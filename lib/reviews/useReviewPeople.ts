// One design review's people: the read, the writes, and what a refusal says.
//
// docs/plan/15-sessions-and-variants.md batch BW. The room's Edit panel has had a
// People tab since batch BH (components/review/PeopleTab.tsx), and the lobby's
// preview panel now offers the same roster under the review's heading — because
// "add Ana to this review" is something a person thinks of while looking at the
// review from outside it, and the answer until now was to enter the room, turn
// Edit on and find the tab. Two surfaces, ONE reading of the endpoint: this hook
// is the part they share, and each keeps its own layout — the tab the room's dark
// panel, the section the lobby's light one.
//
// WHAT IS DELIBERATELY NOT HERE
//
// No decision about who may change the list. api/reviews/members.ts makes that
// from the caller's verified token and the roster as the database holds it, and
// answers with `canManage`; both surfaces draw their controls from that flag
// rather than from a second reading of lib/reviews/roles.ts, which is what keeps
// a screen and the endpoint from ever disagreeing. Hiding a control is not the
// enforcement — the endpoint refuses the press whether or not a button was drawn.
//
// No account creation either. Adding somebody needs an address that already signs
// in to this install, because a permission has to be keyed on an account and not
// on a name somebody typed; creating accounts is the admin console's job, and the
// sentence an unmatched email gets (the endpoint's own) says so.

import { useCallback, useEffect, useState } from 'react';
import {
  fetchReviewPeople,
  writeReviewMember,
  type MemberWrite,
  type ReviewPerson,
} from './membersClient';
import type { MemberRole } from './roles';

/** What each role is called on screen. Both surfaces say it the same way. */
export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: 'Owner',
  editor: 'Editor',
  participant: 'Participant',
};

/** The roles an owner can hand out. The owner's own row is not one of them. */
export const ASSIGNABLE_ROLES: readonly MemberRole[] = ['editor', 'participant'];

/** The sentence an empty "add somebody" box gets, before any request is made. */
export const MISSING_EMAIL =
  'Enter the email address of somebody who signs in to this install.';

/** What a write failure says when the endpoint gave no sentence of its own. */
export const WRITE_REFUSED = 'That change was refused.';

export interface ReviewPeopleState {
  /**
   * The roster, or null when it has not been read or could not be. Null and [] are
   * different facts and are drawn differently: "nobody is on this review" is an
   * answer, "this review could not be read" is a reason to stop inviting people.
   */
  people: ReviewPerson[] | null;
  ownerId: string | null;
  /** Whether the signed-in person may change this list. An editor may read it. */
  canManage: boolean;
  /** Whether the "make me the owner" line belongs on screen: an admin, and no owner. */
  canClaimOwner: boolean;
  /** The sentence to show, from the endpoint wherever it gave one. */
  error: string | null;
  /** True while a write is in flight, so a second click cannot make a second one. */
  busy: boolean;
  /** Read the roster again. Every write does this itself; offered for a "Try again". */
  reload: () => Promise<void>;
  /** One write, then a re-read. True when it landed. */
  write: (change: MemberWrite) => Promise<boolean>;
  /** `write` for the add form, with the empty-box check both surfaces share. */
  add: (email: string, role: MemberRole) => Promise<boolean>;
}

/**
 * The roster of `reviewId`, and the three writes that change it.
 *
 * @param onRosterChanged called after a write LANDS, so the surface can say so out
 *   loud — the room re-reads its own role, the lobby announces the change on
 *   lib/reviews/rosterEvents and re-reads its grid. Not called on a refusal.
 */
export function useReviewPeople(
  reviewId: string,
  onRosterChanged?: () => void,
): ReviewPeopleState {
  const [people, setPeople] = useState<ReviewPerson[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canClaimOwner, setCanClaimOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const result = await fetchReviewPeople(reviewId);
    if ('error' in result) {
      setError(result.error);
      setPeople(null);
      return;
    }
    setError(null);
    setPeople(result.people.people);
    setOwnerId(result.people.ownerId);
    setCanManage(result.people.canManage);
    setCanClaimOwner(result.people.canClaimOwner);
  }, [reviewId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * One write, then a re-read.
   *
   * The re-read is not tidiness: an add resolves an email to an account id this
   * browser never had, and a claim sets a column that decides everybody's role in
   * the review from now on. Patching a local copy would leave the screen showing a
   * roster the server did not write.
   */
  const write = useCallback(
    async (change: MemberWrite): Promise<boolean> => {
      setBusy(true);
      const result = await writeReviewMember(reviewId, change);
      setBusy(false);
      if (!result.ok) {
        setError(result.error ?? WRITE_REFUSED);
        return false;
      }
      setError(null);
      await reload();
      onRosterChanged?.();
      return true;
    },
    [reviewId, reload, onRosterChanged],
  );

  const add = useCallback(
    async (email: string, role: MemberRole): Promise<boolean> => {
      const address = email.trim();
      // Checked here rather than in each surface so that the two cannot drift into
      // two sentences for the same empty box, and so that no request is made for one.
      if (!address) {
        setError(MISSING_EMAIL);
        return false;
      }
      return write({ action: 'add', email: address, role });
    },
    [write],
  );

  return { people, ownerId, canManage, canClaimOwner, error, busy, reload, write, add };
}
