// Tests for lib/trackerBridge.ts — the line a meeting is recorded on
// (docs/plan/15-sessions-and-variants.md batch BK).
//
// The design-review and revision halves of this module are pinned in
// trackerBridge.reviews.test.ts and its labels in trackerBridge.labels.test.ts. What
// is pinned here is the third thing a meeting has to say about itself: which run of
// meetings it continued, and which number it is on it — because a session with no
// line is one the map cannot place and a card that cannot say "Main line · S3".
//
// `listLines` alone is faked. resolveLine, ensureMainLine and nextSessionSeq are the
// real ones, so what these tests assert is the numbering the tracker actually gets,
// not a stub of it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InsightCard } from '../../types';
import type { ModelRevision } from '../reviews/revisionsRepo';

const { state } = vi.hoisted(() => ({
  state: {
    lines: [] as Array<Record<string, unknown>>,
    /** Stands in for a database with no review_lines table at all. */
    linesError: false,
    /** The sessions already on a line, as `seq` rows, for the numbering read. */
    existingSeqs: [] as Array<{ seq: number | null }>,
    sessions: [] as Array<Record<string, unknown>>,
    items: [] as Array<Record<string, unknown>>,
    sessionId: 'sess-3',
    sessionError: null as { code?: string; message?: string } | null,
    stored: [] as ModelRevision[],
  },
}));

interface Answer {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

const settled = new WeakMap<string[], Answer>();

interface QueryChain extends Promise<Answer> {
  select: (...args: unknown[]) => QueryChain;
  insert: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  order: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
  single: (...args: unknown[]) => QueryChain;
}

function chain(table: string, ops: string[], args: Record<string, unknown>): QueryChain {
  const step = (op: string) => (...stepArgs: unknown[]): QueryChain => {
    ops.push(op);
    if (op === 'insert' || op === 'update') Object.assign(args, stepArgs[0] as Record<string, unknown>);
    return chain(table, ops, args);
  };
  // Answered once per query and remembered: every link of the chain builds its own
  // promise, and a router that answered each of them would see one read as three.
  const promise = Promise.resolve().then((): Answer => {
    const remembered = settled.get(ops);
    if (remembered) return remembered;
    const answer = answerFor(table, ops, args);
    settled.set(ops, answer);
    return answer;
  });
  return Object.assign(promise, {
    select: step('select'),
    insert: step('insert'),
    eq: step('eq'),
    order: step('order'),
    limit: step('limit'),
    single: step('single'),
  });
}

function answerFor(table: string, ops: string[], args: Record<string, unknown>): Answer {
  if (table === 'review_lines') {
    // `linesError` stands in for an install whose database has not re-applied
    // docs/supabase-schema.sql and has no such table at all.
    if (state.linesError) return { data: null, error: { code: '42P01', message: 'no table' } };
    if (ops.includes('insert')) {
      // What the real table answers: the row it was handed, with the id its default
      // gave it. Pushed into the list so the read after a refused insert can find it.
      const row: Record<string, unknown> = { id: 'line-main', ...args };
      state.lines = [...state.lines, row];
      return { data: row, error: null };
    }
    return { data: state.lines, error: null };
  }
  if (table === 'tracker_sessions') {
    if (ops.includes('insert')) {
      state.sessions.push({ ...args });
      return state.sessionError
        ? { data: null, error: state.sessionError }
        : { data: { id: state.sessionId }, error: null };
    }
    // The read nextSessionSeq makes: what numbers this line already has.
    return { data: state.existingSeqs, error: null };
  }
  if (table === 'tracker_items') {
    const rows = (args['rows'] ?? []) as Array<Record<string, unknown>>;
    state.items.push(...rows);
    return { data: null, error: null };
  }
  return { data: null, error: null };
}

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      const ops: string[] = [];
      const args: Record<string, unknown> = {};
      // `insert(rows)` on tracker_items carries a LIST, which the chain records under
      // one key so answerFor can push them all.
      return Object.assign(chain(table, ops, args), {
        insert: (rows: unknown) => {
          ops.push('insert');
          if (Array.isArray(rows)) {
            args['rows'] = rows;
          } else {
            Object.assign(args, rows as Record<string, unknown>);
          }
          return chain(table, ops, args);
        },
      });
    },
  },
  supabaseConfigured: true,
}));

