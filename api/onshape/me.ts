// Returns the current Onshape user info, or 401 if not signed in.
// The frontend uses this to know whether to show "Sign in with Onshape"
// vs "Logged in as Robin · Sign out".

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callOnshape, applyRefreshedCookies, withAuth } from '../_lib/onshape.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await withAuth(res, async () => {
    const { response, refreshedCookies } = await callOnshape(req, '/api/v9/users/sessioninfo');
    applyRefreshedCookies(res, refreshedCookies);
    if (!response.ok) {
      res.status(response.status).json({ error: 'onshape_api_error', detail: await response.text() });
      return;
    }
    res.status(200).json(await response.json());
  });
}
