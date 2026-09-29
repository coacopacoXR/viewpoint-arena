// Starting a variant, adopting one into the main line, and dropping one.
//
// docs/plan/15-sessions-and-variants.md batch BL. One endpoint with an `action`
// field rather than three, because the three are the same shape of thing — a
// decision about a line, made by somebody with a role in the review, that moves
// several rows at once — and because they share every line of plumbing that makes
// them safe.
//
//   POST /api/reviews/lines   explore | adopt | drop
//
// WHY THE WRITES ARE HERE AND NOT IN THE BROWSER. docs/supabase-schema.sql used to
// let the published anon key insert and update review_lines freely, which was
// harmless while the only write was `ensureMainLine` and is not harmless now:
// adopting a variant re-homes every card it raised and changes what the main line
// opens on, and dropping one closes other people's open risks with a reason. So the
// schema now allows the browser exactly one insert — a `kind='main'` row — and no
// update or delete at all, and the two multi-row writes are the Postgres functions
// `adopt_review_line` and `drop_review_line`, executable by the service role alone.
// One function call is one transaction, which is what makes a half-adopted variant
// impossible rather than merely unlikely: cards moved and status still 'active' is
// a variant that can be adopted twice, and cards closed with no variant marked
// dropped is a set of risks nobody can find again.
//
// WHO MAY DO IT. All three are `editReview` in lib/reviews/roles.ts — the review's
// owners and editors, and on a deployment with no accounts the meeting host. They
// are deliberately NOT three new named actions: the table in roles.ts reads as four
// levels of trust, and "may start a variant" is not a fifth level, it is the same
// permission as "may change the review's agenda, viewpoints, pins and models". A
// new row per capability would bury that and cost nothing at runtime, because the
// answer is identical. The check is made here, from the caller's own verified token
// and the roster as the database holds it right now, the way
// api/reviews/members.ts makes it — a rule in the UI is a rule anybody can lift.
//
// identity.mode 'none' is served, not 404'd (unlike the People endpoint, which has
// no roster to manage without accounts). There is no token to verify there, so the
// caller's claim to be the meeting host is taken as it is: on such an install the
// anon key in the browser bundle could until this batch write these rows outright,
// and the room server — which is where the claim is actually checked for anything
// that matters — has nothing better to go on either.
//
// THE WORDS ARE THE SPEC. Every sentence this endpoint answers is shown to a person
// in a meeting. Never branch, fork, merge or commit.

import { countsDetail, recordAudit } from '../_lib/audit.ts';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { identityOf } from '../../lib/config/schema.ts';
import { can } from '../../lib/reviews/roles.ts';
import {
  lineLabel,
  MAIN_LINE_NAME,
  activeChildrenOf,
  droppedCardReason,
  isDescendantOf,
  isMainLine,
  lineById,
  mainLineOf,
  mergeTargetWord,
  nextVariantLetter,
  shortLineLabel,
  toReviewLine,
  type ReviewLine,
} from '../../lib/reviews/lines.ts';
import {
  adoptPlan,
  adoptRevisionIds,
  asAdoptKeep,
  type AdoptableRevision,
} from '../../lib/reviews/adopt.ts';
import { postgrestFetch } from '../_lib/postgrest.ts';
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
const TAG = 'reviews/lines';

/**
 * What a line is called, read back. `adopted_revision_ids` is not here: see
 * readAdoptedScenes. The two batch BX columns ARE here, and the read falls back to a
 * list without them for an install whose schema has not caught up — a line read that
 * fails on a column is a line read that answers "this review has no lines", which is
 * how a whole review's variants disappear rather than how one label goes missing.
 */
const LINE_COLUMNS =
  'id,review_id,kind,name,letter,parent_session_id,parent_line_id,merged_into_line_id,drop_reason,status,created_by,created_by_name,created_at,closed_at';
const LINE_COLUMNS_WITHOUT_BX =
  'id,review_id,kind,name,letter,parent_session_id,status,created_by,created_by_name,created_at,closed_at';

/** A variant's name is a phrase somebody says out loud, not a paragraph. */
const MAX_NAME = 80;
/** Same for the reason a variant was dropped, which ends up on every card it closes. */
const MAX_REASON = 200;

