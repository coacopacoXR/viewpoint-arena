import { useMemo } from 'react';
import { usePresence } from './PresenceContext';
import { getIdentity } from './identity';

// A person. Kept as a type for the admin panel work (plan 11); no per-review
// roster is stored any more.
// `id` is a stable key for reordering / editing; `name` is what gets written
// onto cards as the assignee string.
export interface TeamMember {
  id: string;
  name: string;
  role?: string;
  email?: string;
}

// One entry in the assembled assignee list. `inRoom` is true when the person
// is currently in the meeting (presence list or the local user) — the UI
// tags these so the host can see who is live vs. on the roster only.
export interface PeopleOption {
  name: string;
  inRoom: boolean;
  // 'unassigned' | 'room' | 'orphan' — lets the UI group or tag.
  source: 'unassigned' | 'room' | 'orphan';
}

export function usePeopleOptions(currentAssignee?: string): PeopleOption[] {
  const { remoteParticipantList, localUserId } = usePresence();


  return useMemo(() => {
    const result: PeopleOption[] = [{ name: 'Unassigned', inRoom: false, source: 'unassigned' }];
    const seen = new Set<string>(['unassigned']);

    // Local user first among room participants.
    const localIdentity = getIdentity();
    if (localIdentity?.name) {
      const key = localIdentity.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name: localIdentity.name, inRoom: true, source: 'room' });
      }
    }

    // Remote participants currently in the room.
    for (const p of remoteParticipantList) {
      if (p.userId === localUserId) continue;
      const key = p.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ name: p.name, inRoom: true, source: 'room' });
    }

    // No stored roster. A per-review list of people was removed on request
    // (user, 2026-09-23: "the adding people shouldn't be done that way,
    // remove it all together"); managing people belongs to the admin panel
    // in docs/plan/11-accounts-and-admin.md, not to every review.

    // Preserve the card's existing value even if it matches nobody — an old
    // assignee must never be silently dropped from the list.
    if (currentAssignee && currentAssignee !== 'Unassigned') {
      const key = currentAssignee.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ name: currentAssignee, inRoom: false, source: 'orphan' });
      }
    }

    return result;
  }, [remoteParticipantList, localUserId, currentAssignee]);
}
