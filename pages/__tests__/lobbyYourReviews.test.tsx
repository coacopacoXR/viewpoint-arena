// The reviews that follow a PERSON rather than a link — now the card grid's own two
// chips, "Mine" and "Shared with me".
//
// docs/plan/13-identity.md batch AZ, rewritten for batch BO of
// docs/plan/15-sessions-and-variants.md. This file used to assert on a list under the
// heading "Your design reviews · n", fed by lib/reviewParticipantsRepo.listMyReviews.
// That list is gone: the lobby is a grid of CARDS with four filter chips over it, and
// "whose is this" is a property of a card rather than a section of the page. What the
// chips are, and what survives from the old list:
//
//   * "Mine" is a review this account OWNS — owner_id names it, or its review_members
//     row says 'owner'.
//   * "Shared with me" is a review it does not own but is on: a roster row of any other
//     role, or a review_participants row saying it has stood in the room.
//   * "All" is every listed review that has not been put away, whoever's it is.
//
// WHO GETS NOTHING is unchanged, and is still the part worth pinning: a guest, a
// browser that has not signed in, a deployment on identity.mode 'none' and a
// deployment whose config has not arrived yet all make NO request for a roster or a
// history, and for all four of them nothing on the grid is "mine". What changed is how
// that reads on the page: a section that was not rendered has become a chip that
// answers with what the install has — which on a default install is nothing. The chips
// are still offered to all four, EXCEPT to a guest, who is given no chips at all (a
// count on one is a statement about how many reviews the install holds) and no way to
// start a review either. Asserting the chips were absent for everybody would now be
// asserting against a page that deliberately offers them.
//
// THREE ASSERTIONS THIS FILE USED TO MAKE ARE GONE, not moved:
//
//   * "Hosted" / "Joined" and "today" / "3 days ago". The card's meta line names a
//     STANDING ('you own it', 'editor', 'participant', 'you have been in it') and the
//     date of the review's last SESSION, not of my last visit. lib/lobby/useLobbyData
//     still reads lastVisitedAt, but nothing on the page draws it, and
//     reviewParticipantsRepo.describeLastVisit has no caller in the lobby any more.
//   * "Session bbbbbbbb" — an ad-hoc room with no review_curations row. The grid is
//     built from review_curations, so a review that has no row cannot be a card; a
//     review_participants row only marks a card that exists as one I have been in.
//     Since batch BN every room started from the lobby writes a row, so this is a
//     review started before that (or by a bare link) and nothing else.
//   * "Resume editing" per row. Opening a review is the preview panel's "Open room",
//     and it does not turn Edit on — see lobbyNewDesignReview.test.tsx.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { MyReview } from '../../lib/reviewParticipantsRepo';
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
    // Without this, useLobbyData short-circuits to an empty grid and every assertion
    // below would be about a page that never read anything.
    supabaseConfigured: true,
  };
});

const { myReviewsMock, configHolder } = vi.hoisted(() => ({
  myReviewsMock: { list: vi.fn() },
  configHolder: { current: null as Record<string, unknown> | null },
}));

// The grid does not come out of curationsRepo any more, so only the one function
// LobbyPage still imports from it needs an answer — and no test here arrives by a link
// that the grid does not already hold, so null is the honest one.
vi.mock('../../lib/curationsRepo', () => ({
  createReview: vi.fn(async () => null),
  getCurationSummary: vi.fn(async () => null),
}));

// Only the read is faked. Everything that decides what a chip shows — the roster
// query, review_participants' contribution to `visited`, and lib/lobby/useLobbyData's
// own filterReviews — runs for real.
vi.mock('../../lib/reviewParticipantsRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/reviewParticipantsRepo')>()),
  listMyReviews: () => myReviewsMock.list(),
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

const ACCOUNTS = { identity: { mode: 'accounts', methods: ['password'], allowGuests: false } };
const NONE = { identity: { mode: 'none', methods: [], allowGuests: false } };

/** Stands in for RoomPage: reports the address the lobby navigated to. */
const RoomProbe: React.FC = () => {
  const location = useLocation();
  return <span data-testid="room-path">{location.pathname}</span>;
};

/** A review_curations row. Every column useLobbyData reads is explicit: the fake
 *  database compares values and applies no column defaults. */
function curation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'room-1',
    title: 'Landing gear review',
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

/** My row on a review's roster. Only this account's rows are ever seeded, so the
 *  `.eq('user_id', …)` the real query makes has nothing else to filter out. */
