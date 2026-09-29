// @vitest-environment node
//
// Tests for the Reviews admin endpoints (api/admin/reviews.ts).
//
// PostgREST and GoTrue are both mocked through global fetch, routed by URL.
// loadConfig reads VIEWPOINT_CONFIG from the environment.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { hashPassword, signToken } from '../../_lib/accessControl.ts';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)
const POSTGREST_URL = 'http://rest:3000/rest/v1/';
const GOTRUE_URL = 'http://auth:9999';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeAdminJwt(sub: string, role: string = 'admin'): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      sub,
      email: 'admin@example.com',
      app_metadata: { role },
      user_metadata: { full_name: 'Admin User' },
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const ADMIN_TOKEN = makeAdminJwt('admin-1');

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  writableEnded: boolean;
  status(code: number): MockRes;
  json(data: unknown): MockRes;
  setHeader(name: string, value: string): MockRes;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    headers: {},
    writableEnded: false,
    status(code: number) { res.statusCode = code; return res; },
    json(data: unknown) { res.body = data; res.writableEnded = true; return res; },
    setHeader(name: string, value: string) { res.headers[name] = value; return res; },
  };
  return res;
}

function adminReq(overrides: {
  method?: string;
  token?: string;
  body?: unknown;
  query?: Record<string, string>;
} = {}) {
  return {
    method: overrides.method ?? 'GET',
    headers: { authorization: `Bearer ${overrides.token ?? ADMIN_TOKEN}` },
    body: overrides.body ?? undefined,
    query: overrides.query ?? {},
    cookies: {},
  } as never;
}

function passphraseReq(overrides: {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
  cookie?: string;
} = {}) {
  return {
    method: overrides.method ?? 'GET',
    headers: {},
    body: overrides.body ?? undefined,
    query: overrides.query ?? {},
    cookies: { vp_admin: overrides.cookie ?? '' },
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

const CURATION_ROWS = [
  {
    id: 'rev-1',
    title: 'Bracket Review',
    owner_id: 'user-1',
    archived: false,
    listed: true,
    updated_at: '2026-09-24T10:00:00Z',
    created_at: '2026-09-01T00:00:00Z',
  },
  {
    id: 'rev-2',
    title: 'Archived Thing',
    owner_id: null,
    archived: true,
    listed: false,
    updated_at: '2026-09-20T00:00:00Z',
    created_at: '2026-08-01T00:00:00Z',
  },
];

const GOTRUE_USERS = [
  { id: 'user-1', email: 'owner@example.com', user_metadata: { full_name: 'Owner User' } },
  { id: 'user-2', email: 'newowner@example.com', user_metadata: { full_name: 'New Owner' } },
];

/**
 * Route fetch calls to the right mock based on URL. PostgREST calls go to
 * postgrestHandler, GoTrue calls go to gotrueHandler.
 */
function routeFetch(
  postgrestHandler: (url: string, init?: RequestInit) => Promise<Response>,
  gotrueHandler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith(POSTGREST_URL)) return postgrestHandler(url, init);
    if (url.startsWith(GOTRUE_URL)) return gotrueHandler(url, init);
    return new Response('not found', { status: 404 });
  });
}

