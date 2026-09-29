// Tests for room.server.ts — knock-to-join gate, RECORDING_STATE relay,
// TRANSCRIPT_LINE speakerId stamping, POINTING_SEGMENT relay, and the identity
// layer that decides whether a presence name is proven or self-asserted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type * as Party from 'partykit/server';
import RoomServer from '../room.server';

// ─── Fakes ──────────────────────────────────────────────────────────────────

/** In-memory stand-in for the room's persisted key-value storage. */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    _data: data,
  };
}

function fakeRoom(storage = fakeStorage(), env: Record<string, string> = {}): Party.Room {
  return {
    id: 'test-room',
    broadcast: vi.fn(),
    storage,
    env,
  } as unknown as Party.Room;
}

interface FakeConnection {
  id: string;
  send: ReturnType<typeof vi.fn>;
}

function fakeConn(id: string): FakeConnection {
  return { id, send: vi.fn() };
}

/** The parts of the fake room a test reads back. */
interface FakeRoomShape {
  broadcast: ReturnType<typeof vi.fn>;
  storage: ReturnType<typeof fakeStorage>;
  env: Record<string, string>;
}

function createServer(
  storage = fakeStorage(),
  env: Record<string, string> = {},
): RoomServer & { room: FakeRoomShape } {
  const room = fakeRoom(storage, env);
  return new RoomServer(room) as RoomServer & { room: FakeRoomShape };
}

/**
 * Register a connection (onConnect) and then send PRESENCE to admit it.
 *
 * `extra` is spread into the presence payload — how the identity tests below
 * send an accessToken without a second helper. The handler's promise is
 * returned so a test that sent something the server has to verify can await
 * it; a payload with no token is handled synchronously, which is why every
 * caller that predates identity can carry on ignoring the return value.
 */
function admitUser(
  server: RoomServer & { room: { broadcast: ReturnType<typeof vi.fn> } },
  conn: FakeConnection,
  userId: string,
  name = 'User',
  extra: Record<string, unknown> = {},
) {
  server.onConnect(conn as unknown as Party.Connection);
  conn.send.mockClear();
  return server.onMessage(
    JSON.stringify({
      type: 'PRESENCE',
      payload: {
        userId,
        name,
        color: '#000',
        position: [0, 0, 0],
        lookAt: [0, 0, 0],
        ...extra,
      },
    }),
    conn as unknown as Party.Connection,
  );
}

/** Send PRESENCE without prior onConnect (for testing the gate). */
function sendPresence(
  server: RoomServer,
  conn: FakeConnection,
  userId: string,
  name = 'User',
  extra: Record<string, unknown> = {},
) {
  return server.onMessage(
    JSON.stringify({
      type: 'PRESENCE',
      payload: {
        userId,
        name,
        color: '#000',
        position: [0, 0, 0],
        lookAt: [0, 0, 0],
        ...extra,
      },
    }),
    conn as unknown as Party.Connection,
  );
}

/**
 * Get a second person all the way in: they knock, the host admits them, and
 * their next PRESENCE lands. Needed because under the default 'ask' policy a
 * bare PRESENCE only parks them — a fixture that skipped the ADMIT was
 * asserting relay behaviour for someone still stuck at the door.
 */
function admitViaHost(
  server: ReturnType<typeof createServer>,
  hostConn: FakeConnection,
  conn: FakeConnection,
  userId: string,
  name = 'User',
) {
  admitUser(server, conn, userId, name); // knock (parks under 'ask')
  server.onMessage(
    JSON.stringify({ type: 'ADMIT', payload: { userId } }),
    hostConn as unknown as Party.Connection,
  );
  sendPresence(server, conn, userId, name);
}

function sentTypes(conn: FakeConnection): string[] {
  return conn.send.mock.calls.map((c) => JSON.parse(c[0] as string).type);
}

// ─── Knock-to-join gate ─────────────────────────────────────────────────────

