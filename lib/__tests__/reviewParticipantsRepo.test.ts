// Tests for lib/reviewParticipantsRepo.ts — the shape of the one write, who is
// allowed to make it, the read that fills the lobby's "Your reviews", and the
// failures that must not escape into a room.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

interface Answer {
  data: unknown;
  error: unknown;
  /** Make the next step of the chain throw, the way a dropped network does. */
  throws?: Error;
}

// vi.hoisted, because the module factory below runs while these are still in
// their TDZ if they are ordinary declarations.
const { calls, answers } = vi.hoisted(() => ({
  calls: [] as Call[],
  answers: new Map<string, Answer>(),
}));

/**
 * A PostgREST query builder: every step records itself and returns another
 * builder, and the whole thing is awaitable, which is how supabase-js works.
 */
interface QueryChain extends Promise<Answer> {
  select: (...args: unknown[]) => QueryChain;
  upsert: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  in: (...args: unknown[]) => QueryChain;
  order: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
}

function queryChain(table: string): QueryChain {
  const step =
    (op: string) =>
    (...args: unknown[]): QueryChain => {
      calls.push({ table, op, args });
      const configured = answers.get(table);
      // Thrown from the step, not handed back as a rejected promise: a chain
      // nobody awaits would turn that into an unhandled rejection.
      if (configured?.throws) throw configured.throws;
      return queryChain(table);
    };
  const answer = answers.get(table) ?? { data: [], error: null };
  return Object.assign(Promise.resolve(answer), {
    select: step('select'),
    upsert: step('upsert'),
    eq: step('eq'),
    in: step('in'),
    order: step('order'),
    limit: step('limit'),
  });
}

vi.mock('../supabase', () => ({
  supabase: { from: (table: string) => queryChain(table) },
  supabaseConfigured: true,
}));

import {
  recordJoin,
  listMyReviews,
  joinRoleFor,
  describeLastVisit,
  type MyReview,
} from '../reviewParticipantsRepo';

/** The only upsert the repo makes, or null when it made none. */
function upsertCall(): Call | undefined {
  return calls.find((c) => c.op === 'upsert');
}

