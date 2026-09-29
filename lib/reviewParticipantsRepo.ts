// lib/reviewParticipantsRepo.ts — "the reviews I have been part of".
//
// docs/plan/13-identity.md, batch AZ. A room id is the only record an ad-hoc
// session ever leaves in this app, and a curated review is reachable by anyone
// holding its link. Neither answers "which reviews was I in?", which is the
// question a person signed in to a deployment asks on Monday morning. This is
// the table that answers it, and the two functions that touch it.
//
// WHO IT RECORDS, AND WHO IT CANNOT
//
// Only a signed-in account. `signedInAccountId()` below is the single gate: a
// guest has no row (there is no account to key one on, and a supplier who was
// admitted to one review is not thereby given a history of the others), and a
// deployment on identity.mode 'none' never writes an accountId into vp_user in
// the first place — so the default install leaves this table empty without
// this file having to know anything about configuration.
//
// PRIVACY
//
// Row Level Security is the control, not a filter in this file: every policy on
// review_participants compares user_id to auth.uid() (docs/supabase-schema.sql),
// so a caller can only ever read or write their own rows, and the anon key the
// bundle carries — which has no auth.uid() — can read none at all. Who took
// part in a commercially sensitive design review is not public, which is why
// this is the one table in the schema that is not open. The queries below still
// name the account they mean; that is a second line, not the first.
//
// RELIABILITY
//
// Nothing here may break a room. Every failure is logged and answered with a
// value the caller can ignore — a missing "your reviews" list is an
// inconvenience, a review that will not open is not.

import { supabase } from './supabase';
import { getStoredIdentity } from './identity';

/** What somebody was in a review as. 'host' outranks 'participant'. */
export type ReviewRole = 'host' | 'participant';

/** One row of the lobby's "Your reviews" list. */
export interface MyReview {
  /** The room id, which for a curated review is also the curation id. */
  reviewId: string;
  role: ReviewRole;
  firstJoinedAt: string;
  lastJoinedAt: string;
  /** The curation's title, or null when this room was never curated. */
  title: string | null;
}

/**
 * The account this browser is signed in with, or null.
 *
 * The rule lives here rather than in each caller so that no caller can get it
 * wrong, and so that "a room must never write this for a guest" is a property
 * of the module rather than of whoever remembered to ask.
 */
function signedInAccountId(): string | null {
  const stored = getStoredIdentity();
  if (stored?.guest === true) return null;
  const accountId = stored?.accountId;
  return typeof accountId === 'string' && accountId !== '' ? accountId : null;
}

/** What the upsert writes. `role` is absent on purpose — see recordJoin. */
interface ParticipantRow {
  review_id: string;
  last_joined_at: string;
  role?: ReviewRole;
}

/**
 * Whether a room entry is worth recording, and as what — null when it is not.
 *
 * Split out from the page that calls it because the rule is the part worth
 * pinning down: somebody parked in the waiting room has not taken part in
 * anything yet, and the host is whoever the room server put first in its join
 * order, not whoever believes they started the meeting.
 *
 * A sessionHostId that has not arrived yet reads as 'participant'. HOST_CHANGE
 * follows JOIN_ADMITTED by one message, so the first write can happen before
 * this client learns it is the host; the caller writes again when it does, and
 * recordJoin only ever upgrades a role.
 */
export function joinRoleFor(state: {
  admitted: boolean;
  sessionHostId: string | null;
  localUserId: string;
}): ReviewRole | null {
  if (!state.admitted) return null;
  return state.sessionHostId === state.localUserId ? 'host' : 'participant';
}

interface ParticipantListRow {
  review_id: string;
  role: string;
  first_joined_at: string;
  last_joined_at: string;
}

/**
 * Record that the signed-in person took part in this review.
 *
 * One upsert on (review_id, user_id). Three details are load-bearing:
 *
 *   * `user_id` is NOT in the row. The column's default is auth.uid(), so
 *     Postgres fills it from the caller's own token and the insert policy
 *     (`with check (user_id = auth.uid())`) passes. Sending it from the client
 *     would mean asking the database to take our word for who we are, which is
 *     the one thing this table exists to avoid.
 *   * `first_joined_at` is NOT in the row either, so an existing row keeps the
 *     time it was first written and a new one gets now().
 *   * `role` is only sent when it is 'host'. On the INSERT path the column's
 *     own default supplies 'participant'; on the conflict path PostgREST
 *     updates only the columns present, so a host who rejoins a review as an
 *     ordinary participant does not downgrade the row, and a participant who
 *     later hosts does get upgraded. The role only ever moves one way.
 *
 * `last_joined_at` is sent explicitly because a default is not re-applied on
 * the conflict path — omitting it would leave the lobby's "3 days ago" frozen
 * at the first visit for ever.
 *
 * @returns false when there was nothing to record (no account) or the write
 *          failed. The caller is expected to ignore it.
 */
