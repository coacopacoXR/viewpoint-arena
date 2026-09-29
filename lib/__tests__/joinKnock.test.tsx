// The knock — regression tests for the join gate's one fatal failure mode.
//
// The server admits a connection when it sends PRESENCE. Until the knock gate
// landed, the first PRESENCE came from the 3D scene's frame loop; the scene
// does not mount until the gate says 'admitted', so leaving it there deadlocks
// every room including the host's: no PRESENCE, no admission, no scene, no
// PRESENCE. Nothing in the server tests can catch that — the server is fine,
// it is simply never spoken to. So it is pinned here.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

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

  /** Every PRESENCE this socket has sent. */
  presences() {
    return this.sent
      .map((s) => JSON.parse(s) as { type: string })
      .filter((m) => m.type === 'PRESENCE');
  }
}

vi.mock('partysocket', () => ({ default: FakeSocket }));

// Imported after the mock is registered.
const { usePartyPresence, useJoinState } = await import('../usePartyPresence');

/** Mounts the hook the way RoomPage does and reports the gate state. */
function Harness() {
  usePartyPresence('room-1');
  const joinState = useJoinState();
  return <div data-testid="state">{joinState}</div>;
}

function socket(): FakeSocket {
  const s = FakeSocket.last;
  if (!s) throw new Error('no socket was created');
  return s;
}

beforeEach(() => {
  FakeSocket.last = null;
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Maria', color: '#fff' }));
  sessionStorage.setItem('vp_userId', 'user-maria');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the knock', () => {
  it('sends PRESENCE as soon as the socket opens, before any scene exists', () => {
    render(<Harness />);
    expect(socket().presences()).toHaveLength(0); // nothing before 'open'

    act(() => { socket().open(); });

    const knocks = socket().presences();
    expect(knocks).toHaveLength(1);
    expect(knocks[0]).toMatchObject({
      type: 'PRESENCE',
      payload: { userId: 'user-maria', name: 'Maria' },
    });
  });

  it('keeps knocking while it waits, so a room left empty lets the waiter in', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => { socket().open(); });
    act(() => { socket().emit({ type: 'JOIN_PENDING', payload: {} }); });

    expect(socket().presences()).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(socket().presences()).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(socket().presences()).toHaveLength(3);
  });

  it('stops knocking once admitted — the scene takes over from there', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => { socket().open(); });
    act(() => { socket().emit({ type: 'JOIN_ADMITTED', payload: {} }); });

    const before = socket().presences().length;
    act(() => { vi.advanceTimersByTime(9000); });
    expect(socket().presences()).toHaveLength(before);
  });

  it('stops knocking when declined, instead of re-queueing itself forever', () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => { socket().open(); });
    act(() => { socket().emit({ type: 'JOIN_DECLINED', payload: {} }); });

    const before = socket().presences().length;
    act(() => { vi.advanceTimersByTime(9000); });
    expect(socket().presences()).toHaveLength(before);
  });
});

describe('the gate state the room branches on', () => {
  it('starts at joining, then follows the server', () => {
    const { getByTestId } = render(<Harness />);
    expect(getByTestId('state').textContent).toBe('joining');

    act(() => { socket().emit({ type: 'JOIN_PENDING', payload: {} }); });
    expect(getByTestId('state').textContent).toBe('pending');

    act(() => { socket().emit({ type: 'JOIN_ADMITTED', payload: {} }); });
    expect(getByTestId('state').textContent).toBe('admitted');
  });

  it('reports declined so the waiting room can say so', () => {
    const { getByTestId } = render(<Harness />);
    act(() => { socket().emit({ type: 'JOIN_DECLINED', payload: {} }); });
    expect(getByTestId('state').textContent).toBe('declined');
  });
});
