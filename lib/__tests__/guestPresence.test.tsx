// A guest is marked by a flag in presence, not by their name.
//
// Why that matters: `name` is what ends up stored — in tracker items, in the
// audit rows the room server writes, in transcripts. A name that literally read
// "Supplier Sam (guest)" would be written to all of them, and would still be
// there after the deployment turned identity off. So the flag travels on the
// wire and each renderer adds the suffix.
//
// Same harness as joinKnock.test.tsx and followPresenceList.test.tsx: a fake
// partysocket driven by hand.

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

  /** Fire the socket's 'open' handlers, as partysocket does once connected. */
  open() {
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }

  /** Deliver a server message. */
  emit(msg: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(msg) });
  }

  /** The payload of every PRESENCE this socket has sent. */
  presences(): ParticipantPresence[] {
    return this.sent
      .map((s) => JSON.parse(s) as { type: string; payload?: ParticipantPresence })
      .filter((m) => m.type === 'PRESENCE')
      .map((m) => m.payload!);
  }
}

vi.mock('partysocket', () => ({ default: FakeSocket }));

// Imported after the mock is registered — and dynamically, because a static
// import of anything that reaches usePartyPresence would run the factory above
// while FakeSocket is still in its TDZ.
const { usePartyPresence } = await import('../usePartyPresence');
const { default: JoinRequests } = await import('../../components/UI/JoinRequests');

let captured: ReturnType<typeof usePartyPresence> | null = null;

/** The hook the way RoomPage mounts it, plus the host's knock prompt. */
function Harness() {
  captured = usePartyPresence('room-1');
  return (
    <div>
      {captured.remoteParticipantList.map((p) => (
        <span key={p.userId} data-testid={`row-${p.userId}`}>
          {JSON.stringify({ name: p.name, guest: p.guest ?? false })}
        </span>
      ))}
      <JoinRequests />
    </div>
  );
}

function socket(): FakeSocket {
  const s = FakeSocket.last;
  if (!s) throw new Error('no socket was created');
  return s;
}

function presenceOf(userId: string, extra: Partial<ParticipantPresence> = {}): ParticipantPresence {
  return {
    userId,
    name: userId,
    color: '#fff',
    position: [0, 0, 0],
    lookAt: [0, 0, -1],
    ...extra,
  };
}

function row(userId: string) {
  return JSON.parse(screen.getByTestId(`row-${userId}`).textContent ?? 'null');
}

function setVpUser(user: Record<string, unknown>) {
  localStorage.setItem('vp_user', JSON.stringify(user));
}

beforeEach(() => {
  FakeSocket.last = null;
  captured = null;
  sessionStorage.setItem('vp_userId', 'user-maria');
});

afterEach(() => {
  cleanup();
  useStore.setState({ followingRemoteUserId: null, followNudged: false });
});

describe('the guest flag on the wire', () => {
  it('broadcastPresence says when I have no account', () => {
    setVpUser({ name: 'Supplier Sam', color: '#fff', guest: true });
    render(<Harness />);

    act(() => { captured!.broadcastPresence([1, 2, 3], [1, 2, 2]); });

    expect(socket().presences().at(-1)).toMatchObject({
      userId: 'user-maria',
      name: 'Supplier Sam',
      guest: true,
    });
  });

  it('broadcastPresence says so when I signed in', () => {
    setVpUser({ name: 'Maria', color: '#fff', accountId: 'user-1', guest: false });
    render(<Harness />);

    act(() => { captured!.broadcastPresence([0, 0, 0], [0, 0, -1]); });

    expect(socket().presences().at(-1)).toMatchObject({ name: 'Maria', guest: false });
  });

  it('reads a vp_user with no guest field as not a guest', () => {
    setVpUser({ name: 'Maria', color: '#fff' });
    render(<Harness />);

    act(() => { captured!.broadcastPresence([0, 0, 0], [0, 0, -1]); });

    expect(socket().presences().at(-1)).toMatchObject({ guest: false });
  });

  it('knocks with the flag, so the host sees it before admitting anyone', () => {
    setVpUser({ name: 'Supplier Sam', color: '#fff', guest: true });
    render(<Harness />);

    act(() => { socket().open(); });

    expect(socket().presences()[0]).toMatchObject({ name: 'Supplier Sam', guest: true });
  });
});

describe('the guest flag on the participant list', () => {
  it('arrives with a remote guest', () => {
    setVpUser({ name: 'Maria', color: '#fff' });
    render(<Harness />);

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-sam', { name: 'Sam', guest: true }) }); });

    expect(row('user-sam')).toEqual({ name: 'Sam', guest: true });
  });

  it('is absent from an older client, which reads as not a guest', () => {
    setVpUser({ name: 'Maria', color: '#fff' });
    render(<Harness />);

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-old', { name: 'Old' }) }); });

    expect(row('user-old')).toEqual({ name: 'Old', guest: false });
  });

  it('rebuilds the list when a known participant turns out to be a guest', () => {
    setVpUser({ name: 'Maria', color: '#fff' });
    render(<Harness />);
    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-sam', { name: 'Sam' }) }); });

    act(() => { socket().emit({ type: 'PRESENCE', payload: presenceOf('user-sam', { name: 'Sam', guest: true }) }); });

    expect(row('user-sam').guest).toBe(true);
  });
});

describe('the knock prompt', () => {
  function knockers(pending: Array<{ userId: string; name: string; since: number; guest?: boolean }>) {
    act(() => { socket().emit({ type: 'JOIN_REQUESTS', payload: { pending } }); });
  }

  it('marks a guest, and leaves an account holder alone', () => {
    setVpUser({ name: 'Maria', color: '#fff' });
    render(<Harness />);

    knockers([
      { userId: 'user-sam', name: 'Supplier Sam', since: 1, guest: true },
      { userId: 'user-alex', name: 'Alex Chen', since: 2 },
    ]);

    expect(screen.getByText('Supplier Sam (guest)')).toBeInTheDocument();
    expect(screen.getByText('Alex Chen')).toBeInTheDocument();
    expect(screen.queryByText('Alex Chen (guest)')).toBeNull();
  });
});
