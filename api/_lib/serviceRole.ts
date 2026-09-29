// Service-role JWT minting for GoTrue admin calls.
//
// The api container needs to call GoTrue's /admin/users endpoint to manage
// accounts (batch BD). GoTrue accepts a JWT with `role: 'service_role'` signed
// with the same JWT_SECRET the access tokens use. This module mints one,
// caches it until 30 s before expiry, and hands it to the callers.
//
// SERVER ONLY. This file must never end up in the browser bundle — it holds
// the ability to impersonate any account, including admins. The runtime guard
// below throws on import in a non-Node environment, and the build test
// (api/_lib/__tests__/serviceRole.test.ts) greps the built dist/ for the
// marker string to prove the module was tree-shaken out.

import { createHmac } from 'node:crypto';

if (typeof process === 'undefined' || !process.versions.node) {
  throw new Error(
    'serviceRole.ts is server-only. It signs a service-role JWT with JWT_SECRET ' +
      'and must never be imported by client code.',
  );
}

/** Greppable marker: if this string appears in dist/, the module leaked. */
export const _SERVICE_ROLE_MARKER = '__SERVICE_ROLE_SERVER_ONLY__';

const TOKEN_LIFETIME_SEC = 5 * 60;
const REFRESH_BUFFER_SEC = 30;

interface CachedToken {
  token: string;
  /** Epoch seconds — when to mint a fresh one. */
  refreshAt: number;
}

let cached: CachedToken | null = null;

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function jwtSecret(): string {
  return process.env.JWT_SECRET ?? '';
}

/**
 * Mint a service-role JWT, or return null when JWT_SECRET is not set.
 *
 * The token GoTrue expects: `{ role: 'service_role', iss: 'supabase', iat, exp }`,
 * signed HS256 with JWT_SECRET. The `iss: 'supabase'` is what GoTrue checks to
 * distinguish a service-role token from a regular access token.
 */
function mintToken(secret: string, iat: number, exp: number): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      role: 'service_role',
      iss: 'supabase',
      iat,
      exp,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${claims}`)
    .digest('base64url');
  return `${header}.${claims}.${signature}`;
}

/**
 * A valid service-role token for calling GoTrue's admin API, or null when
 * JWT_SECRET is not configured.
 *
 * Caches the token and re-mints it when it is within 30 s of expiry, so
 * repeated calls in a single request do not each sign a new JWT.
 */
export function getServiceRoleToken(): string | null {
  const secret = jwtSecret();
  if (!secret) return null;

  const now = nowSeconds();
  if (cached && cached.refreshAt > now) {
    return cached.token;
  }

  const iat = now;
  const exp = now + TOKEN_LIFETIME_SEC;
  const token = mintToken(secret, iat, exp);
  cached = { token, refreshAt: exp - REFRESH_BUFFER_SEC };
  return token;
}

/** Reset the cache. Tests only. */
export function _resetServiceRoleCache(): void {
  cached = null;
}
