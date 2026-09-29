// @vitest-environment node
//
// Tests for the first-admin claim endpoint (api/admin/claim.ts).
//
// The claim is allowed ONLY while zero admins exist, checked at request time.
// loadConfig reads VIEWPOINT_CONFIG from the environment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      ...claims,
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

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
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.body = data; return res; },
    setHeader(name: string, value: string) { res.headers[name] = value; return res; },
  };
  return res;
}

const ACCOUNTS_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
  identity: { mode: 'accounts', methods: ['password'], allowGuests: false, adminUrl: 'http://auth:9999' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

const NONE_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

const ENV_VARS = { T: 'x', U: 'x', K: 'x' };

describe('POST /api/admin/claim', () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, JWT_SECRET, ...ENV_VARS };
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it('claims admin when zero admins exist', async () => {
    const token = makeJwt({
      sub: 'first-user',
      email: 'first@example.com',
      app_metadata: { role: 'authenticated' },
      user_metadata: { full_name: 'First User' },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ users: [] }),
    });
    fetchMock.mockResolvedValueOnce({ ok: true });

    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    const req = {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: undefined,
      query: {},
    } as never;

    await handler(req, res as never);

    expect(res.statusCode).toBe(200);
    expect((res.body as { claimed: boolean }).claimed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns 409 when admins already exist', async () => {
    const token = makeJwt({
      sub: 'late-user',
      email: 'late@example.com',
      app_metadata: { role: 'authenticated' },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        users: [{ id: 'existing-admin', app_metadata: { role: 'admin' } }],
      }),
    });

    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    const req = {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: undefined,
      query: {},
    } as never;

    await handler(req, res as never);

    expect(res.statusCode).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 401 with no token', async () => {
    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    const req = {
      method: 'POST',
      headers: {},
      body: undefined,
      query: {},
    } as never;

    await handler(req, res as never);

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with an invalid token', async () => {
    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-jwt' },
      body: undefined,
      query: {},
    } as never;

    await handler(req, res as never);

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 in mode none', async () => {
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;

    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer whatever' },
      body: undefined,
      query: {},
    } as never;

    await handler(req, res as never);

    expect(res.statusCode).toBe(404);
  });

  it('GET reports whether an admin exists, and promotes nobody', async () => {
    const token = makeJwt({ sub: 'someone', email: 's@example.com', app_metadata: {} });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ users: [{ id: 'a', app_metadata: { role: 'admin' } }] }),
    });
    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${token}` }, body: undefined, query: {} } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ adminsExist: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // the list only, no PUT
  });

  it('returns 405 for methods other than GET and POST', async () => {
    const { handler } = await import('../claim.ts');
    const res = createMockRes();
    const req = {
      method: 'DELETE',
      headers: {},
      body: undefined,
      query: {},
    } as never;

    await handler(req, res as never);

    expect(res.statusCode).toBe(405);
  });
});
