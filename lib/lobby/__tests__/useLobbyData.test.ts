// What the lobby's grid is drawn from, and what the four chips over it mean.
//
// docs/plan/15-sessions-and-variants.md batch BO. The chips are the new lobby's only
// navigation, so what each one shows is the thing worth pinning: "Mine" is the reviews
// this account owns, "Shared with me" is the ones somebody else added it to, "All" is the
// listed ones, and "Archived" is exactly what an admin put away. A review an admin
// archived is out of the way for its OWN owner too — the chip that finds it is the one
// that says so.
//
// The fixture is a database, not a component: the hook is given table rows and the
// assertions are about the reviews it derives, so a chip that started showing archived
// reviews would fail here rather than only in a browser.
//
// `supabase` is mocked as a chainable builder answering per table. That is the shape
// every other test in this repo uses for it (see pages/__tests__/lobbyNewSession.test.tsx),
// and it is what lets one fixture serve the seven reads the hook batches.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { MyReview } from '../../reviewParticipantsRepo';
import type { LineSession } from '../../reviews/linesRepo';

const { tables, mineMock, calls } = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  mineMock: { current: [] as MyReview[] },
  /** How many table reads the hook has made, so a test can prove a chip made none. */
  calls: { count: 0 },
}));

vi.mock('../../supabase', () => {
  const OPS = ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle', 'single', 'is', 'neq'];
  function chainFor(table: string) {
    const methods: Record<string, () => unknown> = {};
    for (const op of OPS) methods[op] = () => chainFor(table);
    // Read when from() is called, which is inside the hook's effect and therefore after
    // beforeEach has filled the fixture in.
    return Object.assign(Promise.resolve({ data: tables[table] ?? [], error: null }), methods);
  }
  return {
    supabase: {
      from: (table: string) => {
        calls.count += 1;
        return chainFor(table);
      },
      auth: { getSession: async () => ({ data: { session: null } }) },
    },
    supabaseConfigured: true,
  };
});

vi.mock('../../reviewParticipantsRepo', () => ({
  listMyReviews: () => Promise.resolve(mineMock.current),
}));

const { useLobbyData, filterReviews, metaLineOf, peopleOf, standingOf, variantCountOf } =
  await import('../useLobbyData');
type LobbyReview = import('../useLobbyData').LobbyReview;

const ME = 'account-me';
const OTHER = 'account-other';

