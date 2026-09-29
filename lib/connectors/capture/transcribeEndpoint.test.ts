// @vitest-environment node
//
// Tests for POST /api/capture/transcribe (T4.7) — the live-transcript slice.
//
// This is the sibling of localEndpoint.test.ts and shares its shape: one audio
// chunk in, `{ transcript }` out, and in between a single `runJob('transcription')`
// that lib/ai/router.ts resolves. Before plan 14 batch BF the path was an nginx
// proxy_pass straight to capture-service; the reason it is a handler at all now
// is that a deployment can transcribe with its own Whisper while extracting cards
// with OpenAI, and a proxy cannot make that choice.
//
// What is under test here that localEndpoint.test.ts does not already cover:
//   * the 10 MB ceiling, which is a CHUNK's ceiling and not a meeting's;
//   * the deliberately single answer for "not multipart", "no audio part" and
//     "an empty audio part" — distinguishing them would mean describing what
//     arrived, and what arrived is audio;
//   * the wire shape the browser already validates: camelCase chunks with no
//     envelope metadata on them;
//   * the same no-leak rule, on every path.
//
// The node environment above is load-bearing: `parseMultipart` parses with
// `new Request(...).formData()`, and under jsdom the global `File` and undici's
// are different classes, so that call throws and every upload looks malformed.
//
// Nothing here touches the network and nothing here mocks the config:
// globalThis.fetch is always stubbed, VIEWPOINT_CONFIG carries a real config
// string, JWT_SECRET is left unset so the settings store resolves to null and the
// router falls through to that config, and every secret is an obvious placeholder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { ViewpointConfig } from '../../config/schema.ts';
import { hashPassword, signToken } from '../../../api/_lib/accessControl.ts';
import { LocalCaptureError, LocalCaptureProvider } from './local';

const FAKE_SECRET = 'capture-FAKEFAKEFAKEFAKEFAKE-secret';
/** A cloud credential, for the test that resolves the job off the built-in stack. */
const FAKE_CLOUD_KEY = 'sk-FAKEFAKEFAKEFAKEFAKE-not-a-real-key';
const SERVICE_URL = 'http://capture-service:8080';
/** Marker text: if this reaches a response, upstream prose was forwarded. */
const UPSTREAM_MARKER = 'UPSTREAM-BODY-MARKER-do-not-echo';
/** Must match MAX_UPLOAD_BYTES in api/capture/transcribe.ts. */
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;

const BASE_CONFIG: ViewpointConfig = {
  plm: { provider: 'none' },
  capture: { provider: 'local', serviceUrl: SERVICE_URL },
  turn: {
    provider: 'selfHostedCoturn',
    host: 'localhost',
    port: 3478,
    sharedSecretEnv: 'COTURN_SHARED_SECRET',
  },
  db: {
    provider: 'supabase',
    urlEnv: 'VITE_SUPABASE_URL',
    anonKeyEnv: 'VITE_SUPABASE_ANON_KEY',
  },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
};

/** Point the deployment at one capture block. Everything else stays as above. */
function deployCapture(capture: ViewpointConfig['capture']): void {
  vi.stubEnv('VIEWPOINT_CONFIG', JSON.stringify({ ...BASE_CONFIG, capture }));
}

// ─── The upload ─────────────────────────────────────────────────────────────

const BOUNDARY = '----vitestBoundary7MA4YWxkTrZu0gW';

/** The WebM/EBML magic plus ASCII: binary on purpose, see chunkBody. */
const CHUNK_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x63, 0x68, 0x75, 0x6e]);

/**
 * A multipart body as BYTES, not as a template string, so a test can assert the
 * audio arrives intact: a string body would round-trip through UTF-8 and quietly
 * rewrite every byte over 0x7f.
 *
 * `audio === null` omits the part entirely, which is a different request from an
 * empty one — and this endpoint answers both the same way, on purpose.
 */
