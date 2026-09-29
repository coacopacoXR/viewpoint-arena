// A dropped variant's room is a record, and the room server is what keeps it one.
//
// docs/plan/15-sessions-and-variants.md batch BX. Dropping a variant closes its open
// cards, greys it on the session map and keeps it — and its room name still resolves,
// so its room is still reachable by an address somebody typed or a link they kept from
// the week they were exploring it. What must NOT still happen there is a change: a
// model moved in a dropped variant's room would be persisted, relayed to everybody
// else in it, and written by lib/scene/keepPlacements into the review's saved positions
// for a line nobody is exploring any more.
//
// So the refusal is HERE rather than in the browser, because a browser's refusal is one
// devtools panel away from not being one. One predicate — `droppedLine` — answers every
// message that could change the room, and what is pinned below is that all of them ask
// it, that a room whose line is still live is untouched by it, that a main-line room
// pays no read at all for it, and that a database which cannot be reached costs a
// meeting nothing.
//
// The fakes are this file's own, as roomEditing.test.ts explains for itself: a harness
// shared between two test files is one neither can change safely. These differ from that
// file's in the one respect this file needs — the room's NAME, which is where the
// variant's letter lives.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as Party from 'partykit/server';
import RoomServer from '../room.server';

// ─── Fakes ──────────────────────────────────────────────────────────────────

const SCENE_KEY = 'room-scene';
const HASH_A = 'a1'.repeat(32);

/** The default install: no IDENTITY_MODE, so the meeting host is the authority. */
const PLAIN_ENV = { ANON_KEY: 'test-anon-key', REST_URL: 'http://rest:3000' };

/** A dropped variant's room, and the same review's main-line room. */
const DROPPED_ROOM = 'rev-1~A';
const MAIN_ROOM = 'rev-1';

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

interface FakeRoomShape {
  id: string;
  broadcast: ReturnType<typeof vi.fn>;
  storage: ReturnType<typeof fakeStorage>;
  env: Record<string, string>;
}

type Server = RoomServer & { room: FakeRoomShape };

function createServer(roomId: string, env: Record<string, string> = PLAIN_ENV): Server {
  const room = {
    id: roomId,
    broadcast: vi.fn(),
    storage: fakeStorage(),
    env,
  } as unknown as Party.Room;
  return new RoomServer(room) as Server;
}

interface Wire {
  type: string;
  payload: Record<string, unknown>;
}

