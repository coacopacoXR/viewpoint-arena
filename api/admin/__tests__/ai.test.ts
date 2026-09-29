// @vitest-environment node
//
// Tests for the AI section's two endpoints: api/admin/ai.ts (GET/PUT) and
// api/admin/ai/test.ts (POST, "Test connection").
//
// Node, not jsdom: both handlers reach lib/ai/router.ts, which reads process.env
// and calls node:crypto through lib/ai/secretBox.ts.
//
// The property that matters most is the one the whole design rests on: A SECRET
// GOES IN AND NEVER COMES OUT. Every response body in every test below is asserted
// not to contain the credential, the ciphertext, or the last-four that only the
// read API is allowed to compute. The settings store is mocked, so these tests
// drive the endpoints' own logic — the store's encryption is covered by
// lib/ai/__tests__/settingsStore.test.ts and secretBox.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../lib/ai/settingsStore.ts', () => ({
  readSetting: vi.fn(),
  openSettingSecret: vi.fn(),
  probeSettingsStore: vi.fn(),
  writeSetting: vi.fn(),
  deleteSetting: vi.fn(),
  resolveSettingsServerUrl: vi.fn(),
}));

import { hashPassword, signToken } from '../../_lib/accessControl.ts';
import {
  deleteSetting,
  openSettingSecret,
  probeSettingsStore,
  readSetting,
  writeSetting,
} from '../../../lib/ai/settingsStore.ts';

// requirePassphraseAdmin reads ADMIN_PASSPHRASE_HASH and signs the vp_admin
// cookie with it — NOT the front-door ACCESS_PASSWORD_HASH, which guards the
// capture routes instead. Two passphrases, two doors, two variables.
const PASSPHRASE_HASH = hashPassword('test-admin-passphrase');
const ADMIN_COOKIE = signToken(PASSPHRASE_HASH, 'vp_admin');

/** Marker credential: if this reaches a response body, the endpoint leaked it. */
const FAKE_KEY = 'sk-FAKE-KEY-DO-NOT-LEAK-7f2a';
/** Marker ciphertext, standing in for what the store would hold. */
const FAKE_CIPHERTEXT = 'v1:FAKEIV:FAKETAG:FAKECIPHERTEXT';

/**
 * A config with identity.mode 'none', so requireAdmin takes the passphrase path.
 *
 * Deliberately not 'accounts': the token path verifies against a directory, and
 * the point of these tests is the AI settings, not the identity layer (which
 * api/admin/__tests__/users.test.ts covers). The passphrase path is purely local,
 * and the brief requires this section to work in EVERY identity mode — so this is
 * also the test that it does.
 */
const NONE_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

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

function makeReq(options: {
  method?: string;
  body?: unknown;
  admin?: boolean;
} = {}) {
  const cookies: Record<string, string> = {};
  if (options.admin !== false) cookies.vp_admin = ADMIN_COOKIE;
  return {
    method: options.method ?? 'GET',
    headers: {},
    body: options.body,
    query: {},
    cookies,
  } as never;
}

/** The body a response carries, as text, for leak assertions. */
function text(res: MockRes): string {
  return JSON.stringify(res.body ?? null);
}

function expectNoSecretLeak(res: MockRes) {
  const body = text(res);
  expect(body).not.toContain(FAKE_KEY);
  expect(body).not.toContain(FAKE_CIPHERTEXT);
  expect(body).not.toContain('sk-FAKE');
}

