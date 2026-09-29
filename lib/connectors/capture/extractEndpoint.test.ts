// Tests for POST and HEAD /api/capture/extract (T4.5, re-pointed by plan 14 BF).
//
// Two things are under test, in roughly equal measure:
//   1. Behaviour — the transcript reaches the right upstream in the right
//      shape, and the model's answer comes back as validated InsightCards.
//   2. SECURITY — the API key, the env var NAME that holds it, the raw
//      upstream body and the transcript itself never appear in a response,
//      on ANY path including every failure path.
//
// WHAT CHANGED. This endpoint no longer chooses an AI. The request body is
// `{ transcript, context, grounded? }` and a `provider` field in it is accepted
// and IGNORED, so a tab left open across a deploy keeps working. Which AI answers
// is resolved by lib/ai/router.ts — an app_settings row, else the `capture` block
// of viewpoint.config.ts, else the built-in stack — and every upstream call is
// made there too. So the tests below drive the ENDPOINT, not the router: the
// config is set through VIEWPOINT_CONFIG and globalThis.fetch is stubbed, which
// keeps each one end-to-end. That is deliberate. A test that mocked the router
// would still pass if the router put the key in the response, and the leak
// assertions are the only reason this file exists.
//
// JWT_SECRET is deliberately left UNSET (see resetEnv). With no JWT_SECRET,
// api/_lib/serviceRole.ts cannot mint a service-role token, lib/ai/settingsStore
// resolves every read to null and logs one line, and resolution falls through to
// the config. That is the state a deployment which has never opened the admin
// console's AI section is in, and it means these tests need no store mocking —
// and make no network call they did not ask for.
//
// No test here touches the network: globalThis.fetch is always stubbed, and
// every key is an obviously-fake placeholder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlideContext, TranscriptChunk } from './types';
import { hashPassword, signToken } from '../../../api/_lib/accessControl.ts';

const FAKE_OPENAI_KEY = 'sk-FAKEFAKEFAKEFAKEFAKEFAKE00';
const FAKE_ANTHROPIC_KEY = 'sk-ant-FAKEFAKEFAKEFAKEFAKE00';
const FAKE_CUSTOM_KEY = 'custom-FAKEFAKEFAKEFAKEFAKE00';

/** Marker strings: if one of these reaches a response, that is a leak. */
const TRANSCRIPT_MARKER = 'TRANSCRIPT-MARKER-do-not-echo';
const UPSTREAM_MARKER = 'UPSTREAM-BODY-MARKER-do-not-echo';

/** Where the built-in stack lives, for the configs that resolve to it. */
const BUILTIN_URL = 'http://capture-service.test';

const transcript: TranscriptChunk[] = [
  {
    speakerId: 'speaker-1',
    text: `The wall drops from 2.8mm to 1.2mm here. ${TRANSCRIPT_MARKER}`,
    startMs: 0,
    endMs: 4200,
  },
  {
    speakerId: 'speaker-2',
    text: 'That is going to sink on the A-surface.',
    startMs: 4200,
    endMs: 7000,
  },
];

const context: SlideContext = {
  agendaIdx: 3,
  slideTitle: 'Bracket moulding review',
  hoveredPartName: 'Bracket Alpha',
  laserTargetPartName: 'Rib Pattern 2',
};

const VALID_MODEL_JSON = JSON.stringify({
  cards: [
    {
      type: 'RISK',
      title: 'Wall transition risks sink marks',
      description: 'A 57% wall reduction historically causes sink on A-surfaces.',
      agentId: 'speaker-1',
      relatedPoiId: 'Bracket Alpha',
      sourceMessageIds: ['c0', 'c1'],
      details: {
        priority: 'High',
        componentReference: 'Bracket Alpha',
        impact: 'Visible sink on the A-surface',
        mitigationStrategy: 'Re-run moldflow',
      },
    },
  ],
});

// ─── The deployment's config ────────────────────────────────────────────────
//
// loadConfig validates the WHOLE schema and then refuses a config whose `*Env`
// variables are unset, so a test cannot hand the router a bare `{ capture }`.
// Nor should it want to: VIEWPOINT_CONFIG is the same door a real deployment
// uses, which is what makes the resolution below the real resolution.

const CONFIG_SHELL = {
  plm: { provider: 'none' },
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

/** Point the deployment at one `capture` block, and satisfy checkEnvVars. */
function pinCaptureConfig(capture: Record<string, unknown>): void {
  process.env.VIEWPOINT_CONFIG = JSON.stringify({ ...CONFIG_SHELL, capture });
  process.env.COTURN_SHARED_SECRET = 'fake-coturn-secret';
}

const OPENAI_CAPTURE = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKeyEnv: 'OPENAI_API_KEY',
};

const ANTHROPIC_CAPTURE = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
};

/** Resolves to `builtin`: the bundled Whisper and Qwen behind BUILTIN_URL. */
const LOCAL_CAPTURE = { provider: 'local', serviceUrl: BUILTIN_URL };

// ─── Vercel req/res doubles (same shape as notify/__tests__) ────────────────

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

function createMockReq(method: string, body?: unknown, extra?: Record<string, unknown>) {
  return { method, body, headers: {}, ...extra } as never;
}

