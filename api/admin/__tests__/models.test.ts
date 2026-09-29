// @vitest-environment node
//
// Tests for the Models admin endpoints (api/admin/models.ts).
//
// PostgREST is mocked through global fetch. The model store is mocked via
// vi.mock on api/_lib/models.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const JWT_SECRET = 'test-jwt-secret-long-enough-for-hs256'; // gitleaks:allow (fake test value)
const POSTGREST_URL = 'http://rest:3000/rest/v1/';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
// Imported in a plain session: no revision row and no curation asset names it,
// so storage is the only place that knows it exists.
const HASH_C = 'c'.repeat(64);

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

const ACCOUNTS_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
  db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K', serverUrl: POSTGREST_URL },
  identity: { mode: 'accounts', methods: ['password'], allowGuests: false, adminUrl: 'http://auth:9999' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
  modelStorage: { provider: 'local', dir: '/tmp/test-models' },
});

const ENV_VARS = { T: 'x', U: 'x', K: 'x', JWT_SECRET };

const REVISION_ROWS = [
  {
    id: 'rev-row-1',
    review_id: 'review-1',
    line: 'bracket',
    revision: 'Rev A',
    hash: HASH_A,
    file_name: 'bracket.glb',
    size: 1024,
    uploaded_by: 'user-1',
    uploaded_by_name: 'Alice',
    created_at: '2026-09-24T09:00:00Z',
  },
  {
    id: 'rev-row-2',
    review_id: 'review-1',
    line: 'bracket',
    revision: 'Rev B',
    hash: HASH_B,
    file_name: 'bracket-v2.glb',
    size: 2048,
    uploaded_by: 'user-1',
    uploaded_by_name: 'Alice',
    created_at: '2026-09-24T10:00:00Z',
  },
];

const CURATION_ROWS = [
  {
    id: 'review-1',
    title: 'Bracket Review',
    asset: { modelHash: HASH_B },
  },
];

/**
 * What storage holds, as `store.list()` answers it.
 *
 * Two of the three are referenced — HASH_A by a revision row, HASH_B by both a
 * revision row and a curation asset — and HASH_C by nothing at all. It is the
 * third one this listing exists for.
 */
const STORED_FILES = [
  {
    hash: HASH_A,
    fileName: 'bracket.glb',
    size: 1024,
    contentType: 'model/gltf-binary',
    uploadedAt: '2026-09-24T09:00:00Z',
  },
  {
    hash: HASH_B,
    fileName: 'bracket-v2.glb',
    size: 2048,
    contentType: 'model/gltf-binary',
    uploadedAt: '2026-09-24T10:00:00Z',
  },
  {
    hash: HASH_C,
    fileName: 'loose-import.step',
    size: 4096,
    contentType: 'model/step',
    uploadedAt: '2026-09-24T11:00:00Z',
  },
];

const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock('../../_lib/models.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/models.ts')>();
  return {
    ...actual,
    resolveModelStore: vi.fn(async () => ({
      delete: mockDelete,
      list: mockList,
    })),
  };
});

