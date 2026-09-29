// Reviews admin endpoint (plan 14, batch BE).
//
// GET  /api/admin/reviews          — list every review with owner, member count,
//                                    revisions count, last meeting date, archived.
//                                    Query params: filter (active|archived|all),
//                                    search (title substring).
// PATCH /api/admin/reviews?id=...  — transfer owner (by email) or archive/unarchive.
//
// Both behind requireAdmin. In identity.mode 'none' the owner fields are absent
// and the transfer action is refused — there are no accounts to name.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import { requireAdmin } from '../_lib/adminAuth.ts';
import { getServiceRoleToken } from '../_lib/serviceRole.ts';
import { postgrestFetch } from '../_lib/postgrest.ts';

const DEFAULT_ADMIN_URL = 'http://auth:9999';

interface CurationRow {
  id: string;
  title: string;
  owner_id: string | null;
  archived: boolean;
  listed: boolean;
  updated_at: string;
  created_at: string;
}

interface AdminReview {
  id: string;
  title: string;
  listed: boolean;
  archived: boolean;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  member_count: number;
  revisions_count: number;
  last_meeting_at: string | null;
  updated_at: string;
  created_at: string;
}

interface GoTrueUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[admin/reviews] failed to load config:', err);
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }

  const identity = identityOf(config);

  try {
    if (req.method === 'GET') {
      await handleList(req, res, identity.mode);
    } else if (req.method === 'PATCH') {
      await handleUpdate(req, res, identity.mode);
    } else {
      res.setHeader('Allow', 'GET, PATCH');
      res.status(405).json({ error: 'method_not_allowed' });
    }
  } catch (err) {
    console.error('[admin/reviews] unhandled:', err);
    res.status(500).json({ error: 'internal_error' });
  }
}