function signIn(overrides: Record<string, unknown> = {}) {
  localStorage.setItem(
    'vp_user',
    JSON.stringify({
      name: 'Alex Chen',
      color: '#4F8EF7',
      accountId: 'account-1',
      guest: false,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  localStorage.clear();
  // Silenced for the whole suite: every failure path in this repo logs, and
  // printing those would bury the assertions that matter.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordJoin — the write', () => {
  it('upserts on the primary key, with the columns the schema owns left out', async () => {
    signIn();
    answers.set('review_participants', { data: [], error: null });

    const ok = await recordJoin('room-1', 'participant');

    expect(ok).toBe(true);
    const call = upsertCall();
    expect(call?.table).toBe('review_participants');
    expect(call?.args[1]).toEqual({ onConflict: 'review_id,user_id' });

    // No user_id: the column default is auth.uid(), so the row belongs to
    // whoever the token says is writing it and the insert policy can pass.
    // No first_joined_at: an existing row keeps the time it was first written.
    const row = call?.args[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['last_joined_at', 'review_id']);
    expect(row.review_id).toBe('room-1');
    expect(typeof row.last_joined_at).toBe('string');
  });

  it('omits role for a participant, so the write cannot downgrade a host', async () => {
    // PostgREST updates only the columns present in the body, so leaving role
    // out is what makes the conflict path bump last_joined_at and nothing
    // else — a host who rejoins as an ordinary participant stays a host. On
    // the insert path the column's own default supplies 'participant'.
    signIn();
    answers.set('review_participants', { data: [], error: null });

    await recordJoin('room-1', 'participant');

    expect(upsertCall()?.args[0]).not.toHaveProperty('role');
  });

  it('sends role only when this client hosted the session', async () => {
    signIn();
    answers.set('review_participants', { data: [], error: null });

    await recordJoin('room-1', 'host');

    expect(upsertCall()?.args[0]).toMatchObject({ review_id: 'room-1', role: 'host' });
  });

  it('answers false without touching the database when nobody is signed in', async () => {
    // The default install: identity.mode 'none' never writes an accountId into
    // vp_user, so the table stays empty and a room behaves as it always did.
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Alex Chen', color: '#4F8EF7' }));

    expect(await recordJoin('room-1', 'host')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('answers false for a guest, who has an identity but no account', async () => {
    localStorage.setItem(
      'vp_user',
      JSON.stringify({ name: 'Supplier Sam', color: '#4F8EF7', guest: true }),
    );

    expect(await recordJoin('room-1', 'participant')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('answers false for an empty room id', async () => {
    signIn();

    expect(await recordJoin('', 'participant')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('logs and swallows a database error', async () => {
    signIn();
    answers.set('review_participants', {
      data: null,
      error: { code: '42P01', message: 'relation "review_participants" does not exist' },
    });

    // An install whose database has not had the schema re-applied yet must
    // still open the room.
    await expect(recordJoin('room-1', 'host')).resolves.toBe(false);
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it('logs and swallows a throw', async () => {
    signIn();
    answers.set('review_participants', {
      data: null,
      error: null,
      throws: new Error('network down'),
    });

    await expect(recordJoin('room-1', 'host')).resolves.toBe(false);
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });
});

describe('listMyReviews — the read', () => {
  const rows = [
    {
      review_id: 'room-2',
      role: 'participant',
      first_joined_at: '2026-09-20T09:00:00Z',
      last_joined_at: '2026-09-23T09:00:00Z',
    },
    {
      review_id: 'room-1',
      role: 'host',
      first_joined_at: '2026-09-19T09:00:00Z',
      last_joined_at: '2026-09-24T09:00:00Z',
    },
  ];

  it('asks for my rows, newest first, and caps the list', async () => {
    signIn();
    answers.set('review_participants', { data: rows, error: null });

    await listMyReviews();

    const select = calls.find((c) => c.table === 'review_participants' && c.op === 'select');
    expect(select?.args[0]).toBe('review_id,role,first_joined_at,last_joined_at');
    // RLS is the control; this is the second line behind it.
    expect(calls).toContainEqual({
      table: 'review_participants',
      op: 'eq',
      args: ['user_id', 'account-1'],
    });
    expect(calls).toContainEqual({
      table: 'review_participants',
      op: 'order',
      args: ['last_joined_at', { ascending: false }],
    });
    expect(calls).toContainEqual({ table: 'review_participants', op: 'limit', args: [20] });
  });

  it('titles a curated review from a second query, and leaves an ad-hoc one untitled', async () => {
    signIn();
    answers.set('review_participants', { data: rows, error: null });
    answers.set('review_curations', { data: [{ id: 'room-1', title: 'Landing gear review' }], error: null });

    const reviews: MyReview[] = await listMyReviews();

    // No foreign key and no embedded select: the room ids go back as a filter,
    // because an ad-hoc session has no curation row to join to.
    expect(calls).toContainEqual({
      table: 'review_curations',
      op: 'select',
      args: ['id,title'],
    });
    expect(calls).toContainEqual({
      table: 'review_curations',
      op: 'in',
      args: ['id', ['room-2', 'room-1']],
    });

    expect(reviews).toEqual([
      {
        reviewId: 'room-2',
        role: 'participant',
        firstJoinedAt: '2026-09-20T09:00:00Z',
        lastJoinedAt: '2026-09-23T09:00:00Z',
        title: null,
      },
      {
        reviewId: 'room-1',
        role: 'host',
        firstJoinedAt: '2026-09-19T09:00:00Z',
        lastJoinedAt: '2026-09-24T09:00:00Z',
        title: 'Landing gear review',
      },
    ]);
  });

  it('reads an unknown role as the lesser one', async () => {
    signIn();
    answers.set('review_participants', {
      data: [{ ...rows[0], role: 'owner' }],
      error: null,
    });

    const reviews = await listMyReviews();

    expect(reviews[0].role).toBe('participant');
  });

  it('honours a limit of its own', async () => {
    signIn();
    answers.set('review_participants', { data: [], error: null });

    await listMyReviews(5);

    expect(calls).toContainEqual({ table: 'review_participants', op: 'limit', args: [5] });
  });

  it('queries nothing at all when nobody is signed in', async () => {
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Alex', color: '#fff', guest: true }));

    expect(await listMyReviews()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers with an empty list when the table is not there yet', async () => {
    signIn();
    answers.set('review_participants', {
      data: null,
      error: { code: '42P01', message: 'relation "review_participants" does not exist' },
    });

    // The lobby renders its ordinary empty state, which is the truth: there is
    // nothing to show. An install that re-applies the schema gets the list.
    expect(await listMyReviews()).toEqual([]);
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });

  it('still lists the reviews when only the title lookup failed', async () => {
    signIn();
    answers.set('review_participants', { data: rows, error: null });
    answers.set('review_curations', { data: null, error: { code: '42501', message: 'denied' } });

    const reviews = await listMyReviews();

    expect(reviews).toHaveLength(2);
    expect(reviews.every((r) => r.title === null)).toBe(true);
  });
});

describe('joinRoleFor — when a room entry counts', () => {
  const localUserId = 'user-maria';

  it('records nothing at all while the person is still at the door', () => {
    // Admission, not arrival: a waiting room is not a review somebody took
    // part in, and a knock the host declined never becomes one.
    expect(joinRoleFor({ admitted: false, sessionHostId: localUserId, localUserId })).toBeNull();
    expect(joinRoleFor({ admitted: false, sessionHostId: 'host-1', localUserId })).toBeNull();
    expect(joinRoleFor({ admitted: false, sessionHostId: null, localUserId })).toBeNull();
  });

  it('records the session host as the host', () => {
    expect(joinRoleFor({ admitted: true, sessionHostId: localUserId, localUserId })).toBe('host');
  });

  it('records everybody else as a participant', () => {
    expect(joinRoleFor({ admitted: true, sessionHostId: 'host-1', localUserId })).toBe(
      'participant',
    );
  });

  it('reads a host it has not heard about yet as a participant', () => {
    // HOST_CHANGE reaches the client one message after JOIN_ADMITTED, so the
    // first write can predate knowing. Guessing "host" there would record a
    // participant as the host of somebody else's review, and the role never
    // downgrades; the caller writes again once it knows, and that write can
    // only be the upgrade.
    expect(joinRoleFor({ admitted: true, sessionHostId: null, localUserId })).toBe('participant');
  });
});

describe('describeLastVisit', () => {
  // Built from LOCAL time, because the label counts calendar days in the
  // reader's own timezone: a fixed UTC instant would change the expected
  // answer depending on where the suite runs.
  const now = new Date(2026, 8, 24, 15, 0).getTime();

  /** An ISO timestamp `day` days into September 2026, at a local time. */
  function at(day: number, hour = 9, minute = 0): string {
    return new Date(2026, 8, day, hour, minute).toISOString();
  }

  it('says today for anything since midnight', () => {
    expect(describeLastVisit(at(24, 8), now)).toBe('today');
    expect(describeLastVisit(new Date(now).toISOString(), now)).toBe('today');
  });

  it('counts calendar days, not 24-hour periods', () => {
    // Twenty minutes after midnight, a review joined at 23:50 the evening
    // before is "yesterday" — not "today", and not "1 day ago".
    const justAfterMidnight = new Date(2026, 8, 24, 0, 10).getTime();
    expect(describeLastVisit(at(23, 23, 50), justAfterMidnight)).toBe('yesterday');
  });

  it('says yesterday, then days, then the date', () => {
    expect(describeLastVisit(at(23), now)).toBe('yesterday');
    expect(describeLastVisit(at(21), now)).toBe('3 days ago');
    expect(describeLastVisit(at(18), now)).toBe('6 days ago');
    // Past a week it falls back to the same short date the rest of the lobby
    // renders (en-GB, day + short month). A pattern rather than a literal,
    // because CLDR's abbreviation for September is "Sep" in some versions and
    // "Sept" in others — the point is that it stopped counting days.
    expect(describeLastVisit(at(1), now)).toMatch(/^1 Sep/);
  });

  it('answers with nothing for a timestamp it cannot read', () => {
    expect(describeLastVisit('not a date', now)).toBe('');
  });
});
