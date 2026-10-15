// @vitest-environment node
//
// The conversion job: what an upload sets going, what a status request finds, and
// the two properties that make an in-memory job table safe to have.
//
//   * DEDUP — one file uploaded twice while a conversion is running is one
//     conversion, because convert-service runs CONVERT_CONCURRENCY jobs at a time
//     (one, by default) and a duplicate would be a second full tessellation of
//     identical bytes with everybody else queued behind it.
//   * RECOVERY — a hash with no derivative and no job starts a job, which is what
//     heals an api restart mid-conversion without a queue, a table or a lock.
//
// The store is the real LocalModelStore on a temp directory and fetch is injected,
// so what is exercised is the whole path from a stored STEP file to a GLB on disk.
// Each test uses its own bytes, and therefore its own hash: the job table is
// process state, keyed by hash, and shared fixtures would let one test find
// another's job.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalModelStore } from '../../../lib/storage/localModelStore.ts';
import { sha256Hex } from '../../../lib/storage/hash.ts';
import {
  CONVERT_SERVICE_URL_ENV,
  CONVERT_SHARED_SECRET_ENV,
} from '../convertClient.ts';
import {
  derivedGlbStatus,
  isCadFile,
  startDerivedGlb,
  type DerivedStatus,
} from '../derivedJobs.ts';

const SERVICE = 'http://convert-service:8080';
const SECRET = 'convert-FAKE-shared-secret';
const ENV = {
  [CONVERT_SERVICE_URL_ENV]: SERVICE,
  [CONVERT_SHARED_SECRET_ENV]: SECRET,
} as NodeJS.ProcessEnv;

/** A stand-in for the GLB convert-service answers with. */
const GLB = Buffer.concat([
  Buffer.from('glTF', 'ascii'),
  Buffer.from([0x02, 0x00, 0x00, 0x00]),
  Buffer.alloc(16, 0x31),
]);

/** Distinct bytes per test, so distinct hashes, so distinct jobs. */
function sourceFor(label: string, extension = '.step'): { bytes: Buffer; fileName: string; hash: string } {
  const bytes = Buffer.from(`ISO-10303-21;\n${label}\n`, 'ascii');
  return { bytes, fileName: `${label}${extension}`, hash: sha256Hex(new Uint8Array(bytes)) };
}

interface FakeService {
  fetchFn: typeof fetch;
  requests: number;
  bodies: Buffer[];
  names: string[];
}

/**
 * A convert-service that answers `respond`.
 *
 * The responder is called per request and builds a fresh Response, because a body
 * can only be read once: a dedup test that reused one Response would fail on the
 * second read rather than on the second request.
 */
function fakeService(
  respond: (request: number) => Response = () =>
    new Response(new Uint8Array(GLB), {
      status: 200,
      headers: { 'Content-Type': 'model/gltf-binary', 'X-Part-Count': '9' },
    }),
): FakeService {
  const service: FakeService = { fetchFn: fetch, requests: 0, bodies: [], names: [] };
  service.fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    service.requests += 1;
    service.bodies.push(Buffer.from(init?.body as Uint8Array));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    service.names.push(String(headers['X-File-Name']));
    return respond(service.requests);
  }) as unknown as typeof fetch;
  return service;
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The subset of ConvertOptions a test needs to pin a job to its own service. */
interface JobOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

let dir: string;
let store: LocalModelStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vp-derived-'));
  store = new LocalModelStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Wait for a job to stop being pending.
 *
 * Polls the same function the route calls rather than reaching into the job
 * table: a test that awaited an internal promise would pass on a registry that
 * never told the truth about its own state.
 */
async function settled(hash: string, options: JobOptions): Promise<DerivedStatus> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await derivedGlbStatus(store, hash, options);
    if (status.status !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the conversion never settled');
}

/** Store a source file, the way POST /api/models would have. */
async function putSource(source: {
  bytes: Buffer;
  fileName: string;
  contentType?: string;
}): Promise<void> {
  await store.put(source.bytes, {
    fileName: source.fileName,
    contentType: source.contentType ?? 'model/step',
    uploadedAt: '2026-10-15T09:00:00.000Z',
  });
}

