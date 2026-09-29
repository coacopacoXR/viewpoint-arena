// Tests for lib/reviews/membersRepo.ts — who owns a design review, and the roster
// row that has to agree with it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC: "Creating a design review while
// signed in sets owner_id and inserts the owner row." The interesting half of that
// is what it must NOT do: every review written before accounts existed has
// owner_id NULL, and none of them may be quietly handed to whoever saves them
// next. Batch BH's claim action is what fills those in, on purpose.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

const { calls, answers, identity } = vi.hoisted(() => ({
  calls: [] as Call[],
  answers: new Map<string, { data: unknown; error: { message: string } | null; throws?: Error }>(),
  identity: { value: null as null | Record<string, unknown> },
}));

interface QueryChain extends Promise<{ data: unknown; error: { message: string } | null }> {
  select: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  is: (...args: unknown[]) => QueryChain;
  update: (...args: unknown[]) => QueryChain;
  upsert: (...args: unknown[]) => QueryChain;
  maybeSingle: (...args: unknown[]) => QueryChain;
}

function queryChain(table: string): QueryChain {
  const step =
    (op: string) =>
    (...args: unknown[]): QueryChain => {
      calls.push({ table, op, args });
      const configured = answers.get(table);
      if (configured?.throws) throw configured.throws;
      return queryChain(table);
    };
  const answer = answers.get(table) ?? { data: null, error: null };
  return Object.assign(Promise.resolve(answer), {
    select: step('select'),
    eq: step('eq'),
    is: step('is'),
    update: step('update'),
    upsert: step('upsert'),
    maybeSingle: step('maybeSingle'),
  });
}

vi.mock('../../supabase', () => ({
  supabase: { from: (table: string) => queryChain(table) },
  supabaseConfigured: true,
}));

vi.mock('../../identity', () => ({
  getStoredIdentity: () => identity.value,
}));

import { ensureReviewOwner, resetOwnerClaims, signedInAccountId } from '../membersRepo';

const ACCOUNT = '6f1a2b3c-0000-4000-8000-000000000001';

function signedIn(overrides: Record<string, unknown> = {}) {
  identity.value = { name: 'Maria Okafor', color: '#fff', accountId: ACCOUNT, ...overrides };
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  identity.value = null;
  resetOwnerClaims();
});

describe('signedInAccountId', () => {
  it('is the account, when this browser is signed in with one', () => {
    signedIn();
    expect(signedInAccountId()).toBe(ACCOUNT);
  });

  it('is null for a guest, even one whose vp_user still holds an account id', () => {
    // Signing out clears the name and keeps the colour; a browser that was signed
    // in and then joined as a guest can still be holding the old id. The flag is
    // what decides, not the field.
    signedIn({ guest: true });
    expect(signedInAccountId()).toBeNull();
  });

  it('is null on the default install, which never writes an account id', () => {
    signedIn({ accountId: undefined });
    expect(signedInAccountId()).toBeNull();
    identity.value = { name: 'Robin', color: '#fff', accountId: '' };
    expect(signedInAccountId()).toBeNull();
    identity.value = null;
    expect(signedInAccountId()).toBeNull();
  });
});

describe('ensureReviewOwner', () => {
  it('claims a review nobody owns, in the column and in the roster', async () => {
    signedIn();
    answers.set('review_curations', { data: { owner_id: null }, error: null });
    answers.set('review_members', { data: null, error: null });

    expect(await ensureReviewOwner('review-1')).toBe(true);

    const update = calls.find((call) => call.table === 'review_curations' && call.op === 'update');
    expect(update?.args[0]).toEqual({ owner_id: ACCOUNT });
    // Guarded, so two curators who both save a brand-new review produce ONE owner
    // rather than the second silently taking it from the first.
    expect(calls.filter((call) => call.op === 'is').map((call) => call.args)).toEqual([
      ['owner_id', null],
    ]);

    const roster = calls.find((call) => call.table === 'review_members' && call.op === 'upsert');
    expect(roster?.args[0]).toEqual({
      review_id: 'review-1',
      user_id: ACCOUNT,
      role: 'owner',
      added_by: ACCOUNT,
    });
    expect(roster?.args[1]).toEqual({ onConflict: 'review_id,user_id' });
  });

  it('leaves a review that already has an owner exactly as it is', async () => {
    signedIn();
    answers.set('review_curations', { data: { owner_id: 'somebody-else' }, error: null });

    expect(await ensureReviewOwner('review-1')).toBe(false);
    expect(calls.some((call) => call.op === 'update')).toBe(false);
    expect(calls.some((call) => call.table === 'review_members')).toBe(false);
  });

  it('does nothing at all for a browser with no account', async () => {
    identity.value = { name: 'Robin', color: '#fff' };
    answers.set('review_curations', { data: { owner_id: null }, error: null });

    expect(await ensureReviewOwner('review-1')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does nothing for a guest', async () => {
    signedIn({ guest: true });
    expect(await ensureReviewOwner('review-1')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does nothing for an empty review id', async () => {
    signedIn();
    expect(await ensureReviewOwner('')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does nothing when there is no such review', async () => {
    // The setup page can be open on an id that has never been saved. Claiming it
    // would write an owner_id onto a row that does not exist, and a roster row for
    // a review nobody can open.
    signedIn();
    answers.set('review_curations', { data: null, error: null });

    expect(await ensureReviewOwner('review-1')).toBe(false);
    expect(calls.some((call) => call.op === 'update')).toBe(false);
  });

  it('asks once per review per page session, however often the draft is saved', async () => {
    // saveCuration runs on a debounce for as long as a curator edits; without this
    // the ownership check would be a read of the row on every one of them.
    signedIn();
    answers.set('review_curations', { data: { owner_id: null }, error: null });
    answers.set('review_members', { data: null, error: null });

    await ensureReviewOwner('review-1');
    await ensureReviewOwner('review-1');
    await ensureReviewOwner('review-1');

    expect(calls.filter((call) => call.op === 'update')).toHaveLength(1);

    // A different review is a different question.
    await ensureReviewOwner('review-2');
    expect(calls.filter((call) => call.op === 'update')).toHaveLength(2);
  });

  it('answers false when the roster write fails, which is the half-owned review worth a log line', async () => {
    // owner_id is set and the roster is not, so the People tab batch BH builds
    // would render an owner who is not listed. The review still works — resolveRole
    // reads the column first — but this is not a success and must not be reported
    // as one.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    signedIn();
    answers.set('review_curations', { data: { owner_id: null }, error: null });
    answers.set('review_members', { data: null, error: { message: 'roster write refused' } });

    expect(await ensureReviewOwner('review-1')).toBe(false);
    expect(calls.some((call) => call.op === 'update')).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('answers false when the query throws, because a claim must never break a save', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    signedIn();
    answers.set('review_curations', { data: null, error: null, throws: new Error('network down') });

    expect(await ensureReviewOwner('review-1')).toBe(false);
    error.mockRestore();
  });
});
