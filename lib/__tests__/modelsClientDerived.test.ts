// @vitest-environment node
//
// The browser's end of the DERIVED route: the GLB convert-service tessellated
// from a stored CAD file.
//
// Two things are worth pinning and neither is the download itself, which
// modelsClient.test.ts already covers for the source file.
//
// The first is the CACHE KEY. A derivative is served under its SOURCE's hash —
// that is the whole design, because the source hash is the only identity that
// travels on the room socket — so the cache has to tell two Files apart that are
// named by the same string. Get it wrong and a client that asked for the source
// is handed GLB bytes with a `.step` name, which utils/modelLoader.ts would then
// feed to OpenCascade in a Web Worker.
//
// The second is the probe's answers. The importer's wait loop turns them into
// "broadcast derived-glb" or "tessellate it yourself", and a room where those two
// disagree about a model has two trees and one set of pins.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_DOWNLOAD_FAILED_MESSAGE,
  clearModelFileCache,
  derivedGlbFileName,
  derivedModelDownloadUrl,
  fetchDerivedModelFile,
  fetchModelFile,
  modelDownloadUrl,
  modelFileCacheSize,
  probeDerivedGlb,
} from '../modelsClient';

const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
const STEP = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33]);
const HASH = 'a1'.repeat(32);

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => impl(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const glb200 = (): Response =>
  new Response(GLB, { status: 200, headers: { 'Content-Type': 'model/gltf-binary' } });

beforeEach(() => {
  clearModelFileCache();
  // Every failure path logs, on purpose: the codes are the only thing here this
  // repo did not write and they are what an administrator has to go on.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearModelFileCache();
});

describe('derivedGlbFileName', () => {
  it('renames the source to .glb, which is what makes the loader dispatch correctly', () => {
    // Not cosmetic: parseModelFile picks its reader from the extension, and
    // upAxisFor('.step') tips the model −90° about X. A derivative that kept its
    // source's name would be fed to OpenCascade AND rotated, having come out of
    // gltfpack Y-up already.
    expect(derivedGlbFileName('bracket.step')).toBe('bracket.glb');
    expect(derivedGlbFileName('Bügel — Rev B.igs')).toBe('Bügel — Rev B.glb');
    expect(derivedGlbFileName('assembly.STEP')).toBe('assembly.glb');
  });

  it('keeps a name with no extension, and one that is only an extension', () => {
    expect(derivedGlbFileName('bracket')).toBe('bracket.glb');
    // The base-name rule modelLoader's baseNameOf uses: a leading dot is part of
    // the name, not a separator, so `.step` has nothing to strip.
    expect(derivedGlbFileName('.step')).toBe('.step.glb');
  });
});

describe('fetchDerivedModelFile', () => {
  it('asks the derived route and hands back a File the glTF loader will take', async () => {
    const fetchMock = stubFetch(() => glb200());

    const file = await fetchDerivedModelFile(HASH, 'bracket.step');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(derivedModelDownloadUrl(HASH));
    expect(derivedModelDownloadUrl(HASH)).toBe(`/api/models/${HASH}/derived/glb`);
    expect(file.name).toBe('bracket.glb');
    expect(file.type).toBe('model/gltf-binary');
    expect(file.size).toBe(GLB.byteLength);
  });

  it('waits out a 202 rather than parsing its JSON as a GLB', async () => {
    // The api keeps its jobs in memory and restarts a conversion it has lost, so
    // a late joiner can be told "pending" for a model the room already shows.
    vi.useFakeTimers();
    try {
      let asks = 0;
      const fetchMock = stubFetch(() => (++asks < 3 ? json(202, { status: 'pending' }) : glb200()));
      const received = fetchDerivedModelFile(HASH, 'bracket.step');
      await vi.advanceTimersByTimeAsync(10_000);
      const file = await received;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(file.name).toBe('bracket.glb');
      expect(file.size).toBe(GLB.byteLength);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails, rather than falling back to the source, when the conversion failed', async () => {
    stubFetch(() => json(404, { status: 'failed', reason: 'timeout' }));
    await expect(fetchDerivedModelFile(HASH, 'bracket.step')).rejects.toThrow();
  });

  it('caches it, so a second receive of the same reference is not a second download', async () => {
    const fetchMock = stubFetch(() => glb200());
    const first = await fetchDerivedModelFile(HASH, 'bracket.step');
    const second = await fetchDerivedModelFile(HASH, 'bracket.step');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not collide with the source file of the same hash', async () => {
    // Both are named by one string, and both are in the same bounded cache. A
    // collision here is the failure the whole design has to avoid: a client that
    // asked for the STEP would be handed GLB bytes under a `.step` name.
    const fetchMock = stubFetch((url) =>
      url === modelDownloadUrl(HASH)
        ? new Response(STEP, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
        : glb200(),
    );

    const source = await fetchModelFile(HASH, 'bracket.step');
    const derived = await fetchDerivedModelFile(HASH, 'bracket.step');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(source).not.toBe(derived);
    expect(source.name).toBe('bracket.step');
    expect(source.size).toBe(STEP.byteLength);
    expect(derived.name).toBe('bracket.glb');
    expect(derived.size).toBe(GLB.byteLength);
    // Two entries against the one bound: they are two sets of bytes.
    expect(modelFileCacheSize()).toBe(2);

    // And each still answers from its own entry, not the other's.
    expect(await fetchModelFile(HASH, 'bracket.step')).toBe(source);
    expect(await fetchDerivedModelFile(HASH, 'bracket.step')).toBe(derived);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses an /api path answered with HTML, the way the source download does', async () => {
    stubFetch(
      () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(fetchDerivedModelFile(HASH, 'bracket.step')).rejects.toThrow(
      MODEL_DOWNLOAD_FAILED_MESSAGE,
    );
    expect(modelFileCacheSize()).toBe(0);
  });

  it('throws on a 404 rather than handing over the error body as a model', async () => {
    // The receiver path has no fallback to make: the reference said derived-glb,
    // and tessellating the source instead would build the OTHER tree and put this
    // client out of step with everybody else in the room. Failing loudly, in the
    // model tree, is the honest answer.
    stubFetch(() => json(404, { status: 'unavailable' }));
    await expect(fetchDerivedModelFile(HASH, 'bracket.step')).rejects.toThrow(
      MODEL_DOWNLOAD_FAILED_MESSAGE,
    );
  });
});

describe('probeDerivedGlb', () => {
  it('reads a 200 as ready, and returns the GLB it came with', async () => {
    // A GET rather than a HEAD is the whole design: the poll that finds the
    // derivative ready is the one that downloads it, so there is no second
    // transfer of the same file.
    const fetchMock = stubFetch(() => glb200());

    const probe = await probeDerivedGlb(HASH, 'bracket.step');

    expect(fetchMock).toHaveBeenCalledWith(derivedModelDownloadUrl(HASH));
    expect(probe.status).toBe('ready');
    if (probe.status !== 'ready') return;
    expect(probe.file.name).toBe('bracket.glb');
    expect(probe.file.size).toBe(GLB.byteLength);
  });

  it('reads a 202 as pending, which is the answer that makes the importer poll', async () => {
    stubFetch(() => json(202, { status: 'pending' }));
    await expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({ status: 'pending' });
  });

  it('reads a failed conversion as failed, with the api\'s own code', async () => {
    // `reason` is a code from convert_service/errors.py: ours, content-free, and
    // the only thing worth a log line. Never a message from inside the file.
    stubFetch(() => json(404, { status: 'failed', reason: 'convert_unreadable' }));
    await expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({
      status: 'failed',
      reason: 'convert_unreadable',
    });
  });

  it('reads a failed conversion with no reason as failed with none', () => {
    stubFetch(() => json(404, { status: 'failed' }));
    return expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({
      status: 'failed',
      reason: null,
    });
  });

  it('reads "nothing will ever derive one" as unavailable', async () => {
    stubFetch(() => json(404, { status: 'unavailable' }));
    await expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({ status: 'unavailable' });
  });

  it('reads a source nobody stored as unavailable too', () => {
    // A different mistake from "no derivative of it", but the same instruction to
    // the importer: there is nothing to wait for, and it is holding the file.
    stubFetch(() => json(404, { error: 'not_found' }));
    return expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({ status: 'unavailable' });
  });

  it.each([
    ['the access gate', 401, { error: 'locked' }],
    ['storage being down', 503, { error: 'storage_unavailable' }],
    ['a method it does not serve', 405, { error: 'method_not_allowed' }],
  ])('reads %s as unavailable rather than as a reason to keep polling', async (_label, status, body) => {
    // Every one of these is a fact about the deployment rather than about a
    // conversion in progress, so none of them should hold an import open.
    stubFetch(() => json(status, body));
    await expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({ status: 'unavailable' });
  });

  it('never throws: a dropped network reads as unavailable', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({ status: 'unavailable' });
  });

  it('refuses a 200 that is the SPA fallback answering an /api path', async () => {
    // The same guard the download keeps. Without it the importer would parse
    // index.html as a GLB and report a corrupt model, sending whoever is
    // debugging it looking at the file instead of at the deployment.
    stubFetch(
      () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(probeDerivedGlb(HASH, 'bracket.step')).resolves.toEqual({ status: 'unavailable' });
  });
});
