// A receiver loads exactly what the reference says, and nothing it works out
// for itself.
//
// Task 03c's rule, from the receiving end. The importer decides which encoding of
// a stored file the room loads and writes it into the reference; every client
// that reads that reference — a live relay, a late joiner, a reload, a room
// restored from the server's storage — has to obey it rather than pick the one
// that looks fastest from where it is sitting.
//
// The branch is one line and it is the whole contract, so it is tested directly
// rather than by rendering a canvas and watching which URL went out.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SceneModel } from '../roomScene';

const { fetchModelFile, fetchDerivedModelFile } = vi.hoisted(() => ({
  // One line: esbuild reads a multi-line type argument as JSX in a .tsx file.
  fetchModelFile: vi.fn<(hash: string, fileName: string) => Promise<File>>(),
  fetchDerivedModelFile: vi.fn<(hash: string, fileName: string) => Promise<File>>(),
}));

vi.mock('../../modelsClient', () => ({ fetchModelFile, fetchDerivedModelFile }));

const { fetchSceneModelFile } = await import('../useSceneModelLoader');

const HASH = 'a1'.repeat(32);

function reference(overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    id: `model-${HASH}`,
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

beforeEach(() => {
  fetchModelFile.mockReset().mockResolvedValue(new File(['step'], 'bracket.step'));
  fetchDerivedModelFile.mockReset().mockResolvedValue(new File(['glb'], 'bracket.glb'));
});

describe('fetchSceneModelFile', () => {
  it('fetches the derivative for a reference that says so', async () => {
    await fetchSceneModelFile(reference({ representation: 'derived-glb' }));

    expect(fetchDerivedModelFile).toHaveBeenCalledTimes(1);
    expect(fetchDerivedModelFile).toHaveBeenCalledWith(HASH, 'bracket.step');
    // And not the source: a client that fetched both would parse whichever
    // resolved first, which is a race between two different trees.
    expect(fetchModelFile).not.toHaveBeenCalled();
  });

  it('fetches the uploaded file for a reference that says source', async () => {
    await fetchSceneModelFile(reference({ representation: 'source' }));

    expect(fetchModelFile).toHaveBeenCalledTimes(1);
    expect(fetchModelFile).toHaveBeenCalledWith(HASH, 'bracket.step');
    expect(fetchDerivedModelFile).not.toHaveBeenCalled();
  });

  it('fetches the uploaded file for a reference that says nothing', async () => {
    // Every scene persisted before a deployment could run convert-service, every
    // payload from a client that has not been updated, and every mesh upload that
    // never had anything to convert. All three have to keep meaning "the file that
    // was uploaded", which is the only encoding every reader can open.
    const model = reference();
    expect('representation' in model).toBe(false);

    await fetchSceneModelFile(model);

    expect(fetchModelFile).toHaveBeenCalledTimes(1);
    expect(fetchDerivedModelFile).not.toHaveBeenCalled();
  });

  it("passes the SOURCE name either way, because renaming is the fetcher's job", async () => {
    // The reference only ever knows the file as it was uploaded.
    // fetchDerivedModelFile is the one that turns `bracket.step` into
    // `bracket.glb` — pinned in lib/__tests__/modelsClientDerived.test.ts — and it
    // has to be: that name is what makes parseModelFile reach for the glTF reader
    // instead of OpenCascade, and what stops a Y-up derivative being tipped −90°
    // about X the way a Z-up source has to be.
    await fetchSceneModelFile(reference({ representation: 'derived-glb' }));
    await fetchSceneModelFile(reference({ representation: 'source' }));

    expect(fetchDerivedModelFile.mock.calls[0][1]).toBe('bracket.step');
    expect(fetchModelFile.mock.calls[0][1]).toBe('bracket.step');
  });
});
