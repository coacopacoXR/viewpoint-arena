// @vitest-environment node
//
// Tests for POST /api/capture/local (T4.4, rewritten by plan 14 batch BF) — the
// Vercel half of local capture.
//
// This handler stopped being a byte-forwarding reverse proxy. It now parses the
// upload and makes TWO router calls: `transcription` (audio to transcript) and
// then `cards` (transcript to InsightCards). With the default deployment both
// resolve to `builtin`, which is capture-service, so one browser upload becomes
// POST <serviceUrl>/transcribe and then POST <serviceUrl>/extract.
//
// Three things are under test:
//   1. THE TWO CALLS — what each is pointed at, what shape it carries, and that
//      the transcript really does travel from the first into the second rather
//      than being re-derived.
//   2. THE CODES — capture-service's own error vocabulary arrives verbatim with
//      its own status, a CLOUD provider's status never does, and anything
//      unrecognisable is flattened into the router's closed vocabulary.
//   3. SECURITY — the shared secret, the NAME of the variable holding it, the
//      internal serviceUrl, a cloud API key and any upstream response text never
//      appear in a response, on ANY path including every failure path.
//
// The node environment above is load-bearing, not a preference: `parseMultipart`
// parses with `new Request(...).formData()`, and under jsdom the global `File`
// and undici's are different classes, so that call throws and every upload looks
// malformed. Node is also the runtime this handler actually runs in.
//
// Nothing here touches the network and nothing here mocks the config:
// globalThis.fetch is always stubbed, VIEWPOINT_CONFIG carries a real config
// string that lib/config/loadConfig.ts parses for real, JWT_SECRET is left unset
// so lib/ai/settingsStore.ts resolves to null and the router falls through to
// that config, and every secret is an obviously-fake placeholder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import type { ViewpointConfig } from '../../config/schema.ts';
import { hashPassword, signToken } from '../../../api/_lib/accessControl.ts';
import { DEFAULT_SLIDE_TITLE } from '../../../api/capture/_request.ts';
import { LocalCaptureError, LocalCaptureProvider } from './local';

const FAKE_SECRET = 'capture-FAKEFAKEFAKEFAKEFAKE-secret';
/** A cloud credential, for the tests that resolve a job off the built-in stack. */
const FAKE_CLOUD_KEY = 'sk-FAKEFAKEFAKEFAKEFAKE-not-a-real-key';
const SERVICE_URL = 'http://capture-service:8080';
/**
 * Marker text: if this reaches a response, then request prose (it stands in for
 * the meeting — it is the slideTitle the upload carries) or upstream prose was
 * forwarded.
 */
const UPSTREAM_MARKER = 'UPSTREAM-BODY-MARKER-do-not-echo';
/** Must match MAX_UPLOAD_BYTES in api/capture/local.ts. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * A real config, serialised into VIEWPOINT_CONFIG rather than mocked.
 *
 * Mocking loadConfig would test the handler against a config the deployment
 * could never have: the schema is what makes `serviceUrl: 'not a url'` a
 * failure, and checkEnvVars is what makes a named-but-absent key one. Both are
 * part of this endpoint's behaviour now that the router resolves through them.
 */
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

/** The WebM/EBML magic plus ASCII: binary on purpose, see uploadBody. */
const AUDIO_BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x6d, 0x65, 0x65, 0x74]);

interface UploadField {
  name: string;
  value: string;
}

/** The default upload: an agenda position and a slide title that is the marker. */
const DEFAULT_FIELDS: UploadField[] = [
  { name: 'agendaIdx', value: '3' },
  { name: 'slideTitle', value: UPSTREAM_MARKER },
];

/** Every field the browser's buildCaptureForm can put on the wire. */
const FULL_CONTEXT_FIELDS: UploadField[] = [
  { name: 'agendaIdx', value: '3' },
  { name: 'slideTitle', value: 'Bracket moulding' },
  { name: 'hoveredPartName', value: 'Bracket Alpha' },
  { name: 'laserTargetPartName', value: 'Rib Pattern 2' },
];

/**
 * A multipart body as BYTES, not as a template string.
 *
 * The audio part is arbitrary binary, and building the body by concatenating
 * buffers is what lets a test assert the bytes arrive intact: a string body
 * would round-trip through UTF-8 and quietly rewrite every byte over 0x7f, so
 * "byte-for-byte" would be a claim about the test's own encoding.
 *
 * `audio === null` omits the part entirely, which is a different request from an
 * empty one and gets a different assertion.
 */
function uploadBody(
  fields: UploadField[] = DEFAULT_FIELDS,
  audio: Uint8Array | null = AUDIO_BYTES,
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="${field.name}"\r\n\r\n` +
          `${field.value}\r\n`,
        'utf8',
      ),
    );
  }
  if (audio !== null) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\n` +
          `Content-Disposition: form-data; name="audio"; filename="meeting.webm"\r\n` +
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
    {
      speakerId: 'speaker-1',
      text: 'The bracket weld will crack before we reach the yield target.',
      startMs: 0,
      endMs: 4200,
    },
    {
      speakerId: 'speaker-2',
      text: 'Then we re-run the stress simulation on the revised bracket this week.',
      startMs: 4200,
      endMs: 8400,
    },
  ],
};

