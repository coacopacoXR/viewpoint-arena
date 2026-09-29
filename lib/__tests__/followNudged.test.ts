// A nudge belongs to the follow it happened during. If it survived a change of
// leader it would freeze the *next* follow — the camera would never pick the
// new leader up, with nothing on screen to say why.

import { describe, it, expect, afterEach } from 'vitest';
import { useStore } from '../../store';
import { ViewMode } from '../../types';

afterEach(() => {
  useStore.setState({
    leaderId: null,
    followingRemoteUserId: null,
    followNudged: false,
    viewMode: ViewMode.FREE,
    activeAgentId: null,
  });
});

describe('followNudged', () => {
  it('is off in a fresh store', () => {
    expect(useStore.getState().followNudged).toBe(false);
  });

  it('setFollowNudged records the look-around', () => {
    useStore.getState().setFollowingRemoteUser('leader-1');
    useStore.getState().setFollowNudged(true);

    expect(useStore.getState().followNudged).toBe(true);
  });

  it('starting to follow someone new clears it', () => {
    useStore.getState().setFollowingRemoteUser('leader-1');
    useStore.getState().setFollowNudged(true);

    useStore.getState().setFollowingRemoteUser('leader-2');

    expect(useStore.getState().followNudged).toBe(false);
    expect(useStore.getState().followingRemoteUserId).toBe('leader-2');
  });

  it('leaving the follow clears it', () => {
    useStore.getState().setFollowingRemoteUser('leader-1');
    useStore.getState().setFollowNudged(true);

    useStore.getState().setFollowingRemoteUser(null);

    expect(useStore.getState().followNudged).toBe(false);
    expect(useStore.getState().followingRemoteUserId).toBeNull();
  });

  it('setLeader clears it, whichever way the leader changes', () => {
    useStore.getState().setFollowingRemoteUser('leader-1');
    useStore.getState().setFollowNudged(true);

    useStore.getState().setLeader('USER');
    expect(useStore.getState().followNudged).toBe(false);

    useStore.getState().setFollowNudged(true);
    useStore.getState().setLeader(null);
    expect(useStore.getState().followNudged).toBe(false);
    expect(useStore.getState().followingRemoteUserId).toBeNull();
  });
});
