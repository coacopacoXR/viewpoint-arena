// @vitest-environment node
//
// Deleting a design review, and deleting one of its sessions — api/reviews/delete.ts.
//
// docs/plan/15-sessions-and-variants.md batch BN. What is pinned here is what a client
// cannot be trusted with:
//
//   * WHO. Deleting is `deleteReview` in lib/reviews/roles.ts — the owner and this
//     install's administrators, and NOT the review's editors. That is narrower than the
//     `editReview` gate api/reviews/lines.ts uses, and the difference is the point of
//     one of the tests below: the person who may change a review's agenda every meeting
//     may not unmake the review.
//   * ONE CALL. Each delete is one Postgres function, so the review's meetings, cards,
//     lines and roster cannot disagree with its curation row about whether it exists.
//     What is asserted is the call that was SENT.
//   * A SESSION A VARIANT LEAVES FROM. Refused, with the variant named, and nothing
//     written while it is refused.
//
// PostgREST is mocked through global fetch and routed by URL, the way
// api/reviews/__tests__/lines.test.ts does it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)
const POSTGREST_URL = 'http://rest:3000/rest/v1/';

const OWNER = 'user-owner';
const EDITOR = 'user-editor';
const PARTICIPANT = 'user-participant';
const ADMIN = 'user-admin';

const REVIEW_ID = 'rev-1';
const MAIN_ID = 'line-main';
const VARIANT_ID = 'line-a';
const SESSION_ID = 'sess-3';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function jwtFor(sub: string, appMetadata: Record<string, unknown> = {}): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub,
      email: `${sub}@example.com`,
      user_metadata: { full_name: `Name of ${sub}` },
      app_metadata: appMetadata,
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

function req(body: Record<string, unknown>, overrides: { token?: string | null; method?: string } = {}) {
  const token = overrides.token === null ? undefined : (overrides.token ?? jwtFor(OWNER));
  return {
    method: overrides.method ?? 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    query: {},
    cookies: {},
  } as never;
}

const ACCOUNTS_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K', serverUrl: POSTGREST_URL },
  identity: { mode: 'accounts', methods: ['password'], allowGuests: false, adminUrl: 'http://auth:9999' },
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

const OWNED = {
  ownerId: OWNER,
  members: [
    { user_id: OWNER, role: 'owner' },
    { user_id: EDITOR, role: 'editor' },
    { user_id: PARTICIPANT, role: 'participant' },
  ],
};

// ─── The review as the database holds it ────────────────────────────────────

function mainLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MAIN_ID, review_id: REVIEW_ID, kind: 'main', name: 'Main line', letter: null,
    parent_session_id: null, status: 'active', created_by: null, created_by_name: '',
    created_at: '2026-03-01T09:00:00.000Z', closed_at: null, ...overrides,
  };
}

function variant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VARIANT_ID, review_id: REVIEW_ID, kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parent_session_id: SESSION_ID, status: 'active', created_by: OWNER, created_by_name: 'Robin',
    created_at: '2026-05-04T09:00:00.000Z', closed_at: null, ...overrides,
  };
}

interface World {
  /** The lines of the review, one of which may leave from the session under test. */
  lines: Array<Record<string, unknown>>;
  /** The sessions of THIS review, by id. */
  sessions: Array<Record<string, unknown>>;
  /** What the two functions answer. */
  rpcAnswer: Record<string, unknown>;
}

