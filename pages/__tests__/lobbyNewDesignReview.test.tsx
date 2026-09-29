// The lobby's "New design review" — the one button that brings a review into existence.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH, rewritten for batch BO of
// docs/plan/15-sessions-and-variants.md. The curate page is gone; its tabs are the
// room's side panel with Edit on. What that leaves this button responsible for is a
// ROW: a review with no review_curations row opens with nothing to edit, so the row is
// written FIRST and the room is entered at the id the row was written with.
//
// Batch BO also took away the lobby's second creating button. "New session" (batch BN)
// had become this button minus `?edit=1`, and one button remains; the merged behaviour
// is what lobbyNewSession.test.tsx now pins. What is pinned here is
//
//   * the id the row was created with is the id in the address bar — creating the row
//     before navigating is the whole point, because a link that works for anybody it is
//     sent to has to work from the first moment the review exists
//   * a refused write STILL opens the room, with a local draft to edit: the default
//     self-hosted install has no database configured, so a refusal is its normal answer
//     and not an incident
//   * two clicks make one review (a double-click must not orphan a row)
//   * and a review that ALREADY exists is opened WITHOUT `?edit=1`. Edit on arrival is
//     the creator's, and this button is the only one that hands it out.
//
// The mocking setup is the one all four lobby test files share: a fake Supabase that
// applies the filters it is handed rather than answering a canned list, so
// lib/lobby/useLobbyData — which reads seven tables to draw the grid — stays real.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { MyReview } from '../../lib/reviewParticipantsRepo';
// The real store, not a mock: what the room is handed when the database refused
// the row is the point of two of the tests below.
import { useReviewSetupStore } from '../../lib/reviewSetupStore';
import { resetLineCache } from '../../lib/reviews/linesRepo';

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
  createReviewMock: vi.fn<(reviewId: string, title?: string) => Promise<unknown>>(),
  configHolder: { current: null as Record<string, unknown> | null },
}));

// Only the two functions LobbyPage imports. The grid does NOT come out of
// curationsRepo any more — lib/lobby/useLobbyData reads review_curations itself — so
// listRecentCurations is no longer part of this page's surface. The title argument is
// forwarded because naming the review is what batch BQ added, and "the row was written
// with the name that was typed" is only assertable if the mock keeps it.
vi.mock('../../lib/curationsRepo', () => ({
  createReview: (reviewId: string, title?: string) => createReviewMock(reviewId, title),
  getCurationSummary: vi.fn(async () => null),
}));

// Not exercised by this button — a review being "mine" needs a deployment with
// accounts and a signed-in browser — but useLobbyData calls it, so it has to answer.
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

/** A review_curations row. Every column useLobbyData reads is explicit: the fake
 *  database compares values and applies no column defaults. */
function curation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'room-9',
    title: 'A design review that already exists',
    description: '',
    asset: null,
    thumbnail: null,
    owner_id: null,
    archived: false,
    listed: true,
    created_at: '2026-09-20T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
    ...overrides,
  };
}

/** A typed name, the way every other lobby test sets one. */
function signIn(overrides: Record<string, unknown> = {}) {
  localStorage.setItem(
    'vp_user',
    JSON.stringify({ name: 'Alex Chen', color: '#4F8EF7', ...overrides }),
  );
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
  // The grid arrives by promise, and so does the selected review's own detail — the
  // preview panel reads it only once the grid has answered with an id to ask about.
  await act(async () => {});
  await act(async () => {});
}

/** Held by test id rather than looked up by name: while a create is in flight the
 *  label changes to "Creating…", so a name query would not find it. */
function newReviewButton(): HTMLElement {
  return screen.getByTestId('new-design-review');
}

/**
 * Start a review, which since batch BQ is TWO presses: the button opens onto the name
 * field in its place, and Enter in that field creates.
 *
 * `name` defaults to '' — an empty field — because that is what every test that was
 * written before the field existed means by "press the button", and the answer has to
 * stay the review it always was.
 */
