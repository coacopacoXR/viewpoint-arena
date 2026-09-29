// @vitest-environment node
//
// Tests for the People admin endpoints (api/admin/users.ts).
//
// GoTrue is mocked through global fetch. loadConfig reads VIEWPOINT_CONFIG
// from the environment, so we inject the config as JSON.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashPassword, signToken } from '../../_lib/accessControl.ts';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeAdminJwt(sub: string, role: string = 'admin'): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub,
      email: 'admin@example.com',
      app_metadata: { role },
      user_metadata: { full_name: 'Admin User' },
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

const ADMIN_TOKEN = makeAdminJwt('admin-1');

function adminReq(overrides: {
  method?: string;
  token?: string;
  body?: unknown;
  query?: Record<string, string>;
} = {}) {
  return {
    method: overrides.method ?? 'GET',
    headers: { authorization: `Bearer ${overrides.token ?? ADMIN_TOKEN}` },
    body: overrides.body ?? undefined,
    query: overrides.query ?? {},
    cookies: {},
  } as never;
}

const GOTRUE_USERS = [
  {
    id: 'admin-1',
    email: 'admin@example.com',
    user_metadata: { full_name: 'Admin User' },
    app_metadata: { role: 'admin' },
    created_at: '2026-01-01T00:00:00Z',
    last_sign_in_at: '2026-09-24T00:00:00Z',
  },
  {
    id: 'member-1',
    email: 'member@example.com',
    user_metadata: { full_name: 'Member User' },
    app_metadata: { role: 'authenticated' },
    created_at: '2026-06-01T00:00:00Z',
    last_sign_in_at: null,
  },
];

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

describe('GET /api/admin/users', () => {
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

  it('lists users from GoTrue', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ users: GOTRUE_USERS }),
    });

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq(), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as { users: unknown[] };
    expect(body.users).toHaveLength(2);
  });

  it('returns 404 in mode none', async () => {
    const stored = hashPassword('admin-pw');
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;
    process.env.ADMIN_PASSPHRASE_HASH = stored;
    const cookie = signToken(stored, 'vp_admin');
    vi.resetModules();

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    const req = {
      method: 'GET',
      headers: {},
      body: undefined,
      query: {},
      cookies: { vp_admin: cookie },
    } as never;
    await handler(req, res as never);

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/admin/users', () => {
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

  it('creates a user via GoTrue', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'new-user',
        email: 'new@example.com',
        user_metadata: { full_name: 'New User' },
        app_metadata: {},
        created_at: '2026-09-24T00:00:00Z',
      }),
    });

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'POST',
      body: { email: 'new@example.com', password: 'temp-pw', name: 'New User' },
    }), res as never);

    expect(res.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/admin/users');
    expect(opts.method).toBe('POST');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.email).toBe('new@example.com');
    expect(sentBody.email_confirm).toBe(true);
  });

  it('returns 400 when email or password is missing', async () => {
    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({ method: 'POST', body: { email: '' } }), res as never);

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/users — guards', () => {
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

  it('prevents an admin from demoting themselves', async () => {
    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      token: ADMIN_TOKEN,
      query: { id: 'admin-1' },
      body: { admin: false },
    }), res as never);

    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents an admin from disabling themselves', async () => {
    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      token: ADMIN_TOKEN,
      query: { id: 'admin-1' },
      body: { disabled: true },
    }), res as never);

    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents demoting the last admin', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ users: [GOTRUE_USERS[0]] }),
    });

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      query: { id: 'admin-1' },
      body: { admin: false },
    }), res as never);

    expect(res.statusCode).toBe(409);
  });

  it('updates a member successfully', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        ...GOTRUE_USERS[1],
        user_metadata: { full_name: 'Updated Name' },
      }),
    });

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      query: { id: 'member-1' },
      body: { name: 'Updated Name' },
    }), res as never);

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/admin/users — guards', () => {
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

  it('prevents an admin from deleting themselves', async () => {
    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      token: ADMIN_TOKEN,
      query: { id: 'admin-1' },
    }), res as never);

    expect(res.statusCode).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents deleting the last admin', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(GOTRUE_USERS[0]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ users: [GOTRUE_USERS[0]] }),
      });

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    const otherAdminToken = makeAdminJwt('admin-2');
    await handler(adminReq({
      method: 'DELETE',
      token: otherAdminToken,
      query: { id: 'admin-1' },
    }), res as never);

    expect(res.statusCode).toBe(409);
  });

  it('deletes a non-admin member', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(GOTRUE_USERS[1]),
      })
      .mockResolvedValueOnce({ ok: true });

    const { handler } = await import('../users.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { id: 'member-1' },
    }), res as never);

    expect(res.statusCode).toBe(200);
  });
});