describe('room.server — knock-to-join gate', () => {
  let server: ReturnType<typeof createServer>;

  beforeEach(() => {
    server = createServer();
  });

  it('admits the first PRESENCE immediately and makes them host', () => {
    const conn = fakeConn('c1');
    admitUser(server, conn, 'alice', 'Alice');

    expect(server.admitted.has('alice')).toBe(true);
    expect(server.participants.has('alice')).toBe(true);
    expect(server.joinOrder[0]).toBe('alice');
    // The first arrival gets JOIN_ADMITTED + room state bundle
    const types = sentTypes(conn);
    expect(types).toContain('JOIN_ADMITTED');
    expect(types).toContain('ROSTER');
    expect(types).toContain('HOST_CHANGE');
  });

  it('parks a second userId under ask policy and sends JOIN_PENDING', () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    hostConn.send.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    // Guest is NOT admitted
    expect(server.admitted.has('guest-1')).toBe(false);
    expect(server.participants.has('guest-1')).toBe(false);
    expect(server.pending.has('guest-1')).toBe(true);

    // Guest gets JOIN_PENDING
    expect(sentTypes(guestConn)).toContain('JOIN_PENDING');

    // Host gets JOIN_REQUESTS
    expect(sentTypes(hostConn)).toContain('JOIN_REQUESTS');
  });

  it('pending user does NOT appear in the roster', () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    // The guest should not be in participants at all
    expect(server.participants.has('guest-1')).toBe(false);
  });

  it("host's ADMIT puts the guest in and sends room state", () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    hostConn.send.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    // Host admits the guest
    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(server.admitted.has('guest-1')).toBe(true);
    // Guest received JOIN_ADMITTED + room state
    const guestTypes = sentTypes(guestConn);
    expect(guestTypes).toContain('JOIN_ADMITTED');
    expect(guestTypes).toContain('ROSTER');
  });

  it("DECLINE sends JOIN_DECLINED and drops the pending entry", () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    hostConn.send.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    server.onMessage(
      JSON.stringify({ type: 'DECLINE', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(server.pending.has('guest-1')).toBe(false);
    expect(sentTypes(guestConn)).toContain('JOIN_DECLINED');
  });

  it('ADMIT from a non-host is silently ignored', () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    const otherConn = fakeConn('c-other');
    admitUser(server, otherConn, 'other-1', 'Carol');
    otherConn.send.mockClear();

    // Non-host tries to admit
    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      otherConn as unknown as Party.Connection,
    );

    expect(server.pending.has('guest-1')).toBe(true);
    expect(server.admitted.has('guest-1')).toBe(false);
  });

  it('DECLINE from a non-host is silently ignored', () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    const otherConn = fakeConn('c-other');
    admitUser(server, otherConn, 'other-1', 'Carol');

    server.onMessage(
      JSON.stringify({ type: 'DECLINE', payload: { userId: 'guest-1' } }),
      otherConn as unknown as Party.Connection,
    );

    expect(server.pending.has('guest-1')).toBe(true);
  });

  it("open policy admits immediately", () => {
    server.joinPolicy = 'open';

    const conn1 = fakeConn('c1');
    admitUser(server, conn1, 'alice', 'Alice');

    const conn2 = fakeConn('c2');
    server.onConnect(conn2 as unknown as Party.Connection);
    conn2.send.mockClear();
    sendPresence(server, conn2, 'bob', 'Bob');

    expect(server.admitted.has('bob')).toBe(true);
    expect(server.participants.has('bob')).toBe(true);
    expect(sentTypes(conn2)).toContain('JOIN_ADMITTED');
  });

  it("switching to open drains the pending queue", () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    hostConn.send.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    expect(server.pending.has('guest-1')).toBe(true);

    // Host switches to open
    server.onMessage(
      JSON.stringify({ type: 'SET_JOIN_POLICY', payload: { policy: 'open' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(server.pending.has('guest-1')).toBe(false);
    expect(server.admitted.has('guest-1')).toBe(true);
    expect(sentTypes(guestConn)).toContain('JOIN_ADMITTED');
  });

  it('repeated PRESENCE from a pending userId does not resend JOIN_REQUESTS', () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    hostConn.send.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    // Count JOIN_REQUESTS sent to host so far
    const jrBefore = hostConn.send.mock.calls.filter(
      (c) => JSON.parse(c[0] as string).type === 'JOIN_REQUESTS',
    ).length;

    // Same userId sends PRESENCE again with same name
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    const jrAfter = hostConn.send.mock.calls.filter(
      (c) => JSON.parse(c[0] as string).type === 'JOIN_REQUESTS',
    ).length;

    expect(jrAfter).toBe(jrBefore);
  });

  it('a knock when admitted is empty is admitted even though policy is ask', () => {
    // Fresh server, policy is 'ask' by default
    expect(server.joinPolicy).toBe('ask');

    const conn = fakeConn('c1');
    server.onConnect(conn as unknown as Party.Connection);
    conn.send.mockClear();
    sendPresence(server, conn, 'first-user', 'First');

    expect(server.admitted.has('first-user')).toBe(true);
    expect(sentTypes(conn)).toContain('JOIN_ADMITTED');
  });

  it('lets a waiter in once the host closes the tab, instead of stranding them', () => {
    // The rule is keyed on who is actually in the room, not on who was ever
    // admitted — otherwise a host who leaves while someone waits locks the
    // room for good, and the waiter's re-knocks are answered by nobody.
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    expect(server.pending.has('guest-1')).toBe(true);

    server.onClose(hostConn as unknown as Party.Connection);
    guestConn.send.mockClear();

    // The client re-knocks on its timer.
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    expect(server.admitted.has('guest-1')).toBe(true);
    expect(server.pending.has('guest-1')).toBe(false);
    expect(sentTypes(guestConn)).toContain('JOIN_ADMITTED');
    expect(server.joinOrder[0]).toBe('guest-1'); // joinOrder[0] IS the host
  });

  it('does not make an admitted user knock again after a reconnect', () => {
    // A reload keeps the same userId (sessionStorage) and partysocket
    // reconnects on its own after a blip; sending either to the back of the
    // host's queue would be absurd for the host refreshing their own room.
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const guestConn = fakeConn('c-guest');
    admitUser(server, guestConn, 'guest-1', 'Bob'); // parked, then admitted below
    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );
    expect(server.admitted.has('guest-1')).toBe(true);

    server.onClose(guestConn as unknown as Party.Connection);

    // Same userId, new connection — the host is still in the room, so rule 2
    // does not apply; only the kept admission can let them straight back in.
    const againConn = fakeConn('c-guest-2');
    server.onConnect(againConn as unknown as Party.Connection);
    againConn.send.mockClear();
    sendPresence(server, againConn, 'guest-1', 'Bob');

    expect(server.pending.has('guest-1')).toBe(false);
    expect(sentTypes(againConn)).not.toContain('JOIN_PENDING');
    expect(server.participants.has('guest-1')).toBe(true);
    // And it must be TOLD it is in: the client's join state starts at
    // 'joining' on a new socket, so silence leaves it on "Connecting…"
    // for ever — which is exactly what happened to a host who reloaded.
    expect(sentTypes(againConn)).toContain('JOIN_ADMITTED');
    expect(sentTypes(againConn)).toContain('ROSTER');
  });

  it('leaves a waiting connection out of every relay', () => {
    // A hidden waiting-room UI would be worthless if the meeting still
    // streamed to the socket behind it. Whatever the room relays — presence,
    // transcript lines, comments — must skip a connection that is not in.
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const waiterConn = fakeConn('c-waiter');
    server.onConnect(waiterConn as unknown as Party.Connection);
    sendPresence(server, waiterConn, 'waiter-1', 'Bob');
    server.room.broadcast.mockClear();

    server.onMessage(
      JSON.stringify({
        type: 'TRANSCRIPT_LINE',
        payload: { id: 't1', agentId: 'a', text: 'the bracket is too thin', timestamp: 1 },
      }),
      hostConn as unknown as Party.Connection,
    );

    const excluded = server.room.broadcast.mock.calls[0][1] as string[];
    expect(excluded).toContain('c-waiter');

    // And once admitted, they are included again.
    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'waiter-1' } }),
      hostConn as unknown as Party.Connection,
    );
    server.room.broadcast.mockClear();
    server.onMessage(
      JSON.stringify({
        type: 'TRANSCRIPT_LINE',
        payload: { id: 't2', agentId: 'a', text: 'agreed', timestamp: 2 },
      }),
      hostConn as unknown as Party.Connection,
    );
    expect(server.room.broadcast.mock.calls[0][1] as string[]).not.toContain('c-waiter');
  });

  it('hands the room state to a connection once, not on every PRESENCE', () => {
    const conn = fakeConn('c1');
    admitUser(server, conn, 'alice', 'Alice');
    expect(sentTypes(conn).filter((t) => t === 'ROSTER')).toHaveLength(1);

    conn.send.mockClear();
    sendPresence(server, conn, 'alice', 'Alice'); // the scene's next frame
    expect(sentTypes(conn)).not.toContain('ROSTER');
    expect(sentTypes(conn)).not.toContain('JOIN_ADMITTED');
  });

  it('a pending entry older than five minutes is dropped', () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    expect(server.pending.has('guest-1')).toBe(true);

    // Artificially age the pending entry
    const entry = server.pending.get('guest-1')!;
    entry.since = Date.now() - 6 * 60 * 1000;

    // Next knock triggers expiry check
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    // The old entry was expired and a fresh one was created
    expect(server.pending.has('guest-1')).toBe(true);
    expect(server.pending.get('guest-1')!.since).toBeGreaterThan(entry.since);
  });

  it("non-admitted connection's COMMENT_ADD is dropped", () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.room.broadcast.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    // guest is pending, not admitted
    server.room.broadcast.mockClear();

    server.onMessage(
      JSON.stringify({ type: 'COMMENT_ADD', payload: { comment: { id: 'c1', text: 'hi' } } }),
      guestConn as unknown as Party.Connection,
    );

    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(server.comments).toHaveLength(0);
  });

  it("non-admitted connection's MODEL_CHANGE is dropped", () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.room.broadcast.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    server.room.broadcast.mockClear();

    server.onMessage(
      JSON.stringify({ type: 'MODEL_CHANGE', payload: { modelType: 'synth' } }),
      guestConn as unknown as Party.Connection,
    );

    expect(server.room.broadcast).not.toHaveBeenCalled();
  });

  it("non-admitted connection's TRANSCRIPT_LINE is dropped", () => {
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.room.broadcast.mockClear();

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    server.room.broadcast.mockClear();

    server.onMessage(
      JSON.stringify({
        type: 'TRANSCRIPT_LINE',
        payload: { id: 'l1', agentId: 'a', text: 'hi', timestamp: 0 },
      }),
      guestConn as unknown as Party.Connection,
    );

    expect(server.room.broadcast).not.toHaveBeenCalled();
  });
});

// ─── RECORDING_STATE ────────────────────────────────────────────────────────

describe('room.server — RECORDING_STATE', () => {
  let server: ReturnType<typeof createServer>;
  let hostConn: FakeConnection;
  let guestConn: FakeConnection;

  beforeEach(() => {
    server = createServer();
    hostConn = fakeConn('conn-host');
    guestConn = fakeConn('conn-guest');
    admitUser(server, hostConn, 'host-1', 'Alice');
    admitViaHost(server, hostConn, guestConn, 'guest-1', 'Bob');
    server.room.broadcast.mockClear();
  });

  it('persists and broadcasts RECORDING_STATE to ALL clients (including sender)', () => {
    server.onMessage(
      JSON.stringify({
        type: 'RECORDING_STATE',
        payload: { recording: true, startedAt: 1000, byUserId: 'host-1', byName: 'Alice' },
      }),
      hostConn as unknown as Party.Connection,
    );

    const broadcast = server.room.broadcast;
    expect(broadcast).toHaveBeenCalledTimes(1);
    const call = broadcast.mock.calls[0];
    const msg = JSON.parse(call[0] as string);
    expect(msg.type).toBe('RECORDING_STATE');
    expect(msg.payload.recording).toBe(true);
    expect(msg.payload.byUserId).toBe('host-1');
    // The sender is included (they need their own state back); the list now
    // carries whoever has not been admitted, which here is nobody.
    expect(call[1] ?? []).not.toContain('conn-host');
    expect(call[1] ?? []).not.toContain('conn-guest');
  });

  it('sends persisted RECORDING_STATE to late joiners via sendRoomState', () => {
    server.onMessage(
      JSON.stringify({
        type: 'RECORDING_STATE',
        payload: { recording: true, startedAt: 1000, byUserId: 'host-1', byName: 'Alice' },
      }),
      hostConn as unknown as Party.Connection,
    );

    const lateConn = fakeConn('conn-late');
    server.onConnect(lateConn as unknown as Party.Connection);
    lateConn.send.mockClear();
    // Late joiner sends PRESENCE and gets admitted (admitted.size > 0, but
    // we set joinPolicy to open for this test to bypass the gate)
    server.joinPolicy = 'open';
    sendPresence(server, lateConn, 'late-1', 'Late');

    const sentMessages = lateConn.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const recordingMsg = sentMessages.find((m) => m.type === 'RECORDING_STATE');
    expect(recordingMsg).toBeDefined();
    expect(recordingMsg.payload.byUserId).toBe('host-1');
  });

  it('clears recording state when recording stops', () => {
    server.onMessage(
      JSON.stringify({
        type: 'RECORDING_STATE',
        payload: { recording: true, startedAt: 1000, byUserId: 'host-1', byName: 'Alice' },
      }),
      hostConn as unknown as Party.Connection,
    );
    server.onMessage(
      JSON.stringify({
        type: 'RECORDING_STATE',
        payload: { recording: false, startedAt: 0, byUserId: 'host-1', byName: 'Alice' },
      }),
      hostConn as unknown as Party.Connection,
    );

    const lateConn = fakeConn('conn-late');
    server.onConnect(lateConn as unknown as Party.Connection);
    lateConn.send.mockClear();
    server.joinPolicy = 'open';
    sendPresence(server, lateConn, 'late-1', 'Late');

    const sentMessages = lateConn.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    const recordingMsg = sentMessages.find((m) => m.type === 'RECORDING_STATE');
    expect(recordingMsg).toBeDefined();
    expect(recordingMsg.payload.recording).toBe(false);
  });
});

// ─── TRANSCRIPT_LINE ────────────────────────────────────────────────────────

