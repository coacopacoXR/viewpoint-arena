// The other half of the PLM launch's import: a file SceneTree did not pick.
//
// docs/plan/14-rooms-models-admin-ai.md batch BG, item 5. components/review/
// PlmLaunch.tsx gets a File back from Onshape's document browser, and the pipeline
// that turns a File into a model in the room's scene — validate, share to
// /api/models, parse, then beside / replace / revision — already existed here as
// the file input's onChange. It was split into `importPickedFile` rather than
// copied, and the two callers reach it through lib/scene/importHandoff.ts because
// an overlay in the Edit panel and a panel in the left column have no prop between
// them.
//
// So what is pinned here is the half pages/__tests__/roomPlmLaunch.test.tsx cannot
// see: that claiming the handoff really does run a handed-over file through the
// SAME pipeline, and that the claim is for as long as this tree is mounted and no
// longer — a slot nobody releases would import a model into the next room opened.
//
// The upload and the parse are faked; the placement, the scene writes and the
// "already in the scene" guard are real.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import type { ModelImportResult } from '../../../utils/modelLoader';
import type { SceneModel, SceneUpdate } from '../../../lib/scene/roomScene';

/** What POST /api/models answers with, as far as an import is concerned. */
interface StoredModelFile { fileName: string; hash: string; size: number }

const { broadcastSceneUpdate, uploadModelFile } = vi.hoisted(() => ({
  broadcastSceneUpdate: vi.fn((_update: SceneUpdate) => true),
  // One line: esbuild reads a multi-line type argument in a .tsx file as JSX.
  uploadModelFile: vi.fn<(file: File, onProgress?: (fraction: number) => void) => Promise<StoredModelFile>>(),
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

// The parse is the expensive half and has nothing to do with the handoff: one
// group, one part, a two-unit box, which is enough for placement to measure.
vi.mock('../../../utils/modelLoader', async () => {
  const { Group: ThreeGroup, Vector3: ThreeVector3 } = await import('three');
  return {
    validateModelFile: () => null,
    parseModelFile: async (file: File): Promise<ModelImportResult> => ({
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
    }),
  };
});

// Imported after the mocks are registered.
const { default: SceneTree } = await import('../SceneTree');
const { handSceneImportFile } = await import('../../../lib/scene/importHandoff');
const { useStore } = await import('../../../store');

const HASH = 'aa'.repeat(32);
// The scene id lib/scene/roomScene derives from a hash. Written out rather than
// computed so a change to the scheme shows up here as a failing assertion.
const MODEL_ID = `model-${HASH}`;

function modelFile(name = 'onshape-part.glb'): File {
  return new File(['glb'], name, { type: 'model/gltf-binary' });
}

function sceneModel(id: string, hash: string): SceneModel {
  return {
    id, hash, fileName: `${id}.step`, line: id, revision: 'A', visible: true, offset: [0, 0, 0],
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

/** Every scene operation this tree sent, in order. */
function sent(): SceneUpdate[] {
  return broadcastSceneUpdate.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  broadcastSceneUpdate.mockClear();
  uploadModelFile.mockReset().mockImplementation(async (file: File) => ({
    fileName: file.name,
    hash: HASH,
    size: file.size,
  }));
});

afterEach(cleanup);

describe('SceneTree — a file handed over rather than picked', () => {
  it('runs it through the same pipeline: shared, parsed, and added to the scene', async () => {
    renderTree();
    const file = modelFile();

    await hand(file);

    // Shared to /api/models first, because the hash is what the scene holds.
    expect(uploadModelFile).toHaveBeenCalledTimes(1);
    expect(uploadModelFile.mock.calls[0][0]).toBe(file);
    // Then placed. An empty scene has one place to put it, so there is nothing to
    // ask about — exactly as for a picked file.
    const add = sent().find((update) => update.op === 'add');
    expect(add).toBeTruthy();
    if (add?.op !== 'add') return;
    expect(add.model).toMatchObject({ id: MODEL_ID, hash: HASH, fileName: 'onshape-part.glb', revision: 'A' });
    expect(useStore.getState().scene.models).toHaveLength(1);
    // And the parsed geometry is in the store, which is what makes it renderable
    // rather than merely listed.
    expect(useStore.getState().sceneEntries[add.model.id]).toBeTruthy();
  });

  it('reports the import the way a picked one is reported', async () => {
    renderTree();

    await hand(modelFile());

    expect(screen.getByText(/Imported "onshape-part.glb"/)).toBeTruthy();
  });

  it('asks where it goes when the scene already holds a model', async () => {
    // The choice is the part of an import that is easiest to get wrong in a second
    // copy of the pipeline: a launched model must not silently replace the room's.
    renderTree([sceneModel('bracket', 'bb'.repeat(32))]);

    await hand(modelFile());

    expect(screen.getByText(/Add “onshape-part\.glb”/)).toBeTruthy();
    expect(screen.getByText('Replace everything')).toBeTruthy();
    // Nothing has been placed yet — the question comes first.
    expect(sent().some((update) => update.op === 'add')).toBe(false);

    fireEvent.click(screen.getByText('Add next to it'));
    expect(sent().some((update) => update.op === 'add')).toBe(true);
  });

  it('refuses a file the scene already holds, which is the guard a copy would lose', async () => {
    // The scene id is the hash, so the same file twice is the same model — and the
    // guard that says so is the one a second copy of the pipeline would forget.
    renderTree([sceneModel(MODEL_ID, HASH)]);

    await hand(modelFile());

    expect(screen.getByText(/That file is already in the scene as/)).toBeTruthy();
    expect(sent().some((update) => update.op === 'add')).toBe(false);
  });

  it('claims the handoff only while it is mounted', () => {
    const view = renderTree();

    view.unmount();

    // A slot nobody released would import the next launched model into whatever
    // room this browser opened after it.
    expect(handSceneImportFile(modelFile())).toBe(false);
    expect(uploadModelFile).not.toHaveBeenCalled();
  });
});
