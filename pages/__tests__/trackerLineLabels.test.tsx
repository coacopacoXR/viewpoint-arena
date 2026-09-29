// The tracker's lines: what a card says about the run of meetings it came from, and
// the filter that narrows a design review to one of them.
//
// docs/plan/15-sessions-and-variants.md batch BK. The labels themselves are decided in
// lib/reviews/lines.ts and pinned there; what is pinned here is that the page actually
// asks for them — that a card on the board carries "Main line · S3" beside its revision
// continuity rather than instead of it, that a review with a variant can be filtered to
// one line, and that every card recorded before this batch (no line at all) still shows
// exactly where it showed before.
//
// Supabase, the curations read and the revisions read are faked the way
// pages/__tests__/trackerDesignReview.test.tsx fakes them: the page under test is the
// real one, including the board's dnd-kit columns. lib/reviews/linesRepo is NOT mocked
// — it reads the faked `review_lines` table, so the labels here come out of the real
// row-to-line mapping.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  adoptedCardLabel,
  lineFilterLabel,
  lineStatusWord,
  mergedIntoLabel,
  toReviewLine,
  type ReviewLine,
} from '../../lib/reviews/lines';

const { answers, curationsMock, revisionsMock } = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  return {
    answers: tables,
    curationsMock: { list: vi.fn() },
    revisionsMock: { list: vi.fn() },
  };
});

vi.mock('../../lib/supabase', () => {
  interface Answer { data: Array<Record<string, unknown>> | null; error: null }
  interface Chain extends Promise<Answer> {
    select: (columns?: string) => Chain;
    eq: (column: string, value: unknown) => Chain;
    in: (column: string, values: readonly unknown[]) => Chain;
    order: (column: string, ascending?: { ascending?: boolean }) => Chain;
    limit: (count: number) => Chain;
    single: () => Chain;
    maybeSingle: () => Chain;
    insert: (rows: unknown) => Chain;
    update: (rows: unknown) => Chain;
    delete: () => Chain;
  }
  function chain(table: string): Chain {
    const methods = {
      select: () => chain(table),
      eq: () => chain(table),
      in: () => chain(table),
      order: () => chain(table),
      limit: () => chain(table),
      single: () => chain(table),
      maybeSingle: () => chain(table),
      insert: () => chain(table),
      update: () => chain(table),
      delete: () => chain(table),
    };
    return Object.assign(Promise.resolve({ data: answers[table] ?? [], error: null }), methods);
  }
  return {
    supabase: { from: (table: string) => chain(table) },
    supabaseConfigured: true,
  };
});

vi.mock('../../lib/curationsRepo', () => ({
  listAllCurations: () => curationsMock.list(),
}));

vi.mock('../../lib/reviews/revisionsRepo', () => ({
  listModelRevisions: (reviewId: string) => revisionsMock.list(reviewId),
}));

vi.mock('../../components/UI/IntegrationsPanel', () => ({ default: () => null }));

const TrackerPage = (await import('../TrackerPage')).default;
const { resetLineCache } = await import('../../lib/reviews/linesRepo');

const REVIEW_ID = 'review-1';
const MAIN_ID = 'line-main';
const VARIANT_ID = 'line-a';

const MAIN_ROW = {
  id: MAIN_ID, review_id: REVIEW_ID, kind: 'main', name: 'Main line', letter: null,
  parent_session_id: null, status: 'active', created_by: null, created_by_name: '',
  created_at: '2026-03-01T09:00:00.000Z', closed_at: null,
};

const VARIANT_ROW = {
  id: VARIANT_ID, review_id: REVIEW_ID, kind: 'variant', name: 'Weld fix', letter: 'A',
  parent_session_id: 'meet-2', status: 'active', created_by: null, created_by_name: 'Robin',
  created_at: '2026-05-04T09:00:00.000Z', closed_at: null,
};

