// One button starts a design review, and it opens the room with Edit on.
//
// This file's subject used to be the DIFFERENCE between two buttons. docs/plan/15-
// sessions-and-variants.md batch BN gave the lobby a "New session" that wrote a
// review_curations row exactly the way "New design review →" did, which fixed the bug
// the user had reported — an admin (or, on an install with no accounts, the meeting
// host) got the Edit button, because `can(role, 'editReview')` is about the PERSON, and
// then found a panel saying there was no design review to edit; views and pins could
// not be saved, and a participant in the same room was told import was locked because
// nobody owned the review. But it left the two buttons differing in one respect only:
// whether the room opened with `?edit=1`.
//
// Batch BO removed "New session". A second creating button whose whole meaning was a
// query parameter is a choice with one right answer, and the answer is Edit on: every
// room started from the lobby IS a design review, and the person who just created it is
// the person about to put a model in it — without Edit they land in a room where the
// import is locked until somebody else hands it over. So the difference this file was
// written about is GONE, and what is pinned here is the merged behaviour on the one
// remaining button, `data-testid="new-design-review"`:
//
//   * it is the only thing on the page that creates a review
//   * the id the row was written with is the id in the address bar, and the room opens
//     WITH `?edit=1`
//   * the draft handed to the room is the one that was written, so the row and the panel
//     agree about what the review is called
//   * a refused write still opens the room: the default self-hosted install has no
//     database configured, so a refusal is its normal answer and not an incident
//   * no name, no review — nobody enters a room nameless
//   * two clicks make one review
//   * and "Join" creates nothing, but does carry a pasted link's variant through to the
//     address it navigates to
//
// The mocking setup is the one all four lobby test files share: a fake Supabase that
// applies the filters it is handed rather than answering a canned list, so
// lib/lobby/useLobbyData — which reads seven tables to draw the grid — stays real.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
// The real store, not a mock: what the room is handed is the point of two of the tests.
import { useReviewSetupStore } from '../../lib/reviewSetupStore';
import { resetLineCache } from '../../lib/reviews/linesRepo';
import type { MyReview } from '../../lib/reviewParticipantsRepo';

/** The tables this lobby reads, as rows. Emptied between tests. */
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock('../../lib/supabase', () => {
  interface Filter {
    column: string;
    op: 'eq' | 'neq' | 'is' | 'in';
    value: unknown;
  }
  interface Sort {
    column: string;
    ascending: boolean;
  }

  const matches = (row: Record<string, unknown>, filter: Filter): boolean => {
    const actual = row[filter.column];
    if (filter.op === 'in') {
      return Array.isArray(filter.value) && filter.value.includes(actual);
    }
    if (filter.op === 'neq') return actual !== filter.value;
    return actual === filter.value;
  };

  function settle(table: string, filters: Filter[], sort: Sort | null, limit: number | null) {
    let kept = (db.tables[table] ?? []).filter((row) => filters.every((f) => matches(row, f)));
    if (sort) {
      kept = [...kept].sort((left, right) => {
        const by = String(left[sort.column] ?? '').localeCompare(String(right[sort.column] ?? ''));
        return sort.ascending ? by : -by;
      });
    }
    if (limit !== null) kept = kept.slice(0, limit);
    return { data: kept.map((row) => ({ ...row })), error: null };
  }

  function query(table: string, filters: Filter[], sort: Sort | null, limit: number | null) {
    const one = () => {
      const { data } = settle(table, filters, sort, limit);
      return { data: data[0] ?? null, error: null };
    };
    // A builder, and a thenable: every read either awaits it or ends it with
    // maybeSingle()/single(). Both shapes have to answer `{ data, error }`.
    const chain: Record<string, unknown> = {
      then: (onFulfilled: (value: unknown) => unknown) =>
        onFulfilled(settle(table, filters, sort, limit)),
      select: () => query(table, filters, sort, limit),
      eq: (column: string, value: unknown) => query(table, [...filters, { column, op: 'eq', value }], sort, limit),
      neq: (column: string, value: unknown) => query(table, [...filters, { column, op: 'neq', value }], sort, limit),
      is: (column: string, value: unknown) => query(table, [...filters, { column, op: 'is', value }], sort, limit),
      in: (column: string, value: unknown) => query(table, [...filters, { column, op: 'in', value }], sort, limit),
      order: (column: string, options?: { ascending?: boolean }) =>
        query(table, filters, { column, ascending: options?.ascending !== false }, limit),
      limit: (count: number) => query(table, filters, sort, count),
      maybeSingle: () => Promise.resolve(one()),
      single: () => Promise.resolve(one()),
      insert: () => query(table, filters, sort, limit),
      upsert: () => query(table, filters, sort, limit),
      update: () => query(table, filters, sort, limit),
      delete: () => query(table, filters, sort, limit),
    };
    return chain;
  }

  return {
    supabase: {
      from: (table: string) => query(table, [], null, null),
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
    // Without this, useLobbyData short-circuits to an empty grid and the tests below
    // would be asserting on a page that never read anything.
    supabaseConfigured: true,
  };
});

const { createReviewMock, configHolder } = vi.hoisted(() => ({
  createReviewMock: vi.fn<(reviewId: string) => Promise<unknown>>(),
  configHolder: { current: null as Record<string, unknown> | null },
}));

// Only the two functions LobbyPage imports. The grid does NOT come out of
// curationsRepo any more — lib/lobby/useLobbyData reads review_curations itself.
vi.mock('../../lib/curationsRepo', () => ({
  createReview: (reviewId: string) => createReviewMock(reviewId),
  getCurationSummary: vi.fn(async () => null),
}));

// Not exercised by this button, but useLobbyData calls it, so the mock has to answer.
vi.mock('../../lib/reviewParticipantsRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reviewParticipantsRepo')>()),
  listMyReviews: vi.fn(async () => [] as MyReview[]),
}));