/** A card that passes the strict parser, with its id and timestamp spelled out. */
const CARD = {
  id: 'insight-1',
  type: 'RISK',
  agentId: 'speaker-1',
  title: 'Wall transition risks sink marks',
  description: 'A 57% wall reduction historically causes sink on A-surfaces.',
  timestamp: 1_700_000_000_000,
  details: { priority: 'High', status: 'Open' },
};

const COMPONENT_TREE = [{ id: 'c1', name: 'Bracket Alpha', path: '/Assembly/Bracket Alpha' }];

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
  /** The raw body. Omitted means a well-formed upload, which is what most
   *  tests are arranging a failure on top of. */
  body?: Buffer;
  /** Omitted means the multipart header; null means no Content-Type at all. */
  contentType?: string | null;
  /** The parsed cookie jar Vercel hands a handler. */
  cookies?: Record<string, string>;
  /** The platform's own signal for a caller who hung up. */
  signal?: AbortSignal;
  /**
   * A fake chunk for an object-mode stream, used only by the size-ceiling test.
   * `readRawBodyLimited` reads nothing but `.length` before it refuses, and
   * `Buffer.concat` is on a path it never reaches — so a 200 MiB upload can be
   * tested without allocating one.
   */
  chunk?: unknown;
  /** A socket that dies mid-read. */
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
    stream = Readable.from([options.body ?? uploadBody()]);
  }

  return Object.assign(stream, {
    method,
    headers,
    cookies: options.cookies,
    signal: options.signal,
  }) as never;
}

async function callHandler(req: unknown, res: MockRes): Promise<void> {
  const { default: handler } = await import('../../../api/capture/local.ts');
  await handler(req as never, res as never);
}

// ─── The fetch stub ─────────────────────────────────────────────────────────

interface StubbedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The multipart form the router built, when the body was one. */
  form: FormData | null;
  /** The parsed JSON body, when the router sent one. */
  json: unknown;
  signal: AbortSignal | undefined;
}

interface Upstream {
  calls: StubbedCall[];
  /** The transcription call. Throws rather than returning undefined: a missing
   *  call is the failure, and `calls[0].url` on an empty array hides it. */
  transcribe(): StubbedCall;
  /** The cards call. */
  extract(): StubbedCall;
}

function stubUpstream(reply: (url: string) => Response | Promise<Response>): Upstream {
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

  const find = (suffix: string): StubbedCall => {
    const call = calls.find((candidate) => candidate.url.endsWith(suffix));
    if (call === undefined) {
      throw new Error(`no upstream call to ${suffix}; got ${JSON.stringify(calls.map((c) => c.url))}`);
    }
    return call;
  };
  return { calls, transcribe: () => find('/transcribe'), extract: () => find('/extract') };
}

