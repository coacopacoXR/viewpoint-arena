// POST /api/admin-unlock — body { password }; sets vp_admin cookie on match.
//
// Same shape as /api/access but for the admin passphrase (ADMIN_PASSPHRASE in
// .env). Section N builds the admin screen that reads the cookie; this handler
// only does the check and the cookie. When ADMIN_PASSPHRASE_HASH is empty the
// gate is disabled and the POST is a no-op success.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  parseStoredHash,
  verifyPassword,
  signToken,
  verifyToken,
  recordAttempt,
  isAllowed,
  clientIp,
  buildCookieString,
  clearCookieString,
  WRONG_PASSWORD_DELAY_MS,
  delay,
} from './_lib/accessControl.ts';

const COOKIE_NAME = 'vp_admin';
const LABEL = 'vp_admin';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function storedHash(): string {
  return process.env.ADMIN_PASSPHRASE_HASH ?? '';
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  const hash = storedHash();
  const parsed = parseStoredHash(hash);
  const required = parsed !== null;

  if (req.method === 'GET') {
    const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
    const unlocked = required
      ? !!cookie && verifyToken(cookie, hash, LABEL)
      : true;
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ required, unlocked });
    return;
  }

  if (req.method === 'POST') {
    if (!required) {
      res.status(200).json({ unlocked: true });
      return;
    }

    const ip = clientIp(req as unknown as Parameters<typeof clientIp>[0]);

    if (!isAllowed(ip)) {
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }

    recordAttempt(ip);

    const body = req.body as { password?: unknown } | undefined;
    const password = typeof body?.password === 'string' ? body.password : '';

    if (!verifyPassword(password, hash)) {
      await delay(WRONG_PASSWORD_DELAY_MS);
      res.status(401).json({ error: 'wrong_password' });
      return;
    }

    const token = signToken(hash, LABEL);
    res.setHeader('Set-Cookie', buildCookieString(COOKIE_NAME, token, COOKIE_MAX_AGE));
    res.status(200).json({ unlocked: true });
    return;
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookieString(COOKIE_NAME));
    res.status(200).json({ unlocked: false });
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ error: 'method_not_allowed' });
}

export default handler;