/**
 * A variant that was merged INTO Variant A — batch BX's case, and the one the tracker
 * has to name. `merged_into_line_id` is the column that says where it went; without it
 * the card can only say "adopted", which is true and sends the reader to the wrong line.
 */
const MERGED_INTO_A_ID = 'line-b';
/** When the merge happened: the line's own closing moment and the card's stamp agree. */
const MERGED_AT = '2026-05-08T16:00:00.000Z';
const MERGED_INTO_A_ROW = {
  id: MERGED_INTO_A_ID, review_id: REVIEW_ID, kind: 'variant', name: 'Lighter frame', letter: 'B',
  parent_session_id: 'meet-b1', parent_line_id: VARIANT_ID, status: 'adopted',
  merged_into_line_id: VARIANT_ID, created_by: null, created_by_name: 'Robin',
  created_at: '2026-05-06T09:00:00.000Z', closed_at: MERGED_AT,
};

function meeting(id: string, seq: number, lineId: string, endedAt: string): Record<string, unknown> {
  return {
    id, room_id: REVIEW_ID, title: `Design Review — ${endedAt.slice(0, 10)}`,
    ended_at: endedAt, created_at: endedAt, participant_count: 4, model_name: 'qwen',
    labels: {}, review_id: REVIEW_ID, revision_ids: [], line_id: lineId, seq,
  };
}

function card(id: string, title: string, session: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, session_id: session['id'], type: 'RISK', title, description: '', priority: 'High',
    status: 'Open', assignee: null, due_date: null, component_reference: null, department: null,
    agent_id: 'SYS.OP', source_message_ids: null, affected_requirement_ids: null, impact: null,
    mitigation_strategy: null, design_driver: null, tradeoff_analysis: null,
    created_at: session['ended_at'], updated_at: session['ended_at'],
    review_id: REVIEW_ID, raised_on_revision: null, part_node_id: null, part_name: null,
    created_by_name: null, source: 'ai',
    line_id: session['line_id'], origin_line_id: session['line_id'],
    session, ...overrides,
  };
}

const MEET_2 = meeting('meet-2', 2, MAIN_ID, '2026-05-02T16:00:00.000Z');
const MEET_3 = meeting('meet-3', 3, MAIN_ID, '2026-05-03T16:00:00.000Z');
const MEET_A2 = meeting('meet-a2', 2, VARIANT_ID, '2026-05-06T16:00:00.000Z');

/** Three cards: two on the main line's S3, one on Variant A's A2. */
function seedCards(): void {
  answers['tracker_items'] = [
    card('item-1', 'Hinge pin wears', MEET_3),
    card('item-2', 'Seal weeps at 80°C', MEET_3),
    card('item-3', 'Weld cracks at the fillet', MEET_A2),
  ];
}

async function renderTracker() {
  await act(async () => {
    render(<MemoryRouter><TrackerPage /></MemoryRouter>);
  });
  // The reviews, the revisions and the lines are read after the first paint.
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(screen.queryByText('Loading tracker…')).toBeNull());
}

function selectReview(): void {
  fireEvent.change(screen.getByLabelText('Filter by design review'), { target: { value: REVIEW_ID } });
}

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  answers['tracker_sessions'] = [MEET_3, MEET_2, MEET_A2];
  answers['tracker_status_history'] = [];
  answers['review_lines'] = [MAIN_ROW, VARIANT_ROW];
  seedCards();
  curationsMock.list.mockResolvedValue([{ id: REVIEW_ID, title: 'Bracket assembly', description: '', updatedAt: '2026-05-03T16:00:00.000Z' }]);
  revisionsMock.list.mockResolvedValue([]);
  // The lines are cached per review for the life of the module; a test that changes
  // what the table holds has to say so.
  resetLineCache();
});

afterEach(cleanup);

// ─── The label on a card ────────────────────────────────────────────────────