function world(overrides: Partial<World> = {}): World {
  return {
    lines: [mainLine()],
    sessions: [
      { id: SESSION_ID, review_id: REVIEW_ID, line_id: MAIN_ID, ended_at: '2026-05-03T16:00:00.000Z', seq: 3 },
      { id: 'sess-elsewhere', review_id: 'rev-other', line_id: null, ended_at: '2026-05-04T16:00:00.000Z', seq: 1 },
    ],
    rpcAnswer: { ok: true, items: 4, sessions: 2 },
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function stubBackend(state: World) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });

    if (!url.startsWith(POSTGREST_URL)) return new Response('not found', { status: 404 });

    if (url.includes('rpc/delete_review_session') || url.includes('rpc/delete_review')) {
      return new Response(JSON.stringify(state.rpcAnswer), { status: 200 });
    }
    if (url.includes('review_curations')) {
      return new Response(JSON.stringify([{ owner_id: OWNED.ownerId }]), { status: 200 });
    }
    if (url.includes('review_members')) {
      return new Response(JSON.stringify(OWNED.members), { status: 200 });
    }
    if (url.includes('tracker_sessions')) {
      const id = new URL(url).searchParams.get('id')?.replace('eq.', '') ?? '';
      return new Response(JSON.stringify(state.sessions.filter((s) => s['id'] === id)), { status: 200 });
    }
    if (url.includes('review_lines')) {
      const parent = new URL(url).searchParams.get('parent_session_id')?.replace('eq.', '') ?? null;
      const lines = parent === null ? state.lines : state.lines.filter((l) => l['parent_session_id'] === parent);
      return new Response(JSON.stringify(lines), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', mock);
  return { calls, mock };
}

function rpcCall(calls: RecordedCall[], name: string): RecordedCall | undefined {
  // `delete_review_session` contains `delete_review`, so the longer one is looked for
  // first and the shorter one is matched exactly.
  return calls.find((c) => c.url.includes(`rpc/${name}`) && (name !== 'delete_review' || !c.url.includes('rpc/delete_review_session')));
}

describe('api/reviews/delete', () => {
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
    const { handler } = await import('../delete.ts');
    await handler(request, res as never);
    return res;
  }

  // ─── The door ─────────────────────────────────────────────────────────────

  it('refuses a caller with no token', async () => {
    stubBackend(world());
    const res = await callHandler(
      req({ action: 'review', reviewId: REVIEW_ID }, { token: null }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(401);
  });

  it('refuses a participant and a guest, and deletes nothing while it refuses', async () => {
    const { calls } = stubBackend(world());
    for (const action of ['review', 'session'] as const) {
      const res = await callHandler(
        req({ action, reviewId: REVIEW_ID, sessionId: SESSION_ID }, { token: jwtFor(PARTICIPANT) }),
        createMockRes(),
      );
      expect(res.statusCode).toBe(403);
    }
    expect(rpcCall(calls, 'delete_review')).toBeUndefined();
    expect(rpcCall(calls, 'delete_review_session')).toBeUndefined();
  });

  it('refuses an EDITOR, who may change this review and may not unmake it', async () => {
    // The narrowest thing this endpoint decides, and the one worth a test of its own:
    // api/reviews/lines.ts lets the same editor start, adopt and drop a variant, so a
    // gate copied from there would have let them delete the review too.
    const { calls } = stubBackend(world());
    for (const action of ['review', 'session'] as const) {
      const res = await callHandler(
        req({ action, reviewId: REVIEW_ID, sessionId: SESSION_ID }, { token: jwtFor(EDITOR) }),
        createMockRes(),
      );
      expect(res.statusCode).toBe(403);
      expect((res.body as { error?: string }).error).toContain('owner');
    }
    expect(rpcCall(calls, 'delete_review')).toBeUndefined();
    expect(rpcCall(calls, 'delete_review_session')).toBeUndefined();
  });

  it('refuses somebody who is not on the review at all', async () => {
    stubBackend(world());
    const res = await callHandler(
      req({ action: 'review', reviewId: REVIEW_ID }, { token: jwtFor('user-outsider') }),
      createMockRes(),
    );
    // A signed-in person with no membership row is a participant, and a participant may not.
    expect(res.statusCode).toBe(403);
  });

  it('lets the owner delete the review, in one call to one function', async () => {
    const { calls } = stubBackend(world());
    const res = await callHandler(req({ action: 'review', reviewId: REVIEW_ID }), createMockRes());

    expect(res.statusCode).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
    const rpc = rpcCall(calls, 'delete_review');
    expect(rpc).toBeTruthy();
    expect(rpc?.body).toEqual({ p_review: REVIEW_ID });
    // One call, not one per table: a review whose curation row is gone but whose
    // meetings are not is a tracker full of cards no review can be opened on.
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.filter((c) => !String(c.url).includes('audit_events'))).toHaveLength(1);
    // And one audit row saying who deleted what (batch BY).
    const audit = posts.filter((c) => String(c.url).includes('audit_events'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].body)).toContain('review_deleted');
  });

  it('lets an administrator delete a review they do not own', async () => {
    const { calls } = stubBackend(world());
    // The roster says this person is nobody; app_metadata.role in their own token says
    // they administer the install, which lib/reviews/roles.ts reads as an owner.
    const res = await callHandler(
      req({ action: 'review', reviewId: REVIEW_ID }, { token: jwtFor(ADMIN, { role: 'admin' }) }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(rpcCall(calls, 'delete_review')?.body).toEqual({ p_review: REVIEW_ID });
  });

  it('lets the owner delete one session, in one call to one function', async () => {
    const { calls } = stubBackend(world());
    const res = await callHandler(
      req({ action: 'session', reviewId: REVIEW_ID, sessionId: SESSION_ID }),
      createMockRes(),
    );

    expect(res.statusCode).toBe(200);
    expect(rpcCall(calls, 'delete_review_session')?.body).toEqual({ p_session: SESSION_ID });
  });

  it('lets an administrator delete a session', async () => {
    const { calls } = stubBackend(world());
    const res = await callHandler(
      req({ action: 'session', reviewId: REVIEW_ID, sessionId: SESSION_ID }, { token: jwtFor(ADMIN, { role: 'admin' }) }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(rpcCall(calls, 'delete_review_session')).toBeTruthy();
  });

  it('asks for a reviewId, for an action it implements, and for the session a session delete names', async () => {
    stubBackend(world());
    expect((await callHandler(req({ action: 'review' }), createMockRes())).statusCode).toBe(400);
    expect((await callHandler(req({ action: 'empty', reviewId: REVIEW_ID }), createMockRes())).statusCode).toBe(400);
    expect((await callHandler(req({ action: 'session', reviewId: REVIEW_ID }), createMockRes())).statusCode).toBe(400);
  });

  it('answers 405 with an Allow header to a method it does not implement', async () => {
    stubBackend(world());
    const res = await callHandler(
      req({ action: 'review', reviewId: REVIEW_ID }, { method: 'GET' }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(405);
    expect(res.headers['Allow']).toBe('POST');
  });

  // ─── A session a variant leaves from ──────────────────────────────────────

  it('refuses a session a variant starts from, naming the variant, and writes nothing', async () => {
    const { calls } = stubBackend(world({ lines: [mainLine(), variant()] }));
    const res = await callHandler(
      req({ action: 'session', reviewId: REVIEW_ID, sessionId: SESSION_ID }),
      createMockRes(),
    );

    expect(res.statusCode).toBe(409);
    expect((res.body as { error?: string }).error).toBe(
      'Variant A starts from this session. Delete or drop the variant’s sessions first.',
    );
    expect(rpcCall(calls, 'delete_review_session')).toBeUndefined();
  });

  it('refuses a session of another design review rather than deleting it', async () => {
    const { calls } = stubBackend(world());
    const res = await callHandler(
      req({ action: 'session', reviewId: REVIEW_ID, sessionId: 'sess-elsewhere' }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(404);
    expect(rpcCall(calls, 'delete_review_session')).toBeUndefined();
  });

  it('refuses a session that does not exist at all', async () => {
    stubBackend(world());
    const res = await callHandler(
      req({ action: 'session', reviewId: REVIEW_ID, sessionId: 'sess-nope' }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(404);
  });

  it('passes on a refusal from the function, which is the check that cannot be raced', async () => {
    // The endpoint asks first so that it can name the variant; the function asks again
    // inside the same transaction as the delete, for a variant started in between.
    stubBackend(world({
      rpcAnswer: { ok: false, error: 'variant_starts_here', lineId: VARIANT_ID, kind: 'variant', letter: 'B', name: 'Glass-filled nylon' },
    }));
    const res = await callHandler(
      req({ action: 'session', reviewId: REVIEW_ID, sessionId: SESSION_ID }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error?: string }).error).toContain('Variant B starts from this session');
  });

  // ─── A deployment with no accounts ────────────────────────────────────────

  it('on identity.mode none lets the meeting host, whose claim is taken as it is', async () => {
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;
    const { calls } = stubBackend(world());
    const res = await callHandler(
      req({ action: 'review', reviewId: REVIEW_ID, isMeetingHost: true }, { token: null }),
      createMockRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(rpcCall(calls, 'delete_review')).toBeTruthy();
  });

  it('on identity.mode none also lets the lobby, which has no meeting to be host of', async () => {
    // The lobby's delete button is the one path with no room and therefore no host
    // claim. An install with no accounts has no signed-in callers, no roster and no
    // owner column anybody can fill, so there is nobody to ask: this is the same
    // guard the row level security policy this batch removed relied on, and until now
    // the published anon key could delete any curation row outright. What the endpoint
    // adds is that the WHOLE review goes, in one transaction, instead of one row.
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;
    stubBackend(world());
    const res = await callHandler(req({ action: 'review', reviewId: REVIEW_ID }, { token: null }), createMockRes());
    expect(res.statusCode).toBe(200);
  });

  // ─── The store ────────────────────────────────────────────────────────────

  it('answers 503, not 500, when the database cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unreachable'); }));
    const res = await callHandler(req({ action: 'review', reviewId: REVIEW_ID }), createMockRes());
    expect(res.statusCode).toBe(503);
  });

  it('answers as though a review that was already gone is gone', async () => {
    // Two screens deleting the same review at the same moment: neither should be told
    // it failed, because the outcome both wanted is the one that happened.
    stubBackend(world({ rpcAnswer: { ok: false, error: 'no_such_review' } }));
    const res = await callHandler(req({ action: 'review', reviewId: REVIEW_ID }), createMockRes());
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok?: boolean }).ok).toBe(true);
  });

  // ─── The words ────────────────────────────────────────────────────────────

  it('never answers with branch, fork, merge or commit', async () => {
    stubBackend(world({ lines: [mainLine(), variant()] }));
    const answers: unknown[] = [
      (await callHandler(req({ action: 'review', reviewId: REVIEW_ID }), createMockRes())).body,
      (await callHandler(req({ action: 'session', reviewId: REVIEW_ID, sessionId: SESSION_ID }), createMockRes())).body,
      (await callHandler(
        req({ action: 'review', reviewId: REVIEW_ID }, { token: jwtFor(PARTICIPANT) }),
        createMockRes(),
      )).body,
    ];
    const said = JSON.stringify(answers).toLowerCase();
    expect(said).not.toMatch(/branch|fork|merge|commit/);
  });
});