/** One meeting, as far as a scene decision needs it. */
interface SessionRow {
  id: string;
  reviewId: string | null;
  lineId: string | null;
  endedAt: string;
  revisionIds: string[];
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** Postgres' "column … does not exist", as PostgREST reports it in the body. */
function isMissingColumn(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  return (body as Record<string, unknown>)['code'] === '42703';
}

function parsedLines(rows: unknown): ReviewLine[] {
  const lines: ReviewLine[] = [];
  for (const row of Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []) {
    const line = toReviewLine(row);
    if (line) lines.push(line);
  }
  return lines;
}

async function readLines(reviewId: string): Promise<ReviewLine[]> {
  const url = (columns: string) => `review_lines?review_id=eq.${enc(reviewId)}&select=${columns}`;
  const first = await postgrestFetch(url(LINE_COLUMNS));
  // Everything that is not "this database has no such column" goes through `json`,
  // so a store that is down or a key that is wrong still reaches `storeFailure` in the
  // handler as the sentence it has always been rather than as an empty line list.
  if (!first || first.ok || !isMissingColumn(await first.clone().json().catch(() => null))) {
    return parsedLines(await json(first, 'the line read', TAG));
  }
  return parsedLines(await json(await postgrestFetch(url(LINE_COLUMNS_WITHOUT_BX)), 'the line read', TAG));
}

function toSessionRow(row: Record<string, unknown> | undefined): SessionRow | null {
  if (!row) return null;
  const id = typeof row['id'] === 'string' ? row['id'] : '';
  if (!id) return null;
  const raw = row['revision_ids'];
  return {
    id,
    reviewId: typeof row['review_id'] === 'string' ? row['review_id'] : null,
    lineId: typeof row['line_id'] === 'string' && row['line_id'] !== '' ? row['line_id'] : null,
    endedAt: typeof row['ended_at'] === 'string' ? row['ended_at'] : '',
    revisionIds: Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

const SESSION_COLUMNS = 'id,review_id,line_id,ended_at,revision_ids';

async function readSession(id: string): Promise<SessionRow | null> {
  const rows = (await json(
    await postgrestFetch(`tracker_sessions?id=eq.${enc(id)}&select=${SESSION_COLUMNS}&limit=1`),
    'the session read',
    TAG,
  )) as Array<Record<string, unknown>>;
  return toSessionRow(Array.isArray(rows) ? rows[0] : undefined);
}

/** The newest meeting on one line, or null when it has not met. */
async function readLastSession(lineId: string): Promise<SessionRow | null> {
  const rows = (await json(
    await postgrestFetch(
      `tracker_sessions?line_id=eq.${enc(lineId)}&select=${SESSION_COLUMNS}&order=ended_at.desc&limit=1`,
    ),
    'the last session read',
    TAG,
  )) as Array<Record<string, unknown>>;
  return toSessionRow(Array.isArray(rows) ? rows[0] : undefined);
}

async function readRevisions(reviewId: string): Promise<AdoptableRevision[]> {
  const rows = (await json(
    await postgrestFetch(`model_revisions?review_id=eq.${enc(reviewId)}&select=id,line,revision&order=created_at.asc`),
    'the revision read',
    TAG,
  )) as Array<Record<string, unknown>>;
  const revisions: AdoptableRevision[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = typeof row['id'] === 'string' ? row['id'] : '';
    const line = typeof row['line'] === 'string' ? row['line'] : '';
    const revision = typeof row['revision'] === 'string' ? row['revision'] : '';
    if (!id || !line || !revision) continue;
    revisions.push({ id, line, revision });
  }
  return revisions;
}

/** One merged variant's contribution to the line it went into. */
interface MergedScene {
  closedAt: string;
  revisionIds: string[];
  /** The line it was merged into, or null for a row written before batch BX. */
  mergedInto: string | null;
}

/**
 * Every merge this review has made, newest-relevant last.
 *
 * Read with `merged_into_line_id` and retried without it for an install whose schema
 * has not caught up, for the reason `readLines` does: there the column is absent, and
 * every merge that ever happened went into the main line, so a null is the truth
 * about those rows rather than a missing fact.
 */
async function readMergedScenes(reviewId: string): Promise<MergedScene[]> {
  const parse = (rows: unknown, withTarget: boolean): MergedScene[] => {
    const out: MergedScene[] = [];
    for (const row of Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []) {
      const ids = Array.isArray(row['adopted_revision_ids'])
        ? (row['adopted_revision_ids'] as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      if (ids.length === 0) continue;
      const target = row['merged_into_line_id'];
      out.push({
        closedAt: typeof row['closed_at'] === 'string' ? row['closed_at'] : '',
        revisionIds: ids,
        mergedInto: withTarget && typeof target === 'string' && target !== '' ? target : null,
      });
    }
    return out;
  };
  const base = `review_lines?review_id=eq.${enc(reviewId)}&status=eq.adopted&select=`;
  const first = await postgrestFetch(`${base}closed_at,adopted_revision_ids,merged_into_line_id`);
  if (!first || first.ok || !isMissingColumn(await first.clone().json().catch(() => null))) {
    return parse(await json(first, 'the adoption read', TAG), true);
  }
  return parse(await json(await postgrestFetch(`${base}closed_at,adopted_revision_ids`), 'the adoption read', TAG), false);
}

/**
 * What ONE LINE is showing now.
 *
 * The same derivation lib/reviews/linesRepo.originRevisionIds makes in the browser,
 * and it has to be the same one: this is what a merge is decided against and what a
 * room will open on afterwards, so the two disagreeing would mean the question asked
 * in a meeting was not the question the scene answered.
 *
 * Batch BX made it about any line rather than about the main line, because a merge
 * can now go into a variant — and the two halves of that generalisation are the ones
 * linesRepo has: a merge counts for the line it went INTO (`merged_into_line_id`, so
 * merging Variant B into Variant A does not silently change what the main line shows)
 * and only while it is NEWER than that line's last meeting, and a variant with nothing
 * of its own falls back to the line it was started from rather than to the review's
 * newest upload.
 */
async function lineSceneNow(
  reviewId: string,
  lines: readonly ReviewLine[],
  line: ReviewLine | null,
  budget: number,
): Promise<string[]> {
  if (!line || budget <= 0) return [];

  const merged = await readMergedScenes(reviewId);
  // A row with no recorded target is one written before batch BX, and every merge
  // before this batch went into the main line — so it counts for the main line only.
  const into = merged.filter((each) =>
    each.mergedInto === line.id || (each.mergedInto === null && isMainLine(line)),
  );
  let newestAt = '';
  let newest: string[] = [];
  for (const each of into) {
    if (newest.length === 0 || each.closedAt > newestAt) {
      newestAt = each.closedAt;
      newest = each.revisionIds;
    }
  }

  const last = await readLastSession(line.id);
  if (isMainLine(line)) {
    if (newest.length > 0 && (!last?.endedAt || newestAt > last.endedAt)) return newest;
    return last?.revisionIds ?? [];
  }
  if (last && last.revisionIds.length > 0) return last.revisionIds;
  if (newest.length > 0 && (!last?.endedAt || newestAt > last.endedAt)) return newest;

  // A variant that has never met shows what the line it was started from shows.
  if (line.parentSessionId) {
    const left = await readSession(line.parentSessionId);
    if (left && left.revisionIds.length > 0) return left.revisionIds;
  }
  const parent = (line.parentLineId ? lineById(lines, line.parentLineId) : null) ?? mainLineOf(lines);
  if (!parent || parent.id === line.id) return [];
  return lineSceneNow(reviewId, lines, parent, budget - 1);
}

/**
 * The review's main line, created if it has none.
 *
 * The service role writes it, so the browser-only `kind='main'` policy is not what
 * is being relied on here. A review that has met has one already — the backfill in
 * docs/supabase-schema.sql saw to that — and this is for the one that has a variant
 * somehow recorded against a session no line claims.
 */
async function ensureMainLine(reviewId: string, lines: readonly ReviewLine[], actor: string): Promise<ReviewLine | null> {
  const existing = lines.find((line) => line.kind === 'main') ?? null;
  if (existing) return existing;
  const res = await postgrestFetch('review_lines', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      review_id: reviewId,
      kind: 'main',
      name: MAIN_LINE_NAME,
      letter: null,
      parent_session_id: null,
      status: 'active',
      created_by: null,
      created_by_name: actor,
    }),
  });
  if (!res) throw new Error('store_unavailable');
  if (res.ok) {
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const created = toReviewLine(Array.isArray(rows) ? rows[0] : undefined);
    if (created) return created;
  } else {
    console.error(`[reviews/lines] the main line insert failed: ${res.status}`);
  }
  // Somebody else wrote it between the read and the insert, which is what the
  // partial unique index refuses. Their row is the answer, so read the lines again
  // rather than reporting a failure this review does not have.
  const reread = await readLines(reviewId);
  return reread.find((line) => line.kind === 'main') ?? null;
}

// ─── The three actions ──────────────────────────────────────────────────────

/**
 * "Explore a variant from here."
 *
 * The letter is computed here rather than left to the database because it is an
 * identity and not a slot: `nextVariantLetter` counts every line of the review
 * including the dropped ones, so a variant started after Variant A was dropped is
 * Variant B and never a second Variant A — two sets of cards both saying they came
 * from Variant A is exactly what keeping a dropped variant for the record is meant
 * to prevent. `unique (review_id, kind, letter)` backs it up, and a collision from
 * two people clicking at the same moment is answered by reading the lines again and
 * taking the next letter, once.
 */
async function explore(
  res: VercelResponse,
  reviewId: string,
  body: Record<string, unknown>,
  caller: Caller,
): Promise<void> {
  const name = bodyString(body, 'name');
  if (!name) {
    res.status(400).json({ error: 'Give the variant a short name, so the map can say what it was for.' });
    return;
  }
  if (name.length > MAX_NAME) {
    res.status(400).json({ error: `That name is longer than ${MAX_NAME} characters.` });
    return;
  }
  const read = await readLines(reviewId);
  const main = await ensureMainLine(reviewId, read, caller.name);
  // `ensureMainLine` may have just written the row it answers, and `read` was taken
  // before that: a review whose first ever action is "explore a variant" would
  // otherwise look up its own main line in a list that does not contain it.
  const lines = main && !lineById(read, main.id) ? [...read, main] : read;

  const askedSessionId = bodyString(body, 'parentSessionId');
  const askedLineId = bodyString(body, 'parentLineId');

  let leftFrom: SessionRow | null = null;
  if (askedSessionId) {
    leftFrom = await readSession(askedSessionId);
    // A session of ANOTHER review is refused rather than ignored: the map draws a
    // variant leaving from a stop it names, and a stop from somewhere else is a line
    // floating in mid-air with nothing attached to it.
    if (!leftFrom || (leftFrom.reviewId !== null && leftFrom.reviewId !== reviewId)) {
      res.status(404).json({ error: 'That session is not part of this design review.' });
      return;
    }
  }

  // WHICH LINE IT LEAVES FROM — batch BX, and the whole of what makes a variant of a
  // variant possible. The meeting's own line wins when a meeting was named, because a
  // meeting is the more specific fact and the map has to draw the branch leaving from
  // the row that meeting is on; the named line is next, which is what a variant
  // explored from a line that has never met sends; and the review's main line is the
  // answer for a caller that named neither, which is every caller before this batch.
  const wantedId = leftFrom?.lineId ?? askedLineId ?? main?.id ?? '';
  const parentLine = lineById(lines, wantedId);
  if (!parentLine) {
    res.status(askedLineId ? 404 : 409).json({
      error: askedLineId
        ? 'That line is not part of this design review.'
        : 'This design review has no line to start a variant from.',
    });
    return;
  }
  // A line nobody is exploring any more is a record, and a variant started from it
  // would be a variant of an answer the review has already rejected or already taken.
  if (parentLine.status !== 'active') {
    res.status(409).json({
      error: `That line has already been ${parentLine.status}, so nothing can be started from it.`,
    });
    return;
  }

  // The meeting it leaves from: the one named, else the parent line's newest, else
  // none. Batch BX made this the endpoint's job rather than the caller's, and it is
  // what removed batch BQ's refusal of "no meeting named in a review that has met":
  // the caller no longer has to have read the line's history for the new variant to
  // open on the right model, because the line's own newest meeting is right here.
  // NULL only for a line that has genuinely never met, where there is nothing to name
  // and lib/reviews/linesRepo.originRevisionIds opens the room on what the parent line
  // is showing now.
  const parentSessionId = leftFrom?.id ?? (await readLastSession(parentLine.id))?.id ?? null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const known = attempt === 0 ? lines : await readLines(reviewId);
    const letter = nextVariantLetter(known);
    const created = await postgrestFetch('review_lines', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        review_id: reviewId,
        kind: 'variant',
        name,
        letter,
        parent_session_id: parentSessionId,
        parent_line_id: parentLine.id,
        status: 'active',
        created_by: caller.accountId,
        created_by_name: caller.name,
      }),
    });
    if (!created) {
      res.status(503).json({ error: 'The database could not be reached. Try again.' });
      return;
    }
    if (created.status === 409 && attempt === 0) continue;
    if (!created.ok) {
      console.error(`[reviews/lines] explore failed: ${created.status}`);
      res.status(502).json({ error: 'The variant could not be started. Try again.' });
      return;
    }
    const rows = (await created.json()) as Array<Record<string, unknown>>;
    const line = toReviewLine(Array.isArray(rows) ? rows[0] : undefined);
    if (!line) {
      res.status(502).json({ error: 'The variant was started but could not be read back.' });
      return;
    }
    res.status(200).json({ ok: true, line });
    return;
  }
  res.status(409).json({ error: 'Two variants are being started at the same moment. Try again.' });
}