function member(reviewId: string, role: string): Record<string, unknown> {
  return { review_id: reviewId, user_id: 'account-1', role };
}

function visited(reviewId: string, title: string | null): MyReview {
  return {
    reviewId,
    role: 'participant',
    firstJoinedAt: '2026-09-20T00:00:00Z',
    lastJoinedAt: '2026-09-22T00:00:00Z',
    title,
  };
}

function signIn(overrides: Record<string, unknown> = {}) {
  localStorage.setItem(
    'vp_user',
    JSON.stringify({ name: 'Alex Chen', color: '#4F8EF7', accountId: 'account-1', ...overrides }),
  );
}

async function renderLobby(state?: Record<string, unknown>) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/', state: state ?? null }]}>
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

/**
 * The grid's titles, in the order it draws them.
 *
 * Read off the cards rather than by a text query: the preview panel beside the grid
 * shows the selected review's title too, so `getByText` would find two of whichever
 * card is selected and one of every other.
 */
function cardTitles(): string[] {
  return screen
    .queryAllByTestId('review-card')
    .map((card) => card.querySelector('h3')?.textContent ?? '');
}

/** The chip that is on, which is the one whose reviews the grid is drawing. */
function pressedChip(): string | null {
  const pressed = ['mine', 'shared', 'all', 'archived'].filter(
    (chip) => screen.getByTestId(`filter-${chip}`).getAttribute('aria-pressed') === 'true',
  );
  return pressed.length === 1 ? pressed[0] : null;
}

async function showChip(chip: 'mine' | 'shared' | 'all' | 'archived') {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`filter-${chip}`));
  });
}

/** Four reviews: one owned, one on the roster as an editor, one only ever stood in,
 *  and one this account has nothing to do with. Newest first, which is the grid's order. */
function seedFourReviews() {
  db.tables = {
    review_curations: [
      curation({ id: 'room-owned', title: 'Landing gear review', updated_at: '2026-09-24T00:00:00Z' }),
      curation({ id: 'room-editor', title: 'Wing rib study', updated_at: '2026-09-23T00:00:00Z' }),
      curation({ id: 'room-joined', title: 'Door hinge, second pass', updated_at: '2026-09-22T00:00:00Z' }),
      curation({ id: 'room-stranger', title: 'Tailplane jig review', updated_at: '2026-09-21T00:00:00Z' }),
    ],
    review_members: [member('room-owned', 'owner'), member('room-editor', 'editor')],
  };
  myReviewsMock.list.mockResolvedValue([visited('room-joined', 'Door hinge, second pass')]);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLineCache();
  db.tables = {};
  myReviewsMock.list.mockReset().mockResolvedValue([]);
  configHolder.current = ACCOUNTS;
});

afterEach(cleanup);

describe('a signed-in person on a deployment with accounts', () => {
  beforeEach(() => {
    signIn();
  });

  it('opens on Mine, where the review they own is the only card', async () => {
    seedFourReviews();

    await renderLobby();

    // The default chip follows the person: with an account behind the name, the first
    // thing the lobby shows is what is theirs.
    expect(screen.getByTestId('filter-mine')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toEqual(['Landing gear review']);
    // And the card says so in words, which is what the old list's "Hosted" did.
    expect(screen.getByTestId('review-card').textContent).toContain('you own it');
  });

  it('puts a review they are on the roster of, but do not own, under Shared with me', async () => {
    seedFourReviews();

    await renderLobby();
    await showChip('shared');

    expect(screen.getByTestId('filter-shared')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toEqual(['Wing rib study', 'Door hinge, second pass']);
    // The two ways in are told apart: a roster row that is not the owner's reads as the
    // role it names, and a room they merely stood in reads as that.
    const cards = screen.getAllByTestId('review-card');
    expect(cards[0].textContent).toContain('editor');
    expect(cards[1].textContent).toContain('you have been in it');
  });

  it('leaves a review they have nothing to do with to All', async () => {
    seedFourReviews();

    await renderLobby();
    expect(cardTitles()).not.toContain('Tailplane jig review');

    await showChip('shared');
    expect(cardTitles()).not.toContain('Tailplane jig review');

    await showChip('all');
    expect(cardTitles()).toEqual([
      'Landing gear review',
      'Wing rib study',
      'Door hinge, second pass',
      'Tailplane jig review',
    ]);
  });

  it('opens a review through the preview, and the account survives the identity it writes', async () => {
    seedFourReviews();

    await renderLobby();
    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-open-room'));
    });

    // enterRoom, not a bare navigate: the identity is written first, and the account id
    // survives it — dropping that here would sign the person out of their own lobby the
    // moment they opened a review.
    expect(screen.getByTestId('room-path').textContent).toBe('/room/room-owned');
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe('room-owned');
    const stored = JSON.parse(localStorage.getItem('vp_user') ?? '{}');
    expect(stored.accountId).toBe('account-1');
    expect(stored.name).toBe('Alex Chen');
  });
});

