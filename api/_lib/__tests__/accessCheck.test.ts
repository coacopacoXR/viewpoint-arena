// Handler tests for /api/access-check — the yes/no nginx asks before letting
// a request reach the capture endpoints.
//
// Status codes are the entire contract: auth_request ignores the body.

import type { VercelResponse } from '@vercel/node';
import { describe, it, expect, afterEach } from 'vitest';
import { hashPassword, signToken } from '../accessControl.ts';

const STORED_HASH = hashPassword('right-password');

interface FakeRes {
  statusCode: number;
  ended: boolean;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  end(): FakeRes;
  setHeader(name: string, value: string): FakeRes;
}

function makeRes(): FakeRes {
  const r: FakeRes = {
    statusCode: 200,
    ended: false,
    body: null,
    headers: {},
    status(code: number) { r.statusCode = code; return r; },
    json(body: unknown) { r.body = body; return r; },
    end() { r.ended = true; return r; },
    setHeader(name: string, value: string) { r.headers[name] = value; return r; },
  };
  return r;
}

function makeReq(overrides: { method?: string; cookies?: Record<string, string> } = {}) {
  return {
    method: overrides.method ?? 'GET',
    headers: {},
    cookies: overrides.cookies ?? {},
  } as never;
}

async function run(req: never, res: FakeRes) {
  const { default: handler } = await import('../../access-check.ts');
  await handler(req, res as unknown as VercelResponse);
}

describe('GET /api/access-check', () => {
  afterEach(() => {
    delete process.env.ACCESS_PASSWORD_HASH;
  });

  it('lets everything through when no password is configured', async () => {
    process.env.ACCESS_PASSWORD_HASH = '';
    const res = makeRes();
    await run(makeReq(), res);
    expect(res.statusCode).toBe(204);
  });

  it('refuses a caller with no cookie when a password is configured', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    await run(makeReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a forged cookie', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    await run(makeReq({ cookies: { vp_access: 'deadbeef' } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('refuses a cookie minted for the admin gate', async () => {
    // Same mechanism, different label — an admin token must not buy access
    // to the capture endpoints.
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    await run(makeReq({ cookies: { vp_access: signToken(STORED_HASH, 'vp_admin') } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('lets a valid cookie through', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const res = makeRes();
    await run(makeReq({ cookies: { vp_access: signToken(STORED_HASH, 'vp_access') } }), res);
    expect(res.statusCode).toBe(204);
  });

  it('refuses a cookie signed with a different password', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const other = hashPassword('some-other-password');
    const res = makeRes();
    await run(makeReq({ cookies: { vp_access: signToken(other, 'vp_access') } }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects anything but GET/HEAD', async () => {
    process.env.ACCESS_PASSWORD_HASH = '';
    const res = makeRes();
    await run(makeReq({ method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
  });
});