describe('GET /api/admin/reviews', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns 401 without an admin token', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq({ token: 'not-a-token' }), res as never);
    expect(res.statusCode).toBe(401);
  });

  it('lists reviews with owner, member count, revisions count, and last meeting', async () => {
    const fetchMock = routeFetch(
      // PostgREST handler
      async (url) => {
        if (url.includes('review_curations')) {
          return new Response(JSON.stringify(CURATION_ROWS), { status: 200 });
        }
        if (url.includes('review_members')) {
          return new Response(JSON.stringify([
            { review_id: 'rev-1' },
            { review_id: 'rev-1' },
            { review_id: 'rev-2' },
          ]), { status: 200 });
        }
        if (url.includes('model_revisions')) {
          return new Response(JSON.stringify([
            { review_id: 'rev-1' },
          ]), { status: 200 });
        }
        if (url.includes('tracker_sessions')) {
          return new Response(JSON.stringify([
            { review_id: 'rev-1', ended_at: '2026-09-24T09:00:00Z' },
          ]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      },
      // GoTrue handler
      async () => {
        return new Response(JSON.stringify({ users: GOTRUE_USERS }), { status: 200 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq(), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as { reviews: Array<{
      id: string;
      owner_email: string | null;
      member_count: number;
      revisions_count: number;
      last_meeting_at: string | null;
      archived: boolean;
    }> };
    expect(body.reviews).toHaveLength(1); // default filter: active
    expect(body.reviews[0].id).toBe('rev-1');
    expect(body.reviews[0].owner_email).toBe('owner@example.com');
    expect(body.reviews[0].member_count).toBe(2);
    expect(body.reviews[0].revisions_count).toBe(1);
    expect(body.reviews[0].last_meeting_at).toBe('2026-09-24T09:00:00Z');
    expect(body.reviews[0].archived).toBe(false);
  });

  it('returns archived reviews when filter=archived', async () => {
    const fetchMock = routeFetch(
      async (url) => {
        if (url.includes('review_curations')) {
          return new Response(JSON.stringify(CURATION_ROWS), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
      async () => new Response(JSON.stringify({ users: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq({ query: { filter: 'archived' } }), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as { reviews: Array<{ id: string }> };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].id).toBe('rev-2');
  });

  it('filters by title search', async () => {
    const fetchMock = routeFetch(
      async (url) => {
        if (url.includes('review_curations')) {
          return new Response(JSON.stringify(CURATION_ROWS), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
      async () => new Response(JSON.stringify({ users: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq({ query: { search: 'bracket' } }), res as never);

    const body = res.body as { reviews: Array<{ id: string }> };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].id).toBe('rev-1');
  });

  it('omits owner fields in mode none', async () => {
    const stored = hashPassword('admin-pw');
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;
    process.env.ADMIN_PASSPHRASE_HASH = stored;
    const cookie = signToken(stored, 'vp_admin');

    const fetchMock = routeFetch(
      async (url) => {
        if (url.includes('review_curations')) {
          return new Response(JSON.stringify(CURATION_ROWS), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
      async () => new Response(JSON.stringify({ users: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(passphraseReq({ cookie }), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as { reviews: Array<{
      owner_id: string | null;
      owner_name: string | null;
      owner_email: string | null;
    }> };
    expect(body.reviews[0].owner_id).toBeNull();
    expect(body.reviews[0].owner_name).toBeNull();
    expect(body.reviews[0].owner_email).toBeNull();
  });
});

describe('PATCH /api/admin/reviews — archive', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('archives a review', async () => {
    const patchCalls: Array<{ url: string; body: string }> = [];
    const fetchMock = routeFetch(
      async (url, init) => {
        if (init?.method === 'PATCH') {
          patchCalls.push({ url, body: init.body as string });
        }
        return new Response(null, { status: 204 });
      },
      async () => new Response(JSON.stringify({ users: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      query: { id: 'rev-1' },
      body: { archived: true },
    }), res as never);

    expect(res.statusCode).toBe(200);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].url).toContain('review_curations');
    const sentBody = JSON.parse(patchCalls[0].body);
    expect(sentBody.archived).toBe(true);
  });
});

describe('PATCH /api/admin/reviews — transfer owner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('transfers ownership via service-role PostgREST writes', async () => {
    const postgrestCalls: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchMock = routeFetch(
      async (url, init) => {
        const method = init?.method ?? 'GET';
        postgrestCalls.push({ url, method, body: (init?.body as string) ?? null });

        // GoTrue user list for findGoTrueUserByEmail
        if (url.includes('admin/users')) {
          return new Response(JSON.stringify({ users: GOTRUE_USERS }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      },
      async () => {
        return new Response(JSON.stringify({ users: GOTRUE_USERS }), { status: 200 });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      query: { id: 'rev-1' },
      body: { owner_email: 'newowner@example.com' },
    }), res as never);

    expect(res.statusCode).toBe(200);

    // Should have: owner_id update, member delete, member insert.
    const ownerUpdate = postgrestCalls.find(
      (c) => c.method === 'PATCH' && c.url.includes('review_curations'),
    );
    expect(ownerUpdate).toBeDefined();
    expect(JSON.parse(ownerUpdate!.body!).owner_id).toBe('user-2');

    const memberDelete = postgrestCalls.find(
      (c) => c.method === 'DELETE' && c.url.includes('review_members'),
    );
    expect(memberDelete).toBeDefined();

    const memberInsert = postgrestCalls.find(
      (c) => c.method === 'POST' && c.url.includes('review_members'),
    );
    expect(memberInsert).toBeDefined();
    const insertBody = JSON.parse(memberInsert!.body!);
    expect(insertBody.user_id).toBe('user-2');
    expect(insertBody.role).toBe('owner');
  });

  it('returns 404 when the target email does not match any account', async () => {
    const fetchMock = routeFetch(
      async () => new Response(null, { status: 204 }),
      async () => new Response(JSON.stringify({ users: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'PATCH',
      query: { id: 'rev-1' },
      body: { owner_email: 'nobody@example.com' },
    }), res as never);

    expect(res.statusCode).toBe(404);
    const body = res.body as { error: string };
    expect(body.error).toBe('account_not_found');
  });

  it('refuses transfer in mode none', async () => {
    const stored = hashPassword('admin-pw');
    process.env.VIEWPOINT_CONFIG = NONE_CONFIG;
    process.env.ADMIN_PASSPHRASE_HASH = stored;
    const cookie = signToken(stored, 'vp_admin');

    vi.stubGlobal('fetch', vi.fn());

    const { handler } = await import('../reviews.ts');
    const res = createMockRes();
    await handler(passphraseReq({
      method: 'PATCH',
      query: { id: 'rev-1' },
      body: { owner_email: 'anyone@example.com' },
      cookie,
    }), res as never);

    expect(res.statusCode).toBe(404);
  });
});
