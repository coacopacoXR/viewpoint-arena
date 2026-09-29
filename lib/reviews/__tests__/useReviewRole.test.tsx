// Tests for lib/reviews/useReviewRole.ts — the six facts the browser gathers
// before it asks roles.ts what this person may do.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. The table and resolveRole have
// their own file (roles.test.ts) and nothing here repeats them: what is pinned
// here is the GATHERING — which fact comes from where (the deployment's identity
// block, vp_user, review_curations.owner_id, review_members, the session's
// app_metadata, the room's host id) and what the hook hands back to a screen.
//
// The most load-bearing assertion is the negative one: on identity.mode 'none' —
// every self-hosted install made before identity existed — the hook makes NO
// request at all, is never loading, and answers the role it answered before
// roles existed (the meeting host is an editor, everybody else a participant).
// A default install must not start talking to Supabase because a hook was added.
//
// A database that will not answer is pinned twice at the bottom, because the two
// failures look different from the hook and a screen has to survive both: a read
// that REJECTS is caught, so the hook settles on the safe role and stops loading;
// a read that never settles cannot be caught, so `loading` stays true and the role
// is still the safe one. Either way the answer is a participant — a signed-in
// person with no membership row, who may not edit — because an unreadable roster
// must never be read as "no restrictions".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import type { UserIdentity } from '../../identity';
import type { ReviewRoster } from '../membersRepo';
import type { ReviewMember } from '../roles';
import type { UseReviewRoleOptions } from '../useReviewRole';

/** The slice of a GoTrue session the admin check reads. */
interface FakeSession {
  user: { app_metadata?: { role?: string } | null };
}

interface FakeSessionAnswer {
  data: { session: FakeSession | null };
}

const { rosterMock, getSessionMock, identityHolder, configHolder } = vi.hoisted(() => ({
  rosterMock: vi.fn<(reviewId: string) => Promise<ReviewRoster>>(),
  getSessionMock: vi.fn<() => Promise<FakeSessionAnswer>>(),
  identityHolder: { current: null as UserIdentity | null },
  configHolder: { current: null as Record<string, unknown> | null },
}));

vi.mock('../../supabase', () => ({
  supabase: { auth: { getSession: () => getSessionMock() } },
  supabaseConfigured: true,
}));

vi.mock('../../identity', () => ({
  // The hook only ever reads the first element; the setter is part of the tuple
  // it destructures, so it has to be there.
  useIdentity: (): [UserIdentity | null, (next: UserIdentity) => void] => [
    identityHolder.current,
    () => {},
  ],
}));

