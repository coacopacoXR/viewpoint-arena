// The importer's half of task 03c: which representation a room is told to load.
//
// The rule is that everybody in a room loads the SAME encoding of a model, and
// that the importer decides it once and broadcasts it. So what is pinned here is
// the decision and the four routes through it — the server converted it, the
// server could not, there was never going to be one, and the person importing
// chose not to wait — plus the one field on the wire that carries the answer.
//
// It matters more than a performance choice: `buildSceneTree` numbers nodes
// positionally, so the derivative's tree and the browser's are two different sets
// of ids for the same flange, and a pin names an id. A client that guessed would
// render the right product and disagree with everybody else about which mesh is
// which.
//
// The upload, the parse and the wait are faked; the scene writes, the placement
// and the status strips are real, as in sceneTreeImportHandoff.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import { Group as ThreeGroup, Vector3 as ThreeVector3 } from 'three';
import type { ModelImportResult } from '../../../utils/modelLoader';
import type { SceneModel, SceneUpdate } from '../../../lib/scene/roomScene';
import type { DerivedImportOutcome, DerivedImportOptions } from '../../../lib/scene/derivedImport';

interface StoredModelFile {
  fileName: string;
  hash: string;
  size: number;
  derived?: 'pending' | 'unavailable';
}

const { broadcastSceneUpdate, uploadModelFile, parseModelFile, waitForDerivedGlb } = vi.hoisted(() => ({
  broadcastSceneUpdate: vi.fn((_update: SceneUpdate) => true),
  // One line each: esbuild reads a multi-line type argument in a .tsx file as JSX.
  uploadModelFile: vi.fn<(file: File, onProgress?: (fraction: number) => void) => Promise<StoredModelFile>>(),
  parseModelFile: vi.fn<(file: File) => Promise<ModelImportResult>>(),
  waitForDerivedGlb: vi.fn<(hash: string, fileName: string, options?: DerivedImportOptions) => Promise<DerivedImportOutcome>>(),
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    remoteParticipantList: [],
    broadcastSceneUpdate,
    broadcastSetModelEditors: () => true,
  }),
}));

vi.mock('../../../lib/modelsClient', () => ({
  uploadModelFile,
  MODEL_UPLOAD_NETWORK_MESSAGE: 'The model could not be shared.',
}));

vi.mock('../../../lib/scene/derivedImport', () => ({ waitForDerivedGlb }));

vi.mock('../../../utils/modelLoader', () => ({
  validateModelFile: () => null,
  // What the advisory returns for which size is pinned in
  // utils/__tests__/modelFormats.test.ts; only the WHEN is at issue here.
  largeCadWarningFor: (file: File) =>
    file.name.endsWith('.step') ? 'This STEP file is large (150 MB).' : null,
  parseModelFile,
}));

const { default: SceneTree } = await import('../SceneTree');
const { handSceneImportFile } = await import('../../../lib/scene/importHandoff');
const { useStore } = await import('../../../store');

const HASH = 'aa'.repeat(32);
const MODEL_ID = `model-${HASH}`;
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);

/** The GLB the server made, which is what the importer parses on that path. */
function derivedFile(): File {
  return new File([GLB_BYTES], 'bracket.glb', { type: 'model/gltf-binary' });
}

function stepFile(name = 'bracket.step'): File {
  return new File(['ISO-10303-21;'], name, { type: 'model/step' });
}

function parsedOf(file: File): ModelImportResult {
  return {
    root: new ThreeGroup(),
    sceneTree: {
      id: 'prefix_0',
      name: file.name,
      type: 'GROUP',
      children: [{ id: 'prefix_1', name: 'Flange', type: 'MESH' }],
    },
    fileName: file.name,
    baseScale: 1,
    basePosition: new ThreeVector3(),
    size: { x: 2, y: 2, z: 2 },
  };
}

function renderTree(models: SceneModel[] = []) {
  useStore.setState({
    sceneEntries: {},
    expandedSceneModels: {},
    modelEditors: 'everyone',
    sessionHostId: 'me',
    activeSceneModelId: null,
    compare: null,
    sceneRefusal: null,
    isImporting: false,
    importError: null,
    importSuccess: null,
  });
  useStore.getState().setRoomScene({ models, builtIn: null }, { fresh: true });
  return render(<SceneTree />);
}