/** The sentence a refusal from one of the two functions is answered with. */
function rpcRefusal(answer: RpcAnswer): { status: number; error: string } | null {
  if (answer.ok === true) return null;
  const reason = typeof answer.error === 'string' ? answer.error : '';
  if (reason === 'no_such_variant') return { status: 404, error: 'That variant is not part of this design review.' };
  if (reason === 'already_closed') {
    const status = typeof answer.status === 'string' ? answer.status : 'closed';
    return { status: 409, error: `That variant has already been ${status}.` };
  }
  if (reason === 'no_main_line') {
    return { status: 409, error: 'This design review has no main line to merge into.' };
  }
  if (reason === 'no_target_line') {
    return { status: 404, error: 'That line is not part of this design review.' };
  }
  if (reason === 'other_review') {
    return { status: 404, error: 'That line belongs to a different design review.' };
  }
  if (reason === 'same_line') {
    return { status: 400, error: 'A variant cannot be merged into itself.' };
  }
  if (reason === 'target_closed') {
    const status = typeof answer.status === 'string' ? answer.status : 'closed';
    return { status: 409, error: `That line has already been ${status}, so nothing can be merged into it.` };
  }
  if (reason === 'own_descendant') {
    return { status: 409, error: 'That variant was started from this one, so it cannot be merged back into it.' };
  }
  if (reason === 'has_active_children') {
    // The api checks this first so that it can name the child; this is the answer for
    // the one that was started in the moment between the check and the write.
    return { status: 409, error: 'Another variant starts from this one. Drop or merge it first.' };
  }
  return { status: 502, error: 'That change did not land. Try again.' };
}