// Only the READ of the revision history is faked. `revisionsOnScreen` is the real
// one, so the revision half of a session row is still the join
// trackerBridge.reviews.test.ts pins. lib/reviews/linesRepo is NOT mocked at all:
// resolveLine, ensureMainLine and nextSessionSeq are the real ones against the
// faked supabase above, so what these tests assert is the numbering the tracker
// actually gets, not a stub of it.
vi.mock('../reviews/revisionsRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reviews/revisionsRepo')>();
  return { ...actual, listModelRevisions: vi.fn(async () => state.stored) };
});

import { flushSessionToTracker } from '../trackerBridge';
import { resetLineCache } from '../reviews/linesRepo';

const REVIEW = 'review-1';

function mainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'line-main', review_id: REVIEW, kind: 'main', name: 'Main line', letter: null,
    parent_session_id: null, status: 'active', created_by: null, created_by_name: '',
    created_at: '2026-09-01T09:00:00.000Z', closed_at: null, ...overrides,
  };
}

function card(overrides: Partial<InsightCard> = {}): InsightCard {
  return {
    id: 'ic-1',
    type: 'RISK',
    title: 'Hinge pin wears',
    description: '',
    agentId: 'SYS.OP',
    timestamp: Date.now(),
    details: { priority: 'High', status: 'Open' },
    ...overrides,
  };
}

async function flush(overrides: Partial<Parameters<typeof flushSessionToTracker>[0]> = {}) {
  await flushSessionToTracker({
    roomId: REVIEW,
    insightCards: [card()],
    participantCount: 4,
    modelName: 'imported',
    reviewId: REVIEW,
    ...overrides,
  });
}

beforeEach(() => {
  state.lines = [mainRow()];
  state.linesError = false;
  state.existingSeqs = [{ seq: 1 }, { seq: 2 }];
  state.sessions = [];
  state.items = [];
  state.sessionId = 'sess-3';
  state.sessionError = null;
  state.stored = [];
  resetLineCache();
});

// ─── The session row ────────────────────────────────────────────────────────