describe('room.server — TRANSCRIPT_LINE speakerId stamping', () => {
  let server: ReturnType<typeof createServer>;
  let conn: FakeConnection;

  beforeEach(() => {
    server = createServer();
    conn = fakeConn('conn-1');
    admitUser(server, conn, 'user-42', 'Alice');
    server.room.broadcast.mockClear();
  });

  it('overwrites speakerId with the connection userId', () => {
    server.onMessage(
      JSON.stringify({
        type: 'TRANSCRIPT_LINE',
        payload: {
          id: 'line-1',
          agentId: 'live-transcript',
          text: 'hello',
          timestamp: Date.now(),
          speakerName: 'Alice',
          speakerId: 'FORGED-ID',
          offsetMs: 0,
        },
      }),
      conn as unknown as Party.Connection,
    );

    const broadcast = server.room.broadcast;
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(broadcast.mock.calls[0][0] as string);
    expect(msg.payload.speakerId).toBe('user-42');
  });

  it('relays to everyone except the sender', () => {
    server.onMessage(
      JSON.stringify({
        type: 'TRANSCRIPT_LINE',
        payload: {
          id: 'line-1',
          agentId: 'live-transcript',
          text: 'hello',
          timestamp: Date.now(),
          speakerName: 'Alice',
          offsetMs: 0,
        },
      }),
      conn as unknown as Party.Connection,
    );

    const broadcast = server.room.broadcast;
    expect(broadcast.mock.calls[0][1]).toEqual([conn.id]);
  });
});

// ─── POINTING_SEGMENT ───────────────────────────────────────────────────────

describe('room.server — POINTING_SEGMENT relay + userId stamping', () => {
  let server: ReturnType<typeof createServer>;
  let conn: FakeConnection;

  beforeEach(() => {
    server = createServer();
    conn = fakeConn('conn-1');
    admitUser(server, conn, 'user-42', 'Alice');
    server.room.broadcast.mockClear();
  });

  it('overwrites userId with the connection userId', () => {
    server.onMessage(
      JSON.stringify({
        type: 'POINTING_SEGMENT',
        payload: {
          userId: 'FORGED-ID',
          userName: 'Alice',
          partId: 'part-1',
          partName: 'Left Ear Cup',
          source: 'laser',
          fromMs: 0,
          toMs: 1000,
        },
      }),
      conn as unknown as Party.Connection,
    );

    const broadcast = server.room.broadcast;
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(broadcast.mock.calls[0][0] as string);
    expect(msg.type).toBe('POINTING_SEGMENT');
    expect(msg.payload.userId).toBe('user-42');
  });

  it('relays to everyone except the sender', () => {
    server.onMessage(
      JSON.stringify({
        type: 'POINTING_SEGMENT',
        payload: {
          userId: 'user-42',
          userName: 'Alice',
          partId: 'part-1',
          partName: 'Left Ear Cup',
          source: 'laser',
          fromMs: 0,
          toMs: 1000,
        },
      }),
      conn as unknown as Party.Connection,
    );

    const broadcast = server.room.broadcast;
    expect(broadcast.mock.calls[0][1]).toEqual([conn.id]);
  });
});

// ─── Audit log ──────────────────────────────────────────────────────────────

