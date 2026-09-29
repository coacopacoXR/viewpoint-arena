// Who is on a design review, and who may change that.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH, the People tab. This endpoint
// is NOT under api/admin: managing a review's people is the review OWNER's job,
// not an administrator's, and putting it behind requireAdmin would have meant an
// owner who is not an admin could not add an editor to their own review.
//
// GET  /api/reviews/members?reviewId=…  the roster, with names
// POST /api/reviews/members             add | setRole | remove | claimOwner
//
// Two reasons the writes go through here rather than from the browser:
//
//   1. review_members is READ-ONLY to the public key. docs/supabase-schema.sql
//      allows a signed-in person to insert or update only their OWN owner row,
//      precisely so that holding the published anon key is not holding the
//      ability to make yourself an editor of somebody else's review. Everything
//      else needs the service role, which only the api can mint.
//   2. The permission check has to be somewhere a client cannot lift with
//      devtools. lib/reviews/roles.ts decides it, here, from the caller's
//      verified token and the roster as the database holds it right now.
//
// Adding a person needs an ACCOUNT, and an account is looked up by email through
// GoTrue's admin API. That is also why a review's people are never guests: a
// guest has no account to key a row on, and a row keyed on a name somebody typed
// would be a permission granted to whoever typed it.
//
// 404 in identity.mode 'none'. There are no accounts there, so there is no
// roster to manage — the People tab is absent and the meeting host edits freely,
// exactly as the curate page always allowed.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import { verifyAccessToken } from '../../lib/auth/verifyJwt.ts';
import { can, asMemberRole, resolveRole, type MemberRole, type ReviewMember, type Role } from '../../lib/reviews/roles.ts';
import { getServiceRoleToken } from '../_lib/serviceRole.ts';
import { postgrestFetch } from '../_lib/postgrest.ts';

const DEFAULT_ADMIN_URL = 'http://auth:9999';

/** The roles an owner may hand out. 'owner' is not one of them — see setRole. */
const ASSIGNABLE_ROLES: readonly MemberRole[] = ['editor', 'participant'];

/** One roster row with the account's name attached, which is what the tab shows. */
export interface MemberWithAccount extends ReviewMember {
  name: string;
  email: string;
}

interface GoTrueUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
}

// ─── GoTrue ─────────────────────────────────────────────────────────────────

