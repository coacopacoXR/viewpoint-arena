// Leading with nobody following is just free view with an extra label. When
// the last follower leaves, drop back — otherwise the leader stays pinned in
// "SYNC ACTIVE: LEADING" (and the dock keeps telling everyone they are
// following someone who has stopped caring).

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { usePresence } from './PresenceContext';
import type { RemoteParticipantInfo } from './usePartyPresence';

export const LEADER_RELEASE_NOTE_MS = 4000;

/**
 * True only on the ≥1 → 0 transition. Starting to lead with nobody joined yet
 * (0 → 0) must not immediately undo the leader's own button press, and a
 * follower who is mid-nudge still counts as following, so looking around can
 * never trigger this either.
 */
export function shouldAutoReleaseLeader(input: {
  prevFollowerCount: number;
  followerCount: number;
  isLeading: boolean;
}): boolean {
  const { prevFollowerCount, followerCount, isLeading } = input;
  return isLeading && prevFollowerCount >= 1 && followerCount === 0;
}

export function countFollowers(
  participants: RemoteParticipantInfo[],
  localUserId: string,
): number {
  return participants.filter(p => p.followingUserId === localUserId).length;
}

/**
 * Watches the follower count while this client leads the arena. On the last
 * follower leaving, stops leading locally, tells the room, and reports a note
 * to show for LEADER_RELEASE_NOTE_MS.
 */
export function useLeaderAutoRelease(): { noteVisible: boolean } {
  const { localUserId, remoteParticipantList, broadcastLeaderChange } = usePresence();
  const leaderId = useStore(state => state.leaderId);
  const followingRemoteUserId = useStore(state => state.followingRemoteUserId);
  const isBoardroomMode = useStore(state => state.isBoardroomMode);
  const [noteVisible, setNoteVisible] = useState(false);

  const followerCount = countFollowers(remoteParticipantList, localUserId);

  // broadcastLeaderChange is recreated on every provider render; holding it in
  // a ref keeps the effect below keyed on the values that actually matter.
  const broadcastRef = useRef(broadcastLeaderChange);
  broadcastRef.current = broadcastLeaderChange;

  const prevCountRef = useRef(followerCount);
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    prevCountRef.current = followerCount;

    const isLeading = leaderId === 'USER' && !followingRemoteUserId && !isBoardroomMode;
    if (!shouldAutoReleaseLeader({ prevFollowerCount: prevCount, followerCount, isLeading })) return;

    useStore.getState().setLeader(null);
    broadcastRef.current(null);

    setNoteVisible(true);
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNoteVisible(false), LEADER_RELEASE_NOTE_MS);
  }, [followerCount, leaderId, followingRemoteUserId, isBoardroomMode]);

  useEffect(() => {
    return () => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    };
  }, []);

  return { noteVisible };
}
