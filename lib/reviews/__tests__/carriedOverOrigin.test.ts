// What a variant's room starts on: the session it left from.
//
// docs/plan/15-sessions-and-variants.md batch BL. Batch BK made a session start where
// its LINE left off — its own last meeting's model and its own still-open cards. A
// variant that has just been started has no last meeting, and without this it would
// open on the review's whole history: whatever the main line uploaded most recently,
// which is precisely the model the people exploring the variant walked away from, and
// a Capture panel with nothing in it, which is the risks they walked away from too.
//
// So what is pinned here is the two reads the room makes on open, for a line that has
// never met:
//
//   originRevisionIds   the parent session's revision_ids, not the newest ones
//   listCarriedOver     the parent line's cards that were still open AT that session,
//                       labelled with the PARENT line's letter — a card raised in S3
//                       reads "from S3" in a room that is on Variant A, never "from A3"
//
// Plus the two things that must not change: a variant that HAS met starts from its own
// last meeting, and a main line that has met since an adoption starts from that meeting
// rather than from the adoption.
//
// Supabase is faked with a chainable query recorder, the way
// pages/__tests__/trackerLineLabels.test.tsx fakes it: the repo under test is the real
// one, including its row-to-line mapping and its filters.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { db } = vi.hoisted(() => ({
  db: { tables: {} as Record<string, Array<Record<string, unknown>>> },
}));

vi.mock('../../supabase', () => {
  interface Answer {
    data: Array<Record<string, unknown>> | null;
    error: null;
  }
  interface Chain extends Promise<Answer> {
    select: (columns?: string) => Chain;
    eq: (column: string, value: unknown) => Chain;
    in: (column: string, values: readonly unknown[]) => Chain;
    order: (column: string, direction?: { ascending?: boolean }) => Chain;
    limit: (count: number) => Chain;
    single: () => Chain;
    insert: (rows: unknown) => Chain;
  }

  function chain(table: string): Chain {
    const state: {
      filters: Array<[string, unknown]>;
      ins: Array<[string, unknown[]]>;
      order: [string, boolean] | null;
      limit: number | null;
    } = { filters: [], ins: [], order: null, limit: null };

    const run = (): Answer => {
      let rows = (db.tables[table] ?? []).filter((row) =>
        state.filters.every(([column, value]) => row[column] === value),
      );
      for (const [column, values] of state.ins) {
        rows = rows.filter((row) => values.includes(row[column]));
      }
      if (state.order) {
        const [column, ascending] = state.order;
        rows = [...rows].sort(
          (a, b) => String(a[column] ?? '').localeCompare(String(b[column] ?? '')) * (ascending ? 1 : -1),
        );
      }
      if (state.limit !== null) rows = rows.slice(0, state.limit);
      return { data: rows, error: null };
    };

    const methods = {
      select: () => api,
      eq: (column: string, value: unknown) => { state.filters.push([column, value]); return api; },
      in: (column: string, values: readonly unknown[]) => { state.ins.push([column, [...values]]); return api; },
      order: (column: string, direction?: { ascending?: boolean }) => {
        state.order = [column, direction?.ascending !== false];
        return api;
      },
      limit: (count: number) => { state.limit = count; return api; },
      single: () => api,
      insert: () => api,
    };
    const api: Chain = Object.assign(Promise.resolve(null).then(run), methods);
    return api;
  }

  return {
    supabase: { from: (table: string) => chain(table) },
    supabaseConfigured: true,
  };
});

const {
  listCarriedOver,
  listOpenLineItems,
  lineOriginSession,
  originRevisionIds,
  resetLineCache,
} = await import('../linesRepo');
const { toReviewLine } = await import('../lines');

const REVIEW = 'review-1';
const MAIN_ID = 'line-main';
const FRESH_ID = 'line-a';
const MET_ID = 'line-b';

function lineRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_id: REVIEW, kind: 'main', name: 'Main line', letter: null, parent_session_id: null,
    status: 'active', created_by: null, created_by_name: '', created_at: '2026-03-01T09:00:00.000Z',
    closed_at: null, ...overrides,
  };
}

function meeting(id: string, lineId: string, seq: number, endedAt: string, revisionIds: string[]): Record<string, unknown> {
  return {
    id, review_id: REVIEW, line_id: lineId, seq, ended_at: endedAt, created_at: endedAt,
    title: `Session ${id}`, participant_count: 4, model_name: 'Bracket', revision_ids: revisionIds,
  };
}