describe('startDerivedGlb', () => {
  it('converts a stored CAD file and leaves the GLB in the store', async () => {
    const source = sourceFor('bracket');
    await putSource(source);
    const service = fakeService();
    const options: JobOptions = { env: ENV, fetchFn: service.fetchFn };

    expect(startDerivedGlb(store, source.hash, source.fileName, options)).toBe('pending');
    expect(await settled(source.hash, options)).toEqual({
      status: 'ready',
      size: GLB.byteLength,
    });

    // The service was sent the file it was told to convert, under its own name,
    // and the GLB it answered with is on disk under the SOURCE's hash.
    expect(service.bodies[0]).toEqual(source.bytes);
    expect(service.names[0]).toBe(source.fileName);
    expect(await store.headDerived(source.hash, 'glb')).toEqual({ size: GLB.byteLength });
  });

  it('says unavailable, and does nothing, when CONVERT_SERVICE_URL is unset', async () => {
    // The default, and the whole of a Vercel deployment's experience: every CAD
    // import tessellates in the browser exactly as it did before convert-service
    // existed, and no request goes anywhere.
    const source = sourceFor('no-service');
    await putSource(source);
    const service = fakeService();
    const options: JobOptions = { env: {}, fetchFn: service.fetchFn };

    expect(startDerivedGlb(store, source.hash, source.fileName, options)).toBe('unavailable');
    expect(service.requests).toBe(0);
    // The stored source is what makes this 'unavailable' rather than 'not_found':
    // the file is there, and it is the deployment that cannot convert it.
    expect(await derivedGlbStatus(store, source.hash, options)).toEqual({
      status: 'unavailable',
    });
  });

  it('says unavailable for a mesh file, which has nothing to tessellate', async () => {
    const source = sourceFor('already-a-mesh', '.glb');
    const service = fakeService();

    expect(
      startDerivedGlb(store, source.hash, source.fileName, { env: ENV, fetchFn: service.fetchFn }),
    ).toBe('unavailable');
    expect(service.requests).toBe(0);
  });

  it('says unavailable for a hash that is not a content address', async () => {
    const service = fakeService();

    expect(
      startDerivedGlb(store, '../secret', 'bracket.step', { env: ENV, fetchFn: service.fetchFn }),
    ).toBe('unavailable');
    expect(service.requests).toBe(0);
  });

  it('converts one file uploaded twice while the first job is running', async () => {
    const source = sourceFor('dedup');
    const service = fakeService();
    // `bytes` is what POST /api/models passes, since it is already holding them.
    const options = { env: ENV, fetchFn: service.fetchFn, bytes: new Uint8Array(source.bytes) };

    // Both calls happen before either job can settle, so this is the dedup window a
    // room full of people opening the same revision actually produces.
    expect(startDerivedGlb(store, source.hash, source.fileName, options)).toBe('pending');
    expect(startDerivedGlb(store, source.hash, source.fileName, options)).toBe('pending');

    expect(await settled(source.hash, options)).toEqual({
      status: 'ready',
      size: GLB.byteLength,
    });
    expect(service.requests).toBe(1);
  });

  it('retries a hash whose last conversion failed, on a fresh upload', async () => {
    // A job that failed because convert-service was restarting must not stay failed
    // for the life of the process: dedup is for PENDING jobs only.
    const source = sourceFor('retry');
    await putSource(source);
    let attempt = 0;
    const service = fakeService(() => {
      attempt += 1;
      return attempt === 1
        ? errorResponse(503, 'engine_unavailable')
        : new Response(new Uint8Array(GLB), { status: 200 });
    });
    const options: JobOptions = { env: ENV, fetchFn: service.fetchFn };

    startDerivedGlb(store, source.hash, source.fileName, options);
    expect(await settled(source.hash, options)).toEqual({
      status: 'failed',
      reason: 'engine_unavailable',
    });

    expect(startDerivedGlb(store, source.hash, source.fileName, options)).toBe('pending');
    expect(await settled(source.hash, options)).toEqual({
      status: 'ready',
      size: GLB.byteLength,
    });
    expect(service.requests).toBe(2);
  });

  it('reports a conversion the service refused, with the service’s own code', async () => {
    const source = sourceFor('unreadable');
    await putSource(source);
    const service = fakeService(() => errorResponse(422, 'convert_unreadable'));
    const options: JobOptions = { env: ENV, fetchFn: service.fetchFn };

    startDerivedGlb(store, source.hash, source.fileName, options);

    // The reason is forwarded verbatim because that vocabulary is ours and carries
    // no content, and because utils/cadImport.ts already has a sentence for it.
    expect(await settled(source.hash, options)).toEqual({
      status: 'failed',
      reason: 'convert_unreadable',
    });
    expect(await store.headDerived(source.hash, 'glb')).toBeNull();
  });

  it('reports a failure to store a conversion that succeeded', async () => {
    const source = sourceFor('store-failed');
    const service = fakeService();
    // Only the three members a job touches, so the failure below is unambiguous:
    // the conversion worked and the volume could not take the result.
    const failing = {
      get: (hash: string) => store.get(hash),
      head: (hash: string) => store.head(hash),
      putDerived: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    } as unknown as LocalModelStore;

    startDerivedGlb(failing, source.hash, source.fileName, {
      env: ENV,
      fetchFn: service.fetchFn,
      bytes: new Uint8Array(source.bytes),
    });

    // A different fix from a tessellation failure, and reported as one: the disk is
    // full, not the file unreadable. The message, which names a path, stays in the
    // log.
    expect(await settled(source.hash, { env: ENV, fetchFn: service.fetchFn })).toEqual({
      status: 'failed',
      reason: 'storage_error',
    });
    expect(service.requests).toBe(1);
  });

  it('reads the source from the store when the caller is not holding it', async () => {
    // The recovery path has no bytes to pass, and must not need any.
    const source = sourceFor('from-store');
    await putSource(source);
    const service = fakeService();
    const options: JobOptions = { env: ENV, fetchFn: service.fetchFn };

    startDerivedGlb(store, source.hash, source.fileName, options);

    expect(await settled(source.hash, options)).toEqual({
      status: 'ready',
      size: GLB.byteLength,
    });
    expect(service.bodies[0]).toEqual(source.bytes);
  });

  it('fails a conversion whose source is no longer stored', async () => {
    const source = sourceFor('gone');
    const service = fakeService();
    const options: JobOptions = { env: ENV, fetchFn: service.fetchFn };

    startDerivedGlb(store, source.hash, source.fileName, options);

    expect(await settled(source.hash, options)).toEqual({
      status: 'failed',
      reason: 'source_not_found',
    });
    expect(service.requests).toBe(0);
  });
});