describe('room.server — audit log', () => {
  let server: ReturnType<typeof createServer>;
  let hostConn: FakeConnection;
  let guestConn: FakeConnection;
  let fetchMock: ReturnType<typeof vi.fn>;
  const origAnonKey = process.env.ANON_KEY;
  const origRestUrl = process.env.REST_URL;

  beforeEach(() => {
    server = createServer();
    hostConn = fakeConn('conn-host');
    guestConn = fakeConn('conn-guest');
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANON_KEY = origAnonKey;
    process.env.REST_URL = origRestUrl;
  });

  it('ADMIT posts one audit row with correct action, actor and subject', () => {
    process.env.ANON_KEY = 'test-anon-key';
    process.env.REST_URL = 'http://rest:3000';
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    fetchMock.mockClear();

    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    // The ROOT path: PostgREST serves its tables there, and `/rest/v1/` is
    // only the prefix nginx-proxy rewrites away for the browser. Posting to
    // the prefixed path from inside the compose network is a 404, which a
    // fire-and-forget write swallows for ever.
    expect(url).toBe('http://rest:3000/audit_events');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Authorization']).toBe('Bearer test-anon-key');
    expect(opts.headers['apikey']).toBe('test-anon-key');
    expect(opts.headers['Prefer']).toBe('return=minimal');
    const body = JSON.parse(opts.body);
    expect(body.action).toBe('admitted');
    expect(body.room_id).toBe('test-room');
    expect(body.actor_name).toBe('Alice');
    expect(body.actor_id).toBe('host-1');
    expect(body.subject_name).toBe('Bob');
    expect(body.subject_id).toBe('guest-1');
  });

  it('DECLINE posts one audit row with correct action, actor and subject', () => {
    process.env.ANON_KEY = 'test-anon-key';
    process.env.REST_URL = 'http://rest:3000';
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    fetchMock.mockClear();

    server.onMessage(
      JSON.stringify({ type: 'DECLINE', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.action).toBe('declined');
    expect(body.actor_name).toBe('Alice');
    expect(body.actor_id).toBe('host-1');
    expect(body.subject_name).toBe('Bob');
    expect(body.subject_id).toBe('guest-1');
  });

  it('SET_JOIN_POLICY records the new policy in detail', () => {
    process.env.ANON_KEY = 'test-anon-key';
    process.env.REST_URL = 'http://rest:3000';
    admitUser(server, hostConn, 'host-1', 'Alice');
    fetchMock.mockClear();

    server.onMessage(
      JSON.stringify({ type: 'SET_JOIN_POLICY', payload: { policy: 'open' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.action).toBe('join_policy');
    expect(body.actor_name).toBe('Alice');
    expect(body.actor_id).toBe('host-1');
    expect(body.detail).toBe('open');
  });

  it('with ANON_KEY unset: no fetch at all, and the admission still happens', () => {
    delete process.env.ANON_KEY;
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    fetchMock.mockClear();

    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(server.admitted.has('guest-1')).toBe(true);
  });

  it('a throwing fetch does not stop the admission', () => {
    process.env.ANON_KEY = 'test-anon-key';
    fetchMock.mockImplementation(() => { throw new Error('network down'); });
    admitUser(server, hostConn, 'host-1', 'Alice');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(server.admitted.has('guest-1')).toBe(true);
    const guestTypes = sentTypes(guestConn);
    expect(guestTypes).toContain('JOIN_ADMITTED');
  });
});

// ─── Admissions across a restart ────────────────────────────────────────────

describe('room.server — admissions survive a restart', () => {
  it('restores the admitted set before judging any knock', async () => {
    // The container is restarted for upgrades while meetings are running.
    // Without this, the first person to reconnect becomes host and everyone
    // else is bounced into the queue — the host re-admitting people who never
    // left (seen live before this was added).
    const storage = fakeStorage({ 'admitted-user-ids': ['host-1', 'guest-1'] });
    const server = createServer(storage);
    await server.onStart();

    // A second person reconnecting, with someone already in the room, would
    // otherwise be parked.
    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    guestConn.send.mockClear();
    sendPresence(server, guestConn, 'guest-1', 'Bob');

    expect(server.pending.has('guest-1')).toBe(false);
    expect(sentTypes(guestConn)).not.toContain('JOIN_PENDING');
    expect(sentTypes(guestConn)).toContain('JOIN_ADMITTED');
  });

  it('writes each admission back', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();

    const hostConn = fakeConn('c-host');
    admitUser(server, hostConn, 'host-1', 'Alice');
    const guestConn = fakeConn('c-guest');
    admitUser(server, guestConn, 'guest-1', 'Bob');
    server.onMessage(
      JSON.stringify({ type: 'ADMIT', payload: { userId: 'guest-1' } }),
      hostConn as unknown as Party.Connection,
    );

    expect(storage.put).toHaveBeenCalled();
    expect(storage._data.get('admitted-user-ids')).toEqual(['host-1', 'guest-1']);
  });

  it('carries on when the runtime has no storage', async () => {
    // partykit node mode, a future runtime, or a disk problem: an admission
    // must not depend on a disk write succeeding.
    const broken = {
      get: vi.fn(async () => { throw new Error('no storage'); }),
      put: vi.fn(async () => { throw new Error('no storage'); }),
      _data: new Map<string, unknown>(),
    };
    const server = createServer(broken as unknown as ReturnType<typeof fakeStorage>);
    await expect(server.onStart()).resolves.toBeUndefined();

    const conn = fakeConn('c1');
    admitUser(server, conn, 'alice', 'Alice');
    expect(server.admitted.has('alice')).toBe(true);
    expect(sentTypes(conn)).toContain('JOIN_ADMITTED');
  });

  it('keeps the set bounded', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    for (let i = 0; i < 250; i += 1) {
      const conn = fakeConn(`c${i}`);
      server.onConnect(conn as unknown as Party.Connection);
      sendPresence(server, conn, `user-${i}`, `User ${i}`);
      // Everyone after the first is parked, so admit them as the host would.
      server.onMessage(
        JSON.stringify({ type: 'ADMIT', payload: { userId: `user-${i}` } }),
        (() => { const h = fakeConn('c0'); return h; })() as unknown as Party.Connection,
      );
    }
    const saved = storage._data.get('admitted-user-ids') as string[] | undefined;
    if (saved) expect(saved.length).toBeLessThanOrEqual(200);
  });
});

// ─── The model on screen, by reference ──────────────────────────────────────
//
// docs/plan/14-rooms-models-admin-ai.md batch BA. MODEL_CHANGE used to carry the
// file: up to 50 MB of base64, held in this server's memory and replayed to
// every connection that joined. It now carries a hash, and the bytes are fetched
// from /api/models/<hash>. Two things follow, and both are worth a red test:
//
//   * the reference is PERSISTED, so an upgrade that restarts the container
//     during a meeting does not leave everybody looking at the default model;
//   * a payload that still carries bytes is DROPPED, so a client that has not
//     been updated cannot put that size back on the socket.
//
// Batch BB turned the single reference into a SCENE — a list of models — so what
// is persisted and replayed now is that list, as SCENE_STATE. These tests are
// BA's, restated against the shape that carries them: the property each one was
// written for is unchanged.

describe('room.server — the model on screen, by reference', () => {
  const MODEL_KEY = 'current-model';
  const SCENE_KEY = 'room-scene';
  const HASH = 'a1'.repeat(32);
  const REFERENCE = { modelType: 'imported', hash: HASH, fileName: 'bracket.step', size: 2048 };
  /** The scene that reference means, which is what the server holds and relays. */
  const SCENE = {
    models: [{
      id: `model-${HASH}`,
      hash: HASH,
      fileName: 'bracket.step',
      line: 'bracket',
      revision: 'A',
      visible: true,
      offset: [0, 0, 0],
    }],
    builtIn: null,
  };
  // `seeded` travels with the scene (batch BQ2): a room that has held one says so, and
  // a room that never has is asking a client to start it from its design review.
  const PAYLOAD = { ...SCENE, modelEditors: 'host', seeded: true };

  function admittedHost(server: ReturnType<typeof createServer>) {
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function sendModel(server: ReturnType<typeof createServer>, conn: FakeConnection, payload: unknown) {
    return server.onMessage(
      JSON.stringify({ type: 'MODEL_CHANGE', payload }),
      conn as unknown as Party.Connection,
    );
  }

  /** The SCENE_STATE messages a connection or the room was sent, parsed. */
  function sceneStates(messages: Array<{ type: string; payload: unknown }>) {
    return messages.filter((m) => m.type === 'SCENE_STATE');
  }

  it('stores the reference, persists it, and relays it to the others', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = admittedHost(server);

    await sendModel(server, hostConn, REFERENCE);

    expect(server.scene).toEqual(SCENE);
    expect(storage._data.get(SCENE_KEY)).toEqual(PAYLOAD);
    expect(server.room.broadcast).toHaveBeenCalled();
    const relayed = JSON.parse(server.room.broadcast.mock.calls[0]?.[0] as string);
    expect(relayed).toEqual({ type: 'SCENE_STATE', payload: PAYLOAD });
  });

  it('relays only the fields it knows, so an unknown one cannot ride along', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = admittedHost(server);

    await sendModel(server, hostConn, { ...REFERENCE, admin: true, note: 'injected' });

    // What is stored and what is relayed is built field by field, not copied
    // from the payload: this object goes into room state, into persisted
    // storage, and out to every other connection.
    expect(server.scene).toEqual(SCENE);
    expect(storage._data.get(SCENE_KEY)).toEqual(PAYLOAD);
    const relayed = JSON.parse(server.room.broadcast.mock.calls[0]?.[0] as string);
    expect(relayed.payload).toEqual(PAYLOAD);
  });

  it('stores a built-in preset with no hash, which has nothing to fetch', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = admittedHost(server);

    await sendModel(server, hostConn, { modelType: 'bicycle' });

    expect(server.scene).toEqual({ models: [], builtIn: 'bicycle' });
    expect(storage._data.get(SCENE_KEY)).toBeTruthy();
  });

  it('replays the model to a new connection after a restart', async () => {
    // The container is recreated for an upgrade while a meeting is running.
    const storage = fakeStorage();
    const before = createServer(storage);
    await before.onStart();
    await sendModel(before, admittedHost(before), REFERENCE);
    expect(storage._data.get(SCENE_KEY)).toEqual(PAYLOAD);

    // A new server instance over the SAME storage is the restart.
    const after = createServer(storage);
    await after.onStart();
    expect(after.scene).toEqual(SCENE);

    const conn = fakeConn('c-late');
    admitUser(after, conn, 'late-1', 'Carol');
    expect(sceneStates(sent(conn))).toHaveLength(1);
    expect(sceneStates(sent(conn))[0].payload).toEqual(PAYLOAD);
  });

  it('drops a payload that still carries the file, and says so once', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = admittedHost(server);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // A client that has not been updated: same message shape as before, with the
    // bytes in it. Accepting it would put up to 50 MB back into room state and
    // into every replay, which is exactly what the reference shape removed.
    await sendModel(server, hostConn, { modelType: 'imported', fileName: 'b.glb', fileBase64: 'Zm9v' });
    await sendModel(server, hostConn, { modelType: 'imported', fileName: 'b.glb', fileBase64: 'YmFy' });

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(storage._data.has(SCENE_KEY)).toBe(false);
    const drops = log.mock.calls.filter((c) => String(c[0]).includes('dropped a MODEL_CHANGE'));
    expect(drops).toHaveLength(1);
    expect(String(drops[0]?.[0])).toMatch(/fileBase64/);
    log.mockRestore();
  });

  it('drops an imported reference with no hash, which there is nothing to fetch for', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = admittedHost(server);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendModel(server, hostConn, { modelType: 'imported', fileName: 'b.glb' });

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('drops a modelType it has never heard of', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = admittedHost(server);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sendModel(server, hostConn, { modelType: 'rev-c', hash: HASH });

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('does not restore a model an older server persisted with the bytes in it', async () => {
    // The shape written before this change. Restoring it would replay up to
    // 50 MB to every connection that joins, so it is dropped: the room comes
    // back with no model and the next import puts one up.
    const storage = fakeStorage({
      [MODEL_KEY]: { modelType: 'imported', fileName: 'b.glb', fileBase64: 'Zm9v' },
    });
    const server = createServer(storage);
    await server.onStart();
    expect(server.scene).toEqual({ models: [], builtIn: null });
  });

  it('restores a persisted preset even though it has no hash', async () => {
    const storage = fakeStorage({ [MODEL_KEY]: { modelType: 'synth' } });
    const server = createServer(storage);
    await server.onStart();
    expect(server.scene).toEqual({ models: [], builtIn: 'synth' });
  });

  it('ignores a persisted record that is not an object at all', async () => {
    for (const junk of ['bracket.glb', 42, null, [HASH]]) {
      const storage = fakeStorage({ [MODEL_KEY]: junk });
      const server = createServer(storage);
      await server.onStart();
      expect(server.scene, JSON.stringify(junk)).toEqual({ models: [], builtIn: null });
    }
  });

  it('carries on when the runtime has no storage', async () => {
    // The model is still shared with everybody currently in the room; only the
    // across-a-restart half is lost, which is the pre-existing behaviour.
    const broken = {
      get: vi.fn(async () => { throw new Error('no storage'); }),
      put: vi.fn(async () => { throw new Error('no storage'); }),
      _data: new Map<string, unknown>(),
    };
    const server = createServer(broken as unknown as ReturnType<typeof fakeStorage>);
    await expect(server.onStart()).resolves.toBeUndefined();

    const hostConn = admittedHost(server);
    await sendModel(server, hostConn, REFERENCE);
    expect(server.scene).toEqual(SCENE);
    expect(server.room.broadcast).toHaveBeenCalled();
  });

  it('still drops a model change from a connection that has not been admitted', async () => {
    // Unchanged by the reference shape: the knock gate decides what leaves the
    // server, and the model is the room's subject matter.
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    admittedHost(server);

    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    server.room.broadcast.mockClear();

    await sendModel(server, guestConn, REFERENCE);

    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(storage._data.has(SCENE_KEY)).toBe(false);
  });
});

// ─── The scene: several models, and who may change them ─────────────────────
//
// docs/plan/14-rooms-models-admin-ai.md batch BB. One reference became a list,
// and the list is the SERVER's. Three properties are worth a red test, because
// each one is a way a meeting goes wrong:
//
//   * a client sends an OPERATION and gets back the whole scene, so two people
//     changing it at once cannot overwrite each other with a stale list;
//   * the scene survives a restart of this container, models and all;
//   * "who may change models" is enforced HERE. Hiding the import button is a
//     courtesy; a socket that accepts anything is not a permission.

describe('room.server — scene operations', () => {
  const SCENE_KEY = 'room-scene';
  const HASH_A = 'a1'.repeat(32);
  const HASH_B = 'b2'.repeat(32);

  function model(id: string, hash: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      hash,
      fileName: `${id}.glb`,
      line: id,
      revision: 'A',
      visible: true,
      offset: [0, 0, 0],
      ...overrides,
    };
  }

  function host(server: ReturnType<typeof createServer>) {
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function member(server: ReturnType<typeof createServer>, hostConn: FakeConnection, userId = 'member-1', name = 'Bob') {
    const conn = fakeConn(`c-${userId}`);
    admitViaHost(server, hostConn, conn, userId, name);
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function send(server: ReturnType<typeof createServer>, conn: FakeConnection, payload: unknown) {
    return server.onMessage(
      JSON.stringify({ type: 'SCENE_UPDATE', payload }),
      conn as unknown as Party.Connection,
    );
  }

  /** Every SCENE_STATE the room relayed, newest last. */
  function relayedScenes(server: ReturnType<typeof createServer>) {
    return broadcast(server)
      .filter((m) => m.type === 'SCENE_STATE')
      .map((m) => m.payload);
  }

  async function started() {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    return { storage, server };
  }

  it('applies each operation to its own copy and relays one SCENE_STATE per change', async () => {
    const { storage, server } = await started();
    const hostConn = host(server);

    await send(server, hostConn, { op: 'add', model: model('bracket', HASH_A) });
    await send(server, hostConn, { op: 'add', model: model('mating-part', HASH_B, { line: 'bracket', revision: 'B' }) });
    await send(server, hostConn, { op: 'setVisible', id: 'bracket', visible: false });
    await send(server, hostConn, { op: 'setOffset', id: 'mating-part', offset: [2.4, 0, 0] });
    await send(server, hostConn, { op: 'remove', id: 'bracket' });

    const scenes = relayedScenes(server);
    expect(scenes).toHaveLength(5);
    // Each relay is the WHOLE scene as it then stood, not a delta: a client that
    // missed one is still correct after the next.
    expect(scenes[0]).toMatchObject({ models: [{ id: 'bracket' }] });
    expect(scenes[1]).toMatchObject({ models: [{ id: 'bracket' }, { id: 'mating-part' }] });
    expect(scenes[2]).toMatchObject({ models: [{ id: 'bracket', visible: false }, { id: 'mating-part' }] });
    expect(scenes[3]).toMatchObject({ models: [{ id: 'bracket' }, { id: 'mating-part', offset: [2.4, 0, 0] }] });
    expect(scenes[4]).toMatchObject({ models: [{ id: 'mating-part' }] });

    expect(server.scene.models).toEqual([model('mating-part', HASH_B, { line: 'bracket', revision: 'B', offset: [2.4, 0, 0] })]);
    expect(storage._data.get(SCENE_KEY)).toMatchObject({ models: [{ id: 'mating-part' }] });
  });

  it('relays to the sender too, because the server holds the only copy', async () => {
    const { server } = await started();
    const hostConn = host(server);
    server.room.broadcast.mockClear();

    await send(server, hostConn, { op: 'add', model: model('bracket', HASH_A) });

    // `relay` excludes nobody here. A client that predicted its own change gets
    // it confirmed; one that was refused, or that guessed wrong, gets corrected.
    expect(server.room.broadcast).toHaveBeenCalledTimes(1);
    const excluded = server.room.broadcast.mock.calls[0][1] as string[] | undefined;
    expect(excluded ?? []).not.toContain(hostConn.id);
  });

  it('keeps two people’s changes when they arrive one after the other', async () => {
    const { server } = await started();
    const hostConn = host(server);
    await send(server, hostConn, { op: 'add', model: model('bracket', HASH_A) });
    // The host lets everybody in on the models, so the second person is a real
    // editor rather than somebody about to be refused.
    await server.onMessage(
      JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors: 'everyone' } }),
      hostConn as unknown as Party.Connection,
    );
    const memberConn = member(server, hostConn);

    // Neither has seen the other's change: the host adds a second model, the
    // member hides the first. Sending whole lists would have lost one of them.
    await send(server, hostConn, { op: 'add', model: model('mating-part', HASH_B) });
    await send(server, memberConn, { op: 'setVisible', id: 'bracket', visible: false });

    expect(server.scene.models).toEqual([
      model('bracket', HASH_A, { visible: false }),
      model('mating-part', HASH_B),
    ]);
  });

  it('relays nothing for an operation that changes nothing', async () => {
    const { server } = await started();
    const hostConn = host(server);
    await send(server, hostConn, { op: 'add', model: model('bracket', HASH_A) });
    server.room.broadcast.mockClear();

    // Same id again, a flag that already has that value, and a model that is not
    // there. Nothing to persist, nothing to say.
    await send(server, hostConn, { op: 'add', model: model('bracket', HASH_A) });
    await send(server, hostConn, { op: 'setVisible', id: 'bracket', visible: true });
    await send(server, hostConn, { op: 'remove', id: 'nope' });
    await send(server, hostConn, { op: 'setOffset', id: 'nope', offset: [1, 0, 0] });

    expect(server.room.broadcast).not.toHaveBeenCalled();
  });

  it('refuses an operation it cannot read, and says so to the sender only', async () => {
    const { server } = await started();
    const hostConn = host(server);
    server.room.broadcast.mockClear();

    await send(server, hostConn, { op: 'add', model: { id: 'x', fileName: 'x.glb' } }); // no hash
    await send(server, hostConn, { op: 'explode', id: 'x' });
    await send(server, hostConn, { op: 'setOffset', id: 'x', offset: [1, 2] });

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    const refusals = sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED');
    expect(refusals).toHaveLength(3);
    expect(refusals[0].payload).toEqual({ reason: 'unreadable-update' });
  });

  it('drops a field it has never heard of rather than storing it', async () => {
    const { storage, server } = await started();
    const hostConn = host(server);

    await send(server, hostConn, {
      op: 'add',
      model: { ...model('bracket', HASH_A), admin: true, fileBase64: 'Zm9v' },
    });

    // `fileBase64` is BA's refusal surviving into the list shape: a payload that
    // carries bytes comes from a client that has not been updated, and storing
    // it would put 50 MB back into room state and into every replay.
    expect(server.scene.models).toEqual([]);
    expect(storage._data.has(SCENE_KEY)).toBe(false);
  });

  it('refuses to grow the scene past the cap', async () => {
    const { server } = await started();
    const hostConn = host(server);
    for (let i = 0; i < 24; i += 1) {
      await send(server, hostConn, { op: 'add', model: model(`m${i}`, `${i}`.padStart(64, '0')) });
    }
    expect(server.scene.models).toHaveLength(24);
    hostConn.send.mockClear();

    await send(server, hostConn, { op: 'add', model: model('one-too-many', HASH_B) });

    expect(server.scene.models).toHaveLength(24);
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'scene-full' });
  });

  it('keeps the scene, and who may change it, across a restart', async () => {
    const storage = fakeStorage();
    const before = createServer(storage);
    await before.onStart();
    const hostConn = host(before);
    await send(before, hostConn, { op: 'add', model: model('bracket', HASH_A) });
    await send(before, hostConn, { op: 'add', model: model('bracket-b', HASH_B, { line: 'bracket', revision: 'B' }) });
    await send(before, hostConn, { op: 'setVisible', id: 'bracket', visible: false });
    await before.onMessage(
      JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors: 'everyone' } }),
      hostConn as unknown as Party.Connection,
    );

    // An upgrade recreates the container mid-meeting. Same storage, new server.
    const after = createServer(storage);
    await after.onStart();
    expect(after.scene.models).toHaveLength(2);
    expect(after.scene.models[0].visible).toBe(false);
    expect(after.modelEditors).toBe('everyone');

    const lateConn = fakeConn('c-late');
    admitUser(after, lateConn, 'late-1', 'Carol');
    const states = sent(lateConn).filter((m) => m.type === 'SCENE_STATE');
    expect(states).toHaveLength(1);
    expect(states[0].payload).toMatchObject({
      models: [{ id: 'bracket', visible: false }, { id: 'bracket-b', revision: 'B' }],
      modelEditors: 'everyone',
    });
  });

  it('restores the single model a batch-BA server persisted', async () => {
    // A room that upgrades mid-review: BA wrote one reference under
    // 'current-model', BB reads a list under 'room-scene'. Without this
    // translation everybody reconnects to an empty room.
    const storage = fakeStorage({
      'current-model': { modelType: 'imported', hash: HASH_A, fileName: 'bracket.step', size: 2048 },
    });
    const server = createServer(storage);
    await server.onStart();

    expect(server.scene.models).toHaveLength(1);
    expect(server.scene.models[0]).toMatchObject({
      id: `model-${HASH_A}`,
      hash: HASH_A,
      fileName: 'bracket.step',
      line: 'bracket',
      revision: 'A',
      visible: true,
    });
    expect(server.modelEditors).toBe('host');
  });

  it('defaults to host-only, which is the safe direction', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    expect(server.modelEditors).toBe('host');

    // And a persisted scene with no setting in it — written by a build that had
    // the list but not the permission — comes back host-only rather than open.
    const older = createServer(fakeStorage({ [SCENE_KEY]: { models: [], builtIn: null } }));
    await older.onStart();
    expect(older.modelEditors).toBe('host');
  });
});