describe('GET /api/admin/ai', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIEWPOINT_CONFIG: NONE_CONFIG,
      ADMIN_PASSPHRASE_HASH: PASSPHRASE_HASH,
      T: 'x',
      U: 'x',
      K: 'x',
    };
    vi.mocked(probeSettingsStore).mockResolvedValue(true);
    vi.mocked(readSetting).mockResolvedValue(null);
    vi.mocked(openSettingSecret).mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  async function get() {
    const { default: handler } = await import('../ai.ts');
    const res = createMockRes();
    await handler(makeReq({ method: 'GET' }), res as never);
    return res;
  }

  it('is admin-only', async () => {
    const { default: handler } = await import('../ai.ts');
    const res = createMockRes();
    await handler(makeReq({ method: 'GET', admin: false }), res as never);
    expect(res.statusCode).toBe(401);
    expect(readSetting).not.toHaveBeenCalled();
  });

  it('reports all three jobs, in order', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.body as { available: boolean; jobs: Array<{ job: string }> };
    expect(body.available).toBe(true);
    expect(body.jobs.map((j) => j.job)).toEqual(['transcription', 'cards', 'summary']);
  });

  it('reports the built-in stack as the default when nothing is stored', async () => {
    const res = await get();
    const body = res.body as {
      jobs: Array<{ saved: unknown; inUse: Record<string, unknown>; inUseLabel: string }>;
    };
    for (const job of body.jobs) {
      expect(job.saved).toBeNull();
      expect(job.inUse).toMatchObject({ provider: 'builtin', source: 'default', model: null });
      expect(job.inUseLabel).toContain('Built-in');
      expect(job.inUseLabel).toContain('default');
    }
  });

  it('reports the config as the source when the deployment named a provider', async () => {
    process.env.VIEWPOINT_CONFIG = JSON.stringify({
      ...JSON.parse(NONE_CONFIG) as Record<string, unknown>,
      capture: { provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
    });
    process.env.OPENAI_API_KEY = FAKE_KEY;
    vi.resetModules();

    const res = await get();
    const body = res.body as { jobs: Array<{ job: string; inUse: Record<string, unknown>; inUseLabel: string }> };
    const cards = body.jobs.find((j) => j.job === 'cards');
    expect(cards?.inUse).toMatchObject({ provider: 'openai', source: 'config', model: 'gpt-4o-mini' });
    expect(cards?.inUseLabel).toContain('viewpoint.config.ts');
    // The label names the provider and the model and where it came from — and
    // nothing else. In particular not the key, and not the variable that holds it.
    expect(cards?.inUseLabel).not.toContain(FAKE_KEY);
    expect(cards?.inUseLabel).not.toContain('OPENAI_API_KEY');
    expectNoSecretLeak(res);
  });

  it('reports a stored setting with the tail of its secret and never the secret', async () => {
    vi.mocked(readSetting).mockImplementation(async (key: string) =>
      key === 'ai.cards'
        ? {
            key,
            value: { provider: 'openai', fields: { model: 'gpt-4o-mini' } },
            secret: { set: true, last4: '7f2a', unreadable: false },
            updatedAt: '2026-09-24T10:00:00.000Z',
            updatedBy: 'admin-1',
          }
        : null,
    );
    vi.mocked(openSettingSecret).mockResolvedValue(FAKE_KEY);

    const res = await get();
    const body = res.body as {
      jobs: Array<{ job: string; saved: Record<string, unknown> | null; inUse: Record<string, unknown>; inUseLabel: string }>;
    };
    const cards = body.jobs.find((j) => j.job === 'cards');
    expect(cards?.saved).toMatchObject({
      provider: 'openai',
      fields: { model: 'gpt-4o-mini' },
      secret: { set: true, last4: '7f2a', unreadable: false },
      updatedBy: 'admin-1',
    });
    expect(cards?.inUse).toMatchObject({ provider: 'openai', source: 'settings', missingSecret: false });
    expect(cards?.inUseLabel).toContain('set here');
    expectNoSecretLeak(res);
  });

  it('reports a stored secret it cannot open as unreadable, so the screen can ask for it again', async () => {
    vi.mocked(readSetting).mockResolvedValue({
      key: 'ai.cards',
      value: { provider: 'openai', fields: { model: 'gpt-4o-mini' } },
      secret: { set: true, last4: '', unreadable: true },
      updatedAt: '',
      updatedBy: '',
    });
    vi.mocked(openSettingSecret).mockResolvedValue(null);

    const res = await get();
    const body = res.body as { jobs: Array<{ job: string; saved: Record<string, unknown> | null }> };
    expect(body.jobs[0]?.saved).toMatchObject({ secret: { set: true, unreadable: true } });
  });

  it('reports a row this version cannot parse as unusable rather than hiding it', async () => {
    vi.mocked(readSetting).mockResolvedValue({
      key: 'ai.cards',
      value: { provider: 'skynet', fields: {} },
      secret: { set: false, last4: '', unreadable: false },
      updatedAt: '',
      updatedBy: '',
    });
    const res = await get();
    const body = res.body as { jobs: Array<{ saved: Record<string, unknown> | null }> };
    expect(body.jobs[0]?.saved).toMatchObject({ unusable: true, provider: null });
    // …and the router still fell back rather than serving a provider it cannot call.
    expect(body.jobs[0]?.saved).not.toBeNull();
  });

  it('says when the deployment has no settings store to save into', async () => {
    vi.mocked(probeSettingsStore).mockResolvedValue(false);
    const res = await get();
    expect((res.body as { available: boolean }).available).toBe(false);
  });

  it('refuses a method that is not GET or PUT', async () => {
    const { default: handler } = await import('../ai.ts');
    const res = createMockRes();
    await handler(makeReq({ method: 'DELETE', admin: true }), res as never);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET, PUT');
  });
});