describe('GET /api/admin/models', () => {
  const originalEnv = process.env;

  interface ListBody {
    models: Array<{
      hash: string;
      file_name: string;
      size: number;
      content_type: string;
      uploaded_at: string;
      uploaded_by_name: string;
      referenced: boolean;
      revisions: Array<{ id: string; review_title: string }>;
      curation_refs: Array<{ review_id: string }>;
    }>;
    total_storage: number;
  }

  /** PostgREST answering the two reads the list makes. */
  function stubDatabase(revisions: unknown = REVISION_ROWS, curations: unknown = CURATION_ROWS) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('model_revisions')) {
          return new Response(JSON.stringify(revisions), { status: 200 });
        }
        if (url.includes('review_curations')) {
          return new Response(JSON.stringify(curations), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }),
    );
  }

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
    mockDelete.mockReset();
    mockList.mockReset();
    // The listing describes every file the store holds, which is where the
    // handler now reads names and sizes from instead of asking per hash.
    mockList.mockResolvedValue(STORED_FILES);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns 401 without an admin token', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({ token: 'bad' }) as never, res as never);
    expect(res.statusCode).toBe(401);
  });

  it('lists every stored file, with its references and the total storage', async () => {
    stubDatabase();

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq(), res as never);

    expect(res.statusCode).toBe(200);
    const body = res.body as ListBody;
    expect(body.models).toHaveLength(3);
    expect(body.total_storage).toBe(7168);

    const entryB = body.models.find((m) => m.hash === HASH_B);
    expect(entryB).toBeDefined();
    expect(entryB!.referenced).toBe(true);
    expect(entryB!.revisions).toHaveLength(1);
    expect(entryB!.revisions[0].review_title).toBe('Bracket Review');
    expect(entryB!.curation_refs).toHaveLength(1);
    expect(entryB!.curation_refs[0].review_id).toBe('review-1');
  });

  it('lists a file no design review references, marked so the console can say so', async () => {
    stubDatabase();

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq(), res as never);

    const body = res.body as ListBody;
    const loose = body.models.find((m) => m.hash === HASH_C);
    expect(loose).toBeDefined();
    expect(loose!.referenced).toBe(false);
    expect(loose!.revisions).toEqual([]);
    expect(loose!.curation_refs).toEqual([]);
    // Nothing in the database ever named this file, so every field comes from
    // storage — including the size that makes it into the total.
    expect(loose!.file_name).toBe('loose-import.step');
    expect(loose!.size).toBe(4096);
    expect(loose!.content_type).toBe('model/step');
    expect(loose!.uploaded_at).toBe('2026-09-24T11:00:00Z');
    expect(loose!.uploaded_by_name).toBe('');
  });

  it('marks a file only a curation asset points at as referenced', async () => {
    // No revision row survives — the review kept the model but its revisions
    // were deleted — and the 409 guard would still refuse the file.
    stubDatabase([], [{ id: 'review-1', title: 'Bracket Review', asset: { modelHash: HASH_A } }]);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq(), res as never);

    const body = res.body as ListBody;
    const entryA = body.models.find((m) => m.hash === HASH_A);
    expect(entryA!.referenced).toBe(true);
    expect(entryA!.revisions).toEqual([]);
    expect(entryA!.curation_refs).toEqual([{ review_id: 'review-1', review_title: 'Bracket Review' }]);
  });

  it('falls back to the referenced files when storage cannot be listed', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockList.mockRejectedValue(
      new Error('supabase storage list failed for review-models: HTTP 500'),
    );
    stubDatabase();

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq(), res as never);

    expect(errorLog).toHaveBeenCalledWith(
      '[admin/models] store listing failed:',
      expect.any(Error),
    );
    errorLog.mockRestore();

    // Degraded, not broken: the files the database knows about are still
    // listed, described by their revision rows rather than by storage.
    expect(res.statusCode).toBe(200);
    const body = res.body as ListBody;
    expect(body.models.map((m) => m.hash).sort()).toEqual([HASH_A, HASH_B]);
    expect(body.models.every((m) => m.referenced)).toBe(true);
    const entryA = body.models.find((m) => m.hash === HASH_A);
    expect(entryA!.file_name).toBe('bracket.glb');
    expect(entryA!.size).toBe(1024);
    expect(entryA!.content_type).toBe('');
    expect(body.total_storage).toBe(3072);
  });
});

describe('DELETE /api/admin/models — revision', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
    mockDelete.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('deletes a revision row via service-role PostgREST', async () => {
    const deleteCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (init?.method === 'DELETE' && url.includes('model_revisions')) {
        deleteCalls.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'revision', id: 'rev-row-1' },
    }), res as never);

    expect(res.statusCode).toBe(200);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toContain('model_revisions');
    expect(deleteCalls[0]).toContain('rev-row-1');
  });
});

describe('DELETE /api/admin/models — file', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, VIEWPOINT_CONFIG: ACCOUNTS_CONFIG, ...ENV_VARS };
    mockDelete.mockReset();
    mockDelete.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('refuses to delete a file still referenced by a revision', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('model_revisions')) {
        // One revision still references this hash.
        return new Response(JSON.stringify([{ id: 'rev-row-1' }]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'file', hash: HASH_A },
    }), res as never);

    expect(res.statusCode).toBe(409);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('refuses to delete a file still referenced by a curation asset', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('model_revisions')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('review_curations')) {
        return new Response(JSON.stringify([{ id: 'review-1', title: 'X', asset: { modelHash: HASH_A } }]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'file', hash: HASH_A },
    }), res as never);

    expect(res.statusCode).toBe(409);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced file from the store', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('model_revisions')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('review_curations')) {
        return new Response(JSON.stringify([{ id: 'review-1', title: 'X', asset: { modelHash: HASH_B } }]), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'file', hash: HASH_A },
    }), res as never);

    expect(res.statusCode).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith(HASH_A);
    const body = res.body as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
  });

  it('deletes a file only storage knows about', async () => {
    // The case the listing exists for: imported in a plain session, so no
    // revision row and no curation asset ever named it. There is nothing to
    // unreference first, so the guard has to let it through — a 409 here would
    // make the file the console can now see impossible to remove. The database
    // is not empty: it simply has nothing pointing at this hash.
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('model_revisions')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('review_curations')) {
        return new Response(JSON.stringify(CURATION_ROWS), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'file', hash: HASH_C },
    }), res as never);

    expect(res.statusCode).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith(HASH_C);
  });

  it('still refuses a listed file a design review references', async () => {
    // The same database state as the listing tests: HASH_B is in storage AND is
    // the review's current model. Being listed must not weaken the guard.
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('model_revisions')) {
        return new Response(JSON.stringify(REVISION_ROWS), { status: 200 });
      }
      if (url.includes('review_curations')) {
        return new Response(JSON.stringify(CURATION_ROWS), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'file', hash: HASH_B },
    }), res as never);

    expect(res.statusCode).toBe(409);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('rejects an invalid hash', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const { handler } = await import('../models.ts');
    const res = createMockRes();
    await handler(adminReq({
      method: 'DELETE',
      query: { type: 'file', hash: 'not-a-hash' },
    }), res as never);

    expect(res.statusCode).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
