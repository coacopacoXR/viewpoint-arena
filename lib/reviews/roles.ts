// Who may do what in a design review — the whole rule, in one place.
//
// docs/plan/14-rooms-models-admin-ai.md, "Preparing a review inside its room",
// batch BC. The plan's table is the source of truth and this file is its only
// transcription:
//
//   Everyone can meet, point and comment.
//   Everyone except guests can add and edit cards.
//   Owners and editors run meetings and edit the review.
//   Only owners manage people or delete the review.
//
// Two functions, and the split between them is the point:
//
//   * `can(role, action)` is the table. It knows nothing about accounts,
//     deployments or rooms.
//   * `resolveRole(...)` is how a person in a particular review on a particular
//     install gets a role at all.
//
// Keeping them apart is what lets the SAME answer be computed in three places
// that share no runtime: the browser (hiding a button before it is clicked),
// party/room.server.ts (refusing a scene change on the socket, which is the
// enforcement that actually counts), and — later — the api. A rule that lived
// in the UI would be a rule anybody could lift with devtools.
//
// Pure and dependency-free on purpose: no Supabase, no localStorage, no DOM, so
// workerd can import it exactly as lib/scene/roomScene.ts is.

/**
 * The four roles a person can hold in one design review.
 *
 * 'owner', 'editor' and 'participant' are the values review_members.role stores
 * (docs/supabase-schema.sql). 'guest' is deliberately NOT one of them: a guest
 * has no account, so there is nothing to key a membership row on, and a row
 * keyed on a name somebody typed would be a permission granted to whoever typed
 * it. A guest's role is computed, never stored.
 */
export type Role = 'owner' | 'editor' | 'participant' | 'guest';

/** The three roles that are rows in review_members. */
export type MemberRole = 'owner' | 'editor' | 'participant';

/** One row of the review's roster, as far as a role decision needs it. */
export interface ReviewMember {
  userId: string;
  role: MemberRole;
}

/**
 * Everything a person can be refused.
 *
 * Named after what the person DOES, not after the role that may do it, so that
 * adding a screen never means inventing a new role: a new capability is a new
 * action with a row in ALLOWED below, and the four roles stay the four the plan
 * decided on.
 */
export type ReviewAction =
  /** Be in the room at all: point, comment, watch, listen. */
  | 'meet'
  /** Raise a card, by agent or by hand (batch BG). */
  | 'addCard'
  /** Change a card that is already there. */
  | 'editCard'
  /** Start, stop and save a meeting — the recording and its minutes. */
  | 'runMeeting'
  /** Change the review itself: agenda, viewpoints, pins, requirements, models. */
  | 'editReview'
  /** Decide who else may change the models (BB's "who may change models"). */
  | 'setModelEditors'
  /** Add, remove and re-role members. */
  | 'managePeople'
  /** Delete the review. */
  | 'deleteReview';

export const REVIEW_ACTIONS: readonly ReviewAction[] = [
  'meet',
  'addCard',
  'editCard',
  'runMeeting',
  'editReview',
  'setModelEditors',
  'managePeople',
  'deleteReview',
];

export const ROLES: readonly Role[] = ['owner', 'editor', 'participant', 'guest'];

/**
 * The table.
 *
 * Written as "what each role may do" rather than "who may do each action" so
 * that reading it top to bottom shows the four levels of trust, which is how
 * the plan describes them and how the People screen will.
 *
 * `setModelEditors` belongs to owners AND editors: the table the user approved
 * (the "Review in the Room" sketch, plan 14) lists "Change who may put up models
 * in a meeting" as yes for both. Editors run meetings, and deciding who may put
 * a model up is part of running one.
 */
const ALLOWED: Record<Role, readonly ReviewAction[]> = {
  owner: REVIEW_ACTIONS,
  editor: ['meet', 'addCard', 'editCard', 'runMeeting', 'editReview', 'setModelEditors'],
  participant: ['meet', 'addCard', 'editCard'],
  guest: ['meet'],
};

