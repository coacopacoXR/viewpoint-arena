// Completes the Onshape OAuth flow. Validates the state cookie set by
// auth-start, exchanges the code for an access + refresh token, sets two
// HTTP-only cookies (access token short-lived, refresh token longer-lived),
// and 302s the user back to where they came from.
//
// GET /api/onshape/callback?code=<authcode>&state=<token>

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { safeReturnPath } from '../_lib/safeReturnPath.js';

const ONSHAPE_TOKEN = 'https://oauth.onshape.com/oauth/token';

function originOf(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.ONSHAPE_CLIENT_ID;
  const clientSecret = process.env.ONSHAPE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send('Onshape OAuth env vars are not configured.');
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !state) {
    res.status(400).send('Missing code or state.');
    return;
  }

  // Validate the state cookie set in auth-start.
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies['vp_onshape_oauth'];
  if (!raw) {
    res.status(400).send('Missing OAuth state cookie. Restart the sign-in.');
    return;
  }
  let parsed: { state: string; returnTo: string };
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    res.status(400).send('Malformed OAuth state cookie.');
    return;
  }
  if (parsed.state !== state) {
    res.status(400).send('State mismatch — possible CSRF. Restart the sign-in.');
    return;
  }

  // Exchange the auth code for tokens.
  const redirectUri = `${originOf(req)}/api/onshape/callback`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  let tokenResp: Response;
  try {
    tokenResp = await fetch(ONSHAPE_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    res.status(502).send(`Token exchange failed: ${(err as Error).message}`);
    return;
  }

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    res.status(502).send(`Onshape token exchange ${tokenResp.status}: ${text}`);
    return;
  }

  const tokens = (await tokenResp.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;     // seconds
    refresh_token?: string;
    scope?: string;
  };

  // Drop the access token + refresh token into HTTP-only cookies. Access
  // token is short-lived (matches Onshape's expiry); refresh token persists
  // for ~30 days so the user doesn't have to re-auth on every visit.
  const accessMaxAge = Math.max(60, tokens.expires_in - 60);
  const refreshMaxAge = 60 * 60 * 24 * 30;
  const cookieAttrs = 'Path=/; HttpOnly; Secure; SameSite=Lax';

  // URL-encode the values: Onshape access tokens can include '=' padding or
  // other characters that, while technically allowed in cookie values per
  // RFC 6265, sometimes get mangled by proxies or specific parsers.
  const setCookies = [
    `vp_onshape_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`, // clear state
    `vp_onshape_at=${encodeURIComponent(tokens.access_token)}; Max-Age=${accessMaxAge}; ${cookieAttrs}`,
  ];
  if (tokens.refresh_token) {
    setCookies.push(`vp_onshape_rt=${encodeURIComponent(tokens.refresh_token)}; Max-Age=${refreshMaxAge}; ${cookieAttrs}`);
  }
  res.setHeader('Set-Cookie', setCookies);

  // Send them back to wherever they started. Default to root if no return URL.
  //
  // safeReturnPath, NOT `parsed.returnTo.startsWith('/')`: both `//evil.com`
  // and `/\evil.com` start with a slash, and browsers resolve either as another
  // host — an open redirect that carries a freshly-minted Onshape session with
  // it. auth-start validates the same value on the way in; this is the check
  // that has to hold even for a cookie written by an older build.
  res.redirect(302, safeReturnPath(parsed.returnTo));
}
