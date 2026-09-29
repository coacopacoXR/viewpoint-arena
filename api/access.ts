// GET  /api/access — { required: boolean, unlocked: boolean }
// POST /api/access — body { password }; sets vp_access cookie on match.
//
// When ACCESS_PASSWORD_HASH is empty, required is false and every request is
// treated as unlocked — the pre-existing open behaviour. The gate only
// activates when the operator sets a password via install.sh or the admin
// screen. See docs/plan/11-accounts-and-admin.md §M.

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

const COOKIE_NAME = 'vp_access';
const LABEL = 'vp_access';
// 30 days — long enough that the cookie outlives a work week, short enough
// that a stale token on a shared machine is not permanent. Rotate by changing
// the password.
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function storedHash(): string {
  return process.env.ACCESS_PASSWORD_HASH ?? '';
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
    // When no password is configured, every request is unlocked — there is
    // nothing to verify. Return 200 so the UI can proceed.
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

  // A DELETE clears the cookie (logout).
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookieString(COOKIE_NAME));
    res.status(200).json({ unlocked: false });
    return;
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  res.status(405).json({ error: 'method_not_allowed' });
}

export default handler;
