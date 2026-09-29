// The three answers to "a second model was imported", and the revision that goes dark.
//
// docs/plan/15-sessions-and-variants.md batch BQ. The user's report was "importing one
// 3d model deletes the last". Nothing was ever deleted — a superseded revision is kept
// and can be shown again — but the chooser put "New revision of Bracket, becomes Rev B
// and hides the one before it" FIRST and in the boldest type, so it read as the thing
// that was about to happen rather than as one of three options, and the one that leaves
// both models on screen was second.
//
// So what is pinned here is the order, the exact copy of each answer, which one is the
// primary, and — the other half of the complaint — that a hidden revision is still in
// the tree, says it is hidden, and comes back on one click.
//
// The upload and the parse are faked; the placement, the scene writes and the tree are
// real, as in sceneTreeImportHandoff.test.tsx.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';
import type { ModelImportResult } from '../../../utils/modelLoader';
import type { SceneModel, SceneUpdate } from '../../../lib/scene/roomScene';

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

const { default: SceneTree } = await import('../SceneTree');
const { useStore } = await import('../../../store');

const HASH = 'aa'.repeat(32);
const OLD_HASH = 'bb'.repeat(32);

/** Rev A of the "bracket" line, already in the scene when the second file arrives. */
const OLD: SceneModel = {
  id: 'bracket', hash: OLD_HASH, fileName: 'bracket.step', line: 'bracket',
  revision: 'A', visible: true, offset: [0, 0, 0],
};

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

/** Import a second file and stop at the question. */
async function askWhereItGoes(): Promise<void> {
  const file = new File(['glb'], 'onshape-part.glb', { type: 'model/gltf-binary' });
  await act(async () => {
    const { handSceneImportFile } = await import('../../../lib/scene/importHandoff');
    expect(handSceneImportFile(file)).toBe(true);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** The three buttons, in the order they are drawn. */
function optionOrder(): string[] {
  return ['import-choice-beside', 'import-choice-revision-bracket', 'import-choice-replace']
    .map((id) => screen.getByTestId(id))
    .sort((left, right) =>
      left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map((node) => node.getAttribute('data-testid') ?? '');
}

function sent(): SceneUpdate[] {
  return broadcastSceneUpdate.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  broadcastSceneUpdate.mockClear();
  uploadModelFile.mockReset().mockImplementation(async (file: File) => ({
    fileName: file.name, hash: HASH, size: file.size,
  }));
});

afterEach(cleanup);

describe('the import choice', () => {
  it('offers "Add next to it" first, then the revision, then the one that removes things', async () => {
    renderTree([OLD]);
    await askWhereItGoes();

    expect(optionOrder()).toEqual([
      'import-choice-beside',
      'import-choice-revision-bracket',
      'import-choice-replace',
    ]);
  });

  it('makes the answer that keeps both models the primary one, and the destructive one red and last', async () => {
    renderTree([OLD]);
    await askWhereItGoes();

    // Black on white is this app's "this is the one", and it is on the answer that
    // changes nothing about the models already on screen.
    expect(screen.getByTestId('import-choice-beside').className).toContain('bg-black');
    expect(screen.getByTestId('import-choice-revision-bracket').className).not.toContain('bg-black');
    expect(screen.getByTestId('import-choice-replace').className).not.toContain('bg-black');
    // Red TEXT, not a red button: it is a real answer somebody may need, not an error.
    expect(screen.getByText('Replace everything').className).toContain('text-red-700');
  });

  it('says what each answer does, in the words the complaint was about', async () => {
    renderTree([OLD]);
    await askWhereItGoes();

    expect(screen.getByTestId('import-choice-beside')).toHaveTextContent(
      'Add next to itBoth models stay on screen.',
    );
    // Names the revision going dark AND says it is kept, which "hides the one before
    // it" did not: that sentence was true and still read as a deletion.
    expect(screen.getByTestId('import-choice-revision-bracket')).toHaveTextContent(
      'New revision of bracketShown instead of Rev A. Rev A is kept; show it again from the tree.',
    );
    expect(screen.getByTestId('import-choice-replace')).toHaveTextContent(
      'Replace everythingRemoves all models from the scene and clears this meeting’s comments, chat and cards.',
    );
  });

  it('keeps both models on screen when the first answer is taken', async () => {
    renderTree([OLD]);
    await askWhereItGoes();

    fireEvent.click(screen.getByTestId('import-choice-beside'));

    expect(sent().some((update) => update.op === 'setVisible')).toBe(false);
    expect(sent().some((update) => update.op === 'remove')).toBe(false);
    expect(useStore.getState().scene.models).toHaveLength(2);
    expect(useStore.getState().scene.models.every((model) => model.visible)).toBe(true);
  });

  it('hides the revision it supersedes, and keeps it in the tree', async () => {
    renderTree([OLD]);
    await askWhereItGoes();

    fireEvent.click(screen.getByTestId('import-choice-revision-bracket'));

    expect(sent()).toContainEqual({ op: 'setVisible', id: 'bracket', visible: false });
    const models = useStore.getState().scene.models;
    // Hidden, not gone: the cards and pins raised against Rev A still have a model to
    // point at, and Compare needs both.
    expect(models).toHaveLength(2);
    expect(models.find((model) => model.id === 'bracket')?.visible).toBe(false);
    expect(models.find((model) => model.revision === 'B')?.visible).toBe(true);
  });
});

describe('a hidden revision in the model tree', () => {
  /** The scene as the revision choice leaves it: Rev A dark, Rev B on screen. */
  function renderSuperseded() {
    return renderTree([
      { ...OLD, visible: false },
      { id: `model-${HASH}`, hash: HASH, fileName: 'onshape-part.glb', line: 'bracket', revision: 'B', visible: true, offset: [0, 0, 0] },
    ]);
  }

  it('lists it, says it is hidden, and brings it back on one click', () => {
    renderSuperseded();

    // Listed, with its own row and its own revision letter — a hidden revision is not
    // folded into the one that replaced it.
    expect(screen.getByText('bracket · Rev A')).toBeInTheDocument();
    expect(screen.getByTestId('scene-model-hidden-bracket')).toHaveTextContent('hidden');
    // Grey and struck through was the only thing saying so before, which is what made it
    // look deleted.
    expect(screen.getByTestId('scene-model-eye-bracket')).toHaveAttribute('title', 'Show this model again');

    fireEvent.click(screen.getByTestId('scene-model-eye-bracket'));

    expect(sent()).toContainEqual({ op: 'setVisible', id: 'bracket', visible: true });
  });

  it('does not mark a model that is on screen as hidden', () => {
    renderSuperseded();

    expect(screen.getByText('bracket · Rev B')).toBeInTheDocument();
    expect(screen.queryByTestId(`scene-model-hidden-model-${HASH}`)).toBeNull();
  });
});
