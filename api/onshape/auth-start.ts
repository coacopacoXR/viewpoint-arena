// Initiates the Onshape OAuth flow. Generates a CSRF state token, stashes it
// in a short-lived HTTP-only cookie alongside the post-auth return URL, and
// 302s the browser to Onshape's authorize endpoint. The callback handler
// validates state against the cookie before exchanging the code.
//
// GET /api/onshape/auth-start?return=<encoded url to come back to>

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { randomBytes } from 'node:crypto';
import { safeReturnPath } from '../_lib/safeReturnPath.js';

const ONSHAPE_AUTHORIZE = 'https://oauth.onshape.com/oauth/authorize';
const SCOPES = 'OAuth2Read OAuth2ReadPII';

function originOf(req: VercelRequest): string {
  // Vercel sets x-forwarded-host / x-forwarded-proto for the public URL.
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  const clientId = process.env.ONSHAPE_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: 'ONSHAPE_CLIENT_ID is not configured' });
    return;
  }

  const state = randomBytes(24).toString('hex');
  // Validated on the way in, not only on the way out. This value is packed into
  // the state cookie and echoed by the callback as a redirect target, so a
  // hostile `return` (e.g. //evil.com) must never be stored in the first place.
  const returnTo = safeReturnPath(req.query.return);
  const redirectUri = `${originOf(req)}/api/onshape/callback`;

  // Pack state + return URL into a single HTTP-only cookie so the callback
  // can verify CSRF and know where to send the user afterward. 10-minute TTL
  // is plenty for a login round-trip.
  const cookiePayload = Buffer.from(JSON.stringify({ state, returnTo })).toString('base64url');
  res.setHeader('Set-Cookie',
    `vp_onshape_oauth=${cookiePayload}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
  );

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
  });
  res.redirect(302, `${ONSHAPE_AUTHORIZE}?${params.toString()}`);
}