describe('derivedGlbStatus', () => {
  it('answers ready for a derivative the store already holds', async () => {
    const source = sourceFor('already-there');
    await store.putDerived(source.hash, 'glb', new Uint8Array(GLB));
    const service = fakeService();

    // No conversion is started for a derivative that exists, however the job table
    // looks: the store is the only authority on whether one is there.
    expect(
      await derivedGlbStatus(store, source.hash, { env: ENV, fetchFn: service.fetchFn }),
    ).toEqual({ status: 'ready', size: GLB.byteLength });
    expect(service.requests).toBe(0);
  });

  it('answers not_found for a hash nobody stored', async () => {
    const source = sourceFor('never-uploaded');
    const service = fakeService();

    // And starts nothing: without this the route would be a way to set
    // convert-service working on a hash that is not in the store.
    expect(
      await derivedGlbStatus(store, source.hash, { env: ENV, fetchFn: service.fetchFn }),
    ).toEqual({ status: 'not_found' });
    expect(service.requests).toBe(0);
  });

  it('answers not_found for a value that is not a hash', async () => {
    expect(await derivedGlbStatus(store, '../secret', { env: ENV })).toEqual({
      status: 'not_found',
    });
  });

  it('starts a conversion for a stored CAD file this process has no job for', async () => {
    // The recovery path: an api restart mid-conversion leaves the source stored, no
    // derivative and no job, and the next participant to ask is the one who sets it
    // going again.
    const source = sourceFor('recovered');
    await putSource(source);
    const service = fakeService();
    const options: JobOptions = { env: ENV, fetchFn: service.fetchFn };

    expect(await derivedGlbStatus(store, source.hash, options)).toEqual({ status: 'pending' });
    expect(await settled(source.hash, options)).toEqual({
      status: 'ready',
      size: GLB.byteLength,
    });
    // One conversion, of the bytes read back out of the store: the recovery path
    // has no upload in hand to pass along.
    expect(service.requests).toBe(1);
    expect(service.bodies[0]).toEqual(source.bytes);
  });

  it('answers unavailable for a stored mesh file, and converts nothing', async () => {
    const source = sourceFor('mesh', '.obj');
    await putSource({ ...source, contentType: 'application/octet-stream' });
    const service = fakeService();

    expect(
      await derivedGlbStatus(store, source.hash, { env: ENV, fetchFn: service.fetchFn }),
    ).toEqual({ status: 'unavailable' });
    expect(service.requests).toBe(0);
  });
});

describe('isCadFile', () => {
  it('accepts exactly the extensions convert-service reads', () => {
    for (const name of ['a.step', 'a.STP', 'a.iges', 'a.igs', 'a.brep', 'a.BRP']) {
      expect(isCadFile(name), name).toBe(true);
    }
    for (const name of ['a.glb', 'a.obj', 'a.stl', 'a.sldprt', 'a', 'a.']) {
      expect(isCadFile(name), name).toBe(false);
    }
  });
});