function card(id: string, lineId: string, session: Record<string, unknown>, status: string): Record<string, unknown> {
  return {
    id, review_id: REVIEW, line_id: lineId, origin_line_id: lineId, session_id: session['id'],
    type: 'RISK', title: `Risk ${id}`, description: '', priority: 'High', status, assignee: null,
    created_at: session['ended_at'], session,
  };
}

const SESS_2 = meeting('sess-2', MAIN_ID, 2, '2026-05-02T16:00:00.000Z', ['r-a']);
const SESS_3 = meeting('sess-3', MAIN_ID, 3, '2026-05-03T16:00:00.000Z', ['r-b']);
const SESS_A1 = meeting('sess-a1', MET_ID, 1, '2026-05-06T16:00:00.000Z', ['r-b2']);

const LINES = [
  lineRow({ id: MAIN_ID }),
  lineRow({ id: FRESH_ID, kind: 'variant', name: 'Steel hinge pin', letter: 'A', parent_session_id: 'sess-3', created_at: '2026-05-04T09:00:00.000Z' }),
  lineRow({ id: MET_ID, kind: 'variant', name: 'Weld fix', letter: 'B', parent_session_id: 'sess-3', created_at: '2026-05-05T09:00:00.000Z' }),
];

function seed(): void {
  db.tables['review_lines'] = [...LINES];
  db.tables['tracker_sessions'] = [SESS_2, SESS_3, SESS_A1];
  db.tables['tracker_items'] = [
    card('item-1', MAIN_ID, SESS_2, 'Open'),
    card('item-2', MAIN_ID, SESS_3, 'In Review'),
    // Raised in S4, AFTER the session Variant A left from: the people exploring the
    // variant never saw it and must not be handed it.
    card('item-3', MAIN_ID, meeting('sess-4', MAIN_ID, 4, '2026-05-07T16:00:00.000Z', ['r-c']), 'Open'),
    // Dealt with before the variant was started.
    card('item-4', MAIN_ID, SESS_2, 'Approved'),
    card('item-b1', MET_ID, SESS_A1, 'Open'),
  ];
  // The review has met since, so there IS a session after the parent one.
  db.tables['tracker_sessions'] = [...db.tables['tracker_sessions'], meeting('sess-4', MAIN_ID, 4, '2026-05-07T16:00:00.000Z', ['r-c'])];
}

function lineOf(id: string) {
  const row = LINES.find((line) => line['id'] === id);
  return toReviewLine(row ?? null);
}

// ─── Batch BX: a variant started from ANOTHER variant ───────────────────────
//
// Until this batch a variant could only leave from one of the MAIN line's meetings, so
// the cards it opens on had one place to come from. It can now be started from a
// variant — including one that has never met and therefore has no cards of its own to
// hand on. A room that stopped at that parent would open on an empty Capture panel in a
// review with risks still on it, which reads as "nothing to carry" rather than as "we
// could not find them".

const UNMET_PARENT_ID = 'line-c';
const CHILD_OF_UNMET_ID = 'line-d';
const MET_PARENT_ID = 'line-e';
const CHILD_OF_MET_ID = 'line-f';

const SESS_E1 = meeting('sess-e1', MET_PARENT_ID, 1, '2026-05-08T16:00:00.000Z', ['r-e']);

const BX_LINES = [
  // Variant C left the main line with no meeting to leave from, and has never met.
  lineRow({
    id: UNMET_PARENT_ID, kind: 'variant', name: 'Lighter frame', letter: 'C',
    parent_session_id: null, parent_line_id: MAIN_ID, created_at: '2026-05-08T09:00:00.000Z',
  }),
  // Variant D was started from Variant C, not from the main line.
  lineRow({
    id: CHILD_OF_UNMET_ID, kind: 'variant', name: 'Two ribs', letter: 'D',
    parent_session_id: null, parent_line_id: UNMET_PARENT_ID, created_at: '2026-05-09T09:00:00.000Z',
  }),
  // Variant E HAS met, and left one risk open on itself.
  lineRow({
    id: MET_PARENT_ID, kind: 'variant', name: 'Steel hinge pin', letter: 'E',
    parent_session_id: 'sess-3', parent_line_id: MAIN_ID, created_at: '2026-05-10T09:00:00.000Z',
  }),
  // Variant F was started from Variant E afterwards, and has not met.
  lineRow({
    id: CHILD_OF_MET_ID, kind: 'variant', name: 'Weld fix', letter: 'F',
    parent_session_id: null, parent_line_id: MET_PARENT_ID, created_at: '2026-05-11T09:00:00.000Z',
  }),
];

