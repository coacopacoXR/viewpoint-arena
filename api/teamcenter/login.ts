// POST /api/teamcenter/login
//
// Authenticates against Teamcenter using server-side credentials
// (TC_USERNAME / TC_PASSWORD from process.env — never from the request body).
// On success, sets an HttpOnly session cookie and returns { ok: true }.
// Never echoes the password in any response.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getServerConfig,
  tcLoginServer,
  createSession,
  setSessionCookie,
} from './_lib.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const config = getServerConfig();
  if (!config) {
    res.status(503).json({ error: 'teamcenter_not_configured' });
    return;
  }

  try {
    const { sessionId, baseUrl } = await tcLoginServer(config);
    const ref = createSession(sessionId, baseUrl);
    setSessionCookie(res, ref);
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'login_failed';
    // Sanitize: never include the password or raw upstream body in the error.
    // The _lib tcLoginServer throws with codes like "login_failed_401" —
    // safe to forward. Anything else gets a generic message.
    if (/^login_failed_\d+$/.test(message) || message === 'login_no_session_id') {
      res.status(401).json({ error: message });
    } else {
      console.error('[teamcenter] unexpected login error', err);
      res.status(500).json({ error: 'login_failed' });
    }
  }
}