describe('who gets no list of their own', () => {
  it('makes no request on a deployment with identity off, and nothing is anybody’s', async () => {
    configHolder.current = NONE;
    signIn();
    seedFourReviews();

    await renderLobby();

    expect(myReviewsMock.list).not.toHaveBeenCalled();
    // The chips are still offered — this is the change from the old lobby, where the
    // whole section was not rendered. They simply answer with what the install has, and
    // on identity.mode 'none' there is no account for a review to belong to, so the
    // grid opens on All.
    expect(screen.getByTestId('filter-mine')).toBeInTheDocument();
    expect(screen.getByTestId('filter-all')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toHaveLength(4);

    await showChip('mine');
    expect(cardTitles()).toEqual([]);
    expect(screen.getByText('Design reviews you own will appear here.')).toBeInTheDocument();
  });

  it('makes no request for a guest, who has no account to key a row on', async () => {
    localStorage.setItem(
      'vp_user',
      JSON.stringify({ name: 'Supplier Sam', color: '#4F8EF7', guest: true }),
    );
    seedFourReviews();

    await renderLobby();

    expect(myReviewsMock.list).not.toHaveBeenCalled();
    // A guest was admitted to one meeting. They get neither the install's grid nor the
    // chips that narrow it, and they do not get to start a review either — all three
    // controls are hidden rather than disabled, because a control greyed out for
    // somebody who will never have it is a question the page then has to answer.
    expect(cardTitles()).toEqual([]);
    expect(
      screen.getByText('The design review you were invited to will appear here.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('filter-mine')).toBeNull();
    expect(screen.queryByTestId('filter-all')).toBeNull();
    expect(screen.queryByTestId('new-design-review')).toBeNull();
  });

  it('shows a guest the one review they were invited to, and no others', async () => {
    localStorage.setItem(
      'vp_user',
      JSON.stringify({ name: 'Supplier Sam', color: '#4F8EF7', guest: true }),
    );
    // `listed: false` is the link-only review the grid does not offer to a stranger;
    // an invitation is the one way in, and it still works.
    db.tables = {
      review_curations: [
        curation({ id: 'room-invited', title: 'Supplier review, invited only', listed: false }),
        curation({ id: 'room-other', title: 'Somebody else’s review' }),
      ],
    };

    await renderLobby({ joinRoomId: 'room-invited' });

    expect(cardTitles()).toEqual(['Supplier review, invited only']);
    expect(screen.getByTestId('review-preview').textContent).toContain(
      'Supplier review, invited only',
    );
    // Arriving by a link makes Join the primary button: the person came to enter a
    // meeting, and two buttons that both enter it is a choice with one answer.
    expect(screen.getByTestId('preview-join')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-open-room')).toBeNull();
  });

  it('makes no request for a browser that has not signed in', async () => {
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Alex Chen', color: '#4F8EF7' }));
    seedFourReviews();

    await renderLobby();

    expect(myReviewsMock.list).not.toHaveBeenCalled();
    // No account, so no default of Mine: the grid opens on everything the install has.
    expect(pressedChip()).toBe('all');
    expect(cardTitles()).toHaveLength(4);

    await showChip('shared');
    expect(cardTitles()).toEqual([]);
    expect(
      screen.getByText('Design reviews somebody else added you to will appear here.'),
    ).toBeInTheDocument();
  });

  it('makes no request while the deployment’s config is still unknown', async () => {
    // No config means no identity block, which publicIdentityOf reads as 'none'.
    // Guessing the other way would flash "Mine" at every visitor of a default install
    // while /api/public-config was in flight.
    configHolder.current = null;
    signIn();
    seedFourReviews();

    await renderLobby();

    expect(myReviewsMock.list).not.toHaveBeenCalled();
    expect(screen.getByTestId('filter-all')).toHaveAttribute('aria-pressed', 'true');

    await showChip('mine');
    expect(cardTitles()).toEqual([]);
  });
});