describe('flushSessionToTracker — the line a meeting is on', () => {
  it('records the line the room said it was on, and the next number on it', async () => {
    await flush({ lineId: 'line-main' });

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].line_id).toBe('line-main');
    // Two sessions already on the line, so this one is the third.
    expect(state.sessions[0].seq).toBe(3);
  });

  it('records a variant rather than the main line when the room was on one', async () => {
    state.lines = [mainRow(), mainRow({ id: 'line-a', kind: 'variant', name: 'Weld fix', letter: 'A' })];
    state.existingSeqs = [{ seq: 1 }];

    await flush({ lineId: 'line-a' });

    expect(state.sessions[0].line_id).toBe('line-a');
    // Numbered on ITS line: a variant's second meeting is A2, not the main line's
    // fourth.
    expect(state.sessions[0].seq).toBe(2);
  });

  it('works the main line out for itself when the room knew no line', async () => {
    // A room opened before the line resolved, and every room on an install whose
    // RoomPage has not been upgraded. A meeting still belongs to a line.
    await flush({ lineId: null });

    expect(state.sessions[0].line_id).toBe('line-main');
    expect(state.sessions[0].seq).toBe(3);
  });

  it('creates the main line when the review has never had one', async () => {
    // Every review that met before this batch. Without this the session would be
    // recorded on no line and the map could never place it.
    state.lines = [];
    state.existingSeqs = [];
    await flush({ lineId: null });

    expect(state.sessions[0].line_id).toBe('line-main');
    expect(state.sessions[0].seq).toBe(1);
  });

  it('numbers after the line\'s HIGHEST number, not after a count of them', async () => {
    // A meeting somebody deleted from the tracker must not hand its number to this
    // one: two meetings both called S3 is a map nobody can read.
    state.existingSeqs = [{ seq: 1 }, { seq: 4 }];
    await flush({ lineId: 'line-main' });
    expect(state.sessions[0].seq).toBe(5);
  });

  it('records no line for an ad-hoc session, which has no review to have one', async () => {
    await flush({ roomId: 'room-ad-hoc', reviewId: null, lineId: null });

    expect(state.sessions[0].review_id).toBeNull();
    expect(state.sessions[0].line_id).toBeNull();
    expect(state.sessions[0].seq).toBeNull();
  });

  it('still records the meeting when the database has no review_lines table', async () => {
    // 42P01 on an install that has not re-applied docs/supabase-schema.sql. A meeting
    // that ends is recorded with no line, exactly as every meeting was before this
    // batch; it is not lost.
    state.linesError = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await flush({ lineId: null });
    error.mockRestore();

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].line_id).toBeNull();
    expect(state.sessions[0].seq).toBeNull();
  });

  it('writes no items when the session row could not be created', async () => {
    state.sessionError = { message: 'nope' };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await flush({ lineId: 'line-main' });
    error.mockRestore();
    expect(state.items).toHaveLength(0);
  });
});

// ─── The card rows ──────────────────────────────────────────────────────────

describe('flushSessionToTracker — the line a card came from', () => {
  it('puts the line on every card, as both where it is and where it was raised', async () => {
    await flush({ insightCards: [card({ id: 'a' }), card({ id: 'b' })], lineId: 'line-main' });

    expect(state.items).toHaveLength(2);
    for (const item of state.items) {
      expect(item.line_id).toBe('line-main');
      // The same row at the moment a card is raised. They come apart only when a
      // variant is adopted into the main line, which is batch BL — and origin_line_id
      // is the one that must not move then.
      expect(item.origin_line_id).toBe('line-main');
    }
  });

  it('puts a variant on its cards, not the main line', async () => {
    state.lines = [mainRow(), mainRow({ id: 'line-a', kind: 'variant', letter: 'A', name: 'Weld fix' })];
    await flush({ lineId: 'line-a' });

    expect(state.items[0].line_id).toBe('line-a');
    expect(state.items[0].origin_line_id).toBe('line-a');
  });

  it('puts no line on the cards of an ad-hoc session', async () => {
    await flush({ roomId: 'room-ad-hoc', reviewId: null, lineId: null });

    expect(state.items[0].line_id).toBeNull();
    expect(state.items[0].origin_line_id).toBeNull();
  });

  it('keeps writing everything it wrote before', async () => {
    // The line is two more columns on a row that already carried a review, a
    // revision, a part and an author. None of them may be disturbed by it.
    state.stored = [{
      id: 'rev-b', reviewId: REVIEW, line: 'bracket', revision: 'B', hash: 'b2'.repeat(32),
      fileName: 'bracket.step', size: 1024, notes: '', uploadedBy: null,
      uploadedByName: '', createdAt: '2026-09-01T09:00:00.000Z',
    }];
    await flush({
      lineId: 'line-main',
      insightCards: [card({ source: 'manual', createdByName: 'Maria Okafor', agentId: '' })],
      onScreen: [{ line: 'bracket', revision: 'B', visible: true }],
    });

    expect(state.items[0]).toMatchObject({
      review_id: REVIEW,
      raised_on_revision: 'rev-b',
      source: 'manual',
      created_by_name: 'Maria Okafor',
      line_id: 'line-main',
      origin_line_id: 'line-main',
    });
    expect(state.sessions[0].revision_ids).toEqual(['rev-b']);
  });
});
