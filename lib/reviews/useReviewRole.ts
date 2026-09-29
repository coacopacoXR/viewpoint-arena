// What I may do in the design review I am standing in.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. lib/reviews/roles.ts is the
// rule and party/reviewRoles.ts is the room server's copy of the same join; this
// is the browser's. It gathers the six facts resolveRole asks for and hands back
// a role plus a `can(action)` the UI hides buttons with.
//
// Hiding a button is NOT the enforcement — the room server refuses a scene
// change by role, and api/reviews/members.ts refuses a membership write the same
// way. This hook exists so the room does not offer somebody a tool that would
// then be refused, and so the one table in roles.ts is the only place the answer
// is written down.
//
// On a deployment whose identity.mode is 'none' — the default self-hosted
// install — nothing here touches Supabase at all. Not "calls it and ignores the
// answer": the effect returns before the first request, exactly as useAuth does,
// and the role comes out the way it did before roles existed. The meeting host
// gets the editor's powers (which is what the old curate page allowed anybody to
// do, since anybody could open it) and everybody else is a participant.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase';
import { useIdentity } from '../identity';
import { useConnectorConfig } from '../config/ConfigContext';
import { identityRequired, publicIdentityOf } from '../auth/authRules';
import { readReviewRoster, type ReviewRoster, EMPTY_ROSTER } from './membersRepo';
import { REVIEW_ROSTER_CHANGED } from './rosterEvents';
import { can as mayDo, resolveRole, type ReviewAction, type ReviewMember, type Role } from './roles';

export interface UseReviewRoleOptions {
  /** The room's review id. Null for an ad-hoc session, which has no roster. */
  reviewId: string | null | undefined;
  /**
   * store.sessionHostId. Null means nobody has been named yet — a solo session,
   * or a socket that has not heard HOST_CHANGE — and the app reads that as "you
   * are the host" everywhere else (Interface, SharePanel, mayChangeModels), so
   * it reads that way here too.
   */
  sessionHostId: string | null;
  /** presence.localUserId. */
  localUserId: string | null;
}

export interface ReviewRoleState {
  /** My role in this review, resolved from the facts available right now. */
  role: Role;
  /**
   * True when this deployment has identities, so a person's ROLE is the authority
   * on what they may do in the review.
   *
   * False on identity.mode 'none' — the default self-hosted install — where there
   * is no roster to read and the meeting host is the only authority there is. That
   * is the case lib/scene/roomScene.scenePermissions spells as `role: null`, and
   * the room server reaches the same spelling from the other end: its roleFor
   * answers null when reviewFactsCacheFor has no source. `role` above is still
   * resolved on such an install, because `can(role, 'editReview')` is how the
   * meeting host gets the Edit button; it is only the SCENE question that has to
   * know the difference, so a caller that needs the null spelling asks for it here
   * rather than guessing it from the role.
   */
  rolesApply: boolean;
  /** Whether `role` may do `action`. Stable across renders. */
  can: (action: ReviewAction) => boolean;
  /**
   * True while the roster and the admin check are still in flight, and only ever
   * true on a deployment with accounts. Callers that would otherwise flash a
   * button gate on this: a role resolved from an empty roster is the SAFE one
   * (a signed-in person with no membership row is a participant, who may not
   * edit), so waiting is about not showing the owner a room without its Edit
   * button for a frame, not about being wrong.
   */
  loading: boolean;
  /** review_curations.owner_id, or null. The People tab shows the claim line from it. */
  ownerId: string | null;
  /** The roster, for the People tab. Empty until it has been read. */
  members: ReviewMember[];
  /**
   * Re-read the roster. The People tab calls this after a write, so that making
   * somebody an editor takes effect on my screen at once rather than on the next
   * room entry.
   */
  refresh: () => void;
}

/** Whether this person is the meeting the room is holding theirs. */
export function isMeetingHostOf(sessionHostId: string | null, localUserId: string | null): boolean {
  if (sessionHostId === null) return true;
  return localUserId !== null && sessionHostId === localUserId;
}

export function useReviewRole(options: UseReviewRoleOptions): ReviewRoleState {
  const { reviewId, sessionHostId, localUserId } = options;
  const { config } = useConnectorConfig();
  const [identity] = useIdentity();

  const deployment = useMemo(() => publicIdentityOf(config), [config]);
  const mode = deployment.mode;
  const accountsOn = identityRequired(deployment);

  const [roster, setRoster] = useState<ReviewRoster>(EMPTY_ROSTER);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // The default install: no accounts, no roster, no token, no request.
    if (!accountsOn) {
      setRoster(EMPTY_ROSTER);
      setIsAdmin(false);
      setLoaded(true);
      return;
    }

    let cancelled = false;
    setLoaded(false);

    const id = typeof reviewId === 'string' && reviewId !== '' ? reviewId : null;
    const rosterRead = id ? readReviewRoster(id) : Promise.resolve(EMPTY_ROSTER);
    // app_metadata is in the access token GoTrue issued, so "am I an admin of
    // this install" is a read of the session this browser already holds.
    const adminRead = supabase.auth
      .getSession()
      .then(({ data }) => data.session?.user.app_metadata?.role === 'admin')
      .catch(() => false);

    void Promise.all([rosterRead, adminRead])
      .then(([nextRoster, admin]) => {
        if (cancelled) return;
        setRoster(nextRoster);
        setIsAdmin(admin);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        // readReviewRoster catches its own failures and answers EMPTY_ROSTER, and
        // adminRead has a catch of its own, so nothing here rejects today. This is
        // for the day one of them does: a `void`-ed promise that rejects is an
        // unhandled rejection, and — worse — a `.then` that never runs leaves
        // `loaded` false forever, so every caller gating on `loading` waits for an
        // answer that is not coming and the Edit button never appears at all.
        //
        // The roster already in hand is KEPT rather than cleared. On a first read
        // that is EMPTY_ROSTER, which resolves to the safe role (a signed-in
        // person with no membership row is a participant, who may not edit); on a
        // failed refresh() after a People write it is the last good roster, so a
        // database that hiccups cannot demote an owner out of their own review.
        console.error('[useReviewRole] could not read the review’s role facts:', err);
        if (cancelled) return;
        setIsAdmin(false);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [accountsOn, reviewId, nonce]);

  // Read again when this review's roster changes under us — the room's own owner
  // claim lands after the first read (see announceReviewRosterChanged).
  useEffect(() => {
    if (!accountsOn || typeof window === 'undefined') return;
    const onChange = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === reviewId) setNonce((n) => n + 1);
    };
    window.addEventListener(REVIEW_ROSTER_CHANGED, onChange);
    return () => window.removeEventListener(REVIEW_ROSTER_CHANGED, onChange);
  }, [accountsOn, reviewId]);

  const accountId = identity?.guest === true ? null : (identity?.accountId ?? null);

  const role = useMemo(
    () =>
      resolveRole({
        identityMode: mode,
        accountId,
        isGuest: identity?.guest === true,
        members: roster.members,
        ownerId: roster.ownerId,
        isAdmin,
        isMeetingHost: isMeetingHostOf(sessionHostId, localUserId),
      }),
    [mode, accountId, identity?.guest, roster, isAdmin, sessionHostId, localUserId],
  );

  const can = useCallback((action: ReviewAction) => mayDo(role, action), [role]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(
    () => ({
      role,
      rolesApply: accountsOn,
      can,
      loading: accountsOn && !loaded,
      ownerId: roster.ownerId,
      members: roster.members,
      refresh,
    }),
    [role, can, accountsOn, loaded, roster, refresh],
  );
}
