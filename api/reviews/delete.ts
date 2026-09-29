// Deleting a design review, and deleting one of its sessions.
//
// docs/plan/15-sessions-and-variants.md batch BN. One endpoint with an `action`
// field, the shape api/reviews/lines.ts already uses, because the two are the same
// kind of thing — a decision about a review, made by somebody with a role in it,
// that removes several rows at once — and because they share every line of plumbing
// that makes them safe.
//
//   POST /api/reviews/delete   review | session
//
// WHY THE WRITES ARE HERE AND NOT IN THE BROWSER. Until this batch
// docs/supabase-schema.sql let the published anon key delete any row of
// review_curations, which removed a review's curation and left its meetings, its
// cards, its lines, its roster and its stored revisions behind: a tracker full of
// cards no review could be opened on. The delete policy is gone, DELETE on the
// table is revoked from the two browser roles, and the removal is
// `delete_review(p_review)` — one Postgres function, so one transaction, so a
// half-deleted review is impossible rather than merely unlikely.
//
// WHO MAY DO IT. `deleteReview` in lib/reviews/roles.ts: the review's owner and
// this install's admins, and NOT its editors. That is the plan's own table ("Only
// owners manage people or delete the review") and it is deliberately narrower than
// the `editReview` gate api/reviews/lines.ts uses — changing a review's lines is
// something an editor does every meeting, and unmaking the review is not. The
// check is made here, from the caller's own verified token and the roster as the
// database holds it right now, through the same helper lines.ts uses.
//
// A SESSION IS REFUSED WHEN A VARIANT STARTS FROM IT. review_lines.parent_session_id
// is the stop the map draws the variant leaving from; removing the stop would leave
// a side line floating in mid-air. The refusal names the variant, and the same
// question is asked again inside the function, where it cannot be raced.
//
// SESSION NUMBERS ARE NOT REUSED AND NOT RENUMBERED. tracker_sessions.seq stays as
// it is, so a card that says it was raised in S3 goes on saying that.
//
// STORED MODEL FILES ARE NOT DELETED. They are content-addressed —
// model_revisions.hash is the name a file is stored under — so the same bytes can
// be two reviews' Rev B, and removing them for one would break the other.
//
// THE WORDS ARE THE SPEC. Every sentence this endpoint answers is shown to a
// person in a meeting or in the lobby. Never branch, fork, merge or commit.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import { can } from '../../lib/reviews/roles.ts';
import { shortLineLabel, toReviewLine, type ReviewLine } from '../../lib/reviews/lines.ts';
import { postgrestFetch } from '../_lib/postgrest.ts';
import { countsDetail, recordAudit } from '../_lib/audit.ts';
import {
  bodyRecord,
  bodyString,
  callerFor,
  enc,
  json,
  rpc,
  storeFailure,
  type Caller,
  type RpcAnswer,
} from './_lib/reviewCaller.ts';

/** What this endpoint's own database failures are logged as. */
const TAG = 'reviews/delete';

/** Enough of a line to say which variant is in the way, by name. */
const LINE_COLUMNS =
  'id,review_id,kind,name,letter,parent_session_id,status,created_by,created_by_name,created_at,closed_at';

/**
 * "Variant A starts from this session."
 *
 * Built here rather than in the database so that the name in the refusal is the one
 * lib/reviews/lines.ts says it is, in the one file that decides those.
 */
function blockedByVariant(line: ReviewLine | null): string {
  const label = shortLineLabel(line) ?? 'A variant';
  return `${label} starts from this session. Delete or drop the variant’s sessions first.`;
}

/** The variant that leaves from this meeting, or null when none does. */
async function readVariantFrom(sessionId: string): Promise<ReviewLine | null> {
  const rows = (await json(
    await postgrestFetch(
      `review_lines?parent_session_id=eq.${enc(sessionId)}&select=${LINE_COLUMNS}&order=created_at.asc&limit=1`,
    ),
    'the variant read',
    TAG,
  )) as Array<Record<string, unknown>>;
  return toReviewLine(Array.isArray(rows) ? rows[0] : undefined);
}

/** Whether this meeting is one of this review's, which is what the id claims. */
async function sessionBelongsTo(sessionId: string, reviewId: string): Promise<boolean> {
  const rows = (await json(
    await postgrestFetch(`tracker_sessions?id=eq.${enc(sessionId)}&select=id,review_id&limit=1`),
    'the session read',
    TAG,
  )) as Array<Record<string, unknown>>;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return false;
  const owner = typeof row['review_id'] === 'string' && row['review_id'] !== '' ? row['review_id'] : null;
  // A meeting with no review at all is not this review's to delete, and saying so
  // is truer than deleting it: the id in the request came from a map of THIS review.
  return owner === reviewId;
}

function countOf(answer: RpcAnswer, key: string): number {
  const value = answer[key];
  return typeof value === 'number' ? value : 0;
}

/** The refusal one of the two functions answers with, as a status and a sentence. */
function refusal(answer: RpcAnswer, reviewId: string): { status: number; error: string } | null {
  if (answer.ok === true) return null;
  const reason = typeof answer.error === 'string' ? answer.error : '';
  if (reason === 'no_such_review' || reason === 'no_such_session') {
    // Asked for something that is not there, and the outcome wanted is that it is
    // not there. Two screens deleting the same review at the same moment is the
    // only way to reach it, and neither should be told it failed.
    return null;
  }
  if (reason === 'variant_starts_here') {
    return {
      status: 409,
      // Through the one parser rather than a second reading of the row: it is what
      // checks `kind` and `letter`, and a label this endpoint shows a room has to
      // be the label the map shows for the same line.
      error: blockedByVariant(
        toReviewLine({
          id: answer['lineId'],
          review_id: reviewId,
          kind: answer['kind'],
          name: answer['name'],
          letter: answer['letter'],
          status: 'active',
        }),
      ),
    };
  }
  return { status: 502, error: 'That could not be deleted. Try again.' };
}