/**
 * "Merge into…" — take a variant into another line.
 *
 * The models are decided here and not in the browser, so that the one plain question
 * cannot be skipped by a client that would rather not ask it: when both lines moved
 * the same model, a request with no answer is refused with the question in it, and
 * the browser asks the person and posts again. The cards move either way, and both
 * halves are one transaction.
 *
 * So is the third half, batch BV: the positions the variant left its models at become
 * the target line's. `adopt_review_line` copies `asset.linePlacements[variant]` into
 * the target's own slot on the review's row, in the same function call as the cards and
 * the status — this endpoint writes no row of its own afterwards, and deliberately so,
 * because a merge that moved the cards in one transaction and the positions in a second
 * request would have a window in which the target line opens on the model the meeting
 * had just taken, standing where the meeting had just decided against. A drop leaves
 * the variant's slot exactly as it was, as the record.
 *
 * AND SO IS THE FOURTH, batch BX: the variant's own active variants are re-parented
 * onto the target in the same call, because a merge closes the line they hang off and
 * an active line whose parent is closed is a line the map cannot draw and the chip
 * cannot offer a way back from.
 */
async function adopt(
  res: VercelResponse,
  reviewId: string,
  body: Record<string, unknown>,
  caller: Caller,
): Promise<void> {
  const lineId = bodyString(body, 'lineId');
  if (!lineId) {
    res.status(400).json({ error: 'lineId is required' });
    return;
  }
  const read = await readLines(reviewId);
  const variant = lineById(read, lineId);
  if (!variant || variant.kind !== 'variant') {
    res.status(404).json({ error: 'That variant is not part of this design review.' });
    return;
  }
  if (variant.status !== 'active') {
    res.status(409).json({ error: `That variant has already been ${variant.status}.` });
    return;
  }

  const main = await ensureMainLine(reviewId, read, caller.name);
  const lines = main && !lineById(read, main.id) ? [...read, main] : read;

  // WHERE IT IS GOING. Batch BX: any line still being explored, not only the main one,
  // and a request that names none still means the main line — which is what every
  // caller before this batch sent and what the two-argument database function still
  // does. Checked here as well as in the function, and not instead of it: the endpoint
  // answers with a sentence that names the lines, while `adopt_review_line` is the one
  // that cannot be raced.
  const askedTargetId = bodyString(body, 'targetLineId');
  const askedTarget = askedTargetId ? lineById(lines, askedTargetId) : null;
  if (askedTargetId && !askedTarget) {
    // Refused rather than quietly retargeted at the main line: a chooser that listed a
    // line which has since been deleted is a person who asked for one destination, and
    // moving their cards onto a different one is a write they did not agree to.
    res.status(404).json({ error: 'That line is not part of this design review.' });
    return;
  }
  const target = askedTarget ?? main;
  if (!target) {
    res.status(409).json({ error: 'This design review has no main line to merge into.' });
    return;
  }
  if (target.id === variant.id) {
    res.status(400).json({ error: 'A variant cannot be merged into itself.' });
    return;
  }
  if (target.status !== 'active') {
    res.status(409).json({ error: `That line has already been ${target.status}, so nothing can be merged into it.` });
    return;
  }
  if (isDescendantOf(lines, target.id, variant.id)) {
    res.status(409).json({
      error: 'That variant was started from this one, so it cannot be merged back into it.',
    });
    return;
  }

  const [parent, variantLast, revisions, targetScene] = await Promise.all([
    variant.parentSessionId ? readSession(variant.parentSessionId) : Promise.resolve(null),
    readLastSession(variant.id),
    readRevisions(reviewId),
    lineSceneNow(reviewId, lines, target, lines.length + 1),
  ]);

  // The point both lines agree on. The meeting the variant left is the answer when it
  // named revisions; the target line's own scene is the answer when it did not, which
  // makes the question "what has this variant changed against the line it is going
  // into" — the only comparison the person answering it can act on.
  const agreed = parent && parent.revisionIds.length > 0 ? parent.revisionIds : targetScene;

  const plan = adoptPlan({
    parentRevisionIds: agreed,
    mainRevisionIds: targetScene,
    variantRevisionIds: variantLast?.revisionIds ?? [],
    revisions,
    variantLabel: shortLineLabel(variant),
    targetLabel: mergeTargetWord(target),
  });

  const keep = asAdoptKeep(body['keep']);
  if (plan.kind === 'ask' && keep === null) {
    // 409 rather than 400: the request was understood and is not wrong, it is
    // missing an answer only the people in the meeting can give. The question is
    // the endpoint's own words, built by the same pure rule that decides the write,
    // so the browser cannot get one without the other.
    res.status(409).json({
      error: plan.choice.question,
      question: plan.choice.question,
      keep: ['target', 'variant'],
    });
    return;
  }

  const chosen = adoptRevisionIds(plan, keep);
  if (chosen === null) {
    // Unreachable: `ask` with no answer was just refused, and every other plan
    // answers with a scene. Written down rather than assumed, because the
    // alternative is writing an empty merge to the target line.
    console.error('[reviews/lines] the merge produced no scene to write');
    res.status(500).json({ error: 'internal_error' });
    return;
  }

  const answer = await rpc('rpc/adopt_review_line', {
    p_variant: variant.id,
    p_target: target.id,
    p_revision_ids: chosen,
  }, TAG);
  const refusal = rpcRefusal(answer);
  if (refusal) {
    if (refusal.status >= 500) console.error(`[reviews/lines] adopt refused: ${String(answer.error)}`);
    res.status(refusal.status).json({ error: refusal.error });
    return;
  }
  await recordAudit({
    action: 'variant_merged', roomId: reviewId, actorId: caller.accountId, actorName: caller.name,
    subjectId: variant.id,
    subjectName: `${lineLabel(variant) ?? 'Variant'} → ${target.kind === 'main' ? 'Main line' : lineLabel(target) ?? 'Variant'}`,
    detail: countsDetail([[typeof answer.moved === 'number' ? answer.moved : 0, 'card moved', 'cards moved']]),
  });
  res.status(200).json({
    ok: true,
    lineId: variant.id,
    // Both, because a caller from before batch BX reads `mainLineId` to know where the
    // cards went and would otherwise be told nothing about a merge into a variant.
    targetLineId: target.id,
    mainLineId: target.id,
    moved: typeof answer.moved === 'number' ? answer.moved : 0,
    reparented: typeof answer.reparented === 'number' ? answer.reparented : 0,
    status: 'adopted',
    revisionIds: chosen,
  });
}

