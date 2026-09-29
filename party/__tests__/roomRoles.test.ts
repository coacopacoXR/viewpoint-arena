// Who may change the models in a room, judged by their role in the design review.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. Batch BB enforced this against
// the meeting host, which on a deployment with no accounts is the only authority
// there is. With accounts on, the host is merely whoever arrived first — a
// supplier's guest could be that — so the authority becomes the person's ROLE IN
// THIS REVIEW, read from review_curations.owner_id and review_members over
// PostgREST with the anon key the room server already holds, and cached for sixty
// seconds (party/reviewRoles.ts, unit-tested in reviewRoles.test.ts).
//
// The other half of this file is that identity.mode 'none' does not change at all:
// no role is looked up, no fetch is made for one, and the refusal a non-host gets
// is still 'host-only'. A default install must not gain a database round trip per
// import, or a new way to be told no. Those tests live at the bottom, and they are
// the regression guard for the "must not regress" list in the batch brief.
//
// The fakes here are this file's own rather than imported from
// room.server.test.ts: a test harness shared between two files is a harness
// neither of them can change without breaking the other.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type * as Party from 'partykit/server';
import RoomServer from '../room.server';

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

function createServer(
  storage = fakeStorage(),
  env: Record<string, string> = {},
): RoomServer & { room: { broadcast: ReturnType<typeof vi.fn>; storage: ReturnType<typeof fakeStorage>; env: Record<string, string> } } {
  const room = {
    id: 'test-room',
    broadcast: vi.fn(),
    storage,
    env,
  } as unknown as Party.Room;
  return new RoomServer(room) as ReturnType<typeof createServer>;
}

type Server = ReturnType<typeof createServer>;

/** Register a connection and send PRESENCE, which under an open policy admits it. */
function admit(
  server: Server,
  conn: FakeConnection,
  userId: string,
  name: string,
  extra: Record<string, unknown> = {},
) {
  server.onConnect(conn as unknown as Party.Connection);
  conn.send.mockClear();
  return server.onMessage(
    JSON.stringify({
      type: 'PRESENCE',
      payload: { userId, name, color: '#000', position: [0, 0, 0], lookAt: [0, 0, 0], ...extra },
    }),
    conn as unknown as Party.Connection,
  );
}

/** A second person in through the host's knock gate, for the identity-off tests. */
function admitViaHost(server: Server, hostConn: FakeConnection, conn: FakeConnection, userId: string, name: string) {
  admit(server, conn, userId, name); // knocks, parks under 'ask'
  server.onMessage(
    JSON.stringify({ type: 'ADMIT', payload: { userId } }),
    hostConn as unknown as Party.Connection,
  );
  admit(server, conn, userId, name);
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

function send(server: Server, conn: FakeConnection, payload: unknown) {
  return server.onMessage(
    JSON.stringify({ type: 'SCENE_UPDATE', payload }),
    conn as unknown as Party.Connection,
  );
}

function setEditors(server: Server, conn: FakeConnection, modelEditors: unknown) {
  return server.onMessage(
    JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors } }),
    conn as unknown as Party.Connection,
  );
}

// ─── Identity ───────────────────────────────────────────────────────────────

const JWT_SECRET = 'a-test-secret';
const ROLE_ENV = {
  IDENTITY_MODE: 'accounts',
  JWT_SECRET,
  ANON_KEY: 'test-anon-key',
  REST_URL: 'http://rest:3000',
};

