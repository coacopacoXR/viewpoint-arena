// Archived design reviews stay out of the lobby's grid — under every chip except the
// one that says so — while a link to one still opens it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BE: "archived reviews are hidden from the
// lobby but kept". Batch BO of docs/plan/15-sessions-and-variants.md turned the lobby's
// TWO lists into one grid of cards with four chips over it, and moved the hiding. It
// used to be a filter inside the query listRecentCurations built, plus a listArchivedIds
// cross-check for the participant-fed list. It is now two halves of
// lib/lobby/useLobbyData:
//
//   * readCurations reads EVERY review, archived ones included — the Archived chip has
//     to show them, and `listed` is the separate flag that keeps a link-only review out
//     of the grid;
//   * filterReviews, a pure function, decides which of them a chip shows. 'mine',
//     'shared with me' and 'all' all drop the archived ones; 'archived' is exactly the
//     complement. An archived review is out of the way for its OWNER too, which is why
//     the fixture below puts one in hands this account owns.
//
// Both run for real here, and only the database under them is faked, so the filters
// asserted below are the ones the page applies in production. lib/curationsRepo stays
// real as well, for the one read that must NOT filter: getCurationSummary, which is how
// an invitation link previews a review the grid's sixty newest do not hold. It filters
// on the id and nothing else, or an archived review would stop opening for the person
// holding its link.
//
// TWO ASSERTIONS THIS FILE USED TO MAKE ARE GONE, not moved:
//
//   * the participant-fed "Your design reviews" list. Its rows came out of
//     review_participants, which has no `archived` column to filter on, so the archived
//     ones were dropped by a second query. The grid is built from review_curations
//     alone — a review with no row cannot be a card — so there is no second list to
//     cross-check and lib/curationsRepo.listArchivedIds has no caller on this page.
//   * the invited preview printing the review's description. components/lobby/
//     ReviewPreview shows the title, the people, the session map, the sessions and the
//     last minutes, and no description, so a link to an archived review is asserted
//     here by its title and by the panel it opens in.

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
    // maybeSingle()/single(). Both shapes have to answer `{ data, error }`, because
    // getCurationSummary — which stays real here — awaits a maybeSingle.
    const chain: Record<string, unknown> = {
      then: (onFulfilled: (value: unknown) => unknown) =>
        onFulfilled(settle(table, filters, sort, limit)),
      select: () => query(table, filters, sort, limit),
      eq: (column: string, value: unknown) => query(table, [...filters, { column, op: 'eq', value }], sort, limit),
      neq: (column: string, value: unknown) => query(table, [...filters, { column, op: 'neq', value }], sort, limit),
      is: (column: string, value: unknown) => query(table, [...filters, { column, op: 'is', value }], sort, limit),
      in: (column: string, value: unknown) => query(table, [...filters, { column, op: 'in', value }], sort, limit),
      // Applied rather than ignored: readCurations asks for the sixty newest, and one
      // test below depends on a review falling outside that window.
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

// Only the participant read is faked — and no test here needs it to answer anything,
// because a review_participants row marks a card as one I have been in and cannot make
// a card out of a review the grid has dropped. lib/curationsRepo stays REAL, so
// getCurationSummary is the real one.
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

/** Stands in for RoomPage: reports the address the lobby navigated to. */
const RoomProbe: React.FC = () => {
  const location = useLocation();
  return <span data-testid="room-path">{location.pathname}</span>;
};

/** A review_curations row. `listed`, `archived` and `owner_id` are explicit: the fake
 *  database compares them by value and applies no column defaults. */
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

function signIn() {
  localStorage.setItem(
    'vp_user',
    JSON.stringify({ name: 'Alex Chen', color: '#4F8EF7', accountId: 'account-1' }),
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

async function showChip(chip: 'mine' | 'shared' | 'all' | 'archived') {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`filter-${chip}`));
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLineCache();
  db.tables = {};
  myReviewsMock.list.mockReset().mockResolvedValue([] as MyReview[]);
  configHolder.current = ACCOUNTS;
  signIn();
});

afterEach(cleanup);

