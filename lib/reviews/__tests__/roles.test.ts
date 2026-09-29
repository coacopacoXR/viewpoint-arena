// The roles table, and how a person gets a role at all.
//
// docs/plan/14-rooms-models-admin-ai.md, "Preparing a review inside its room":
//
//   Everyone can meet, point and comment.
//   Everyone except guests can add and edit cards.
//   Owners and editors run meetings and edit the review.
//   Only owners manage people or delete the review.
//
// The first describe block below is that table transcribed as data, and it is
// written as an explicit 4 × 8 grid rather than as a handful of spot checks
// because this is the ONLY place the grid is stated: the browser hides buttons
// from it, party/room.server.ts refuses socket messages with it, and batch BH
// renders the People tab from it. A missing cell here is a permission that is
// silently granted or silently lost everywhere at once.

import { describe, it, expect } from 'vitest';
import {
  can,
  resolveRole,
  asMemberRole,
  REVIEW_ACTIONS,
  ROLES,
  type ReviewAction,
  type Role,
  type RoleContext,
} from '../roles';

/**
 * The plan's table, as the grid the tests assert against.
 *
 * Spelled out per role and per action instead of derived from ALLOWED in
 * roles.ts: a test that read the implementation's own table would pass whatever
 * that table said, including a row somebody had edited by accident.
 */
const EXPECTED: Record<Role, Record<ReviewAction, boolean>> = {
  owner: {
    meet: true,
    addCard: true,
    editCard: true,
    runMeeting: true,
    editReview: true,
    setModelEditors: true,
    managePeople: true,
    deleteReview: true,
  },
  editor: {
    meet: true,
    addCard: true,
    editCard: true,
    runMeeting: true,
    editReview: true,
    setModelEditors: true,
    managePeople: false,
    deleteReview: false,
  },
  participant: {
    meet: true,
    addCard: true,
    editCard: true,
    runMeeting: false,
    editReview: false,
    setModelEditors: false,
    managePeople: false,
    deleteReview: false,
  },
  guest: {
    meet: true,
    addCard: false,
    editCard: false,
    runMeeting: false,
    editReview: false,
    setModelEditors: false,
    managePeople: false,
    deleteReview: false,
  },
};

describe('can — every role against every action', () => {
  // One assertion per cell, so a failure names the role and the action rather
  // than pointing at a grid.
  for (const role of ROLES) {
    for (const action of REVIEW_ACTIONS) {
      it(`${role} ${EXPECTED[role][action] ? 'may' : 'may NOT'} ${action}`, () => {
        expect(can(role, action)).toBe(EXPECTED[role][action]);
      });
    }
  }

  it('covers every action the plan names, and no others', () => {
    expect([...REVIEW_ACTIONS].sort()).toEqual(
      [
        'addCard',
        'deleteReview',
        'editCard',
        'editReview',
        'managePeople',
        'meet',
        'runMeeting',
        'setModelEditors',
      ].sort(),
    );
  });

  it('gives every role a stated answer for every action', () => {
    for (const role of ROLES) {
      expect(Object.keys(EXPECTED[role]).sort()).toEqual([...REVIEW_ACTIONS].sort());
    }
  });

  it('nobody is above meeting, and no guest is above meeting', () => {
    // "Everyone can meet, point and comment."
    for (const role of ROLES) expect(can(role, 'meet')).toBe(true);
    // "Everyone except guests can add and edit cards" — and nothing else either.
    for (const action of REVIEW_ACTIONS) {
      if (action === 'meet') continue;
      expect(can('guest', action)).toBe(false);
    }
  });

  it('orders the roles: each one may do everything the one below it may', () => {
    const order: Role[] = ['guest', 'participant', 'editor', 'owner'];
    for (let i = 1; i < order.length; i += 1) {
      const below = order[i - 1];
      const above = order[i];
      for (const action of REVIEW_ACTIONS) {
        if (can(below, action)) expect(can(above, action)).toBe(true);
      }
    }
  });
});

// ─── resolveRole ────────────────────────────────────────────────────────────

const ACCOUNT = '6f1a2b3c-0000-4000-8000-000000000001';
const OTHER = '6f1a2b3c-0000-4000-8000-000000000002';

/** A signed-in person on a deployment with accounts, in an unremarkable review. */
function accountsContext(overrides: Partial<RoleContext> = {}): RoleContext {
  return {
    identityMode: 'accounts',
    accountId: ACCOUNT,
    isGuest: false,
    members: [],
    ownerId: null,
    isAdmin: false,
    isMeetingHost: false,
    ...overrides,
  };
}