describe('the tracker — a card says which line and session it came from', () => {
  it('says "Main line · S3" on a card from the main line', async () => {
    await renderTracker();
    // Two of the three seeded cards were raised in S3, and both say so.
    expect(screen.getAllByText('Main line · S3')).toHaveLength(2);
  });

  it('says "Variant A · A2" on a card from a variant', async () => {
    await renderTracker();
    expect(screen.getByText('Variant A · A2')).toBeTruthy();
  });

  it('says nothing on a card recorded before lines existed', async () => {
    // Not "Main line · S0", and not a line guessed from the meeting it came from: a
    // card with no line row to name renders the board exactly as it did before.
    answers['tracker_items'] = [
      card('item-9', 'Legacy risk', { ...MEET_3, line_id: null, seq: null }, { line_id: null }),
    ];
    await renderTracker();
    expect(screen.getByText('Legacy risk')).toBeTruthy();
    expect(screen.queryByText(/Main line ·/)).toBeNull();
  });

  it('keeps the revision continuity beside the line, not under it', async () => {
    // The two answer different questions and a reviewer needs both: the line says
    // which run of meetings, the revision says which version of the product.
    revisionsMock.list.mockResolvedValue([
      { id: 'rev-b', reviewId: REVIEW_ID, line: 'Bracket', revision: 'B', hash: 'hash-b', fileName: 'b.step', size: 1, notes: '', uploadedBy: null, uploadedByName: '', createdAt: '2026-04-01T10:00:00.000Z' },
    ]);
    answers['tracker_items'] = [card('item-1', 'Hinge pin wears', MEET_3, { raised_on_revision: 'rev-b' })];
    answers['review_lines'] = [MAIN_ROW, VARIANT_ROW];
    await renderTracker();

    expect(screen.getByText('Main line · S3')).toBeTruthy();
    expect(screen.getByText('Raised on Rev B')).toBeTruthy();
  });

  it('still says where a hand-made card came from when only its meeting knows the line', async () => {
    // A card added through the tracker's own modal names a session and has never
    // written a line_id of its own.
    answers['tracker_items'] = [card('item-5', 'Typed in by hand', MEET_3, { line_id: null })];
    await renderTracker();
    expect(screen.getByText('Main line · S3')).toBeTruthy();
  });
});

// ─── The line filter ────────────────────────────────────────────────────────

describe('the tracker — filtering a design review by line', () => {
  it('offers every line of the review once one is selected', async () => {
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByLabelText('Filter by line')).toBeTruthy());

    const options = Array.from(
      (screen.getByLabelText('Filter by line') as HTMLSelectElement).options,
    ).map((option) => option.text);
    expect(options).toEqual(['All lines', 'Main line', 'Variant A · Weld fix']);
  });

  it('offers no line filter at all until a design review is chosen', async () => {
    // Lines belong to one review; with 'All design reviews' there is nothing to
    // choose between.
    await renderTracker();
    expect(screen.queryByLabelText('Filter by line')).toBeNull();
  });

  it('narrows the board to one line', async () => {
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByLabelText('Filter by line')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Filter by line'), { target: { value: VARIANT_ID } });
    await waitFor(() => expect(screen.queryByText('Hinge pin wears')).toBeNull());
    expect(screen.getByText('Weld cracks at the fillet')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by line'), { target: { value: MAIN_ID } });
    await waitFor(() => expect(screen.getByText('Hinge pin wears')).toBeTruthy());
    expect(screen.queryByText('Weld cracks at the fillet')).toBeNull();
  });

  it('narrows the meeting list to the same line', async () => {
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByLabelText('Filter by line')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Filter by line'), { target: { value: VARIANT_ID } });
    await waitFor(() => expect(screen.getByText('1 sessions · 1 items')).toBeTruthy());
  });

  it('goes back to every line of the review', async () => {
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByLabelText('Filter by line')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Filter by line'), { target: { value: VARIANT_ID } });
    await waitFor(() => expect(screen.queryByText('Hinge pin wears')).toBeNull());
    fireEvent.change(screen.getByLabelText('Filter by line'), { target: { value: 'All' } });
    await waitFor(() => expect(screen.getByText('Hinge pin wears')).toBeTruthy());
    expect(screen.getByText('Weld cracks at the fillet')).toBeTruthy();
  });
});