function upstreamReply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The two-call happy path, so a test that is not about a failure says so once. */
function stubHappy(cards: unknown = []): Upstream {
  return stubUpstream((url) =>
    upstreamReply(url.endsWith('/transcribe') ? TRANSCRIPT_REPLY : { cards }),
  );
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

/** Every string that must never reach the browser. */
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

/**
 * The front-door cookie, minted the way api/access-check.ts mints it.
 *
 * Recomputed per file rather than hard-coded: the stored hash carries a random
 * salt, so a fixture would only ever be a fixture of itself.
 */
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
  // The built-in stack's address. CAPTURE_SERVICE_URL outranks the config in
  // lib/ai/router.ts's builtinBaseUrl, so a developer's shell export would
  // otherwise silently repoint every URL assertion in this file.
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

// ─── The two calls ──────────────────────────────────────────────────────────

describe('api/capture/local — one upload, two router calls', () => {
  it('transcribes first and then extracts cards, in that order', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${SERVICE_URL}/transcribe`,
      `${SERVICE_URL}/extract`,
    ]);
    expect(upstream.calls.map((call) => call.method)).toEqual(['POST', 'POST']);
  });

  it('sends the recording to /transcribe as a multipart part named audio', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    const call = upstream.transcribe();
    const audio = audioPartOf(call);
    // The field name is capture-service's own (AUDIO_FIELD in lib/ai/router.ts);
    // a rename there is a 422 here, not a cosmetic difference.
    expect([...(call.form?.keys() ?? [])]).toEqual(['audio']);
    expect(audio.name).toBe('meeting.webm');
    expect(audio.type).toBe('audio/webm');
    // Byte-for-byte, through a parse and a re-encode. The handler no longer
    // forwards the browser's own multipart body, so this is the assertion that
    // stands in for "the recording survived".
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(AUDIO_BYTES);
  });

  it('sets no Content-Type on the multipart call, so the runtime owns the boundary', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // The incoming boundary is gone by necessity — the body was parsed — and a
    // hand-set Content-Type would name a boundary the new encoder never used.
    // That is the classic way to make an upload arrive unparseable.
    expect('content-type' in upstream.transcribe().headers).toBe(false);
    expect(upstream.extract().headers['content-type']).toBe('application/json');
  });

  it('sends the transcript and the slide context to /extract as JSON', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { body: uploadBody(FULL_CONTEXT_FIELDS) }), res);

    expect(upstream.extract().json).toEqual({
      transcript: TRANSCRIPT_REPLY.transcript,
      context: {
        agendaIdx: 3,
        slideTitle: 'Bracket moulding',
        hoveredPartName: 'Bracket Alpha',
        laserTargetPartName: 'Rib Pattern 2',
      },
    });
  });

  it('feeds job one\'s transcript to job two rather than transcribing twice', async () => {
    const upstream = stubUpstream((url) =>
      upstreamReply(url.endsWith('/transcribe') ? TRANSCRIPT_REPLY : { cards: [CARD] }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    const sent = upstream.extract().json as { transcript: unknown };
    expect(sent.transcript).toEqual(TRANSCRIPT_REPLY.transcript);
    // One audio upload, one transcription: a second /transcribe would double the
    // GPU time for the same meeting.
    expect(upstream.calls.filter((call) => call.url.endsWith('/transcribe'))).toHaveLength(1);
  });

  it('returns the cards verbatim on success', async () => {
    stubHappy([CARD]);
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(200);
    // Verbatim, including the id and timestamp: the browser re-validates this
    // with the same strict parser, so a handler that "improved" the envelope
    // would break it.
    expect(res._body).toEqual({ cards: [CARD] });
    expectNoLeaks(res);
  });

  it('forwards an empty-cards answer rather than inventing one', async () => {
    stubHappy([]);
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(200);
    expect(res._body).toEqual({ cards: [] });
  });

  it('bounds both upstream calls with an abort signal', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Without one, a hung transcription keeps a serverless function — and the
    // caller's tab — waiting until the platform kills it.
    expect(upstream.transcribe().signal).toBeInstanceOf(AbortSignal);
    expect(upstream.extract().signal).toBeInstanceOf(AbortSignal);
  });

  it('answers 499 request_closed when the caller hung up before the first call', async () => {
    const upstream = stubHappy();
    const controller = new AbortController();
    controller.abort();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { signal: controller.signal }), res);

    expect(res._statusCode).toBe(499);
    expect(res._body).toEqual({ error: 'request_closed' });
    // Nobody was waiting, so nothing was spent: no GPU seconds, no billed tokens.
    expect(upstream.calls).toHaveLength(0);
    // Logged by CODE ONLY. An abort that surfaces as some other error type
    // carries a stack, and a stack can quote the request — which is a recording.
    expect(logs.join('\n')).toContain('[capture] local: the client disconnected');
    expectNoLeaks(res);
  });
});

// ─── The slide context ──────────────────────────────────────────────────────

describe('api/capture/local — the slide context', () => {
  it('falls back to the shared default label rather than refusing the upload', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          { name: 'agendaIdx', value: 'nonsense' },
          { name: 'slideTitle', value: '   ' },
        ]),
      }),
      res,
    );

    expect(res._statusCode).toBe(200);
    // A recording with no agenda context is still worth extracting, and an empty
    // string in the prompt is worse than a generic one: the model then has
    // nothing to anchor the review to. The constant is capture-service's own, so
    // a meeting labelled by the browser and one labelled by the service read the
    // same to the model.
    expect(upstream.extract().json).toEqual({
      transcript: TRANSCRIPT_REPLY.transcript,
      context: { agendaIdx: 0, slideTitle: DEFAULT_SLIDE_TITLE },
    });
    expect(DEFAULT_SLIDE_TITLE).toBe('Full meeting recording');
  });

  it('omits the two part names when the form does not carry them', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          { name: 'agendaIdx', value: '0' },
          { name: 'slideTitle', value: 'Kick-off' },
        ]),
      }),
      res,
    );

    const sent = upstream.extract().json as { context: Record<string, unknown> };
    // Not the string "undefined" and not "": both would reach the extraction
    // prompt as text.
    expect(sent.context).toEqual({ agendaIdx: 0, slideTitle: 'Kick-off' });
  });

  it('trims the labels it forwards', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          { name: 'agendaIdx', value: '7' },
          { name: 'slideTitle', value: '  Bracket moulding  ' },
          { name: 'hoveredPartName', value: ' Bracket Alpha ' },
        ]),
      }),
      res,
    );

    const sent = upstream.extract().json as { context: Record<string, unknown> };
    expect(sent.context).toEqual({
      agendaIdx: 7,
      slideTitle: 'Bracket moulding',
      hoveredPartName: 'Bracket Alpha',
    });
  });
});

// ─── The grounded context ───────────────────────────────────────────────────

describe('api/capture/local — the grounded context', () => {
  it('parses the three JSON-encoded form fields and forwards them', async () => {
    const upstream = stubHappy();
    const res = createMockRes();
    const pointing = [
      {
        userId: 'u1',
        userName: 'Ann',
        partId: 'c1',
        partName: 'Bracket Alpha',
        fromMs: 0,
        toMs: 1200,
      },
    ];
    const hint = [{ speaker: 'Ann', text: 'look at the weld here', offsetMs: 400 }];

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          ...FULL_CONTEXT_FIELDS,
          { name: 'componentTree', value: JSON.stringify(COMPONENT_TREE) },
          { name: 'pointingSegments', value: JSON.stringify(pointing) },
          { name: 'transcriptHint', value: JSON.stringify(hint) },
        ]),
      }),
      res,
    );

    expect(res._statusCode).toBe(200);
    expect(upstream.extract().json).toEqual({
      transcript: TRANSCRIPT_REPLY.transcript,
      context: {
        agendaIdx: 3,
        slideTitle: 'Bracket moulding',
        hoveredPartName: 'Bracket Alpha',
        laserTargetPartName: 'Rib Pattern 2',
      },
      componentTree: COMPONENT_TREE,
      pointingSegments: pointing,
      transcriptHint: hint,
    });
  });

  it('refuses a componentTree that is not JSON, rather than dropping it', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          ...DEFAULT_FIELDS,
          { name: 'componentTree', value: 'Bracket Alpha, Rib Pattern 2' },
        ]),
      }),
      res,
    );

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'invalid_request' });
    // Nothing was spent: the refusal happens before either router call. A
    // silently dropped component list is how a model starts inventing component
    // ids, so the whole request is refused instead.
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('refuses a component entry that has no id', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          ...DEFAULT_FIELDS,
          {
            name: 'componentTree',
            value: JSON.stringify([{ name: 'Bracket Alpha', path: '/Assembly/Bracket Alpha' }]),
          },
        ]),
      }),
      res,
    );

    // A component without an id cannot be referenced by a card, and one without
    // a path is invisible in the tree the reviewer sees.
    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'invalid_request' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('refuses a pointing segment with a negative timestamp', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          ...DEFAULT_FIELDS,
          {
            name: 'pointingSegments',
            value: JSON.stringify([
              {
                userId: 'u1',
                userName: 'Ann',
                partId: 'c1',
                partName: 'Bracket Alpha',
                fromMs: -1,
                toMs: 1200,
              },
            ]),
          },
        ]),
      }),
      res,
    );

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'invalid_request' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('sends no grounded keys at all when the form carries none', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Absent, not `null` and not `{}`: the pre-grounded-capture shape is still
    // perfectly valid, and a key holding null would reach the prompt builder.
    expect(Object.keys(upstream.extract().json as Record<string, unknown>).sort()).toEqual([
      'context',
      'transcript',
    ]);
  });

  it('forwards an empty component list as absent, not as []', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([...DEFAULT_FIELDS, { name: 'componentTree', value: '[]' }]),
      }),
      res,
    );

    expect(res._statusCode).toBe(200);
    // "There is no model tree" and "here is an empty tree" should not be two
    // cases for the receiving service to distinguish.
    expect('componentTree' in (upstream.extract().json as Record<string, unknown>)).toBe(false);
  });

  it('refuses a card whose componentReference is not in the list that was sent', async () => {
    stubUpstream((url) =>
      upstreamReply(
        url.endsWith('/transcribe')
          ? TRANSCRIPT_REPLY
          : {
              cards: [
                { ...CARD, details: { priority: 'High', status: 'Open', componentReference: 'c9' } },
              ],
            },
      ),
    );
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: uploadBody([
          ...DEFAULT_FIELDS,
          { name: 'componentTree', value: JSON.stringify(COMPONENT_TREE) },
        ]),
      }),
      res,
    );

    expect(res._statusCode).toBe(422);
    // `reason` is an enum from our own vocabulary, so it is safe to forward; the
    // card itself is not, because it quotes the meeting.
    expect(res._body).toEqual({ error: 'capture_parse_error', reason: 'invalid_card' });
    expectNoLeaks(res);
  });
});

// ─── The request itself ─────────────────────────────────────────────────────

describe('api/capture/local — the request itself', () => {
  it('rejects anything but POST, and says what is allowed', async () => {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const upstream = stubHappy();
      const res = createMockRes();

      await callHandler(createMockReq(method), res);

      expect(res._statusCode, method).toBe(405);
      expect(res._body).toEqual({ error: 'method_not_allowed' });
      expect(res._headers.Allow).toBe('POST');
      expect(upstream.calls).toHaveLength(0);
      expectNoLeaks(res);
    }
  });

  it('refuses an unadmitted request before reading the body', async () => {
    vi.stubEnv('ACCESS_PASSWORD_HASH', STORED_HASH);
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // These routes SPEND something — a GPU, a cloud key, a gateway's quota — and
    // they attach their own upstream credential for every caller. Without this
    // gate anyone who could reach the origin could make the deployment
    // transcribe audio without ever seeing a screen.
    expect(res._statusCode).toBe(401);
    expect(res._body).toEqual({ error: 'locked' });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('admits a request carrying a valid front-door cookie', async () => {
    vi.stubEnv('ACCESS_PASSWORD_HASH', STORED_HASH);
    stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { cookies: ACCESS_COOKIE }), res);

    expect(res._statusCode).toBe(200);
    expectNoLeaks(res);
  });

  it('answers 413 with the ceiling when the body goes over it', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', { chunk: { length: MAX_UPLOAD_BYTES + 1 } }),
      res,
    );

    // The ceiling is enforced HERE rather than left to nginx or to the upstream,
    // because the body is no longer forwarded untouched: this runtime parses it,
    // so this runtime is the layer that has to say "too big" — and say it before
    // it has accepted 200 MB it cannot hold.
    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({ error: 'upload_too_large', maxUploadBytes: MAX_UPLOAD_BYTES });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 400 invalid_body when the stream dies mid-read', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { failStream: true }), res);

    expect(res._statusCode).toBe(400);
    // A code, not a message: the error text can quote request bytes, and the
    // request is a recording.
    expect(res._body).toEqual({ error: 'invalid_body' });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 400 invalid_body when the body is not multipart', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        body: Buffer.from(JSON.stringify({ audio: 'base64' }), 'utf8'),
        contentType: 'application/json',
      }),
      res,
    );

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'invalid_body' });
    expect(upstream.calls).toHaveLength(0);
  });

  it('answers 400 empty_upload when there is no audio part', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { body: uploadBody(DEFAULT_FIELDS, null) }), res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'empty_upload' });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 400 empty_upload when the audio part is empty', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', { body: uploadBody(DEFAULT_FIELDS, new Uint8Array(0)) }),
      res,
    );

    // A muted microphone for the whole meeting is the operator's answer here, and
    // it is a different one from "we could not parse your upload".
    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'empty_upload' });
    expect(upstream.calls).toHaveLength(0);
  });
});

// ─── Where the built-in stack lives ─────────────────────────────────────────

describe('api/capture/local — resolving the built-in stack', () => {
  it('takes the address from the deployment config, with nothing mocked', async () => {
    deployCapture({ provider: 'local', serviceUrl: 'http://whisper.internal:9000' });
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // VIEWPOINT_CONFIG is the source a real deployment uses, and reaching it
    // means going through the schema and checkEnvVars for real.
    expect(upstream.calls.map((call) => call.url)).toEqual([
      'http://whisper.internal:9000/transcribe',
      'http://whisper.internal:9000/extract',
    ]);
  });

  it('prefers CAPTURE_SERVICE_URL, the operator\'s explicit answer', async () => {
    vi.stubEnv('CAPTURE_SERVICE_URL', 'http://capture-service:8080');
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // docker-compose sets this for the api container, so it is the address the
    // self-hosted stack actually uses even when viewpoint.config.ts names one.
    expect(upstream.calls.map((call) => call.url)).toEqual([
      'http://capture-service:8080/transcribe',
      'http://capture-service:8080/extract',
    ]);
  });

  it('drops a trailing slash rather than doubling it', async () => {
    deployCapture({ provider: 'local', serviceUrl: `${SERVICE_URL}/` });
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${SERVICE_URL}/transcribe`,
      `${SERVICE_URL}/extract`,
    ]);
  });

  it('answers 503 capture_not_configured when the config will not load', async () => {
    // loadConfig's own message names the config file and the missing env var —
    // exactly what an operator needs and exactly what must not be published.
    vi.stubEnv('VIEWPOINT_CONFIG', `{ not json, and the secret was ${FAKE_SECRET}`);
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 503 capture_not_configured when serviceUrl is not a URL', async () => {
    vi.stubEnv(
      'VIEWPOINT_CONFIG',
      JSON.stringify({ ...BASE_CONFIG, capture: { provider: 'local', serviceUrl: 'not a url' } }),
    );
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Refused by the schema, so there is no address to invent one from.
    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 503 for a mock deployment that named no built-in address', async () => {
    deployCapture({ provider: 'mock' });
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // `mock` says "this deployment runs no real capture", which is a statement
    // about the browser's simulation path. It deliberately falls through to
    // builtin in the router — so what makes this a 503 is the absent address,
    // not the provider.
    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(upstream.calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('a mock deployment with CAPTURE_SERVICE_URL still reaches the built-in stack', async () => {
    deployCapture({ provider: 'mock' });
    vi.stubEnv('CAPTURE_SERVICE_URL', SERVICE_URL);
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Pinned because it is surprising: docker-compose sets CAPTURE_SERVICE_URL
    // unconditionally, so a mock install running in the bundled stack resolves
    // both jobs to capture-service rather than refusing. That is the router's
    // documented choice — a mock install never calls these endpoints, and if
    // something does, the built-in stack is a saner answer than a 503.
    expect(res._statusCode).toBe(200);
    expect(upstream.calls.map((call) => call.url)).toEqual([
      `${SERVICE_URL}/transcribe`,
      `${SERVICE_URL}/extract`,
    ]);
  });
});

// ─── The shared secret ──────────────────────────────────────────────────────

describe('api/capture/local — the shared secret', () => {
  it('attaches the header capture-service requires to BOTH calls, from server-side env only', async () => {
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(upstream.transcribe().headers['x-capture-token']).toBe(FAKE_SECRET);
    expect(upstream.extract().headers['x-capture-token']).toBe(FAKE_SECRET);
    // It is USED server-side and never returned. capture-service publishes no
    // port at all, and this header is the only reason it can keep doing that.
    expectNoLeaks(res);
  });

  it('omits the header on both calls when no secret is configured', async () => {
    vi.stubEnv('CAPTURE_SHARED_SECRET', '');
    const upstream = stubHappy();
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // An empty header would be rejected as a bad token; capture-service reads an
    // empty secret as "authentication off", and the request must agree.
    expect('x-capture-token' in upstream.transcribe().headers).toBe(false);
    expect('x-capture-token' in upstream.extract().headers).toBe(false);
    expect(res._statusCode).toBe(200);
    expectNoLeaks(res);
  });

  it('takes the header name and the variable name from lib/health/probes.ts', async () => {
    // Shared with the health probe, which is pinned against capture-service's
    // auth.py by capture-service/tests/test_typescript_parity.py. A third
    // spelling here would be a fourth place to forget.
    const { CAPTURE_AUTH_HEADER, CAPTURE_SHARED_SECRET_ENV } = await import(
      '../../health/probes.ts'
    );
    expect(CAPTURE_AUTH_HEADER).toBe('X-Capture-Token');
    expect(CAPTURE_SHARED_SECRET_ENV).toBe('CAPTURE_SHARED_SECRET');
  });
});

// ─── capture-service's own codes ────────────────────────────────────────────

describe('api/capture/local — the built-in stack\'s codes are forwarded', () => {
  it('a 413 upload_too_large arrives with the service\'s own ceiling', async () => {
    stubUpstream(() =>
      upstreamReply({ error: 'upload_too_large', maxUploadBytes: 1048576 }, 413),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // The status travels unchanged, which is what nginx did when it proxied this
    // path straight to the service: the browser has a specific message for each
    // of these codes, and flattening them into one 502 would lose it.
    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({ error: 'upload_too_large', maxUploadBytes: 1048576 });
    expectNoLeaks(res);
  });

  it('a 422 capture_parse_error keeps its reason enum', async () => {
    stubUpstream((url) =>
      url.endsWith('/transcribe')
        ? upstreamReply(TRANSCRIPT_REPLY)
        : upstreamReply({ error: 'capture_parse_error', reason: 'malformed_json' }, 422),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'capture_parse_error', reason: 'malformed_json' });
    expectNoLeaks(res);
  });

  it('a 503 transcriber_unavailable stays a 503', async () => {
    stubUpstream(() => upstreamReply({ error: 'transcriber_unavailable' }, 503));
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'transcriber_unavailable' });
    expectNoLeaks(res);
  });

  it('an empty transcript is our own 422 empty_transcript', async () => {
    stubUpstream((url) =>
      url.endsWith('/transcribe') ? upstreamReply({ transcript: [] }) : upstreamReply({ cards: [] }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Nothing speech-like was found, so there is nothing to extract — and no
    // reason to spend a second call finding that out again.
    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'empty_transcript' });
    expectNoLeaks(res);
  });

  it('flattens a code that is not on the router\'s allowlist into 502', async () => {
    stubUpstream(() =>
      upstreamReply({ error: 'totally_invented_code', detail: UPSTREAM_MARKER }, 400),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // An allowlist rather than "anything matching [a-z_]+": a code the browser
    // has no case for would render as a bare string, and a code an upstream
    // invented would render as a sentence we did not write.
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });

  it('flattens a code that is not machine-readable, and echoes none of it', async () => {
    stubUpstream(() =>
      upstreamReply({ error: `<html>${UPSTREAM_MARKER}</html>` }, 502),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });

  it('keeps only the allowlisted numeric extras and drops the prose', async () => {
    stubUpstream(() =>
      upstreamReply(
        {
          error: 'upload_too_large',
          maxUploadBytes: 1048576,
          cardIndex: 2,
          detail: `${UPSTREAM_MARKER} from ${SERVICE_URL}`,
          reason: 'not_one_of_ours',
        },
        413,
      ),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // A ceiling and an index are numbers from OUR vocabulary. `detail` is prose
    // and `reason` is not one of the parser's enums, so neither survives.
    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({
      error: 'upload_too_large',
      maxUploadBytes: 1048576,
      cardIndex: 2,
    });
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
    expectNoLeaks(res);
  });

  it('reports 502 capture_endpoint_unavailable when a 200 is HTML', async () => {
    // An SPA fallback, a proxy answering for a route it does not own, or the
    // wrong port: something else is listening on that address.
    stubUpstream(
      () =>
        new Response(`<!doctype html>${UPSTREAM_MARKER}`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_endpoint_unavailable' });
    expectNoLeaks(res);
  });

  it('reports 502 capture_endpoint_unavailable when a 200 is not JSON at all', async () => {
    stubUpstream(
      () =>
        new Response('nope', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_endpoint_unavailable' });
    expectNoLeaks(res);
  });
});

// ─── A cloud provider never sets our status ─────────────────────────────────

describe('api/capture/local — a cloud provider is always our 502', () => {
  const OPENAI_CAPTURE: ViewpointConfig['capture'] = {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
  };

  beforeEach(() => {
    deployCapture(OPENAI_CAPTURE);
    vi.stubEnv('OPENAI_API_KEY', FAKE_CLOUD_KEY);
  });

  it('turns a provider 401 into our 502, never into our 401', async () => {
    const upstream = stubUpstream(() =>
      new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_CLOUD_KEY}` } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    // Forwarding a provider's 401 would let it arrive at the browser as OURS,
    // where the access layer reads it as "this person is not signed in" and
    // sends them to a door they were already through.
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expectNoLeaks(res);
  });

  it('puts the key in the Authorization header and nowhere else', async () => {
    const upstream = stubUpstream(() =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(upstream.calls[0].headers.authorization).toBe(`Bearer ${FAKE_CLOUD_KEY}`);
    // A provider-specific code would mean a provider-specific client, which is
    // what the router exists to remove: 429 is not one of ours, so it is ours.
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });

  it('does not forward a cloud provider\'s own codes, only the built-in stack\'s', async () => {
    // `upload_too_large` is forwarded from capture-service because it is ours.
    // From OpenAI it is not: the allowlist only applies to the built-in path,
    // where the browser already has a message for each code.
    const upstream = stubUpstream(() =>
      upstreamReply({ error: 'upload_too_large', maxUploadBytes: 1 }, 413),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(upstream.calls[0].url).toContain('api.openai.com');
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });
});

// ─── Leaks, on every path ───────────────────────────────────────────────────

describe('api/capture/local — nothing leaks on any path', () => {
  /**
   * Every terminal response this handler can produce, driven by a real call
   * rather than a list copied from the source: a new failure path that forwards
   * something it should not fails here without anybody remembering to add it.
   */
  const PATHS: Array<{
    name: string;
    arrange(): void;
    /** Defaults to a well-formed upload: the failure is in the arrangement. */
    request?(): unknown;
  }> = [
    {
      name: 'success',
      arrange() {
        stubHappy([CARD]);
      },
    },
    {
      name: 'service refused the size',
      arrange() {
        stubUpstream(() => upstreamReply({ error: 'upload_too_large', maxUploadBytes: 1 }, 413));
      },
    },
    {
      name: 'service had no transcriber',
      arrange() {
        stubUpstream(() => upstreamReply({ error: 'transcriber_unavailable' }, 503));
      },
    },
    {
      name: 'service could not parse the model output',
      arrange() {
        stubUpstream((url) =>
          url.endsWith('/transcribe')
            ? upstreamReply(TRANSCRIPT_REPLY)
            : upstreamReply({ error: 'capture_parse_error', reason: 'prose' }, 422),
        );
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
      name: 'upstream 500 with prose that quotes the upload',
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
      name: 'upstream answered 200 with an SPA fallback',
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
      name: 'a card named a component that does not exist',
      arrange() {
        stubUpstream((url) =>
          url.endsWith('/transcribe')
            ? upstreamReply(TRANSCRIPT_REPLY)
            : upstreamReply({
                cards: [
                  { ...CARD, details: { priority: 'High', componentReference: 'invented' } },
                ],
              }),
        );
      },
      request() {
        return createMockReq('POST', {
          body: uploadBody([
            ...DEFAULT_FIELDS,
            { name: 'componentTree', value: JSON.stringify(COMPONENT_TREE) },
          ]),
        });
      },
    },
    {
      name: 'method not allowed',
      arrange() {
        stubHappy();
      },
      request() {
        return createMockReq('GET');
      },
    },
    {
      name: 'front door locked',
      arrange() {
        vi.stubEnv('ACCESS_PASSWORD_HASH', STORED_HASH);
        stubHappy();
      },
    },
    {
      name: 'body over the ceiling',
      arrange() {
        stubHappy();
      },
      request() {
        return createMockReq('POST', { chunk: { length: MAX_UPLOAD_BYTES + 1 } });
      },
    },
    {
      name: 'stream died mid-read',
      arrange() {
        stubHappy();
      },
      request() {
        return createMockReq('POST', { failStream: true });
      },
    },
    {
      name: 'body was not multipart',
      arrange() {
        stubHappy();
      },
      request() {
        return createMockReq('POST', { body: Buffer.from('nope', 'utf8'), contentType: 'text/plain' });
      },
    },
    {
      name: 'no audio in the upload',
      arrange() {
        stubHappy();
      },
      request() {
        return createMockReq('POST', { body: uploadBody(DEFAULT_FIELDS, null) });
      },
    },
    {
      name: 'grounded context was not JSON',
      arrange() {
        stubHappy();
      },
      request() {
        return createMockReq('POST', {
          body: uploadBody([...DEFAULT_FIELDS, { name: 'componentTree', value: 'not json' }]),
        });
      },
    },
    {
      name: 'config not available',
      arrange() {
        vi.stubEnv('VIEWPOINT_CONFIG', `{ not json, and the secret was ${FAKE_SECRET}`);
        stubHappy();
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

// ─── The server log ─────────────────────────────────────────────────────────

describe('api/capture/local — the server log', () => {
  it('names the provider, the code and the PATH — never the host or the secret', async () => {
    stubUpstream(() => {
      throw new TypeError(`fetch failed for ${SERVICE_URL} with ${FAKE_SECRET}`);
    });
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    const logged = logs.join('\n');
    // What an operator needs to act on: which provider, which code, which route.
    expect(logged).toContain('capture_upstream_unreachable');
    expect(logged).toContain('/transcribe');
    // What an operator does not get: fetch's own message embeds the URL, which
    // on a self-hosted install is an internal container name, and the secret is
    // not the log's business either.
    expect(logged).not.toContain('capture-service');
    expect(logged).not.toContain('http://');
    expect(logged).not.toContain(FAKE_SECRET);
    expectNoLeaks(res);
  });

  it('logs an upstream body as ONE bounded, flattened line and never in the response', async () => {
    stubUpstream(
      () =>
        new Response(`${UPSTREAM_MARKER}\n`.repeat(400), {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST'), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    // The response and the log are deliberately asymmetric: the log is where an
    // operator finds the upstream's own text, and the response gets a code and
    // nothing else. The marker stands in for meeting content.
    expectNoLeaks(res);

    const excerpts = logs.filter((line) => line.includes(UPSTREAM_MARKER));
    expect(excerpts).toHaveLength(1);
    // Flattening is not cosmetic: 400 newlines could otherwise forge 400 log
    // lines, and a forged line is how a transcript gets read as our own prose.
    expect(excerpts[0]).not.toContain('\n');
    // Bounded by MAX_LOG_EXCERPT in lib/ai/router.ts: 300 characters plus the
    // ellipsis, however much the upstream sent.
    const excerpt = excerpts[0].slice(excerpts[0].indexOf(UPSTREAM_MARKER));
    expect(excerpt.length).toBeLessThanOrEqual(301);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

// ─── The browser contract, end to end ───────────────────────────────────────

describe('api/capture/local — the browser contract through the real handler', () => {
  /**
   * A fetchFn for LocalCaptureProvider that runs the REAL handler.
   *
   * The wire bytes are produced by the browser's own encoder: a Request is the
   * only WHATWG entry point that will serialise a FormData, and using it means
   * this test does not carry a second, hand-rolled multipart encoder that could
   * drift from the one the provider actually uses.
   */
  function handlerAsFetch(): typeof globalThis.fetch {
    return async (_input, init) => {
      const form = init?.body;
      if (!(form instanceof FormData)) {
        throw new Error('the provider must post a FormData body');
      }
      const wire = new Request('http://localhost/api/capture/local', {
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

  function recording(): Blob {
    return new Blob([AUDIO_BYTES], { type: 'audio/webm' });
  }

  it('still hands LocalCaptureProvider validated InsightCards', async () => {
    stubHappy([CARD]);

    const cards = await provider().captureRecording(recording(), {
      agendaIdx: 3,
      slideTitle: 'Bracket moulding',
    });

    // The URL, the multipart shape and the `{ cards }` response are all things
    // the browser already relied on; the rewrite changed what happens in between.
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('insight-1');
    expect(cards[0].type).toBe('RISK');
    expect(cards[0].details.priority).toBe('High');
    expect(cards[0].timestamp).toBe(1_700_000_000_000);
  });

  it('still refuses an invented componentReference, with a safe code', async () => {
    stubUpstream((url) =>
      upstreamReply(
        url.endsWith('/transcribe')
          ? TRANSCRIPT_REPLY
          : {
              cards: [
                { ...CARD, details: { priority: 'High', componentReference: 'not-in-the-model' } },
              ],
            },
      ),
    );

    const error = await provider()
      .captureRecording(
        recording(),
        { agendaIdx: 3, slideTitle: 'Bracket moulding' },
        { grounded: { componentTree: COMPONENT_TREE } },
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(LocalCaptureError);
    const failure = error as LocalCaptureError;
    // A card pointing at a part that is not in the model sends a reviewer hunting
    // for geometry that does not exist.
    expect(failure.code).toBe('capture_parse_error');
    expect(failure.status).toBe(422);
    expect(failure.message).not.toContain('not-in-the-model');
    expect(failure.message).not.toContain(UPSTREAM_MARKER);
  });

  it('still turns the service\'s own ceiling into the operator\'s own message', async () => {
    stubUpstream(() =>
      upstreamReply({ error: 'upload_too_large', maxUploadBytes: 1048576 }, 413),
    );

    const error = await provider()
      .captureRecording(recording(), { agendaIdx: 0, slideTitle: 'Kick-off' })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(LocalCaptureError);
    const failure = error as LocalCaptureError;
    expect(failure.code).toBe('upload_too_large');
    expect(failure.status).toBe(413);
    expect(failure.message).toContain('upload ceiling');
    expect(failure.message).not.toContain(FAKE_SECRET);
    expect(failure.message).not.toContain(SERVICE_URL);
  });
});