describe('resolveRole — accounts and sso', () => {
  it('makes the account owner_id names the owner', () => {
    expect(resolveRole(accountsContext({ ownerId: ACCOUNT }))).toBe('owner');
  });

  it('makes an admin the owner even when somebody else owns the review', () => {
    expect(resolveRole(accountsContext({ ownerId: OTHER, isAdmin: true }))).toBe('owner');
  });

  it("makes an admin the owner of a review nobody has claimed", () => {
    // Every review that existed before accounts did has owner_id NULL. Without
    // this, such a review would have nobody who could administer it and batch
    // BH's claim action would have nobody to offer it to.
    expect(resolveRole(accountsContext({ ownerId: null, isAdmin: true }))).toBe('owner');
  });

  it('is not the owner when owner_id names somebody else', () => {
    expect(resolveRole(accountsContext({ ownerId: OTHER }))).toBe('participant');
  });

  it('takes the roster role when the person is on it', () => {
    expect(
      resolveRole(accountsContext({ members: [{ userId: ACCOUNT, role: 'editor' }] })),
    ).toBe('editor');
    expect(
      resolveRole(accountsContext({ members: [{ userId: ACCOUNT, role: 'participant' }] })),
    ).toBe('participant');
  });

  it('reads a roster owner as the owner even when owner_id is NULL', () => {
    expect(
      resolveRole(accountsContext({ members: [{ userId: ACCOUNT, role: 'owner' }] })),
    ).toBe('owner');
  });

  it('ignores a roster row belonging to somebody else', () => {
    expect(
      resolveRole(accountsContext({ members: [{ userId: OTHER, role: 'owner' }] })),
    ).toBe('participant');
  });

  it('makes a signed-in person who is not on the roster a participant', () => {
    expect(resolveRole(accountsContext())).toBe('participant');
  });

  it('makes a guest a guest, whatever else is true of them', () => {
    expect(resolveRole(accountsContext({ isGuest: true }))).toBe('guest');
    // A guest is not on the roster — there is no account to put there — but a
    // payload that claimed both must still come out as the lesser role.
    expect(
      resolveRole(
        accountsContext({ isGuest: true, members: [{ userId: ACCOUNT, role: 'owner' }] }),
      ),
    ).toBe('guest');
    expect(resolveRole(accountsContext({ isGuest: true, isAdmin: true }))).toBe('guest');
  });

  it('makes a browser with no account at all a guest', () => {
    expect(resolveRole(accountsContext({ accountId: null }))).toBe('guest');
    expect(resolveRole(accountsContext({ accountId: null, isAdmin: true }))).toBe('guest');
  });

  it('treats sso exactly like accounts', () => {
    expect(resolveRole(accountsContext({ identityMode: 'sso', ownerId: ACCOUNT }))).toBe('owner');
    expect(resolveRole(accountsContext({ identityMode: 'sso' }))).toBe('participant');
    expect(resolveRole(accountsContext({ identityMode: 'sso', isGuest: true }))).toBe('guest');
  });

  it('prefers the roster over being the meeting host', () => {
    // With accounts, who started the meeting says nothing about what they may
    // do: the host is whoever arrived first, which a supplier's editor could be.
    expect(resolveRole(accountsContext({ isMeetingHost: true }))).toBe('participant');
    expect(
      resolveRole(
        accountsContext({ isMeetingHost: true, members: [{ userId: ACCOUNT, role: 'editor' }] }),
      ),
    ).toBe('editor');
  });
});

describe('resolveRole — no accounts (identity.mode none)', () => {
  function noneContext(overrides: Partial<RoleContext> = {}): RoleContext {
    return {
      identityMode: 'none',
      accountId: null,
      isGuest: false,
      members: [],
      ownerId: null,
      isAdmin: false,
      isMeetingHost: false,
      ...overrides,
    };
  }

  it('makes the meeting host an editor', () => {
    expect(resolveRole(noneContext({ isMeetingHost: true }))).toBe('editor');
  });

  it('makes the admin-passphrase holder the owner', () => {
    expect(resolveRole(noneContext({ isAdmin: true }))).toBe('owner');
  });

  it('makes the admin the owner even when they are not hosting', () => {
    expect(resolveRole(noneContext({ isAdmin: true, isMeetingHost: false }))).toBe('owner');
  });

  it('makes the admin who IS hosting the owner, not the editor', () => {
    expect(resolveRole(noneContext({ isAdmin: true, isMeetingHost: true }))).toBe('owner');
  });

  it('makes everybody else a participant', () => {
    expect(resolveRole(noneContext())).toBe('participant');
  });

  it('never answers guest, because there are no guests on such an install', () => {
    // A `mode: 'none'` deployment has one front door and everybody through it is
    // a colleague. resolveRole has no isGuest branch here on purpose: the plan
    // maps the two things such an install actually has, and 'guest' is neither.
    expect(resolveRole(noneContext({ isGuest: true }))).toBe('participant');
  });

  it('ignores a roster and an owner_id, which such an install never writes', () => {
    expect(
      resolveRole(noneContext({ ownerId: ACCOUNT, members: [{ userId: ACCOUNT, role: 'owner' }] })),
    ).toBe('participant');
  });
});

describe('asMemberRole', () => {
  it('accepts the three stored roles', () => {
    expect(asMemberRole('owner')).toBe('owner');
    expect(asMemberRole('editor')).toBe('editor');
    expect(asMemberRole('participant')).toBe('participant');
  });

  it('refuses anything else rather than defaulting to the most permissive reading', () => {
    expect(asMemberRole('guest')).toBeNull();
    expect(asMemberRole('admin')).toBeNull();
    expect(asMemberRole('OWNER')).toBeNull();
    expect(asMemberRole('')).toBeNull();
    expect(asMemberRole(null)).toBeNull();
    expect(asMemberRole(undefined)).toBeNull();
    expect(asMemberRole(3)).toBeNull();
    expect(asMemberRole({ role: 'owner' })).toBeNull();
  });
});