/**
 * "Drop variant."
 *
 * The reason is one line and is stored word for word on every card the drop closes,
 * so that a reviewer who finds one of them in six months' time is reading the
 * sentence the meeting agreed. The variant itself stays, greyed, for the record.
 */
async function drop(
  res: VercelResponse,
  reviewId: string,
  body: Record<string, unknown>,
  caller: Caller,
): Promise<void> {
  const lineId = bodyString(body, 'lineId');
  const reason = bodyString(body, 'reason');
  if (!lineId) {
    res.status(400).json({ error: 'lineId is required' });
    return;
  }
  if (!reason) {
    res.status(400).json({ error: 'Say in one line why the variant was dropped — it goes on every card it closes.' });
    return;
  }
  if (reason.length > MAX_REASON) {
    res.status(400).json({ error: `That reason is longer than ${MAX_REASON} characters.` });
    return;
  }

  const lines = await readLines(reviewId);
  const variant = lineById(lines, lineId);
  if (!variant || variant.kind !== 'variant') {
    res.status(404).json({ error: 'That variant is not part of this design review.' });
    return;
  }
  if (variant.status !== 'active') {
    res.status(409).json({ error: `That variant has already been ${variant.status}.` });
    return;
  }
  // A variant of its own, still being explored (batch BX). Refused rather than
  // repaired, and named here rather than left to the database's own refusal so that
  // the sentence says WHICH one — the person pressing the button has to go and deal
  // with it, and "another variant" is not an instruction. drop_review_line checks the
  // same thing inside its transaction, which is the check that cannot be raced.
  const child = activeChildrenOf(lines, variant.id)[0] ?? null;
  if (child) {
    res.status(409).json({
      error: `${shortLineLabel(child) ?? 'Another variant'} starts from this variant. Drop or merge it first.`,
      childLineId: child.id,
    });
    return;
  }
  // Built here rather than in the database so that the words a card carries are the
  // words lib/reviews/lines.ts says they are, in the one file that decides them.
  const closedReason = droppedCardReason(variant, reason);
  if (!closedReason) {
    res.status(400).json({ error: 'That variant has no name to close its cards under.' });
    return;
  }

  const answer = await rpc('rpc/drop_review_line', {
    p_variant: variant.id,
    p_closed_reason: closedReason,
    p_actor_name: caller.name,
  }, TAG);
  const refusal = rpcRefusal(answer);
  if (refusal) {
    if (refusal.status >= 500) console.error(`[reviews/lines] drop refused: ${String(answer.error)}`);
    res.status(refusal.status).json({ error: refusal.error });
    return;
  }
  await recordAudit({
    action: 'variant_dropped', roomId: reviewId, actorId: caller.accountId, actorName: caller.name,
    subjectId: variant.id, subjectName: lineLabel(variant) ?? 'Variant',
    detail: `${closedReason}${typeof answer.closed === 'number' ? ` (${countsDetail([[answer.closed, 'card closed', 'cards closed']])})` : ''}`,
  });
  res.status(200).json({
    ok: true,
    lineId: variant.id,
    closed: typeof answer.closed === 'number' ? answer.closed : 0,
    status: 'dropped',
    closedReason,
  });
}

// ─── Handler ────────────────────────────────────────────────────────────────

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
    console.error('[reviews/lines] failed to load config:', err);
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
  if (action !== 'explore' && action !== 'adopt' && action !== 'drop') {
    res.status(400).json({ error: 'action must be explore, adopt or drop' });
    return;
  }

  try {
    const caller = await callerFor(req, body, reviewId, accountsOn, TAG);
    if (!caller) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    // One gate for all three, and it is `editReview`: see the top of this file for
    // why starting, merging and dropping a variant are not three new actions.
    if (!can(caller.role, 'editReview')) {
      res.status(403).json({
        error: 'Only the owner and the editors of this design review can start, merge or drop a variant.',
      });
      return;
    }

    if (action === 'explore') {
      await explore(res, reviewId, body, caller);
    } else if (action === 'adopt') {
      await adopt(res, reviewId, body, caller);
    } else {
      await drop(res, reviewId, body, caller);
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