export async function recordJoin(reviewId: string, role: ReviewRole): Promise<boolean> {
  const accountId = signedInAccountId();
  if (!reviewId || !accountId) return false;

  const row: ParticipantRow = { review_id: reviewId, last_joined_at: new Date().toISOString() };
  if (role === 'host') row.role = role;

  try {
    const { error } = await supabase
      .from('review_participants')
      .upsert(row, { onConflict: 'review_id,user_id' });
    if (error) {
      console.error('[reviewParticipantsRepo] recordJoin failed:', error);
      return false;
    }
    return true;
  } catch (err) {
    // supabase-js reports failures as a result rather than a throw, but a
    // dropped network stack or a runtime without fetch can still raise here,
    // and this runs inside a room that is about to be used.
    console.error('[reviewParticipantsRepo] recordJoin threw:', err);
    return false;
  }
}

/**
 * Titles for a set of room ids, by a second query.
 *
 * Not a foreign-key join: an ad-hoc session has a room id and no
 * review_curations row, so a relation would either drop it from the list or
 * force a nullable foreign key the schema deliberately does not have. A missing
 * title is the ordinary case, and the caller renders "Session <short id>".
 */
async function titlesFor(ids: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  if (ids.length === 0) return titles;
  const { data, error } = await supabase.from('review_curations').select('id,title').in('id', ids);
  if (error) {
    // The list is still useful without titles, so this is not fatal to it.
    console.error('[reviewParticipantsRepo] title lookup failed:', error);
    return titles;
  }
  for (const row of (data ?? []) as Array<{ id: string; title: string | null }>) {
    if (row.id && row.title) titles.set(row.id, row.title);
  }
  return titles;
}

/**
 * The reviews this account has taken part in, most recently visited first.
 *
 * RLS has already narrowed the table to the caller's own rows; the `user_id`
 * filter is the second line behind it. Errors answer with an empty list, which
 * the lobby renders as its ordinary empty state — an install whose database
 * predates the table looks the same as one nobody has joined a review on yet.
 */
export async function listMyReviews(limit = 20): Promise<MyReview[]> {
  const accountId = signedInAccountId();
  if (!accountId) return [];

  try {
    const { data, error } = await supabase
      .from('review_participants')
      .select('review_id,role,first_joined_at,last_joined_at')
      .eq('user_id', accountId)
      .order('last_joined_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('[reviewParticipantsRepo] listMyReviews failed:', error);
      return [];
    }

    const rows = (data ?? []) as ParticipantListRow[];
    const titles = await titlesFor(rows.map((row) => row.review_id));
    return rows.map((row) => ({
      reviewId: row.review_id,
      // A value this code did not write — an older schema, a hand-edited row —
      // reads as the lesser role rather than as a host.
      role: row.role === 'host' ? 'host' : 'participant',
      firstJoinedAt: row.first_joined_at,
      lastJoinedAt: row.last_joined_at,
      title: titles.get(row.review_id) ?? null,
    }));
  } catch (err) {
    console.error('[reviewParticipantsRepo] listMyReviews threw:', err);
    return [];
  }
}

const MS_PER_DAY = 86_400_000;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * When somebody was last in a review, the way a person says it: "today",
 * "yesterday", "3 days ago", and after a week the date itself (in the same
 * en-GB short form the rest of the lobby uses).
 *
 * Counted in calendar days rather than 24-hour periods, so a review joined at
 * 23:50 was "today" and not "1 day ago" ten minutes later. `now` is a parameter
 * so the label is testable without a fake clock.
 */
export function describeLastVisit(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  // Rounding absorbs the hour a daylight-saving change takes out of a day.
  const days = Math.round((startOfDay(now) - startOfDay(then)) / MS_PER_DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
