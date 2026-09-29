// The room server and a moved part — batch BR.
//
// A part override travels in the same SCENE_UPDATE as a model transform, is judged by
// the same permission, and is refused the same way when it cannot be read. Nothing
// here is a new authority: `scenePermissions` already answers "may this person change
// the models in this room", and moving one bolt of a product is changing the product.
//
// What IS new, and what only this level can prove, is the two edges of it:
//
//   • a caller without the permission gets a refusal and the room's scene does not
//     move — including the sender's own screen, because the sender learns the scene
//     from the relay and there is no relay;
//   • a malformed part entry is refused WHOLE rather than applied in part. Half a move
//     would leave the person who dragged a part looking at it where they put it and
//     everybody else looking at it where it was, with nothing on either screen to say
//     the two differ.
//
// The fakes are this file's own rather than imported from roomRoles.test.ts, for the
// reason that file gives: a harness shared between two files is a harness neither can
// change without breaking the other.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as Party from 'partykit/server';
import RoomServer from '../room.server';
import { MAX_SCENE_PARTS, sceneModelId, sceneModelPrefix, type SceneModel } from '../../lib/scene/roomScene';

const HASH = 'a1'.repeat(32);
const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const FLANGE = `${PREFIX}_3`;

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
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

function createServer(storage = fakeStorage(), env: Record<string, string> = {}) {
  const room = { id: 'test-room', broadcast: vi.fn(), storage, env } as unknown as Party.Room;
  return new RoomServer(room) as RoomServer & {
    room: { broadcast: ReturnType<typeof vi.fn>; storage: ReturnType<typeof fakeStorage>; env: Record<string, string> };
  };
}

type Server = ReturnType<typeof createServer>;

function admit(server: Server, conn: FakeConnection, userId: string, name: string) {
  server.onConnect(conn as unknown as Party.Connection);
  conn.send.mockClear();
  return server.onMessage(
    JSON.stringify({
      type: 'PRESENCE',
      payload: { userId, name, color: '#000', position: [0, 0, 0], lookAt: [0, 0, 0] },
    }),
    conn as unknown as Party.Connection,
  );
}

/** A second person in through the host's knock gate — a room on the default install. */
async function admitViaHost(
  server: Server,
  hostConn: FakeConnection,
  conn: FakeConnection,
  userId: string,
  name: string,
) {
  await admit(server, conn, userId, name);
  await server.onMessage(JSON.stringify({ type: 'ADMIT', payload: { userId } }), hostConn as unknown as Party.Connection);
  return admit(server, conn, userId, name);
}

interface Wire {
  type: string;
  payload: Record<string, unknown>;
}

function sent(conn: FakeConnection): Wire[] {
  return conn.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

function refusals(conn: FakeConnection): Wire[] {
  return sent(conn).filter((m) => m.type === 'SCENE_REFUSED');
}

/**
 * What the room relayed.
 *
 * Read off `room.broadcast` rather than off a connection's `send`: a relay goes to
 * everybody at once (and excludes by connection id, not by choosing recipients), so
 * the only place it is observable in this harness is the broadcast fake.
 */
function relayed(server: Server, type = 'SCENE_STATE'): Wire[] {
  return server.room.broadcast.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Wire)
    .filter((m) => m.type === type);
}

function send(server: Server, conn: FakeConnection, payload: unknown) {
  return server.onMessage(
    JSON.stringify({ type: 'SCENE_UPDATE', payload }),
    conn as unknown as Party.Connection,
  );
}

