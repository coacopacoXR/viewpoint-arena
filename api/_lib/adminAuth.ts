// Admin authentication for the api handlers.
//
// Every admin endpoint calls `requireAdmin(req, res)` before doing anything.
// It returns the authenticated admin's details on success, or sends a 401/403
// response and returns null — the handler returns early.
//
// Two modes:
//   - identity.mode 'none': the existing passphrase cookie (vp_admin), exactly
//     as today's /api/admin-unlock. The admin passphrase is the only key.
//   - identity.mode 'accounts' | 'sso': a Bearer token in the Authorization
//     header, verified against JWT_SECRET, with app_metadata.role === 'admin'.
//     The passphrase is not used in these modes.
//
// The config is loaded once per call (it is cached by loadConfig), so the mode
// check is always current — a deploy that flips identity on mid-flight starts
// rejecting passphrase cookies on the next request.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import {
  parseStoredHash,
  verifyToken,
} from './accessControl.ts';
import { verifyAccessToken } from '../../lib/auth/verifyJwt.ts';

const ADMIN_COOKIE = 'vp_admin';
const ADMIN_LABEL = 'vp_admin';

export interface AdminIdentity {
  /** The account id (GoTrue sub) in accounts/sso mode, or 'passphrase' in none. */
  sub: string;
  /** Display name in accounts/sso mode, or 'Admin' in none mode. */
  name: string;
}

/**
 * Verify this request is from an admin, or send an error response and return
 * null. The handler MUST return early when the result is null.
 */
export async function requireAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AdminIdentity | null> {
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[adminAuth] failed to load config:', err);
    res.status(500).json({ error: 'config_unavailable' });
    return null;
  }

  const identity = identityOf(config);

  if (identity.mode === 'none') {
    return requirePassphraseAdmin(req, res);
  }

  return requireTokenAdmin(req, res);
}

function requirePassphraseAdmin(
  req: VercelRequest,
  res: VercelResponse,
): AdminIdentity | null {
  const hash = process.env.ADMIN_PASSPHRASE_HASH ?? '';
  const parsed = parseStoredHash(hash);
  if (!parsed) {
    // No passphrase configured — the admin screen should not even be reachable,
    // but if it is, refuse rather than let an unconfigured install be admin'd.
    res.status(401).json({ error: 'not_configured' });
    return null;
  }

  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  const cookie = cookies?.[ADMIN_COOKIE];
  if (!cookie || !verifyToken(cookie, hash, ADMIN_LABEL)) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  return { sub: 'passphrase', name: 'Admin' };
}

async function requireTokenAdmin(
  req: VercelRequest,
  res: VercelResponse,
): Promise<AdminIdentity | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  const secret = process.env.JWT_SECRET ?? '';
  if (!secret) {
    console.error('[adminAuth] JWT_SECRET is not set but identity mode requires it');
    res.status(500).json({ error: 'config_unavailable' });
    return null;
  }

  const verified = await verifyAccessToken(token, secret);
  if (!verified) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }

  if (verified.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return null;
  }

  return { sub: verified.sub, name: verified.name };
}