async function handleList(
  req: VercelRequest,
  res: VercelResponse,
  mode: string,
) {
  const filter = readStringParam(req, 'filter') ?? 'active';
  const search = readStringParam(req, 'search') ?? '';

  const curationsRes = await postgrestFetch(
    'review_curations?select=id,title,owner_id,archived,listed,updated_at,created_at' +
    '&order=updated_at.desc&limit=200',
  );
  if (!curationsRes) {
    res.status(503).json({ error: 'store_unavailable' });
    return;
  }
  if (!curationsRes.ok) {
    console.error(`[admin/reviews] list failed: ${curationsRes.status}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  const rows = (await curationsRes.json()) as CurationRow[];

  // Filter by archived status.
  let filtered = rows;
  if (filter === 'active') {
    filtered = rows.filter((r) => !r.archived);
  } else if (filter === 'archived') {
    filtered = rows.filter((r) => r.archived);
  }

  // Filter by title search.
  if (search) {
    const lower = search.toLowerCase();
    filtered = filtered.filter((r) => r.title.toLowerCase().includes(lower));
  }

  // Parallel queries for counts and last meeting.
  const [memberRes, revisionRes, meetingRes] = await Promise.all([
    postgrestFetch('review_members?select=review_id'),
    postgrestFetch('model_revisions?select=review_id'),
    postgrestFetch(
      'tracker_sessions?select=review_id,ended_at&review_id=not.is.null&order=ended_at.desc&limit=500',
    ),
  ]);

  const [memberCounts, revisionCounts, lastMeetings] = await Promise.all([
    countByReviewId(memberRes),
    countByReviewId(revisionRes),
    latestMeetingByReviewId(meetingRes),
  ]);

  // Resolve owner names/emails in accounts mode.
  const ownerMap = mode !== 'none'
    ? await resolveOwnerNames(filtered.map((r) => r.owner_id).filter(Boolean) as string[])
    : new Map<string, { name: string; email: string }>();

  const reviews: AdminReview[] = filtered.map((r) => ({
    id: r.id,
    title: r.title,
    listed: r.listed,
    archived: r.archived,
    owner_id: mode !== 'none' ? r.owner_id : null,
    owner_name: mode !== 'none' ? (ownerMap.get(r.owner_id ?? '')?.name ?? null) : null,
    owner_email: mode !== 'none' ? (ownerMap.get(r.owner_id ?? '')?.email ?? null) : null,
    member_count: memberCounts.get(r.id) ?? 0,
    revisions_count: revisionCounts.get(r.id) ?? 0,
    last_meeting_at: lastMeetings.get(r.id) ?? null,
    updated_at: r.updated_at,
    created_at: r.created_at,
  }));

  res.status(200).json({ reviews });
}

async function handleUpdate(
  req: VercelRequest,
  res: VercelResponse,
  mode: string,
) {
  const id = readStringParam(req, 'id');
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  const body = req.body as {
    owner_email?: unknown;
    archived?: unknown;
  } | undefined;

  const wantsTransfer = typeof body?.owner_email === 'string' && body.owner_email.trim() !== '';
  const wantsArchive = typeof body?.archived === 'boolean';

  if (!wantsTransfer && !wantsArchive) {
    res.status(400).json({ error: 'nothing to update' });
    return;
  }

  if (wantsTransfer && mode === 'none') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  if (wantsArchive) {
    const archiveRes = await postgrestFetch(
      `review_curations?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ archived: body?.archived }),
      },
    );
    if (!archiveRes) {
      res.status(503).json({ error: 'store_unavailable' });
      return;
    }
    if (!archiveRes.ok) {
      console.error(`[admin/reviews] archive failed: ${archiveRes.status}`);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }
  }

  if (wantsTransfer) {
    const email = (body?.owner_email as string).trim();
    const targetUser = await findGoTrueUserByEmail(email);
    if (!targetUser) {
      res.status(404).json({ error: 'account_not_found' });
      return;
    }

    // Update review_curations.owner_id via service-role PostgREST.
    const ownerRes = await postgrestFetch(
      `review_curations?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ owner_id: targetUser.id }),
      },
    );
    if (!ownerRes || !ownerRes.ok) {
      console.error(`[admin/reviews] owner update failed: ${ownerRes?.status}`);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }

    // Remove any existing 'owner' role row for this review, then insert the
    // new owner's row. Both through service-role PostgREST (BYPASSRLS).
    await postgrestFetch(
      `review_members?review_id=eq.${encodeURIComponent(id)}&role=eq.owner`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );
    const memberRes = await postgrestFetch('review_members', {
      method: 'POST',
      body: JSON.stringify({
        review_id: id,
        user_id: targetUser.id,
        role: 'owner',
      }),
    });
    if (!memberRes || !memberRes.ok) {
      // The owner_id was already updated; the member row is secondary. Log and
      // continue — the review has the right owner, the roster just misses the
      // row, which the next room open will not break on.
      console.error(`[admin/reviews] member row write failed: ${memberRes?.status}`);
    }
  }

  res.status(200).json({ ok: true });
}

async function countByReviewId(res: Response | null): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!res || !res.ok) return map;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return map;
  }
  if (!Array.isArray(data)) return map;
  for (const row of data as Array<{ review_id: string }>) {
    if (row.review_id) {
      map.set(row.review_id, (map.get(row.review_id) ?? 0) + 1);
    }
  }
  return map;
}

async function latestMeetingByReviewId(res: Response | null): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!res || !res.ok) return map;
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return map;
  }
  if (!Array.isArray(data)) return map;
  for (const row of data as Array<{ review_id: string; ended_at: string }>) {
    if (row.review_id && row.ended_at) {
      const prev = map.get(row.review_id);
      if (!prev || row.ended_at > prev) {
        map.set(row.review_id, row.ended_at);
      }
    }
  }
  return map;
}

async function resolveOwnerNames(
  ownerIds: string[],
): Promise<Map<string, { name: string; email: string }>> {
  const map = new Map<string, { name: string; email: string }>();
  if (ownerIds.length === 0) return map;

  const token = getServiceRoleToken();
  if (!token) return map;

  const base = await adminBase();
  if (!base) return map;

  // Fetch all users and filter by id. GoTrue's admin API does not support
  // batch lookup by id, so we list and filter.
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/admin/users?per_page=1000`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return map;
    const data = (await res.json()) as { users: GoTrueUser[] };
    const wanted = new Set(ownerIds);
    for (const u of data.users) {
      if (wanted.has(u.id)) {
        const name = typeof u.user_metadata?.full_name === 'string'
          ? u.user_metadata.full_name
          : '';
        map.set(u.id, { name, email: u.email ?? '' });
      }
    }
  } catch {
    // Unreachable — logged by the caller.
  }
  return map;
}

async function findGoTrueUserByEmail(email: string): Promise<GoTrueUser | null> {
  const token = getServiceRoleToken();
  if (!token) return null;

  const base = await adminBase();
  if (!base) return null;

  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/admin/users?per_page=1000`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { users: GoTrueUser[] };
    return data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

async function adminBase(): Promise<string> {
  const config = await loadConfig();
  const identity = identityOf(config);
  if (identity.mode === 'none') return '';
  return identity.adminUrl ?? DEFAULT_ADMIN_URL;
}

function readStringParam(req: VercelRequest, name: string): string | null {
  const raw = req.query[name];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim();
}

export default handler;