async function callHandler(req: unknown, res: MockRes): Promise<void> {
  const { default: handler } = await import('../../../api/capture/extract.ts');
  await handler(req as never, res as never);
}

interface StubbedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Stubs fetch and records what the router actually sent upstream. */
function stubUpstream(
  reply: () => Response | Promise<Response>,
): { calls: StubbedCall[] } {
  const calls: StubbedCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    // Headers normalises names to lowercase, so the assertions below read
    // `headers.authorization`, not the `Authorization` the router set.
    const rawHeaders = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    rawHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    } catch {
      body = {};
    }
    calls.push({ url, headers, body });
    return reply();
  });
  return { calls };
}

/** A fetch spy that records calls and asserts none were made. */
function stubNoUpstream(): { calls: StubbedCall[] } {
  return stubUpstream(() => new Response('{}', { status: 200 }));
}

function openAiReply(content: string, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function anthropicReply(text: string, stopReason = 'end_turn'): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stopReason }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** capture-service answers with the structured envelope, not with model text. */
function builtinReply(cards: unknown): Response {
  return new Response(JSON.stringify({ cards }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every string that must never reach the browser. */
const FORBIDDEN = [
  FAKE_OPENAI_KEY,
  FAKE_ANTHROPIC_KEY,
  FAKE_CUSTOM_KEY,
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CUSTOM_CAPTURE_KEY',
  'apiKeyEnv',
  TRANSCRIPT_MARKER,
  UPSTREAM_MARKER,
];

function expectNoLeaks(res: MockRes): void {
  const serialized = JSON.stringify(res._body ?? '');
  for (const forbidden of FORBIDDEN) {
    expect(serialized, `response leaked ${forbidden}`).not.toContain(forbidden);
  }
}

function expectNoLeaksInLogs(logs: string[]): void {
  const serialized = logs.join('\n');
  for (const key of [FAKE_OPENAI_KEY, FAKE_ANTHROPIC_KEY, FAKE_CUSTOM_KEY]) {
    expect(serialized, `server log leaked ${key}`).not.toContain(key);
  }
}

/**
 * Every env var these tests touch, cleared.
 *
 * JWT_SECRET is deleted explicitly rather than merely never set: the whole
 * no-mocking trick in the header depends on the settings store being unable to
 * sign a service-role token, and a developer's shell exporting one would
 * otherwise turn these into tests of a database nobody has.
 */
function resetEnv(): void {
  for (const name of [
    'VIEWPOINT_CONFIG',
    'COTURN_SHARED_SECRET',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'CUSTOM_CAPTURE_KEY',
    'ACCESS_PASSWORD_HASH',
    'CAPTURE_SERVICE_URL',
    'JWT_SECRET',
  ]) {
    delete process.env[name];
  }
}

describe('api/capture/extract — behaviour', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns validated InsightCards for an OpenAI reply', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    const body = res._body as { cards: Array<Record<string, unknown>> };
    // The success envelope carries cards and NOTHING else, so the browser
    // client can re-validate it with the same strict parser (which rejects
    // unknown envelope fields) rather than a second, laxer schema. In
    // particular it does not carry the provider that answered: which AI ran is
    // not the browser's business and never becomes a field it can depend on.
    expect(Object.keys(body)).toEqual(['cards']);
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0].type).toBe('RISK');
    expect(body.cards[0].title).toBe('Wall transition risks sink marks');
    expect(body.cards[0].details).toMatchObject({
      priority: 'High',
      status: 'Open',
      impact: 'Visible sink on the A-surface',
    });
    // id and timestamp are minted server-side, never left to the model.
    expect(typeof body.cards[0].id).toBe('string');
    expect(typeof body.cards[0].timestamp).toBe('number');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expectNoLeaks(res);
  });

  it('sends the OpenAI request with the key, JSON mode and temperature 0', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    // The key IS used — server-side, in the upstream request only, read from
    // the variable the deployment's config named.
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_OPENAI_KEY}`);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.model).toBe('gpt-4o-mini');
    // Pinned across TypeScript and capture-service by
    // capture-service/tests/test_typescript_parity.py: a reply that hits this
    // ceiling is reported as truncated, so the number has to be the same one.
    expect(calls[0].body.max_tokens).toBe(4096);
    expectNoLeaks(res);
  });

  it('fuses the transcript and the spatial context into the prompt', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    // The system prompt is the format contract: it names the three insight
    // types and the exact envelope the parser enforces.
    expect(messages[0].content).toContain('RISK');
    expect(messages[0].content).toContain('"cards"');
    expect(messages[1].role).toBe('user');

    const user = messages[1].content;
    expect(user).toContain('Agenda item 3: Bracket moulding review');
    expect(user).toContain('hovering over: Bracket Alpha');
    expect(user).toContain('laser pointer was on: Rib Pattern 2');
    // Speaker labels and stable chunk labels the model cites in sourceMessageIds.
    expect(user).toContain('c0 [00:00-00:04] speaker-1:');
    expect(user).toContain('c1 [00:04-00:07] speaker-2:');
    expect(user).toContain(TRANSCRIPT_MARKER);
  });

  it('forwards the grounded pointing timeline and speaker hint to the cloud', async () => {
    // Batch D collected these three fields and the cloud path dropped them.
    // They now reach whichever provider the router chose, because an enterprise
    // gateway is at least as able to use them as our own service is.
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        transcript,
        context,
        grounded: {
          pointingSegments: [
            {
              userId: 'u1',
              userName: 'Dana',
              partId: 'p1',
              partName: 'Rib Pattern 2',
              fromMs: 1200,
              toMs: 3400,
            },
          ],
          transcriptHint: [{ speaker: 'Dana', text: 'right there', offsetMs: 1200 }],
        },
      }),
      res,
    );

    expect(res._statusCode).toBe(200);
    const user = (calls[0].body.messages as Array<{ content: string }>)[1].content;
    expect(user).toContain('What people were pointing at:');
    expect(user).toContain('Dana → Rib Pattern 2 (1s–3s)');
    expect(user).toContain('[Dana, t=1s] right there');
  });

  it('returns validated InsightCards for an Anthropic reply', async () => {
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    const { calls } = stubUpstream(() => anthropicReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    const body = res._body as { cards: unknown[] };
    expect(Object.keys(body)).toEqual(['cards']);
    expect(body.cards).toHaveLength(1);

    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    // Anthropic takes the system prompt as a top-level field, not a message.
    expect(typeof calls[0].body.system).toBe('string');
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[0].body.max_tokens).toBe(4096);
    // No JSON mode on the Messages API, so nothing asks for one and the parser
    // unwraps the fence Anthropic habitually adds instead.
    expect(calls[0].body.response_format).toBeUndefined();
    expectNoLeaks(res);
  });

  it('concatenates Anthropic text blocks split across content entries', async () => {
    // A long answer can arrive as several text blocks; splitting the JSON
    // mid-token proves they are joined before parsing rather than parsed
    // block-by-block.
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    const splitAt = Math.floor(VALID_MODEL_JSON.length / 2);
    stubUpstream(
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: VALID_MODEL_JSON.slice(0, splitAt) },
              { type: 'thinking', thought: 'not a text block' },
              { type: 'text', text: VALID_MODEL_JSON.slice(splitAt) },
            ],
            stop_reason: 'end_turn',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect((res._body as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it('returns an empty card list when the model found nothing to capture', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(() => openAiReply('{"cards":[]}'));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect((res._body as { cards: unknown[] }).cards).toEqual([]);
  });

  it('returns validated InsightCards end to end when the built-in stack answers', async () => {
    // The resolution a fresh install gets. capture-service answers with the
    // structured envelope rather than model text, and the router re-validates it
    // with the same strict parser — so a half-built card cannot reach the
    // tracker even though a layer in between already checked it.
    pinCaptureConfig(LOCAL_CAPTURE);
    const { calls } = stubUpstream(() => builtinReply(JSON.parse(VALID_MODEL_JSON).cards));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BUILTIN_URL}/extract`);
    // The grounded fields travel as JSON in the body, not as string form fields.
    expect(calls[0].body.transcript).toEqual(transcript);
    expect(calls[0].body.context).toEqual(context);
    expect(Object.keys(res._body as object)).toEqual(['cards']);
    expect((res._body as { cards: unknown[] }).cards).toHaveLength(1);
    expectNoLeaks(res);
  });
});

