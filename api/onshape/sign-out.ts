// Clears the Onshape OAuth cookies. The frontend redirects here to log out;
// the user can re-authenticate via auth-start any time.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearAuthCookies } from '../_lib/onshape.js';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  clearAuthCookies(res);
  res.status(200).json({ ok: true });
}
