// @vitest-environment node
//
// Tests for the admin authentication helper (api/_lib/adminAuth.ts).
//
// Covers both modes:
//   - identity.mode 'none': passphrase cookie check
//   - identity.mode 'accounts' | 'sso': Bearer token with admin role
//
// loadConfig reads VIEWPOINT_CONFIG from the environment when set, so we
// inject the config as JSON rather than mocking the module.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashPassword, signToken } from '../accessControl.ts';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeJwt(claims: Record<string, unknown>, secret: string = JWT_SECRET): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub: 'user-123',
      email: 'test@example.com',
      ...claims,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  status(code: number): MockRes;
  json(data: unknown): MockRes;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.body = data; return res; },
  };
  return res;
}

interface MockReq {
  headers: Record<string, string>;
  cookies?: Record<string, string>;
}

// Minimal valid configs for loadConfig's validator.
const NONE_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

const ACCOUNTS_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
  identity: { mode: 'accounts', methods: ['password'], allowGuests: false },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

describe('requireAdmin — none mode (passphrase)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: NONE_CONFIG, T: 'x', U: 'x', K: 'x' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes with a valid passphrase cookie', async () => {
    const stored = hashPassword('admin-pw');
    process.env.ADMIN_PASSPHRASE_HASH = stored;
    const token = signToken(stored, 'vp_admin');

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: {}, cookies: { vp_admin: token } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toEqual({ sub: 'passphrase', name: 'Admin' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 with no cookie', async () => {
    const stored = hashPassword('admin-pw');
    process.env.ADMIN_PASSPHRASE_HASH = stored;

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: {}, cookies: {} } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with an invalid cookie', async () => {
    const stored = hashPassword('admin-pw');
    process.env.ADMIN_PASSPHRASE_HASH = stored;

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: {}, cookies: { vp_admin: 'wrong-token' } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when passphrase is not configured', async () => {
    delete process.env.ADMIN_PASSPHRASE_HASH;

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: {}, cookies: {} } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });
});

describe('requireAdmin — accounts/sso mode (Bearer token)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, JWT_SECRET, T: 'x', U: 'x', K: 'x' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes with a valid admin token', async () => {
    const token = makeJwt({
      sub: 'admin-123',
      email: 'admin@example.com',
      app_metadata: { role: 'admin' },
      user_metadata: { full_name: 'Admin User' },
    });

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).not.toBeNull();
    expect(result?.sub).toBe('admin-123');
    expect(result?.name).toBe('Admin User');
  });

  it('returns 401 with no Authorization header', async () => {
    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: {} } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with an invalid token', async () => {
    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: { authorization: 'Bearer not-a-jwt' } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with an expired token', async () => {
    const token = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 100,
      app_metadata: { role: 'admin' },
    });

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with a token signed with a different secret', async () => {
    const token = makeJwt(
      { app_metadata: { role: 'admin' } },
      'somebody-elses-secret-long-enough',
    );

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with a valid non-admin token', async () => {
    const token = makeJwt({
      sub: 'user-456',
      app_metadata: { role: 'authenticated' },
    });

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(403);
  });

  it('returns 500 when JWT_SECRET is not set', async () => {
    delete process.env.JWT_SECRET;

    const { requireAdmin } = await import('../adminAuth.ts');
    const req = { headers: { authorization: 'Bearer some-token' } } as unknown as MockReq;
    const res = createMockRes();

    const result = await requireAdmin(req as never, res as never);
    expect(result).toBeNull();
    expect(res.statusCode).toBe(500);
  });
});
