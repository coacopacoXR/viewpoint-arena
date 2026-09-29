// TRANSCRIPT_KEEP — who may decide that a meeting's transcript is stored.
//
// docs/plan/15-sessions-and-variants.md batch BU. The choice is made by whoever
// stopped the recording and carried out by whoever ends the meeting, which is
// usually a different browser, so it travels through the room server. Three claims
// only a server can make are pinned here:
//
//   1. it is the same permission the Record button is offered under — the meeting
//      host — and a participant or a guest who crafts the frame is dropped;
//   2. the room hears the answer, including the sender, so every client holds the
//      same choice and a browser that ends the meeting acts on it;
//   3. it survives an arrival: a client that joins after the choice was made is
//      handed it, because the person who made it may have reloaded between Stop
//      and End and the meeting must not be recorded without its transcript.
//
// Plus the two things it must NOT do: it is not persisted to room storage (the
// transcript it decides the fate of lives in one browser's memory and dies with the
// page), and a frame with no payload in it does not take the message loop down.
//
// The fakes are this file's own, as roomEditing.test.ts explains for itself: a
// harness shared between two test files is one neither can change safely.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Party from 'partykit/server';
import RoomServer from '../room.server';

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    _data: data,
  };
}

interface FakeConnection {
  id: string;
  send: ReturnType<typeof vi.fn>;
}

function fakeConn(id: string): FakeConnection {
  return { id, send: vi.fn() };
}

function createServer(storage = fakeStorage()) {
  const room = {
    id: 'review-1',
    broadcast: vi.fn(),
    storage,
    env: {},
  } as unknown as Party.Room;
  return new RoomServer(room) as RoomServer & {
    room: { broadcast: ReturnType<typeof vi.fn>; storage: ReturnType<typeof fakeStorage> };
  };
}

type Server = ReturnType<typeof createServer>;

function presence(userId: string, name: string): string {
  return JSON.stringify({
    type: 'PRESENCE',
    payload: { userId, name, color: '#000', position: [0, 0, 0], lookAt: [0, 0, 0] },
  });
}

/** Register a connection and send PRESENCE, which admits the first person as host. */
function admit(server: Server, conn: FakeConnection, userId: string, name: string) {
  server.onConnect(conn as unknown as Party.Connection);
  conn.send.mockClear();
  return server.onMessage(presence(userId, name), conn as unknown as Party.Connection);
}

/** A second person, in through the host's knock gate. */
async function admitViaHost(
  server: Server,
  hostConn: FakeConnection,
  conn: FakeConnection,
  userId: string,
  name: string,
) {
  await admit(server, conn, userId, name); // knocks, parks under the 'ask' policy
  await server.onMessage(
    JSON.stringify({ type: 'ADMIT', payload: { userId } }),
    hostConn as unknown as Party.Connection,
  );
  await admit(server, conn, userId, name);
}

/**
 * Somebody who arrives NOW, with nothing they are sent cleared on the way.
 *
 * `admitViaHost` clears `send` as it registers a connection, which is right for the
 * room's existing members and wrong here: what an arrival is handed when it joins is
 * the whole of the claim being made.
 */
async function arrive(
  server: Server,
  hostConn: FakeConnection,
  conn: FakeConnection,
  userId: string,
  name: string,
) {
  server.onConnect(conn as unknown as Party.Connection);
  await server.onMessage(presence(userId, name), conn as unknown as Party.Connection);
  await server.onMessage(
    JSON.stringify({ type: 'ADMIT', payload: { userId } }),
    hostConn as unknown as Party.Connection,
  );
  await server.onMessage(presence(userId, name), conn as unknown as Party.Connection);
}

interface Wire {
  type: string;
  payload: Record<string, unknown>;
}

/** Everything relayed to the room, parsed. `relay` goes through room.broadcast. */
function relayed(server: Server): Wire[] {
  return server.room.broadcast.mock.calls.map((call) => JSON.parse(call[0] as string) as Wire);
}

function relayedOfType(server: Server, type: string): Wire[] {
  return relayed(server).filter((message) => message.type === type);
}

/** Everything ONE connection was sent, parsed — which is how a joiner is told. */
function sentTo(conn: FakeConnection): Wire[] {
  return conn.send.mock.calls
    .map((call) => JSON.parse(call[0] as string) as Wire)
    .filter((message) => message && typeof message.type === 'string');
}

function keepMessage(keep: boolean, includePointing: boolean, byName: string): string {
  return JSON.stringify({ type: 'TRANSCRIPT_KEEP', payload: { keep, includePointing, byName } });
}

