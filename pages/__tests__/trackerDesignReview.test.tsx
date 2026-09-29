// The tracker's design-review continuity: what a card says about the revisions it
// has lived through, and the filter that shows one review's whole history.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. The sentences themselves are
// decided in lib/trackerContinuity.ts and pinned there; what is pinned here is
// that the page actually asks for them — that a card on the board carries its
// line, that a review can be filtered for and opens onto its revisions and its
// meetings, and that the meetings recorded before this batch (which have no
// review_id at all) are still reachable rather than becoming a remainder
// nothing can select.
//
// Supabase, the curations read and the revisions read are all faked, the way
// pages/__tests__/lobbyYourReviews.test.tsx fakes them: the page under test is the
// real one, including the board's dnd-kit columns.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { answers, curationsMock, revisionsMock } = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  return {
    answers: tables,
    curationsMock: { list: vi.fn() },
    revisionsMock: { list: vi.fn() },
  };
});

vi.mock('../../lib/supabase', () => {
  // The page reads four tables through a chainable builder and only ever renders
  // the rows, so a promise that also answers every chaining method is enough.
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

// Only the two reads the page makes outside supabase are faked. listAllCurations
// is what fills the filter, listModelRevisions is what fills the continuity line
// and the review's panel — the page has no other way to reach either.
vi.mock('../../lib/curationsRepo', () => ({
  listAllCurations: () => curationsMock.list(),
}));

vi.mock('../../lib/reviews/revisionsRepo', () => ({
  listModelRevisions: (reviewId: string) => revisionsMock.list(reviewId),
}));

// Pulls in the connector adapters and the config context; the panel is closed
// during every test below and renders nothing the tracker's continuity depends on.
vi.mock('../../components/UI/IntegrationsPanel', () => ({ default: () => null }));

const trackerPage = await import('../TrackerPage');
const TrackerPage = trackerPage.default;
const { NO_DESIGN_REVIEW } = trackerPage;

const REVIEW_ID = 'review-1';

const REVISIONS = [
  {
    id: 'rev-a', reviewId: REVIEW_ID, line: 'Bracket', revision: 'A', hash: 'hash-a',
    fileName: 'bracket-a.step', size: 1024, notes: '', uploadedBy: null,
    uploadedByName: 'Robin', createdAt: '2026-03-01T10:00:00.000Z',
  },
  {
    id: 'rev-b', reviewId: REVIEW_ID, line: 'Bracket', revision: 'B', hash: 'hash-b',
    fileName: 'bracket-b.step', size: 2048, notes: '', uploadedBy: null,
    uploadedByName: 'Robin', createdAt: '2026-04-01T10:00:00.000Z',
  },
  {
    id: 'rev-c', reviewId: REVIEW_ID, line: 'Bracket', revision: 'C', hash: 'hash-c',
    fileName: 'bracket-c.step', size: 4096, notes: '', uploadedBy: null,
    uploadedByName: 'Ana', createdAt: '2026-05-01T10:00:00.000Z',
  },
];

const MEETING = {
  id: 'meet-1', room_id: REVIEW_ID, title: 'Design review — 3 May 2026',
  ended_at: '2026-05-03T16:00:00.000Z', created_at: '2026-05-03T15:00:00.000Z',
  participant_count: 4, model_name: 'qwen', labels: {},
  review_id: REVIEW_ID, revision_ids: ['rev-c'],
};

const AD_HOC_MEETING = {
  id: 'meet-2', room_id: 'room-ad-hoc', title: 'Ad-hoc look at the jig',
  ended_at: '2026-05-04T16:00:00.000Z', created_at: '2026-05-04T15:00:00.000Z',
  participant_count: 2, model_name: null, labels: {},
  review_id: null, revision_ids: [],
};

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-1',
    session_id: MEETING.id,
    type: 'RISK',
    title: 'A card',
    description: '',
    priority: 'High',
    status: 'Open',
    assignee: null,
    due_date: null,
    component_reference: null,
    department: null,
    agent_id: 'SYS.OP',
    source_message_ids: null,
    affected_requirement_ids: null,
    impact: null,
    mitigation_strategy: null,
    design_driver: null,
    tradeoff_analysis: null,
    created_at: '2026-05-03T16:00:00.000Z',
    updated_at: '2026-05-03T16:00:00.000Z',
    review_id: REVIEW_ID,
    raised_on_revision: null,
    part_node_id: null,
    part_name: null,
    created_by_name: null,
    source: 'ai',
    session: MEETING,
    ...overrides,
  };
}

