// @vitest-environment node
//
// party/verifyJwt.ts — the room server's proof of who somebody is.
//
// Node, not jsdom: the module verifies through Web Crypto (`crypto.subtle`),
// which node has had as a global since 18 and jsdom does not implement. That is
// also the runtime that matters — Cloudflare's workerd runs the real room
// server and provides the same API.
//
// Tokens are built here with node's own crypto.createHmac rather than by any
// helper from the module under test, so a bug in the signing side cannot hide a
// bug in the verifying side.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyAccessToken } from '../verifyJwt';

const SECRET = 'a-secret-long-enough-to-sign-with';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

interface TokenOptions {
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
  secret?: string;
  /** Replace the computed signature with this raw string. */
  signature?: string;
}

/** A real HS256 JWT, or one deliberately damaged by an option above. */
function token(options: TokenOptions = {}): string {
  const header = base64Url(
    JSON.stringify(options.header ?? { alg: 'HS256', typ: 'JWT' }),
  );
  const claims = base64Url(
    JSON.stringify({
      sub: '6f1a2b3c-0000-4000-8000-000000000001',
      aud: 'authenticated',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      email: 'alex.chen@acme.example',
      user_metadata: { full_name: 'Alex Chen' },
      ...options.claims,
    }),
  );
  const signature =
    options.signature ??
    createHmac('sha256', options.secret ?? SECRET)
      .update(`${header}.${claims}`)
      .digest('base64url');
  return `${header}.${claims}.${signature}`;
}

describe('verifyAccessToken — a token GoTrue would have signed', () => {
  it('answers with the subject and the account name', async () => {
    const verified = await verifyAccessToken(token(), SECRET);

    expect(verified).toEqual({
      sub: '6f1a2b3c-0000-4000-8000-000000000001',
      name: 'Alex Chen',
    });
  });

  it('falls back to the local part of the email when the account has no name', async () => {
    const verified = await verifyAccessToken(
      token({ claims: { user_metadata: {}, email: 'alex.chen@acme.example' } }),
      SECRET,
    );

    // The same precedence the lobby uses (lib/auth/authRules): one spelling of
    // "what do we call this person", so the room and the lobby cannot disagree.
    expect(verified?.name).toBe('alex.chen');
  });

  it('still answers for a token with no user_metadata at all', async () => {
    const verified = await verifyAccessToken(
      token({ claims: { user_metadata: null } }),
      SECRET,
    );

    expect(verified?.sub).toBe('6f1a2b3c-0000-4000-8000-000000000001');
    expect(verified?.name).toBe('alex.chen');
  });

  it('accepts a token that expires in the future by a single second', async () => {
    const verified = await verifyAccessToken(
      token({ claims: { exp: Math.floor(Date.now() / 1000) + 1 } }),
      SECRET,
    );

    expect(verified).not.toBeNull();
  });
});