/** The room's one model, with no parts: what a scene looked like before batch BR. */
function bracket(overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    id: MODEL_ID,
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

const MOVE_PART = {
  op: 'setPartTransform',
  id: MODEL_ID,
  nodeId: FLANGE,
  transform: { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
};

/**
 * A room on the default install — no IDENTITY_MODE, so no roles to look up and the
 * meeting host is the whole of the authority, exactly as it was before accounts.
 *
 * Awaited at every step, including the model the room starts with: `onMessage` is
 * async, and a setup that fired its own messages without waiting would have the
 * add's relay and its storage write land after the mock clears below — which reads
 * as the room relaying and persisting something the test under it did not do.
 */
async function plainRoom(editors: 'host' | 'everyone' = 'host') {
  const storage = fakeStorage();
  const server = createServer(storage, { ANON_KEY: 'test-anon-key', REST_URL: 'http://rest:3000' });
  const hostConn = fakeConn('c-host');
  await admit(server, hostConn, 'host-1', 'Alice');
  const memberConn = fakeConn('c-member');
  await admitViaHost(server, hostConn, memberConn, 'member-1', 'Bob');
  if (editors === 'everyone') {
    await server.onMessage(
      JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors: 'everyone' } }),
      hostConn as unknown as Party.Connection,
    );
  }
  await send(server, hostConn, { op: 'add', model: bracket() });
  hostConn.send.mockClear();
  memberConn.send.mockClear();
  server.room.broadcast.mockClear();
  storage.put.mockClear();
  return { server, storage, hostConn, memberConn };
}

beforeEach(() => {
  // The room server writes an audit row when it can; on a default install with no
  // identities it does not, but every other test file in this directory stubs it and
  // a real fetch from a unit test would be a flake waiting to happen.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('room.server — who may move a part', () => {
  it('lets the person who may change the models move one, and tells everybody', async () => {
    const { server, hostConn } = await plainRoom();

    await send(server, hostConn, MOVE_PART);

    expect(server.scene.models[0].parts).toEqual({ [FLANGE]: MOVE_PART.transform });
    expect(refusals(hostConn)).toHaveLength(0);
    // Relayed to the sender too, which is the design: there is one copy of the scene
    // and it lives on the server, so the person who dragged the part learns where it
    // ended up from the same message everybody else does — `relay` excludes nobody
    // here, and an exclusion list is the only way a connection is left out.
    const states = relayed(server);
    expect(states).toHaveLength(1);
    expect(states[0].payload).toMatchObject({
      models: [{ id: MODEL_ID, parts: { [FLANGE]: MOVE_PART.transform } }],
    });
  });

  it('refuses somebody who may not change the models, and changes nothing for anybody', async () => {
    const { server, storage, memberConn } = await plainRoom();

    await send(server, memberConn, MOVE_PART);

    expect(server.scene.models[0].parts).toBeUndefined();
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'host-only' });
    // Nothing persisted and nothing relayed: a refused change is not a change, and a
    // SCENE_STATE nobody's copy differs from would redraw every participant's model
    // tree for nothing.
    expect(storage.put).not.toHaveBeenCalled();
    expect(relayed(server)).toHaveLength(0);
  });

  it('is the same permission as a whole-model move, widened by the same setting', async () => {
    const { server, memberConn } = await plainRoom('everyone');

    await send(server, memberConn, MOVE_PART);

    expect(server.scene.models[0].parts).toEqual({ [FLANGE]: MOVE_PART.transform });
    expect(refusals(memberConn)).toHaveLength(0);
  });

  it('takes a reset from the same people, and from nobody else', async () => {
    const { server, memberConn, hostConn } = await plainRoom();
    await send(server, hostConn, MOVE_PART);
    hostConn.send.mockClear();
    memberConn.send.mockClear();

    await send(server, memberConn, { op: 'clearPartTransforms', id: MODEL_ID });
    expect(server.scene.models[0].parts).toEqual({ [FLANGE]: MOVE_PART.transform });
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'host-only' });

    await send(server, hostConn, { op: 'setPartTransform', id: MODEL_ID, nodeId: FLANGE, transform: null });
    expect(server.scene.models[0].parts).toBeUndefined();
    expect(refusals(hostConn)).toHaveLength(0);
  });
});

