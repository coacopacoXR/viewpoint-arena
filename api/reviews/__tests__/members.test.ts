// @vitest-environment node
//
// Who is on a design review, and who may change that — api/reviews/members.ts.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. What is pinned here is the
// permission table as the ENDPOINT judges it, from the caller's own verified
// token and the roster as the database holds it, because that is the one copy of
// the rule a client cannot lift with devtools:
//
//   owner   reads the roster and writes it
//   editor  READS the roster (canManage false) and may not write it
//   participant / guest   neither — a roster is account ids, names and email
//                         addresses, and they have no business with any of it
//   admin   an owner of every review, so both — but the claim is offered only
//           while a review has NO owner, and refused the moment it has one
//
// Plus the two writes that are not ordinary writes: adding somebody resolves an
// EMAIL to an account through GoTrue's admin list (an address nobody signs in
// with is a 404 that says whose job it is), and claiming an ownerless review is
// guarded in the database with `owner_id=is.null` so that two admins clicking at
// the same moment produce one owner rather than a race.
//
// And the answer that must not change: identity.mode 'none' is a 404, because
// there are no accounts there and therefore no roster to manage.
//
// PostgREST and GoTrue are both mocked through global fetch, routed by URL, as
// api/admin/__tests__/reviews.test.ts does. loadConfig reads VIEWPOINT_CONFIG.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)
const POSTGREST_URL = 'http://rest:3000/rest/v1/';
const GOTRUE_URL = 'http://auth:9999';

const OWNER = 'user-owner';
const EDITOR = 'user-editor';
const PARTICIPANT = 'user-participant';
const ADMIN = 'user-admin';
const OUTSIDER = 'user-outsider';

const REVIEW_ID = 'rev-1';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** A GoTrue-shaped access token for `sub`, optionally an admin of the install. */
function jwtFor(sub: string, options: { admin?: boolean } = {}): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub,
      email: `${sub}@example.com`,
      user_metadata: { full_name: `Name of ${sub}` },
      ...(options.admin ? { app_metadata: { role: 'admin' } } : {}),
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(data: unknown): MockRes;
  setHeader(name: string, value: string): MockRes;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.body = data; return res; },
    setHeader(name: string, value: string) { res.headers[name] = value; return res; },
  };
  return res;
}

function req(overrides: {
  method?: string;
  token?: string | null;
  body?: unknown;
  query?: Record<string, string>;
} = {}) {
  const token = overrides.token === null ? undefined : (overrides.token ?? jwtFor(OWNER));
  return {
    method: overrides.method ?? 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: overrides.body ?? undefined,
    query: overrides.query ?? (overrides.method === 'POST' ? {} : { reviewId: REVIEW_ID }),
    cookies: {},
  } as never;
}

const ACCOUNTS_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K', serverUrl: POSTGREST_URL },
  identity: { mode: 'accounts', methods: ['password'], allowGuests: false, adminUrl: GOTRUE_URL },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

const NONE_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K', serverUrl: POSTGREST_URL },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
});

const ENV_VARS = { T: 'x', U: 'x', K: 'x', JWT_SECRET };

/** Every account on this install, as GoTrue's admin list would answer it. */
const GOTRUE_USERS = [
  { id: OWNER, email: 'robin@example.com', user_metadata: { full_name: 'Robin' } },
  { id: EDITOR, email: 'maria@example.com', user_metadata: { full_name: 'Maria' } },
  { id: PARTICIPANT, email: 'wei@example.com', user_metadata: { full_name: 'Wei' } },
  { id: ADMIN, email: 'admin@example.com', user_metadata: { full_name: 'Ada' } },
];

interface Roster {
  ownerId: string | null;
  members: Array<{ user_id: string; role: string }>;
}

const OWNED: Roster = {
  ownerId: OWNER,
  members: [
    { user_id: OWNER, role: 'owner' },
    { user_id: EDITOR, role: 'editor' },
    { user_id: PARTICIPANT, role: 'participant' },
  ],
};

const OWNERLESS: Roster = { ownerId: null, members: [] };

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A fetch that answers the two roster reads out of `roster` and records every
 * call, so a write can be asserted on what it SENT rather than on a status code.
 *
 * `claimRange` is the Content-Range a claim PATCH answers with: `0-0/1` means the
 * guarded update matched a row, and a starred range means it matched none because
 * somebody else claimed the review a moment earlier.
 */