describe('verifyAccessToken — what it refuses', () => {
  it('refuses a token signed with a different secret', async () => {
    // The attack this exists to stop: anybody can build a well-formed JWT, so
    // the signature is the only thing that makes a name mean anything.
    expect(await verifyAccessToken(token({ secret: 'somebody-elses-secret' }), SECRET)).toBeNull();
  });

  it('refuses a token whose claims were edited after signing', async () => {
    const original = token();
    const [header, , signature] = original.split('.');
    const forged = base64Url(
      JSON.stringify({
        sub: '6f1a2b3c-0000-4000-8000-000000000002',
        aud: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 3600,
        user_metadata: { full_name: 'Someone Else' },
      }),
    );

    expect(await verifyAccessToken(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const expired = token({ claims: { exp: Math.floor(Date.now() / 1000) - 1 } });

    expect(await verifyAccessToken(expired, SECRET)).toBeNull();
  });

  it('refuses a token with no expiry', async () => {
    // GoTrue always sets one (GOTRUE_JWT_EXP=3600). A claim set without `exp`
    // did not come from GoTrue, whatever else is true about it. An explicit
    // undefined overrides the default and is then dropped by JSON.stringify,
    // which is how a real "absent claim" is spelled here.
    expect(await verifyAccessToken(token({ claims: { exp: undefined } }), SECRET)).toBeNull();
    expect(
      await verifyAccessToken(token({ claims: { exp: 'in an hour' } }), SECRET),
    ).toBeNull();
  });

  it('refuses the wrong audience, including the anon key', async () => {
    // The anon key is a JWT signed with THIS secret and published in the client
    // bundle. Accepting it as a person would let any visitor name themselves.
    expect(
      await verifyAccessToken(token({ claims: { aud: 'anon', role: 'anon' } }), SECRET),
    ).toBeNull();
    expect(
      await verifyAccessToken(token({ claims: { aud: 'service_role' } }), SECRET),
    ).toBeNull();
    expect(await verifyAccessToken(token({ claims: { aud: undefined } }), SECRET)).toBeNull();
  });

  it('refuses alg=none and any algorithm that is not HS256', async () => {
    // Read `alg` from the header and then verify with whatever it says, and a
    // token with an empty signature verifies itself.
    const noneToken = token({ header: { alg: 'none', typ: 'JWT' }, signature: '' });
    expect(await verifyAccessToken(noneToken, SECRET)).toBeNull();

    expect(
      await verifyAccessToken(token({ header: { alg: 'RS256', typ: 'JWT' } }), SECRET),
    ).toBeNull();
  });

  it('refuses malformed input rather than throwing', async () => {
    // onMessage runs this on data from an open websocket: a throw here would
    // surface as an unhandled rejection in the room server, and the room must
    // not break because somebody sent it rubbish.
    expect(await verifyAccessToken('', SECRET)).toBeNull();
    expect(await verifyAccessToken('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyAccessToken('a.b', SECRET)).toBeNull();
    expect(await verifyAccessToken('a.b.c.d', SECRET)).toBeNull();
    expect(await verifyAccessToken('!!!.@@@.###', SECRET)).toBeNull();
    expect(
      await verifyAccessToken(`${base64Url('{"alg":"HS256"}')}.${base64Url('[1,2]')}.sig`, SECRET),
    ).toBeNull();
    expect(
      await verifyAccessToken(`${base64Url('{"alg":"HS256"')}.sig.sig`, SECRET),
    ).toBeNull();
  });

  it('refuses a claim set with no usable subject', async () => {
    expect(await verifyAccessToken(token({ claims: { sub: '' } }), SECRET)).toBeNull();
    expect(await verifyAccessToken(token({ claims: { sub: 12345 } }), SECRET)).toBeNull();
    expect(await verifyAccessToken(token({ claims: { sub: undefined } }), SECRET)).toBeNull();
  });

  it('verifies nothing at all without a secret', async () => {
    // A room server started with IDENTITY_MODE on and no JWT_SECRET must fail
    // closed — everybody a guest — rather than throw inside importKey.
    expect(await verifyAccessToken(token(), '')).toBeNull();
  });
});

describe('verifyAccessToken — role from app_metadata', () => {
  it('extracts the admin role when present', async () => {
    const verified = await verifyAccessToken(
      token({ claims: { app_metadata: { role: 'admin' } } }),
      SECRET,
    );

    expect(verified).not.toBeNull();
    expect(verified?.role).toBe('admin');
  });

  it('omits the role when app_metadata has no role', async () => {
    const verified = await verifyAccessToken(
      token({ claims: { app_metadata: {} } }),
      SECRET,
    );

    expect(verified).not.toBeNull();
    expect(verified?.role).toBeUndefined();
  });

  it('omits the role when app_metadata is absent', async () => {
    const verified = await verifyAccessToken(
      token({ claims: { app_metadata: undefined } }),
      SECRET,
    );

    expect(verified).not.toBeNull();
    expect(verified?.role).toBeUndefined();
  });
});