describe('room.server — a part entry it cannot read', () => {
  it('refuses the whole move rather than applying the readable half of it', async () => {
    const { server, storage, hostConn } = await plainRoom();

    for (const transform of [
      { position: [1, NaN, 0] },
      { position: [1, 0] },
      { scale: [1, 0, 1] },
      { scale: [-1, 1, 1] },
      { position: ['1', '0', '0'] },
      {},
      'over there',
    ]) {
      hostConn.send.mockClear();
      storage.put.mockClear();

      await send(server, hostConn, { ...MOVE_PART, transform });

      expect(server.scene.models[0].parts, JSON.stringify(transform)).toBeUndefined();
      expect(refusals(hostConn)[0].payload).toEqual({ reason: 'unreadable-update' });
      expect(storage.put).not.toHaveBeenCalled();
    }
  });

  it('refuses a node id it would have to store and replay', async () => {
    const { server, hostConn } = await plainRoom();

    await send(server, hostConn, { ...MOVE_PART, nodeId: 'x'.repeat(201) });
    expect(server.scene.models[0].parts).toBeUndefined();
    expect(refusals(hostConn)[0].payload).toEqual({ reason: 'unreadable-update' });

    await send(server, hostConn, { ...MOVE_PART, nodeId: '' });
    expect(refusals(hostConn)[1].payload).toEqual({ reason: 'unreadable-update' });
  });

  it('stops a model carrying more part entries than one model may', async () => {
    const { server, hostConn } = await plainRoom();

    for (let i = 0; i <= MAX_SCENE_PARTS; i += 1) {
      await send(server, hostConn, {
        op: 'setPartTransform',
        id: MODEL_ID,
        nodeId: `${PREFIX}_${i}`,
        transform: { position: [i, 0, 0] },
      });
    }

    // The first MAX_SCENE_PARTS landed; the one past the cap did not, and the room
    // went on working rather than growing its persisted state without bound.
    expect(Object.keys(server.scene.models[0].parts ?? {})).toHaveLength(MAX_SCENE_PARTS);
    expect(server.scene.models[0].parts?.[`${PREFIX}_${MAX_SCENE_PARTS}`]).toBeUndefined();
  });

  it('drops unreadable parts from a model being ADDED, and keeps the model', async () => {
    const { server, hostConn } = await plainRoom();

    await send(server, hostConn, {
      op: 'add',
      model: bracket({
        id: 'model-other',
        hash: 'b2'.repeat(32),
        fileName: 'mating-part.step',
        line: 'mating-part',
        parts: { x_1: { position: [1, 0, 0] }, x_2: { scale: [0, 1, 1] } },
      }),
    });

    // A model a person can no longer see is recoverable; a room that refused an import
    // in the middle of a review is not. That is asRoomScene's rule for a bad model,
    // applied one level down — and it is why an OPERATION is refused instead.
    expect(server.scene.models).toHaveLength(2);
    expect(server.scene.models[1].parts).toBeUndefined();
    expect(refusals(hostConn)).toHaveLength(0);
  });
});

describe('room.server — a moved part survives a restart', () => {
  it('comes back out of storage with the model it belongs to', async () => {
    const { server, storage, hostConn } = await plainRoom();

    await send(server, hostConn, MOVE_PART);
    const persisted = storage._data.get('room-scene') as Record<string, unknown>;
    expect(persisted).toBeDefined();

    const restarted = createServer(fakeStorage({ 'room-scene': persisted }));
    await restarted.onStart();

    expect(restarted.scene.models[0].parts).toEqual({ [FLANGE]: MOVE_PART.transform });
  });

  it('restores a scene written before parts existed, unchanged', async () => {
    // The record a previous build persisted: no `parts` key anywhere. Absent has to
    // keep meaning "the file's own transform", or every room on the install would
    // come back from its restart with its products subtly rearranged.
    const { storage } = await plainRoom();
    const persisted = storage._data.get('room-scene') as Record<string, unknown>;

    const restarted = createServer(fakeStorage({ 'room-scene': persisted }));
    await restarted.onStart();

    expect(restarted.scene.models).toHaveLength(1);
    expect(restarted.scene.models[0].parts).toBeUndefined();
  });
});