// Raised on Rev A while Rev C is on the line: the sentence the plan asks for.
const STILL_OPEN = item({
  id: 'item-open',
  title: 'Weld crack at the fillet transition',
  raised_on_revision: 'rev-a',
});

// Closed on 12 Apr, when Rev B was the newest revision of the line.
const CLOSED = item({
  id: 'item-closed',
  type: 'ACTION',
  title: 'Bezel tolerance revised to ±0.2mm',
  status: 'Approved',
  raised_on_revision: 'rev-a',
});

// Batch BG's hand-made card: a person's, not an agent's.
const HAND_MADE = item({
  id: 'item-manual',
  type: 'RATIONALE',
  title: 'Keep the old bracket as the fallback',
  source: 'manual',
  created_by_name: 'Robin',
  raised_on_revision: 'rev-c',
});

// Recorded before this batch, in a room nobody curated: no review, no revision.
const BEFORE_THIS_BATCH = item({
  id: 'item-legacy',
  title: 'Jig alignment drifts after a thermal cycle',
  session_id: AD_HOC_MEETING.id,
  review_id: null,
  raised_on_revision: null,
  created_by_name: null,
  session: AD_HOC_MEETING,
});

async function renderTracker() {
  const result = render(
    <MemoryRouter>
      <TrackerPage />
    </MemoryRouter>,
  );
  // Sessions, items, label fields, reviews, revisions and the closing history all
  // arrive by promise, and the page shows a spinner until the first two land.
  await waitFor(() => {
    expect(screen.queryByText('Loading tracker…')).toBeNull();
  });
  await act(async () => {});
  await act(async () => {});
  return result;
}

beforeEach(() => {
  localStorage.clear();
  answers['tracker_sessions'] = [MEETING, AD_HOC_MEETING];
  answers['tracker_items'] = [STILL_OPEN, CLOSED, HAND_MADE, BEFORE_THIS_BATCH];
  answers['tracker_status_history'] = [
    { item_id: 'item-closed', created_at: '2026-04-12T16:20:00.000Z' },
  ];
  answers['review_label_fields'] = [];
  curationsMock.list.mockReset().mockResolvedValue([
    {
      id: REVIEW_ID, title: 'Landing gear bracket', description: 'Fatigue life of the fillet weld',
      viewpoint_count: 3, pin_count: 2, slide_count: 1, listed: true,
      updated_at: '2026-05-03T16:00:00.000Z', created_at: '2026-02-01T09:00:00.000Z',
    },
  ]);
  revisionsMock.list.mockReset().mockImplementation(async (reviewId: string) =>
    reviewId === REVIEW_ID ? REVISIONS : [],
  );
});

afterEach(() => {
  cleanup();
});

describe('the continuity line on a card', () => {
  it('says a card raised on Rev A is still open on Rev C', async () => {
    await renderTracker();

    expect(screen.getByText('Raised on Rev A · still open on Rev C')).toBeInTheDocument();
  });

  it('says which revision a closed card was closed in, and when', async () => {
    await renderTracker();

    // 12 Apr 2026 fell between the upload of Rev B and the upload of Rev C, so
    // Rev B is the revision the review was showing when this card was closed.
    expect(screen.getByText('Raised on Rev A · Closed on Rev B · 12 Apr')).toBeInTheDocument();
  });

  it('names only the revision it was raised on while that is the newest', async () => {
    await renderTracker();

    expect(screen.getByText('Raised on Rev C')).toBeInTheDocument();
  });

  it('says nothing at all for a card recorded before revisions existed', async () => {
    await renderTracker();

    expect(screen.getByText('Jig alignment drifts after a thermal cycle')).toBeInTheDocument();
    // Three of the four cards name a revision; the fourth has none to name, and
    // must not be given one.
    expect(screen.getAllByText(/Raised on Rev/)).toHaveLength(3);
    expect(screen.queryByText(/Raised on Rev undefined/)).toBeNull();
  });

  it('reads a hand-made card as the person who typed it, not as an agent', async () => {
    await renderTracker();

    expect(screen.getByTitle('Added by hand · Robin')).toBeInTheDocument();
    expect(screen.queryByText(/SYS\.OP/)).toBeNull();
  });

  it('asks for the revisions of the review its cards belong to', async () => {
    await renderTracker();

    expect(revisionsMock.list).toHaveBeenCalledWith(REVIEW_ID);
  });
});