/** The review's name for an audit row; empty when it cannot be read. */
async function readReviewTitle(reviewId: string): Promise<string> {
  try {
    const res = await postgrestFetch(`review_curations?id=eq.${enc(reviewId)}&select=title&limit=1`);
    if (!res || !res.ok) return '';
    const rows = (await res.json()) as Array<{ title?: unknown }>;
    return typeof rows[0]?.title === 'string' ? rows[0].title : '';
  } catch {
    return '';
  }
}

async function deleteReview(res: VercelResponse, reviewId: string, caller: Caller): Promise<void> {
  // Read before it is gone, for the audit row.
  const title = await readReviewTitle(reviewId);
  const answer = await rpc('rpc/delete_review', { p_review: reviewId }, TAG);
  const refused = refusal(answer, reviewId);
  if (refused) {
    if (refused.status >= 500) console.error(`[${TAG}] delete_review refused: ${String(answer.error)}`);
    res.status(refused.status).json({ error: refused.error });
    return;
  }
  await recordAudit({
    action: 'review_deleted', roomId: reviewId, actorId: caller.accountId, actorName: caller.name,
    subjectId: reviewId, subjectName: title,
    detail: countsDetail([[countOf(answer, 'sessions'), 'session', 'sessions'], [countOf(answer, 'items'), 'card', 'cards']]),
  });
  res.status(200).json({
    ok: true,
    action: 'review',
    reviewId,
    sessions: countOf(answer, 'sessions'),
    items: countOf(answer, 'items'),
  });
}

async function deleteSession(
  res: VercelResponse,
  reviewId: string,
  sessionId: string,
  caller: Caller,
): Promise<void> {
  if (!(await sessionBelongsTo(sessionId, reviewId))) {
    res.status(404).json({ error: 'That session is not part of this design review.' });
    return;
  }
  // Asked first so the refusal can name the variant. The function asks again inside
  // its own transaction, which is the one that cannot be raced by a variant started
  // in the moment between this read and the delete.
  const blocking = await readVariantFrom(sessionId);
  if (blocking) {
    res.status(409).json({ error: blockedByVariant(blocking) });
    return;
  }

  const answer = await rpc('rpc/delete_review_session', { p_session: sessionId }, TAG);
  const refused = refusal(answer, reviewId);
  if (refused) {
    if (refused.status >= 500) {
      console.error(`[${TAG}] delete_review_session refused: ${String(answer.error)}`);
    }
    res.status(refused.status).json({ error: refused.error });
    return;
  }
  await recordAudit({
    action: 'session_deleted', roomId: reviewId, actorId: caller.accountId, actorName: caller.name,
    subjectId: sessionId, subjectName: await readReviewTitle(reviewId),
    detail: countsDetail([[countOf(answer, 'items'), 'card', 'cards']]),
  });
  res.status(200).json({
    ok: true,
    action: 'session',
    reviewId,
    sessionId,
    items: countOf(answer, 'items'),
  });
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error(`[${TAG}] failed to load config:`, err);
    res.status(500).json({ error: 'config_unavailable' });
    return;
  }
  const identity = identityOf(config);
  const accountsOn = identity.mode === 'accounts' || identity.mode === 'sso';

  const body = bodyRecord(req);
  const reviewId = bodyString(body, 'reviewId');
  if (!reviewId) {
    res.status(400).json({ error: 'reviewId is required' });
    return;
  }
  const action = bodyString(body, 'action');
  if (action !== 'review' && action !== 'session') {
    res.status(400).json({ error: 'action must be review or session' });
    return;
  }
  const sessionId = action === 'session' ? bodyString(body, 'sessionId') : null;
  if (action === 'session' && !sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }

  try {
    const caller = await callerFor(req, body, reviewId, accountsOn, TAG);
    if (!caller) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // With accounts, the owner and the admins. On a deployment with NO accounts
    // there is nobody to ask: it has no signed-in callers, no roster and no owner
    // column anybody can fill, so the caller's own claim is taken as it is — the
    // way api/reviews/lines.ts takes the meeting host's — and what guards the
    // install is the front-door password on the origin. That is the same guard the
    // row level security policy this batch removed relied on, and the same one
    // under which the published anon key could until now delete any curation row
    // outright, so this endpoint is a tightening of what such an install allowed
    // and not a widening: what it adds is that the whole review goes, in one
    // transaction, instead of the curation row alone.
    if (accountsOn && !can(caller.role, 'deleteReview')) {
      res.status(403).json({
        error: 'Only the owner of this design review, or an administrator, can delete it.',
      });
      return;
    }

    if (action === 'review') {
      await deleteReview(res, reviewId, caller);
    } else if (sessionId) {
      await deleteSession(res, reviewId, sessionId, caller);
    }
  } catch (err) {
    const failure = storeFailure(err);
    if (failure) {
      if (failure.status >= 500) console.error(`[${TAG}] ${failure.body['error']}`);
      res.status(failure.status).json(failure.body);
    } else {
      console.error(`[${TAG}] unhandled:`, err);
      res.status(500).json({ error: 'internal_error' });
    }
  }
}

export default handler;
