// @vitest-environment node
//
// Tests for POST /api/capture/summary — the third AI job (plan 14, batch BF).
//
// Two things are under test:
//
//   1. THE BUDGET AND THE VALIDATION. A summary runs once over a WHOLE meeting
//      rather than over a window, so its limits are wider than extraction's — and
//      wider limits are exactly where an unbounded prompt sneaks in. The cards it
//      accepts come from a browser and are about to be pasted into a prompt, so
//      they go through the same strict parser the extraction path uses.
//   2. NO LEAKS. The request body is a meeting. Every failure is asserted to carry
//      a code and nothing else: no transcript, no credential, no model output, no
//      upstream prose.
//
// `runJob` is mocked for the validation tests so each one exercises exactly one
// rule, and the last block drives the REAL router with fetch stubbed, because a
// leak assertion against a mock proves nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../lib/ai/router.ts', async (importOriginal) => ({
  // Keeps AiJobError and asAiJobError real: sendJobError in api/capture/_request.ts
  // depends on them, and mocking them would mock away the thing under test.
  ...(await importOriginal<typeof import('../../../lib/ai/router.ts')>()),
  runJob: vi.fn(),
}));

vi.mock('../../../lib/config/loadConfig.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/config/loadConfig.ts')>()),
  loadConfig: vi.fn(),
}));

import { runJob } from '../../../lib/ai/router.ts';
import { loadConfig } from '../../../lib/config/loadConfig.ts';
import type { ViewpointConfig } from '../../../lib/config/schema.ts';
import { hashPassword, signToken } from '../../../api/_lib/accessControl.ts';

/** Marker text: if this reaches a response, the transcript leaked. */
const SENTINEL = 'SENTINEL-the-yield-blocker-nobody-may-echo';
/** Marker model output: if it reaches a response, an answer was echoed. */
const ANSWER_MARKER = 'ANSWER-MARKER-do-not-echo';

const FRONT_DOOR_HASH = hashPassword('front-door-passphrase');
const UNLOCKED_COOKIE = signToken(FRONT_DOOR_HASH, 'vp_access');

const TRANSCRIPT = [
  { speakerId: 'speaker-1', text: SENTINEL, startMs: 0, endMs: 4200 },
  { speakerId: 'speaker-2', text: 'Then we re-run the simulation.', startMs: 4200, endMs: 8400 },
];

/** A card the strict parser accepts, in the shape the app already holds. */
const VALID_CARD = {
  id: 'card-1',
  type: 'RISK',
  agentId: 'speaker-1',
  title: 'Bracket weld cracks under load',
  description: 'The reviewer said the weld will crack before the yield target.',
  timestamp: 1_700_000_000_000,
  details: { priority: 'High', status: 'Open', impact: 'Warranty returns' },
};

const MOCK_CONFIG: ViewpointConfig = {
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
} as ViewpointConfig;

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(data: unknown): MockRes;
  setHeader(name: string, value: string): MockRes;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
}

function makeReq(body: unknown, options: { method?: string; unlocked?: boolean } = {}) {
  const cookies: Record<string, string> = {};
  if (options.unlocked !== false) cookies.vp_access = UNLOCKED_COOKIE;
  return {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    query: {},
    cookies,
  } as never;
}

async function call(body: unknown, options: { method?: string; unlocked?: boolean } = {}) {
  const { default: handler } = await import('../../../api/capture/summary.ts');
  const res = createMockRes();
  await handler(makeReq(body, options), res as never);
  return res;
}

/** Asserts the four things that must never appear in a response body. */
function expectNoLeak(res: MockRes) {
  const body = JSON.stringify(res.body ?? null);
  expect(body).not.toContain(SENTINEL);
  expect(body).not.toContain(ANSWER_MARKER);
  expect(body).not.toContain('sk-');
}

