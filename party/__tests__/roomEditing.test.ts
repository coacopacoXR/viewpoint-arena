// Only one person edits a design review at a time, and the room is told who.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. The Edit switch in the room's
// top bar is not a local toggle: the client ASKS (EDITING_START) and the server
// ANSWERS (EDITING_STATE to everybody, EDITING_REFUSED or EDITING_TAKEN_OVER to
// the one connection that needs it). What is pinned here is the three claims that
// only a server can make —
//
//   1. who may turn it on at all, which is lib/reviews/roles.ts's `editReview`
//      with accounts and the meeting host without them;
//   2. that a second editor is refused with the FIRST editor's name rather than
//      quietly becoming a second editor, and that taking over is an explicit
//      second act which tells the displaced person who displaced them;
//   3. that the lock does not outlive the person holding it — on Done, and on
//      disconnect, because a banner naming somebody who has left the room is one
//      nobody can clear.
//
// Plus the two things that must NOT have happened: the lock is not persisted to
// room storage (a container restart must not come back "being edited" by a
// connection that no longer exists), and a deployment with identity off makes no
// database read to answer an EDITING_START.
//
// The fakes are this file's own, as roomRoles.test.ts explains for itself: a
// harness shared between two test files is one neither can change safely.

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

/** Everything this connection was sent, parsed. */
function sent(conn: FakeConnection): Wire[] {
  return conn.send.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

/** Everything relayed to the room, parsed. `relay` goes out via room.broadcast. */
function relayed(server: Server): Wire[] {
  return server.room.broadcast.mock.calls.map((c) => JSON.parse(c[0] as string) as Wire);
}

function editingStates(source: Wire[]): Array<Record<string, unknown>> {
  return source.filter((m) => m.type === 'EDITING_STATE').map((m) => m.payload);
}

function refusals(conn: FakeConnection): Wire[] {
  return sent(conn).filter((m) => m.type === 'EDITING_REFUSED');
}

function takenOver(conn: FakeConnection): Wire[] {
  return sent(conn).filter((m) => m.type === 'EDITING_TAKEN_OVER');
}

/** One editing message, as a client would send it. */
function editing(server: Server, conn: FakeConnection, type: 'EDITING_START' | 'EDITING_STOP', payload: Record<string, unknown> = {}) {
  return server.onMessage(JSON.stringify({ type, payload }), conn as unknown as Party.Connection);
}

// ─── Identity ───────────────────────────────────────────────────────────────

const JWT_SECRET = 'a-test-secret';
const ROLE_ENV = {
  IDENTITY_MODE: 'accounts',
  JWT_SECRET,
  ANON_KEY: 'test-anon-key',
  REST_URL: 'http://rest:3000',
};
/** The default install: no IDENTITY_MODE, so no roles to look up. */
const PLAIN_ENV = { ANON_KEY: 'test-anon-key', REST_URL: 'http://rest:3000' };

const OWNER_ACCOUNT = '6f1a2b3c-0000-4000-8000-0000000000a1';
const EDITOR_ACCOUNT = '6f1a2b3c-0000-4000-8000-0000000000b2';
const MEMBER_ACCOUNT = '6f1a2b3c-0000-4000-8000-0000000000c3';

// The names the banner shows. With accounts on these come from the TOKEN, not
// from the name typed into the join form: applyVerifiedIdentity replaces a typed
// name with the account's own, so a client cannot put a colleague's name on
// everybody's banner by typing it. Every expectation below is of the verified name.
const OWNER_NAME = 'Robin';
const EDITOR_NAME = 'Maria';
const MEMBER_NAME = 'Wei';

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

function tokenFor(account: string, options: { admin?: boolean; name?: string } = {}): string {
  return accessToken({
    sub: account,
    user_metadata: { full_name: options.name ?? `Name of ${account.slice(-4)}` },
    ...(options.admin ? { app_metadata: { role: 'admin' } } : {}),
  });
}

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

/** A fetch that answers the two role reads out of `facts`, and any write with 201. */
function roleFetch(facts: Facts) {
  return vi.fn(async (url: string) => {
    if (url.includes('review_curations')) return jsonResponse([{ owner_id: facts.ownerId }]);
    if (url.includes('review_members')) return jsonResponse(facts.members);
    return new Response(null, { status: 201 });
  });
}

function rosterReads(mock: ReturnType<typeof vi.fn>): number {
  return mock.mock.calls.filter((call) => String(call[0]).includes('review_members')).length;
}

// ─── With accounts ──────────────────────────────────────────────────────────

describe('room.server — editing the review (identity on)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function roomWith(facts: Facts): Server {
    fetchMock = roleFetch(facts);
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(fakeStorage(), ROLE_ENV);
    server.joinPolicy = 'open';
    return server;
  }

  async function person(server: Server, connId: string, userId: string, name: string, token: string | null) {
    const conn = fakeConn(connId);
    await admit(server, conn, userId, name, token === null ? { guest: true } : { accessToken: token });
    conn.send.mockClear();
    server.room.broadcast.mockClear();
    return conn;
  }

  const OWNED = { ownerId: OWNER_ACCOUNT, members: [{ user_id: EDITOR_ACCOUNT, role: 'editor' }, { user_id: MEMBER_ACCOUNT, role: 'participant' }] };

  it('gives Edit to the owner and tells the whole room, sender included', async () => {
    const server = roomWith(OWNED);
    await person(server, 'c-other', 'other-1', 'Beatriz', tokenFor(MEMBER_ACCOUNT, { name: MEMBER_NAME }));
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));

    await editing(server, ownerConn, 'EDITING_START');

    expect(server.editing).toEqual({ userId: 'owner-1', name: 'Robin' });
    expect(refusals(ownerConn)).toHaveLength(0);
    // Relayed, not answered: the sender's own edit mode is something the room
    // confirmed rather than something it assumed, so it arrives the same way
    // everybody else's does.
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: 'owner-1', editorName: 'Robin' }]);
  });

  it('gives Edit to an editor on the roster', async () => {
    const server = roomWith(OWNED);
    await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    const editorConn = await person(server, 'c-editor', 'editor-1', 'Maria', tokenFor(EDITOR_ACCOUNT, { name: EDITOR_NAME }));

    await editing(server, editorConn, 'EDITING_START');

    expect(server.editing).toEqual({ userId: 'editor-1', name: 'Maria' });
    expect(refusals(editorConn)).toHaveLength(0);
  });

  it('refuses a participant, and says it is their role rather than naming an editor', async () => {
    const server = roomWith(OWNED);
    await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    const memberConn = await person(server, 'c-member', 'member-1', 'Wei', tokenFor(MEMBER_ACCOUNT, { name: MEMBER_NAME }));

    await editing(server, memberConn, 'EDITING_START');

    expect(server.editing).toBeNull();
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'role', editorName: null });
    // Nothing went to the room: a refusal is an answer to one connection, and
    // relaying it would tell everybody about a press that changed nothing.
    expect(editingStates(relayed(server))).toHaveLength(0);
  });

  it('refuses a guest, whose name on the join form is not an account', async () => {
    // The roster names the owner, and the guest TYPES the owner's name. A role
    // read off a typed name would be a permission anybody could take.
    const server = roomWith({ ownerId: OWNER_ACCOUNT, members: [{ user_id: OWNER_ACCOUNT, role: 'owner' }] });
    await person(server, 'c-owner', 'owner-1', OWNER_NAME, tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    const guestConn = await person(server, 'c-guest', 'guest-1', OWNER_NAME, null);

    await editing(server, guestConn, 'EDITING_START');

    expect(server.editing).toBeNull();
    expect(refusals(guestConn)[0].payload.reason).toBe('role');
  });

  it('refuses a second editor with the first editor’s name, and leaves the lock where it was', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');
    server.room.broadcast.mockClear();
    const editorConn = await person(server, 'c-editor', 'editor-1', 'Maria', tokenFor(EDITOR_ACCOUNT, { name: EDITOR_NAME }));

    await editing(server, editorConn, 'EDITING_START');

    expect(refusals(editorConn)[0].payload).toEqual({ reason: 'busy', editorName: 'Robin' });
    expect(server.editing).toEqual({ userId: 'owner-1', name: 'Robin' });
    expect(editingStates(relayed(server))).toHaveLength(0);
  });

  it('hands Edit over on a forced second press, and tells the person being displaced by name', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');
    ownerConn.send.mockClear();
    server.room.broadcast.mockClear();
    const editorConn = await person(server, 'c-editor', 'editor-1', 'Maria', tokenFor(EDITOR_ACCOUNT, { name: EDITOR_NAME }));

    await editing(server, editorConn, 'EDITING_START', { force: true });

    expect(server.editing).toEqual({ userId: 'editor-1', name: 'Maria' });
    // To the displaced person alone — the room hears about the change through the
    // EDITING_STATE that follows, which already carries the new editor's name.
    expect(takenOver(ownerConn).map((m) => m.payload)).toEqual([{ byName: 'Maria' }]);
    expect(takenOver(editorConn)).toHaveLength(0);
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: 'editor-1', editorName: 'Maria' }]);
  });

  it('takes the name from the verified account, never from the message or the join form', async () => {
    const server = roomWith(OWNED);
    // Admitted under a typed name that is not theirs, asking with a payload that
    // names somebody else again. Both are ignored: the banner carries the
    // account's own name, the only one this server has vouched for.
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Beatriz', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));

    await editing(server, ownerConn, 'EDITING_START', { force: true, editorName: 'Beatriz', name: 'Beatriz' });

    expect(server.editing).toEqual({ userId: 'owner-1', name: OWNER_NAME });
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: 'owner-1', editorName: OWNER_NAME }]);
  });

  it('releases the lock on Done, and tells the room including whoever held it', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');
    server.room.broadcast.mockClear();

    await editing(server, ownerConn, 'EDITING_STOP');

    expect(server.editing).toBeNull();
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: null, editorName: null }]);
  });

  it('ignores a Done from somebody who is not editing, so a stray message cannot end a colleague’s session', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');
    server.room.broadcast.mockClear();
    const editorConn = await person(server, 'c-editor', 'editor-1', 'Maria', tokenFor(EDITOR_ACCOUNT, { name: EDITOR_NAME }));

    await editing(server, editorConn, 'EDITING_STOP');

    expect(server.editing).toEqual({ userId: 'owner-1', name: 'Robin' });
    expect(editingStates(relayed(server))).toHaveLength(0);
    expect(sent(editorConn).filter((m) => m.type === 'EDITING_REFUSED')).toHaveLength(0);
    // …but the sender is told who does hold it, so a browser that wrongly thought it
    // was editing corrects itself instead of pressing a Done that does nothing.
    expect(sent(editorConn).filter((m) => m.type === 'EDITING_STATE').map((m) => m.payload))
      .toEqual([{ editorUserId: 'owner-1', editorName: 'Robin' }]);
  });

  it('answers a Done in a room nobody is editing with "nobody", to that connection only', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    server.room.broadcast.mockClear();

    await editing(server, ownerConn, 'EDITING_STOP');

    expect(editingStates(relayed(server))).toHaveLength(0);
    expect(sent(ownerConn).filter((m) => m.type === 'EDITING_STATE').map((m) => m.payload))
      .toEqual([{ editorUserId: null, editorName: null }]);
  });

  it('releases the lock when the person holding it leaves the room', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');
    server.room.broadcast.mockClear();

    server.onClose(ownerConn as unknown as Party.Connection);

    expect(server.editing).toBeNull();
    // Told at once: without this the banner outlives Robin for as long as the room
    // stays awake, and the next press of Edit is refused in the name of somebody
    // who has gone.
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: null, editorName: null }]);
  });

  it('leaves the lock alone when somebody else leaves', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');
    const otherConn = await person(server, 'c-member', 'member-1', 'Wei', tokenFor(MEMBER_ACCOUNT, { name: MEMBER_NAME }));
    server.room.broadcast.mockClear();

    server.onClose(otherConn as unknown as Party.Connection);

    expect(server.editing).toEqual({ userId: 'owner-1', name: 'Robin' });
    expect(editingStates(relayed(server))).toHaveLength(0);
  });

  it('tells a late joiner who is editing, so they do not see the review change with nobody named', async () => {
    const server = roomWith(OWNED);
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));
    await editing(server, ownerConn, 'EDITING_START');

    const lateConn = fakeConn('c-late');
    await admit(server, lateConn, 'late-1', 'Ines', { accessToken: tokenFor(MEMBER_ACCOUNT, { name: MEMBER_NAME }) });

    expect(editingStates(sent(lateConn))).toEqual([{ editorUserId: 'owner-1', editorName: 'Robin' }]);
  });

  it('sends a late joiner nothing at all when nobody is editing', async () => {
    const server = roomWith(OWNED);
    await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));

    const lateConn = fakeConn('c-late');
    await admit(server, lateConn, 'late-1', 'Ines', { accessToken: tokenFor(MEMBER_ACCOUNT, { name: MEMBER_NAME }) });

    // The common case: an arrival who hears no EDITING_STATE is in a room nobody
    // is editing, which is the state a client starts in anyway.
    expect(editingStates(sent(lateConn))).toHaveLength(0);
  });

  it('does not persist the lock, because a restart drops the editor’s socket too', async () => {
    const storage = fakeStorage();
    fetchMock = roleFetch(OWNED);
    vi.stubGlobal('fetch', fetchMock);
    const server = createServer(storage, ROLE_ENV);
    server.joinPolicy = 'open';
    const ownerConn = await person(server, 'c-owner', 'owner-1', 'Robin', tokenFor(OWNER_ACCOUNT, { name: OWNER_NAME }));

    await editing(server, ownerConn, 'EDITING_START');

    expect(server.editing).not.toBeNull();
    expect([...storage._data.keys()].some((key) => key.includes('edit'))).toBe(false);
  });
});

