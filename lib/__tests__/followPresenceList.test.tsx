// The leader can only show "who is following me" if a *change* of follow state
// reaches remoteParticipantList. The list used to be rebuilt only when a
// participant was new, so the flag that matters most never arrived.
//
// Same harness as joinKnock.test.tsx: a fake partysocket driven by hand.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { useStore } from '../../store';
import type { ParticipantPresence } from '../../party/room.server';

interface Listener { (event: unknown): void }

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  listeners = new Map<string, Set<Listener>>();

  constructor(_opts: unknown) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emit(msg: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(msg) });
  }

  presences() {
    return this.sent
      .map((s) => JSON.parse(s) as { type: string; payload?: ParticipantPresence })
      .filter((m) => m.type === 'PRESENCE')
      .map((m) => m.payload!);
  }
}

vi.mock('partysocket', () => ({ default: FakeSocket }));

// Imported after the mock is registered.
const { usePartyPresence } = await import('../usePartyPresence');

let captured: ReturnType<typeof usePartyPresence> | null = null;

function Harness() {
  captured = usePartyPresence('room-1');
  return (
    <div>
      {captured.remoteParticipantList.map((p) => (
        <span key={p.userId} data-testid={`row-${p.userId}`}>
          {JSON.stringify({
            name: p.name,
            followingUserId: p.followingUserId ?? null,
            followNudged: p.followNudged ?? false,
          })}
        </span>
      ))}
    </div>
  );
}

function socket(): FakeSocket {
  const s = FakeSocket.last;
  if (!s) throw new Error('no socket was created');
  return s;
}

function presenceOf(userId: string, follow: Partial<ParticipantPresence> = {}): ParticipantPresence {
  return {
    userId,
    name: userId,
    color: '#fff',
    position: [0, 0, 0],
    lookAt: [0, 0, -1],
    ...follow,
  };
}

function row(userId: string) {
  return JSON.parse(screen.getByTestId(`row-${userId}`).textContent ?? 'null');
}

beforeEach(() => {
  FakeSocket.last = null;
  captured = null;
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Maria', color: '#fff' }));
  sessionStorage.setItem('vp_userId', 'user-maria');
});

afterEach(() => {
  cleanup();
  useStore.setState({ leaderId: null, followingRemoteUserId: null, followNudged: false });
});

describe('the follow fields on the participant list', () => {
  it('adds a new participant with their follow state', () => {
    render(<Harness />);

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: 'user-maria' }) }); });

    expect(row('user-bob')).toEqual({ name: 'user-bob', followingUserId: 'user-maria', followNudged: false });
  });

  it('updates an already-known participant whose followingUserId changed', () => {
    render(<Harness />);
    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: null }) }); });
    expect(row('user-bob').followingUserId).toBeNull();

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: 'user-maria' }) }); });

    expect(row('user-bob').followingUserId).toBe('user-maria');
  });

  it('updates an already-known participant who starts or stops looking around', () => {
    render(<Harness />);
    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: 'user-maria' }) }); });

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: 'user-maria', followNudged: true }) }); });
    expect(row('user-bob').followNudged).toBe(true);

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: 'user-maria', followNudged: false }) }); });
    expect(row('user-bob').followNudged).toBe(false);
  });

  it('reads a missing field from an older client as "following nobody"', () => {
    render(<Harness />);

    act(() => { socket().emit({ type: 'PRESENCE', payload: { userId: 'user-old', name: 'Old', color: '#fff', position: [0, 0, 0], lookAt: [0, 0, -1] } }); });

    expect(row('user-old')).toEqual({ name: 'Old', followingUserId: null, followNudged: false });
  });

  it('keeps the same list when a presence changes nothing but the camera', () => {
    render(<Harness />);
    const payload = presenceOf('user-bob', { followingUserId: 'user-maria' });
    act(() => { socket().emit({ type: 'PRESENCE', payload }); });
    const before = captured!.remoteParticipantList;

    // The scene broadcasts at 10fps; only follow changes may rebuild the list.
    act(() => { socket().emit({ type: 'PRESENCE', payload: { ...payload, position: [1, 2, 3] } }); });

    expect(captured!.remoteParticipantList).toBe(before);
  });

  it('drops a follower who leaves the room', () => {
    render(<Harness />);
    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-bob', { followingUserId: 'user-maria' }) }); });

    act(() => { socket().emit({ type: 'LEAVE', payload: { userId: 'user-bob' } }); });

    expect(screen.queryByTestId('row-user-bob')).toBeNull();
  });
});

describe('the follow fields on the wire', () => {
  it('broadcastPresence reports who I follow and whether I am looking around', () => {
    render(<Harness />);
    act(() => { useStore.getState().setFollowingRemoteUser('user-leader'); });
    act(() => { useStore.getState().setFollowNudged(true); });

    act(() => { captured!.broadcastPresence([1, 2, 3], [1, 2, 2]); });

    expect(socket().presences().at(-1)).toMatchObject({
      userId: 'user-maria',
      followingUserId: 'user-leader',
      followNudged: true,
    });
  });

  it('reports nobody when I am not following', () => {
    render(<Harness />);

    act(() => { captured!.broadcastPresence([0, 0, 0], [0, 0, -1]); });

    expect(socket().presences().at(-1)).toMatchObject({
      followingUserId: null,
      followNudged: false,
    });
  });
});
