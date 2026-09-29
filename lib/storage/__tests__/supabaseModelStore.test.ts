// @vitest-environment node
//
// The `supabase` provider. It will not be run against a live project in CI, so
// what these tests are really pinning is the CONTRACT: the routes and headers
// Supabase Storage expects, the two status codes that mean "no such object",
// and — above all — that the service-role key never appears anywhere a caller
// or a log reader could pick it up.

import { describe, expect, it, vi } from 'vitest';
import { SupabaseModelStore } from '../supabaseModelStore.ts';
import { sha256Hex } from '../hash.ts';

const SERVICE_ROLE_KEY = 'eyJ-role-secret-do-not-leak';
const PROJECT_URL = 'https://proj.supabase.co';
const BUCKET = 'review-models';
const OBJECT_PREFIX = `${PROJECT_URL}/storage/v1/object/${BUCKET}/`;
const LIST_URL = `${PROJECT_URL}/storage/v1/object/list/${BUCKET}`;

const BYTES = new Uint8Array([0x53, 0x54, 0x45, 0x50, 0x3b, 0x0a, 0x00, 0x01]);
const HASH = sha256Hex(BYTES);
const META = {
  fileName: 'bracket.step',
  contentType: 'model/step',
  uploadedAt: '2026-09-24T09:00:00.000Z',
};

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

/**
 * Supabase Storage as a map of objects behind its REST routes.
 *
 * A missing object answers 400 with `Object not found`, which is what the real
 * download route does and why the store treats 400 as "absent" rather than as a
 * failure. The list route answers the names it holds, paged by the `limit` and
 * `offset` the request asked for. `failEveryRequestWith` swaps in a flat status
 * for the error paths.
 */
function fakeStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const calls: Recorded[] = [];
  let failure: number | null = null;

  const fetchFn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: { ...rawHeaders },
        body: init?.body ? Buffer.from(init.body as Uint8Array) : null,
      });

      if (failure !== null) {
        return new Response(JSON.stringify({ message: 'internal' }), { status: failure });
      }

      // Matched on its URL before the upload branch below, which is a POST too.
      if (url === LIST_URL) {
        const asked = JSON.parse(String(init?.body ?? '{}')) as {
          limit?: unknown;
          offset?: unknown;
        };
        const limit = typeof asked.limit === 'number' ? asked.limit : 100;
        const offset = typeof asked.offset === 'number' ? asked.offset : 0;
        const names = [...objects.keys()].sort().slice(offset, offset + limit);
        return new Response(
          // The rest of a real row describes the SIDECAR object, which is why
          // the store reads the file's own metadata rather than trusting this.
          JSON.stringify(names.map((name) => ({ name, id: 'object-id', metadata: { size: 1 } }))),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      const path = url.slice(OBJECT_PREFIX.length);
      if ((init?.method ?? 'GET') === 'POST') {
        objects.set(path, {
          body: Buffer.from(init?.body as Uint8Array),
          contentType: rawHeaders['Content-Type'] ?? 'application/octet-stream',
        });
        return new Response(JSON.stringify({ Key: path }), { status: 200 });
      }

      if ((init?.method ?? 'GET') === 'DELETE') {
        const had = objects.has(path);
        objects.delete(path);
        if (!had) {
          return new Response(
            JSON.stringify({ statusCode: '400', error: 'Not found', message: 'Object not found' }),
            { status: 400 },
          );
        }
        return new Response(null, { status: 204 });
      }

      const found = objects.get(path);
      if (!found) {
        return new Response(
          JSON.stringify({ statusCode: '400', error: 'Not found', message: 'Object not found' }),
          { status: 400 },
        );
      }
      return new Response(found.body, {
        status: 200,
        headers: { 'Content-Type': found.contentType },
      });
    },
  );

  return {
    fetchFn,
    calls,
    objects,
    failEveryRequestWith: (status: number | null) => {
      failure = status;
    },
  };
}