function sent(conn: FakeConnection): Wire[] {
  return conn.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

function relayed(server: Server): Wire[] {
  return server.room.broadcast.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

function refusals(conn: FakeConnection): Wire[] {
  return sent(conn).filter((m) => m.type === 'SCENE_REFUSED');
}

function editingRefusals(conn: FakeConnection): Wire[] {
  return sent(conn).filter((m) => m.type === 'EDITING_REFUSED');
}

/**
 * A fetch that answers the line-status read out of `status`, and any other read or
 * write with an empty body. `null` makes it fail, which is how the fail-open case is
 * asked for: a room server that refused every scene change whenever PostgREST hiccuped
 * would turn an outage into a meeting nobody could hold.
 */
function lineFetch(status: 'active' | 'adopted' | 'dropped' | null) {
  return vi.fn(async (url: string) => {
    if (String(url).includes('review_lines')) {
      if (status === null) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify([{ status }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, { status: 201 });
  });
}

function lineReads(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter((call) => String(call[0]).includes('review_lines')).length;
}

/** The meeting host, admitted, with everything already sent to them forgotten. */
async function hostOf(server: Server): Promise<FakeConnection> {
  const conn = fakeConn('c-host');
  server.onConnect(conn as unknown as Party.Connection);
  // The first PRESENCE into an empty room is admitted whatever the join policy is, so
  // one person is enough to be the host and to be the one whose changes are judged.
  await server.onMessage(
    JSON.stringify({
      type: 'PRESENCE',
      payload: { userId: 'host-1', name: 'Alice', color: '#000', position: [0, 0, 0], lookAt: [0, 0, 0] },
    }),
    conn as unknown as Party.Connection,
  );
  conn.send.mockClear();
  server.room.broadcast.mockClear();
  return conn;
}

function send(server: Server, conn: FakeConnection, message: Record<string, unknown>) {
  return server.onMessage(JSON.stringify(message), conn as unknown as Party.Connection);
}

const ADD = {
  type: 'SCENE_UPDATE',
  payload: {
    op: 'add',
    model: {
      id: 'bracket',
      hash: HASH_A,
      fileName: 'bracket.glb',
      line: 'bracket',
      revision: 'A',
      visible: true,
      offset: [0, 0, 0],
    },
  },
};

const SEED = {
  type: 'SCENE_SEED',
  payload: {
    models: [{
      id: 'bracket',
      hash: HASH_A,
      fileName: 'bracket.glb',
      line: 'bracket',
      revision: 'A',
      visible: true,
      offset: [0, 0, 0],
    }],
    builtIn: null,
  },
};

const LEGACY_IMPORT = {
  type: 'MODEL_CHANGE',
  payload: { modelType: 'imported', hash: HASH_A, fileName: 'bracket.glb' },
};

const SET_EDITORS = { type: 'SET_MODEL_EDITORS', payload: { modelEditors: 'everyone' } };

/** A room on a line whose status the database answers with. */
async function roomOn(status: 'active' | 'adopted' | 'dropped' | null, roomId = DROPPED_ROOM) {
  const fetchMock = lineFetch(status);
  vi.stubGlobal('fetch', fetchMock);
  const server = createServer(roomId);
  await server.onStart();
  const hostConn = await hostOf(server);
  fetchMock.mockClear();
  return { server, hostConn, storage: server.room.storage, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── The room refuses everything that would change it ───────────────────────

describe('room.server — a dropped variant’s room', () => {
  it('refuses a scene change, tells the sender why, and relays and persists nothing', async () => {
    const { server, hostConn, storage } = await roomOn('dropped');

    await send(server, hostConn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(storage._data.has(SCENE_KEY)).toBe(false);
    // The sender is the only one who hears anything, and what they hear is a reason
    // the client turns into a sentence (lib/scene/roomScene.describeSceneRefusal).
    expect(refusals(hostConn)[0].payload).toEqual({ reason: 'dropped-line' });
  });

  it('refuses a seed, a legacy import and a change to who may edit — every message that could change the room', async () => {
    const { server, hostConn, storage } = await roomOn('dropped');

    await send(server, hostConn, SEED);
    await send(server, hostConn, LEGACY_IMPORT);
    await send(server, hostConn, SET_EDITORS);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.modelEditors).toBe('host');
    expect(server.room.broadcast).not.toHaveBeenCalled();
    expect(storage._data.has(SCENE_KEY)).toBe(false);
    // One refusal per message, all of them the room's own reason rather than a role
    // one: this is the meeting HOST being refused, so "only the host can change the
    // models" would have named a rule that is not the one in their way.
    expect(refusals(hostConn).map((m) => m.payload)).toEqual([
      { reason: 'dropped-line' },
      { reason: 'dropped-line' },
      { reason: 'dropped-line' },
    ]);
  });

  it('refuses to hand out the Edit lock, with a reason that is about the line', async () => {
    const { server, hostConn } = await roomOn('dropped');

    await send(server, hostConn, { type: 'EDITING_START', payload: {} });

    expect(server.editing).toBeNull();
    expect(editingRefusals(hostConn)[0].payload).toEqual({ reason: 'dropped', editorName: null });
    // Not 'busy' with a take-over offered: there is no lock to take.
    expect(server.room.broadcast).not.toHaveBeenCalled();
  });

  it('refuses a take-over too, because there is no lock in the room to take', async () => {
    const { server, hostConn } = await roomOn('dropped');

    await send(server, hostConn, { type: 'EDITING_START', payload: { force: true } });

    expect(server.editing).toBeNull();
    expect(editingRefusals(hostConn)[0].payload).toEqual({ reason: 'dropped', editorName: null });
  });

  it('reads the line status once for a burst of changes rather than once per change', async () => {
    const { server, hostConn, fetchMock } = await roomOn('dropped');

    await send(server, hostConn, ADD);
    await send(server, hostConn, ADD);
    await send(server, hostConn, ADD);

    expect(refusals(hostConn)).toHaveLength(3);
    expect(lineReads(fetchMock)).toBe(1);
  });
});

// ─── Every other room is untouched by it ────────────────────────────────────

describe('room.server — a room whose line is not dropped', () => {
  it('applies and relays a scene change in an active variant’s room', async () => {
    const { server, hostConn, storage } = await roomOn('active');

    await send(server, hostConn, ADD);

    expect(server.scene.models.map((m) => m.id)).toEqual(['bracket']);
    expect(relayed(server).filter((m) => m.type === 'SCENE_STATE')).toHaveLength(1);
    expect(storage._data.has(SCENE_KEY)).toBe(true);
    expect(refusals(hostConn)).toHaveLength(0);
  });

  it('hands the Edit lock to the host of an active variant’s room', async () => {
    const { server, hostConn } = await roomOn('active');

    await send(server, hostConn, { type: 'EDITING_START', payload: {} });

    expect(server.editing).toEqual({ userId: 'host-1', name: 'Alice' });
    expect(editingRefusals(hostConn)).toHaveLength(0);
  });

  it('applies a scene change in a main-line room and reads no line to find out', async () => {
    const { server, hostConn, fetchMock } = await roomOn('dropped', MAIN_ROOM);

    await send(server, hostConn, ADD);

    // The letter is in the room's own name, so a main-line room answers "not dropped"
    // without a read — and a main line has no status to be dropped by in any case.
    expect(lineReads(fetchMock)).toBe(0);
    expect(server.scene.models.map((m) => m.id)).toEqual(['bracket']);
    expect(refusals(hostConn)).toHaveLength(0);
  });

  it('applies a scene change when the line read fails, because a database outage is not a reason to end a meeting', async () => {
    const { server, hostConn } = await roomOn(null);

    await send(server, hostConn, ADD);

    expect(server.scene.models.map((m) => m.id)).toEqual(['bracket']);
    expect(refusals(hostConn)).toHaveLength(0);
  });

  it('applies a scene change on an install with no database at all', async () => {
    const fetchMock = lineFetch('dropped');
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(DROPPED_ROOM, {});
    await server.onStart();
    const hostConn = await hostOf(server);
    fetchMock.mockClear();

    await send(server, hostConn, ADD);

    // No ANON_KEY, so there is nothing to read the line status with. Fail-open, for the
    // reason readLineDropped gives: the alternative is a default install whose variant
    // rooms refuse every scene change.
    expect(lineReads(fetchMock)).toBe(0);
    expect(server.scene.models.map((m) => m.id)).toEqual(['bracket']);
  });
});
