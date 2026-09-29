// People endpoints for the admin console (batch BD).
//
// All behind requireAdmin. 404 in identity.mode 'none' — the passphrase mode
// has no accounts to manage.
//
// GET    /api/admin/users         → list accounts
// POST   /api/admin/users         → create an account
// PATCH  /api/admin/users?id=...  → update an account (admin, disabled, name)
// DELETE /api/admin/users?id=...  → delete an account
//
// The user ID for PATCH and DELETE travels as a query parameter because the
// self-hosted api shim (server/vercelShim.ts) uses filesystem routing with
// SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/, which does not match Vercel's [id]
// dynamic segments. A query parameter works on both runtimes without a shim
// change.
//
// GoTrue admin API: the api container calls GoTrue's /admin/users with a
// service-role JWT (api/_lib/serviceRole.ts). The admin base URL comes from
// identity.adminUrl in viewpoint.config.ts, defaulting to http://auth:9999
// (the bundled GoTrue service on the Docker network).
//
// Guards (server-side, checked at the moment of the request):
//   - An admin cannot demote, disable or delete themselves.
//   - The last admin cannot be demoted, disabled or deleted.
//   Both return 409 with a plain sentence.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import { requireAdmin } from '../_lib/adminAuth.ts';
import { getServiceRoleToken } from '../_lib/serviceRole.ts';

const DEFAULT_ADMIN_URL = 'http://auth:9999';

interface GoTrueUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  created_at: string;
  last_sign_in_at?: string;
  banned_until?: string;
}

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
  last_sign_in_at: string | null;
  disabled: boolean;
}

function toAdminUser(u: GoTrueUser): AdminUser {
  const metadata = u.user_metadata ?? {};
  const name = typeof metadata.full_name === 'string' ? metadata.full_name : '';
  const appMeta = u.app_metadata ?? {};
  const role = typeof appMeta.role === 'string' ? appMeta.role : 'authenticated';
  return {
    id: u.id,
    email: u.email ?? '',
    name,
    role,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
    disabled: typeof u.banned_until === 'string' && u.banned_until !== '',
  };
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

async function listAdmins(): Promise<number> {
  const res = await gotrueFetch('/admin/users?per_page=1000');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[admin/users] list failed: ${res.status} ${text}`);
    throw new Error('upstream_error');
  }
  const data = (await res.json()) as { users: GoTrueUser[] };
  return data.users.filter((u) => {
    const role = (u.app_metadata ?? {}).role;
    return role === 'admin';
  }).length;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[admin/users] failed to load config:', err);
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }

  const identity = identityOf(config);
  if (identity.mode === 'none') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  try {
    if (req.method === 'GET') {
      await handleList(res);
    } else if (req.method === 'POST') {
      await handleCreate(req, res);
    } else if (req.method === 'PATCH') {
      await handleUpdate(req, res, admin.sub);
    } else if (req.method === 'DELETE') {
      await handleDelete(req, res, admin.sub);
    } else {
      res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
      res.status(405).json({ error: 'method_not_allowed' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'identity_not_configured') {
      res.status(404).json({ error: 'not_found' });
    } else if (message === 'service_role_unavailable') {
      console.error('[admin/users] JWT_SECRET is not set');
      res.status(500).json({ error: 'config_unavailable' });
    } else if (message === 'upstream_error') {
      res.status(502).json({ error: 'upstream_error' });
    } else {
      console.error('[admin/users] unhandled:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  }
}

async function handleList(res: VercelResponse) {
  const goRes = await gotrueFetch('/admin/users?per_page=1000');
  if (!goRes.ok) {
    const text = await goRes.text().catch(() => '');
    console.error(`[admin/users] list failed: ${goRes.status} ${text}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  const data = (await goRes.json()) as { users: GoTrueUser[] };
  const users = data.users.map(toAdminUser);
  res.status(200).json({ users });
}

async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const body = req.body as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
    admin?: unknown;
  } | undefined;

  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const isAdmin = body?.admin === true;

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const goBody: Record<string, unknown> = {
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  };
  if (isAdmin) {
    goBody.app_metadata = { role: 'admin' };
  }

  const goRes = await gotrueFetch('/admin/users', {
    method: 'POST',
    body: JSON.stringify(goBody),
  });
  if (!goRes.ok) {
    const text = await goRes.text().catch(() => '');
    console.error(`[admin/users] create failed: ${goRes.status} ${text}`);
    // GoTrue returns { msg: "..." } for validation errors like duplicate email.
    if (goRes.status === 422) {
      res.status(409).json({ error: 'An account with that email already exists.' });
    } else {
      res.status(502).json({ error: 'upstream_error' });
    }
    return;
  }
  const user = (await goRes.json()) as GoTrueUser;
  res.status(201).json({ user: toAdminUser(user) });
}