async function gotrueFetch(path: string): Promise<Response> {
  const config = await loadConfig();
  const identity = identityOf(config);
  const base = identity.mode === 'none' ? '' : (identity.adminUrl ?? DEFAULT_ADMIN_URL);
  if (!base) throw new Error('identity_not_configured');

  const token = getServiceRoleToken();
  if (!token) throw new Error('service_role_unavailable');

  return fetch(`${base.replace(/\/+$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
}

/**
 * Every account, as an id → name/email map.
 *
 * Read as one page rather than one request per member: the tab lists a handful
 * of people and GoTrue's admin list is the only way to turn a uuid into the name
 * somebody recognises. `filter` narrows the search when GoTrue supports it and
 * is simply ignored when it does not, so the exact match below is what decides.
 */
async function listAccounts(): Promise<Map<string, { name: string; email: string }>> {
  const res = await gotrueFetch('/admin/users?per_page=1000');
  if (!res.ok) {
    console.error(`[reviews/members] GoTrue list failed: ${res.status}`);
    throw new Error('upstream_error');
  }
  const data = (await res.json()) as { users?: GoTrueUser[] };
  const accounts = new Map<string, { name: string; email: string }>();
  for (const user of data.users ?? []) {
    if (typeof user.id !== 'string' || user.id === '') continue;
    const metadata = user.user_metadata ?? {};
    const email = typeof user.email === 'string' ? user.email : '';
    const fullName = typeof metadata.full_name === 'string' ? metadata.full_name.trim() : '';
    // The lobby's own rule (displayNameForAccount) rather than a second idea of
    // what somebody is called: the name in this tab and the name in the room
    // come from the same place.
    const name = fullName || (email.includes('@') ? email.split('@')[0] : email);
    accounts.set(user.id, { name, email });
  }
  return accounts;
}

/** The account with this email address, or null. Case-insensitive, as emails are. */
async function findAccountByEmail(email: string): Promise<{ id: string; name: string } | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  const res = await gotrueFetch(`/admin/users?per_page=1000&filter=${encodeURIComponent(email.trim())}`);
  if (!res.ok) {
    console.error(`[reviews/members] GoTrue search failed: ${res.status}`);
    throw new Error('upstream_error');
  }
  const data = (await res.json()) as { users?: GoTrueUser[] };
  for (const user of data.users ?? []) {
    if (typeof user.email !== 'string') continue;
    if (user.email.toLowerCase() !== wanted) continue;
    const metadata = user.user_metadata ?? {};
    const fullName = typeof metadata.full_name === 'string' ? metadata.full_name.trim() : '';
    const name = fullName || user.email.split('@')[0];
    return { id: user.id, name };
  }
  return null;
}

// ─── The roster, as the database holds it ───────────────────────────────────

interface Roster {
  ownerId: string | null;
  members: ReviewMember[];
}

/**
 * review_curations.owner_id and the review_members rows.
 *
 * Throws 'store_unavailable' when the database cannot be reached at all, which
 * the handler turns into a 503 — an operator's problem, not the caller's. A
 * review with no rows is a normal answer: it is ownerless and empty, and the tab
 * offers an admin the claim.
 */
async function readRoster(reviewId: string): Promise<Roster> {
  const id = encodeURIComponent(reviewId);
  const [curationRes, membersRes] = await Promise.all([
    postgrestFetch(`review_curations?id=eq.${id}&select=owner_id`),
    postgrestFetch(`review_members?review_id=eq.${id}&select=user_id,role`),
  ]);
  if (!curationRes || !membersRes) throw new Error('store_unavailable');
  if (!curationRes.ok || !membersRes.ok) {
    console.error(`[reviews/members] read failed: ${curationRes.status} / ${membersRes.status}`);
    throw new Error('upstream_error');
  }

  const curations = (await curationRes.json()) as Array<{ owner_id?: unknown }>;
  const rawOwner = curations[0]?.owner_id;
  const ownerId = typeof rawOwner === 'string' && rawOwner !== '' ? rawOwner : null;

  const rows = (await membersRes.json()) as Array<Record<string, unknown>>;
  const members: ReviewMember[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = row['user_id'];
    if (typeof userId !== 'string' || userId === '') continue;
    // asMemberRole's rule: a value this code has never heard of is "no
    // membership row", never the most permissive thing a fallback would give.
    const role = asMemberRole(row['role']);
    if (!role) continue;
    members.push({ userId, role });
  }
  return { ownerId, members };
}

// ─── Request plumbing ───────────────────────────────────────────────────────

function bearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

function queryValue(req: VercelRequest, key: string): string | null {
  const raw = req.query[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function bodyRecord(req: VercelRequest): Record<string, unknown> {
  const body = req.body;
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function bodyString(body: Record<string, unknown>, key: string): string | null {
  const raw = body[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

interface Caller {
  accountId: string;
  isAdmin: boolean;
  role: Role;
}

/**
 * Who is asking, and what this review says about them.
 *
 * `isMeetingHost` is false because it is meaningless here: that fact only
 * changes a role on a deployment with no accounts, and this endpoint does not
 * exist on one.
 */
function callerFor(accountId: string, isAdmin: boolean, roster: Roster): Caller {
  const role = resolveRole({
    identityMode: 'accounts',
    accountId,
    isGuest: false,
    members: roster.members,
    ownerId: roster.ownerId,
    isAdmin,
    isMeetingHost: false,
  });
  return { accountId, isAdmin, role };
}

async function writeMemberRow(
  reviewId: string,
  userId: string,
  role: MemberRole,
  addedBy: string,
): Promise<void> {
  // Upsert on the (review_id, user_id) primary key: adding somebody who is
  // already on the roster re-roles them rather than failing on a duplicate.
  const res = await postgrestFetch('review_members', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ review_id: reviewId, user_id: userId, role, added_by: addedBy }),
  });
  if (!res) throw new Error('store_unavailable');
  if (!res.ok) {
    console.error(`[reviews/members] upsert failed: ${res.status}`);
    throw new Error('upstream_error');
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[reviews/members] failed to load config:', err);
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }

  const identity = identityOf(config);
  if (identity.mode === 'none') {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const secret = process.env.JWT_SECRET ?? '';
  if (!secret) {
    console.error('[reviews/members] JWT_SECRET is not set but identity mode requires it');
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const verified = await verifyAccessToken(token, secret);
  if (!verified) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const reviewId = req.method === 'GET' ? queryValue(req, 'reviewId') : bodyString(bodyRecord(req), 'reviewId');
  if (!reviewId) {
    res.status(400).json({ error: 'reviewId is required' });
    return;
  }

  try {
    const roster = await readRoster(reviewId);
    const caller = callerFor(verified.sub, verified.role === 'admin', roster);

    if (req.method === 'GET') {
      await handleRead(res, caller, roster);
    } else {
      await handleWrite(req, res, caller, roster, reviewId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    if (message === 'identity_not_configured') {
      res.status(404).json({ error: 'not_found' });
    } else if (message === 'service_role_unavailable') {
      console.error('[reviews/members] JWT_SECRET is not set');
      res.status(500).json({ error: 'config_unavailable' });
    } else if (message === 'store_unavailable') {
      res.status(503).json({ error: 'The database could not be reached. Try again.' });
    } else if (message === 'upstream_error') {
      res.status(502).json({ error: 'upstream_error' });
    } else {
      console.error('[reviews/members] unhandled:', err);
      res.status(500).json({ error: 'internal_error' });
    }
  }
}

/**
 * The roster for the People tab.
 *
 * Owners and editors only. Reading WHO is on a review is not the same as reading
 * that a review exists — the roster carries account ids and, once resolved here,
 * names and email addresses, and a participant or a guest has no business with
 * either. The database leaves review_members readable by the public key because
 * a screen has to be able to work out its own role from it; that is a read of
 * ids by the person holding them, not a directory.
 */
async function handleRead(res: VercelResponse, caller: Caller, roster: Roster): Promise<void> {
  if (!can(caller.role, 'editReview')) {
    res.status(403).json({ error: 'Only the owner and the editors of this design review can see its people.' });
    return;
  }

  const accounts = await listAccounts();
  const members: MemberWithAccount[] = roster.members.map((member) => {
    const account = accounts.get(member.userId);
    return {
      ...member,
      name: account?.name ?? '',
      email: account?.email ?? '',
    };
  });
  // Owner first, then editors, then participants: the order the tab reads in,
  // and the order that makes an ownerless review obvious.
  const rank: Record<MemberRole, number> = { owner: 0, editor: 1, participant: 2 };
  members.sort((a, b) => rank[a.role] - rank[b.role]);

  res.status(200).json({
    ownerId: roster.ownerId,
    // The tab renders its controls from this rather than re-deriving the rule:
    // an editor sees the list and no buttons, an owner sees both.
    canManage: can(caller.role, 'managePeople'),
    // An admin who is NOT the owner is offered the claim only while the review
    // has no owner at all — see claimOwner.
    canClaimOwner: caller.isAdmin && roster.ownerId === null,
    members,
  });
}

async function handleWrite(
  req: VercelRequest,
  res: VercelResponse,
  caller: Caller,
  roster: Roster,
  reviewId: string,
): Promise<void> {
  const body = bodyRecord(req);
  const action = bodyString(body, 'action');

  if (action !== 'add' && action !== 'setRole' && action !== 'remove' && action !== 'claimOwner') {
    res.status(400).json({ error: 'action must be add, setRole, remove or claimOwner' });
    return;
  }

  // Claiming is an admin's answer to a review that predates accounts, and it is
  // checked before managePeople because an ownerless review has nobody to ask:
  // resolveRole already answers 'owner' for an admin here, so the two agree.
  if (action !== 'claimOwner' && !can(caller.role, 'managePeople')) {
    res.status(403).json({ error: 'Only the owner of this design review can change its people.' });
    return;
  }

  if (action === 'claimOwner') {
    await handleClaimOwner(res, caller, roster, reviewId);
    return;
  }

  if (action === 'add') {
    await handleAdd(res, caller, roster, reviewId, body);
    return;
  }

  const userId = bodyString(body, 'userId');
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  if (roster.ownerId !== null && userId === roster.ownerId) {
    // The owner's row is what review_curations.owner_id already says. Re-roling
    // it would leave the column and the roster disagreeing about who owns the
    // review, and removing it would leave an owner who is not on their own
    // review's People tab. Transferring ownership is a different operation.
    res.status(409).json({ error: 'The owner cannot be re-rolled or removed. Transfer ownership instead.' });
    return;
  }
  if (!roster.members.some((member) => member.userId === userId)) {
    res.status(404).json({ error: 'That person is not on this review.' });
    return;
  }

  if (action === 'setRole') {
    const requested = asMemberRole(bodyString(body, 'role'));
    if (!requested || !ASSIGNABLE_ROLES.includes(requested)) {
      res.status(400).json({ error: 'role must be editor or participant' });
      return;
    }
    const res2 = await postgrestFetch(
      `review_members?review_id=eq.${encodeURIComponent(reviewId)}&user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role: requested }) },
    );
    if (!res2) {
      res.status(503).json({ error: 'The database could not be reached. Try again.' });
      return;
    }
    if (!res2.ok) {
      console.error(`[reviews/members] setRole failed: ${res2.status}`);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }
    res.status(200).json({ ok: true, userId, role: requested });
    return;
  }

  const removed = await postgrestFetch(
    `review_members?review_id=eq.${encodeURIComponent(reviewId)}&user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
  if (!removed) {
    res.status(503).json({ error: 'The database could not be reached. Try again.' });
    return;
  }
  if (!removed.ok) {
    console.error(`[reviews/members] remove failed: ${removed.status}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  res.status(200).json({ ok: true, userId, removed: true });
}