vi.mock('../../lib/config/ConfigContext', () => ({
  useConnectorConfig: () => ({
    config: configHolder.current,
    loading: false,
    error: null,
    available: true,
    publicUrl: undefined,
    plm: 'teamcenter',
    capture: 'mock',
    turn: 'cloudflare',
    db: 'supabase',
    modelImport: 'onshape',
    notifications: ['teams'],
  }),
}));

const LobbyPage = (await import('../LobbyPage')).default;

const NONE = { identity: { mode: 'none', methods: [], allowGuests: false } };

/** Stands in for RoomPage: reports the address the lobby navigated to. */
const RoomProbe: React.FC = () => {
  const location = useLocation();
  return (
    <div>
      <span data-testid="room-path">{location.pathname}</span>
      <span data-testid="room-search">{location.search}</span>
    </div>
  );
};

/** A typed name, the way every other lobby test sets one. */
function signIn() {
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Alex Chen', color: '#4F8EF7' }));
}

async function renderLobby() {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/', state: null }]}>
      <Routes>
        <Route path="/" element={<LobbyPage />} />
        <Route path="/room/:roomId" element={<RoomProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  // The grid arrives by promise, and so does the selected review's own detail.
  await act(async () => {});
  await act(async () => {});
}

/** Held by test id, because the label changes to "Creating…" while a write is in flight. */
function newReviewButton(): HTMLElement {
  return screen.getByTestId('new-design-review');
}

/**
 * Start a review, which since batch BQ is two presses: the button opens onto the name
 * field in its place, and Enter in that field creates. An empty field is the answer
 * "nobody named it", so the review created is the untitled one this file has always
 * been asserting on.
 */
async function startReview() {
  // Two fireEvent calls and then a tick, rather than both inside one `await act(async…)`:
  // an async act scope does not flush between events, so the field the first click
  // renders would not be in the DOM for the second.
  fireEvent.click(newReviewButton());
  fireEvent.keyDown(screen.getByTestId('new-design-review-field'), { key: 'Enter' });
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useReviewSetupStore.getState().discardDraft();
  resetLineCache();
  db.tables = {};
  createReviewMock.mockReset().mockResolvedValue({ id: 'draft' });
  configHolder.current = NONE;
  signIn();
});

afterEach(cleanup);