/** Whether `role` may do `action` in the review it was resolved for. */
export function can(role: Role, action: ReviewAction): boolean {
  return ALLOWED[role].includes(action);
}

/**
 * A role out of a value read from the database or off a wire, or null.
 *
 * Strict, and 'guest' is NOT an answer: a review_members row that says
 * something this code has never heard of — a hand-edited value, a role a later
 * version added — must not be read as the most permissive thing a nullish
 * branch would fall back to. The caller decides what an unknown value means,
 * and every caller here decides "no membership row", which resolveRole then
 * answers as 'participant' for a signed-in person.
 */
export function asMemberRole(value: unknown): MemberRole | null {
  if (value === 'owner' || value === 'editor' || value === 'participant') return value;
  return null;
}

/**
 * This deployment's identity.mode, as a role decision needs it.
 *
 * The same three values lib/config/schema.ts validates and /api/public-config
 * exposes, restated here rather than imported: this module runs inside workerd
 * as well as in a browser, and a type-only import is free but a dependency on
 * the config loader is not.
 */
export type IdentityModeForRoles = 'none' | 'accounts' | 'sso';

export interface RoleContext {
  identityMode: IdentityModeForRoles;
  /** The signed-in account's id, or null when there is no session. */
  accountId: string | null;
  /** True when this browser is in the room without an account. */
  isGuest: boolean;
  /** The review's roster. Empty for a review nobody has added anybody to. */
  members: readonly ReviewMember[];
  /** review_curations.owner_id, or null for a review that has never been claimed. */
  ownerId: string | null;
  /** An admin of the install: app_metadata.role 'admin', or the passphrase holder. */
  isAdmin: boolean;
  /** True when this person is the meeting host — the room server's first arrival. */
  isMeetingHost: boolean;
}

/**
 * The role one person holds in one design review.
 *
 * Two deployments, two rules, and neither is a guess at the other:
 *
 * WITH ACCOUNTS ('accounts' | 'sso'). The owner is the account owner_id names,
 * or any admin of the install — the plan says "Owner (creator, and admins)", and
 * it is also what makes a review whose creator has left manageable. Otherwise
 * the roster decides. Otherwise, a signed-in person who is not on the roster is
 * a participant: they were let into the room, and "everyone can meet, point and
 * comment … everyone except guests can add and edit cards" is exactly that. A
 * guest — or anybody with no account at all — is a guest.
 *
 * An ownerless review (every one that existed before accounts did) therefore
 * resolves its admins to owners and everybody else by the roster, which is what
 * lets the first admin to open one claim it in batch BH instead of finding a
 * review nobody can administer.
 *
 * WITHOUT ACCOUNTS ('none'). There is no roster to read and nobody to be, so the
 * plan maps the two things a password-protected install actually has: the
 * meeting host gets the editor's powers, and the admin passphrase is the owner.
 * The host is an editor and NOT an owner on purpose — a host can run the meeting
 * and change the models, but the review is not theirs to hand over or delete.
 * Everyone else in the room is a participant, which is what a colleague who was
 * sent a link is.
 */
export function resolveRole(context: RoleContext): Role {
  const { identityMode, accountId, isGuest, members, ownerId, isAdmin, isMeetingHost } = context;

  if (identityMode !== 'accounts' && identityMode !== 'sso') {
    if (isAdmin) return 'owner';
    if (isMeetingHost) return 'editor';
    return 'participant';
  }

  // No account means no role above guest, whatever the roster says: the roster
  // is keyed on account ids, and a guest's name is theirs alone.
  if (isGuest || !accountId) return 'guest';
  if (isAdmin) return 'owner';
  if (ownerId !== null && ownerId === accountId) return 'owner';

  for (const member of members) {
    if (member.userId !== accountId) continue;
    return member.role;
  }
  return 'participant';
}