/**
 * Add somebody by email address.
 *
 * The account must already exist on this install: inviting is the admin
 * console's job (POST /api/admin/users), and this endpoint creating an account
 * would have meant an owner could mint a login for an address they do not
 * control. An email that matches no account is a 404 with the sentence that
 * says what to do about it.
 */
async function handleAdd(
  res: VercelResponse,
  caller: Caller,
  roster: Roster,
  reviewId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const email = bodyString(body, 'email');
  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  const requested = asMemberRole(bodyString(body, 'role')) ?? 'participant';
  if (!ASSIGNABLE_ROLES.includes(requested)) {
    res.status(400).json({ error: 'role must be editor or participant' });
    return;
  }

  const account = await findAccountByEmail(email);
  if (!account) {
    res.status(404).json({
      error: 'Nobody on this install signs in with that email address. Ask an administrator to create their account first.',
    });
    return;
  }
  if (roster.ownerId !== null && account.id === roster.ownerId) {
    res.status(409).json({ error: 'That person already owns this review.' });
    return;
  }

  await writeMemberRow(reviewId, account.id, requested, caller.accountId);
  res.status(200).json({
    ok: true,
    member: { userId: account.id, role: requested, name: account.name, email: email.trim() },
  });
}

/**
 * "This review has no owner. Make me the owner."
 *
 * For every review created before accounts existed: owner_id is NULL, so
 * resolveRole answers 'owner' for any admin of the install and 'participant' for
 * everybody else — which means without this nobody could ever administer one.
 *
 * The update is guarded with `owner_id=is.null` in the URL, so two admins
 * clicking at the same moment produce one owner: the first PATCH matches a row,
 * the second matches none and is told the review has just been claimed. The
 * member row is written only once the column took, because the roster and the
 * column must never disagree about who owns a review.
 */
