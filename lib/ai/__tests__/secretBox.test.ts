// @vitest-environment node
//
// Tests for lib/ai/secretBox.ts — the at-rest encryption of the credentials an
// administrator pastes into the AI section.
//
// Node, not jsdom: the module derives a key with node:crypto and has a runtime
// guard that throws in a non-Node environment.
//
// The property that matters most here is FAIL CLOSED. A box that returns garbage
// for a wrong key, or that quietly accepts a flipped byte, is worse than no box:
// it looks like working encryption right up to the moment a database backup is
// restored under a different JWT_SECRET, or a row is edited by hand.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)
const OTHER_SECRET = 'a-completely-different-jwt-secret-value';
const PLAINTEXT = 'sk-proj-1234567890abcdef7f2a';

describe('secretBox', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, JWT_SECRET: SECRET };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function box() {
    return import('../secretBox.ts');
  }

  // ─── Round trip ───────────────────────────────────────────────────────────

  it('round-trips a secret through the stored form', async () => {
    const { encryptSecret, decryptSecret } = await box();
    const stored = encryptSecret(PLAINTEXT);
    expect(decryptSecret(stored)).toBe(PLAINTEXT);
  });

  it('stores the versioned four-part base64url form', async () => {
    const { encryptSecret, isSealedSecret, SECRET_BOX_VERSION } = await box();
    const stored = encryptSecret(PLAINTEXT);

    const parts = stored.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(SECRET_BOX_VERSION);
    expect(isSealedSecret(stored)).toBe(true);

    // base64url and nothing else: no padding, no +, no /. A stored value has to
    // survive a text column, a JSON body from PostgREST and a log line.
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('never puts the plaintext in the stored form', async () => {
    const { encryptSecret } = await box();
    const stored = encryptSecret(PLAINTEXT);
    expect(stored).not.toContain(PLAINTEXT);
    // …nor in any base64 spelling of it, which is the mistake a home-grown
    // "encryption" scheme makes.
    expect(stored).not.toContain(Buffer.from(PLAINTEXT, 'utf8').toString('base64url'));
  });

  it('uses a fresh IV per call, so two rows holding the same key differ', async () => {
    const { encryptSecret } = await box();
    const a = encryptSecret(PLAINTEXT);
    const b = encryptSecret(PLAINTEXT);
    expect(a).not.toBe(b);
    // Same plaintext, different ciphertext — and both still open.
    const { decryptSecret } = await box();
    expect(decryptSecret(a)).toBe(PLAINTEXT);
    expect(decryptSecret(b)).toBe(PLAINTEXT);
  });

  it('round-trips an empty string and a secret with unicode and colons', async () => {
    const { encryptSecret, decryptSecret } = await box();
    for (const value of ['', 'a', 'pässwörd-ünïcøde', 'has:colons:in:it', 'x'.repeat(4096)]) {
      expect(decryptSecret(encryptSecret(value))).toBe(value);
    }
  });

  // ─── Fail closed ──────────────────────────────────────────────────────────

  it('refuses to open a secret sealed under a different key', async () => {
    const { encryptSecret, decryptSecret, SecretBoxError } = await box();
    const stored = encryptSecret(PLAINTEXT, OTHER_SECRET);

    // This is the JWT_SECRET-rotation case: a database restored from a backup
    // taken under another secret must report the failure, not return noise.
    expect(() => decryptSecret(stored, SECRET)).toThrow(SecretBoxError);
    try {
      decryptSecret(stored, SECRET);
      expect.unreachable('decryption with the wrong secret must throw');
    } catch (err) {
      expect((err as InstanceType<typeof SecretBoxError>).reason).toBe('unsealed');
    }
  });

  it.each([
    ['the ciphertext', 3],
    ['the tag', 2],
    ['the IV', 1],
  ])('refuses to open a tampered %s', async (_label, partIndex) => {
    const { encryptSecret, decryptSecret, SecretBoxError } = await box();
    const parts = encryptSecret(PLAINTEXT).split(':');

    // Flip one character of one part. GCM is authenticated encryption, so there
    // is no "decrypt it and then notice it looks wrong" — a modified row cannot
    // produce a plaintext at all.
    const original = parts[partIndex];
    const first = original.charAt(0);
    parts[partIndex] = (first === 'A' ? 'B' : 'A') + original.slice(1);
    expect(parts[partIndex]).not.toBe(original);

    expect(() => decryptSecret(parts.join(':'))).toThrow(SecretBoxError);
  });

  it('refuses a stored value that is not the four-part form', async () => {
    const { decryptSecret, SecretBoxError } = await box();
    for (const malformed of [
      '',
      PLAINTEXT,
      'v1:onlythreeparts:here',
      'v2:aaaa:bbbb:cccc',
      'v1:a:b:c:d',
      '{"value":"v1:a:b:c"}',
    ]) {
      try {
        decryptSecret(malformed);
        expect.unreachable(`${JSON.stringify(malformed)} must not open`);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretBoxError);
        expect((err as InstanceType<typeof SecretBoxError>).reason).toBe('malformed');
      }
    }
  });

  it('refuses a truncated IV or tag rather than padding it out', async () => {
    const { encryptSecret, decryptSecret, SecretBoxError } = await box();
    const parts = encryptSecret(PLAINTEXT).split(':');
    const shortIv = ['v1', Buffer.from('only-four').toString('base64url'), parts[2], parts[3]];
    expect(() => decryptSecret(shortIv.join(':'))).toThrow(SecretBoxError);
  });

  it('refuses to seal or open with no JWT_SECRET at all', async () => {
    delete process.env.JWT_SECRET;
    vi.resetModules();
    const { encryptSecret, decryptSecret, SecretBoxError } = await box();

    // Deriving from an empty string would produce the SAME key on every
    // unconfigured install — i.e. a public key that looks like encryption.
    for (const attempt of [
      () => encryptSecret(PLAINTEXT),
      () => decryptSecret('v1:aaaa:bbbb:cccc'),
    ]) {
      try {
        attempt();
        expect.unreachable('no JWT_SECRET must refuse');
      } catch (err) {
        expect(err).toBeInstanceOf(SecretBoxError);
        expect((err as InstanceType<typeof SecretBoxError>).reason).toBe('no_secret_configured');
      }
    }
  });

  it('refuses a whitespace-only JWT_SECRET', async () => {
    process.env.JWT_SECRET = '   ';
    vi.resetModules();
    const { encryptSecret, SecretBoxError } = await box();
    expect(() => encryptSecret(PLAINTEXT)).toThrow(SecretBoxError);
  });

  it('never quotes its input in a failure message', async () => {
    const { decryptSecret } = await box();
    // The input to decryptSecret is ciphertext from a database row, and the input
    // to encryptSecret is a live key. A message carrying either would end up in a
    // server log, which is the one place this module exists to keep them out of.
    const tainted = `v1:${Buffer.from(PLAINTEXT).toString('base64url')}:bbbb:cccc`;
    try {
      decryptSecret(tainted);
      expect.unreachable('must throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(PLAINTEXT);
      expect(message).not.toContain(tainted);
    }
  });

  // ─── The tail the admin screen shows ──────────────────────────────────────

  it('reports the last four characters, and nothing else', async () => {
    const { secretTail } = await box();
    expect(secretTail(PLAINTEXT)).toBe('7f2a');
    expect(secretTail(`  ${PLAINTEXT}  `)).toBe('7f2a');
  });

  it('reports an empty tail for a secret too short to have one', async () => {
    const { secretTail } = await box();
    // Four characters or fewer is the whole secret. Showing it would not be a
    // hint, it would be the credential.
    for (const short of ['', 'a', 'abcd']) {
      expect(secretTail(short)).toBe('');
    }
  });

  // ─── Shape ────────────────────────────────────────────────────────────────

  it('recognises only its own stored form', async () => {
    const { isSealedSecret } = await box();
    expect(isSealedSecret('v1:aaaa:bbbb:cccc')).toBe(true);
    expect(isSealedSecret(PLAINTEXT)).toBe(false);
    expect(isSealedSecret('v1:aaaa:bbbb')).toBe(false);
    expect(isSealedSecret(undefined)).toBe(false);
    expect(isSealedSecret(null)).toBe(false);
    expect(isSealedSecret(42)).toBe(false);
  });

  it('derives its key with the versioned HKDF info string', async () => {
    const { SECRET_BOX_INFO } = await box();
    // Versioned so a future scheme derives a DIFFERENT key from the same
    // JWT_SECRET rather than reusing this one.
    expect(SECRET_BOX_INFO).toBe('viewpoint-app-settings-v1');
  });

  it('exports the server-only marker', async () => {
    const { _SECRET_BOX_MARKER } = await box();
    // Greppable proof for a build test that this module was tree-shaken out of
    // the browser bundle: if the string appears in dist/, the module leaked, and
    // with it the ability to read every stored credential.
    expect(_SECRET_BOX_MARKER).toBe('__SECRET_BOX_SERVER_ONLY__');
  });
});