describe('POST /api/capture/summary — validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, ACCESS_PASSWORD_HASH: FRONT_DOOR_HASH };
    vi.mocked(runJob).mockResolvedValue({ job: 'summary', summary: '## Decisions\n\nNone.' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  it('rejects GET with 405 and an Allow header', async () => {
    const res = await call({}, { method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
    expect(runJob).not.toHaveBeenCalled();
  });

  it('is held to the front-door password, before the body is read', async () => {
    // This route spends a model call, so an unadmitted caller must not reach one.
    const res = await call({ transcript: TRANSCRIPT }, { unlocked: false });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'locked' });
    expect(runJob).not.toHaveBeenCalled();
  });

  it('summarises a transcript and its cards', async () => {
    const res = await call({ transcript: TRANSCRIPT, cards: [VALID_CARD], title: 'Rear bracket review' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ summary: '## Decisions\n\nNone.' });

    const [job, input] = vi.mocked(runJob).mock.calls[0];
    expect(job).toBe('summary');
    expect(input).toMatchObject({ transcript: TRANSCRIPT, title: 'Rear bracket review' });
    expect((input as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it('summarises cards alone — a curated review that was never recorded', async () => {
    const res = await call({ cards: [VALID_CARD] });
    expect(res.statusCode).toBe(200);
    const [, input] = vi.mocked(runJob).mock.calls[0];
    expect((input as { transcript: unknown[] }).transcript).toEqual([]);
  });

  it('summarises a transcript alone', async () => {
    const res = await call({ transcript: TRANSCRIPT });
    expect(res.statusCode).toBe(200);
    const [, input] = vi.mocked(runJob).mock.calls[0];
    expect((input as { cards: unknown[] }).cards).toEqual([]);
  });

  it('refuses a request with neither a transcript nor a card', async () => {
    // A 400 rather than an empty document: an operator who wired this up wrong
    // should see that, not a blank panel that looks like the model said nothing.
    const res = await call({ transcript: [], cards: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'empty_summary_input' });
    expect(runJob).not.toHaveBeenCalled();
  });

  it('refuses a body with nothing in it at all', async () => {
    const res = await call({});
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'empty_summary_input' });
  });

  it('accepts and ignores a provider field, because the server decides', async () => {
    const res = await call({ transcript: TRANSCRIPT, provider: 'anthropic' });
    expect(res.statusCode).toBe(200);
    const [, input] = vi.mocked(runJob).mock.calls[0];
    expect(input).not.toHaveProperty('provider');
  });

  it.each([
    ['a transcript that is not an array', { transcript: 'hello', cards: [VALID_CARD] }, ['transcript']],
    ['a malformed transcript chunk', { transcript: [{ text: 42 }], cards: [VALID_CARD] }, ['transcript']],
    ['a chunk with blank text', { transcript: [{ ...TRANSCRIPT[0], text: '   ' }], cards: [VALID_CARD] }, ['transcript']],
    ['a chunk with a negative timestamp', { transcript: [{ ...TRANSCRIPT[0], startMs: -1 }], cards: [VALID_CARD] }, ['transcript']],
    ['cards that are not an array', { transcript: TRANSCRIPT, cards: VALID_CARD }, ['cards']],
    ['a title that is not a string', { transcript: TRANSCRIPT, cards: [], title: 42 }, ['title']],
  ])('refuses %s, naming the field and never a value', async (_label, body, fields) => {
    const res = await call(body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_body', fields });
    // The field NAME is safe to repeat; the value is transcript.
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('refuses a transcript over the chunk budget', async () => {
    const chunks = Array.from({ length: 4001 }, (_unused, i) => ({
      ...TRANSCRIPT[0],
      text: `line ${i}`,
      startMs: i * 1000,
      endMs: i * 1000 + 900,
    }));
    const res = await call({ transcript: chunks, cards: [] });
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'transcript_too_large', maxChunks: 4000 });
    expectNoLeak(res);
  });

  it('refuses a transcript over the character budget', async () => {
    const chunks = Array.from({ length: 5 }, (_unused, i) => ({
      ...TRANSCRIPT[0],
      text: 'x'.repeat(90_000) + String(i),
      startMs: i * 1000,
      endMs: i * 1000 + 900,
    }));
    const res = await call({ transcript: chunks, cards: [] });
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ error: 'transcript_too_large', maxChars: 400_000 });
    expectNoLeak(res);
  });

  it('refuses more cards than a prompt budget can carry', async () => {
    const cards = Array.from({ length: 501 }, (_unused, i) => ({ ...VALID_CARD, id: `card-${i}` }));
    const res = await call({ transcript: TRANSCRIPT, cards });
    expect(res.statusCode).toBe(413);
    expect(res.body).toMatchObject({ error: 'invalid_body', fields: ['cards'], maxCards: 500 });
  });

  it('refuses a title longer than a title', async () => {
    const res = await call({ transcript: TRANSCRIPT, title: 'x'.repeat(201) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_body', fields: ['title'] });
  });

  it('trims a title and omits it when nothing is left', async () => {
    await call({ transcript: TRANSCRIPT, title: '   Rear bracket  ' });
    expect((vi.mocked(runJob).mock.calls[0][1] as { title?: string }).title).toBe('Rear bracket');

    vi.mocked(runJob).mockClear();
    await call({ transcript: TRANSCRIPT, title: '   ' });
    expect((vi.mocked(runJob).mock.calls[0][1] as { title?: string }).title).toBeUndefined();
  });

  it('refuses a card the strict parser will not accept, with a reason and no content', async () => {
    // These cards came from a browser and are about to be pasted into a prompt. A
    // card with a priority nobody chose would be laundered through the summary
    // into prose that reads as if the meeting said it.
    const res = await call({
      transcript: TRANSCRIPT,
      cards: [{ ...VALID_CARD, details: { ...VALID_CARD.details, priority: 'Urgent' } }],
    });
    expect(res.statusCode).toBe(422);
    expect((res.body as { error: string }).error).toBe('capture_parse_error');
    // Only the parser's enum crosses the wire; its message quotes the payload.
    expect(JSON.stringify(res.body)).toMatch(/"reason":"[a-z_]+"/);
    expectNoLeak(res);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('refuses a card with a field that is not part of the shape', async () => {
    const res = await call({
      transcript: TRANSCRIPT,
      cards: [{ ...VALID_CARD, sentiment: 0.9 }],
    });
    expect(res.statusCode).toBe(422);
    expect((res.body as { error: string }).error).toBe('capture_parse_error');
  });

  it('maps a router failure onto its code and status', async () => {
    const { AiJobError } = await import('../../../lib/ai/router.ts');
    vi.mocked(runJob).mockRejectedValue(
      new AiJobError('capture_not_configured', 503, 'openai', { note: 'no apiKey is stored for this job' }),
    );
    const res = await call({ transcript: TRANSCRIPT });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'capture_not_configured' });
    expectNoLeak(res);
  });

  it('translates an unexpected throw rather than forwarding it', async () => {
    // A bug's message is the one string here that might quote the transcript.
    vi.mocked(runJob).mockRejectedValue(new TypeError(`cannot read ${SENTINEL}`));
    const res = await call({ transcript: TRANSCRIPT });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeak(res);
    // The detail is logged, because a bug is what an operator needs to see.
    const logged = String(vi.mocked(console.error).mock.calls.flat().join(' '));
    expect(logged).toContain(SENTINEL);
  });

  it('refuses an answer longer than the ceiling instead of truncating it silently', async () => {
    vi.mocked(runJob).mockResolvedValue({ job: 'summary', summary: 'x'.repeat(40_001) });
    const res = await call({ transcript: TRANSCRIPT });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'capture_output_truncated' });
  });
});

describe('POST /api/capture/summary — the real router, with fetch stubbed', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv, ACCESS_PASSWORD_HASH: FRONT_DOOR_HASH };
    vi.mocked(loadConfig).mockResolvedValue(
      { ...MOCK_CONFIG, capture: { provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' } } as ViewpointConfig,
    );
    process.env.OPENAI_API_KEY = 'sk-FAKE-KEY-DO-NOT-LEAK-7f2a';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  /** Calls the handler with runJob unmocked, by re-importing both fresh. */
  async function callReal(body: unknown, reply: Response) {
    vi.doUnmock('../../../lib/ai/router.ts');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply);
    try {
      const { default: handler } = await import('../../../api/capture/summary.ts');
      const res = createMockRes();
      await handler(makeReq(body), res as never);
      return { res, fetchSpy };
    } finally {
      vi.doMock('../../../lib/ai/router.ts', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../../lib/ai/router.ts')>()),
        runJob: vi.fn(),
      }));
    }
  }

  it('sends the summary prompt, not the extraction prompt', async () => {
    const { SUMMARY_SYSTEM_PROMPT } = await import('../../../lib/ai/summaryPrompt.ts');
    const { res, fetchSpy } = await callReal(
      { transcript: TRANSCRIPT, cards: [VALID_CARD], title: 'Rear bracket review' },
      new Response(
        JSON.stringify({
          choices: [{ message: { content: `## Decisions\n\n${ANSWER_MARKER}` }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as { summary: string }).summary).toContain(ANSWER_MARKER);

    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
    };
    expect(sent.messages[0].content).toBe(SUMMARY_SYSTEM_PROMPT);
    // The transcript and the cards both reach the model — that is the request, not
    // a leak; the leak rule is about RESPONSES and LOGS.
    expect(sent.messages[1].content).toContain(SENTINEL);
    expect(sent.messages[1].content).toContain('Bracket weld cracks under load');
    // A summary is markdown. JSON mode would fence it or escape it into
    // unreadability.
    expect(sent.response_format).toBeUndefined();
  });

  it('answers a provider failure with a code and nothing else', async () => {
    const { res } = await callReal(
      { transcript: TRANSCRIPT, cards: [] },
      new Response(JSON.stringify({ error: { message: ANSWER_MARKER } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeak(res);
  });

  it('answers a non-JSON 200 with capture_endpoint_unavailable', async () => {
    // A proxy, an SPA fallback or the wrong port answers 200 text/html for any
    // path. Named, rather than surfaced as a JSON decode error quoting the page.
    const { res } = await callReal(
      { transcript: TRANSCRIPT, cards: [] },
      new Response(`<html>${ANSWER_MARKER}</html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'capture_endpoint_unavailable' });
    expectNoLeak(res);
  });
});
