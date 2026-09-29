// GET /api/access-check — 204 when this request may proceed, 401 when not.
//
// This exists for nginx's auth_request, which judges a request by status code
// alone and ignores the body. /api/access answers the browser a JSON
// description of the gate; this answers the proxy a yes or no about ONE
// request, so the two cannot be collapsed.
//
// Why it is needed: in the self-hosted stack the expensive capture endpoints
// do not go through this API at all. nginx streams /api/capture/local and
// /api/capture/transcribe straight to capture-service and adds the shared
// secret itself (deploy/nginx/app.conf). That secret stops anything outside
// the compose network reaching capture-service, but it is added for EVERY
// caller — so before this, anyone who could reach the origin could make the
// server transcribe audio and run the LLM, whether or not a front-door
// password was set. The password guarded the UI and left the GPU open.
//
// When no password is configured the answer is always 204: an install that
// chose to stay open stays open, exactly as before.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requestIsUnlocked } from './_lib/accessControl.ts';

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  if (requestIsUnlocked(req as unknown as { cookies?: Record<string, string> })) {
    res.status(204).end();
    return;
  }

  res.status(401).end();
}

export default handler;