vi.mock('../../config/ConfigContext', () => ({
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

// The hook also imports the TYPE ReviewRoster from here; a type-only import is
// erased, so the two runtime exports are all the mock has to carry.
vi.mock('../membersRepo', () => ({
  readReviewRoster: (reviewId: string) => rosterMock(reviewId),
  EMPTY_ROSTER: { ownerId: null, members: [] },
}));

const { useReviewRole } = await import('../useReviewRole');

const ACCOUNTS = { identity: { mode: 'accounts', methods: ['password'], allowGuests: false } };
const NONE = { identity: { mode: 'none', methods: [], allowGuests: false } };

const ME = '6f1a2b3c-0000-4000-8000-000000000001';
const SOMEBODY_ELSE = '6f1a2b3c-0000-4000-8000-000000000002';
const LOCAL_USER = 'presence-user-1';
const REVIEW = 'rev-1';

/** The vp_user a default install holds: a typed name and no account. */
function nameOnly() {
  identityHolder.current = { name: 'Alex Chen', color: '#4F8EF7' };
}

/** A signed-in account, or a guest when `overrides` says so. */
function signIn(overrides: Partial<UserIdentity> = {}) {
  identityHolder.current = { name: 'Alex Chen', color: '#4F8EF7', accountId: ME, ...overrides };
}

function answerRoster(roster: ReviewRoster) {
  rosterMock.mockResolvedValue(roster);
}

/** `role` null means "no session at all", which is what a signed-out browser has. */
function answerSession(role: string | null) {
  getSessionMock.mockResolvedValue({
    data: { session: role === null ? null : { user: { app_metadata: { role } } } },
  });
}

function member(userId: string, role: ReviewMember['role']): ReviewMember {
  return { userId, role };
}

function renderRole(overrides: Partial<UseReviewRoleOptions> = {}) {
  return renderHook(() =>
    useReviewRole({
      reviewId: REVIEW,
      sessionHostId: null,
      localUserId: LOCAL_USER,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  rosterMock.mockReset();
  getSessionMock.mockReset();
  identityHolder.current = null;
  configHolder.current = NONE;
  answerRoster({ ownerId: null, members: [] });
  answerSession(null);
});

// test/setup.ts registers no RTL cleanup, and this file renders a lot.
afterEach(cleanup);

describe("a deployment whose identity.mode is 'none'", () => {
  beforeEach(() => {
    configHolder.current = NONE;
    nameOnly();
  });

  it("gives the meeting host the editor's powers", () => {
    const { result } = renderRole({ sessionHostId: LOCAL_USER, localUserId: LOCAL_USER });

    expect(result.current.role).toBe('editor');
    expect(result.current.can('editReview')).toBe(true);
    // An editor runs the meeting and changes the models; the review is not
    // theirs to hand over or delete.
    expect(result.current.can('managePeople')).toBe(false);
  });

  it('reads a room with no host named yet as "you are the host"', () => {
    // store.sessionHostId is null for a solo session and for a socket that has
    // not heard HOST_CHANGE, and the rest of the app (Interface, SharePanel,
    // mayChangeModels) reads that as "you are the host" — so this does too.
    const { result } = renderRole({ sessionHostId: null, localUserId: LOCAL_USER });

    expect(result.current.role).toBe('editor');
    expect(result.current.can('editReview')).toBe(true);
  });

  it('makes everybody else a participant', () => {
    const { result } = renderRole({ sessionHostId: SOMEBODY_ELSE, localUserId: LOCAL_USER });

    expect(result.current.role).toBe('participant');
    expect(result.current.can('editReview')).toBe(false);
    // Everyone can meet, point and comment — a colleague sent a link is not
    // locked out of the room, only out of editing it.
    expect(result.current.can('meet')).toBe(true);
  });

  it('makes no request at all: no roster read and no session read', () => {
    renderRole({ sessionHostId: LOCAL_USER, localUserId: LOCAL_USER });

    expect(rosterMock).not.toHaveBeenCalled();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('is never loading, because there is nothing to wait for', () => {
    // `loading` is `accountsOn && !loaded`, and accountsOn is false here — so it
    // is false on the very first render, not false after a tick. A caller gating
    // a button on it never sees a frame without one.
    const { result } = renderRole({ sessionHostId: LOCAL_USER, localUserId: LOCAL_USER });

    expect(result.current.loading).toBe(false);
    expect(result.current.ownerId).toBeNull();
    expect(result.current.members).toEqual([]);
    // And the role above is NOT an authority: components/UI/SceneTree.tsx reads
    // this and asks lib/scene/roomScene.scenePermissions with `role: null`, which
    // is the spelling the room server uses when party/reviewRoles has no facts to
    // read. Passing 'editor' there instead would have replaced the host rule with
    // the accounts rule on the one deployment that has no accounts.
    expect(result.current.rolesApply).toBe(false);
  });
});

describe("a deployment whose identity.mode is 'accounts'", () => {
  beforeEach(() => {
    configHolder.current = ACCOUNTS;
    signIn();
  });

  it('reads the owner off review_curations.owner_id, for this review', async () => {
    answerRoster({ ownerId: ME, members: [] });

    const { result } = renderRole({ sessionHostId: SOMEBODY_ELSE, localUserId: LOCAL_USER });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(rosterMock).toHaveBeenCalledWith(REVIEW);
    expect(result.current.role).toBe('owner');
    expect(result.current.can('managePeople')).toBe(true);
    expect(result.current.can('deleteReview')).toBe(true);
    // Here the role IS the authority, which is what tells the scene question to
    // ask about the role rather than about the meeting host.
    expect(result.current.rolesApply).toBe(true);
  });

  it("takes a signed-in editor's powers from their roster row", async () => {
    answerRoster({ ownerId: SOMEBODY_ELSE, members: [member(ME, 'editor')] });

    const { result } = renderRole({ sessionHostId: SOMEBODY_ELSE, localUserId: LOCAL_USER });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('editor');
    expect(result.current.can('editReview')).toBe(true);
    expect(result.current.can('managePeople')).toBe(false);
  });

  it('keeps a roster participant out of the review itself', async () => {
    answerRoster({ ownerId: SOMEBODY_ELSE, members: [member(ME, 'participant')] });

    const { result } = renderRole();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('participant');
    expect(result.current.can('editReview')).toBe(false);
    expect(result.current.can('addCard')).toBe(true);
  });

  it('makes a signed-in person who is on no roster a participant', async () => {
    answerRoster({ ownerId: SOMEBODY_ELSE, members: [member(SOMEBODY_ELSE, 'editor')] });

    const { result } = renderRole({ sessionHostId: LOCAL_USER, localUserId: LOCAL_USER });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Being the meeting host buys nothing on a deployment with accounts: the
    // host is whoever the room server named, which is not an identity.
    expect(result.current.role).toBe('participant');
    expect(result.current.can('editReview')).toBe(false);
  });

  it('makes a guest a guest, whatever the roster says', async () => {
    identityHolder.current = { name: 'Supplier Sam', color: '#F76B4F', guest: true };
    answerRoster({ ownerId: ME, members: [member(ME, 'editor')] });

    const { result } = renderRole();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('guest');
    expect(result.current.can('meet')).toBe(true);
    expect(result.current.can('addCard')).toBe(false);
    expect(result.current.can('editReview')).toBe(false);
  });

  it('makes an admin of the install the owner of somebody else\'s review', async () => {
    answerSession('admin');
    answerRoster({ ownerId: SOMEBODY_ELSE, members: [member(SOMEBODY_ELSE, 'owner')] });

    const { result } = renderRole();

    await waitFor(() => expect(result.current.loading).toBe(false));
    // app_metadata is in the access token this browser already holds, so the
    // check is a read of the session, not a request to the database.
    expect(getSessionMock).toHaveBeenCalledTimes(1);
    expect(result.current.role).toBe('owner');
    expect(result.current.can('managePeople')).toBe(true);
  });

  it('exposes the owner id and the roster for the People tab', async () => {
    const members = [member(SOMEBODY_ELSE, 'owner'), member(ME, 'editor')];
    answerRoster({ ownerId: SOMEBODY_ELSE, members });

    const { result } = renderRole();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ownerId).toBe(SOMEBODY_ELSE);
    expect(result.current.members).toEqual(members);
  });

  it('re-reads the roster when refresh() is called, and shows the new answer', async () => {
    // This is what the People tab calls after a write: making somebody an editor
    // has to take effect on my screen at once, not on my next entry to the room.
    rosterMock
      .mockResolvedValueOnce({ ownerId: null, members: [] })
      .mockResolvedValueOnce({ ownerId: ME, members: [member(ME, 'owner')] });

    const { result } = renderRole();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('participant');

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(rosterMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.ownerId).toBe(ME));
    expect(result.current.role).toBe('owner');
    expect(result.current.can('deleteReview')).toBe(true);
  });

  it('stays on the safe role, and stays loading, when the roster read never answers', async () => {
    // `loaded` only ever flips inside the `.then`, so a read that does not
    // settle leaves loading true and the role resolved from an empty roster —
    // which is the SAFE one: a signed-in person with no membership row is a
    // participant, who may not edit. Nothing here hangs the room, but a caller
    // that gates a button on `loading` would wait forever.
    rosterMock.mockReturnValue(new Promise<ReviewRoster>(() => {}));

    const { result } = renderRole();

    await waitFor(() => expect(rosterMock).toHaveBeenCalledTimes(1));
    expect(result.current.role).toBe('participant');
    expect(result.current.can('editReview')).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.ownerId).toBeNull();
  });

  it('answers the safe role when the read failed and came back empty', async () => {
    // The reachable version of a database outage: readReviewRoster catches every
    // failure and answers EMPTY_ROSTER, so the hook resolves normally and the
    // person is a participant rather than the owner of a room nobody can read.
    answerRoster({ ownerId: null, members: [] });

    const { result } = renderRole({ sessionHostId: LOCAL_USER, localUserId: LOCAL_USER });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('participant');
    expect(result.current.can('editReview')).toBe(false);
    expect(result.current.can('managePeople')).toBe(false);
  });

  it('settles on the safe role when the read REJECTS, rather than waiting forever', async () => {
    // readReviewRoster cannot reject today — it catches everything — so this is
    // the day somebody changes it. An uncaught rejection here would do two
    // damages at once: escape as an unhandled rejection, and leave `loaded` false
    // so that every caller gating a button on `loading` waits for an answer that
    // is never coming. The owner would simply never see their Edit button.
    rosterMock.mockRejectedValue(new Error('database went away'));

    const { result } = renderRole({ sessionHostId: SOMEBODY_ELSE, localUserId: LOCAL_USER });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('participant');
    expect(result.current.can('editReview')).toBe(false);
    expect(result.current.ownerId).toBeNull();
  });

  it('keeps the last good roster when a refresh() fails, so a hiccup cannot demote an owner', async () => {
    rosterMock
      .mockResolvedValueOnce({ ownerId: ME, members: [] })
      .mockRejectedValueOnce(new Error('database went away'));

    const { result } = renderRole({ sessionHostId: SOMEBODY_ELSE, localUserId: LOCAL_USER });
    await waitFor(() => expect(result.current.role).toBe('owner'));

    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(rosterMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Still the owner. Clearing the roster here would have read as "no membership
    // row", which is a participant — and losing Edit mid-meeting because a read
    // blipped is not a safe failure, it is an inexplicable one.
    expect(result.current.role).toBe('owner');
    expect(result.current.can('editReview')).toBe(true);
    expect(result.current.ownerId).toBe(ME);
  });
});
