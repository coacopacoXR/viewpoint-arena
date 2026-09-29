// Server-side helpers for the api/teamcenter/* Vercel functions.
// Mirrors the session pattern in api/_lib/onshape.ts: credentials live in
// process.env (never reach the browser), and the browser holds only an
// opaque session ID delivered via an HttpOnly cookie.

import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface TCSession {
  tcSessionId: string;
  baseUrl: string;
  createdAt: number;
}

const sessions = new Map<string, TCSession>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

export function setSessionCookie(res: VercelResponse, sessionRef: string): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `vp_tc_session=${encodeURIComponent(sessionRef)}; Max-Age=${maxAge}; ${COOKIE_ATTRS}`,
  );
}

export function clearSessionCookie(res: VercelResponse): void {
  res.setHeader(
    'Set-Cookie',
    `vp_tc_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
}

export function getSession(req: VercelRequest): TCSession | null {
  const cookies = parseCookies(req.headers.cookie);
  const ref = cookies['vp_tc_session'];
  if (!ref) return null;
  purgeExpired();
  return sessions.get(ref) ?? null;
}

export function requireSession(req: VercelRequest, res: VercelResponse): TCSession | null {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not_authenticated' });
    return null;
  }
  return session;
}

export function getServerConfig(): { baseUrl: string; username: string; password: string } | null {
  const baseUrl = process.env.TC_BASE_URL;
  const username = process.env.TC_USERNAME;
  const password = process.env.TC_PASSWORD;
  if (!baseUrl || !username || !password) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ''), username, password };
}

export async function tcLoginServer(
  config: { baseUrl: string; username: string; password: string },
): Promise<{ sessionId: string; baseUrl: string }> {
  const url = `${config.baseUrl}/tc/micro/auth/v1/login`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });

  if (!res.ok) {
    throw new Error(`login_failed_${res.status}`);
  }

  const data = (await res.json()) as { sessionID?: string; session_id?: string; token?: string };
  const sessionId = data.sessionID ?? data.session_id ?? data.token;
  if (!sessionId) {
    throw new Error('login_no_session_id');
  }

  return { sessionId, baseUrl: config.baseUrl };
}

export function createSession(tcSessionId: string, baseUrl: string): string {
  purgeExpired();
  const ref = randomUUID();
  sessions.set(ref, { tcSessionId, baseUrl, createdAt: Date.now() });
  return ref;
}

export function destroySession(ref: string): void {
  sessions.delete(ref);
}

export async function withTCAuth(
  req: VercelRequest,
  res: VercelResponse,
  fn: (session: TCSession) => Promise<void>,
): Promise<void> {
  try {
    const session = requireSession(req, res);
    if (!session) return;
    await fn(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal_error';
    // Never forward raw upstream bodies — they may contain credential echoes.
    console.error('[teamcenter] handler error', message);
    res.status(500).json({ error: 'internal_error' });
  }
}