async function startReview(name = '') {
  // NOT wrapped in one `await act(async () => …)`: inside an async act scope React does
  // not flush between events, so the field the first click renders would not be in the
  // DOM for the second, and the key handler would still be the closure from the render
  // before the typed value. fireEvent wraps itself in a synchronous act, which is what
  // makes the three presses see each other.
  fireEvent.click(newReviewButton());
  const field = screen.getByTestId('new-design-review-field');
  if (name !== '') fireEvent.change(field, { target: { value: name } });
  fireEvent.keyDown(field, { key: 'Enter' });
  // The create is async — a row is written and a navigation happens — so the assertions
  // that follow need the tick.
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

describe('the button itself', () => {
  it('says "New design review", and the old wording is gone', async () => {
    await renderLobby();

    expect(newReviewButton()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New design review' })).toBeInTheDocument();
    expect(screen.queryByText('Curate a design review')).toBeNull();
  });

  it('is what the empty grid points at', async () => {
    await renderLobby();

    // With no account behind the name the grid opens on "All", which is the one chip
    // whose empty state offers a way out — and it names the button, so the two have to
    // keep agreeing.
    expect(screen.queryByTestId('review-card')).toBeNull();
    expect(screen.getByText('No design reviews yet.')).toBeInTheDocument();
    const hint = screen.getByText(/it saves as you go and appears here/);
    expect(hint.textContent).toContain('New design review');
    expect(screen.queryByText('Curate a design review')).toBeNull();
  });
});

describe('creating a review', () => {
  it('refuses without a name, and creates nothing', async () => {
    localStorage.clear();
    await renderLobby();

    // The name rule survived the redesign, and so did its placement: with no account
    // behind this browser the field is drawn INLINE above the actions, not folded into
    // the identity chip's menu where nobody would find it.
    expect(screen.getByTestId('lobby-name-field')).toBeInTheDocument();

    await startReview();

    expect(screen.getByText('Enter your name first.')).toBeInTheDocument();
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('room-path')).toBeNull();
  });

  it('writes the row first, then opens that same review with Edit on', async () => {
    await renderLobby();

    await startReview();

    expect(createReviewMock).toHaveBeenCalledTimes(1);
    const reviewId = createReviewMock.mock.calls[0][0];
    expect(reviewId).not.toBe('');
    // The id in the address bar is the id the row was written with: a link that is
    // shared from here opens the review that exists, not an empty room.
    expect(screen.getByTestId('room-path').textContent).toBe(`/room/${reviewId}`);
    // And WITH Edit on, which is the half of "New session" this button absorbed: the
    // person who just created a review is the one about to put a model in it.
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
    // enterRoom, not a bare navigate: the identity is written first.
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe(reviewId);
    expect(JSON.parse(localStorage.getItem('vp_user') ?? '{}').name).toBe('Alex Chen');
  });

  it('still opens the room when the database refused the row, with a local draft to edit', async () => {
    createReviewMock.mockResolvedValue(null);
    await renderLobby();

    await startReview();

    // The default self-hosted install has no database configured, so a refused write is
    // its NORMAL answer, not an incident. Blocking the room there would take this
    // button away from the one install that has no other way to start a review — and
    // the curate page it replaces never needed a row to work.
    const reviewId = createReviewMock.mock.calls[0][0];
    expect(screen.getByTestId('room-path').textContent).toBe(`/room/${reviewId}`);
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
    // RoomPage reads the local draft FIRST, so the side panel has a review to show
    // rather than "this room has no design review to edit yet".
    const draft = useReviewSetupStore.getState().draft;
    expect(draft?.reviewId).toBe(reviewId);
    expect(draft?.title).toBe('Untitled design review');
  });

  it('hands the room the draft that was written, so the row and the panel agree', async () => {
    const written = { reviewId: 'rev-written', title: 'Untitled design review' };
    createReviewMock.mockResolvedValue(written);
    await renderLobby();

    await startReview();

    expect(useReviewSetupStore.getState().draft).toEqual(written);
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
    expect(create).toHaveTextContent('Creating…');

    // The button is disabled while a create is in flight, and the handler also returns
    // early on `creating` — either one alone would stop the second row, and a second
    // row is a review nobody will ever open again.
    await act(async () => {
      fireEvent.click(create);
    });
    expect(createReviewMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.({ id: 'draft' });
    });

    expect(createReviewMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('room-path').textContent).toBe(
      `/room/${createReviewMock.mock.calls[0][0]}`,
    );
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
  });
});

// ─── Naming it (batch BQ) ─────────────────────────────────────────────────────
//
// Nothing anywhere wrote review_curations.title before this, so every review the lobby
// created was "Untitled design review" and the grid was a wall of identical cards. The
// button now opens onto the name, in place, and the name is what the row is written with.

describe('naming the review', () => {
  it('asks for the name in place of the button, and writes the one that was typed', async () => {
    await renderLobby();

    fireEvent.click(newReviewButton());
    const field = screen.getByTestId('new-design-review-field');
    expect(field).toHaveAttribute('placeholder', 'e.g. Door hinge, rev C');
    // Nothing is written by asking.
    expect(createReviewMock).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '  Door hinge, rev C  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await act(async () => {});

    expect(createReviewMock).toHaveBeenCalledTimes(1);
    // Trimmed: a name with spaces either side is the same name.
    expect(createReviewMock.mock.calls[0][1]).toBe('Door hinge, rev C');
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
  });

  it('creates the untitled review when the field is left empty, which is what the button did before it asked', async () => {
    await renderLobby();

    await startReview();

    expect(createReviewMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock.mock.calls[0][1]).toBe('Untitled design review');
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
  });

  it('caps the name at 120 characters, because a card and a room corner have to show it', async () => {
    await renderLobby();
    const long = 'x'.repeat(200);

    await startReview(long);

    expect(createReviewMock.mock.calls[0][1]).toHaveLength(120);
  });

  it('leaves the button as it was when the question is escaped, and creates nothing', async () => {
    await renderLobby();

    fireEvent.click(newReviewButton());
    fireEvent.keyDown(screen.getByTestId('new-design-review-field'), { key: 'Escape' });
    await act(async () => {});

    expect(screen.queryByTestId('new-design-review-field')).toBeNull();
    expect(newReviewButton()).toBeInTheDocument();
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('room-path')).toBeNull();
  });
});

describe('a review that already exists', () => {
  it('opens it as a card in the grid, without Edit, and creates nothing', async () => {
    db.tables = { review_curations: [curation({ id: 'room-9' })] };
    await renderLobby();

    // The grid is the row, and the preview beside it is the way in: there is no
    // per-row "Resume editing" action any more, and no second creating button.
    expect(screen.getByTestId('review-card')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-open-room'));
    });

    expect(createReviewMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('room-path').textContent).toBe('/room/room-9');
    // `?edit=1` belongs to the person who CREATED the review. Somebody opening one
    // that already exists arrives as a participant, and Edit is handed over from
    // inside the room the way it always was.
    expect(screen.getByTestId('room-search').textContent).toBe('');
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe('room-9');
  });
});