/** The seeded review plus the four lines above it, and a cache that has not seen them. */
function seedBX(): void {
  db.tables['review_lines'] = [...LINES, ...BX_LINES];
  db.tables['tracker_sessions'] = [...(db.tables['tracker_sessions'] ?? []), SESS_E1];
  db.tables['tracker_items'] = [
    ...(db.tables['tracker_items'] ?? []),
    card('item-e1', MET_PARENT_ID, SESS_E1, 'Open'),
  ];
  resetLineCache();
}

/** A line as the repo would read it back, rather than as the fixture above states it. */
function lineFromDb(id: string) {
  const row = (db.tables['review_lines'] ?? []).find((line) => line['id'] === id);
  return toReviewLine(row ?? null);
}

beforeEach(() => {
  for (const key of Object.keys(db.tables)) delete db.tables[key];
  seed();
  resetLineCache();
});

describe('the meeting a line starts from', () => {
  it('is the parent session for a variant that has never met', async () => {
    const origin = await lineOriginSession(lineOf(FRESH_ID));
    expect(origin?.id).toBe('sess-3');
    expect(origin?.seq).toBe(3);
  });

  it('is its own last meeting for a variant that has met', async () => {
    // A2 starts from A1, not from the main line's S3: the variant has a history of
    // its own from the moment it holds its first meeting.
    const origin = await lineOriginSession(lineOf(MET_ID));
    expect(origin?.id).toBe('sess-a1');
  });

  it('is the main line\'s own last meeting, which has no parent to fall back to', async () => {
    const origin = await lineOriginSession(lineOf(MAIN_ID));
    expect(origin?.id).toBe('sess-4');
  });
});

describe('the scene a variant\'s room opens on', () => {
  it('is the parent session\'s model, not the review\'s newest', async () => {
    // The main line went on to Rev C after the variant was started. Opening the
    // variant on Rev C would put the people exploring it back on the model they
    // walked away from, which is the whole reason they started it.
    expect(await originRevisionIds(REVIEW, FRESH_ID)).toEqual(['r-b']);
  });

  it('is its own last meeting\'s model once the variant has met', async () => {
    expect(await originRevisionIds(REVIEW, MET_ID)).toEqual(['r-b2']);
  });

  it('is the main line\'s last meeting, unchanged by any of this', async () => {
    expect(await originRevisionIds(REVIEW, MAIN_ID)).toEqual(['r-c']);
  });

  it('is what an adoption put on the main line, while no meeting has superseded it', async () => {
    db.tables['review_lines'] = [
      ...LINES,
      lineRow({
        id: 'line-old', kind: 'variant', name: 'Glass-filled', letter: 'Z', status: 'adopted',
        closed_at: '2026-05-09T16:00:00.000Z', adopted_revision_ids: ['r-b2'],
      }),
    ];
    resetLineCache();
    expect(await originRevisionIds(REVIEW, MAIN_ID)).toEqual(['r-b2']);
  });

  it('is the newer meeting once the main line has met since the adoption', async () => {
    // Nothing has to clear the column afterwards: a meeting held after the adoption
    // wrote its own revision_ids and is the newer fact about what is on screen.
    db.tables['review_lines'] = [
      ...LINES,
      lineRow({
        id: 'line-old', kind: 'variant', name: 'Glass-filled', letter: 'Z', status: 'adopted',
        closed_at: '2026-05-05T16:00:00.000Z', adopted_revision_ids: ['r-b2'],
      }),
    ];
    resetLineCache();
    expect(await originRevisionIds(REVIEW, MAIN_ID)).toEqual(['r-c']);
  });

  it('opens a line it cannot find on the main line, rather than not opening', async () => {
    // A stale `?line=` — a variant somebody deleted, an id from another review — is
    // still a room that has to open, and the main line is the honest answer.
    expect(await originRevisionIds(REVIEW, 'line-that-does-not-exist')).toEqual(['r-c']);
  });

  it('is nothing at all for a review with no id', async () => {
    expect(await originRevisionIds(null, null)).toBeNull();
  });
});

