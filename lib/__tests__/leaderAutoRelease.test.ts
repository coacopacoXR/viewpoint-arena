// Leading with nobody following is just free view with a label on it. The
// release has to fire on the last follower leaving — and never on a nudge,
// never before anyone has joined.

import { describe, it, expect } from 'vitest';
import { shouldAutoReleaseLeader, countFollowers } from '../useLeaderAutoRelease';
import type { RemoteParticipantInfo } from '../usePartyPresence';

function release(prevFollowerCount: number, followerCount: number, isLeading = true) {
  return shouldAutoReleaseLeader({ prevFollowerCount, followerCount, isLeading });
}

describe('shouldAutoReleaseLeader', () => {
  it('does not release when nobody ever followed (0 → 0)', () => {
    expect(release(0, 0)).toBe(false);
  });

  it('does not release when one of two followers leaves (2 → 1)', () => {
    expect(release(2, 1)).toBe(false);
  });

  it('releases when the last follower leaves (1 → 0)', () => {
    expect(release(1, 0)).toBe(true);
  });

  it('releases when the last of several leaves (3 → 0)', () => {
    expect(release(3, 0)).toBe(true);
  });

  it('releases on a join-then-leave sequence (0 → 1 → 0)', () => {
    expect(release(0, 1)).toBe(false);
    expect(release(1, 0)).toBe(true);
  });

  it('never releases while I am not leading', () => {
    expect(release(1, 0, false)).toBe(false);
    expect(release(3, 0, false)).toBe(false);
  });
});

function participant(userId: string, followingUserId?: string | null, followNudged?: boolean): RemoteParticipantInfo {
  return { userId, name: userId, color: '#fff', followingUserId, followNudged };
}

describe('countFollowers', () => {
  it('counts only the people locked to me', () => {
    const list = [participant('a', 'me'), participant('b', 'someone-else'), participant('c', 'me')];
    expect(countFollowers(list, 'me')).toBe(2);
  });

  it('counts nobody when an older client sends no follow field at all', () => {
    const list = [{ userId: 'a', name: 'a', color: '#fff' }, participant('b', null)];
    expect(countFollowers(list, 'me')).toBe(0);
  });

  it('still counts a follower who is mid-nudge — looking around is not leaving', () => {
    const list = [participant('a', 'me', true)];
    expect(countFollowers(list, 'me')).toBe(1);
  });
});