function chunkBody(audio: Uint8Array | null = CHUNK_BYTES): Buffer {
  const parts: Buffer[] = [];
  if (audio !== null) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="audio"; filename="chunk.webm"\r\n` +
          `Content-Type: audio/webm\r\n\r\n`,
        'utf8',
      ),
    );
    parts.push(Buffer.from(audio));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

// ─── Upstream answers ───────────────────────────────────────────────────────

const TRANSCRIPT_REPLY = {
  transcript: [
    { speakerId: 'speaker-1', text: 'Hold on, the weld lands off-centre.', startMs: 0, endMs: 2600 },
    { speakerId: 'speaker-1', text: 'Can you point at it?', startMs: 2600, endMs: 4100 },
  ],
};

// ─── Vercel req/res doubles ─────────────────────────────────────────────────

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  _statusCode: number;
  _body: unknown;
  _headers: Record<string, string>;
}

function createMockRes(): MockRes {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    _statusCode: 0,
    _body: null as unknown,
    _headers: {} as Record<string, string>,
  } as unknown as MockRes;
  res.status.mockImplementation((code: number) => {
    res._statusCode = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  res.setHeader.mockImplementation((name: string, value: string) => {
    res._headers[name] = value;
    return res;
  });
  return res;
}

interface MockReqOptions {
  /** The raw body. Omitted means a well-formed chunk. */
  body?: Buffer;
  /** Omitted means the multipart header; null means no Content-Type at all. */
  contentType?: string | null;
  cookies?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * A fake chunk for an object-mode stream, used only by the size-ceiling test.
   * `readRawBodyLimited` reads nothing but `.length` before it refuses, and
   * `Buffer.concat` is on a path it never reaches — so a 10 MB chunk can be
   * tested without allocating one.
   */
  chunk?: unknown;
  failStream?: boolean;
}

/**
 * A request double that is also a readable stream, because with
 * `bodyParser: false` the handler reads the raw body itself.
 */
function createMockReq(method: string, options: MockReqOptions = {}) {
  const headers: Record<string, string> = {};
  const contentType =
    options.contentType === undefined
      ? `multipart/form-data; boundary=${BOUNDARY}`
      : options.contentType;
  if (contentType !== null) headers['content-type'] = contentType;

  let stream: Readable;
  if (options.failStream) {
    stream = new Readable({
      read() {
        this.destroy(new Error(`socket hang up while reading ${UPSTREAM_MARKER}`));
      },
    });
  } else if (options.chunk !== undefined) {
    stream = new Readable({ objectMode: true, read() {} });
    stream.push(options.chunk);
  } else {
    stream = Readable.from([options.body ?? chunkBody()]);
  }

  return Object.assign(stream, {
    method,
    headers,
    cookies: options.cookies,
    signal: options.signal,
  }) as never;
}

async function callHandler(req: unknown, res: MockRes): Promise<void> {
  const { default: handler } = await import('../../../api/capture/transcribe.ts');
  await handler(req as never, res as never);
}

// ─── The fetch stub ─────────────────────────────────────────────────────────

interface StubbedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: FormData | null;
  json: unknown;
  signal: AbortSignal | undefined;
}

function stubUpstream(reply: (url: string) => Response | Promise<Response>): StubbedCall[] {
  const calls: StubbedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body;
    const text = typeof body === 'string' ? body : '';
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      form: body instanceof FormData ? body : null,
      json: text === '' ? null : (JSON.parse(text) as unknown),
      signal: init?.signal ?? undefined,
    });
    return reply(String(input));
  });
  return calls;
}

function upstreamReply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The `audio` part of a call, as the file the router actually put on the wire. */
function audioPartOf(call: StubbedCall): File {
  const part = call.form === null ? null : call.form.get('audio');
  if (part === null || typeof part === 'string') {
    throw new Error('the upstream call carried no `audio` file part');
  }
  return part;
}

// ─── The no-leak assertions ─────────────────────────────────────────────────

const FORBIDDEN = [
  FAKE_SECRET,
  FAKE_CLOUD_KEY,
  'CAPTURE_SHARED_SECRET',
  'OPENAI_API_KEY',
  'X-Capture-Token',
  'x-capture-token',
  SERVICE_URL,
  'capture-service:8080',
  UPSTREAM_MARKER,
];

function expectNoLeaks(res: MockRes): void {
  const serialized = JSON.stringify(res._body ?? '') + JSON.stringify(res._headers);
  for (const forbidden of FORBIDDEN) {
    expect(serialized, `response leaked ${forbidden}`).not.toContain(forbidden);
  }
}

const STORED_HASH = hashPassword('front-door');
const ACCESS_COOKIE = { vp_access: signToken(STORED_HASH, 'vp_access') };

let logs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  deployCapture(BASE_CONFIG.capture);
  // CAPTURE_SERVICE_URL outranks the config in lib/ai/router.ts's builtinBaseUrl,
  // so a developer's shell export would otherwise repoint every URL assertion.
  vi.stubEnv('CAPTURE_SERVICE_URL', '');
  vi.stubEnv('COTURN_SHARED_SECRET', 'coturn-FAKE-secret');
  vi.stubEnv('CAPTURE_SHARED_SECRET', FAKE_SECRET);
  // Deterministic by default: the gate is off unless a test turns it on.
  vi.stubEnv('ACCESS_PASSWORD_HASH', '');
  // Deliberately NOT stubbed: with JWT_SECRET unset, getServiceRoleToken()
  // returns null, the settings store resolves to null, and the router falls
  // through to VIEWPOINT_CONFIG — the resolution path under test, unmocked.
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ─── Behaviour ──────────────────────────────────────────────────────────────

describe('api/capture/transcribe — behaviour', () => {
  it('rejects anything but POST, and says what is allowed', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      const res = createMockRes();

      await callHandler(createMockReq(method), res);

      expect(res._statusCode, method).toBe(405);
      expect(res._body).toEqual({ error: 'method_not_allowed' });
      expect(res._headers.Allow).toBe('POST');
      expect(calls).toHaveLength(0);
      expectNoLeaks(res);
    }
  });

  it('makes exactly one call, to <serviceUrl>/transcribe', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // A live chunk is transcribed and dropped; there is no cards job on this
    // path, so a second call would be a second bill for the same audio.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVICE_URL}/transcribe`);
    expect(calls[0].method).toBe('POST');
    expect(res._statusCode).toBe(200);
  });

  it('sends the chunk as a multipart part named audio, bytes intact', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    const audio = audioPartOf(calls[0]);
    expect([...(calls[0].form?.keys() ?? [])]).toEqual(['audio']);
    // NOT the client's filename. The name sent upstream is derived from the part's
    // MIME type by the browser's own recordingFilename mapping, so a client cannot
    // choose the filename that reaches capture-service or a cloud provider — the
    // upstream's own suffix rule and its log lines both see a name this repo picked.
    expect(audio.name).toBe('meeting.webm');
    expect(audio.type).toBe('audio/webm');
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(CHUNK_BYTES);
    // The runtime owns the boundary: a hand-set Content-Type would name one the
    // encoder never used, which is how an upload arrives unparseable.
    expect('content-type' in calls[0].headers).toBe(false);
  });

  it('returns the transcript verbatim, camelCase chunks and no envelope metadata', async () => {
    stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(200);
    // The wire shape lib/connectors/capture/local.ts's transcribeChunk already
    // validates. A live-transcript line that arrives with a `took 4.2s` key on it
    // is a rejected response, not a cosmetic difference.
    expect(res._body).toEqual({ transcript: TRANSCRIPT_REPLY.transcript });
    expectNoLeaks(res);
  });

  it('bounds the upstream call with an abort signal', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // A live chunk is seconds of audio on a rolling cadence: without a signal, a
    // hung transcription keeps running for a participant who has moved on.
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('answers 499 request_closed when the caller hung up first', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const controller = new AbortController();
    controller.abort();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { signal: controller.signal }), res);

    expect(res._statusCode).toBe(499);
    expect(res._body).toEqual({ error: 'request_closed' });
    expect(calls).toHaveLength(0);
    // Logged by CODE ONLY: an abort that surfaces as another error type carries a
    // stack, and a stack can quote the request — which is audio.
    expect(logs.join('\n')).toContain('[capture] transcribe: the client disconnected');
    expectNoLeaks(res);
  });
});

