// Shared helpers for the api/onshape/* serverless functions. Extracts the
// access token from the HTTP-only cookie, transparently refreshes it via
// the refresh_token cookie when expired, and proxies an Onshape API call.
//
// Returns the parsed JSON (or the raw Response if the caller wants binary).

import type { VercelRequest, VercelResponse } from '@vercel/node';

const ONSHAPE_API = 'https://cad.onshape.com';
const ONSHAPE_TOKEN = 'https://oauth.onshape.com/oauth/token';

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

async function refreshAccessToken(refreshToken: string): Promise<
  { ok: true; access_token: string; expires_in: number; refresh_token?: string } |
  { ok: false; status: number; body: string }
> {
  const clientId = process.env.ONSHAPE_CLIENT_ID!;
  const clientSecret = process.env.ONSHAPE_CLIENT_SECRET!;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const resp = await fetch(ONSHAPE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) return { ok: false, status: resp.status, body: await resp.text() };
  const j = await resp.json() as { access_token: string; expires_in: number; refresh_token?: string };
  return { ok: true, ...j };
}

export interface AuthedCall {
  accessToken: string;
  /** If a refresh happened, the new cookies the caller must set on its response. */
  refreshedCookies?: string[];
}

// Thrown when auth is missing or refresh fails. Carries the HTTP status the
// API endpoint should send back to the client.
export class OnshapeAuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
    this.name = 'OnshapeAuthError';
  }
}

export async function getAuthedToken(req: VercelRequest): Promise<AuthedCall> {
  const cookies = parseCookies(req.headers.cookie);
  const at = cookies['vp_onshape_at'];
  if (at) return { accessToken: at };

  // No access token cookie — try to refresh.
  const rt = cookies['vp_onshape_rt'];
  if (!rt) throw new OnshapeAuthError('not_authenticated');

  const refreshed = await refreshAccessToken(rt);
  if (!refreshed.ok) throw new OnshapeAuthError('refresh_failed');

  const accessMaxAge = Math.max(60, refreshed.expires_in - 60);
  const cookies_out = [`vp_onshape_at=${encodeURIComponent(refreshed.access_token)}; Max-Age=${accessMaxAge}; ${COOKIE_ATTRS}`];
  if (refreshed.refresh_token) {
    cookies_out.push(`vp_onshape_rt=${encodeURIComponent(refreshed.refresh_token)}; Max-Age=${60 * 60 * 24 * 30}; ${COOKIE_ATTRS}`);
  }
  return { accessToken: refreshed.access_token, refreshedCookies: cookies_out };
}

export async function callOnshape(
  req: VercelRequest,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; refreshedCookies?: string[] }> {
  const auth = await getAuthedToken(req);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${auth.accessToken}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json;charset=UTF-8;qs=0.09');
  const url = path.startsWith('http') ? path : `${ONSHAPE_API}${path}`;
  const response = await fetch(url, { ...init, headers });
  return { response, refreshedCookies: auth.refreshedCookies };
}

// Helper: wrap a handler body so any OnshapeAuthError gets a clean 401 instead
// of crashing the function.
export async function withAuth(
  res: VercelResponse,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof OnshapeAuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[onshape] unexpected error', err);
    res.status(500).json({ error: (err as Error).message || 'internal_error' });
  }
}

export function applyRefreshedCookies(res: VercelResponse, cookies?: string[]) {
  if (!cookies || cookies.length === 0) return;
  const existing = res.getHeader('Set-Cookie');
  if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, ...cookies]);
  else if (typeof existing === 'string') res.setHeader('Set-Cookie', [existing, ...cookies]);
  else res.setHeader('Set-Cookie', cookies);
}

/** Clear all Onshape OAuth cookies — used by the sign-out endpoint. */
export function clearAuthCookies(res: VercelResponse) {
  res.setHeader('Set-Cookie', [
    `vp_onshape_at=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    `vp_onshape_rt=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  ]);
}