describe('the cards a variant\'s room starts with', () => {
  it('are the parent line\'s, still open at the session it left from', async () => {
    const carried = await listCarriedOver(lineOf(FRESH_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-1', 'item-2']);
  });

  it('leave out a card raised after that session, and one already dealt with', async () => {
    const carried = await listCarriedOver(lineOf(FRESH_ID));
    expect(carried.map((item) => item.id)).not.toContain('item-3');
    expect(carried.map((item) => item.id)).not.toContain('item-4');
  });

  it('label them with the line they are actually on, not the room\'s', async () => {
    // "from S2" in a room that is on Variant A. "A2" would be a meeting this variant
    // has never held, on a card it did not raise.
    const carried = await listCarriedOver(lineOf(FRESH_ID));
    expect(carried.map((item) => item.fromLabel)).toEqual(['S2', 'S3']);
  });

  it('are the same tracker items, not copies', async () => {
    const carried = await listCarriedOver(lineOf(FRESH_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-1', 'item-2']);
    // Nothing was written to get them: the ids are the tracker's own rows.
    expect(db.tables['tracker_items']?.filter((row) => row['line_id'] === FRESH_ID)).toEqual([]);
  });

  it('are its own once the variant has met', async () => {
    const carried = await listCarriedOver(lineOf(MET_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-b1']);
    expect(carried.map((item) => item.fromLabel)).toEqual(['B1']);
  });

  it('are nothing at all for a variant that has met and closed everything', async () => {
    db.tables['tracker_items'] = (db.tables['tracker_items'] ?? []).map((row) =>
      row['id'] === 'item-b1' ? { ...row, status: 'Rejected' } : row,
    );
    // Reaching back to the parent here would resurrect the risks the people exploring
    // the variant dealt with on purpose.
    expect(await listCarriedOver(lineOf(MET_ID))).toEqual([]);
  });

  it('are the main line\'s own open cards, exactly as batch BK left them', async () => {
    const carried = await listCarriedOver(lineOf(MAIN_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(carried.map((item) => item.fromLabel)).toEqual(['S2', 'S3', 'S4']);
  });

  it('are nothing for a room with no line', async () => {
    expect(await listCarriedOver(null)).toEqual([]);
  });

  it('leave listOpenLineItems answering only the line it was asked about', async () => {
    // The read the map and the flush use is unchanged: one line, its own cards.
    expect((await listOpenLineItems({ id: FRESH_ID })).map((item) => item.id)).toEqual([]);
    expect((await listOpenLineItems({ id: MET_ID })).map((item) => item.id)).toEqual(['item-b1']);
  });
});

describe('the cards a variant of ANOTHER variant starts with (batch BX)', () => {
  it('are the open cards of the line it was started from, labelled with that line', async () => {
    seedBX();
    const carried = await listCarriedOver(lineFromDb(CHILD_OF_MET_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-e1']);
    // "from E1" in a room that is on Variant F. "F1" would be a meeting Variant F has
    // never held, on a card it did not raise — the same lie the main line's "S2" was
    // kept out of in batch BL, one line further down.
    expect(carried.map((item) => item.fromLabel)).toEqual(['E1']);
  });

  it('are the whole of that line\'s open cards when no meeting is named', async () => {
    seedBX();
    // Variant C left the main line without a meeting to leave from, so there is no
    // moment to narrow to and everything the main line still has open is what C is a
    // continuation of — including the card raised in S4, which batch BL would have
    // left out had C named a session.
    const carried = await listCarriedOver(lineFromDb(UNMET_PARENT_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(carried.map((item) => item.fromLabel)).toEqual(['S2', 'S3', 'S4']);
  });

  it('keep coming from above while the line it was started from has never met', async () => {
    seedBX();
    // Variant C has no cards and no meetings, so stopping at it would open Variant D on
    // an empty Capture panel in a review with two risks still open on the main line —
    // and the people on D would explore a third answer with no idea what the first two
    // left unresolved.
    const carried = await listCarriedOver(lineFromDb(CHILD_OF_UNMET_ID));
    expect(carried.map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    // Still the main line's numbering: the cards were raised there, two lines up.
    expect(carried.map((item) => item.fromLabel)).toEqual(['S2', 'S3', 'S4']);
  });

  it('are nothing for a variant started from a line that has met and closed everything', async () => {
    seedBX();
    db.tables['tracker_items'] = (db.tables['tracker_items'] ?? []).map((row) =>
      row['id'] === 'item-e1' ? { ...row, status: 'Rejected' } : row,
    );
    // The walk stops at a line that HAS met, and so it must: Variant E had the chance to
    // deal with its risk and did. Handing it to Variant F anyway would put a rejected
    // risk back in front of a meeting as though nobody had decided anything about it.
    expect(await listCarriedOver(lineFromDb(CHILD_OF_MET_ID))).toEqual([]);
  });

  it('are nothing at all for a variant that has met and closed everything itself', async () => {
    seedBX();
    db.tables['tracker_items'] = (db.tables['tracker_items'] ?? []).map((row) =>
      row['id'] === 'item-e1' ? { ...row, status: 'Rejected' } : row,
    );
    // The same rule one line up, and the reason the walk is only ever started for a line
    // with no meeting of its own.
    expect(await listCarriedOver(lineFromDb(MET_PARENT_ID))).toEqual([]);
  });
});