// ─── The map in the tracker ─────────────────────────────────────────────────

describe('the tracker — the session map above its cards', () => {
  it('is folded away until asked for, and reads nothing until then', async () => {
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByText('Session map')).toBeTruthy());
    expect(screen.queryByRole('img', { name: "Map of this design review's sessions" })).toBeNull();
  });

  it('draws the review\'s lines and sessions when opened', async () => {
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByText('Session map')).toBeTruthy());

    fireEvent.click(screen.getByText('Session map'));
    await waitFor(() => expect(screen.getByText('S2')).toBeTruthy());
    expect(screen.getByText('S3')).toBeTruthy();
    expect(screen.getByText('A2')).toBeTruthy();
  });

  it('is not offered for a card that belongs to no design review', async () => {
    await renderTracker();
    fireEvent.change(screen.getByLabelText('Filter by design review'), { target: { value: '__no_design_review__' } });
    await waitFor(() => expect(screen.queryByText('Session map')).toBeNull());
  });
});

// ─── A card a merge moved ───────────────────────────────────────────────────
//
// Batch BX. A merge used to have one destination — the main line — so "adopted" was a
// complete answer about where a card had got to. It is not any more: two variants that
// turned out to agree can be brought together, and a card that says only "adopted 8 May"
// sends its reader to the review's front page to look for a model that is standing on a
// side line. What is pinned here is the sentence the board actually prints, and that the
// DATABASE's word for a merged line is still 'adopted' — the column keeps its name, only
// sentences changed, and a test that let the two drift would let a rename of the status
// word through to every row already written.

describe('the tracker — a card moved by a merge says where it went', () => {
  /** Variant B's own meeting, whose cards ended up on Variant A when B was merged. */
  const MEET_B2 = meeting('meet-b2', 2, MERGED_INTO_A_ID, '2026-05-07T16:00:00.000Z');

  it('reads "Raised in Variant B · merged into Variant A 8 May" on the board', async () => {
    answers['review_lines'] = [MAIN_ROW, VARIANT_ROW, MERGED_INTO_A_ROW];
    resetLineCache();
    answers['tracker_sessions'] = [MEET_3, MEET_2, MEET_A2, MEET_B2];
    answers['tracker_items'] = [
      card('item-7', 'Pin binds at full lock', MEET_B2, {
        line_id: VARIANT_ID,
        origin_line_id: MERGED_INTO_A_ID,
        adopted_at: MERGED_AT,
      }),
    ];

    await renderTracker();

    expect(screen.getByText('Raised in Variant B · merged into Variant A 8 May')).toBeTruthy();
    // The old sentence must not survive beside the new one: a card that said both would
    // be a card that says it was adopted into the review AND into a side line.
    expect(screen.queryByText(/Raised in Variant B · adopted/)).toBeNull();
  });

  it('leaves the closed line out of the filter, and its cards on the board', async () => {
    // The line a merge closed has no room to be opened, so the filter does not offer it
    // — and it does not need to: its cards are on the line they went to, each saying for
    // itself where they came from.
    answers['review_lines'] = [MAIN_ROW, VARIANT_ROW, MERGED_INTO_A_ROW];
    resetLineCache();
    answers['tracker_items'] = [
      card('item-7', 'Pin binds at full lock', MEET_B2, {
        line_id: VARIANT_ID,
        origin_line_id: MERGED_INTO_A_ID,
        adopted_at: MERGED_AT,
      }),
    ];

    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByLabelText('Filter by line')).toBeTruthy());

    const options = Array.from(
      (screen.getByLabelText('Filter by line') as HTMLSelectElement).options,
    ).map((option) => option.text);
    expect(options).toEqual(['All lines', 'Main line', 'Variant A · Weld fix']);
    // And the card is still there under 'All lines', which is the whole point of taking
    // the entry out: hiding the line must not hide what it produced.
    expect(screen.getByText('Pin binds at full lock')).toBeTruthy();
  });

  it('keeps the database word for a merged line, and puts "merged" only in a sentence', () => {
    const merged = toReviewLine(MERGED_INTO_A_ROW);
    const target = toReviewLine(VARIANT_ROW);
    const main = toReviewLine(MAIN_ROW);
    const lines = [main, target, merged].filter((line): line is ReviewLine => line !== null);
    // The fixture is the thing under test's input; if it cannot be read the assertions
    // below would pass on nulls and say nothing.
    expect(lines).toHaveLength(3);

    // 'adopted' is the status column's own word and stays exactly that.
    expect(lineStatusWord(merged)).toBe('adopted');
    expect(lineFilterLabel(merged)).toBe('Variant B · Lighter frame · adopted');
    // "merged" is what a SENTENCE says, and only where the destination is known.
    expect(mergedIntoLabel(lines, merged)).toBe('merged into Variant A 8 May');
    expect(adoptedCardLabel(merged, MERGED_AT, mergedIntoLabel(lines, merged)))
      .toBe('Raised in Variant B · merged into Variant A 8 May');
    // No destination recorded — a database that predates the column, or a line since
    // deleted — and the sentence falls back to the one it has always been.
    expect(adoptedCardLabel(merged, MERGED_AT, null)).toBe('Raised in Variant B · adopted 8 May');
    // Nothing about a line still being explored: it went nowhere.
    expect(mergedIntoLabel(lines, target)).toBeNull();
  });
});

