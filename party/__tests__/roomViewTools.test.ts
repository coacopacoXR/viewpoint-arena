// VIEW_TOOLS — the room's cut plane, and the explode task 08b renders.
//
// The value is shared rather than local, which is a decision about what a meeting is: a cut
// is something the room is looking at together, not something one browser is doing to its
// own screen. So the room server is what holds it, and four claims only a server can make
// are pinned here:
//
//   1. a valid value is KEPT and relayed to everybody but the sender, who already applied
//      it locally and would otherwise see its own section a round trip late;
//   2. junk is REFUSED whole — an unreadable axis, a position that is not a finite number —
//      because this payload is stored and then handed to every connection in the room, and
//      a NaN in a plane's constant makes every fragment of every model compare false;
//   3. an arrival is handed the current value, always, including the default, because a
//      browser that reconnects is holding the cut it had when its socket dropped;
//   4. the room puts it back when the last person leaves, so the next meeting in this room
//      does not open on a section somebody left at midnight.
//
// Plus the two things it must NOT do: it is not persisted to room storage (a cut is a fact
// about the meeting in progress, not about the review), and a frame with no payload in it
// does not take the message loop down.
//
// The fakes are this file's own, as roomEditing.test.ts explains for itself: a harness
// shared between two test files is one neither can change safely.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Party from 'partykit/server';
import RoomServer from '../room.server';
import { DEFAULT_VIEW_TOOLS } from '../../lib/scene/viewTools';

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
 * `admitViaHost` clears `send` as it registers a connection, which is right for the room's
 * existing members and wrong here: what an arrival is handed when it joins is the whole of
 * the claim being made.
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

const viewToolsMessage = (payload: unknown): string =>
  JSON.stringify({ type: 'VIEW_TOOLS', payload });

/** The cut a meeting is most likely to make first: half way along X, positive side away. */
const A_CUT = { axis: 'x', position: 0.5, flip: false };