describe('api/capture/extract — HEAD is a probe, not a billable call', () => {
  beforeEach(() => {
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('answers 200 {} from the resolution alone when a usable provider exists', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('HEAD'), res);

    expect(res._statusCode).toBe(200);
    expect(res._body).toEqual({});
    // A health poll that spent money on a model call would be a health poll
    // nobody could afford to run, so it must not reach the upstream at all.
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 503 capture_not_configured when the resolved provider has no usable key', async () => {
    // checkEnvVars refuses an EMPTY variable, so the way a real config reaches
    // "this provider needs a credential and none is usable" is a value that is
    // set but blank — which is what an operator's `OPENAI_API_KEY= ` line in a
    // .env file produces. describeResolution trims before it judges, and so does
    // requireSecret, so the probe and the POST agree.
    pinCaptureConfig(OPENAI_CAPTURE);
    process.env.OPENAI_API_KEY = '   ';
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('HEAD'), res);

    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('answers 200 for a built-in resolution, which needs no credential', async () => {
    // `builtin` has no secret field, so "is it usable" cannot depend on a key:
    // the bundled Whisper and Qwen ship with the installation.
    pinCaptureConfig(LOCAL_CAPTURE);
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('HEAD'), res);

    expect(res._statusCode).toBe(200);
    expect(res._body).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('answers 200 rather than failing when there is no config at all', async () => {
    // No VIEWPOINT_CONFIG and no viewpoint.config.ts: loadConfig throws, the
    // router falls through to `builtin`, and a deployment that has never been
    // configured still probes as available. resolveJob never throws — that
    // guarantee is what this asserts from the outside.
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('HEAD'), res);

    expect(res._statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('is gated by the front-door password like any other method', async () => {
    // The probe is cheap but it is not free: it tells a caller whether this
    // deployment has a working AI behind it, which is worth a password.
    pinCaptureConfig(OPENAI_CAPTURE);
    process.env.ACCESS_PASSWORD_HASH = hashPassword('right-password');
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('HEAD', undefined, { cookies: {} }), res);

    expect(res._statusCode).toBe(401);
    expect(res._body).toEqual({ error: 'locked' });
    expect(calls).toHaveLength(0);
  });
});

describe('api/capture/extract — the request no longer chooses the AI', () => {
  beforeEach(() => {
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('ignores a provider field and sends the request to the configured vendor', async () => {
    // The deployment resolved Anthropic. A body asking for OpenAI must not be
    // honoured — and must not be refused either, because the browser that sent
    // it is an older bundle that has no way to know the decision moved.
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    const { calls } = stubUpstream(() => anthropicReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', { provider: 'openai', transcript, context }),
      res,
    );

    expect(res._statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe(FAKE_ANTHROPIC_KEY);
    expect(calls[0].headers.authorization).toBeUndefined();
    expectNoLeaks(res);
  });

  it('accepts a provider value it has never heard of instead of 400ing', async () => {
    // This replaces the old "rejects a provider that is not openai or
    // anthropic" test. Refusing an unknown provider would break every stale tab
    // open across a deploy, for a field the server does not read any more.
    pinCaptureConfig(LOCAL_CAPTURE);
    for (const provider of ['ollamaDirect', 'mock', 'OPENAI', 'gpt-store', null, 42]) {
      const { calls } = stubUpstream(() => builtinReply([]));
      const res = createMockRes();

      await callHandler(
        createMockReq('POST', { provider, transcript, context }),
        res,
      );

      expect(res._statusCode, `provider ${String(provider)}`).toBe(200);
      expect(calls).toHaveLength(1);
      // The field is dropped rather than forwarded: the built-in stack has its
      // own contract and a `provider` in the body would be an unknown field to
      // capture-service and to a webhook alike.
      expect(Object.keys(calls[0].body).includes('provider')).toBe(false);
      expectNoLeaks(res);
    }
  });

  it('succeeds with no provider field at all, which is what the browser now sends', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe('api/capture/extract — request validation', () => {
  beforeEach(() => {
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
    pinCaptureConfig(OPENAI_CAPTURE);
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])(
    'rejects %s with 405 and an Allow header naming both live methods',
    async (method) => {
      const { calls } = stubNoUpstream();
      const res = createMockRes();

      await callHandler(createMockReq(method), res);

      expect(res._statusCode).toBe(405);
      expect(res._headers.Allow).toBe('POST, HEAD');
      expect(res._body).toEqual({ error: 'method_not_allowed' });
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects a non-object body as an empty transcript, naming no value', async () => {
    for (const body of ['transcript please', 42, null, undefined]) {
      const { calls } = stubNoUpstream();
      const res = createMockRes();

      await callHandler(createMockReq('POST', body), res);

      // `empty_transcript` rather than `invalid_body`: there is no transcript
      // array here, and the code a client switches on should say what is
      // missing rather than what is wrong.
      expect(res._statusCode, `body ${String(body)}`).toBe(400);
      expect(res._body).toEqual({ error: 'empty_transcript' });
      expect(calls).toHaveLength(0);
      expectNoLeaks(res);
    }
  });

  it('rejects an empty transcript before spending any tokens', async () => {
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript: [], context }), res);

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'empty_transcript' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed transcript chunk, naming the FIELD and never its value', async () => {
    const bad = [
      [undefined],
      ['not an object'],
      [{ speakerId: 'a', text: 'b', startMs: 0 }],
      [{ speakerId: 'a', text: 5, startMs: 0, endMs: 1 }],
      [{ speakerId: 'a', text: '   ', startMs: 0, endMs: 1 }],
      [{ speakerId: 'a', text: 'b', startMs: -1, endMs: 1 }],
      [{ speakerId: 'a', text: 'b', startMs: Number.NaN, endMs: 1 }],
      [{ speakerId: 'a', text: 'b', startMs: 0, endMs: Number.POSITIVE_INFINITY }],
    ];
    for (const t of bad) {
      const { calls } = stubNoUpstream();
      const res = createMockRes();

      await callHandler(createMockReq('POST', { transcript: t, context }), res);

      expect(res._statusCode).toBe(400);
      expect(res._body).toEqual({ error: 'invalid_body', fields: ['transcript'] });
      expect(calls).toHaveLength(0);
      expectNoLeaks(res);
    }
  });

  it('rejects a chunk whose speakerId is blank', async () => {
    // REGRESSION, and this test is red until api/capture/_request.ts is fixed.
    //
    // The committed endpoint validated a chunk with
    // `isNonEmptyString(entry.speakerId)` (git show HEAD:api/capture/extract.ts,
    // line 119). parseTranscriptChunk in api/capture/_request.ts checks
    // `speakerId === null` only — which a trimmed empty string is not — so a
    // chunk labelled with no speaker is now accepted and rendered into the
    // prompt as `c0 [00:00-00:04] :`.
    //
    // Not a leak, but it is a validator that stopped validating, and it is
    // shared by all four /api/capture/* endpoints. The fix is one clause in
    // parseTranscriptChunk: `speakerId === ''` alongside `text === ''`. The same
    // gap applies to parsePointingSegments (userId/userName/partId/partName) and
    // parseTranscriptHint (speaker), and to `name`/`path` in parseComponentTree,
    // where only `id` is held to be non-empty.
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        transcript: [{ speakerId: '   ', text: 'b', startMs: 0, endMs: 1 }],
        context,
      }),
      res,
    );

    expect(res._statusCode).toBe(400);
    expect(res._body).toEqual({ error: 'invalid_body', fields: ['transcript'] });
    expect(calls).toHaveLength(0);
  });

  it('does not put the offending chunk in the response', async () => {
    // The specific leak this guards: a validator that reports what it rejected
    // reports the transcript. `fields` names the key; the value stays here.
    const secretText = `the yield target is wrong ${TRANSCRIPT_MARKER}`;
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        transcript: [{ speakerId: 'a', text: secretText, startMs: 0, endMs: 'soon' }],
        context,
      }),
      res,
    );

    expect(res._statusCode).toBe(400);
    expect(JSON.stringify(res._body)).not.toContain(TRANSCRIPT_MARKER);
    expect(JSON.stringify(res._body)).not.toContain('soon');
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed slide context', async () => {
    const bad = [undefined, null, 'not an object', [], { agendaIdx: 'three' }, { agendaIdx: -1 }];
    for (const c of bad) {
      const { calls } = stubNoUpstream();
      const res = createMockRes();

      await callHandler(createMockReq('POST', { transcript, context: c }), res);

      expect(res._statusCode).toBe(400);
      expect(res._body).toEqual({ error: 'invalid_body', fields: ['context'] });
      expect(calls).toHaveLength(0);
      expectNoLeaks(res);
    }
  });

  it('defaults a missing or blank slideTitle rather than refusing the meeting', async () => {
    // A missing label is not a reason to refuse a review, and an empty string in
    // the prompt is worse than a generic one because the model then has nothing
    // to anchor the meeting to. Same substitution capture-service makes.
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));

    for (const c of [{ agendaIdx: 1 }, { agendaIdx: 1, slideTitle: '   ' }]) {
      const res = createMockRes();
      await callHandler(createMockReq('POST', { transcript, context: c }), res);
      expect(res._statusCode).toBe(200);
    }
    const user = (calls[0].body.messages as Array<{ content: string }>)[1].content;
    expect(user).toContain('Agenda item 1: Full meeting recording');
  });

  it('rejects a malformed grounded context instead of silently dropping it', async () => {
    // Silently dropping a component list is how a model starts inventing
    // component ids that do not exist in anyone's CAD tree, so a malformed one
    // refuses the whole request.
    const bad = [
      { componentTree: 'not an array' },
      { componentTree: [{ id: 'a', name: 'b' }] },
      { componentTree: [{ id: '', name: 'b', path: 'c' }] },
      { pointingSegments: [{ userId: 'u' }] },
      { transcriptHint: [{ speaker: 's', text: '', offsetMs: 0 }] },
      'not an object',
    ];
    for (const grounded of bad) {
      const { calls } = stubNoUpstream();
      const res = createMockRes();

      await callHandler(createMockReq('POST', { transcript, context, grounded }), res);

      expect(res._statusCode).toBe(400);
      expect(res._body).toEqual({ error: 'invalid_body', fields: ['grounded'] });
      expect(calls).toHaveLength(0);
      expectNoLeaks(res);
    }
  });

  it('rejects too many chunks with 413 before calling the model', async () => {
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const manyChunks: TranscriptChunk[] = Array.from({ length: 2001 }, (_, i) => ({
      speakerId: 's',
      text: 'ok',
      startMs: i,
      endMs: i + 1,
    }));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript: manyChunks, context }), res);

    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({ error: 'transcript_too_large', maxChunks: 2000 });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('rejects an over-long transcript with 413 before calling the model', async () => {
    // The character budget is checked AFTER shape validation, so a malformed
    // chunk cannot hide behind a too-large body.
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const huge: TranscriptChunk[] = Array.from({ length: 100 }, (_, i) => ({
      speakerId: `s${i}`,
      text: 'x'.repeat(2500),
      startMs: i * 1000,
      endMs: i * 1000 + 999,
    }));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript: huge, context }), res);

    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({ error: 'transcript_too_large', maxChars: 200000 });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });
});

