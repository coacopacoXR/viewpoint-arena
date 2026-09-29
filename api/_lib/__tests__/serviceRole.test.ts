// @vitest-environment node
//
// Tests for the service-role JWT minting (api/_lib/serviceRole.ts).
//
// Node, not jsdom: the module uses node:crypto for HMAC signing and has a
// runtime guard that throws in non-Node environments.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)

function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [headerSeg, claimsSeg] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(headerSeg, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(claimsSeg, 'base64url').toString('utf8')),
  };
}

describe('serviceRole', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, JWT_SECRET: SECRET };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('mints a token with the correct claims', async () => {
    const { getServiceRoleToken } = await import('../serviceRole.ts');
    const token = getServiceRoleToken();

    expect(token).not.toBeNull();
    const { header, claims } = decodeJwt(token!);
    expect(header.alg).toBe('HS256');
    expect(claims.role).toBe('service_role');
    expect(claims.iss).toBe('supabase');
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
    expect(claims.exp).toBeGreaterThan(claims.iat as number);
  });

  it('signs with JWT_SECRET', async () => {
    const { getServiceRoleToken } = await import('../serviceRole.ts');
    const token = getServiceRoleToken();

    const [headerSeg, claimsSeg, sigSeg] = token!.split('.');
    const expected = createHmac('sha256', SECRET)
      .update(`${headerSeg}.${claimsSeg}`)
      .digest('base64url');
    expect(sigSeg).toBe(expected);
  });

  it('returns null when JWT_SECRET is not set', async () => {
    delete process.env.JWT_SECRET;
    vi.resetModules();
    const { getServiceRoleToken } = await import('../serviceRole.ts');
    expect(getServiceRoleToken()).toBeNull();
  });

  it('caches the token across calls', async () => {
    const { getServiceRoleToken } = await import('../serviceRole.ts');
    const a = getServiceRoleToken();
    const b = getServiceRoleToken();
    expect(a).toBe(b);
  });

  it('exports the server-only marker', async () => {
    const { _SERVICE_ROLE_MARKER } = await import('../serviceRole.ts');
    expect(_SERVICE_ROLE_MARKER).toBe('__SERVICE_ROLE_SERVER_ONLY__');
  });
});
