// Tests for lib/reviews/linesRepo.ts — the lines a design review has, the number
// the next session on one gets, and the cards a line is still carrying
// (docs/plan/15-sessions-and-variants.md batch BK).
//
// Supabase is faked the way lib/reviews/__tests__/revisionsRepo.test.ts fakes it, and
// for the same reason: what is worth pinning here is the SHAPE of the read and the
// write — which table, which filter, which columns land in which row — and what the
// module answers when the database says no. An install whose database has not had
// docs/supabase-schema.sql re-applied since this batch has no review_lines table at
// all, and every one of these functions has to answer "nothing" rather than throw,
// because the room and the tracker both open on top of them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Answer {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

const { calls, route, identity } = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  // One router rather than one canned answer per table, because ensureMainLine reads
  // and then writes the same table and has to see a different answer each time.
  route: {
    current: ((_table: string, _ops: string[]) => ({ data: null, error: null })) as (
      table: string,
      ops: string[],
    ) => { data: unknown; error: { code?: string; message?: string } | null },
  },
  identity: { value: null as null | Record<string, unknown> },
}));

interface QueryChain extends Promise<Answer> {
  select: (...args: unknown[]) => QueryChain;
  insert: (...args: unknown[]) => QueryChain;
  update: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  in: (...args: unknown[]) => QueryChain;
  order: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
  single: (...args: unknown[]) => QueryChain;
  maybeSingle: (...args: unknown[]) => QueryChain;
}

/** One answer per query, keyed on the operation list that query built. */
const answersForOps = new WeakMap<string[], Answer>();

function chain(table: string, ops: string[]): QueryChain {
  const step = (op: string) => (...args: unknown[]): QueryChain => {
    calls.push({ table, op, args });
    ops.push(op);
    return chain(table, ops);
  };
  // Resolved on a microtask, by which point every chained call in the expression has
  // recorded its operation — so the router can answer on "select, then eq" as well as
  // on the table alone. Answered ONCE per query and remembered: every link of the
  // chain builds a promise of its own, and a router that counted them would see one
  // read as three.
  const promise = Promise.resolve().then(() => {
    const settled = answersForOps.get(ops);
    if (settled) return settled;
    const answer = route.current(table, ops);
    answersForOps.set(ops, answer);
    return answer;
  });
  return Object.assign(promise, {
    select: step('select'),
    insert: step('insert'),
    update: step('update'),
    eq: step('eq'),
    in: step('in'),
    order: step('order'),
    limit: step('limit'),
    single: step('single'),
    maybeSingle: step('maybeSingle'),
  });
}

vi.mock('../../supabase', () => ({
  supabase: { from: (table: string) => chain(table, []) },
  supabaseConfigured: true,
}));

vi.mock('../../identity', () => ({
  getStoredIdentity: () => identity.value,
}));

import {
  cachedLines,
  ensureMainLine,
  lastSessionOnLine,
  listLines,
  listLinesForReviews,
  listOpenLineItems,
  listReviewCardRefs,
  listReviewSessions,
  nextSessionSeq,
  originRevisionIds,
  placementSlotsFor,
  resetLineCache,
  resolveLine,
  updateLineItem,
} from '../linesRepo';
import type { ReviewLine } from '../lines';

const REVIEW = 'review-1';

function mainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'line-main', review_id: REVIEW, kind: 'main', name: 'Main line', letter: null,
    parent_session_id: null, status: 'active', created_by: null, created_by_name: '',
    created_at: '2026-09-01T09:00:00.000Z', closed_at: null, ...overrides,
  };
}

function variantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return mainRow({
    id: 'line-a', kind: 'variant', name: 'Weld fix', letter: 'A',
    parent_session_id: 'sess-2', created_at: '2026-09-05T09:00:00.000Z', ...overrides,
  });
}

/** The answer for a read of a table, until a test says otherwise. */
function answerWith(data: unknown, error: Answer['error'] = null): void {
  route.current = () => ({ data, error });
}

/** A router keyed on the table, for the reads that have to differ. */
function answerByTable(tableData: Record<string, unknown>): void {
  route.current = (table) => ({ data: tableData[table] ?? [], error: null });
}

/**
 * A router keyed on the table AND on which line a tracker_sessions read asked for.
 *
 * Needed by the parentless-variant case below, where `originRevisionIds` reads one
 * line's meetings, finds none, and then reads the MAIN line's — and a single canned
 * answer per table would hand it the same rows both times, so the second read would
 * look like the first had succeeded and the fallback would never be reached.
 *
 * The line is read off `calls`, which records every chained method with its arguments:
 * the router runs on a microtask after the whole expression has been built, so the last
 * `eq` recorded for that table is this query's.
 */