describe('the lobby has one button that starts a design review', () => {
  it('offers no second way in, and this one opens the room with Edit on', async () => {
    await renderLobby();

    // "New session" and "Start new session" are both gone. A second creating button is
    // not a shortcut, it is a second answer to "what happens when I press this", and
    // the two used to differ only in a query parameter.
    expect(screen.queryByRole('button', { name: /new session/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'New design review' })).toBeInTheDocument();

    await startReview();

    expect(createReviewMock).toHaveBeenCalledTimes(1);
    const reviewId = createReviewMock.mock.calls[0][0];
    expect(screen.getByTestId('room-path').textContent).toBe(`/room/${reviewId}`);
    // Edit on, which is the half of "New session" this button absorbed: the creator is
    // the person about to put a model in the review, and without it the import is
    // locked until somebody inside hands it over.
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe(reviewId);
  });

  it('hands the room the draft that was written, so the row and the panel agree', async () => {
    const written = { reviewId: 'rev-written', title: 'Untitled design review' };
    createReviewMock.mockResolvedValue(written);
    await renderLobby();

    await startReview();

    // RoomPage reads the handover draft FIRST, so the side panel has a review to show
    // rather than a panel with nothing in it.
    expect(useReviewSetupStore.getState().draft).toEqual(written);
  });

  it('still opens the room when the database refused the row, with a local draft to edit', async () => {
    createReviewMock.mockResolvedValue(null);
    await renderLobby();

    await startReview();

    // The default self-hosted install has no database configured, so a refused write is
    // its NORMAL answer, not an incident. Blocking the room there would take this button
    // away from the one install that has no other way to start a meeting. The room's own
    // edit panel creates the row if it can, and says plainly what failed if it cannot.
    const reviewId = createReviewMock.mock.calls[0][0];
    expect(screen.getByTestId('room-path').textContent).toBe(`/room/${reviewId}`);
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
    const draft = useReviewSetupStore.getState().draft;
    expect(draft?.reviewId).toBe(reviewId);
    expect(draft?.title).toBe('Untitled design review');
  });

  it('refuses without a name, and creates nothing', async () => {
    localStorage.clear();
    await renderLobby();

    await startReview();

    expect(screen.getByText('Enter your name first.')).toBeInTheDocument();
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('room-path')).toBeNull();
  });

  it('makes one review when Create is pressed twice', async () => {
    let release: ((value: unknown) => void) | null = null;
    createReviewMock.mockReturnValue(
      new Promise<unknown>((resolve) => {
        release = resolve;
      }),
    );
    await renderLobby();

    await act(async () => {
      fireEvent.click(newReviewButton());
    });
    const create = screen.getByTestId('new-design-review-create');
    await act(async () => {
      fireEvent.click(create);
    });
    expect(create).toBeDisabled();

    // Either the disabled button or the handler's own early return would stop the second
    // row, and a second row is a review nobody will ever open again.
    await act(async () => {
      fireEvent.click(create);
    });
    expect(createReviewMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.({ id: 'draft' });
    });

    expect(createReviewMock).toHaveBeenCalledTimes(1);
  });

  it('leaves "Join" alone, which still opens somebody else’s room by its code', async () => {
    // Only the button that STARTS a review writes a row. Joining one must not: the
    // review either exists already or the person who started it created it, and minting
    // a room out of a mistyped link is how a lobby fills up with reviews nobody opens.
    await renderLobby();

    fireEvent.change(screen.getByLabelText('Room code or link'), { target: { value: 'abc123' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('join-button'));
    });

    expect(createReviewMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-path').textContent).toBe('/room/abc123');
    // Joining is not creating, so no Edit either.
    expect(screen.getByTestId('room-search').textContent).toBe('');
  });

  it('carries a pasted link’s variant through to the room it opens', async () => {
    // The box takes the link somebody was sent, whole. Dropping the `?line=` would put
    // a person invited to Variant A into the main line's room — a different meeting
    // looking at a different model — so the address the lobby navigates to is
    // lib/reviews/lines.roomPath's spelling, not one built here.
    await renderLobby();

    fireEvent.change(screen.getByLabelText('Room code or link'), {
      target: { value: 'https://viewpoint.example.test/room/abc123?line=line-variant-a' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('join-button'));
    });

    expect(createReviewMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-path').textContent).toBe('/room/abc123');
    expect(screen.getByTestId('room-search').textContent).toBe('?line=line-variant-a');
  });
});