describe('VIEW_TOOLS', () => {
  let server: Server;
  let host: FakeConnection;
  let member: FakeConnection;

  beforeEach(async () => {
    server = createServer();
    host = fakeConn('conn-host');
    member = fakeConn('conn-member');
    await admit(server, host, 'host-1', 'Olga Owner');
    await admitViaHost(server, host, member, 'u-ben', 'Ben Participant');
    server.room.broadcast.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a valid value and relays it to everybody but the sender', async () => {
    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0 }), host as unknown as Party.Connection);

    expect(server.viewTools).toEqual({ cut: A_CUT, explode: 0 });
    const messages = relayedOfType(server, 'VIEW_TOOLS');
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toEqual({ cut: A_CUT, explode: 0 });
    // `relay(json, [sender.id])` is how the room excludes one connection, and the sender is
    // the one excluded: it applied the value the moment the slider moved.
    expect(server.room.broadcast.mock.calls[0][1]).toContain('conn-host');
  });

  it('is not a host-only control — any participant may cut the model', async () => {
    // A cut is a way of looking, and the laser is not the host's either. A room where only
    // one person could open a section would be a room where the person who knows the model
    // has to ask the person who set the meeting up to look at it for them.
    await server.onMessage(
      viewToolsMessage({ cut: { axis: 'y', position: 0.25, flip: true }, explode: 0 }),
      member as unknown as Party.Connection,
    );

    expect(server.viewTools).toEqual({ cut: { axis: 'y', position: 0.25, flip: true }, explode: 0 });
    expect(relayedOfType(server, 'VIEW_TOOLS')).toHaveLength(1);
  });

  it('carries the explode beside the cut, so 08b needs no new message', async () => {
    await server.onMessage(viewToolsMessage({ cut: null, explode: 0.75 }), host as unknown as Party.Connection);

    expect(server.viewTools).toEqual({ cut: null, explode: 0.75 });
    expect(relayedOfType(server, 'VIEW_TOOLS')[0].payload).toEqual({ cut: null, explode: 0.75 });
  });

  it('clamps a position and an explode that overshoot, and refuses one that is not a number', async () => {
    await server.onMessage(viewToolsMessage({ cut: { axis: 'z', position: 1.6, flip: false }, explode: 3 }), host as unknown as Party.Connection);
    expect(server.viewTools).toEqual({ cut: { axis: 'z', position: 1, flip: false }, explode: 1 });

    server.room.broadcast.mockClear();
    await server.onMessage(viewToolsMessage({ cut: { axis: 'z', position: Number.NaN, flip: false } }), host as unknown as Party.Connection);
    // Refused WHOLE, and the room keeps the value it had: a NaN that reached a THREE.Plane's
    // constant would make every fragment of every model compare false, which is a room with
    // no product in it rather than a room with a cut in the wrong place.
    expect(server.viewTools).toEqual({ cut: { axis: 'z', position: 1, flip: false }, explode: 1 });
    expect(relayedOfType(server, 'VIEW_TOOLS')).toHaveLength(0);
  });

  it.each([
    ['an axis that is not an axis', { cut: { axis: 'w', position: 0.5, flip: false } }],
    ['a cut that is not an object', { cut: 'x=0.5' }],
    ['a payload that is not an object', 'cut please'],
    ['a payload that is an array', [{ axis: 'x' }]],
    ['no payload at all', undefined],
    ['a flip that is not a boolean and a position that is a string', { cut: { axis: 'x', position: 'half', flip: 'yes' } }],
  ])('refuses %s and relays nothing', async (_label, payload) => {
    const before = server.viewTools;
    await server.onMessage(viewToolsMessage(payload), host as unknown as Party.Connection);

    expect(server.viewTools).toBe(before);
    expect(relayedOfType(server, 'VIEW_TOOLS')).toHaveLength(0);
  });

  it('strips a field nobody wrote, so it cannot ride into room state', async () => {
    await server.onMessage(
      viewToolsMessage({ cut: A_CUT, explode: 0, andMyHouseKeys: { secret: 's' } }),
      host as unknown as Party.Connection,
    );

    expect(server.viewTools).toEqual({ cut: A_CUT, explode: 0 });
    expect(relayedOfType(server, 'VIEW_TOOLS')[0].payload).toEqual({ cut: A_CUT, explode: 0 });
  });

  it('relays nothing when the value is the one the room already had', async () => {
    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0 }), host as unknown as Party.Connection);
    server.room.broadcast.mockClear();

    // A second browser sending the same section, or one drag landing where it started. The
    // room's answer is that nothing happened, which is also what stops a relayed message
    // from being relayed again by a client that writes what it receives.
    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0 }), member as unknown as Party.Connection);

    expect(relayedOfType(server, 'VIEW_TOOLS')).toHaveLength(0);
  });

  it('is handed to an arrival, including the default', async () => {
    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0 }), host as unknown as Party.Connection);

    const late = fakeConn('conn-late');
    await arrive(server, host, late, 'u-late', 'Late Arrival');
    expect(sentTo(late).filter((message) => message.type === 'VIEW_TOOLS')).toEqual([
      { type: 'VIEW_TOOLS', payload: { cut: A_CUT, explode: 0 } },
    ]);

    // And the default goes too, always: a browser that RECONNECTS is holding the cut it had
    // when its socket dropped, and an absent message would leave it cutting a model the room
    // has already put back together.
    const second = createServer();
    const secondHost = fakeConn('conn-host-2');
    await admit(second, secondHost, 'host-2', 'Olga Owner');
    const rejoiner = fakeConn('conn-rejoin');
    await arrive(second, secondHost, rejoiner, 'u-re', 'Re Joiner');
    expect(sentTo(rejoiner).filter((message) => message.type === 'VIEW_TOOLS')).toEqual([
      { type: 'VIEW_TOOLS', payload: DEFAULT_VIEW_TOOLS },
    ]);
  });

  it('is put back when the last person leaves, and kept while anybody remains', async () => {
    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0.4 }), host as unknown as Party.Connection);

    // One of two out: the meeting is still on, and so is its section.
    server.onClose(member as unknown as Party.Connection);
    expect(server.viewTools).toEqual({ cut: A_CUT, explode: 0.4 });

    // The last one out: the next meeting in this room is a different meeting.
    server.onClose(host as unknown as Party.Connection);
    expect(server.viewTools).toEqual(DEFAULT_VIEW_TOOLS);
  });

  it('is not written to room storage, because it is a fact about the meeting', async () => {
    // Cleared first: admission writes the room's `admitted-user-ids`, which is the knock
    // gate's own business and nothing to do with this message.
    server.room.storage.put.mockClear();

    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0 }), host as unknown as Party.Connection);

    // A room that hibernates comes back with the default, and a cut nobody is looking at any
    // more is not a cut anybody missed. The same reasoning lib/recordingState.ts gives for
    // itself: the thing this decides the fate of dies with the page.
    expect(server.room.storage.put).not.toHaveBeenCalled();
    for (const key of server.room.storage._data.keys()) {
      expect(key.toLowerCase()).not.toContain('viewtool');
    }
  });

  it('drops a value from a connection nobody has admitted', async () => {
    // The knock gate is above this handler in onMessage, and a person parked in the waiting
    // room is not in the meeting and does not get to cut the model it is having.
    const pending = fakeConn('conn-pending');
    server.onConnect(pending as unknown as Party.Connection);
    await server.onMessage(presence('u-outside', 'Waiting Person'), pending as unknown as Party.Connection);
    await server.onMessage(viewToolsMessage({ cut: A_CUT, explode: 0 }), pending as unknown as Party.Connection);

    expect(server.viewTools).toEqual(DEFAULT_VIEW_TOOLS);
    expect(relayedOfType(server, 'VIEW_TOOLS')).toHaveLength(0);
  });

  it('survives a frame that is not JSON and one with no type', async () => {
    await server.onMessage('{ not json', host as unknown as Party.Connection);
    await server.onMessage(JSON.stringify({ payload: A_CUT }), host as unknown as Party.Connection);

    expect(server.viewTools).toEqual(DEFAULT_VIEW_TOOLS);
  });
});