/** One file, all the way through the pipeline. */
async function hand(file: File): Promise<void> {
  await act(async () => {
    expect(handSceneImportFile(file)).toBe(true);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** The model the tree told the room to load. */
function addedModel(): SceneModel | undefined {
  const add = broadcastSceneUpdate.mock.calls.map((call) => call[0]).find((u) => u.op === 'add');
  return add?.op === 'add' ? add.model : undefined;
}

/**
 * Hold the wait open, the way a real conversion does, and keep the handle that
 * ends it. The abort listener is wired because that is the contract the panel
 * relies on: the button aborts, the waiter notices and answers 'cancelled'.
 */
function holdTheWait(): { settle: (outcome: DerivedImportOutcome) => void; options: () => DerivedImportOptions | undefined } {
  let settle!: (outcome: DerivedImportOutcome) => void;
  let captured: DerivedImportOptions | undefined;
  waitForDerivedGlb.mockImplementationOnce(
    (_hash, _fileName, options) =>
      new Promise<DerivedImportOutcome>((resolve) => {
        captured = options;
        settle = resolve;
        options?.signal?.addEventListener('abort', () =>
          resolve({ status: 'fallback', reason: 'cancelled', detail: null }),
        );
      }),
  );
  return { settle: (outcome) => settle(outcome), options: () => captured };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  broadcastSceneUpdate.mockClear();
  parseModelFile.mockReset().mockImplementation(async (file: File) => parsedOf(file));
  waitForDerivedGlb.mockReset().mockResolvedValue({ status: 'fallback', reason: 'unavailable', detail: null });
  uploadModelFile.mockReset().mockImplementation(async (file: File) => ({
    fileName: file.name,
    hash: HASH,
    size: file.size,
    derived: 'unavailable',
  }));
});

afterEach(cleanup);

describe('a CAD file the server is converting', () => {
  beforeEach(() => {
    uploadModelFile.mockImplementation(async (file: File) => ({
      fileName: file.name,
      hash: HASH,
      size: file.size,
      derived: 'pending',
    }));
  });

  it('waits, parses the GLB, and tells the room to load the derivative', async () => {
    const glb = derivedFile();
    waitForDerivedGlb.mockResolvedValue({ status: 'derived', file: glb });
    renderTree();

    await hand(stepFile());

    expect(waitForDerivedGlb).toHaveBeenCalledTimes(1);
    expect(waitForDerivedGlb.mock.calls[0][0]).toBe(HASH);
    expect(waitForDerivedGlb.mock.calls[0][1]).toBe('bracket.step');
    // The GLB is what was parsed, not the STEP: this is the tree the reference is
    // about to promise everybody else.
    expect(parseModelFile.mock.calls[0][0]).toBe(glb);

    const model = addedModel();
    expect(model?.representation).toBe('derived-glb');
    // The line and the revision row still name the file the person picked — the
    // derivative has no name of its own, and `.glb` is not what they called it.
    expect(model?.fileName).toBe('bracket.step');
    expect(model?.line).toBe('bracket');
    expect(model?.revision).toBe('A');
    expect(useStore.getState().sceneEntries[MODEL_ID]).toBeTruthy();
  });

  it('shows the wait on screen with a clock on it, and the way out of it', async () => {
    const wait = holdTheWait();
    renderTree();

    await act(async () => {
      void handSceneImportFile(stepFile());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    // Driven from the waiter's own tick rather than by letting a second pass: the
    // clock belongs to the wait, and this is what it reports.
    act(() => wait.options()?.onElapsed?.(42_000));

    expect(screen.getByText(/Preparing the model on the server…\s*0:42/)).toBeTruthy();
    expect(screen.getByText('Open in browser instead')).toBeTruthy();

    await act(async () => {
      wait.settle({ status: 'derived', file: derivedFile() });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    // The strip is the wait, so it goes when the wait does.
    expect(screen.queryByText(/Preparing the model on the server/)).toBeNull();
  });

  it('does not warn about a slow browser import while the server is doing it', async () => {
    const wait = holdTheWait();
    renderTree();

    await act(async () => {
      void handSceneImportFile(stepFile());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // What the advisory describes is minutes of tessellation in a Web Worker that
    // may not finish. This import is not doing that, so showing it would be a
    // warning about work nobody is going to do.
    expect(screen.queryByText(/This STEP file is large/)).toBeNull();

    await act(async () => {
      wait.settle({ status: 'derived', file: derivedFile() });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(screen.queryByText(/This STEP file is large/)).toBeNull();
    expect(addedModel()?.representation).toBe('derived-glb');
  });

  it('falls back to the browser when the conversion failed, and says the advisory then', async () => {
    const wait = holdTheWait();
    const source = stepFile();
    // Held open so the advisory can be read: what it describes is the browser
    // tessellation that is about to happen, so that is when it has to be up.
    let finishParse!: () => void;
    parseModelFile.mockImplementationOnce(
      (file: File) => new Promise<ModelImportResult>((resolve) => {
        finishParse = () => resolve(parsedOf(file));
      }),
    );
    renderTree();

    await act(async () => {
      void handSceneImportFile(source);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(screen.queryByText(/This STEP file is large/)).toBeNull();

    await act(async () => {
      wait.settle({ status: 'fallback', reason: 'failed', detail: 'convert_unreadable' });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // The SOURCE file is what got parsed, because there is nothing else to parse.
    expect(parseModelFile.mock.calls[0][0]).toBe(source);
    expect(screen.getByText(/This STEP file is large/)).toBeTruthy();

    await act(async () => {
      finishParse();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // Absent, not 'source': the default is what every reference an older build
    // wrote means, and writing it out would change every persisted scene.
    const model = addedModel();
    expect(model).toBeTruthy();
    expect('representation' in model!).toBe(false);
    expect(useStore.getState().scene.models).toHaveLength(1);
    expect(screen.queryByText(/This STEP file is large/)).toBeNull();
  });

  it('falls back to the browser when the person presses "Open in browser instead"', async () => {
    const wait = holdTheWait();
    renderTree();

    await act(async () => {
      void handSceneImportFile(stepFile());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(wait.options()?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByText('Open in browser instead'));
    // The abort is the whole mechanism: the waiter notices it and answers
    // 'cancelled', and the import carries on down the path that has always worked.
    expect(wait.options()?.signal?.aborted).toBe(true);

    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const model = addedModel();
    expect(model).toBeTruthy();
    expect('representation' in model!).toBe(false);
    expect(useStore.getState().scene.models).toHaveLength(1);
  });

  it('stops polling when the panel goes away', async () => {
    const wait = holdTheWait();
    const view = renderTree();

    await act(async () => {
      void handSceneImportFile(stepFile());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    view.unmount();

    // The wait is the one phase of an import with no other end: a conversion that
    // never lands would otherwise be polled for as long as the tab stayed open,
    // by a panel nobody is looking at.
    expect(wait.options()?.signal?.aborted).toBe(true);
    // And the unmount is not mistaken for "Open in browser instead": nobody is
    // left to show a browser tessellation to.
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(parseModelFile).not.toHaveBeenCalled();
    expect(broadcastSceneUpdate).not.toHaveBeenCalled();
  });
});

describe('a file the server will not convert', () => {
  it('does not wait at all, and tells the room to load the source', async () => {
    // `derived: 'unavailable'` from the upload: no convert-service on this
    // deployment, or a mesh that never needed one.
    renderTree();

    await hand(stepFile());

    expect(waitForDerivedGlb).not.toHaveBeenCalled();
    const model = addedModel();
    expect(model).toBeTruthy();
    expect('representation' in model!).toBe(false);
    expect(screen.queryByText(/Preparing the model on the server/)).toBeNull();
  });

  it('does not wait for a mesh either, which is every GLB anybody uploads', async () => {
    renderTree();

    await hand(new File(['glb'], 'part.glb', { type: 'model/gltf-binary' }));

    expect(waitForDerivedGlb).not.toHaveBeenCalled();
    expect('representation' in addedModel()!).toBe(false);
  });
});