function answerByTableAndLine(
  tableData: Record<string, unknown>,
  sessionsByLine: Record<string, unknown[]>,
): void {
  route.current = (table) => {
    if (table !== 'tracker_sessions') return { data: tableData[table] ?? [], error: null };
    const filters = calls.filter((call) => call.table === table && call.op === 'eq');
    const last = filters[filters.length - 1];
    const lineId = last ? String(last.args[1] ?? '') : '';
    return { data: sessionsByLine[lineId] ?? [], error: null };
  };
}

beforeEach(() => {
  calls.length = 0;
  identity.value = null;
  resetLineCache();
  route.current = () => ({ data: null, error: null });
});

const asLine = (row: Record<string, unknown>) => row as unknown as ReviewLine;

// ─── listLines ──────────────────────────────────────────────────────────────

describe('listLines', () => {
  it('answers the review\'s lines, main first', async () => {
    // Read back in whatever order the database liked, so the ordering is this
    // module's and not Postgres'.
    answerWith([variantRow(), mainRow()]);
    const lines = await listLines(REVIEW);
    expect(lines.map((line) => line.id)).toEqual(['line-main', 'line-a']);
  });

  it('reads the table once and answers from the cache after that', async () => {
    answerWith([mainRow()]);
    await listLines(REVIEW);
    await listLines(REVIEW);
    // One read is a `select` plus an `eq`, so it is the selects that count.
    const reads = calls.filter((call) => call.table === 'review_lines' && call.op === 'select');
    expect(reads).toHaveLength(1);
  });

  it('answers [] for a database with no review_lines table, and says nothing about it', async () => {
    // 42P01 is what an install that has not re-applied the schema answers. It is not
    // broken, it has no lines yet, and the room has to open anyway.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    route.current = () => ({ data: null, error: { code: '42P01', message: 'relation "review_lines" does not exist' } });
    await expect(listLines(REVIEW)).resolves.toEqual([]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('answers [] for no review id at all', async () => {
    await expect(listLines(null)).resolves.toEqual([]);
    await expect(listLines('')).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('drops a row it cannot make sense of rather than rendering it wrong', async () => {
    answerWith([mainRow(), { id: 'line-x', review_id: REVIEW, kind: 'experiment' }]);
    const lines = await listLines(REVIEW);
    expect(lines.map((line) => line.id)).toEqual(['line-main']);
  });
});

// ─── ensureMainLine ─────────────────────────────────────────────────────────

describe('ensureMainLine', () => {
  it('answers the main line the review already has, and writes nothing', async () => {
    answerWith([mainRow()]);
    const line = await ensureMainLine(REVIEW);
    expect(line?.id).toBe('line-main');
    expect(calls.filter((call) => call.op === 'insert')).toHaveLength(0);
  });

  it('creates one when the review has none, as an unnamed main line', async () => {
    route.current = (table, ops) =>
      ops.includes('insert') ? { data: mainRow(), error: null } : { data: [], error: null };

    const line = await ensureMainLine(REVIEW);
    expect(line?.id).toBe('line-main');
    const insert = calls.find((call) => call.op === 'insert');
    expect(insert?.table).toBe('review_lines');
    expect(insert?.args[0]).toMatchObject({
      review_id: REVIEW,
      kind: 'main',
      name: 'Main line',
      letter: null,
      status: 'active',
    });
  });

  it('creates it exactly once, however often a page asks', async () => {
    // A room asks on open, the Capture panel asks for its cards, and the meeting
    // flush asks at the end. One row is the whole point of the function.
    route.current = (table, ops) =>
      ops.includes('insert') ? { data: mainRow(), error: null } : { data: [], error: null };
    await ensureMainLine(REVIEW);
    await ensureMainLine(REVIEW);
    await ensureMainLine(REVIEW);
    expect(calls.filter((call) => call.op === 'insert')).toHaveLength(1);
  });

  it('takes the winner\'s row when two people open the same review at once', async () => {
    // The partial unique index refuses the second insert. That is the constraint
    // doing its job; the answer has to be the other person's row, not a failure.
    let insertAttempts = 0;
    let reads = 0;
    route.current = (table, ops) => {
      if (table !== 'review_lines') return { data: null, error: null };
      if (ops.includes('insert')) {
        insertAttempts++;
        return { data: null, error: { code: '23505', message: 'duplicate key value' } };
      }
      // The first read sees nothing — that is why it inserts. The read after the
      // refusal finds the row the other person wrote.
      reads++;
      return { data: reads === 1 ? [] : [mainRow({ id: 'theirs' })], error: null };
    };
    const line = await ensureMainLine(REVIEW);
    expect(insertAttempts).toBe(1);
    expect(line?.id).toBe('theirs');
  });

  it('answers null when the table is not there, and does not cache the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    route.current = () => ({ data: null, error: { code: '42P01', message: 'no table' } });
    await expect(ensureMainLine(REVIEW)).resolves.toBeNull();
    error.mockRestore();
  });

  it('answers null for no review id, without touching the database', async () => {
    await expect(ensureMainLine(null)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('names who created it when this browser is signed in, and leaves it blank for a guest', async () => {
    route.current = (table, ops) =>
      ops.includes('insert') ? { data: mainRow(), error: null } : { data: [], error: null };

    identity.value = { name: 'Robin', accountId: 'acct-1' };
    resetLineCache();
    await ensureMainLine('review-signed-in');
    expect(calls.find((call) => call.op === 'insert')?.args[0]).toMatchObject({
      created_by: 'acct-1',
      created_by_name: 'Robin',
    });

    calls.length = 0;
    identity.value = { name: 'Guest', guest: true };
    resetLineCache();
    await ensureMainLine('review-guest');
    // A guest has no account to attribute it to, but the name is still worth having:
    // "who started this review's line" is a question the history should answer.
    expect(calls.find((call) => call.op === 'insert')?.args[0]).toMatchObject({
      created_by: null,
      created_by_name: 'Guest',
    });
  });
});

// ─── resolveLine ────────────────────────────────────────────────────────────

describe('resolveLine', () => {
  it('answers the line the address named', async () => {
    answerWith([mainRow(), variantRow()]);
    const line = await resolveLine(REVIEW, 'line-a');
    expect(line?.id).toBe('line-a');
  });

  it('falls back to the main line for a line id that is not this review\'s', async () => {
    // A stale link, a deleted variant, an id from another review. A room that opens
    // on a line it cannot find must still open.
    answerWith([mainRow(), variantRow()]);
    const line = await resolveLine(REVIEW, 'line-from-somewhere-else');
    expect(line?.id).toBe('line-main');
  });

  it('answers the main line for no line id, which is every address that predates lines', async () => {
    answerWith([mainRow()]);
    expect((await resolveLine(REVIEW, null))?.id).toBe('line-main');
  });

  it('answers null for no review, because an ad-hoc room has no lines', async () => {
    await expect(resolveLine(null, 'line-a')).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// ─── nextSessionSeq ─────────────────────────────────────────────────────────

describe('nextSessionSeq', () => {
  it('is one more than the line\'s highest number', async () => {
    answerWith([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    await expect(nextSessionSeq('line-main')).resolves.toBe(4);
  });

  it('does not reuse the number of a session somebody deleted', async () => {
    // Two meetings of one review both called S3 would be a map nobody can read and
    // a set of cards whose "raised in S3" is ambiguous.
    answerWith([{ seq: 1 }, { seq: 3 }]);
    await expect(nextSessionSeq('line-main')).resolves.toBe(4);
  });

  it('starts at 1 for a line that has never met', async () => {
    answerWith([]);
    await expect(nextSessionSeq('line-main')).resolves.toBe(1);
  });

  it('ignores a session with no number, which is one recorded before seq existed', async () => {
    answerWith([{ seq: null }, { seq: 2 }, {}]);
    await expect(nextSessionSeq('line-main')).resolves.toBe(3);
  });

  it('answers 1 rather than nothing when the read fails', async () => {
    route.current = () => ({ data: null, error: { code: '42703', message: 'column "line_id" does not exist' } });
    await expect(nextSessionSeq('line-main')).resolves.toBe(1);
  });

  it('answers 1 for no line at all', async () => {
    await expect(nextSessionSeq(null)).resolves.toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('asks for the sessions of THAT line and no others', async () => {
    answerWith([]);
    await nextSessionSeq('line-a');
    const eq = calls.find((call) => call.op === 'eq');
    expect(eq?.table).toBe('tracker_sessions');
    expect(eq?.args).toEqual(['line_id', 'line-a']);
  });
});

// ─── The sessions a line has had ────────────────────────────────────────────

describe('listReviewSessions and lastSessionOnLine', () => {
  const older = {
    id: 'sess-1', title: 'First look', ended_at: '2026-09-01T16:00:00.000Z',
    participant_count: 3, model_name: 'imported', line_id: 'line-main', seq: 1,
    revision_ids: ['rev-a'],
  };
  const newer = {
    id: 'sess-2', title: 'Second look', ended_at: '2026-09-08T16:00:00.000Z',
    participant_count: 5, model_name: null, line_id: 'line-main', seq: 2,
    revision_ids: ['rev-b', 'rev-m'],
  };

  it('answers a review\'s meetings oldest first, whichever way the database gave them', async () => {
    answerWith([newer, older]);
    const sessions = await listReviewSessions(REVIEW);
    expect(sessions.map((session) => session.id)).toEqual(['sess-1', 'sess-2']);
    expect(sessions[1]).toMatchObject({ seq: 2, lineId: 'line-main', revisionIds: ['rev-b', 'rev-m'] });
  });

  it('reads a meeting recorded before this batch, with no line and no revisions', async () => {
    answerWith([{ id: 'sess-0', title: 'Old', ended_at: '2026-01-01T10:00:00.000Z', participant_count: 2 }]);
    const [session] = await listReviewSessions(REVIEW);
    expect(session).toMatchObject({
      lineId: null, seq: null, revisionIds: [], summary: null, modelName: null, attendeeNames: [],
    });
  });

  it('reads who attended and the minutes, when the row has them', async () => {
    // Batch BM. Both come off the same `select('*')` the revisions do, and both
    // stay optional at the row level: a meeting recorded before either column
    // existed reads back [] and null, which is what the session panel falls back on.
    answerWith([{ ...newer, attendee_names: ['Olga Owner', 'Ben Editor'], summary: '## Decisions\nRev B approved.' }]);
    const [session] = await listReviewSessions(REVIEW);
    expect(session).toMatchObject({
      participantCount: 5,
      attendeeNames: ['Olga Owner', 'Ben Editor'],
      summary: '## Decisions\nRev B approved.',
    });
  });

  it('drops a blank name out of the list it reads back', async () => {
    // A blank in the middle of the list reads as a missing attendee in the panel,
    // and the count beside it is the fallback for "we never knew".
    answerWith([{ ...newer, attendee_names: ['Olga Owner', ''] }]);
    const [session] = await listReviewSessions(REVIEW);
    expect(session.attendeeNames).toEqual(['Olga Owner']);
  });

  it('answers [] for a review that has not met, and for a database that has not been upgraded', async () => {
    route.current = () => ({ data: null, error: { code: '42703', message: 'no column' } });
    await expect(listReviewSessions(REVIEW)).resolves.toEqual([]);
  });

  it('answers the newest meeting on one line', async () => {
    answerWith([newer]);
    const last = await lastSessionOnLine('line-main');
    expect(last?.id).toBe('sess-2');
    const order = calls.find((call) => call.op === 'order');
    expect(order?.args[0]).toBe('ended_at');
    expect(order?.args[1]).toEqual({ ascending: false });
  });

  it('answers null for a line that has never met', async () => {
    answerWith([]);
    await expect(lastSessionOnLine('line-a')).resolves.toBeNull();
    await expect(lastSessionOnLine(null)).resolves.toBeNull();
  });
});

describe('originRevisionIds — what a session starts from', () => {
  it('answers what the line was last looking at', async () => {
    answerByTable({
      review_lines: [mainRow()],
      tracker_sessions: [{
        id: 'sess-2', title: 'Second look', ended_at: '2026-09-08T16:00:00.000Z',
        participant_count: 5, line_id: 'line-main', seq: 2, revision_ids: ['rev-b'],
      }],
    });
    await expect(originRevisionIds(REVIEW, null)).resolves.toEqual(['rev-b']);
  });

  it('answers null for a line that has never met, so the room opens on its whole history', async () => {
    answerByTable({ review_lines: [mainRow()], tracker_sessions: [] });
    await expect(originRevisionIds(REVIEW, null)).resolves.toBeNull();
  });

  it('answers null for a meeting recorded before revision_ids existed', async () => {
    // Empty is "nothing was stored", not "show nothing": treating it as the latter
    // would open such a room on an empty scene.
    answerByTable({
      review_lines: [mainRow()],
      tracker_sessions: [{ id: 'sess-1', ended_at: '2026-09-01T16:00:00.000Z', participant_count: 3, line_id: 'line-main', seq: 1, revision_ids: [] }],
    });
    await expect(originRevisionIds(REVIEW, 'line-main')).resolves.toBeNull();
  });

  it('answers null for an ad-hoc room, which has no review to have lines', async () => {
    await expect(originRevisionIds(null, null)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  // ─── A variant with no meeting to leave from (batch BQ) ─────────────────────
  //
  // api/reviews/lines.ts writes parent_session_id NULL for a variant started in a
  // review that had never met. Such a variant has no session of its own and no parent
  // session, so lineOriginSession answers null for it — and null here means "rebuild
  // from the review's whole history", which is NOT what the main line's room would be
  // showing if the main line has met since. So the main line's own answer is asked for.

  it('answers what the main line is showing for a variant with no meeting to leave from', async () => {
    answerByTableAndLine(
      { review_lines: [mainRow(), variantRow({ id: 'line-new', letter: 'B', parent_session_id: null })] },
      {
        // The variant itself has never met.
        'line-new': [],
        // The main line met after the variant was started, and was looking at Rev C.
        'line-main': [{
          id: 'sess-3', title: 'Third look', ended_at: '2026-09-09T16:00:00.000Z',
          participant_count: 4, line_id: 'line-main', seq: 3, revision_ids: ['rev-c'],
        }],
      },
    );

    await expect(originRevisionIds(REVIEW, 'line-new')).resolves.toEqual(['rev-c']);
  });

  it('answers null for such a variant in a review that has STILL never met, so the room rebuilds from its own revisions', async () => {
    answerByTableAndLine(
      { review_lines: [mainRow(), variantRow({ id: 'line-new', letter: 'B', parent_session_id: null })] },
      { 'line-new': [], 'line-main': [] },
    );

    // Which is the honest answer: there is no scene to inherit, so the room shows the
    // newest revision of every line the review has stored — the same thing the main
    // line's own room would show.
    await expect(originRevisionIds(REVIEW, 'line-new')).resolves.toBeNull();
  });

  it('still leaves from the meeting it was started at, for a variant that HAS one', async () => {
    // The fallback above is for a line with no origin at all. A variant started from a
    // meeting keeps leaving from that meeting even after the main line has moved on —
    // that is the whole point of a variant, and it is what the room's "Carried over"
    // cards are the cards of.
    const parent = {
      id: 'sess-2', title: 'Second look', ended_at: '2026-09-08T16:00:00.000Z',
      participant_count: 5, line_id: 'line-main', seq: 2, revision_ids: ['rev-b'],
    };
    answerByTableAndLine(
      { review_lines: [mainRow(), variantRow()] },
      {
        // The variant has never met, so its origin is the meeting it left from…
        'line-a': [],
        // …asked for by id, which is the read sessionById makes.
        'sess-2': [parent],
        // …and NOT what the main line is on now, which has moved on to Rev C since.
        'line-main': [parent, {
          id: 'sess-3', title: 'Third look', ended_at: '2026-09-09T16:00:00.000Z',
          participant_count: 4, line_id: 'line-main', seq: 3, revision_ids: ['rev-c'],
        }],
      },
    );

    await expect(originRevisionIds(REVIEW, 'line-a')).resolves.toEqual(['rev-b']);
  });
});

// ─── Batch BX: a variant can come from, and go into, ANY line ───────────────
//
// Until this batch `parent_session_id` was the only record of where a variant came
// from, so a variant could only leave from one of the MAIN line's meetings and could
// only be taken back into the main line. Both ends are now a LINE of their own —
// `parent_line_id` and `merged_into_line_id` — and every read that used to be able to
// assume the main line was at the other end of the chain has to follow it instead.

/** main ← A ← B ← C, none of them started from a meeting, so the chain is all there is. */
function chainRows(): Record<string, unknown>[] {
  return [
    mainRow(),
    variantRow({
      id: 'line-a', letter: 'A', parent_session_id: null, parent_line_id: 'line-main',
      created_at: '2026-09-05T09:00:00.000Z',
    }),
    variantRow({
      id: 'line-b', letter: 'B', name: 'Lighter frame', parent_session_id: null,
      parent_line_id: 'line-a', created_at: '2026-09-06T09:00:00.000Z',
    }),
    variantRow({
      id: 'line-c', letter: 'C', name: 'Two ribs', parent_session_id: null,
      parent_line_id: 'line-b', created_at: '2026-09-07T09:00:00.000Z',
    }),
  ];
}

function meetingRow(
  lineId: string,
  id: string,
  seq: number,
  endedAt: string,
  revisionIds: string[],
): Record<string, unknown> {
  return {
    id, title: `Session ${id}`, ended_at: endedAt, participant_count: 3,
    line_id: lineId, seq, revision_ids: revisionIds,
  };
}

function lineWithId(lines: readonly ReviewLine[], id: string): ReviewLine | null {
  return lines.find((line) => line.id === id) ?? null;
}

describe('placementSlotsFor — the saved positions a line opens on', () => {
  async function readChain(): Promise<ReviewLine[]> {
    answerWith(chainRows());
    return listLines(REVIEW);
  }

  it('answers the line\'s own slot and then every variant above it, nearest first', async () => {
    const lines = await readChain();
    // Variant C has had nothing moved on it yet, so its models stand wherever the line
    // above it last put them. Stopping at its own empty slot would open the room on the
    // main line's positions and quietly undo two variants' worth of framing.
    expect(placementSlotsFor(REVIEW, lineWithId(lines, 'line-c'))).toEqual(['line-c', 'line-b', 'line-a']);
  });

  it('stops at the last variant, because the main line\'s positions are not a slot', async () => {
    const lines = await readChain();
    expect(placementSlotsFor(REVIEW, lineWithId(lines, 'line-a'))).toEqual(['line-a']);
  });

  it('answers [] for the main line and for no line at all', async () => {
    const lines = await readChain();
    expect(placementSlotsFor(REVIEW, lineWithId(lines, 'line-main'))).toEqual([]);
    expect(placementSlotsFor(REVIEW, null)).toEqual([]);
  });

  it('reads the chain off the line\'s own review when the caller has no id to hand', async () => {
    // lib/scene/showCurationModel is given a line and not a review, and it decides this
    // synchronously while a scene is going up. [] there is not a neutral answer: it
    // opens every variant on the main line's positions.
    const lines = await readChain();
    expect(placementSlotsFor(null, lineWithId(lines, 'line-c'))).toEqual(['line-c', 'line-b', 'line-a']);
  });
});

describe('cachedLines', () => {
  it('answers [] for a review whose lines were never read, without reading them', async () => {
    // A page that is not a room, and an install with no database. Every caller reads []
    // as "no chain to walk", which is the pre-BX answer and the right one for a review
    // with no lines — so this must not become a read that a lobby page waits on.
    expect(cachedLines('review-never-read')).toEqual([]);
    expect(cachedLines(null)).toEqual([]);
    expect(cachedLines('')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('answers the lines a read already put there, and reads the table once', async () => {
    answerWith(chainRows());
    const lines = await listLines(REVIEW);
    expect(cachedLines(REVIEW)).toEqual(lines);
    expect(cachedLines(REVIEW).map((line) => line.id)).toEqual(['line-main', 'line-a', 'line-b', 'line-c']);
    expect(calls.filter((call) => call.table === 'review_lines' && call.op === 'select')).toHaveLength(1);
  });
});

describe('originRevisionIds — the walk up the parent lines', () => {
  it('answers the nearest line above it that has met, not the main line and not null', async () => {
    answerByTableAndLine(
      { review_lines: chainRows() },
      {
        // C has never met, and neither has B above it…
        'line-c': [],
        'line-b': [],
        // …so the answer is A's, which met and was looking at Rev A.
        'line-a': [meetingRow('line-a', 'sess-a1', 1, '2026-09-08T16:00:00.000Z', ['r-a'])],
        // The main line has moved on since, and its model is the one C is an alternative to.
        'line-main': [meetingRow('line-main', 'sess-3', 3, '2026-09-09T16:00:00.000Z', ['r-main'])],
      },
    );

    await expect(originRevisionIds(REVIEW, 'line-c')).resolves.toEqual(['r-a']);
  });

  it('answers a variant\'s OWN last meeting once it has met, however many lines are above it', async () => {
    answerByTableAndLine(
      { review_lines: chainRows() },
      {
        'line-b': [meetingRow('line-b', 'sess-b1', 1, '2026-09-08T16:00:00.000Z', ['r-b'])],
        'line-a': [meetingRow('line-a', 'sess-a1', 1, '2026-09-09T16:00:00.000Z', ['r-a'])],
        'line-main': [meetingRow('line-main', 'sess-3', 3, '2026-09-10T16:00:00.000Z', ['r-main'])],
      },
    );

    // B2 starts from B1. Answering A's model here would put the people on B back on a
    // scene they explored away from a meeting ago.
    await expect(originRevisionIds(REVIEW, 'line-b')).resolves.toEqual(['r-b']);
  });
});

describe('a merge is the business of the line it went into', () => {
  /** Variant B, merged into Variant A after the main line last met. */
  const mergedIntoVariant = variantRow({
    id: 'line-b', letter: 'B', name: 'Two ribs', status: 'adopted', parent_session_id: null,
    parent_line_id: 'line-a', created_at: '2026-09-06T09:00:00.000Z',
    closed_at: '2026-09-20T16:00:00.000Z', merged_into_line_id: 'line-a',
    adopted_revision_ids: ['r-merged'],
  });
  const MAIN_SESSIONS = {
    'line-main': [meetingRow('line-main', 'sess-3', 3, '2026-09-09T16:00:00.000Z', ['r-main'])],
    'line-a': [],
    'line-b': [],
  };

  it('does not change what the main line opens on', async () => {
    answerByTableAndLine(
      { review_lines: [mainRow(), variantRow({ parent_line_id: 'line-main' }), mergedIntoVariant] },
      MAIN_SESSIONS,
    );

    // Counting every merged variant of a review against its main line would open the
    // main line's room on a model nobody took a decision about there, while the map
    // goes on drawing the green return into Variant A.
    await expect(originRevisionIds(REVIEW, 'line-main')).resolves.toEqual(['r-main']);
  });

  it('is what the variant it went into opens on, until that variant meets again', async () => {
    answerByTableAndLine(
      { review_lines: [mainRow(), variantRow({ parent_line_id: 'line-main' }), mergedIntoVariant] },
      MAIN_SESSIONS,
    );

    // A variant is a destination now, so a merge into it is the same fact a merge into
    // the main line has always been: the model the people on that line are looking at.
    await expect(originRevisionIds(REVIEW, 'line-a')).resolves.toEqual(['r-merged']);
  });

  it('still counts a merge that named no destination, which is a row from before batch BX', async () => {
    answerByTableAndLine(
      {
        review_lines: [
          mainRow(),
          variantRow({
            id: 'line-old', letter: 'Z', status: 'adopted', closed_at: '2026-09-20T16:00:00.000Z',
            adopted_revision_ids: ['r-old'],
          }),
        ],
      },
      MAIN_SESSIONS,
    );

    // Every merge that happened before this batch went into the main line, because that
    // was the only line a variant could be taken into. Reading such a row as "went
    // nowhere" would drop the model a review adopted months ago.
    await expect(originRevisionIds(REVIEW, 'line-main')).resolves.toEqual(['r-old']);
  });
});

// ─── A database that has not been upgraded since batch BX ───────────────────

describe('a line read on a database without batch BX\'s columns', () => {
  /** Answers 42703 for the wide column list and the rows for the narrow one. */
  function routeMissingColumns(asked: string[]): void {
    route.current = (table) => {
      if (table !== 'review_lines') return { data: [], error: null };
      const selects = calls.filter((call) => call.table === table && call.op === 'select');
      const columns = String(selects[selects.length - 1]?.args[0] ?? '');
      asked.push(columns);
      if (columns.includes('parent_line_id')) {
        return { data: null, error: { code: '42703', message: 'column "parent_line_id" does not exist' } };
      }
      return { data: [mainRow(), variantRow()], error: null };
    };
  }

  it('asks again without them, and reads every variant as one that came from the main line', async () => {
    const asked: string[] = [];
    routeMissingColumns(asked);

    const lines = await listLines(REVIEW);
    expect(lines.map((line) => line.id)).toEqual(['line-main', 'line-a']);
    // Such an install has no variant of a variant and no merge into one, because it
    // could not write either. A null is the truth about the row, and "from the main
    // line" is where every reader then puts it.
    expect(lines[1]).toMatchObject({ parentLineId: null, mergedIntoLineId: null, dropReason: null });

    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('parent_line_id');
    expect(asked[1]).toContain('parent_session_id');
    for (const gone of ['parent_line_id', 'merged_into_line_id', 'drop_reason']) {
      expect(asked[1]).not.toContain(gone);
    }
  });

  it('does the same for the lobby\'s read of many reviews at once', async () => {
    const asked: string[] = [];
    routeMissingColumns(asked);

    // One lobby card per review, and every card carries a miniature of that review's
    // map: a column list this database does not have would empty all forty of them.
    const grouped = await listLinesForReviews([REVIEW]);
    expect(grouped[REVIEW]?.map((line) => line.id)).toEqual(['line-main', 'line-a']);
    expect(asked).toHaveLength(2);
  });

  it('answers [] for a refusal that is not about a column, without asking twice', async () => {
    let asks = 0;
    route.current = (table) => {
      if (table !== 'review_lines') return { data: [], error: null };
      asks++;
      return { data: null, error: { code: '42501', message: 'permission denied for table review_lines' } };
    };

    await expect(listLines(REVIEW)).resolves.toEqual([]);
    // Fewer columns do not answer a permission refusal, so a retry would only make the
    // room wait twice as long to be told no — and then show a review with no lines.
    expect(asks).toBe(1);
  });
});

// ─── The cards a line is carrying ───────────────────────────────────────────

describe('listOpenLineItems', () => {
  const openRisk = {
    id: 'item-1', type: 'RISK', title: 'Hinge pin wears', description: 'After 4k cycles.',
    priority: 'High', status: 'Open', assignee: 'Ana', created_at: '2026-09-02T10:00:00.000Z',
    session: { id: 'sess-2', line_id: 'line-main', seq: 2 },
  };

  it('answers the line\'s still-open cards, with the session each came from', async () => {
    answerWith([openRisk]);
    const items = await listOpenLineItems(asLine(mainRow()));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'item-1', type: 'RISK', fromSeq: 2, fromSessionId: 'sess-2' });
  });

  it('asks for the cards on THIS line only, still open', async () => {
    answerWith([]);
    await listOpenLineItems(asLine(mainRow()));
    const eq = calls.find((call) => call.op === 'eq');
    const included = calls.find((call) => call.op === 'in');
    expect(eq?.args).toEqual(['line_id', 'line-main']);
    expect(included?.args[0]).toBe('status');
    expect(included?.args[1]).toEqual(['Open', 'In Review']);
  });

  it('answers [] for no line, for a first meeting, and for a database without line_id', async () => {
    await expect(listOpenLineItems(null)).resolves.toEqual([]);
    expect(calls).toHaveLength(0);

    route.current = () => ({ data: null, error: { code: '42703', message: 'no column' } });
    await expect(listOpenLineItems(asLine(mainRow()))).resolves.toEqual([]);
  });

  it('drops a row whose type or status this code has never heard of', async () => {
    answerWith([openRisk, { ...openRisk, id: 'item-2', type: 'OBSERVATION' }, { ...openRisk, id: 'item-3', status: 'Parked' }]);
    const items = await listOpenLineItems(asLine(mainRow()));
    expect(items.map((item) => item.id)).toEqual(['item-1']);
  });
});

// ─── Editing one of them ────────────────────────────────────────────────────

describe('updateLineItem', () => {
  it('writes the tracker row and the history entry, because the tracker needs both', async () => {
    answerWith([]);
    route.current = () => ({ data: null, error: null });
    await expect(updateLineItem('item-1', { status: 'Approved' }, 'Robin')).resolves.toBe(true);
    const update = calls.find((call) => call.op === 'update');
    expect(update?.table).toBe('tracker_items');
    expect(update?.args[0]).toMatchObject({ status: 'Approved' });
    expect(update?.args[0]).toHaveProperty('updated_at');
    const history = calls.find((call) => call.table === 'tracker_status_history' && call.op === 'insert');
    expect(history?.args[0]).toEqual({ item_id: 'item-1', status: 'Approved', changed_by: 'Robin' });
  });

  it('answers false when the write did not land, so the panel can put the value back', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    route.current = () => ({ data: null, error: { message: 'nope' } });
    await expect(updateLineItem('item-1', { status: 'Approved' }, 'Robin')).resolves.toBe(false);
    error.mockRestore();
  });

  it('still answers true when only the history entry failed', async () => {
    // The card IS changed. A missing history entry costs the tracker the date it
    // would have said the card closed on, which is a smaller loss than pretending
    // the change did not happen.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    route.current = (table) =>
      table === 'tracker_status_history' ? { data: null, error: { message: 'nope' } } : { data: null, error: null };
    await expect(updateLineItem('item-1', { status: 'Rejected' }, 'Robin')).resolves.toBe(true);
    error.mockRestore();
  });

  it('writes no history for a change that is not a status change', async () => {
    route.current = () => ({ data: null, error: null });
    await updateLineItem('item-1', { assignee: 'Ana' }, 'Robin');
    expect(calls.filter((call) => call.table === 'tracker_status_history')).toHaveLength(0);
  });
});

// ─── The cards the map counts ───────────────────────────────────────────────

describe('listReviewCardRefs', () => {
  it('answers a review\'s cards with the two lines each of them names', async () => {
    answerWith([
      { id: 'item-1', session_id: 'sess-2', type: 'RISK', title: 'Hinge pin wears', status: 'Open', priority: 'High', line_id: 'line-main', origin_line_id: 'line-a' },
    ]);
    const refs = await listReviewCardRefs(REVIEW);
    expect(refs[0]).toMatchObject({ id: 'item-1', sessionId: 'sess-2', lineId: 'line-main', originLineId: 'line-a' });
  });

  it('answers [] for a database that has no line_id column yet', async () => {
    // The map still draws, without counts — better than no map.
    route.current = () => ({ data: null, error: { code: '42703', message: 'no column' } });
    await expect(listReviewCardRefs(REVIEW)).resolves.toEqual([]);
  });

  it('asks for one review\'s cards and no more', async () => {
    answerWith([]);
    await listReviewCardRefs(REVIEW);
    expect(calls.find((call) => call.op === 'eq')?.args).toEqual(['review_id', REVIEW]);
  });
});
