// Handler-level tests for /api/access.
//
// Drives the handler with fake req/res objects the same way the vercelShim
// would, asserting the JSON body, status code, Set-Cookie header, and rate
// limiting behaviour.

import type { VercelResponse } from '@vercel/node';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  hashPassword,
  signToken,
  _resetRateLimit,
} from '../accessControl.ts';

// The handler reads process.env, so we set/clear it around each test.
const STORED_HASH = hashPassword('right-password');

interface FakeRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  setHeader(name: string, value: string): FakeRes;
  getHeader(name: string): string | undefined;
}

/** The handlers take a VercelResponse; only these four methods are used,
 *  so the fake implements those and is cast at the call sites. */
function makeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: unknown) { r.body = body; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
    getHeader(name: string) { return r.headers[name]; },
  };
  return r;
}

function makeReq(overrides: {
  method?: string;
  body?: unknown;
  cookies?: Record<string, string>;
  ip?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (overrides.cookies) {
    headers.cookie = Object.entries(overrides.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  if (overrides.ip) {
    headers['x-forwarded-for'] = overrides.ip;
  }
  return {
    method: overrides.method ?? 'GET',
    headers,
    body: overrides.body,
    socket: { remoteAddress: overrides.ip ?? '127.0.0.1' },
    cookies: overrides.cookies ?? {},
  } as never;
}

describe('GET /api/access', () => {
  beforeEach(() => {
    _resetRateLimit();
  });

  afterEach(() => {
    delete process.env.ACCESS_PASSWORD_HASH;
  });

  it('reports required=false when the hash is empty', async () => {
    process.env.ACCESS_PASSWORD_HASH = '';
    const res = makeRes();
    const { default: handler } = await import('../../access.ts');
    await handler(makeReq(), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ required: false, unlocked: true });
  });

  it('reports required=true and unlocked=false without a cookie', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    const { default: handler } = await import('../../access.ts');
    await handler(makeReq(), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ required: true, unlocked: false });
  });

  it('reports unlocked=true when the cookie token is valid', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const token = signToken(STORED_HASH, 'vp_access');
    const res = makeRes();
    const { default: handler } = await import('../../access.ts');
    await handler(makeReq({ cookies: { vp_access: token } }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ required: true, unlocked: true });
  });
});

describe('POST /api/access', () => {
  beforeEach(() => {
    _resetRateLimit();
  });

  afterEach(() => {
    delete process.env.ACCESS_PASSWORD_HASH;
  });

  it('returns 200 and sets the cookie on correct password', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    const { default: handler } = await import('../../access.ts');
    await handler(makeReq({ method: 'POST', body: { password: 'right-password' } }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ unlocked: true });
    expect(res.headers['Set-Cookie']).toBeDefined();
    expect(res.headers['Set-Cookie']).toContain('vp_access=');
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
    expect(res.headers['Set-Cookie']).toContain('SameSite=Lax');
    expect(res.headers['Set-Cookie']).toContain('Secure');
  });

  it('returns 401 and no cookie on wrong password', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    const { default: handler } = await import('../../access.ts');
    await handler(makeReq({ method: 'POST', body: { password: 'wrong' } }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'wrong_password' });
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('returns 429 after 10 failed attempts from the same IP', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const { default: handler } = await import('../../access.ts');

    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      await handler(makeReq({ method: 'POST', body: { password: 'wrong' }, ip: '10.0.0.1' }), res as unknown as VercelResponse);
      expect(res.statusCode).toBe(401);
    }

    // 11th attempt from same IP.
    const res = makeRes();
    await handler(makeReq({ method: 'POST', body: { password: 'wrong' }, ip: '10.0.0.1' }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'too_many_attempts' });
  });

  it('returns 200 immediately when no password is configured', async () => {
    process.env.ACCESS_PASSWORD_HASH = '';
    const res = makeRes();
    const { default: handler } = await import('../../access.ts');
    await handler(makeReq({ method: 'POST', body: { password: 'anything' } }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ unlocked: true });
  });
});