describe('the grid', () => {
  it('hides a review an admin has put away from Mine, Shared with me and All', async () => {
    // The archived one is THIS ACCOUNT'S, which is the case worth having a fixture for:
    // putting a review away takes it out of its owner's way too, and the chip that
    // finds it again is the one that says what happened to it.
    db.tables = {
      review_curations: [
        curation({ id: 'room-mine', title: 'Owned and live', owner_id: 'account-1', updated_at: '2026-09-24T00:00:00Z' }),
        curation({ id: 'room-kept', title: 'Kept for everybody', updated_at: '2026-09-23T00:00:00Z' }),
        curation({
          id: 'room-archived',
          title: 'Put away by an admin',
          owner_id: 'account-1',
          archived: true,
          updated_at: '2026-09-22T00:00:00Z',
        }),
      ],
    };

    await renderLobby();

    // Mine is the default chip for a signed-in account, and the archived review is mine.
    expect(screen.getByTestId('filter-mine')).toHaveAttribute('aria-pressed', 'true');
    expect(cardTitles()).toEqual(['Owned and live']);

    await showChip('shared');
    expect(cardTitles()).toEqual([]);

    await showChip('all');
    expect(cardTitles()).toEqual(['Owned and live', 'Kept for everybody']);
    expect(screen.queryByText('Put away by an admin')).toBeNull();
  });

  it('shows it, and only it, under Archived', async () => {
    db.tables = {
      review_curations: [
        curation({ id: 'room-mine', title: 'Owned and live', owner_id: 'account-1', updated_at: '2026-09-24T00:00:00Z' }),
        curation({ id: 'room-kept', title: 'Kept for everybody', updated_at: '2026-09-23T00:00:00Z' }),
        curation({
          id: 'room-archived',
          title: 'Put away by an admin',
          owner_id: 'account-1',
          archived: true,
          updated_at: '2026-09-22T00:00:00Z',
        }),
      ],
    };

    await renderLobby();
    await showChip('archived');

    expect(cardTitles()).toEqual(['Put away by an admin']);
    // Kept, not deleted: the card is a way in, and the preview beside it opens the
    // review the link always opened.
    expect(screen.getByTestId('review-preview').textContent).toContain('Put away by an admin');
  });

  it('still leaves out a link-only review, which is a different flag', async () => {
    // `listed` and `archived` are two flags on one row, and readCurations filters on
    // NEITHER — it reads every review so the Archived chip has something to show. Both
    // are applied by filterReviews, and they are applied to different chips: a
    // link-only review is absent from All, an archived one is present under Archived.
    db.tables = {
      review_curations: [
        curation({ id: 'room-1', title: 'Landing gear review', updated_at: '2026-09-24T00:00:00Z' }),
        curation({ id: 'room-2', title: 'Link only', listed: false, updated_at: '2026-09-23T00:00:00Z' }),
        curation({ id: 'room-3', title: 'Put away by an admin', archived: true, updated_at: '2026-09-22T00:00:00Z' }),
      ],
    };

    await renderLobby();
    await showChip('all');

    expect(cardTitles()).toEqual(['Landing gear review']);

    await showChip('archived');
    expect(cardTitles()).toEqual(['Put away by an admin']);
    expect(screen.queryByText('Link only')).toBeNull();
  });

  it('says so when everything in it has been put away', async () => {
    db.tables = {
      review_curations: [
        curation({ id: 'room-2', title: 'Put away by an admin', archived: true }),
      ],
    };

    await renderLobby();
    await showChip('all');

    // Empty, not stuck loading: the read answered, and the answer is that the only
    // review on this install is one an admin put away.
    expect(screen.getByText('No design reviews yet.')).toBeInTheDocument();
    expect(cardTitles()).toEqual([]);
  });

  it('says so when nothing has been put away', async () => {
    db.tables = {
      review_curations: [curation({ id: 'room-1', title: 'Landing gear review' })],
    };

    await renderLobby();
    await showChip('archived');

    expect(screen.getByText('No design reviews have been put away.')).toBeInTheDocument();
  });
});

describe('a link to an archived review', () => {
  it('still previews it, because the lobby is not the only way in', async () => {
    // Archiving hides a review from the chips; it does not break the address somebody
    // already has. readCurations reads archived rows for exactly this reason — the grid
    // holds the row, no chip shows it, and an invitation puts it at the front anyway.
    db.tables = {
      review_curations: [
        curation({
          id: 'room-2',
          title: 'Put away by an admin',
          archived: true,
          updated_at: '2026-09-22T00:00:00Z',
        }),
      ],
    };

    await renderLobby({ joinRoomId: 'room-2' });

    // No chip shows this review — the chip is Mine and it is nobody's — but "you have
    // been invited to THIS" is the one thing the invited-preview flow must not lose, so
    // it is a card and it is the selected one.
    expect(cardTitles()).toEqual(['Put away by an admin']);
    expect(screen.getByTestId('review-preview').textContent).toContain('Put away by an admin');
    // Arriving by a link makes Join the primary button.
    expect(screen.getByTestId('preview-join')).toBeInTheDocument();
    expect(screen.queryByTestId('preview-open-room')).toBeNull();
  });

  it('still previews one the grid’s sixty newest do not hold', async () => {
    // The case getCurationSummary exists for: a review older than the grid's window is
    // still a review somebody was invited to. That read filters on the id and nothing
    // else, so an archived review answers it exactly as a live one does — and the card
    // and the preview below are built from its answer, because the grid's own read
    // never returned the row.
    const HOUR = 3_600_000;
    const newer = Array.from({ length: 61 }, (_, index) =>
      curation({
        id: `room-filler-${index}`,
        title: `A newer review ${index}`,
        updated_at: new Date(Date.UTC(2026, 0, 1) + index * HOUR).toISOString(),
      }),
    );
    db.tables = {
      review_curations: [
        ...newer,
        curation({
          id: 'room-old',
          title: 'Put away years ago',
          archived: true,
          updated_at: new Date(Date.UTC(2020, 0, 1)).toISOString(),
        }),
      ],
    };

    await renderLobby({ joinRoomId: 'room-old' });

    expect(screen.getByTestId('review-preview').textContent).toContain('Put away years ago');
    expect(screen.getByTestId('preview-join')).toBeInTheDocument();

    await showChip('all');
    // Sixty from the grid's own read, which caps at the sixty newest, and then the
    // invited one at the front — which is the proof of where it came from: a review the
    // cap left out is a review only getCurationSummary could have answered with.
    const titles = cardTitles();
    expect(titles).toHaveLength(61);
    expect(titles[0]).toBe('Put away years ago');
  });
});