const OWNER_ACCOUNT = '6f1a2b3c-0000-4000-8000-0000000000a1';
const EDITOR_ACCOUNT = '6f1a2b3c-0000-4000-8000-0000000000b2';
const MEMBER_ACCOUNT = '6f1a2b3c-0000-4000-8000-0000000000c3';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** An HS256 access token of the shape GoTrue issues, signed with node's crypto. */
function accessToken(overrides: Record<string, unknown> = {}): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      sub: MEMBER_ACCOUNT,
      aud: 'authenticated',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'somebody@acme.example',
      user_metadata: { full_name: 'Somebody' },
      ...overrides,
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${claims}`).digest('base64url');
  return `${header}.${claims}.${signature}`;
}

/** A token for `account`, optionally an admin of the install. */
function tokenFor(account: string, options: { admin?: boolean } = {}): string {
  return accessToken({
    sub: account,
    user_metadata: { full_name: `Name of ${account.slice(-4)}` },
    ...(options.admin ? { app_metadata: { role: 'admin' } } : {}),
  });
}

// ─── The review's facts, as PostgREST would answer ──────────────────────────

interface RosterRow {
  user_id: string;
  role: string;
}

interface Facts {
  ownerId: string | null;
  members: RosterRow[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that answers the two role reads out of `facts`, and the audit write with 201. */
function roleFetch(facts: Facts) {
  return vi.fn(async (url: string) => {
    if (url.includes('review_curations')) return jsonResponse([{ owner_id: facts.ownerId }]);
    if (url.includes('review_members')) return jsonResponse(facts.members);
    return new Response(null, { status: 201 });
  });
}

/** How many times the server asked the database about the review's roster. */
function rosterReads(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter((call) => String(call[0]).includes('review_members')).length;
}

// ─── The scene change every test below tries ────────────────────────────────

const HASH_A = 'a1'.repeat(32);
const ADD = {
  op: 'add',
  model: {
    id: 'bracket',
    hash: HASH_A,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0] as [number, number, number],
  },
};
const HIDE = { op: 'setVisible', id: 'bracket', visible: false };

describe('room.server — scene permissions by role (identity on)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A room with identity on, an open door, and a review whose facts are `facts`. */
  function roomWith(facts: Facts): Server {
    fetchMock = roleFetch(facts);
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(fakeStorage(), ROLE_ENV);
    server.joinPolicy = 'open';
    return server;
  }

  /** Somebody in the room, proven to be `account` by a token this server verifies. */
  async function person(server: Server, connId: string, userId: string, token: string | null) {
    const conn = fakeConn(connId);
    await admit(server, conn, userId, 'Somebody', token === null ? { guest: true } : { accessToken: token });
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  it('lets the owner change the scene even when somebody else is hosting the meeting', async () => {
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    // The host arrives first and is NOT the owner: arriving first is not
    // authority on a deployment that can say who everybody is.
    await person(server, 'c-host', 'host-1', tokenFor(MEMBER_ACCOUNT));
    const ownerConn = await person(server, 'c-owner', 'owner-1', tokenFor(OWNER_ACCOUNT));

    await send(server, ownerConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(refusals(ownerConn)).toHaveLength(0);
  });

  it('lets an editor on the roster change the scene', async () => {
    const server = roomWith({
      ownerId: OWNER_ACCOUNT,
      members: [{ user_id: EDITOR_ACCOUNT, role: 'editor' }],
    });
    await person(server, 'c-host', 'host-1', tokenFor(OWNER_ACCOUNT));
    const editorConn = await person(server, 'c-editor', 'editor-1', tokenFor(EDITOR_ACCOUNT));

    await send(server, editorConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(refusals(editorConn)).toHaveLength(0);
  });

  it('refuses a participant, says it is their role, and changes nothing for anybody', async () => {
    const storage = fakeStorage();
    fetchMock = roleFetch({
      ownerId: OWNER_ACCOUNT,
      members: [{ user_id: MEMBER_ACCOUNT, role: 'participant' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(storage, ROLE_ENV);
    server.joinPolicy = 'open';
    await person(server, 'c-host', 'host-1', tokenFor(OWNER_ACCOUNT));
    const memberConn = await person(server, 'c-member', 'member-1', tokenFor(MEMBER_ACCOUNT));

    await send(server, memberConn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(storage._data.has('room-scene')).toBe(false);
    expect(server.room.broadcast).not.toHaveBeenCalled();
    // Not 'host-only': the host is not what stood in their way, and saying so
    // would have sent them to ask a person who could not help.
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'role-forbidden' });
  });

  it('refuses the meeting host when the host is only a participant', async () => {
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    const hostConn = await person(server, 'c-host', 'host-1', tokenFor(MEMBER_ACCOUNT));

    await send(server, hostConn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(refusals(hostConn)[0].payload).toEqual({ reason: 'role-forbidden' });
  });

  it('refuses a connection whose token did not verify, whatever the roster says', async () => {
    // A guest has no account to look up, so a roster naming the owner cannot be
    // reached by typing the owner's name into the join form.
    const server = roomWith({
      ownerId: OWNER_ACCOUNT,
      members: [{ user_id: OWNER_ACCOUNT, role: 'owner' }],
    });
    await person(server, 'c-host', 'host-1', tokenFor(OWNER_ACCOUNT));
    const guestConn = await person(server, 'c-guest', 'guest-1', null);

    await send(server, guestConn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(refusals(guestConn)[0].payload).toEqual({ reason: 'role-forbidden' });
  });

  it('treats an admin of the install as the owner of the review', async () => {
    // The plan: "Owner (creator, and admins)". It is also what makes a review
    // whose creator has left the company manageable by anybody at all.
    // app_metadata.role is what GoTrue puts in the token and what
    // api/_lib/adminAuth.ts reads; a room server has no other way to know one.
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    const adminConn = await person(server, 'c-admin', 'admin-1', tokenFor(MEMBER_ACCOUNT, { admin: true }));

    await send(server, adminConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(refusals(adminConn)).toHaveLength(0);
  });

  it("still honours the review's own 'everyone may change models'", async () => {
    // That setting is the owner's choice, made through the control BB built. A
    // role that quietly overrode it would be a role that ignores the review.
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    const ownerConn = await person(server, 'c-owner', 'owner-1', tokenFor(OWNER_ACCOUNT));
    await setEditors(server, ownerConn, 'everyone');
    const memberConn = await person(server, 'c-member', 'member-1', tokenFor(MEMBER_ACCOUNT));

    await send(server, memberConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(refusals(memberConn)).toHaveLength(0);
  });

  it('still honours a named list of people, and refuses everybody else', async () => {
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    const ownerConn = await person(server, 'c-owner', 'owner-1', tokenFor(OWNER_ACCOUNT));
    await setEditors(server, ownerConn, ['named-1']);
    const namedConn = await person(server, 'c-named', 'named-1', tokenFor(MEMBER_ACCOUNT));
    const otherConn = await person(server, 'c-other', 'other-1', tokenFor(EDITOR_ACCOUNT));

    await send(server, namedConn, ADD);
    await send(server, otherConn, HIDE);

    expect(server.scene.models).toHaveLength(1);
    expect(server.scene.models[0].visible).toBe(true);
    expect(refusals(namedConn)).toHaveLength(0);
    expect(refusals(otherConn)[0].payload).toEqual({ reason: 'role-forbidden' });
  });

  it('lets owners and editors set who may change models, and refuses a participant', async () => {
    // The approved roles table: "Change who may put up models in a meeting" is
    // yes for owner and editor, no for participant and guest.
    const server = roomWith({
      ownerId: OWNER_ACCOUNT,
      members: [{ user_id: EDITOR_ACCOUNT, role: 'editor' }],
    });
    const memberConn = await person(server, 'c-member', 'member-1', tokenFor(MEMBER_ACCOUNT));
    const editorConn = await person(server, 'c-editor', 'editor-1', tokenFor(EDITOR_ACCOUNT));
    const ownerConn = await person(server, 'c-owner', 'owner-1', tokenFor(OWNER_ACCOUNT));

    await setEditors(server, memberConn, 'everyone');
    expect(server.modelEditors).toBe('host');
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'role-forbidden-setting' });

    await setEditors(server, editorConn, 'everyone');
    expect(server.modelEditors).toBe('everyone');
    expect(refusals(editorConn)).toHaveLength(0);

    await setEditors(server, ownerConn, 'host');
    expect(server.modelEditors).toBe('host');
    expect(refusals(ownerConn)).toHaveLength(0);
  });

  it('refuses a MODEL_CHANGE from a participant too, so an old client is not a way round it', async () => {
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    await person(server, 'c-host', 'host-1', tokenFor(OWNER_ACCOUNT));
    const memberConn = await person(server, 'c-member', 'member-1', tokenFor(MEMBER_ACCOUNT));

    await server.onMessage(
      JSON.stringify({
        type: 'MODEL_CHANGE',
        payload: { modelType: 'imported', hash: HASH_A, fileName: 'bracket.step' },
      }),
      memberConn as unknown as Party.Connection,
    );

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'role-forbidden' });
  });

  it('reads the roster once for a burst of changes, not once per change', async () => {
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    const ownerConn = await person(server, 'c-owner', 'owner-1', tokenFor(OWNER_ACCOUNT));
    const memberConn = await person(server, 'c-member', 'member-1', tokenFor(MEMBER_ACCOUNT));
    const before = rosterReads(fetchMock);

    await send(server, ownerConn, ADD);
    await send(server, memberConn, HIDE);
    await send(server, ownerConn, { op: 'setVisible', id: 'bracket', visible: true });

    // Presence arrives about ten times a second and a scene change can arrive in
    // a burst. Two PostgREST round trips per message would be felt in the room,
    // which is what the sixty-second cache in party/reviewRoles.ts is for.
    expect(rosterReads(fetchMock)).toBe(before + 1);
  });

  it('refuses by role rather than guessing when the roster cannot be read', async () => {
    // Fail closed, the way the identity layer does. An unreadable roster that
    // resolved to "nobody is restricted" would make a PostgREST outage the moment
    // a review's models became editable by whoever was standing in the room.
    fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(fakeStorage(), ROLE_ENV);
    server.joinPolicy = 'open';
    const conn = fakeConn('c-owner');
    await admit(server, conn, 'owner-1', 'Owner', { accessToken: tokenFor(OWNER_ACCOUNT) });
    conn.send.mockClear();

    await send(server, conn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(refusals(conn)[0].payload).toEqual({ reason: 'role-forbidden' });
  });

  it('carries on being a room when ANON_KEY is not wired up, and says so once', async () => {
    // No key, no read, no roles: everybody resolves to a participant or a guest
    // and the scene is only changeable through the review's own setting. The log
    // line is the operator's clue, and it is once per server rather than once per
    // message because an import burst would otherwise fill the container's log.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const server = createServer(fakeStorage(), { IDENTITY_MODE: 'accounts', JWT_SECRET });
    server.joinPolicy = 'open';
    const conn = fakeConn('c-owner');
    await admit(server, conn, 'owner-1', 'Owner', { accessToken: tokenFor(OWNER_ACCOUNT) });
    conn.send.mockClear();

    await send(server, conn, ADD);
    await send(server, conn, ADD);

    expect(refusals(conn)).toHaveLength(2);
    expect(log.mock.calls.filter((call) => String(call[0]).includes('[roles]'))).toHaveLength(1);
    log.mockRestore();
  });

  it('drops a change from somebody who left the room while their role was being looked up', async () => {
    // The knock gate answered "admitted" before the lookup started, and the first
    // lookup costs two round trips. A host who sends somebody back to the waiting
    // room in that window must not have their scene change land afterwards.
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => { release = resolve; });
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('review_members')) return held;
      if (String(url).includes('review_curations')) return jsonResponse([{ owner_id: OWNER_ACCOUNT }]);
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(fakeStorage(), ROLE_ENV);
    server.joinPolicy = 'open';
    const ownerConn = await person(server, 'c-owner', 'owner-1', tokenFor(OWNER_ACCOUNT));

    const pending = send(server, ownerConn, ADD);
    server.admitted.delete('owner-1');
    release(jsonResponse([{ user_id: OWNER_ACCOUNT, role: 'owner' }]));
    await pending;

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(server.room.broadcast).not.toHaveBeenCalled();
  });

  it('never puts the admin verdict on the wire', async () => {
    // `isAdmin` is this server's business. The presence payload is relayed to
    // everybody, so a permission that reached it could be read off somebody else
    // — and claimed for themselves by the next client to send one.
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [] });
    const conn = fakeConn('c-admin');
    await admit(server, conn, 'admin-1', 'Admin', {
      accessToken: tokenFor(MEMBER_ACCOUNT, { admin: true }),
    });

    const onTheWire = [
      ...server.room.broadcast.mock.calls.map((c) => c[0] as string),
      ...conn.send.mock.calls.map((c) => c[0] as string),
      ...[...server.room.storage._data.values()].map((v) => JSON.stringify(v)),
    ].join('\n');

    expect(onTheWire).not.toContain('isAdmin');
    expect(onTheWire).not.toContain('"admin"');
    expect(server.participants.get('admin-1')).not.toHaveProperty('isAdmin');
    // And the presence it does relay is still the verified one.
    expect(server.participants.get('admin-1')?.accountId).toBe(MEMBER_ACCOUNT);
  });
});

describe('room.server — scene permissions with identity off are batch BB, unchanged', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A room on the default install: no IDENTITY_MODE, so no roles to look up. */
  function plainRoom() {
    const storage = fakeStorage();
    const server = createServer(storage, { ANON_KEY: 'test-anon-key', REST_URL: 'http://rest:3000' });
    const hostConn = fakeConn('c-host');
    admit(server, hostConn, 'host-1', 'Alice');
    const memberConn = fakeConn('c-member');
    admitViaHost(server, hostConn, memberConn, 'member-1', 'Bob');
    hostConn.send.mockClear();
    memberConn.send.mockClear();
    server.room.broadcast.mockClear();
    fetchMock.mockClear();
    return { server, storage, hostConn, memberConn };
  }

  it('asks the database nothing at all about roles', async () => {
    // ANON_KEY is set, so a server that wanted to look a role up could. It must
    // not: a default install gains no database traffic from this batch.
    const { server, memberConn } = plainRoom();

    await send(server, memberConn, ADD);

    expect(rosterReads(fetchMock)).toBe(0);
  });

  it('still refuses a non-host, with the reason a non-host has always been given', async () => {
    const { server, storage, memberConn } = plainRoom();

    await send(server, memberConn, ADD);

    expect(server.scene).toEqual({ models: [], builtIn: null });
    expect(storage._data.has('room-scene')).toBe(false);
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'host-only' });
  });

  it('still lets the host change the scene whatever the setting says', async () => {
    const { server, hostConn } = plainRoom();

    await send(server, hostConn, ADD);

    expect(server.scene.models).toHaveLength(1);
    expect(refusals(hostConn)).toHaveLength(0);
  });

  it('still takes the editor setting from the host alone', async () => {
    const { server, hostConn, memberConn } = plainRoom();

    await setEditors(server, memberConn, 'everyone');
    expect(server.modelEditors).toBe('host');
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'host-only-setting' });

    await setEditors(server, hostConn, 'everyone');
    expect(server.modelEditors).toBe('everyone');
    expect(refusals(hostConn)).toHaveLength(0);
  });

  it('is still synchronous, so a room with identity off is not slowed by a role lookup', async () => {
    // The refusal is on the wire by the time onMessage's promise settles, and no
    // fetch was awaited to get there — which is what `rosterReads` above asserts.
    const { server, memberConn } = plainRoom();

    await send(server, memberConn, ADD);

    expect(refusals(memberConn)).toHaveLength(1);
  });
});