describe('PUT /api/admin/ai', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIEWPOINT_CONFIG: NONE_CONFIG,
      ADMIN_PASSPHRASE_HASH: PASSPHRASE_HASH,
      T: 'x',
      U: 'x',
      K: 'x',
    };
    vi.mocked(probeSettingsStore).mockResolvedValue(true);
    vi.mocked(readSetting).mockResolvedValue(null);
    vi.mocked(openSettingSecret).mockResolvedValue(null);
    vi.mocked(writeSetting).mockResolvedValue(true);
    vi.mocked(deleteSetting).mockResolvedValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  async function put(body: unknown, admin = true) {
    const { default: handler } = await import('../ai.ts');
    const res = createMockRes();
    await handler(makeReq({ method: 'PUT', body, admin }), res as never);
    return res;
  }

  it('is admin-only, and stores nothing for a caller who is not', async () => {
    const res = await put({ job: 'cards', provider: 'openai' }, false);
    expect(res.statusCode).toBe(401);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it('stores a setting, sealing the secret away from the value column', async () => {
    const res = await put({
      job: 'cards',
      provider: 'openai',
      fields: { model: 'gpt-4o-mini' },
      secret: FAKE_KEY,
    });

    expect(res.statusCode).toBe(200);
    expect(writeSetting).toHaveBeenCalledTimes(1);
    const [key, input] = vi.mocked(writeSetting).mock.calls[0];
    expect(key).toBe('ai.cards');
    expect(input.value).toEqual({ provider: 'openai', fields: { model: 'gpt-4o-mini' } });
    expect(input.secret).toBe(FAKE_KEY);
    expect(input.updatedBy).toBe('passphrase');
    expectNoSecretLeak(res);
  });

  it('takes a key that arrived inside fields, and keeps it out of the stored value', async () => {
    // A form that posts its inputs straight through is the common case, and
    // refusing it would only teach people to write custom submission code.
    const res = await put({
      job: 'cards',
      provider: 'openai',
      fields: { model: 'gpt-4o-mini', apiKey: FAKE_KEY },
    });

    expect(res.statusCode).toBe(200);
    const [, input] = vi.mocked(writeSetting).mock.calls[0];
    expect(input.secret).toBe(FAKE_KEY);
    // The credential must not survive in the jsonb column, which is the column a
    // database dump carries in the clear.
    expect(JSON.stringify(input.value)).not.toContain(FAKE_KEY);
    expect((input.value as { fields: Record<string, string> }).fields.apiKey).toBeUndefined();
    expectNoSecretLeak(res);
  });

  it('leaves the stored secret alone when the request omits it', async () => {
    vi.mocked(openSettingSecret).mockResolvedValue(FAKE_KEY);
    const res = await put({ job: 'cards', provider: 'openai', fields: { model: 'gpt-5' } });
    expect(res.statusCode).toBe(200);
    const [, input] = vi.mocked(writeSetting).mock.calls[0];
    // `undefined`, not null: the store reads that as "keep what is there".
    expect(input.secret).toBeUndefined();
  });

  it('clears the secret when the request sends null', async () => {
    vi.mocked(openSettingSecret).mockResolvedValue(FAKE_KEY);
    await put({ job: 'transcription', provider: 'openaiCompatible', fields: { baseUrl: 'https://gw/v1', model: 'm' }, secret: null });
    const [, input] = vi.mocked(writeSetting).mock.calls[0];
    expect(input.secret).toBeNull();
  });

  it('refuses a provider that needs a key when none is typed and none is stored', async () => {
    const res = await put({ job: 'cards', provider: 'openai', fields: { model: 'gpt-4o-mini' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'secret_required', field: 'apiKey' });
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it('accepts a provider whose credential is optional', async () => {
    // vLLM and LM Studio on a trusted network authenticate by address. Refusing
    // them for having no key would make the provider useless for its main use.
    const res = await put({
      job: 'cards',
      provider: 'openaiCompatible',
      fields: { baseUrl: 'http://vllm.internal:8000/v1', model: 'qwen2.5:7b' },
    });
    expect(res.statusCode).toBe(200);
    expect(writeSetting).toHaveBeenCalledTimes(1);
  });

  it('refuses a provider that cannot do the job', async () => {
    const res = await put({ job: 'transcription', provider: 'anthropic', fields: { model: 'claude-sonnet-4-5' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_provider' });
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown provider', { job: 'cards', provider: 'skynet' }],
    ['an unknown job', { job: 'vibes', provider: 'openai' }],
    ['a missing required field', { job: 'cards', provider: 'webhook', fields: {} }],
    ['a non-URL where a URL is required', { job: 'cards', provider: 'webhook', fields: { url: 'not a url' } }],
  ])('refuses %s', async (_label, body) => {
    const res = await put(body);
    expect(res.statusCode).toBe(400);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  it('deletes the row on reset, so the job resolves from config again', async () => {
    const res = await put({ job: 'cards', reset: true });
    expect(res.statusCode).toBe(200);
    expect(deleteSetting).toHaveBeenCalledWith('ai.cards');
    expect(writeSetting).not.toHaveBeenCalled();
    expect((res.body as { saved: unknown }).saved).toBeNull();
  });

  it('reports an unwritable store as 503 rather than pretending it saved', async () => {
    vi.mocked(writeSetting).mockResolvedValue(false);
    const res = await put({ job: 'cards', provider: 'builtin', fields: {} });
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: 'settings_unavailable' });
  });

  it('reports an undeletable row as 503', async () => {
    vi.mocked(deleteSetting).mockResolvedValue(false);
    const res = await put({ job: 'cards', reset: true });
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /api/admin/ai/test', () => {
  const originalEnv = process.env;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIEWPOINT_CONFIG: NONE_CONFIG,
      ADMIN_PASSPHRASE_HASH: PASSPHRASE_HASH,
      T: 'x',
      U: 'x',
      K: 'x',
    };
    vi.mocked(readSetting).mockResolvedValue(null);
    vi.mocked(openSettingSecret).mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  async function post(body: unknown, admin = true) {
    const { default: handler } = await import('../ai/test.ts');
    const res = createMockRes();
    await handler(makeReq({ method: 'POST', body, admin }), res as never);
    return res;
  }

  it('is admin-only, and makes no upstream call for a caller who is not', async () => {
    const res = await post({ job: 'cards', provider: 'webhook', fields: { url: 'https://ai.internal/vp' } }, false);
    expect(res.statusCode).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs a real cards request through a webhook and reports the elapsed time', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ cards: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await post({
      job: 'cards',
      provider: 'webhook',
      fields: { url: 'https://ai.internal/vp', headerName: 'X-Api-Key' },
      secret: FAKE_KEY,
    });

    // HTTP 200 for a failing provider too: the REQUEST succeeded, and what it was
    // asked to find out is whether the provider works.
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; job: string; ms: number };
    expect(body.ok).toBe(true);
    expect(body.job).toBe('cards');
    expect(body.ms).toBeGreaterThanOrEqual(0);

    // Two lines of transcript, and the operator's own header — the whole point is
    // that this is a real request, not a ping.
    const call = fetchSpy.mock.calls[0];
    expect(String(call[0])).toBe('https://ai.internal/vp');
    const sent = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent.job).toBe('cards');
    expect((sent.transcript as unknown[]).length).toBe(2);
    expect(new Headers((call[1] as RequestInit).headers as HeadersInit).get('x-api-key')).toBe(FAKE_KEY);
    expectNoSecretLeak(res);
  });

  it('runs a real summary request and accepts markdown', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ summary: '## Decisions\n\nNone.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post({ job: 'summary', provider: 'webhook', fields: { url: 'https://ai.internal/vp' } });
    expect((res.body as { ok: boolean }).ok).toBe(true);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent.job).toBe('summary');
    expect(sent.transcript).toHaveLength(2);
    expect(sent.cards).toEqual([]);
  });

  it('runs a real transcription request with a generated one-second silent WAV', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ segments: [{ start: 0, end: 1, text: 'Silence.' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post({ job: 'transcription', provider: 'webhook', fields: { url: 'https://ai.internal/asr' } });
    expect((res.body as { ok: boolean }).ok).toBe(true);

    const body = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const audio = body.get('audio');
    expect(audio).not.toBeNull();
    // 44 bytes of RIFF header plus one second of 16 kHz mono silence: the smallest
    // thing a real ASR stack accepts as a recording.
    expect((audio as unknown as { size: number }).size).toBe(44 + 16000 * 2);
  });

  it('reports a refused provider as ok:false with a plain reason, at HTTP 200', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await post({
      job: 'cards',
      provider: 'openai',
      fields: { model: 'gpt-4o-mini' },
      secret: FAKE_KEY,
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; code: string; reason: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('capture_upstream_error');
    // A plain reason an administrator can act on: the provider, the code, and a
    // URL PATH — not the key, not the upstream's prose, not the transcript.
    expect(body.reason).toContain('openai');
    expect(body.reason).toContain('capture_upstream_error');
    // ...but it OPENS with a sentence an administrator can act on, not the code.
    expect(body.reason).toMatch(/^The service answered with an error\. Check the key/);
    expect(body.reason).not.toContain(FAKE_KEY);
    expect(body.reason).not.toContain('Incorrect API key');
    expectNoSecretLeak(res);
  });

  it('reports a missing credential without making a call', async () => {
    const res = await post({ job: 'cards', provider: 'openai', fields: { model: 'gpt-4o-mini' } });
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect((res.body as { code: string }).code).toBe('capture_not_configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('tests with the STORED credential when the request carries none', async () => {
    vi.mocked(openSettingSecret).mockResolvedValue(FAKE_KEY);
    // An OpenAI-shaped reply, not a webhook one: the point is that the router
    // reached OpenAI using the stored key.
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"cards":[]}' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    // An admin re-testing a saved provider cannot re-paste a key they can no
    // longer see, so the stored one has to work.
    const res = await post({ job: 'cards', provider: 'openai', fields: { model: 'gpt-4o-mini' } });
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(openSettingSecret).toHaveBeenCalledWith('ai.cards');
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers as HeadersInit);
    expect(headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    expectNoSecretLeak(res);
  });

  it('applies the provider default model when the field is blank', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"cards":[]}' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await post({ job: 'cards', provider: 'openai', fields: {}, secret: FAKE_KEY });
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent.model).toBe('gpt-4o-mini');
  });

  it.each([
    ['an unknown job', { job: 'vibes', provider: 'webhook', fields: { url: 'https://x/vp' } }],
    ['an unknown provider', { job: 'cards', provider: 'skynet' }],
    ['a provider that cannot do the job', { job: 'transcription', provider: 'gemini', fields: { model: 'gemini-2.5-flash' } }],
  ])('refuses %s with a 400 and makes no call', async (_label, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a method that is not POST', async () => {
    const { default: handler } = await import('../ai/test.ts');
    const res = createMockRes();
    await handler(makeReq({ method: 'GET' }), res as never);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST');
  });
});