// ─── What must not have moved ───────────────────────────────────────────────

describe('the tracker — everything it already did', () => {
  it('still filters by design review, with lines in the way', async () => {
    await renderTracker();
    selectReview();
    // The title is in the filter's option and in the review's own panel, so it is the
    // panel's card count that says the review was actually opened.
    await waitFor(() => expect(screen.getByText('3 cards · 3 open · 3 meetings')).toBeTruthy());
    expect(screen.getByText('Hinge pin wears')).toBeTruthy();
  });

  it('still shows the cards of a review that has no lines at all', async () => {
    // An install whose database has not been re-applied since this batch: no
    // review_lines table, no labels, and the board exactly as it was.
    answers['review_lines'] = [];
    resetLineCache();
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByText('3 cards · 3 open · 3 meetings')).toBeTruthy());
    expect(screen.getByText('Hinge pin wears')).toBeTruthy();
    expect(screen.queryByLabelText('Filter by line')).toBeNull();
  });

  it('never says branch, fork or commit', async () => {
    // "merge" came OFF this list in batch BX, and it is pinned by the describe above
    // rather than left unpinned. It is the user's own word for taking a variant's model
    // and its cards into another line (2026-09-26), and the tracker now prints it in a
    // sentence its reader needs — "Raised in Variant B · merged into Variant A 8 May".
    // Banning it would ban the one fact a card that a merge moved has to state, and the
    // database's own word for the state stays 'adopted' either way. The three that
    // remain are the programming words the plan forbids: the drawing may LOOK like a
    // branch and the icon like a fork, and nothing in this app is a commit.
    await renderTracker();
    selectReview();
    await waitFor(() => expect(screen.getByLabelText('Filter by line')).toBeTruthy());
    fireEvent.click(screen.getByText('Session map'));
    await waitFor(() => expect(screen.getByText('S3')).toBeTruthy());

    const shown = (document.body.textContent ?? '').toLowerCase();
    for (const word of ['branch', 'fork', 'commit']) {
      expect(shown, `the tracker says "${word}"`).not.toContain(word);
    }
  });
});