describe('TRANSCRIPT_KEEP', () => {
  let server: Server;
  let host: FakeConnection;
  let member: FakeConnection;

  beforeEach(async () => {
    server = createServer();
    host = fakeConn('conn-host');
    member = fakeConn('conn-member');
    await admit(server, host, 'host-1', 'Olga Owner');
    await admitViaHost(server, host, member, 'u-ben', 'Ben Guest');
    server.room.broadcast.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is kept and relayed when the meeting host sends it', async () => {
    await server.onMessage(keepMessage(true, true, 'Olga Owner'), host as unknown as Party.Connection);

    expect(server.transcriptKeep).toEqual({ keep: true, includePointing: true, byName: 'Olga Owner' });
    expect(relayedOfType(server, 'TRANSCRIPT_KEEP')).toEqual([
      { type: 'TRANSCRIPT_KEEP', payload: { keep: true, includePointing: true, byName: 'Olga Owner' } },
    ]);
  });

  it('is relayed to the sender too, so the panel’s pressed state is the room’s answer', async () => {
    await server.onMessage(keepMessage(true, false, 'Olga Owner'), host as unknown as Party.Connection);

    // `relay` builds an EXCLUSION list: an empty one is the proof that everybody,
    // the sender included, was sent it.
    const [, excluded] = server.room.broadcast.mock.calls[0] as [string, string[]];
    expect(excluded).toEqual([]);
  });

  it('is dropped when somebody who may not record the meeting sends it', async () => {
    // A participant is in the room and admitted, so this is not the knock gate
    // answering: it is the permission the Record button is offered under. What they
    // would be deciding is that a meeting's transcript is written to the review's
    // session row, where everybody who can open the map can download it later.
    await server.onMessage(keepMessage(true, true, 'Ben Guest'), member as unknown as Party.Connection);

    expect(server.transcriptKeep).toBeNull();
    expect(relayedOfType(server, 'TRANSCRIPT_KEEP')).toEqual([]);
  });

  it('reaches a connection that arrives after the choice was made', async () => {
    await server.onMessage(keepMessage(true, false, 'Olga Owner'), host as unknown as Party.Connection);

    const late = fakeConn('conn-late');
    await arrive(server, host, late, 'u-maria', 'Maria Guest');

    expect(sentTo(late).filter((message) => message.type === 'TRANSCRIPT_KEEP')).toEqual([
      { type: 'TRANSCRIPT_KEEP', payload: { keep: true, includePointing: false, byName: 'Olga Owner' } },
    ]);
  });

  it('says nothing to an arrival when nobody has chosen', async () => {
    const late = fakeConn('conn-late');
    await arrive(server, host, late, 'u-maria', 'Maria Guest');

    expect(sentTo(late).some((message) => message.type === 'TRANSCRIPT_KEEP')).toBe(false);
  });

  it('takes a later choice over an earlier one', async () => {
    await server.onMessage(keepMessage(true, true, 'Olga Owner'), host as unknown as Party.Connection);
    await server.onMessage(keepMessage(false, false, 'Olga Owner'), host as unknown as Party.Connection);

    expect(server.transcriptKeep).toEqual({ keep: false, includePointing: false, byName: 'Olga Owner' });
    expect(relayedOfType(server, 'TRANSCRIPT_KEEP')).toHaveLength(2);
  });

  it('answers the default for a frame with nothing usable in it, rather than throwing', async () => {
    // The knock gate has already established who this connection is, but a frame off
    // the wire is not a payload: `msg.payload.keep` on a missing payload would throw
    // inside the message loop and take the connection's handling down with it.
    await expect(
      server.onMessage(JSON.stringify({ type: 'TRANSCRIPT_KEEP' }), host as unknown as Party.Connection),
    ).resolves.toBeUndefined();

    expect(server.transcriptKeep).toEqual({ keep: false, includePointing: false, byName: '' });
  });

  it('does not relay a name of somebody else’s choosing, or one of any length', async () => {
    await server.onMessage(
      JSON.stringify({
        type: 'TRANSCRIPT_KEEP',
        payload: { keep: 'yes', includePointing: 1, byName: 'x'.repeat(5000) },
      }),
      host as unknown as Party.Connection,
    );

    expect(server.transcriptKeep?.keep).toBe(false);
    expect(server.transcriptKeep?.includePointing).toBe(false);
    expect(server.transcriptKeep?.byName).toHaveLength(100);
  });

  it('is not persisted to room storage, because the transcript it is about dies with the page', async () => {
    await server.onMessage(keepMessage(true, true, 'Olga Owner'), host as unknown as Party.Connection);

    for (const call of server.room.storage.put.mock.calls) {
      expect(JSON.stringify(call[1] ?? null)).not.toContain('includePointing');
    }
  });
});
