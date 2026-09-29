// The leader has to be able to see who is locked to their camera, and a
// follower has to be able to see that dragging is only temporary.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

interface Participant {
  userId: string;
  name: string;
  color: string;
  followingUserId?: string | null;
  followNudged?: boolean;
}

let storeState: Record<string, unknown>;
let remoteParticipants: Participant[] = [];

vi.mock('../../../store', () => ({
  useStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(storeState);
    return storeState;
  },
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    remoteParticipantList: remoteParticipants,
    localUserId: 'local-1',
  }),
}));

import FollowersBadge, { FollowingBadge } from '../FollowersBadge';

function baseStore(overrides: Record<string, unknown> = {}) {
  return {
    leaderId: 'USER',
    followingRemoteUserId: null,
    followNudged: false,
    ...overrides,
  };
}

function follower(userId: string, name: string, color: string, followNudged = false): Participant {
  return { userId, name, color, followingUserId: 'local-1', followNudged };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  remoteParticipants = [];
});

describe('FollowersBadge', () => {
  it('renders nothing when nobody is following me', () => {
    storeState = baseStore();
    remoteParticipants = [{ userId: 'p1', name: 'Maria', color: '#0f0', followingUserId: null }];
    const { container } = render(<FollowersBadge />);

    expect(container.firstChild).toBeNull();
  });

  it('ignores people following somebody else', () => {
    storeState = baseStore();
    remoteParticipants = [{ userId: 'p1', name: 'Maria', color: '#0f0', followingUserId: 'someone-else' }];
    const { container } = render(<FollowersBadge />);

    expect(container.firstChild).toBeNull();
  });

  it('names the leader and both followers', () => {
    storeState = baseStore({ leaderId: 'USER' });
    remoteParticipants = [
      follower('p1', 'Maria', '#0f0'),
      follower('p2', 'Jonas', '#00f'),
      { userId: 'p3', name: 'Ida', color: '#f00', followingUserId: null },
    ];
    render(<FollowersBadge />);

    expect(screen.getByText('Leading · 2 following')).toBeTruthy();
    expect(screen.getByTitle('Maria')).toBeTruthy();
    expect(screen.getByTitle('Jonas')).toBeTruthy();
    expect(screen.queryByTitle('Ida')).toBeNull();
    // Initials, coloured with each participant's own colour
    expect(screen.getByTitle('Maria').textContent).toBe('M');
    expect(screen.getByTitle('Maria').style.backgroundColor).toBe('rgb(0, 255, 0)');
  });

  it('says "following you" when I am not the one leading', () => {
    // Mobile clients auto-follow the host, so this is not only the leader's badge.
    storeState = baseStore({ leaderId: null });
    remoteParticipants = [follower('p1', 'Maria', '#0f0'), follower('p2', 'Jonas', '#00f')];
    render(<FollowersBadge />);

    expect(screen.getByText('2 following you')).toBeTruthy();
  });

  it('marks a follower who is looking around, without dropping them', () => {
    storeState = baseStore();
    remoteParticipants = [follower('p1', 'Maria', '#0f0', true), follower('p2', 'Jonas', '#00f')];
    render(<FollowersBadge />);

    expect(screen.getByText('Leading · 2 following')).toBeTruthy();
    expect(screen.getByTitle('Maria — looking around').className).toContain('opacity-30');
    expect(screen.getByTitle('Jonas').className).not.toContain('opacity-30');
  });
});

describe('FollowingBadge', () => {
  const onFreeView = vi.fn();

  it('renders nothing when I am not following', () => {
    storeState = baseStore({ leaderId: null });
    const { container } = render(<FollowingBadge onFreeView={onFreeView} />);

    expect(container.firstChild).toBeNull();
  });

  it('says who I am following and offers the way out', () => {
    storeState = baseStore({ leaderId: 'USER', followingRemoteUserId: 'p1' });
    remoteParticipants = [follower('p1', 'Maria', '#0f0')];
    render(<FollowingBadge onFreeView={onFreeView} />);

    expect(screen.getByText(/Following/).textContent).toContain('Maria');
    expect(screen.queryByText(/snapping back/)).toBeNull();

    fireEvent.click(screen.getByText('Free view'));
    expect(onFreeView).toHaveBeenCalledTimes(1);
  });

  it('says a nudge is temporary and still offers the way out', () => {
    storeState = baseStore({ leaderId: 'USER', followingRemoteUserId: 'p1', followNudged: true });
    remoteParticipants = [follower('p1', 'Maria', '#0f0')];
    render(<FollowingBadge onFreeView={onFreeView} />);

    expect(screen.getByText(/moving on your own · snapping back/)).toBeTruthy();
    fireEvent.click(screen.getByText('Free view'));
    expect(onFreeView).toHaveBeenCalledTimes(1);
  });
});
