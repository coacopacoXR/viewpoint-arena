// @vitest-environment node
//
// Tests for lib/ai/settingsStore.ts — the only door into app_settings.
//
// The central property, and the one every test here is really about: SECRETS ARE
// WRITE-ONLY. `readSetting` reports `{ set, last4, unreadable }` and nothing that
// could hold a credential, so there is no code path by which /api/admin/ai can put
// a key in a response body. The plaintext exists in exactly one function,
// `openSettingSecret`, whose name says what it does.
//
// The second property: a missing or unreachable store is NOT an error. Every read
// resolves to null instead of throwing, because the router's contract is to fall
// back to viewpoint.config.ts and then to the built-in stack — an installation
// whose database is down must lose capture to a cloud key it never configured, not
// to a settings read that threw.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config/loadConfig.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/loadConfig.ts')>()),
  loadConfig: vi.fn(),
}));

import { loadConfig } from '../../config/loadConfig.ts';
import type { ViewpointConfig } from '../../config/schema.ts';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)
const OTHER_JWT_SECRET = 'a-completely-different-jwt-secret-value';
const SERVER_URL = 'http://rest:3000/';
const TOKEN = 'service-role-token-FAKE';
const PLAINTEXT = 'sk-proj-1234567890abcdef7f2a';
const KEY = 'ai.cards';

function configWith(overrides: Partial<ViewpointConfig['db']> = {}): ViewpointConfig {
  return {
    plm: { provider: 'none' },
    capture: { provider: 'mock' },
    turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
    db: { provider: 'supabase', urlEnv: 'VITE_SUPABASE_URL', anonKeyEnv: 'K', ...overrides },
    notifications: [],
    modelImport: { provider: 'genericGltf' },
  } as ViewpointConfig;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A PostgREST double.
 *
 * `rows` is what a GET answers with; `reply` overrides everything, for the
 * failure paths. Every call is recorded so a test can assert on the URL, the
 * headers and the body — which is where a leaked credential would show up.
 */
function stubRest(options: {
  rows?: unknown[];
  status?: number;
  contentType?: string;
  /** `null` for a bodyless reply, which is what a 204 must be. */
  body?: string | null;
} = {}) {
  const calls: RecordedCall[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const status = options.status ?? 200;
    const contentType = options.contentType ?? 'application/json';
    const body =
      options.body === null
        ? null
        : (options.body ?? JSON.stringify(options.rows ?? []));
    // A 204 is constructed with a null body: `new Response('', { status: 204 })`
    // throws, which is the spec's way of saying a bodyless status has no body.
    return new Response(body, {
      status,
      headers: body === null ? undefined : { 'content-type': contentType },
    });
  });
  return { calls, fetchFn: fetchFn as unknown as typeof globalThis.fetch };
}

const STORE = { serverUrl: SERVER_URL, token: TOKEN };

