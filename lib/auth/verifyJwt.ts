// verifyJwt — verify a GoTrue access token's signature, expiry and audience.
//
// Originally lived in party/verifyJwt.ts (the room server's half of "a signed-in
// name cannot be spoofed"). Moved here so the api handlers can share the same
// verification logic for admin auth (batch BD). Re-exported from the old path
// so the room server and its tests keep compiling unchanged.
//
// Deliberately pure and dependency-light: no PartyKit imports, no room state,
// no Supabase client, no DOM. Web Crypto (`crypto.subtle`) is the only host API
// and both runtimes that execute this file have it — Cloudflare's workerd,
// node, and the api container.

import { displayNameForAccount } from './authRules';

/** A token whose signature, expiry and audience all checked out. */
export interface VerifiedAccount {
  /** GoTrue's `sub` — the same id RLS's auth.uid() returns for this caller. */
  sub: string;
  /**
   * The name to show, derived exactly the way the lobby derives it
   * (lib/auth/authRules.displayNameForAccount): user_metadata.full_name, else
   * the local part of the email address. Sharing that one function is what
   * stops the room and the lobby from disagreeing about what somebody is
   * called.
   */
  name: string;
  /**
   * The account's role from `app_metadata.role`, or undefined when the token
   * carries no role. GoTrue puts `app_metadata` in the access token, and the
   * admin console reads `role === 'admin'` from this field (batch BD). The
   * room server ignores it — presence verification does not care about roles.
   */
  role?: string;
}

// GoTrue is configured with GOTRUE_JWT_AUD=authenticated and
// GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated (docker-compose.yml), and hosted
// Supabase issues the same audience. A token for another audience — the anon
// key is itself a JWT, signed with the same secret and carrying
// role=anon/aud=anon — must not be accepted as a person, or anybody holding the
// published anon key could name themselves in a room.
const EXPECTED_AUDIENCE = 'authenticated';

const ALGORITHM = 'HS256';

/** Seconds, because that is what `exp` carries. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * base64url → bytes, or null when the segment is not base64url at all.
 *
 * `atob` is the forgiving decoder both runtimes provide and this repo already
 * uses for wire data (lib/usePartyPresence decodes a model file the same way);
 * it accepts the missing padding base64url omits, so only the two alphabet
 * substitutions are needed.
 */
function base64UrlToBytes(segment: string): Uint8Array | null {
  try {
    const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** A JWT segment that is base64url-encoded JSON, or null. Never throws. */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlToBytes(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compare without stopping at the first differing byte.
 *
 * The lengths are public (a SHA-256 HMAC is always 32 bytes), so leaking them
 * costs nothing; leaking WHICH byte differed first is what would let a forger
 * walk a signature into place one byte at a time.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function signatureIsValid(
  signingInput: string,
  signature: Uint8Array,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)),
  );
  return equalBytes(expected, signature);
}

/**
 * Verify an access token, or return null.
 *
 * Null is the only failure mode and it is deliberately uninformative: an
 * expired token, a forged signature, the wrong algorithm, a token for another
 * audience and a string that is not a JWT at all all look the same to the
 * caller, which treats every one of them as "not signed in" and marks the
 * presence as a guest. Nothing here throws and nothing here logs — the token is
 * a bearer credential, and a log line is a place it could survive.
 *
 * @param token  the access token as the client sent it.
 * @param secret the deployment's JWT_SECRET. An empty secret verifies nothing,
 *               which is the right answer for a room server that was started
 *               without one rather than an exception in a message handler.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<VerifiedAccount | null> {
  if (!token || !secret) return null;

  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [headerSegment, claimsSegment, signatureSegment] = segments;
  if (!headerSegment || !claimsSegment || !signatureSegment) return null;

  // The algorithm is checked BEFORE the signature, and only HS256 is accepted.
  // A verifier that read `alg` from the token and acted on it would accept
  // `none` (no signature at all) or an RSA key published as a secret.
  const header = decodeJsonSegment(headerSegment);
  if (!header || header.alg !== ALGORITHM) return null;

  const signature = base64UrlToBytes(signatureSegment);
  if (!signature) return null;

  if (!(await signatureIsValid(`${headerSegment}.${claimsSegment}`, signature, secret))) {
    return null;
  }

  const claims = decodeJsonSegment(claimsSegment);
  if (!claims) return null;

  const { sub, aud, exp, email, user_metadata: userMetadata, app_metadata: appMetadata } = claims;
  if (typeof sub !== 'string' || !sub) return null;
  if (aud !== EXPECTED_AUDIENCE) return null;
  // No `exp` means a token that never expires, which GoTrue does not issue —
  // so its absence says the token did not come from GoTrue.
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds()) return null;

  const result: VerifiedAccount = {
    sub,
    name: displayNameForAccount({
      id: sub,
      email: typeof email === 'string' ? email : null,
      user_metadata: isRecord(userMetadata) ? userMetadata : null,
    }),
  };
  if (isRecord(appMetadata) && typeof appMetadata.role === 'string') {
    result.role = appMetadata.role;
  }
  return result;
}