// ─── The request itself ─────────────────────────────────────────────────────

describe('api/capture/transcribe — the request itself', () => {
  it('refuses an unadmitted request before reading the body', async () => {
    vi.stubEnv('ACCESS_PASSWORD_HASH', STORED_HASH);
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // This endpoint accepts audio and attaches an upstream credential for every
    // caller, so it gets the same gate as the one that accepts a whole meeting.
    expect(res._statusCode).toBe(401);
    expect(res._body).toEqual({ error: 'locked' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('admits a request carrying a valid front-door cookie', async () => {
    vi.stubEnv('ACCESS_PASSWORD_HASH', STORED_HASH);
    stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { cookies: ACCESS_COOKIE }), res);

    expect(res._statusCode).toBe(200);
    expectNoLeaks(res);
  });

  it('answers 413 with the CHUNK ceiling, not the meeting one', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { chunk: { length: MAX_CHUNK_BYTES + 1 } }), res);

    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({
      error: 'upload_too_large',
      maxUploadBytes: MAX_CHUNK_BYTES,
    });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 400 invalid_body when the stream dies mid-read', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { failStream: true }), res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'invalid_body' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  /**
   * Three different requests, one answer.
   *
   * Pinned as a table because the sameness IS the behaviour: telling a caller
   * "your body was not multipart" from "your audio part was empty" would mean
   * describing what arrived, and what arrived is audio.
   */
  const EMPTY: Array<{ name: string; request(): unknown }> = [
    {
      name: 'the body is not multipart',
      request() {
        return createMockReq('POST', {
          body: Buffer.from(JSON.stringify({ audio: 'base64' }), 'utf8'),
          contentType: 'application/json',
        });
      },
    },
    {
      name: 'there is no Content-Type at all',
      request() {
        return createMockReq('POST', { contentType: null });
      },
    },
    {
      name: 'there is no audio part',
      request() {
        return createMockReq('POST', { body: chunkBody(null) });
      },
    },
    {
      name: 'the audio part is empty',
      request() {
        return createMockReq('POST', { body: chunkBody(new Uint8Array(0)) });
      },
    },
    {
      name: 'the audio part is a string, not a file',
      request() {
        const body =
          `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="audio"\r\n\r\n` +
          `${UPSTREAM_MARKER}\r\n` +
          `--${BOUNDARY}--\r\n`;
        return createMockReq('POST', { body: Buffer.from(body, 'utf8') });
      },
    },
  ];

  it.each(EMPTY)('answers 400 empty_upload when $name', async ({ request }) => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(request(), res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'empty_upload' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });
});

// ─── The shared secret ──────────────────────────────────────────────────────

describe('api/capture/transcribe — the shared secret', () => {
  it('attaches the header capture-service requires, from server-side env only', async () => {
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(calls[0].headers['x-capture-token']).toBe(FAKE_SECRET);
    expectNoLeaks(res);
  });

  it('omits the header entirely when no secret is configured', async () => {
    vi.stubEnv('CAPTURE_SHARED_SECRET', '');
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // An empty header would be rejected as a bad token; capture-service reads an
    // empty secret as "authentication off", and the request must agree.
    expect('x-capture-token' in calls[0].headers).toBe(false);
    expect(res._statusCode).toBe(200);
  });
});

// ─── Failure codes ──────────────────────────────────────────────────────────

describe('api/capture/transcribe — failure codes', () => {
  it('forwards capture-service\'s own code and status', async () => {
    stubUpstream(() => upstreamReply({ error: 'transcriber_unavailable' }, 503));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // These codes are ours, they carry no content, and the browser has a specific
    // message for each — flattening them into one 502 would lose it.
    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'transcriber_unavailable' });
    expectNoLeaks(res);
  });

  it('forwards a transcription_failed with its status', async () => {
    stubUpstream(() => upstreamReply({ error: 'transcription_failed' }, 500));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(500);
    expect(res._body).toEqual({ error: 'transcription_failed' });
    expectNoLeaks(res);
  });

  it('reports an empty transcript as 422 empty_transcript', async () => {
    stubUpstream(() => upstreamReply({ transcript: [] }));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Nobody spoke in this slice. That is an answer, not a working transcript, and
    // the live panel has a message for it.
    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'empty_transcript' });
    expectNoLeaks(res);
  });

  it('skips a silent stretch rather than failing the whole chunk', async () => {
    stubUpstream(() =>
      upstreamReply({
        transcript: [
          { speakerId: 'speaker-1', text: '   ', startMs: 0, endMs: 900 },
          { speakerId: 'speaker-1', text: 'Now the flange.', startMs: 900, endMs: 2000 },
        ],
      }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(200);
    expect(res._body).toEqual({
      transcript: [{ speakerId: 'speaker-1', text: 'Now the flange.', startMs: 900, endMs: 2000 }],
    });
  });

  it('flattens a code that is not on the router\'s allowlist into 502', async () => {
    stubUpstream(() =>
      upstreamReply({ error: 'totally_invented_code', detail: UPSTREAM_MARKER }, 400),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });

  it('reports 502 capture_upstream_unreachable when the service cannot be reached', async () => {
    stubUpstream(() => {
      throw new TypeError(`fetch failed for ${SERVICE_URL} with ${FAKE_SECRET}`);
    });
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_unreachable' });
    // The log names the route but not the host, and never the secret.
    const logged = logs.join('\n');
    expect(logged).not.toContain('capture-service');
    expect(logged).not.toContain(FAKE_SECRET);
    expectNoLeaks(res);
  });

  it('reports 502 capture_endpoint_unavailable when a 200 is an SPA fallback', async () => {
    stubUpstream(
      () =>
        new Response(`<!doctype html>${UPSTREAM_MARKER}`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // "Something else is answering on that address" is a different fix from "the
    // model said something odd", and neither is a JSON decode error.
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_endpoint_unavailable' });
    expectNoLeaks(res);
  });

  it('answers 503 capture_not_configured when there is no built-in address', async () => {
    deployCapture({ provider: 'mock' });
    const calls = stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('turns a cloud provider\'s 401 into our 502, never into our 401', async () => {
    deployCapture({ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' });
    vi.stubEnv('OPENAI_API_KEY', FAKE_CLOUD_KEY);
    const calls = stubUpstream(() =>
      new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_CLOUD_KEY}` } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Forwarding a provider's 401 would let it arrive at the browser as OURS,
    // where the access layer reads it as "this person is not signed in".
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    // OpenAI's own field name is `file`, not `audio` — the router translates.
    expect(calls[0].form?.has('file')).toBe(true);
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_CLOUD_KEY}`);
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });
});

// ─── Leaks, on every path ───────────────────────────────────────────────────

describe('api/capture/transcribe — nothing leaks on any path', () => {
  /**
   * Every terminal response this handler can produce, driven by a real call
   * rather than a list copied from the source: a new failure path that forwards
   * something it should not fails here without anybody remembering to add it.
   */
  const PATHS: Array<{
    name: string;
    arrange(): void;
    request?(): unknown;
  }> = [
    {
      name: 'success',
      arrange() {
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
    },
    {
      name: 'method not allowed',
      arrange() {
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
      request() {
        return createMockReq('GET');
      },
    },
    {
      name: 'front door locked',
      arrange() {
        vi.stubEnv('ACCESS_PASSWORD_HASH', STORED_HASH);
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
    },
    {
      name: 'body over the ceiling',
      arrange() {
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
      request() {
        return createMockReq('POST', { chunk: { length: MAX_CHUNK_BYTES + 1 } });
      },
    },
    {
      name: 'stream died mid-read',
      arrange() {
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
      request() {
        return createMockReq('POST', { failStream: true });
      },
    },
    {
      name: 'no audio in the upload',
      arrange() {
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
      request() {
        return createMockReq('POST', { body: chunkBody(null) });
      },
    },
    {
      name: 'empty transcript',
      arrange() {
        stubUpstream(() => upstreamReply({ transcript: [] }));
      },
    },
    {
      name: 'upstream 401 with a body quoting the token',
      arrange() {
        stubUpstream(() =>
          new Response(
            JSON.stringify({
              error: 'unauthorized',
              detail: `X-Capture-Token did not match ${FAKE_SECRET}`,
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    },
    {
      name: 'upstream 500 with prose that quotes the audio',
      arrange() {
        stubUpstream(() =>
          new Response(
            `Internal Server Error while handling ${UPSTREAM_MARKER} from ` +
              `${SERVICE_URL} with token ${FAKE_SECRET}`,
            { status: 500, headers: { 'content-type': 'text/plain' } },
          ),
        );
      },
    },
    {
      name: 'upstream answered 200 with HTML',
      arrange() {
        stubUpstream(
          () =>
            new Response(`<!doctype html>${UPSTREAM_MARKER}`, {
              status: 200,
              headers: { 'content-type': 'text/html' },
            }),
        );
      },
    },
    {
      name: 'upstream unreachable',
      arrange() {
        stubUpstream(() => {
          throw new TypeError(`fetch failed for ${SERVICE_URL}`);
        });
      },
    },
    {
      name: 'config not available',
      arrange() {
        vi.stubEnv('VIEWPOINT_CONFIG', `{ not json, and the secret was ${FAKE_SECRET}`);
        stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));
      },
    },
    {
      name: 'a cloud provider refused the key',
      arrange() {
        deployCapture({ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' });
        vi.stubEnv('OPENAI_API_KEY', FAKE_CLOUD_KEY);
        stubUpstream(() =>
          new Response(
            JSON.stringify({ error: { message: `Incorrect API key: ${FAKE_CLOUD_KEY}` } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    },
  ];

  it.each(PATHS)('the "$name" response carries no secret, no name and no URL', async ({
    arrange,
    request,
  }) => {
    arrange();
    const res = createMockRes();

    await callHandler(request === undefined ? createMockReq('POST') : request(), res);

    expect(res._statusCode).toBeGreaterThan(0);
    expectNoLeaks(res);
  });
});

// ─── The browser contract, end to end ───────────────────────────────────────

describe('api/capture/transcribe — the browser contract through the real handler', () => {
  /**
   * A fetchFn for LocalCaptureProvider that runs the REAL handler.
   *
   * The wire bytes come from the browser's own encoder: a Request is the only
   * WHATWG entry point that will serialise a FormData, so this test does not
   * carry a second, hand-rolled multipart encoder that could drift from the one
   * transcribeChunk actually uses.
   */
  function handlerAsFetch(): typeof globalThis.fetch {
    return async (_input, init) => {
      const form = init?.body;
      if (!(form instanceof FormData)) {
        throw new Error('the provider must post a FormData body');
      }
      const wire = new Request('http://localhost/api/capture/transcribe', {
        method: 'POST',
        body: form,
      });
      const res = createMockRes();
      await callHandler(
        createMockReq('POST', {
          body: Buffer.from(await wire.arrayBuffer()),
          contentType: wire.headers.get('content-type'),
        }),
        res,
      );
      return new Response(JSON.stringify(res._body ?? {}), {
        status: res._statusCode === 0 ? 200 : res._statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };
  }

  function provider(): LocalCaptureProvider {
    return new LocalCaptureProvider({ fetchFn: handlerAsFetch() });
  }

  function chunk(): Blob {
    return new Blob([CHUNK_BYTES], { type: 'audio/webm' });
  }

  it('still joins the chunk texts for the live transcript panel', async () => {
    stubUpstream(() => upstreamReply(TRANSCRIPT_REPLY));

    const text = await provider().transcribeChunk(chunk());

    expect(text).toBe('Hold on, the weld lands off-centre. Can you point at it?');
  });

  it('still surfaces an unusable transcript as a LocalCaptureError', async () => {
    stubUpstream(() => upstreamReply({ error: 'transcriber_unavailable' }, 503));

    const error = await provider()
      .transcribeChunk(chunk())
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(LocalCaptureError);
    const failure = error as LocalCaptureError;
    expect(failure.code).toBe('transcriber_unavailable');
    expect(failure.status).toBe(503);
    expect(failure.message).not.toContain(FAKE_SECRET);
    expect(failure.message).not.toContain(SERVICE_URL);
  });
});
