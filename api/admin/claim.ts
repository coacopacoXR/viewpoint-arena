// First-admin claim endpoint (batch BD).
//
// POST /api/admin/claim — the signed-in caller becomes the administrator.
//
// Allowed ONLY while zero admin accounts exist, checked server-side at the
// moment of the request (not cached). After the first admin is created, this
// endpoint returns 409 and the button in the UI disappears.
//
// In identity.mode 'none' this endpoint does not exist — there are no accounts
// to promote. The passphrase mode uses the admin passphrase instead.
//
// The caller does NOT need to be an admin (they are becoming one). They DO need
// a valid access token — the endpoint verifies the Bearer token with
// verifyAccessToken but does not check the role.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import { verifyAccessToken } from '../../lib/auth/verifyJwt.ts';
import { getServiceRoleToken } from '../_lib/serviceRole.ts';

const DEFAULT_ADMIN_URL = 'http://auth:9999';

interface GoTrueUser {
  id: string;
  app_metadata?: Record<string, unknown>;
}

async function adminBase(): Promise<string> {
  const config = await loadConfig();
  const identity = identityOf(config);
  if (identity.mode === 'none') return '';
  return identity.adminUrl ?? DEFAULT_ADMIN_URL;
}

async function gotrueFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const base = await adminBase();
  if (!base) {
    throw new Error('identity_not_configured');
  }
  const token = getServiceRoleToken();
  if (!token) {
    throw new Error('service_role_unavailable');
  }
  const url = `${base.replace(/\/+$/, '')}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

async function countAdmins(): Promise<number> {
  const res = await gotrueFetch('/admin/users?per_page=1000');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[admin/claim] list failed: ${res.status} ${text}`);
    throw new Error('upstream_error');
  }
  const data = (await res.json()) as { users: GoTrueUser[] };
  return data.users.filter((u) => {
    const role = (u.app_metadata ?? {}).role;
    return role === 'admin';
  }).length;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  // GET answers "does this install have an administrator yet?" for any
  // signed-in person, so the page can offer the claim only when it would work
  // and otherwise say plainly that you are not an administrator.
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[admin/claim] failed to load config:', err);
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }

  const identity = identityOf(config);
  if (identity.mode === 'none') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Verify the caller is signed in (but do NOT require admin role — they are
  // claiming to become one).
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const bearerToken = authHeader.slice('Bearer '.length).trim();
  if (!bearerToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const secret = process.env.JWT_SECRET ?? '';
  if (!secret) {
    console.error('[admin/claim] JWT_SECRET is not set but identity mode requires it');
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }

  const verified = await verifyAccessToken(bearerToken, secret);
  if (!verified) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    // Check at the moment of the request — not cached.
    const adminCount = await countAdmins();
    if (req.method === 'GET') {
      res.status(200).json({ adminsExist: adminCount > 0 });
      return;
    }
    if (adminCount > 0) {
      res.status(409).json({ error: 'An administrator already exists.' });
      return;
    }

    // Promote the caller to admin.
    const goRes = await gotrueFetch(
      `/admin/users/${encodeURIComponent(verified.sub)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ app_metadata: { role: 'admin' } }),
      },
    );
    if (!goRes.ok) {
      const text = await goRes.text().catch(() => '');
      console.error(`[admin/claim] promote failed: ${goRes.status} ${text}`);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }

    res.status(200).json({ claimed: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'identity_not_configured') {
      res.status(404).json({ error: 'not_found' });
    } else if (message === 'service_role_unavailable') {
      console.error('[admin/claim] JWT_SECRET is not set');
      res.status(500).json({ error: 'config_unavailable' });
    } else if (message === 'upstream_error') {
      res.status(502).json({ error: 'upstream_error' });
    } else {
      console.error('[admin/claim] unhandled:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  }
}

export default handler;