describe('settingsStore', () => {
  const originalEnv = process.env;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, JWT_SECRET };
    vi.mocked(loadConfig).mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.env = originalEnv;
  });

  async function store() {
    return import('../settingsStore.ts');
  }

  async function box() {
    return import('../secretBox.ts');
  }

  // ─── The write-only rule ──────────────────────────────────────────────────

  it('readSetting never returns the secret value, in any spelling', async () => {
    const { encryptSecret } = await box();
    const ciphertext = encryptSecret(PLAINTEXT);
    const rest = stubRest({
      rows: [
        {
          key: KEY,
          value: { provider: 'openai', fields: { model: 'gpt-4o-mini' } },
          secret: ciphertext,
          updated_at: '2026-09-24T10:00:00.000Z',
          updated_by: 'admin-1',
        },
      ],
    });

    const { readSetting } = await store();
    const setting = await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn });

    expect(setting).not.toBeNull();
    expect(setting!.secret).toEqual({ set: true, last4: '7f2a', unreadable: false });
    expect(setting!.value).toEqual({ provider: 'openai', fields: { model: 'gpt-4o-mini' } });
    expect(setting!.updatedBy).toBe('admin-1');

    // The whole point: serialising what the admin endpoint is allowed to send to
    // a browser carries neither the plaintext nor the ciphertext.
    const serialised = JSON.stringify(setting);
    expect(serialised).not.toContain(PLAINTEXT);
    expect(serialised).not.toContain(ciphertext);
    expect(serialised).not.toContain('sk-proj');
  });

  it('has no field on the returned setting that could hold a credential', async () => {
    const { encryptSecret } = await box();
    const rest = stubRest({
      rows: [{ key: KEY, value: {}, secret: encryptSecret(PLAINTEXT) }],
    });
    const { readSetting } = await store();
    const setting = await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn });
    expect(Object.keys(setting!.secret).sort()).toEqual(['last4', 'set', 'unreadable']);
  });

  it('openSettingSecret is the only function that returns the plaintext', async () => {
    const { encryptSecret } = await box();
    const rest = stubRest({
      rows: [{ key: KEY, value: { provider: 'openai', fields: {} }, secret: encryptSecret(PLAINTEXT) }],
    });
    const { openSettingSecret } = await store();
    expect(await openSettingSecret(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBe(PLAINTEXT);
  });

  it('reports a secret it cannot open as unreadable, and does not throw', async () => {
    // Sealed under a different JWT_SECRET: the rotation case. The screen has to
    // be able to say "stored, but re-enter it" instead of crashing or showing a
    // tail it cannot compute.
    const { encryptSecret } = await box();
    const rest = stubRest({
      rows: [{ key: KEY, value: {}, secret: encryptSecret(PLAINTEXT, OTHER_JWT_SECRET) }],
    });
    const { readSetting, openSettingSecret } = await store();

    const setting = await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn });
    expect(setting!.secret).toEqual({ set: true, last4: '', unreadable: true });
    expect(JSON.stringify(setting)).not.toContain(PLAINTEXT);
    // The router asks for the plaintext and gets null, which makes it fall back
    // rather than send an empty Authorization header.
    expect(await openSettingSecret(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBeNull();
  });

  it('reports no secret at all as { set: false }', async () => {
    const rest = stubRest({ rows: [{ key: KEY, value: { provider: 'builtin', fields: {} }, secret: null }] });
    const { readSetting } = await store();
    const setting = await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn });
    expect(setting!.secret).toEqual({ set: false, last4: '', unreadable: false });
  });

  it('never logs the secret or the ciphertext', async () => {
    const { encryptSecret } = await box();
    const ciphertext = encryptSecret(PLAINTEXT);
    const rest = stubRest({ rows: [{ key: KEY, value: {}, secret: ciphertext }] });
    const { readSetting, openSettingSecret } = await store();
    await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn });
    await openSettingSecret(KEY, { ...STORE, fetchFn: rest.fetchFn });

    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(PLAINTEXT);
    expect(logged).not.toContain(ciphertext);
  });

  // ─── The PostgREST request ────────────────────────────────────────────────

  it('reads the row with a service-role token and asks only for the columns it needs', async () => {
    const rest = stubRest({ rows: [] });
    const { readSetting } = await store();
    await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn });

    expect(rest.calls).toHaveLength(1);
    const call = rest.calls[0];
    expect(call.method).toBe('GET');
    expect(call.url).toBe(
      `${SERVER_URL}app_settings?key=eq.ai.cards&select=key,value,secret,updated_at,updated_by`,
    );
    expect(call.headers.apikey).toBe(TOKEN);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.accept).toBe('application/json');
  });

  it('encodes the key in the filter, so a key with a reserved character cannot break out', async () => {
    const rest = stubRest({ rows: [] });
    const { readSetting } = await store();
    await readSetting('ai/cards&select=*', { ...STORE, fetchFn: rest.fetchFn });
    expect(rest.calls[0].url).toContain('key=eq.ai%2Fcards%26select%3D*');
  });

  // ─── A missing store is not an error ──────────────────────────────────────

  it('resolves to null when there is no row', async () => {
    const rest = stubRest({ rows: [] });
    const { readSetting } = await store();
    expect(await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBeNull();
  });

  it.each([
    ['the store refuses', { status: 401, body: '{"message":"jwt expired"}' }],
    ['the store is unreachable', { status: 500, body: 'upstream failed' }],
    ['something else answers with HTML', { status: 200, contentType: 'text/html', body: '<html>login</html>' }],
    ['the body is not a row array', { status: 200, body: '{"key":"ai.cards"}' }],
  ])('resolves to null when %s, rather than throwing', async (_label, options) => {
    const rest = stubRest(options);
    const { readSetting, openSettingSecret } = await store();
    expect(await readSetting(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBeNull();
    expect(await openSettingSecret(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBeNull();
  });

  it('resolves to null when there is no service-role token to sign', async () => {
    delete process.env.JWT_SECRET;
    vi.resetModules();
    const rest = stubRest({ rows: [{ key: KEY, value: {} }] });
    const { readSetting } = await store();
    // No JWT_SECRET means no service-role JWT, which means no privileged database
    // access at all. That is a deployment fact, not a request failure.
    expect(await readSetting(KEY, { serverUrl: SERVER_URL, fetchFn: rest.fetchFn })).toBeNull();
    expect(rest.calls).toHaveLength(0);
  });

  it('resolves to null when fetch itself throws', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED http://rest:3000/');
    });
    const { readSetting } = await store();
    expect(
      await readSetting(KEY, {
        ...STORE,
        fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      }),
    ).toBeNull();
    // fetch's own message embeds the URL, which on a self-hosted install is an
    // internal container name. It is logged as a fixed sentence instead.
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('ECONNREFUSED');
  });

  // ─── Writing ──────────────────────────────────────────────────────────────

  it('upserts the row, sealing the secret before it leaves this process', async () => {
    const rest = stubRest({ status: 201, body: '' });
    const { writeSetting } = await store();
    const ok = await writeSetting(
      KEY,
      { value: { provider: 'openai', fields: { model: 'gpt-4o-mini' } }, secret: PLAINTEXT, updatedBy: 'admin-1' },
      { ...STORE, fetchFn: rest.fetchFn },
    );

    expect(ok).toBe(true);
    const call = rest.calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${SERVER_URL}app_settings`);
    // merge-duplicates turns the POST into an upsert on the primary key, so a
    // second save of the same job updates the row instead of failing on it.
    expect(call.headers.prefer).toBe('resolution=merge-duplicates,return=minimal');

    const sent = JSON.parse(call.body) as Record<string, unknown>;
    expect(sent.key).toBe(KEY);
    expect(sent.value).toEqual({ provider: 'openai', fields: { model: 'gpt-4o-mini' } });
    expect(sent.updated_by).toBe('admin-1');
    // Sealed, not plaintext: the wire body is what lands in the database.
    expect(sent.secret).not.toBe(PLAINTEXT);
    expect(String(sent.secret).split(':')).toHaveLength(4);
    expect(call.body).not.toContain(PLAINTEXT);
  });

  it('keeps the stored ciphertext when the caller omits the secret', async () => {
    const { encryptSecret } = await box();
    const ciphertext = encryptSecret(PLAINTEXT);
    const rest = stubRest({ rows: [{ key: KEY, value: {}, secret: ciphertext }] });
    const { writeSetting } = await store();

    await writeSetting(
      KEY,
      { value: { provider: 'openai', fields: { model: 'whisper-1' } }, updatedBy: 'admin-1' },
      { ...STORE, fetchFn: rest.fetchFn },
    );

    // Two calls: a read of the existing ciphertext, then a write that carries it
    // back VERBATIM. Re-sending rather than omitting the column is deliberate —
    // it does not depend on how a given PostgREST version treats a column absent
    // from an ON CONFLICT payload.
    expect(rest.calls).toHaveLength(2);
    const sent = JSON.parse(rest.calls[1].body) as Record<string, unknown>;
    expect(sent.secret).toBe(ciphertext);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('clears the secret when the caller sends %s', async (_label, secret) => {
    const { encryptSecret } = await box();
    const rest = stubRest({ rows: [{ key: KEY, value: {}, secret: encryptSecret(PLAINTEXT) }] });
    const { writeSetting } = await store();

    await writeSetting(
      KEY,
      { value: { provider: 'builtin', fields: {} }, secret, updatedBy: 'admin-1' },
      { ...STORE, fetchFn: rest.fetchFn },
    );

    // One call, not two: clearing needs no read. And a form that always posts its
    // inputs cannot silently re-encrypt '' over a real key.
    expect(rest.calls).toHaveLength(1);
    expect((JSON.parse(rest.calls[0].body) as Record<string, unknown>).secret).toBeNull();
  });

  it('refuses to store a secret it cannot seal', async () => {
    delete process.env.JWT_SECRET;
    vi.resetModules();
    const rest = stubRest({ status: 201, body: '' });
    const { writeSetting } = await store();

    const ok = await writeSetting(
      KEY,
      { value: {}, secret: PLAINTEXT, updatedBy: 'admin-1' },
      { serverUrl: SERVER_URL, token: TOKEN, fetchFn: rest.fetchFn },
    );
    // A plaintext credential in a database that is backed up is worse than a save
    // that failed, so the write never happens.
    expect(ok).toBe(false);
    expect(rest.calls).toHaveLength(0);
  });

  it('reports a refused write as false, and does not read the body', async () => {
    // PostgREST echoes the row it refused, and that row carries the ciphertext.
    const rest = stubRest({ status: 409, body: JSON.stringify({ secret: 'x', error: 'conflict' }) });
    const { writeSetting } = await store();
    const ok = await writeSetting(KEY, { value: {}, updatedBy: 'admin-1' }, { ...STORE, fetchFn: rest.fetchFn });
    expect(ok).toBe(false);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('409');
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('conflict');
  });

  it('deletes a row asking for nothing back', async () => {
    const rest = stubRest({ status: 204, body: null });
    const { deleteSetting } = await store();
    expect(await deleteSetting(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBe(true);

    const call = rest.calls[0];
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe(`${SERVER_URL}app_settings?key=eq.ai.cards`);
    // The row being deleted carries the ciphertext; return=minimal is what stops
    // PostgREST echoing it into a response body.
    expect(call.headers.prefer).toBe('return=minimal');
  });

  it('reports an unreachable delete as false', async () => {
    const rest = stubRest({ status: 500, body: 'nope' });
    const { deleteSetting } = await store();
    expect(await deleteSetting(KEY, { ...STORE, fetchFn: rest.fetchFn })).toBe(false);
  });

  // ─── Reachability ─────────────────────────────────────────────────────────

  it('probes with one column of at most one row', async () => {
    const rest = stubRest({ rows: [{ key: 'ai.cards' }] });
    const { probeSettingsStore } = await store();
    expect(await probeSettingsStore({ ...STORE, fetchFn: rest.fetchFn })).toBe(true);
    expect(rest.calls[0].url).toBe(`${SERVER_URL}app_settings?select=key&limit=1`);
  });

  it('reports an unreachable store as false, not as an exception', async () => {
    const rest = stubRest({ status: 503, body: '' });
    const { probeSettingsStore } = await store();
    expect(await probeSettingsStore({ ...STORE, fetchFn: rest.fetchFn })).toBe(false);
  });

  // ─── Which PostgREST root ─────────────────────────────────────────────────

  it('prefers db.serverUrl, then db.probeUrl, then the public URL plus /rest/v1/', async () => {
    const { resolveSettingsServerUrl } = await store();

    vi.mocked(loadConfig).mockResolvedValue(
      configWith({ serverUrl: 'http://gateway:3001/', probeUrl: 'http://rest:3000/' }),
    );
    expect(await resolveSettingsServerUrl({ env: {} })).toBe('http://gateway:3001/');

    vi.mocked(loadConfig).mockResolvedValue(configWith({ probeUrl: 'http://rest:3000' }));
    expect(await resolveSettingsServerUrl({ env: {} })).toBe('http://rest:3000/');

    vi.mocked(loadConfig).mockResolvedValue(configWith());
    expect(
      await resolveSettingsServerUrl({ env: { VITE_SUPABASE_URL: 'https://proj.supabase.co' } }),
    ).toBe('https://proj.supabase.co/rest/v1/');
  });

  it('resolves to null when the config will not load or names no URL', async () => {
    const { resolveSettingsServerUrl } = await store();

    vi.mocked(loadConfig).mockRejectedValue(new Error('Invalid viewpoint config'));
    expect(await resolveSettingsServerUrl({ env: {} })).toBeNull();

    vi.mocked(loadConfig).mockResolvedValue(configWith());
    expect(await resolveSettingsServerUrl({ env: {} })).toBeNull();
  });
});