function stubBackend(roster: Roster, options: { claimRange?: string } = {}) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body: init?.body === undefined ? null : JSON.parse(String(init.body)), headers });

    if (url.startsWith(GOTRUE_URL)) {
      const filter = new URL(url).searchParams.get('filter');
      const users = filter
        ? GOTRUE_USERS.filter((u) => u.email.toLowerCase().includes(filter.toLowerCase()))
        : GOTRUE_USERS;
      return new Response(JSON.stringify({ users }), { status: 200 });
    }

    if (url.startsWith(POSTGREST_URL)) {
      if (url.includes('review_curations')) {
        if (method === 'PATCH') {
          return new Response(null, {
            status: 204,
            headers: { 'content-range': options.claimRange ?? '0-0/1' },
          });
        }
        return new Response(JSON.stringify([{ owner_id: roster.ownerId }]), { status: 200 });
      }
      if (url.includes('review_members')) {
        if (method === 'GET') {
          return new Response(JSON.stringify(roster.members), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

/** The recorded write to a table, or undefined. */
function writeTo(calls: RecordedCall[], table: string, method: string): RecordedCall | undefined {
  return calls.find((c) => c.url.includes(table) && c.method === method);
}

describe('api/reviews/members', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function callHandler(request: never, res: MockRes) {
    const { handler } = await import('../members.ts');
    await handler(request, res as never);
    return res;
  }

  // ─── The door ─────────────────────────────────────────────────────────────

  it('refuses a caller with no token', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: null }), createMockRes());
    expect(res.statusCode).toBe(401);
  });

  it('refuses a token that does not verify, whatever the roster says', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: 'not-a-jwt' }), createMockRes());
    expect(res.statusCode).toBe(401);
  });

  it('refuses a token signed with the wrong secret — the owner’s own id is not enough', async () => {
    stubBackend(OWNED);
    const forged = jwtFor(OWNER).slice(0, -4) + 'AAAA';
    const res = await callHandler(req({ token: forged }), createMockRes());
    expect(res.statusCode).toBe(401);
  });

  it('is 404 on a deployment with no accounts, because there is no roster to manage', async () => {
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;
    stubBackend(OWNED);
    const res = await callHandler(req(), createMockRes());
    expect(res.statusCode).toBe(404);
  });

  it('asks for a reviewId', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ query: {} }), createMockRes());
    expect(res.statusCode).toBe(400);
  });

  it('answers 405 with an Allow header to a method it does not implement', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ method: 'PUT', body: {} }), createMockRes());
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('GET, POST');
  });

  it('refuses an action it has never heard of', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', body: { reviewId: REVIEW_ID, action: 'promote' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(400);
  });

  // ─── Reading the roster ───────────────────────────────────────────────────

  it('gives the owner the roster with names, owner first, and the right to change it', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: jwtFor(OWNER) }), createMockRes());

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      ownerId: string | null;
      canManage: boolean;
      canClaimOwner: boolean;
      members: Array<{ userId: string; role: string; name: string; email: string }>;
    };
    expect(body.ownerId).toBe(OWNER);
    expect(body.canManage).toBe(true);
    expect(body.canClaimOwner).toBe(false);
    expect(body.members.map((m) => m.role)).toEqual(['owner', 'editor', 'participant']);
    expect(body.members[0]).toEqual({ userId: OWNER, role: 'owner', name: 'Robin', email: 'robin@example.com' });
  });

  it('lets an editor READ the roster, and says in the answer that they may not change it', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: jwtFor(EDITOR) }), createMockRes());

    expect(res.statusCode).toBe(200);
    const body = res.body as { canManage: boolean; members: unknown[] };
    // The tab renders its controls from this flag rather than re-deriving the
    // rule, so screen and endpoint cannot disagree about who is allowed.
    expect(body.canManage).toBe(false);
    expect(body.members).toHaveLength(3);
  });

  it('refuses a participant, for whom a roster is a directory of accounts they have no business with', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: jwtFor(PARTICIPANT) }), createMockRes());
    expect(res.statusCode).toBe(403);
  });

  it('refuses somebody signed in but not on the review at all', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: jwtFor(OUTSIDER) }), createMockRes());
    expect(res.statusCode).toBe(403);
  });

  it('reads the roster with the service role, never with the caller’s own token', async () => {
    const { calls } = stubBackend(OWNED);
    await callHandler(req({ token: jwtFor(OWNER) }), createMockRes());

    // review_members is read-only to the public key on purpose; the names come
    // from GoTrue's admin API, which only a service-role token reaches.
    const rosterRead = calls.find((c) => c.url.includes('review_members') && c.method === 'GET');
    expect(rosterRead?.headers['Authorization']).toMatch(/^Bearer /);
    expect(rosterRead?.headers['Authorization']).not.toContain(jwtFor(OWNER));
    expect(rosterRead?.headers['apikey']).toBeTruthy();
  });

  // ─── Adding somebody ──────────────────────────────────────────────────────

  it('lets the owner add somebody by email, resolving the address to an account', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'add', email: '  Admin@Example.com  ', role: 'editor' } }),
      createMockRes(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      member: { userId: ADMIN, role: 'editor', name: 'Ada', email: 'Admin@Example.com' },
    });
    const write = writeTo(calls, 'review_members', 'POST');
    expect(write?.body).toEqual({ review_id: REVIEW_ID, user_id: ADMIN, role: 'editor', added_by: OWNER });
    // Upsert on the (review_id, user_id) key: adding somebody already on the
    // roster re-roles them rather than failing on a duplicate.
    expect(write?.headers['Prefer']).toBe('resolution=merge-duplicates');
  });

  it('matches an email address case-insensitively, as email addresses are', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'add', email: 'MARIA@example.com', role: 'participant' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { member: { userId: string } }).member.userId).toBe(EDITOR);
  });

  it('defaults an add with no role to participant, the least it can be', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'add', email: 'admin@example.com' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(writeTo(calls, 'review_members', 'POST')?.body).toMatchObject({ role: 'participant' });
  });

  it('refuses an email nobody on this install signs in with, and says whose job it is', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'add', email: 'stranger@elsewhere.test', role: 'editor' } }),
      createMockRes(),
    );

    // Not a 400: the request was well formed, the address simply is not here.
    // Creating the account would have meant an owner could mint a login for an
    // address they do not control.
    expect(res.statusCode).toBe(404);
    expect((res.body as { error: string }).error).toContain('administrator');
    expect(writeTo(calls, 'review_members', 'POST')).toBeUndefined();
  });

  it('refuses to add an owner role, which is a transfer and not an add', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'add', email: 'admin@example.com', role: 'owner' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('refuses to add the person who already owns the review', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(ADMIN, { admin: true }), body: { reviewId: REVIEW_ID, action: 'add', email: 'robin@example.com', role: 'editor' } }),
      createMockRes(),
    );
    // An owner re-roled to editor would leave owner_id and the roster saying two
    // different things about who owns the review.
    expect(res.statusCode).toBe(409);
  });

  it('refuses an editor, who may read the list but not change it', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(EDITOR), body: { reviewId: REVIEW_ID, action: 'add', email: 'admin@example.com', role: 'participant' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(403);
    expect(writeTo(calls, 'review_members', 'POST')).toBeUndefined();
  });

  it('refuses a participant', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(PARTICIPANT), body: { reviewId: REVIEW_ID, action: 'remove', userId: EDITOR } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(403);
    expect(writeTo(calls, 'review_members', 'DELETE')).toBeUndefined();
  });

  // ─── Changing and removing ────────────────────────────────────────────────

  it('lets the owner change a role', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'setRole', userId: PARTICIPANT, role: 'editor' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, userId: PARTICIPANT, role: 'editor' });
    const patch = writeTo(calls, 'review_members', 'PATCH');
    expect(patch?.url).toContain(`review_id=eq.${REVIEW_ID}`);
    expect(patch?.url).toContain(`user_id=eq.${PARTICIPANT}`);
    expect(patch?.body).toEqual({ role: 'editor' });
  });

  it('refuses a role change to owner, which is a transfer and not a role', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'setRole', userId: PARTICIPANT, role: 'owner' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('refuses a role this code has never heard of', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'setRole', userId: PARTICIPANT, role: 'superuser' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(400);
  });

  it('lets the owner remove somebody', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'remove', userId: PARTICIPANT } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(writeTo(calls, 'review_members', 'DELETE')?.url).toContain(`user_id=eq.${PARTICIPANT}`);
  });

  it('refuses to re-role or remove the owner’s own row', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(ADMIN, { admin: true }), body: { reviewId: REVIEW_ID, action: 'remove', userId: OWNER } }),
      createMockRes(),
    );
    // Even an admin: removing it would leave an owner who is not on their own
    // review's People tab, and the column and the roster disagreeing.
    expect(res.statusCode).toBe(409);
    expect(writeTo(calls, 'review_members', 'DELETE')).toBeUndefined();
  });

  it('refuses to change somebody who is not on the review', async () => {
    stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'remove', userId: OUTSIDER } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(404);
  });

  // ─── Claiming a review nobody owns ────────────────────────────────────────

  it('offers an admin the claim on an ownerless review, and nobody else', async () => {
    stubBackend(OWNERLESS);
    const admin = await callHandler(req({ token: jwtFor(ADMIN, { admin: true }) }), createMockRes());
    expect(admin.statusCode).toBe(200);
    expect((admin.body as { canClaimOwner: boolean }).canClaimOwner).toBe(true);

    vi.resetModules();
    stubBackend(OWNERLESS);
    const ordinary = await callHandler(req({ token: jwtFor(OUTSIDER) }), createMockRes());
    // A participant cannot even read the roster of a review nobody owns.
    expect(ordinary.statusCode).toBe(403);
  });

  it('never offers the claim on a review that already has an owner', async () => {
    stubBackend(OWNED);
    const res = await callHandler(req({ token: jwtFor(ADMIN, { admin: true }) }), createMockRes());
    expect(res.statusCode).toBe(200);
    expect((res.body as { canClaimOwner: boolean }).canClaimOwner).toBe(false);
  });

  it('lets an admin claim an ownerless review, writing the column and the owner row together', async () => {
    const { calls } = stubBackend(OWNERLESS);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(ADMIN, { admin: true }), body: { reviewId: REVIEW_ID, action: 'claimOwner' } }),
      createMockRes(),
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, ownerId: ADMIN, claimed: true });
    const patch = writeTo(calls, 'review_curations', 'PATCH');
    expect(patch?.url).toContain(`id=eq.${REVIEW_ID}`);
    // The guard is in the URL: two admins clicking at the same moment produce one
    // owner, because the second PATCH matches no row.
    expect(patch?.url).toContain('owner_id=is.null');
    expect(patch?.body).toEqual({ owner_id: ADMIN });
    expect(patch?.headers['Prefer']).toContain('count=exact');
    expect(writeTo(calls, 'review_members', 'POST')?.body).toEqual({
      review_id: REVIEW_ID,
      user_id: ADMIN,
      role: 'owner',
      added_by: ADMIN,
    });
  });

  it('refuses a claim from somebody who is not an admin', async () => {
    const { calls } = stubBackend(OWNERLESS);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OUTSIDER), body: { reviewId: REVIEW_ID, action: 'claimOwner' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(403);
    expect(writeTo(calls, 'review_curations', 'PATCH')).toBeUndefined();
  });

  it('refuses a claim on a review that has an owner, even from an admin', async () => {
    const { calls } = stubBackend(OWNED);
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(ADMIN, { admin: true }), body: { reviewId: REVIEW_ID, action: 'claimOwner' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(409);
    expect(writeTo(calls, 'review_curations', 'PATCH')).toBeUndefined();
  });

  it('tells the second of two admins racing for a claim that somebody got there first', async () => {
    // The guarded PATCH matched no row, so PostgREST answers 204 with a starred
    // Content-Range. Both callers would otherwise see a success.
    stubBackend(OWNERLESS, { claimRange: '*/0' });
    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(ADMIN, { admin: true }), body: { reviewId: REVIEW_ID, action: 'claimOwner' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(409);
  });

  // ─── The database being unavailable ───────────────────────────────────────

  it('answers 503 when the roster cannot be read, which is an operator’s problem and not the caller’s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
    const res = await callHandler(req({ token: jwtFor(OWNER) }), createMockRes());
    expect(res.statusCode).toBe(503);
  });

  it('answers 502 when the database rejects a write, without pretending it landed', async () => {
    const { calls } = stubBackend(OWNED);
    // Override just the member write to fail.
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('review_members') && (init?.method ?? 'GET').toUpperCase() === 'PATCH') {
        return new Response('nope', { status: 400 });
      }
      return original(input, init);
    }));

    const res = await callHandler(
      req({ method: 'POST', token: jwtFor(OWNER), body: { reviewId: REVIEW_ID, action: 'setRole', userId: PARTICIPANT, role: 'editor' } }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(502);
    expect(calls.length).toBeGreaterThan(0);
  });
});
