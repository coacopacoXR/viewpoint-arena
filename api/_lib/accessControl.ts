// Shared helpers for the optional front-door password and admin passphrase
// (docs/plan/11-accounts-and-admin.md §M). Two secrets, both empty by default,
// stored as salted SHA-256 hashes in .env. When the hash is empty the
// corresponding gate is disabled and every request is treated as unlocked —
// that is exactly the pre-existing behaviour, so no install locks itself out.
//
// Hashing: <salt>:<sha256(salt + password)>. A COLON, not a '$': these values
// live in .env, and Docker Compose interpolates '$' there — a '$'-separated
// hash reached the container with the separator eaten and every password was
// refused (found live 2026-09-23). Legacy '$' values are still parsed.
// The salt is 16 hex chars from the
// OS CSPRNG. The hash is stored, never the password — a leaked .env gives an
// attacker a hash to crack offline rather than the password itself, and the
// salt ensures two installs with the same password produce different hashes.
//
// Cookie tokens: HMAC-SHA256 keyed with the stored hash over a fixed label.
// The server recomputes the same HMAC to verify; the cookie value reveals
// neither the password nor the hash. Rotating the password changes the hash
// and invalidates every outstanding cookie.

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export interface HashedSecret {
  salt: string;
  hash: string;
}

const SALT_BYTES = 8;
const HASH_ALGO = 'sha256';

/**
 * Hash a password with a fresh salt. Returns the "<salt>:<hash>" string that
 * goes into .env. Matches the openssl command install.sh uses, so the two
 * agree for the same input.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = createHash(HASH_ALGO).update(salt + password).digest('hex');
  return `${salt}:${hash}`;
}

/**
 * Parse a stored "<salt>:<hash>" value ('$' also accepted, see above).
 * Returns null when the value is empty
 * or malformed — empty means the gate is disabled.
 */
export function parseStoredHash(value: string | undefined): HashedSecret | null {
  if (!value) return null;
  const idx = value.includes(':') ? value.indexOf(':') : value.indexOf('$');
  if (idx < 1 || idx >= value.length - 1) return null;
  return { salt: value.slice(0, idx), hash: value.slice(idx + 1) };
}

/**
 * Verify a candidate password against a stored "<salt>:<hash>". Uses
 * timingSafeEqual so a wrong password does not return faster than a right one.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const candidate = createHash(HASH_ALGO).update(parsed.salt + password).digest('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(parsed.hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Sign a cookie token. The HMAC key is the stored hash itself, so only the
 * server (which reads the hash from .env) can produce or verify it. The label
 * separates access tokens from admin tokens even though they use the same
 * mechanism — a cookie minted for one gate cannot satisfy the other.
 */
export function signToken(storedHash: string, label: string): string {
  return createHmac(HASH_ALGO, storedHash).update(label).digest('hex');
}

/**
 * Verify a cookie token. Returns true only when the HMAC matches.
 */
export function verifyToken(token: string, storedHash: string, label: string): boolean {
  const expected = signToken(storedHash, label);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(token, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Rate limiting ──────────────────────────────────────────────────────────
//
// In-memory, per-IP, 10 attempts per 60-second sliding window. Good enough for
// a shared password on a self-deployed tool — the threat model is a colleague
// guessing on the office network, not a botnet. A persistent store (Redis,
// Postgres) would be needed for internet-facing deployments, which this is not.

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;

interface RateBucket {
  timestamps: number[];
}

const buckets = new Map<string, RateBucket>();

/**
 * Record an attempt and return whether the caller is within the limit.
 * Exported for tests; the handler calls recordAttempt + isAllowed together.
 */
export function recordAttempt(ip: string): void {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(ip, bucket);
  }
  bucket.timestamps.push(now);
  // Evict entries older than the window so the map does not grow without bound.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < WINDOW_MS);
}

export function isAllowed(ip: string): boolean {
  const bucket = buckets.get(ip);
  if (!bucket) return true;
  const now = Date.now();
  const recent = bucket.timestamps.filter((t) => now - t < WINDOW_MS);
  return recent.length < MAX_ATTEMPTS;
}

/** Reset all rate-limit state. Tests only. */
export function _resetRateLimit(): void {
  buckets.clear();
}

// ─── Cookie helpers ─────────────────────────────────────────────────────────

/**
 * Build a Set-Cookie value for an access/admin token. HttpOnly so JavaScript
 * cannot read it, SameSite=Lax so it rides same-site navigations, Secure so it
 * only travels over TLS (the app is HTTPS-only in production).
 */
export function buildCookieString(
  name: string,
  value: string,
  maxAgeSec: number,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ].join('; ');
}

/**
 * Clear a cookie by setting Max-Age=0.
 */
export function clearCookieString(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

/**
 * Extract the client IP from the request. X-Forwarded-First is set by
 * nginx-proxy; fall back to the socket address.
 */
export function clientIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    const first = (Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Fixed delay on a wrong password (400 ms per spec). */
export const WRONG_PASSWORD_DELAY_MS = 400;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether this request may proceed past the front door.
 *
 * True when the deployment has no front-door password (an install that chose
 * to stay open stays open) or when the request carries a valid `vp_access`
 * cookie.
 *
 * This is what the endpoints that SPEND something — a GPU, a cloud API key —
 * are held to. The password used to guard only the UI: the capture routes
 * attach their own upstream credential for every caller, so anyone who could
 * reach the origin could make the deployment transcribe audio or bill a
 * provider without ever seeing a screen.
 */
export function requestIsUnlocked(
  req: { cookies?: Record<string, string> },
): boolean {
  const hash = process.env.ACCESS_PASSWORD_HASH ?? '';
  if (parseStoredHash(hash) === null) return true;
  const cookie = req.cookies?.['vp_access'];
  return !!cookie && verifyToken(cookie, hash, 'vp_access');
}