describe('room.server — who may change models', () => {
  const HASH_A = 'a1'.repeat(32);
  const ADD = { op: 'add', model: { id: 'bracket', hash: HASH_A, fileName: 'bracket.step', line: 'bracket', revision: 'A', visible: true, offset: [0, 0, 0] } };

  function host(server: ReturnType<typeof createServer>) {
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function member(server: ReturnType<typeof createServer>, hostConn: FakeConnection, userId = 'member-1') {
    const conn = fakeConn(`c-${userId}`);
    admitViaHost(server, hostConn, conn, userId, 'Bob');
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function send(server: ReturnType<typeof createServer>, conn: FakeConnection, payload: unknown) {
    return server.onMessage(
      JSON.stringify({ type: 'SCENE_UPDATE', payload }),
      conn as unknown as Party.Connection,
    );
  }

  async function setEditors(server: ReturnType<typeof createServer>, conn: FakeConnection, modelEditors: unknown) {
    return server.onMessage(
      JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors } }),
      conn as unknown as Party.Connection,
    );
  }

  it('refuses a non-editor, tells them why, and relays nothing', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);
    const memberConn = member(server, hostConn);

    await send(server, memberConn, ADD);

    // The scene is untouched, so there is no SCENE_STATE to send and no reason
    // for anybody else's screen to change. The person who tried is the only one
    // who hears anything, and what they hear is a reason.
    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(storage._data.has('room-scene')).toBe(false);
    expect(sent(memberConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'host-only' });
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(0);
  });

  it('lets the host change the scene whatever the setting says', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);

    await send(server, hostConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(broadcast(server).filter((m) => m.type === 'SCENE_STATE')).toHaveLength(1);
  });

  it('lets everybody in once the host says everyone', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);
    const memberConn = member(server, hostConn);
    await setEditors(server, hostConn, 'everyone');

    await send(server, memberConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(sent(memberConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(0);
  });

  it('admits a named person and refuses everybody else', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);
    const namedConn = member(server, hostConn, 'named-1');
    const otherConn = member(server, hostConn, 'other-1');
    await setEditors(server, hostConn, ['named-1']);

    await send(server, namedConn, ADD);
    await send(server, otherConn, { op: 'setVisible', id: 'bracket', visible: false });

    expect(server.scene.models).toHaveLength(1);
    expect(server.scene.models[0].visible).toBe(true);
    expect(sent(otherConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'not-an-editor' });
  });

  it('refuses a MODEL_CHANGE from a non-editor too, so an old client is not a way round it', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);
    const memberConn = member(server, hostConn);

    await server.onMessage(
      JSON.stringify({ type: 'MODEL_CHANGE', payload: { modelType: 'imported', hash: HASH_A, fileName: 'bracket.step' } }),
      memberConn as unknown as Party.Connection,
    );

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(sent(memberConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'host-only' });
  });

  it('translates a MODEL_CHANGE from the host into a one-model scene', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);

    await server.onMessage(
      JSON.stringify({
        type: 'MODEL_CHANGE',
        payload: { modelType: 'imported', hash: HASH_A, fileName: 'bracket.step', size: 2048 },
      }),
      hostConn as unknown as Party.Connection,
    );

    // "The scene is this one model" — which is what the message always meant
    // back when the scene could only hold one.
    expect(server.scene.models).toHaveLength(1);
    expect(server.scene.models[0]).toMatchObject({ hash: HASH_A, line: 'bracket', revision: 'A' });
    const states = broadcast(server).filter((m) => m.type === 'SCENE_STATE');
    expect(states).toHaveLength(1);
    // And the room is told in the new shape: this server no longer sends
    // MODEL_CHANGE at all, so a client only has one thing to listen for.
    expect(broadcast(server).filter((m) => m.type === 'MODEL_CHANGE')).toHaveLength(0);
  });

  it('takes the editor setting from the host and nobody else', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);
    const memberConn = member(server, hostConn);

    await setEditors(server, memberConn, 'everyone');
    expect(server.modelEditors).toBe('host');
    expect(sent(memberConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'host-only-setting' });

    await setEditors(server, hostConn, 'everyone');
    expect(server.modelEditors).toBe('everyone');
    // Relayed as part of the scene, so everybody's import button changes at once.
    const states = broadcast(server).filter((m) => m.type === 'SCENE_STATE');
    expect(states[states.length - 1].payload).toMatchObject({ modelEditors: 'everyone' });
    expect(storage._data.get('room-scene')).toMatchObject({ modelEditors: 'everyone' });
  });

  it('rebuilds a named list rather than storing what it was sent', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);

    await setEditors(server, hostConn, ['a', 'a', '', 42, { userId: 'b' }, 'b']);

    expect(server.modelEditors).toEqual(['a', 'b']);
  });

  it('refuses a setting it cannot read', async () => {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    const hostConn = host(server);

    await setEditors(server, hostConn, 'anyone');
    await setEditors(server, hostConn, 7);

    expect(server.modelEditors).toBe('host');
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(2);
  });

  it('still refuses a scene change from a connection that has not been admitted', async () => {
    // The knock gate runs first and drops the message outright: somebody who is
    // not in the room is not told why they may not change its models, because
    // they are not told anything.
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    // A host has to be in the room, or the knock gate would admit the guest by
    // rule 2 (nobody is in the room) and this would be testing the wrong thing.
    host(server);
    const guestConn = fakeConn('c-guest');
    server.onConnect(guestConn as unknown as Party.Connection);
    sendPresence(server, guestConn, 'guest-1', 'Bob');
    server.room.broadcast.mockClear();

    await send(server, guestConn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(sent(guestConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(0);
  });
});

// ─── Identity: signed names, and the token that proves them ─────────────────
//
// docs/plan/13-identity.md batch AZ. A presence name is whatever the client
// typed, so on a deployment with accounts anybody could be anybody in a design
// review — and the tracker items, transcripts and audit rows they left behind
// would say so. With IDENTITY_MODE set the client sends the signed-in person's
// access token too, and the server relays the name that TOKEN carries, or
// marks the person a guest when it cannot verify one.
//
// The other half of these tests is the credential itself. An access token is a
// bearer token: a room server that relayed one would hand every participant
// everybody else's session, so every assertion about what leaves the server is
// also an assertion that the token is not in it.

const JWT_SECRET = 'a-test-secret';
const IDENTITY_ENV = { IDENTITY_MODE: 'accounts', JWT_SECRET };
const ACCOUNT_ID = '6f1a2b3c-0000-4000-8000-000000000001';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** An HS256 access token of the shape GoTrue issues, signed with node's crypto. */
function accessToken(overrides: Record<string, unknown> = {}, secret = JWT_SECRET): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      sub: ACCOUNT_ID,
      aud: 'authenticated',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'alex.chen@acme.example',
      user_metadata: { full_name: 'Alex Chen' },
      ...overrides,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${signature}`;
}

interface Wire {
  type: string;
  payload: Record<string, unknown>;
}

/** Every message a connection was sent, parsed. */
function sent(conn: FakeConnection): Wire[] {
  return conn.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

/** Every message the room broadcast, parsed. */
function broadcast(server: ReturnType<typeof createServer>): Wire[] {
  return server.room.broadcast.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

/**
 * Everything this server persisted or put on a wire, as raw strings — the
 * surface a leaked credential could appear on.
 */
function persistedAndSent(
  server: ReturnType<typeof createServer>,
  conns: FakeConnection[],
): string[] {
  return [
    ...server.room.broadcast.mock.calls.map((c) => c[0] as string),
    ...conns.flatMap((c) => c.send.mock.calls.map((call) => call[0] as string)),
    ...[...server.room.storage._data.values()].map((v) => JSON.stringify(v)),
  ];
}

describe('room.server — identity on (IDENTITY_MODE=accounts)', () => {
  it('relays the name the token carries, not the one that was typed', async () => {
    const server = createServer(fakeStorage(), IDENTITY_ENV);
    const hostConn = fakeConn('c-host');
    await admitUser(server, hostConn, 'host-1', 'Alice', { accessToken: accessToken() });
    server.joinPolicy = 'open';
    server.room.broadcast.mockClear();

    const memberConn = fakeConn('c-member');
    await admitUser(server, memberConn, 'member-1', 'Somebody Else', {
      accessToken: accessToken(),
    });

    const relayed = broadcast(server).filter((m) => m.type === 'PRESENCE');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].payload).toMatchObject({
      userId: 'member-1',
      name: 'Alex Chen',
      guest: false,
      accountId: ACCOUNT_ID,
    });
    // What the roster hands a late joiner is the stored payload, so it has to
    // be the verified one too.
    expect(server.participants.get('member-1')?.name).toBe('Alex Chen');
    expect(server.participants.get('member-1')?.guest).toBe(false);
  });

  it("shows the host the account's name in the knock prompt", async () => {
    const server = createServer(fakeStorage(), IDENTITY_ENV);
    const hostConn = fakeConn('c-host');
    await admitUser(server, hostConn, 'host-1', 'Alice', { accessToken: accessToken() });
    hostConn.send.mockClear();

    const knocker = fakeConn('c-knocker');
    await admitUser(server, knocker, 'knocker-1', 'Not Alex', { accessToken: accessToken() });

    const requests = sent(hostConn).filter((m) => m.type === 'JOIN_REQUESTS').at(-1);
    expect(requests?.payload.pending).toEqual([
      { userId: 'knocker-1', name: 'Alex Chen', since: expect.any(Number), guest: false },
    ]);
  });

  it('marks a forged token as a guest and drops the account it claimed', async () => {
    const server = createServer(fakeStorage(), IDENTITY_ENV);
    const hostConn = fakeConn('c-host');
    await admitUser(server, hostConn, 'host-1', 'Alice', { accessToken: accessToken() });
    server.joinPolicy = 'open';
    server.room.broadcast.mockClear();

    const forger = fakeConn('c-forger');
    await admitUser(server, forger, 'forger-1', 'Alex Chen', {
      // Well-formed, correctly shaped claims, signed with the wrong secret.
      accessToken: accessToken({}, 'a-secret-only-the-forger-knows'),
      accountId: ACCOUNT_ID,
    });

    const relayed = broadcast(server).filter((m) => m.type === 'PRESENCE');
    expect(relayed[0].payload).toMatchObject({
      userId: 'forger-1',
      name: 'Alex Chen',
      guest: true,
    });
    expect(relayed[0].payload).not.toHaveProperty('accountId');
  });

  it('marks an expired token as a guest', async () => {
    const server = createServer(fakeStorage(), IDENTITY_ENV);
    server.joinPolicy = 'open';
    const conn = fakeConn('c-host');

    await admitUser(server, conn, 'host-1', 'Alex Chen', {
      accessToken: accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
    });

    expect(server.participants.get('host-1')?.guest).toBe(true);
  });

  it('marks a client that sent no token at all as a guest', async () => {
    const server = createServer(fakeStorage(), IDENTITY_ENV);
    server.joinPolicy = 'open';
    const conn = fakeConn('c-host');

    // The shape a pre-identity client, or a guest on a deployment that allows
    // them, still sends.
    await admitUser(server, conn, 'host-1', 'Supplier Sam', { guest: true });

    expect(server.participants.get('host-1')?.guest).toBe(true);
    expect(server.participants.get('host-1')?.name).toBe('Supplier Sam');
  });

  it('fails closed, once, when identity is on but no secret was passed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = createServer(fakeStorage(), { IDENTITY_MODE: 'accounts' });
    server.joinPolicy = 'open';
    const conn = fakeConn('c-host');

    await admitUser(server, conn, 'host-1', 'Alex Chen', { accessToken: accessToken() });
    await sendPresence(server, conn, 'host-1', 'Alex Chen', { accessToken: accessToken() });

    expect(server.participants.get('host-1')?.guest).toBe(true);
    expect(log.mock.calls.filter((c) => String(c[0]).includes('[identity]'))).toHaveLength(1);
    log.mockRestore();
  });

  it('never lets a token reach another client, the roster or storage', async () => {
    const storage = fakeStorage();
    const server = createServer(storage, IDENTITY_ENV);
    const tokens = [
      accessToken({ sub: `${ACCOUNT_ID}` }),
      accessToken({ sub: '6f1a2b3c-0000-4000-8000-000000000002' }),
      accessToken({ sub: '6f1a2b3c-0000-4000-8000-000000000003' }),
    ];

    const hostConn = fakeConn('c-host');
    await admitUser(server, hostConn, 'host-1', 'Alice', { accessToken: tokens[0] });
    server.joinPolicy = 'open';
    const memberConn = fakeConn('c-member');
    await admitUser(server, memberConn, 'member-1', 'Alex', { accessToken: tokens[1] });
    // A late joiner is handed the whole room state, ROSTER included.
    const lateConn = fakeConn('c-late');
    await admitUser(server, lateConn, 'late-1', 'Late', { accessToken: tokens[2] });

    const wires = persistedAndSent(server, [hostConn, memberConn, lateConn]);
    expect(wires.length).toBeGreaterThan(0);
    for (const wire of wires) {
      for (const token of tokens) expect(wire).not.toContain(token);
      expect(wire).not.toContain('accessToken');
    }

    // What the room keeps between restarts is ids, and nothing else.
    expect([...storage._data.keys()]).toEqual(['admitted-user-ids']);
    expect(storage._data.get('admitted-user-ids')).toEqual(['host-1', 'member-1', 'late-1']);

    // And the roster a late joiner received carries names and account ids.
    const roster = sent(lateConn)
      .filter((m) => m.type === 'ROSTER')
      .at(-1);
    expect(roster?.payload).toBeDefined();
    expect(JSON.stringify(roster?.payload)).not.toContain('accessToken');
  });

  it('verifies a token once per connection, not once per presence frame', async () => {
    // Presence is sent about ten times a second. Re-checking each frame would
    // be an HMAC per frame per participant, for an answer that changes when the
    // token does — an hour apart, when supabase-js refreshes the session.
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const server = createServer(fakeStorage(), IDENTITY_ENV);
    const conn = fakeConn('c-host');
    const token = accessToken();

    await admitUser(server, conn, 'host-1', 'Alice', { accessToken: token });
    expect(sign).toHaveBeenCalledTimes(1);

    await sendPresence(server, conn, 'host-1', 'Alice', { accessToken: token });
    await sendPresence(server, conn, 'host-1', 'Alice', { accessToken: token });
    expect(sign).toHaveBeenCalledTimes(1);

    // A refreshed session is a different string, so it is checked again — and
    // a token that has stopped being valid stops being trusted.
    await sendPresence(server, conn, 'host-1', 'Alice', {
      accessToken: accessToken({ exp: Math.floor(Date.now() / 1000) - 1 }),
    });
    expect(sign).toHaveBeenCalledTimes(2);
    expect(server.participants.get('host-1')?.guest).toBe(true);

    sign.mockRestore();
  });
});

describe('room.server — identity off (the default install)', () => {
  it('relays a presence exactly as it arrived, apart from what it strips', async () => {
    // No IDENTITY_MODE anywhere: not in room.env, not in process.env. This is
    // every install made before identity existed, and the behaviour it must
    // keep is that the server has no opinion about who anybody is.
    const server = createServer(fakeStorage());
    const hostConn = fakeConn('c-host');
    await admitUser(server, hostConn, 'host-1', 'Alice');
    server.joinPolicy = 'open';
    server.room.broadcast.mockClear();

    const token = accessToken();
    const memberConn = fakeConn('c-member');
    await admitUser(server, memberConn, 'member-1', 'Whoever I Say', {
      accessToken: token,
      guest: true,
    });

    const relayed = broadcast(server).filter((m) => m.type === 'PRESENCE');
    expect(relayed[0].payload).toMatchObject({
      userId: 'member-1',
      name: 'Whoever I Say',
      guest: true,
    });
    expect(relayed[0].payload).not.toHaveProperty('accessToken');
    expect(server.room.broadcast.mock.calls[0][0]).not.toContain(token);
  });

  it('treats an explicit IDENTITY_MODE=none the same way', async () => {
    // What docker-compose.yml writes for a default install: the variable is
    // there, and set to the value that means "do not verify anything".
    const server = createServer(fakeStorage(), { IDENTITY_MODE: 'none', JWT_SECRET });
    server.joinPolicy = 'open';
    const conn = fakeConn('c-host');

    await admitUser(server, conn, 'host-1', 'Alice', { accessToken: accessToken() });

    expect(server.participants.get('host-1')?.name).toBe('Alice');
    // Not marked as a guest: with identity off there is no such thing as one,
    // and a name stays as self-asserted as it has always been.
    expect(server.participants.get('host-1')?.guest).toBeUndefined();
  });

  it('drops an account id a client claimed for itself, in every mode', async () => {
    // accountId is stamped by the server from a token it verified. A
    // deployment with identity off has verified nothing, so it relays nothing:
    // the field is either proven or absent, never asserted.
    const server = createServer(fakeStorage());
    server.joinPolicy = 'open';
    const conn = fakeConn('c-host');

    await admitUser(server, conn, 'host-1', 'Alice', { accountId: ACCOUNT_ID });

    expect(server.participants.get('host-1')?.accountId).toBeUndefined();
  });

  it('is synchronous, so a room with identity off is not slowed by it', () => {
    // applyVerifiedIdentity returns null rather than a resolved promise when
    // there is nothing to check, because awaiting one still defers the rest of
    // the handler by a microtask. A test that asserts immediately after
    // onMessage — the way every test above the identity section does — only
    // passes if the whole handler ran during the call.
    const server = createServer(fakeStorage());
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');

    expect(server.admitted.has('host-1')).toBe(true);
    expect(server.participants.has('host-1')).toBe(true);
  });
});

// ─── A room that has never held a scene (batch BQ2) ──────────────────────────
//
// The server sends its scene on connect even when it is empty, and the client replaces
// its own copy with what arrives. For a room that has never held one — every new variant
// room, and any main room whose server storage is gone — that wiped the models the client
// had just built from the review's history, and nothing ever put them back: the variant of
// a review holding two imported models showed "No model yet", and went on showing it after
// a reload. `seeded` is the flag that tells the two kinds of empty apart, and SCENE_SEED is
// how a client that may change the models answers it.

describe('room.server — a room that has never held a scene', () => {
  const SCENE_KEY = 'room-scene';
  const HASH_A = 'a1'.repeat(32);
  const MODEL_A = {
    id: `model-${HASH_A}`,
    hash: HASH_A,
    fileName: 'headphones.glb',
    line: 'headphones',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
  };
  /** What a client that read its review's history offers an empty room. */
  const SEED = { models: [MODEL_A], builtIn: null };

  function host(server: ReturnType<typeof createServer>) {
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function member(server: ReturnType<typeof createServer>, hostConn: FakeConnection, userId = 'member-1') {
    const conn = fakeConn(`c-${userId}`);
    admitViaHost(server, hostConn, conn, userId, 'Bob');
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  function seed(server: ReturnType<typeof createServer>, conn: FakeConnection, payload: unknown) {
    return server.onMessage(
      JSON.stringify({ type: 'SCENE_SEED', payload }),
      conn as unknown as Party.Connection,
    );
  }

  function update(server: ReturnType<typeof createServer>, conn: FakeConnection, payload: unknown) {
    return server.onMessage(
      JSON.stringify({ type: 'SCENE_UPDATE', payload }),
      conn as unknown as Party.Connection,
    );
  }

  /** The SCENE_STATE messages one connection was sent, parsed. */
  function states(conn: FakeConnection) {
    return sent(conn).filter((m) => m.type === 'SCENE_STATE');
  }

  async function fresh() {
    const storage = fakeStorage();
    const server = createServer(storage);
    await server.onStart();
    return { storage, server };
  }

  it('says it has never been seeded while it is fresh', async () => {
    const { server } = await fresh();
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');

    // Empty AND unseeded, which is the two facts a client has to be able to tell apart:
    // the first says what is on screen, the second says nobody has said what should be.
    expect(states(conn)).toHaveLength(1);
    expect(states(conn)[0].payload).toMatchObject({ models: [], builtIn: null, seeded: false });
  });

  it('counts an accepted change as the room having been seeded', async () => {
    const { storage, server } = await fresh();
    const hostConn = host(server);

    await update(server, hostConn, { op: 'add', model: MODEL_A });

    expect(server.sceneSeeded).toBe(true);
    // Persisted with the scene, so a restart does not turn a room somebody has been
    // working in back into one anybody's client may overwrite from the database.
    expect(storage._data.get(SCENE_KEY)).toMatchObject({ seeded: true });

    const late = fakeConn('c-late');
    admitViaHost(server, hostConn, late, 'late-1', 'Carol');
    expect(states(late)[0].payload).toMatchObject({ models: [{ id: MODEL_A.id }], seeded: true });
  });

  it('counts a preset with no models as seeded too', async () => {
    const { server } = await fresh();
    const hostConn = host(server);

    await update(server, hostConn, { op: 'setBuiltIn', builtIn: 'bicycle' });

    expect(server.scene).toEqual({ models: [], builtIn: 'bicycle' });
    expect(server.sceneSeeded).toBe(true);
  });

  it('takes one seed from a client that may change the models, and relays it as its own scene', async () => {
    const { storage, server } = await fresh();
    const hostConn = host(server);

    await seed(server, hostConn, SEED);

    expect(server.scene.models).toEqual([MODEL_A]);
    expect(server.sceneSeeded).toBe(true);
    expect(storage._data.get(SCENE_KEY)).toMatchObject({ models: [{ id: MODEL_A.id }], seeded: true });
    const relayed = broadcast(server).filter((m) => m.type === 'SCENE_STATE');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].payload).toMatchObject({ models: [{ id: MODEL_A.id }], seeded: true });
    // Relayed to the sender as well, the way every scene change is: the seeder's own
    // screen is then showing what the room says rather than what it computed.
    expect(server.room.broadcast.mock.calls[0][1] as string[] | undefined ?? []).not.toContain(hostConn.id);
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(0);
  });

  it('refuses a second seed, and changes nothing for anybody', async () => {
    const { server } = await fresh();
    const hostConn = host(server);
    await seed(server, hostConn, SEED);
    server.room.broadcast.mockClear();
    hostConn.send.mockClear();

    await seed(server, hostConn, { models: [{ ...MODEL_A, id: 'other', hash: 'b2'.repeat(32) }], builtIn: null });

    // Two people opened the same empty variant room at the same moment and both offered
    // its review's models. The first one won; the second is told, in a reason its client
    // drops without showing, and the room keeps the scene it already had.
    expect(server.scene.models).toEqual([MODEL_A]);
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'already_seeded' });
  });

  it('refuses a seed from somebody who may not change the models', async () => {
    const { storage, server } = await fresh();
    const hostConn = host(server);
    const memberConn = member(server, hostConn);

    await seed(server, memberConn, SEED);

    // A seed is a scene change that happens to be the first one. A participant who could
    // put a model up by joining an empty room could put one up at all, so the question is
    // the one SCENE_UPDATE already asks — and the room stays unseeded, for somebody who
    // may answer it.
    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.sceneSeeded).toBe(false);
    expect(storage._data.has(SCENE_KEY)).toBe(false);
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(sent(memberConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'host-only' });
  });

  it('lets a named person seed, the same setting that lets them change the models', async () => {
    const { server } = await fresh();
    const hostConn = host(server);
    const namedConn = member(server, hostConn, 'named-1');
    await server.onMessage(
      JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors: ['named-1'] } }),
      hostConn as unknown as Party.Connection,
    );
    server.room.broadcast.mockClear();

    await seed(server, namedConn, SEED);

    expect(server.scene.models).toEqual([MODEL_A]);
    expect(sent(namedConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(0);
  });

  it('ignores a seed with nothing in it, and stays open to a better answer', async () => {
    const { server } = await fresh();
    const hostConn = host(server);

    await seed(server, hostConn, { models: [], builtIn: null });

    // A client whose read of the review came back empty has not seeded the room. Accepting
    // the offer would have closed the question with "nothing", and every later arrival
    // would have been told the room was already started.
    expect(server.sceneSeeded).toBe(false);
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')).toHaveLength(0);

    await seed(server, hostConn, SEED);
    expect(server.scene.models).toEqual([MODEL_A]);
  });

  it('rebuilds a seed rather than storing what it was sent', async () => {
    const { server } = await fresh();
    const hostConn = host(server);

    await seed(server, hostConn, {
      models: [{ ...MODEL_A, admin: true, rotation: [0, 1.5, 0], scale: 2 }],
      builtIn: 'synth',
      modelEditors: 'everyone',
    });

    // The transform rides along — it is what the review stored — but a field this server
    // has never heard of does not, and neither does a `modelEditors` the seed has no
    // business setting: who may change the models is SET_MODEL_EDITORS' answer alone.
    expect(server.scene.models[0]).toEqual({ ...MODEL_A, rotation: [0, 1.5, 0], scale: 2 });
    expect(server.scene.builtIn).toBe('synth');
    expect(server.modelEditors).toBe('host');
  });

  it('refuses a seed it cannot read, and stays unseeded', async () => {
    const { server } = await fresh();
    const hostConn = host(server);

    await seed(server, hostConn, { models: 'not-a-list' });

    // Not a scene at all, so nothing is rescued and nothing is stored — the same answer
    // an unreadable SCENE_UPDATE gets — and the room is still open to one that can be read.
    expect(server.sceneSeeded).toBe(false);
    expect(sent(hostConn).filter((m) => m.type === 'SCENE_REFUSED')[0].payload).toEqual({ reason: 'unreadable-update' });
  });

  it('drops a model in a seed that has nothing to fetch for it', async () => {
    const { server } = await fresh();
    const hostConn = host(server);

    await seed(server, hostConn, { models: [{ id: 'x', fileName: 'x.glb' }, MODEL_A], builtIn: null });

    // No hash on the first one: accepting it would tell every participant to render a
    // model that does not exist. It is dropped and the readable one beside it is kept,
    // because a model somebody can no longer see is recoverable and an empty room in the
    // middle of a review is not.
    expect(server.scene.models).toEqual([MODEL_A]);
  });

  it('caps a seed at the scene’s limit', async () => {
    const { server } = await fresh();
    const hostConn = host(server);
    const models = Array.from({ length: 30 }, (_, i) => ({
      ...MODEL_A, id: `m${i}`, hash: `${i}`.padStart(64, '0'), line: `line-${i}`,
    }));

    await seed(server, hostConn, { models, builtIn: null });

    expect(server.scene.models).toHaveLength(24);
  });

  it('counts a scene an older build stored with models in it as seeded', async () => {
    // The record has no `seeded` field: it was written before the flag existed. What it
    // holds is the evidence — a build with no seed path only persisted a scene it had been
    // given, so a room with models in it has been started already.
    const storage = fakeStorage({ [SCENE_KEY]: { models: [MODEL_A], builtIn: null, modelEditors: 'host' } });
    const server = createServer(storage);
    await server.onStart();

    expect(server.sceneSeeded).toBe(true);
    const conn = fakeConn('c-late');
    admitUser(server, conn, 'late-1', 'Carol');
    expect(states(conn)[0].payload).toMatchObject({ models: [{ id: MODEL_A.id }], seeded: true });
  });

  it('leaves an older build’s EMPTY record unseeded, so a client can still start the room', async () => {
    const storage = fakeStorage({ [SCENE_KEY]: { models: [], builtIn: null } });
    const server = createServer(storage);
    await server.onStart();

    expect(server.sceneSeeded).toBe(false);
    const conn = fakeConn('c-host');
    admitUser(server, conn, 'host-1', 'Alice');
    expect(states(conn)[0].payload).toMatchObject({ models: [], seeded: false });
  });

  it('keeps the flag across a restart, so a seeded room is not seeded again', async () => {
    const storage = fakeStorage();
    const before = createServer(storage);
    await before.onStart();
    await seed(before, host(before), SEED);

    const after = createServer(storage);
    await after.onStart();

    expect(after.scene.models).toEqual([MODEL_A]);
    expect(after.sceneSeeded).toBe(true);
  });
});