async function handleUpdate(
  req: VercelRequest,
  res: VercelResponse,
  callerSub: string,
) {
  const id = readIdParam(req);
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  const body = req.body as {
    admin?: unknown;
    disabled?: unknown;
    name?: unknown;
  } | undefined;

  const wantsAdminChange = typeof body?.admin === 'boolean';
  const wantsDisable = typeof body?.disabled === 'boolean';
  const newName = typeof body?.name === 'string' ? body.name.trim() : undefined;

  // Guard: cannot act on yourself.
  if (id === callerSub && callerSub !== 'passphrase') {
    if (wantsAdminChange || wantsDisable) {
      res.status(409).json({ error: 'You cannot change your own role or status.' });
      return;
    }
  }

  // Guard: last admin cannot be demoted or disabled.
  if (wantsAdminChange && body?.admin === false) {
    const adminCount = await listAdmins();
    if (adminCount <= 1) {
      // Check if the target is currently an admin.
      const target = await fetchUser(id);
      if (target && (target.app_metadata ?? {}).role === 'admin') {
        res.status(409).json({ error: 'The last administrator cannot be demoted.' });
        return;
      }
    }
  }
  if (wantsDisable && body?.disabled === true) {
    const adminCount = await listAdmins();
    if (adminCount <= 1) {
      const target = await fetchUser(id);
      if (target && (target.app_metadata ?? {}).role === 'admin') {
        res.status(409).json({ error: 'The last administrator cannot be disabled.' });
        return;
      }
    }
  }

  const goBody: Record<string, unknown> = {};
  if (wantsAdminChange) {
    goBody.app_metadata = { role: body?.admin ? 'admin' : 'authenticated' };
  }
  if (wantsDisable) {
    goBody.ban_duration = body?.disabled ? '876000h' : 'none';
  }
  if (newName !== undefined) {
    goBody.user_metadata = { full_name: newName };
  }

  if (Object.keys(goBody).length === 0) {
    res.status(400).json({ error: 'nothing to update' });
    return;
  }

  const goRes = await gotrueFetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(goBody),
  });
  if (!goRes.ok) {
    const text = await goRes.text().catch(() => '');
    console.error(`[admin/users] update failed: ${goRes.status} ${text}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  const user = (await goRes.json()) as GoTrueUser;
  res.status(200).json({ user: toAdminUser(user) });
}

async function handleDelete(
  req: VercelRequest,
  res: VercelResponse,
  callerSub: string,
) {
  const id = readIdParam(req);
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  // Guard: cannot delete yourself.
  if (id === callerSub && callerSub !== 'passphrase') {
    res.status(409).json({ error: 'You cannot delete your own account.' });
    return;
  }

  // Guard: last admin cannot be deleted.
  const target = await fetchUser(id);
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if ((target.app_metadata ?? {}).role === 'admin') {
    const adminCount = await listAdmins();
    if (adminCount <= 1) {
      res.status(409).json({ error: 'The last administrator cannot be deleted.' });
      return;
    }
  }

  const goRes = await gotrueFetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!goRes.ok) {
    const text = await goRes.text().catch(() => '');
    console.error(`[admin/users] delete failed: ${goRes.status} ${text}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  res.status(200).json({ deleted: true });
}

async function fetchUser(id: string): Promise<GoTrueUser | null> {
  const res = await gotrueFetch(`/admin/users/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return (await res.json()) as GoTrueUser;
}

function readIdParam(req: VercelRequest): string | null {
  const raw = req.query.id;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim();
}

export default handler;