describe('filtering by design review', () => {
  it('offers every review, and the meetings that belong to none', async () => {
    await renderTracker();

    const filter = screen.getByLabelText('Filter by design review');
    const labels = Array.from(filter.querySelectorAll('option')).map(o => o.textContent);
    expect(labels).toContain('All design reviews');
    expect(labels).toContain('Landing gear bracket');
    expect(labels).toContain('No design review');
  });

  it('shows one review as a page: its revisions, its meetings and its cards', async () => {
    await renderTracker();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by design review'), {
        target: { value: REVIEW_ID },
      });
    });
    await act(async () => {});

    // The review's own panel: what it has reviewed, oldest revision first. The
    // heading rather than the text, because the filter's <option> says the same
    // thing and is in the DOM whether or not it is selected.
    expect(screen.getByRole('heading', { name: 'Landing gear bracket' })).toBeInTheDocument();
    expect(screen.getByText('Design review')).toBeInTheDocument();
    const revisionLabels = screen.getAllByText(/^Rev [A-Z]$/).map(el => el.textContent);
    expect(revisionLabels).toEqual(['Rev A', 'Rev B', 'Rev C']);
    expect(screen.getByText('bracket-a.step')).toBeInTheDocument();

    // Its meetings — in the sidebar and in the panel — and its cards.
    expect(screen.getAllByText('Design review — 3 May 2026').length).toBeGreaterThan(0);
    expect(screen.getByText('Weld crack at the fillet transition')).toBeInTheDocument();
    expect(screen.queryByText('Jig alignment drifts after a thermal cycle')).toBeNull();
  });

  it('keeps the meetings that have no design review reachable', async () => {
    await renderTracker();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by design review'), {
        target: { value: NO_DESIGN_REVIEW },
      });
    });
    await act(async () => {});

    // Every session recorded before this batch has a null review_id, and none of
    // them may be put out of reach by a filter that did not exist then.
    expect(screen.getByText('Jig alignment drifts after a thermal cycle')).toBeInTheDocument();
    expect(screen.getAllByText('Ad-hoc look at the jig').length).toBeGreaterThan(0);
    expect(screen.queryByText('Weld crack at the fillet transition')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Landing gear bracket' })).toBeNull();
  });

  it('counts only the review in view', async () => {
    await renderTracker();

    expect(screen.getByText('2 sessions · 4 items')).toBeInTheDocument();

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Filter by design review'), {
        target: { value: REVIEW_ID },
      });
    });
    await act(async () => {});

    await waitFor(() => {
      expect(screen.getByText('1 sessions · 3 items')).toBeInTheDocument();
    });
  });
});

describe('an install whose database predates batch BC', () => {
  it('renders the cards with no continuity line and asks for no revisions', async () => {
    // Such a database returns rows with no review_id and no raised_on_revision at
    // all — not nulls, absent keys — and the page has to render them exactly as it
    // rendered them before the filter and the continuity line existed.
    const legacyMeeting = { ...MEETING, review_id: undefined, revision_ids: undefined };
    answers['tracker_sessions'] = [legacyMeeting, { ...AD_HOC_MEETING, review_id: undefined }];
    answers['tracker_items'] = [
      item({
        id: 'item-open',
        title: 'Weld crack at the fillet transition',
        review_id: undefined,
        raised_on_revision: undefined,
        session: legacyMeeting,
      }),
    ];
    curationsMock.list.mockResolvedValue([]);

    await renderTracker();

    expect(screen.getByText('Weld crack at the fillet transition')).toBeInTheDocument();
    expect(screen.queryByText(/Raised on Rev/)).toBeNull();
    expect(revisionsMock.list).not.toHaveBeenCalled();
    // The filter is still offered, with nothing in it but the honest remainder.
    expect(screen.getByLabelText('Filter by design review')).toBeInTheDocument();
  });
});