async function handleClaimOwner(
  res: VercelResponse,
  caller: Caller,
  roster: Roster,
  reviewId: string,
): Promise<void> {
  if (roster.ownerId !== null) {
    res.status(409).json({ error: 'This review already has an owner.' });
    return;
  }
  if (!caller.isAdmin) {
    res.status(403).json({ error: 'Only an administrator can claim a review that has no owner.' });
    return;
  }

  const id = encodeURIComponent(reviewId);
  const claimed = await postgrestFetch(`review_curations?id=eq.${id}&owner_id=is.null`, {
    method: 'PATCH',
    // count=exact asks PostgREST to say how many rows the PATCH matched, which
    // is the only way to tell "I claimed it" from "somebody else did a moment
    // ago": both answer 200.
    headers: { Prefer: 'return=minimal, count=exact' },
    body: JSON.stringify({ owner_id: caller.accountId }),
  });
  if (!claimed) {
    res.status(503).json({ error: 'The database could not be reached. Try again.' });
    return;
  }
  if (!claimed.ok) {
    console.error(`[reviews/members] claim failed: ${claimed.status}`);
    res.status(502).json({ error: 'upstream_error' });
    return;
  }
  // Content-Range is `0-0/1` when a row was updated and `*/0` when the filter
  // matched none. Only the star form means the guard lost a race.
  const range = claimed.headers.get('content-range');
  if (range !== null && range.startsWith('*/')) {
    res.status(409).json({ error: 'This review has just been claimed by somebody else.' });
    return;
  }

  await writeMemberRow(reviewId, caller.accountId, 'owner', caller.accountId);
  res.status(200).json({ ok: true, ownerId: caller.accountId, claimed: true });
}

export default handler;