function makeStore(storage = fakeStorage()) {
  return {
    storage,
    store: new SupabaseModelStore({
      url: PROJECT_URL,
      bucket: BUCKET,
      serviceRoleKey: SERVICE_ROLE_KEY,
      fetchFn: storage.fetchFn,
    }),
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('SupabaseModelStore.put', () => {
  it('uploads the sidecar and then the object, and reports the hash', async () => {
    const { storage, store } = makeStore();
    const ref = await store.put(BYTES, META);

    expect(ref).toEqual({ hash: HASH, size: BYTES.byteLength });
    expect(storage.calls.map((c) => c.url)).toEqual([
      `${OBJECT_PREFIX}${HASH}.json`,
      `${OBJECT_PREFIX}${HASH}`,
    ]);
    expect(storage.calls.map((c) => c.method)).toEqual(['POST', 'POST']);
    // Upsert: a content address cannot collide with different bytes, so the
    // second upload of a revision three people imported is one object.
    expect(storage.calls.every((c) => c.headers['x-upsert'] === 'true')).toBe(true);
    expect(storage.calls[0]?.headers['Content-Type']).toBe('application/json');
    expect(storage.calls[1]?.headers['Content-Type']).toBe('model/step');
    expect(storage.objects.get(HASH)?.body).toEqual(Buffer.from(BYTES));
    expect(JSON.parse(storage.objects.get(`${HASH}.json`)?.body.toString('utf8') ?? 'null')).toEqual(
      { ...META, size: BYTES.byteLength },
    );
  });

  it('sends the service-role key as both bearer and apikey', async () => {
    const { storage, store } = makeStore();
    await store.put(BYTES, META);
    for (const call of storage.calls) {
      expect(call.headers['Authorization']).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
      // Storage checks apikey first; a request with only the bearer is a 401.
      expect(call.headers['apikey']).toBe(SERVICE_ROLE_KEY);
    }
  });

  it('throws on a failed upload, and the message quotes a status, not the key', async () => {
    const { storage, store } = makeStore();
    storage.failEveryRequestWith(500);
    const message = await store.put(BYTES, META).then(
      () => '',
      (err: Error) => err.message,
    );
    expect(message).toMatch(/supabase storage upload failed/);
    expect(message).toContain('HTTP 500');
    expect(message).not.toContain(SERVICE_ROLE_KEY);
  });
});

describe('SupabaseModelStore.get / head', () => {
  it('round-trips the bytes as a stream, and the metadata', async () => {
    const { store } = makeStore();
    await store.put(BYTES, META);
    const stream = await store.get(HASH);
    expect(stream).not.toBeNull();
    expect(await readAll(stream!)).toEqual(Buffer.from(BYTES));
    expect(await store.head(HASH)).toEqual({ ...META, size: BYTES.byteLength });
  });

  it('answers null for an object nobody stored, on both 400 and 404', async () => {
    const { store } = makeStore();
    expect(await store.get(HASH)).toBeNull();
    expect(await store.head(HASH)).toBeNull();
  });

  it('refuses a value that is not a hash, without making a request', async () => {
    const { storage, store } = makeStore();
    for (const bad of ['../etc/passwd', HASH.toUpperCase(), HASH.slice(1), '']) {
      expect(await store.get(bad)).toBeNull();
      expect(await store.head(bad)).toBeNull();
    }
    expect(storage.fetchFn).not.toHaveBeenCalled();
  });

  it('throws on a server error rather than reporting the object absent', async () => {
    const { storage, store } = makeStore();
    await store.put(BYTES, META);
    storage.failEveryRequestWith(503);
    await expect(store.get(HASH)).rejects.toThrow(/HTTP 503/);
    await expect(store.head(HASH)).rejects.toThrow(/HTTP 503/);
  });
});

describe('SupabaseModelStore.list', () => {
  it('lists a stored file once, described by its own sidecar', async () => {
    const { store } = makeStore();
    await store.put(BYTES, META);

    // One entry per FILE, not per object: the bucket holds the bytes and the
    // sidecar beside them, and only the sidecar can say what the file is.
    expect(await store.list()).toEqual([{ hash: HASH, ...META, size: BYTES.byteLength }]);
  });

  it('lists a file nothing asked about, on the strength of being stored', async () => {
    const { storage, store } = makeStore();
    await store.put(BYTES, META);

    const listed = await store.list();

    expect(listed.map((e) => e.hash)).toEqual([HASH]);
    // Names come from the list route; the metadata from the sidecar it named.
    expect(storage.calls.map((c) => c.url)).toEqual([
      `${OBJECT_PREFIX}${HASH}.json`,
      `${OBJECT_PREFIX}${HASH}`,
      LIST_URL,
      `${OBJECT_PREFIX}${HASH}.json`,
    ]);
    const listCall = storage.calls.find((c) => c.url === LIST_URL);
    expect(listCall?.method).toBe('POST');
    expect(JSON.parse(listCall?.body?.toString('utf8') ?? '{}') as unknown).toEqual({
      limit: 1000,
      offset: 0,
    });
    expect(listCall?.headers['Authorization']).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
    expect(listCall?.headers['apikey']).toBe(SERVICE_ROLE_KEY);
  });

  it('walks every page of a bucket larger than one listing', async () => {
    const { storage, store } = makeStore();
    // Past the page size, so the walk has to ask again. An offset bug here
    // silently hides every file after the first thousand — which is the
    // "invisible, therefore undeletable" failure the listing exists to end.
    const total = 1001;
    for (let i = 0; i < total; i += 1) {
      await store.put(new Uint8Array([i & 0xff, (i >> 8) & 0xff, 7]), {
        fileName: `part-${i}.glb`,
        contentType: 'model/gltf-binary',
        uploadedAt: '2026-09-24T09:00:00.000Z',
      });
    }

    const listed = await store.list();

    expect(listed).toHaveLength(total);
    const pages = storage.calls
      .filter((c) => c.url === LIST_URL)
      .map((c) => JSON.parse(c.body?.toString('utf8') ?? '{}') as { limit: number; offset: number });
    expect(pages).toEqual([
      { limit: 1000, offset: 0 },
      { limit: 1000, offset: 1000 },
      { limit: 1000, offset: 2000 },
    ]);
    // Sorted, so the answer does not depend on the order Storage listed in.
    expect(listed.map((e) => e.hash)).toEqual([...listed.map((e) => e.hash)].sort());
  });

  it('answers [] for an empty bucket', async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
  });

  it('answers [] for a bucket that is not there, rather than throwing', async () => {
    const { storage, store } = makeStore();
    // A deployment whose bucket nobody created yet holds no model files, and
    // 404 is what this module already reads as "not here".
    storage.failEveryRequestWith(404);
    expect(await store.list()).toEqual([]);
  });

  it('throws on a server error, quoting a status and not the key', async () => {
    const { storage, store } = makeStore();
    storage.failEveryRequestWith(503);
    const message = await store.list().then(
      () => '',
      (err: Error) => err.message,
    );
    expect(message).toMatch(/supabase storage list failed/);
    expect(message).toContain('HTTP 503');
    expect(message).not.toContain(SERVICE_ROLE_KEY);
  });
});

describe('SupabaseModelStore.delete', () => {
  it('removes both the object and the sidecar, and reports true', async () => {
    const { storage, store } = makeStore();
    await store.put(BYTES, META);
    expect(await store.delete(HASH)).toBe(true);
    expect(storage.objects.has(HASH)).toBe(false);
    expect(storage.objects.has(`${HASH}.json`)).toBe(false);
    // The DELETE calls carried the service-role key as bearer and apikey.
    const deleteCalls = storage.calls.filter((c) => c.method === 'DELETE');
    expect(deleteCalls).toHaveLength(2);
    for (const call of deleteCalls) {
      expect(call.headers['Authorization']).toBe(`Bearer ${SERVICE_ROLE_KEY}`);
      expect(call.headers['apikey']).toBe(SERVICE_ROLE_KEY);
    }
  });

  it('reports false for a hash that was never stored', async () => {
    const { store } = makeStore();
    expect(await store.delete(HASH)).toBe(false);
  });

  it('refuses a non-hash value without making a request', async () => {
    const { storage, store } = makeStore();
    expect(await store.delete('../etc/passwd')).toBe(false);
    expect(storage.fetchFn).not.toHaveBeenCalled();
  });
});

describe('SupabaseModelStore — the service-role key stays server-side', () => {
  it('never appears in a URL', async () => {
    const { storage, store } = makeStore();
    await store.put(BYTES, META);
    await store.get(HASH);
    await store.head(HASH);
    await store.list();
    for (const call of storage.calls) {
      expect(call.url).not.toContain(SERVICE_ROLE_KEY);
      expect(call.url).not.toContain(encodeURIComponent(SERVICE_ROLE_KEY));
    }
  });

  it('never appears in an error message', async () => {
    const { storage, store } = makeStore();
    storage.failEveryRequestWith(403);
    const messages: string[] = [];
    for (const attempt of [
      () => store.put(BYTES, META),
      () => store.get(HASH).then((s) => s && readAll(s)),
      () => store.head(HASH),
      () => store.list(),
    ]) {
      try {
        await attempt();
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    expect(messages.length).toBe(4);
    for (const message of messages) {
      expect(message).not.toContain(SERVICE_ROLE_KEY);
      expect(message).not.toContain('internal');
    }
  });
});