function curation(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Review ${id}`,
    description: '',
    asset: { modelType: 'imported', importedFileName: `${id}.glb` },
    thumbnail: null,
    owner_id: OTHER,
    archived: false,
    listed: true,
    created_at: '2026-09-01T09:00:00.000Z',
    updated_at: '2026-09-20T09:00:00.000Z',
    ...over,
  };
}

/** One review that has met twice on its main line and once on an adopted variant. */
const SESSIONS = [
  {
    id: 's1', review_id: 'r1', title: 'Kickoff', ended_at: '2026-09-20T09:00:00.000Z',
    participant_count: 3, attendee_names: ['Robin', 'Ben', 'Olga'], model_name: 'hinge.glb',
    line_id: 'line-main', seq: 1, revision_ids: [], summary: null,
  },
  {
    id: 's2', review_id: 'r1', title: 'Steel pin', ended_at: '2026-09-22T09:00:00.000Z',
    participant_count: 2, attendee_names: ['Robin', 'Ben'], model_name: 'hinge.glb',
    line_id: 'line-a', seq: 1, revision_ids: [], summary: null,
  },
  {
    id: 's3', review_id: 'r1', title: 'Follow up', ended_at: '2026-09-24T09:00:00.000Z',
    participant_count: 2, attendee_names: ['Robin', 'Maria'], model_name: 'hinge.glb',
    line_id: 'line-main', seq: 2, revision_ids: [],
    summary: '## Risks raised\n- Pin wears after 1000 cycles',
  },
];

const LINES = [
  {
    id: 'line-main', review_id: 'r1', kind: 'main', name: 'Main line', letter: null,
    parent_session_id: null, status: 'active', created_by: ME, created_by_name: 'Robin',
    created_at: '2026-09-20T09:00:00.000Z', closed_at: null,
  },
  {
    id: 'line-a', review_id: 'r1', kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parent_session_id: 's1', status: 'adopted', created_by: ME, created_by_name: 'Robin',
    created_at: '2026-09-21T09:00:00.000Z', closed_at: '2026-09-23T09:00:00.000Z',
  },
];

const ITEMS = [
  { review_id: 'r1', type: 'RISK' },
  { review_id: 'r1', type: 'RISK' },
  { review_id: 'r1', type: 'ACTION' },
  { review_id: 'r2', type: 'RATIONALE' },
];

const REVISIONS = [
  { review_id: 'r1', line: 'hinge', revision: 'A', created_at: '2026-09-20T09:00:00.000Z' },
  { review_id: 'r1', line: 'hinge', revision: 'B', created_at: '2026-09-22T09:00:00.000Z' },
];

/** r1 mine, r2 shared with me, r3 archived, r4 link-only. */
function fixture() {
  tables['review_curations'] = [
    curation('r1', { title: 'Door hinge', owner_id: ME, thumbnail: 'data:image/jpeg;base64,AAAA' }),
    curation('r2', { title: 'Bike frame' }),
    curation('r3', { title: 'Put away', archived: true, owner_id: ME }),
    curation('r4', { title: 'Link only', listed: false }),
  ];
  tables['review_members'] = [{ review_id: 'r2', user_id: ME, role: 'editor' }];
  tables['tracker_sessions'] = SESSIONS;
  tables['review_lines'] = LINES;
  tables['tracker_items'] = ITEMS;
  tables['model_revisions'] = REVISIONS;
  mineMock.current = [
    { reviewId: 'r4', role: 'participant', firstJoinedAt: '2026-09-19T09:00:00.000Z', lastJoinedAt: '2026-09-19T09:00:00.000Z', title: 'Link only' },
  ];
}

async function load(options: { accountId: string | null; isGuest?: boolean } = { accountId: ME }) {
  const { result } = renderHook(() =>
    useLobbyData({ accountId: options.accountId, isGuest: options.isGuest ?? false }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  return { result };
}

function byId(reviews: readonly LobbyReview[], id: string): LobbyReview {
  const found = reviews.find((review) => review.id === id);
  if (!found) throw new Error(`no review ${id} in ${reviews.map((r) => r.id).join(',')}`);
  return found;
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  mineMock.current = [];
  calls.count = 0;
  fixture();
});

describe('useLobbyData — the chips', () => {
  it('starts on Mine for somebody signed in, and on All where there are no accounts', async () => {
    expect((await load()).result.current.filter).toBe('mine');
    expect((await load({ accountId: null })).result.current.filter).toBe('all');
  });

  it('Mine is the reviews this account owns, and not the ones it was only added to', async () => {
    const { result: { current } } = await load();
    expect(current.visible.map((review) => review.id)).toEqual(['r1']);
  });

  it('Shared with me is a review somebody else owns and this account is on the roster of', async () => {
    // r2 through review_members, r4 through review_participants — being on the roster and
    // having stood in the room are two different reasons a review is yours to find again,
    // and both belong under this chip.
    const { result } = await load();
    expect(filterReviews(result.current.reviews, 'shared').map((r) => r.id)).toEqual(['r2', 'r4']);
  });

  it('Shared with me also holds a review this account only ever stood in', async () => {
    // r4 is link-only and unlisted, so `all` hides it — but this account was in the room,
    // and a review you have been part of is yours to find again on Monday morning.
    const { result } = await load();
    expect(filterReviews(result.current.reviews, 'shared').map((r) => r.id)).toContain('r4');
  });

  it('All is the listed reviews, and not the link-only or the archived ones', async () => {
    const { result } = await load();
    expect(filterReviews(result.current.reviews, 'all').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('Archived is exactly what an admin put away, including this account’s own', async () => {
    const { result } = await load();
    expect(filterReviews(result.current.reviews, 'archived').map((r) => r.id)).toEqual(['r3']);
  });

  it('switching chip makes no request, because the set is already in hand', async () => {
    const { result } = await load();
    const readsBefore = calls.count;
    result.current.setFilter('archived');
    await waitFor(() => expect(result.current.filter).toBe('archived'));
    expect(calls.count).toBe(readsBefore);
    expect(result.current.visible.map((r) => r.id)).toEqual(['r3']);
  });
});

describe('useLobbyData — what a card says', () => {
  it('counts the still-open cards by kind, for the whole grid in one read', async () => {
    const { result } = await load();
    expect(byId(result.current.reviews, 'r1').openCards).toEqual({ RISK: 2, ACTION: 1, RATIONALE: 0 });
    expect(byId(result.current.reviews, 'r2').openCards).toEqual({ RISK: 0, ACTION: 0, RATIONALE: 1 });
  });

  it('says the newest revision and when the review last met', async () => {
    const { result } = await load();
    const review = byId(result.current.reviews, 'r1');
    expect(review.revision).toBe('Rev B');
    expect(metaLineOf(review)).toContain('Rev B');
    expect(metaLineOf(review)).toContain('last session');
    expect(metaLineOf(review)).toContain('you own it');
  });

  it('carries the snapshot the room took, and the model name for the card that has none', async () => {
    const { result } = await load();
    expect(byId(result.current.reviews, 'r1').thumbnail).toBe('data:image/jpeg;base64,AAAA');
    expect(byId(result.current.reviews, 'r2').thumbnail).toBeNull();
    expect(byId(result.current.reviews, 'r2').modelName).toBe('r2.glb');
  });

  it('holds the meetings and the lines a mini map needs, oldest first and main line first', async () => {
    const { result } = await load();
    const review = byId(result.current.reviews, 'r1');
    expect(review.sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3']);
    expect(review.lines.map((line) => line.kind)).toEqual(['main', 'variant']);
    expect(variantCountOf(review)).toBe(1);
  });

  it('names the people who have been in it, across every meeting', async () => {
    const { result } = await load();
    const people = peopleOf({ sessions: byId(result.current.reviews, 'r1').sessions });
    expect(people.names).toEqual(['Robin', 'Ben', 'Olga', 'Maria']);
    expect(people.count).toBe(4);
  });

  it('falls back to the head count for a meeting recorded before names were stored', () => {
    // attendee_names is [] for every meeting recorded before batch BM, and the count is
    // still a true statement about how many people were in the room.
    const nameless: LineSession = {
      id: 's0',
      title: 'Before names were stored',
      endedAt: '2026-09-18T09:00:00.000Z',
      participantCount: 3,
      attendeeNames: [],
      modelName: null,
      lineId: null,
      seq: null,
      revisionIds: [],
      summary: null,
    };
    const people = peopleOf({ sessions: [nameless] });
    expect(people.names).toEqual([]);
    expect(people.count).toBe(3);
  });

  it('says what this account is to the review, in one word', async () => {
    const { result } = await load();
    expect(standingOf(byId(result.current.reviews, 'r1'))).toBe('you own it');
    expect(standingOf(byId(result.current.reviews, 'r2'))).toBe('editor');
    expect(standingOf(byId(result.current.reviews, 'r4'))).toBe('you have been in it');
  });

  it('reads a review nothing is known about as no sessions yet, rather than as a gap', async () => {
    const { result } = await load();
    const review = byId(result.current.reviews, 'r3');
    expect(review.sessions).toEqual([]);
    expect(review.revision).toBeNull();
    expect(metaLineOf(review)).toContain('no sessions yet');
  });
});

describe('useLobbyData — an install with nothing to read', () => {
  it('answers an empty grid where no account is signed in, and never claims a review is mine', async () => {
    const { result } = await load({ accountId: null });
    expect(result.current.reviews.every((review) => !review.mine)).toBe(true);
    expect(filterReviews(result.current.reviews, 'mine')).toEqual([]);
  });

  it('drops a deleted review without re-reading the whole grid', async () => {
    const { result } = await load({ accountId: null });
    expect(result.current.reviews.map((r) => r.id)).toContain('r1');
    result.current.forget('r1');
    await waitFor(() => expect(result.current.reviews.map((r) => r.id)).not.toContain('r1'));
  });
});
