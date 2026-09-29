// Tests for the access-control helpers: hashing, cookie signing, rate limiting.
//
// The hashing test shells out to the same openssl command install.sh uses, so
// a mismatch between the installer and the server is caught here before it
// reaches a live deploy.

import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  hashPassword,
  parseStoredHash,
  verifyPassword,
  signToken,
  verifyToken,
  recordAttempt,
  isAllowed,
  _resetRateLimit,
  buildCookieString,
  clearCookieString,
} from '../accessControl.ts';

describe('hashPassword / verifyPassword', () => {
  it('produces a <salt>:<hash> string with 16-char hex salt and 64-char hex hash', () => {
    const stored = hashPassword('hello');
    const parts = stored.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the correct password and rejects a wrong one', () => {
    const stored = hashPassword('correct');
    expect(verifyPassword('correct', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('produces different salts for the same password', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    // But both verify.
    expect(verifyPassword('same', a)).toBe(true);
    expect(verifyPassword('same', b)).toBe(true);
  });

  it('returns false for empty or malformed stored values', () => {
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'nosalt')).toBe(false);
    expect(verifyPassword('anything', ':')).toBe(false);
  });

  it('matches the openssl command install.sh uses', () => {
    // This is the exact algorithm: salt = openssl rand -hex 8,
    // hash = printf '%s' "${salt}${password}" | openssl dgst -sha256 -r | cut -d' ' -f1
    const password = 'test-password-123';
    const salt = execFileSync('openssl', ['rand', '-hex', '8'], { encoding: 'utf8' }).trim();
    const hash = execFileSync('bash', ['-c', `printf '%s' '${salt}${password}' | openssl dgst -sha256 -r | cut -d' ' -f1`], { encoding: 'utf8' }).trim();
    const stored = `${salt}:${hash}`;

    // The Node implementation must verify a hash produced by the shell command.
    expect(verifyPassword(password, stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);

    // And the Node hashPassword must produce something the shell can verify.
    const nodeStored = hashPassword(password);
    const [nodeSalt, nodeHash] = nodeStored.split(':');
    const shellHash = execFileSync('bash', ['-c', `printf '%s' '${nodeSalt}${password}' | openssl dgst -sha256 -r | cut -d' ' -f1`], { encoding: 'utf8' }).trim();
    expect(nodeHash).toBe(shellHash);
  });
});

describe('parseStoredHash', () => {
  it('returns null for empty, undefined, or malformed input', () => {
    expect(parseStoredHash(undefined)).toBeNull();
    expect(parseStoredHash('')).toBeNull();
    expect(parseStoredHash('nosalt')).toBeNull();
    expect(parseStoredHash(':')).toBeNull();
    expect(parseStoredHash('$hash')).toBeNull();
    expect(parseStoredHash('salt$')).toBeNull();
  });

  it('parses a valid stored hash', () => {
    const result = parseStoredHash('abcdef0123456789$' + 'a'.repeat(64));
    expect(result).toEqual({ salt: 'abcdef0123456789', hash: 'a'.repeat(64) });
  });
});

describe('signToken / verifyToken', () => {
  it('signs and verifies a token for a given label', () => {
    const stored = hashPassword('pw');
    const token = signToken(stored, 'vp_access');
    expect(verifyToken(token, stored, 'vp_access')).toBe(true);
  });

  it('rejects a token with the wrong label', () => {
    const stored = hashPassword('pw');
    const token = signToken(stored, 'vp_access');
    expect(verifyToken(token, stored, 'vp_admin')).toBe(false);
  });

  it('rejects a token with the wrong hash', () => {
    const stored1 = hashPassword('pw1');
    const stored2 = hashPassword('pw2');
    const token = signToken(stored1, 'vp_access');
    expect(verifyToken(token, stored2, 'vp_access')).toBe(false);
  });
});

describe('rate limiting', () => {
  beforeEach(() => {
    _resetRateLimit();
  });

  it('allows up to 10 attempts and blocks the 11th', () => {
    const ip = '1.2.3.4';
    for (let i = 0; i < 10; i++) {
      expect(isAllowed(ip)).toBe(true);
      recordAttempt(ip);
    }
    // After 10 recorded attempts, the 11th check should fail.
    expect(isAllowed(ip)).toBe(false);
  });

  it('tracks IPs independently', () => {
    for (let i = 0; i < 10; i++) recordAttempt('1.1.1.1');
    expect(isAllowed('1.1.1.1')).toBe(false);
    expect(isAllowed('2.2.2.2')).toBe(true);
  });
});

describe('cookie helpers', () => {
  it('buildCookieString includes HttpOnly, SameSite=Lax, Secure', () => {
    const cookie = buildCookieString('vp_access', 'token123', 86400);
    expect(cookie).toContain('vp_access=token123');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=86400');
    expect(cookie).toContain('Path=/');
  });

  it('clearCookieString sets Max-Age=0', () => {
    const cookie = clearCookieString('vp_access');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('vp_access=');
  });
});