describe('api/capture/extract — MALFORMED MODEL OUTPUT', () => {
  // Each case must come back as a 422 with a machine-readable `reason`, and
  // must never carry the model's text (which quotes the transcript). The reason
  // is the parser's own enum, forwarded by sendJobError and nothing else: the
  // parser's MESSAGE quotes the payload it rejected, so it stops at the router.
  let logs: string[];

  beforeEach(() => {
    logs = [];
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function expectParseFailure(
    modelOutput: string,
    reason: string,
    vendor: 'openai' | 'anthropic' = 'openai',
  ): Promise<MockRes> {
    pinCaptureConfig(vendor === 'openai' ? OPENAI_CAPTURE : ANTHROPIC_CAPTURE);
    stubUpstream(() =>
      vendor === 'openai' ? openAiReply(modelOutput) : anthropicReply(modelOutput),
    );
    const res = createMockRes();
    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode, `expected 422 for ${reason}`).toBe(422);
    expect(res._body).toEqual({ error: 'capture_parse_error', reason });
    expectNoLeaks(res);
    return res;
  }

  it('prose → 422 reason "prose"', async () => {
    await expectParseFailure(
      `Sure! Looking at the transcript, ${TRANSCRIPT_MARKER} is the main risk.`,
      'prose',
    );
  });

  it('truncated JSON → 422 reason "truncated_json"', async () => {
    await expectParseFailure(VALID_MODEL_JSON.slice(0, 90), 'truncated_json');
  });

  it('unclosed markdown fence → 422 reason "markdown_fenced"', async () => {
    await expectParseFailure('```json\n' + VALID_MODEL_JSON, 'markdown_fenced');
  });

  it('extra fields → 422 reason "extra_fields"', async () => {
    await expectParseFailure(
      JSON.stringify({
        cards: [{ ...JSON.parse(VALID_MODEL_JSON).cards[0], confidence: 0.9 }],
      }),
      'extra_fields',
    );
  });

  it('a bare array → 422 reason "wrong_envelope"', async () => {
    await expectParseFailure(JSON.stringify(JSON.parse(VALID_MODEL_JSON).cards), 'wrong_envelope');
  });

  it('an invalid enum value → 422 reason "invalid_card"', async () => {
    await expectParseFailure(
      JSON.stringify({
        cards: [{ ...JSON.parse(VALID_MODEL_JSON).cards[0], type: 'OBSERVATION' }],
      }),
      'invalid_card',
    );
  });

  it('the same four cases are handled identically for Anthropic', async () => {
    await expectParseFailure('No insights found in this window.', 'prose', 'anthropic');
    await expectParseFailure(VALID_MODEL_JSON.slice(0, 90), 'truncated_json', 'anthropic');
    await expectParseFailure('```\n' + VALID_MODEL_JSON, 'markdown_fenced', 'anthropic');
    await expectParseFailure(
      JSON.stringify({ cards: [], note: 'nothing found' }),
      'extra_fields',
      'anthropic',
    );
  });

  it('parses a CLOSED markdown fence, which is Anthropic normal behaviour', async () => {
    // The Messages API has no JSON mode, so a fence is what a well-behaved
    // Anthropic reply usually looks like. Unwrapping is not guesswork — only the
    // delimiters go, and JSON.parse still validates everything inside — so this
    // is a 200 and not a parse failure.
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    stubUpstream(() => anthropicReply('```json\n' + VALID_MODEL_JSON + '\n```'));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect((res._body as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it('a reply with no message content at all → 422 reason "wrong_envelope"', async () => {
    // The chat answer had no `message.content` string to parse, which is the
    // provider's envelope being wrong rather than the model's prose being wrong.
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(
      () =>
        new Response(JSON.stringify({ choices: [{ message: {}, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'capture_parse_error', reason: 'wrong_envelope' });
    expectNoLeaks(res);
  });

  it('an Anthropic reply with no text block → 422 reason "prose"', async () => {
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    stubUpstream(
      () =>
        new Response(JSON.stringify({ content: [], stop_reason: 'end_turn' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'capture_parse_error', reason: 'prose' });
    expectNoLeaks(res);
  });

  it('refuses a card that names a component not in the model', async () => {
    // checkComponents runs for EVERY provider, so an invented component id is
    // refused here too and not only by the cloud parser: a card pointing at
    // geometry that does not exist sends a reviewer hunting for nothing.
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', {
        transcript,
        context,
        grounded: { componentTree: [{ id: 'Rib Pattern 9', name: 'Rib', path: '/Rib' }] },
      }),
      res,
    );

    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'capture_parse_error', reason: 'invalid_card' });
    expectNoLeaks(res);
  });

  it('logs the failure without logging the model output', async () => {
    await expectParseFailure(`Prose mentioning ${TRANSCRIPT_MARKER}`, 'prose');

    const logged = logs.join('\n');
    expect(logged).toContain('capture_parse_error');
    expect(logged).not.toContain(TRANSCRIPT_MARKER);
    expectNoLeaksInLogs(logs);
  });

  it('reports a completion cut short by the token limit distinctly', async () => {
    // finish_reason is checked BEFORE the text is read: a truncated answer is a
    // different failure with a different fix (a longer ceiling, a shorter
    // meeting), and reporting it as unparseable JSON sends an operator looking
    // at the model instead of at the length.
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(() => openAiReply('{"cards":[{', 'length'));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'capture_output_truncated' });
    expectNoLeaks(res);
  });

  it('reports Anthropic stop_reason max_tokens distinctly', async () => {
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    stubUpstream(() => anthropicReply('{"cards":[{', 'max_tokens'));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(422);
    expect(res._body).toEqual({ error: 'capture_output_truncated' });
  });
});

describe('api/capture/extract — upstream and configuration failures', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('503 when the configured key is blank, naming the variable in the LOG and never in the body', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    process.env.OPENAI_API_KEY = '   ';
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(503);
    // The body is a code and nothing else. It used to carry `provider` too; it
    // does not now, because which AI the deployment resolved is the admin
    // console's answer to give, not a response field a browser can depend on.
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
    // The RESPONSE names neither the variable nor the key: a body has no business
    // describing a deployment's environment layout to whoever can reach the origin.
    expect(JSON.stringify(res._body)).not.toContain('OPENAI_API_KEY');
    // The SERVER LOG names the variable, and that is a restoration rather than a
    // relaxation — api/capture/extract.ts logged it before batch BF moved the
    // upstream calls into the router. A NAME is not a secret: install.sh writes it
    // into viewpoint.config.ts, in this same container. Without it an operator sees
    // `capture_not_configured` and has to guess which of the deployment's half a
    // dozen variables to go and set.
    const logged = logs.join('\n');
    expect(logged).toContain('capture_not_configured');
    expect(logged).toContain('ai/openai');
    expect(logged).toContain('OPENAI_API_KEY');
    expect(logged).not.toContain('sk-');
  });

  it('503 when nothing resolves at all, rather than throwing', async () => {
    // No config: loadConfig throws, resolveJob falls through to `builtin`, and
    // the built-in stack has no address either. The outcome is still a code from
    // the closed vocabulary and a 503 — never a 500 with a stack in it.
    delete process.env.OPENAI_API_KEY;
    pinCaptureConfig({ ...OPENAI_CAPTURE, apiKeyEnv: 'OPENAI_API_KEY' });
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(503);
    expect(res._body).toEqual({ error: 'capture_not_configured' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
  });

  it('502 when the upstream rejects the request, without forwarding its body', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(
      () =>
        new Response(`{"error":{"message":"${UPSTREAM_MARKER} invalid api key"}}`, {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    // 502 and NOT 401. Forwarding the upstream's status would let a provider's
    // 401 arrive at the browser as ours, where the access layer reads it as
    // "this person is not signed in" and sends them to a door they came through.
    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
    // The detail IS logged server-side, which is where an operator looks.
    expect(logs.join('\n')).toContain(UPSTREAM_MARKER);
  });

  it('502 for any non-2xx upstream, whatever status the upstream used', async () => {
    pinCaptureConfig(ANTHROPIC_CAPTURE);
    for (const status of [400, 401, 403, 404, 429, 500, 503, 529]) {
      stubUpstream(() => new Response(UPSTREAM_MARKER, { status }));
      const res = createMockRes();

      await callHandler(createMockReq('POST', { transcript, context }), res);

      expect(res._statusCode, `upstream ${status}`).toBe(502);
      expect(res._body).toEqual({ error: 'capture_upstream_error' });
      expectNoLeaks(res);
    }
  });

  it('logs an enormous upstream body as a bounded, flattened excerpt', async () => {
    // The bound is the property: an upstream that answers 500 with a megabyte of
    // stack trace must not put a megabyte in the server log, and a body
    // containing newlines must not be able to forge extra log lines.
    pinCaptureConfig(OPENAI_CAPTURE);
    const huge = `${UPSTREAM_MARKER}\n${'x'.repeat(5000)}\nfake-injected-log-line`;
    stubUpstream(() => new Response(huge, { status: 500 }));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(502);
    expectNoLeaks(res);
    const excerpt = logs.find((line) => line.includes(UPSTREAM_MARKER)) ?? '';
    expect(excerpt).not.toContain('\n');
    expect(excerpt).not.toContain('fake-injected-log-line');
    expect(excerpt.length).toBeLessThan(400);
    expect(excerpt).toContain('…');
  });

  it('never logs the key when fetch itself fails', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`fetch failed for https://api.openai.com with ${FAKE_OPENAI_KEY}`),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_unreachable' });
    expectNoLeaks(res);
    // fetch's own message is dropped rather than logged: it embeds the URL,
    // which can carry a deployment's internal hostname or a query string — and
    // here it also embeds the key.
    expectNoLeaksInLogs(logs);
    expect(logs.join('\n')).not.toContain('api.openai.com');
  });

  it('tolerates an upstream that returns a non-JSON error body', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(() => new Response('<html>gateway timeout</html>', { status: 504 }));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });

  it('502 capture_endpoint_unavailable for an upstream 200 whose body is not JSON', async () => {
    // The classic misconfiguration: a proxy, an SPA fallback or the wrong port
    // answers 200 text/html for any path. "Something else is answering on that
    // address" is a different fix from "the model said something odd", so it
    // gets its own code rather than arriving as a parse failure.
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(() => new Response('not json at all', { status: 200 }));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_endpoint_unavailable' });
    expectNoLeaks(res);
  });

  it('502 capture_endpoint_unavailable for a JSON content type holding invalid JSON', async () => {
    pinCaptureConfig(OPENAI_CAPTURE);
    stubUpstream(
      () =>
        new Response('{not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_endpoint_unavailable' });
    expectNoLeaks(res);
  });

  it('499 request_closed when the caller hung up, and nothing else', async () => {
    // nginx's own code for a client that left, so the two agree. Logged by CODE
    // ONLY: an abort surfacing as some other error type carries a stack that can
    // quote the request, and the request is a recording.
    pinCaptureConfig(OPENAI_CAPTURE);
    const { calls } = stubNoUpstream();
    const controller = new AbortController();
    controller.abort();
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }, { signal: controller.signal }), res);

    expect(res._statusCode).toBe(499);
    expect(res._body).toEqual({ error: 'request_closed' });
    expect(calls).toHaveLength(0);
    expectNoLeaks(res);
    expect(logs.join('\n')).toContain('the client disconnected');
  });

  it('reads the key from the env var named by capture.apiKeyEnv in the config', async () => {
    // The variable NAME is deployment internals: it must reach the header and
    // never the response.
    pinCaptureConfig({
      provider: 'openai',
      model: 'gpt-4o-custom-deployment',
      apiKeyEnv: 'CUSTOM_CAPTURE_KEY',
    });
    process.env.CUSTOM_CAPTURE_KEY = FAKE_CUSTOM_KEY;
    delete process.env.OPENAI_API_KEY;

    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();
    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_CUSTOM_KEY}`);
    expect(calls[0].body.model).toBe('gpt-4o-custom-deployment');
    expectNoLeaks(res);
  });

  it('never borrows a key from the conventional variable the config did not name', async () => {
    // The config names CUSTOM_CAPTURE_KEY. OPENAI_API_KEY is set and must not be
    // used: a deployment that points capture at a gateway with its own secret
    // has to be able to leave a stale vendor key in the environment without the
    // router finding it and sending it somewhere it was never meant to go.
    pinCaptureConfig({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKeyEnv: 'CUSTOM_CAPTURE_KEY',
    });
    process.env.CUSTOM_CAPTURE_KEY = FAKE_CUSTOM_KEY;
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;

    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();
    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
    expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_CUSTOM_KEY}`);
    expect(calls[0].headers.authorization).not.toBe(`Bearer ${FAKE_OPENAI_KEY}`);
    expectNoLeaks(res);
  });

  it('forwards the built-in stack own code rather than flattening it', async () => {
    // capture-service is OUR OWN service and already speaks the browser's error
    // vocabulary. Forwarding its code — rather than turning every failure into
    // capture_upstream_error — is what keeps "the recording is larger than the
    // ceiling" distinguishable from "the model is not pulled" in the UI. Only an
    // allowlisted code crosses, and only with a number or an enum attached.
    pinCaptureConfig(LOCAL_CAPTURE);
    stubUpstream(
      () =>
        new Response(
          JSON.stringify({
            error: 'upload_too_large',
            maxUploadBytes: 209715200,
            detail: `${UPSTREAM_MARKER} and some prose`,
          }),
          { status: 413, headers: { 'content-type': 'application/json' } },
        ),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(413);
    expect(res._body).toEqual({ error: 'upload_too_large', maxUploadBytes: 209715200 });
    expectNoLeaks(res);
  });

  it('refuses to forward a code the browser has no case for', async () => {
    // An allowlist, not "anything matching [a-z_]+": a code an upstream invented
    // would render in the UI as a sentence we did not write.
    pinCaptureConfig(LOCAL_CAPTURE);
    stubUpstream(
      () =>
        new Response(JSON.stringify({ error: 'model_says_hello' }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(502);
    expect(res._body).toEqual({ error: 'capture_upstream_error' });
    expectNoLeaks(res);
  });
});

describe('api/capture/extract — the front-door password', () => {
  // This endpoint spends something — a GPU, a cloud API key, an enterprise
  // gateway's quota — and it attaches the deployment's own credential for every
  // caller. So when a front-door password is set it must not answer a caller who
  // has not entered it. Before this gate existed, the password guarded the
  // screens and left the spending endpoints open to anyone who could reach the
  // origin.
  const STORED = hashPassword('right-password');

  beforeEach(() => {
    resetEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = FAKE_OPENAI_KEY;
    pinCaptureConfig(OPENAI_CAPTURE);
  });

  afterEach(() => {
    resetEnv();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('refuses a POST with no cookie when a password is configured', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED;
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', { transcript, context }, { cookies: {} }),
      res,
    );

    expect(res._statusCode).toBe(401);
    expect(res._body).toEqual({ error: 'locked' });
    expect(calls).toHaveLength(0); // nothing was billed
    expectNoLeaks(res);
  });

  it('refuses a forged cookie', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED;
    const { calls } = stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', { transcript, context }, { cookies: { vp_access: 'deadbeef' } }),
      res,
    );

    expect(res._statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('gates before validation, so an unadmitted caller learns nothing about the body', async () => {
    // The 401 must win over the 400: a validation error describes what the
    // caller sent, and someone who has not been admitted is not owed a
    // description of their own request.
    process.env.ACCESS_PASSWORD_HASH = STORED;
    const { calls } = stubNoUpstream();
    const res = createMockRes();

    await callHandler(
      createMockReq('POST', { transcript: 'nonsense' }, { cookies: {} }),
      res,
    );

    expect(res._statusCode).toBe(401);
    expect(res._body).toEqual({ error: 'locked' });
    expect(calls).toHaveLength(0);
  });

  it('lets an unlocked caller through', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED;
    stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(
      createMockReq(
        'POST',
        { transcript, context },
        { cookies: { vp_access: signToken(STORED, 'vp_access') } },
      ),
      res,
    );

    expect(res._statusCode).toBe(200);
    expect((res._body as { cards: unknown[] }).cards).toHaveLength(1);
  });

  it('changes nothing when no password is configured', async () => {
    process.env.ACCESS_PASSWORD_HASH = '';
    stubUpstream(() => openAiReply(VALID_MODEL_JSON));
    const res = createMockRes();

    await callHandler(createMockReq('POST', { transcript, context }), res);

    expect(res._statusCode).toBe(200);
  });
});