// ─── Without accounts: the meeting host, exactly as before ──────────────────

describe('room.server — editing the review with identity off', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function plainRoom() {
    const storage = fakeStorage();
    const server = createServer(storage, PLAIN_ENV);
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

  it('lets the meeting host turn Edit on — which is what the old curate page allowed anybody to do', async () => {
    const { server, hostConn } = plainRoom();

    await editing(server, hostConn, 'EDITING_START');

    expect(server.editing).toEqual({ userId: 'host-1', name: 'Alice' });
    expect(refusals(hostConn)).toHaveLength(0);
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: 'host-1', editorName: 'Alice' }]);
  });

  it('refuses everybody else, with the reason being their role and not a busy colleague', async () => {
    const { server, memberConn } = plainRoom();

    await editing(server, memberConn, 'EDITING_START');

    expect(server.editing).toBeNull();
    expect(refusals(memberConn)[0].payload).toEqual({ reason: 'role', editorName: null });
  });

  it('asks the database nothing at all about roles to decide', async () => {
    // ANON_KEY and REST_URL are set, so a server that wanted to look a role up
    // could. A default install gains no database traffic from this batch.
    const { server, hostConn } = plainRoom();

    await editing(server, hostConn, 'EDITING_START');

    expect(rosterReads(fetchMock)).toBe(0);
  });

  it('still keeps the lock to one person, host or not', async () => {
    const { server, hostConn, memberConn } = plainRoom();
    await editing(server, hostConn, 'EDITING_START');
    server.room.broadcast.mockClear();

    await editing(server, memberConn, 'EDITING_START', { force: true });

    // force cannot buy a lock the role was refused for: the role check runs first.
    expect(server.editing).toEqual({ userId: 'host-1', name: 'Alice' });
    expect(refusals(memberConn)[0].payload.reason).toBe('role');
    expect(editingStates(relayed(server))).toHaveLength(0);
  });

  it('releases the lock when the host leaves, as it does with accounts', async () => {
    const { server, hostConn } = plainRoom();
    await editing(server, hostConn, 'EDITING_START');
    server.room.broadcast.mockClear();

    server.onClose(hostConn as unknown as Party.Connection);

    expect(server.editing).toBeNull();
    expect(editingStates(relayed(server))).toEqual([{ editorUserId: null, editorName: null }]);
  });
});
