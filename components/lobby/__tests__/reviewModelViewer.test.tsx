// What the lobby's live viewer is allowed to be: a reader, not a second room.
//
// docs/plan/15-sessions-and-variants.md batch BO. The component under test is the
// target of a React.lazy in the preview panel, so it is the one place in the lobby
// that may pull in three.js — and the reason it can is that it renders the review's
// models with the ROOM's loaders and the room's placement maths. Almost everything
// here is an assertion about reuse rather than about pixels:
//
//   * the models it draws come from the review's stored history narrowed to its
//     main line, exactly as showReviewScene computes them, and a revision that
//     history has hidden is never downloaded
//   * the bytes go through lib/modelsClient.fetchModelFile and the parse through
//     lib/scene/sceneEntries.parseSceneModelFile — a second loader in the lobby
//     would be a second way for the preview to disagree with the room
//   * the review's stored placements reach the model through the room's own
//     applyStoredPlacements, so what somebody moved in a meeting stands where they
//     left it here too
//   * nothing IT does reaches store.ts, because the lobby has no room to put a
//     scene in and a session spent scrolling it must not leave any behind — with the
//     one exception of the room's own components for the three bundled samples, which
//     register their points of interest and their scene trees exactly as they do in a
//     room and never a scene (see ReviewModelViewer's SAMPLE_COMPONENTS)
//   * what it parses, it frees
//
// There is no WebGL in jsdom, so @react-three/fiber and @react-three/drei are
// stubbed the way components/UI/Boardroom/__tests__/hideAgents.test.tsx stubs them:
// the canvas becomes a div that renders its children, which is enough to prove what
// the viewer decided to draw and when. three itself is REAL — the parsed groups are
// real Groups holding real geometry, because the component centres them with the
// room's own placeImportedGroup and measures them with Box3.setFromObject, and a
// `{ traverse(cb) }` shape would let both of those go untested.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import * as THREE from 'three';
import type { ReviewAsset, ReviewDraft } from '../../../lib/reviewSetupStore';
import type { ModelRevision } from '../../../lib/reviews/revisionsRepo';
import type { StoredPlacement } from '../../../lib/scene/placement';
import type { RoomScene, SceneModel } from '../../../lib/scene/roomScene';
import type { SceneModelEntry } from '../../../lib/scene/sceneEntries';

// ─── Stubs ──────────────────────────────────────────────────────────────────

const {
  loadCurationMock,
  listRevisionsMock,
  revisionsForSessionMock,
  sceneFromRevisionsMock,
  originMock,
  fetchMock,
  parseMock,
  appliedPlacements,
} = vi.hoisted(() => ({
  loadCurationMock: vi.fn<(reviewId: string) => Promise<ReviewDraft | null>>(),
  listRevisionsMock: vi.fn<(reviewId: string) => Promise<ModelRevision[]>>(),
  revisionsForSessionMock: vi.fn<(revisions: ModelRevision[], revisionIds: string[] | null) => ModelRevision[]>(),
  sceneFromRevisionsMock: vi.fn<(revisions: ModelRevision[], unrecorded: SceneModel | null) => RoomScene>(),
  originMock: vi.fn<(reviewId: string | null, lineId: string | null) => Promise<string[] | null>>(),
  fetchMock: vi.fn<(hash: string, fileName: string) => Promise<File>>(),
  parseMock: vi.fn<(model: SceneModel, file: File) => Promise<SceneModelEntry>>(),
  // Every call the real placement rule received, so a test can see the review's
  // stored placements arrive without having to fake the rule's answer.
  appliedPlacements: [] as Array<{
    scene: RoomScene;
    stored: readonly StoredPlacement[] | null | undefined;
  }>,
}));

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="r3f-canvas">{children}</div>
  ),
  // The viewer asks R3F for its scene, its camera and its controls so it can frame the
  // model. There is none of the three here, and it has to cope: that is the same
  // situation as a real canvas whose models landed a render before its controls did.
  useThree: (select: (state: { camera: null; controls: null; scene: null }) => null) =>
    select({ camera: null, controls: null, scene: null }),
  // A sample's framing waits for its geometry to land and is driven by the frame loop.
  // There is no frame loop here, so the callback is simply never called.
  useFrame: () => {},
}));

vi.mock('@react-three/drei', () => ({
  PerspectiveCamera: () => null,
  OrbitControls: () => null,
  Grid: () => null,
  Environment: () => null,
  ContactShadows: () => null,
  // components/Scene/ImportedModel imports this. The viewer imports that module for
  // placeImportedGroup and never renders its component.
  Html: () => null,
}));

// The room's own components for the three bundled samples. The viewer reaches each
// through a React.lazy of its own, so which one it asked for is visible — and the real
// ones suspend on a GLB through drei's useGLTF, which the stub above does not have.
vi.mock('../../../components/Scene/Product', () => ({
  default: () => <div data-testid="sample-synth" />,
}));

vi.mock('../../../lib/curationsRepo', () => ({
  loadCuration: (reviewId: string) => loadCurationMock(reviewId),
}));

vi.mock('../../../lib/reviews/revisionsRepo', () => ({
  listModelRevisions: (reviewId: string) => listRevisionsMock(reviewId),
  revisionsForSession: (revisions: ModelRevision[], revisionIds: string[] | null) =>
    revisionsForSessionMock(revisions, revisionIds),
  sceneFromRevisions: (revisions: ModelRevision[], unrecorded: SceneModel | null) =>
    sceneFromRevisionsMock(revisions, unrecorded),
}));

vi.mock('../../../lib/reviews/linesRepo', () => ({
  originRevisionIds: (reviewId: string | null, lineId: string | null) =>
    originMock(reviewId, lineId),
}));

vi.mock('../../../lib/modelsClient', () => ({
  fetchModelFile: (hash: string, fileName: string) => fetchMock(hash, fileName),
}));

vi.mock('../../../lib/scene/sceneEntries', () => ({
  parseSceneModelFile: (model: SceneModel, file: File) => parseMock(model, file),
}));

// The real rule, watched. Spied on rather than replaced, because the point is that
// the viewer delegates to it — a fake answer here would prove nothing.
vi.mock('../../../lib/scene/placement', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/scene/placement')>();
  return {
    ...real,
    applyStoredPlacements: (
      scene: RoomScene,
      placements: readonly StoredPlacement[] | null | undefined,
    ) => {
      appliedPlacements.push({ scene, stored: placements });
      return real.applyStoredPlacements(scene, placements);
    },
  };
});

// Imported after the mocks, so nothing above can be caught uninitialised by a
// factory that runs while this module is still being evaluated.
const {
  default: ReviewModelViewer,
  LOADING_MESSAGE,
  NO_MODEL_MESSAGE,
  LOAD_FAILED_MESSAGE,
} = await import('../ReviewModelViewer');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const REVIEW_ID = 'review-1';
const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

const IMPORTED_ASSET: ReviewAsset = {
  modelType: 'imported',
  modelHash: HASH_A,
  importedFileName: 'bracket.step',
  references: [],
};

/** A review whose asset names one of the app's bundled models and nothing else. */
const PRESET_ASSET: ReviewAsset = {
  modelType: 'synth',
  references: [],
};

/** A review that has genuinely never had a model: no import, and no sample chosen. */
const NO_MODEL_ASSET: ReviewAsset = {
  modelType: 'none',
  references: [],
};

function draftWith(asset: ReviewAsset): ReviewDraft {
  return {
    reviewId: REVIEW_ID,
    title: 'Landing gear review',
    description: '',
    asset,
    viewpoints: [],
    pins: [],
    agenda: [],
    requirements: [],
    team: [],
    labels: {},
    listed: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function revisionRow(
  id: string,
  line: string,
  letter: string,
  hash: string,
  fileName: string,
): ModelRevision {
  return {
    id,
    reviewId: REVIEW_ID,
    line,
    revision: letter,
    hash,
    fileName,
    size: 1024,
    notes: '',
    uploadedBy: null,
    uploadedByName: 'Me',
    createdAt: '2026-09-01T10:00:00.000Z',
  };
}

function sceneModel(
  hash: string,
  fileName: string,
  line: string,
  letter: string,
  visible: boolean,
): SceneModel {
  return {
    id: `model-${hash}`,
    hash,
    fileName,
    line,
    revision: letter,
    visible,
    offset: [0, 0, 0],
  };
}

/**
 * The parsed half of a model, with the two dispose calls this file asserts on.
 *
 * Real three objects throughout: the viewer centres the group with the room's own
 * placeImportedGroup and then measures it with Box3.setFromObject, so a group with
 * nothing in it would turn both into no-ops and let a component that had stopped
 * doing either pass anyway.
 */
function parsedEntry(model: SceneModel) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material));

  const entry: SceneModelEntry = {
    id: model.id,
    group,
    sceneTree: { id: `${model.id}_0`, name: model.fileName, type: 'MESH', children: [] },
    fileName: model.fileName,
    line: model.line,
    revision: model.revision,
    baseScale: 1,
    basePosition: new THREE.Vector3(0, 0, 0),
    scale: 1,
    size: { x: 1, y: 1, z: 1 },
  };

  return {
    entry,
    geometryDispose: vi.spyOn(geometry, 'dispose'),
    materialDispose: vi.spyOn(material, 'dispose'),
  };
}

/** A promise the test settles by hand, so "before the load finishes" is a fact. */
function deferred<T>() {
  const gate: { settle: ((value: T) => void) | null } = { settle: null };
  const promise = new Promise<T>((resolve) => {
    gate.settle = resolve;
  });
  return { promise, settle: (value: T) => gate.settle?.(value) };
}

/** Every group parseSceneModelFile answered, in the order it answered them. */
let parsed: ReturnType<typeof parsedEntry>[] = [];
/** Every File fetchModelFile answered, so a test can match it against the parse. */
let served: File[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  parsed = [];
  served = [];
  appliedPlacements.length = 0;

  loadCurationMock.mockResolvedValue(draftWith(IMPORTED_ASSET));
  listRevisionsMock.mockResolvedValue([]);
  revisionsForSessionMock.mockImplementation((revisions: ModelRevision[]) => revisions);
  // No stored history, so the scene is the curation's own model — which is what the
  // real sceneFromRevisions answers for an empty list too.
  sceneFromRevisionsMock.mockImplementation(
    (_revisions: ModelRevision[], unrecorded: SceneModel | null) => ({
      models: unrecorded ? [unrecorded] : [],
      builtIn: null,
    }),
  );
  originMock.mockResolvedValue(null);

  fetchMock.mockImplementation(async (_hash: string, fileName: string) => {
    const file = new File(['bytes'], fileName);
    served.push(file);
    return file;
  });
  parseMock.mockImplementation(async (model: SceneModel) => {
    const made = parsedEntry(model);
    parsed.push(made);
    return made.entry;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ReviewModelViewer — the lobby looking inside a design review', () => {
  it('says what it is doing until the models are on screen', async () => {
    const gate = deferred<File>();
    fetchMock.mockReturnValue(gate.promise);

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);

    // Still downloading: the words, and no canvas — a viewer with nothing in it has
    // no business holding a WebGL context.
    expect(screen.getByText(LOADING_MESSAGE)).toBeTruthy();
    expect(screen.queryByTestId('r3f-canvas')).toBeNull();

    gate.settle(new File(['bytes'], 'bracket.step'));

    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());
    expect(screen.queryByText(LOADING_MESSAGE)).toBeNull();
  });

  it("goes through the room's own loaders, with the hash the review stored", async () => {
    render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    expect(loadCurationMock).toHaveBeenCalledWith(REVIEW_ID);

    // The download is lib/modelsClient's, asked for by the review's own hash and the
    // name it was uploaded under — the name matters because parseModelFile
    // dispatches on the extension.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(HASH_A, 'bracket.step');

    // And the parse is lib/scene/sceneEntries', handed the very File the download
    // answered rather than a copy of it or a second fetch of the same hash.
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock.mock.calls[0][1]).toBe(served[0]);
    const parsedModel = parseMock.mock.calls[0][0];
    expect(parsedModel.hash).toBe(HASH_A);
    expect(parsedModel.fileName).toBe('bracket.step');
    expect(parsedModel.id).toBe(`model-${HASH_A}`);
  });

  it('asks which revisions the main line was last looking at, and narrows to them', async () => {
    const history = [revisionRow('rev-1', 'bracket', 'A', HASH_A, 'bracket.step')];
    listRevisionsMock.mockResolvedValue(history);

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    // Null for the line id: the lobby is not on a line, and a room opened on this
    // review's own address starts from the main one.
    expect(originMock).toHaveBeenCalledWith(REVIEW_ID, null);
    expect(revisionsForSessionMock).toHaveBeenCalledWith(history, null);
    expect(sceneFromRevisionsMock).toHaveBeenCalledWith(history, {
      id: `model-${HASH_A}`,
      hash: HASH_A,
      fileName: 'bracket.step',
      line: 'bracket',
      revision: 'A',
      visible: true,
      offset: [0, 0, 0],
    });
  });

  it("hands the review's stored placements to the room's own placement rule", async () => {
    const placements: StoredPlacement[] = [{
      line: 'bracket',
      revision: 'A',
      offset: [4, 0, -1],
      rotation: [0, 1.5708, 0],
      scale: 2,
    }];
    loadCurationMock.mockResolvedValue(draftWith({ ...IMPORTED_ASSET, placements }));

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    expect(appliedPlacements).toHaveLength(1);
    expect(appliedPlacements[0].stored).toEqual(placements);

    // And the placed model is the one that got drawn: the loader was handed the
    // model where somebody left it, not where it arrived.
    const placed = parseMock.mock.calls[0][0];
    expect(placed.offset).toEqual([4, 0, -1]);
    expect(placed.rotation).toEqual([0, 1.5708, 0]);
    expect(placed.scale).toBe(2);
  });

  it('does not download a revision the scene has hidden', async () => {
    const hidden = sceneModel(HASH_A, 'bracket.step', 'bracket', 'A', false);
    const shown = sceneModel(HASH_B, 'mating-part.step', 'mating part', 'B', true);
    listRevisionsMock.mockResolvedValue([
      revisionRow('rev-1', 'bracket', 'A', HASH_A, 'bracket.step'),
      revisionRow('rev-2', 'mating part', 'B', HASH_B, 'mating-part.step'),
    ]);
    sceneFromRevisionsMock.mockReturnValue({ models: [hidden, shown], builtIn: null });

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    // Hidden in the room means absent here, and absent means never fetched: a review
    // with eight revisions of one bracket is one download, not eight.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(HASH_B, 'mating-part.step');
    expect(screen.getByText('mating part · Rev B')).toBeTruthy();
    expect(screen.queryByText('bracket · Rev A')).toBeNull();
  });

  it('says the model could not be loaded when the download fails, and does not throw', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('gone from the server'));

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);

    await waitFor(() => expect(screen.getByText(LOAD_FAILED_MESSAGE)).toBeTruthy());
    // A sentence, not an error boundary and not an empty box.
    expect(screen.queryByTestId('r3f-canvas')).toBeNull();
    expect(screen.queryByText(NO_MODEL_MESSAGE)).toBeNull();
    expect(screen.getByTestId('review-model-viewer')).toBeTruthy();
    quiet.mockRestore();
  });

  it('says there is nothing to show for a review with no model at all, and fetches nothing', async () => {
    loadCurationMock.mockResolvedValue(draftWith(NO_MODEL_ASSET));
    sceneFromRevisionsMock.mockReturnValue({ models: [], builtIn: null });

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);

    await waitFor(() => expect(screen.getByText(NO_MODEL_MESSAGE)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('r3f-canvas')).toBeNull();
  });

  it("draws the room's own component for a review whose model is a bundled sample", async () => {
    loadCurationMock.mockResolvedValue(draftWith(PRESET_ASSET));
    sceneFromRevisionsMock.mockReturnValue({ models: [], builtIn: null });

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);

    // A canvas, and not the sentence. Batch BO said "no model to show yet" here, which
    // was a panel giving up on a review that had a sample standing in it.
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());
    expect(screen.queryByText(NO_MODEL_MESSAGE)).toBeNull();
    expect(screen.queryByText(LOAD_FAILED_MESSAGE)).toBeNull();

    // Named the way the menu that offers it names it, not the way the scene spells it.
    expect(screen.getByText('Synth assembly')).toBeTruthy();

    // Nothing was downloaded from model storage: a sample has no hash and no revision,
    // and its geometry arrives through the room's own loader instead.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(parseMock).not.toHaveBeenCalled();

    // Through that sample's own lazy chunk.
    await waitFor(() => expect(screen.getByTestId('sample-synth')).toBeTruthy());
  });

  it('draws whichever sample the review names, and lets a scene that recorded one win', async () => {
    loadCurationMock.mockResolvedValue(draftWith({ modelType: 'bicycle', references: [] }));
    sceneFromRevisionsMock.mockReturnValue({ models: [], builtIn: 'synth' });

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);

    // The scene record first and the asset's model type as the fallback, which is the
    // room's own precedence: store.ts derives activeModelType from the scene and only
    // then from what the curation asked for.
    await waitFor(() => expect(screen.getByTestId('sample-synth')).toBeTruthy());
    expect(screen.getByText('Synth assembly')).toBeTruthy();
    expect(screen.queryByTestId('sample-bicycle')).toBeNull();
  });

  it('prefers an imported model over the sample the same asset names', async () => {
    loadCurationMock.mockResolvedValue(draftWith({ ...IMPORTED_ASSET, modelType: 'headphones' }));

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    // The room draws a preset only while its scene holds no models of its own, and so
    // does this: a review that started on the headphones and then imported its own
    // bracket shows the bracket, exactly as the room opened on it would.
    expect(fetchMock).toHaveBeenCalledWith(HASH_A, 'bracket.step');
    expect(screen.getByText('bracket · Rev A')).toBeTruthy();
    expect(screen.queryByTestId('sample-headphones')).toBeNull();
  });

  it('says the same for a review the database has no row for', async () => {
    loadCurationMock.mockResolvedValue(null);
    sceneFromRevisionsMock.mockReturnValue({ models: [], builtIn: null });

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);

    await waitFor(() => expect(screen.getByText(NO_MODEL_MESSAGE)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('frees the geometry and materials it parsed when it goes away', async () => {
    const view = render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    expect(parsed).toHaveLength(1);
    expect(parsed[0].geometryDispose).not.toHaveBeenCalled();
    expect(parsed[0].materialDispose).not.toHaveBeenCalled();

    view.unmount();

    expect(parsed[0].geometryDispose).toHaveBeenCalledTimes(1);
    expect(parsed[0].materialDispose).toHaveBeenCalledTimes(1);
  });

  it("frees the first review's models when the panel is pointed at another", async () => {
    const view = render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    view.rerender(<ReviewModelViewer reviewId="review-2" />);
    await waitFor(() => expect(parsed).toHaveLength(2));

    expect(parsed[0].geometryDispose).toHaveBeenCalledTimes(1);
    expect(parsed[0].materialDispose).toHaveBeenCalledTimes(1);
    // The review now on screen keeps its own.
    expect(parsed[1].geometryDispose).not.toHaveBeenCalled();
  });

  it('drops a parse that lands after the panel has gone, and frees it', async () => {
    // The lobby can be scrolled through faster than a 200 MB CAD file parses. A
    // parse that finishes after unmount belongs to nobody, so it must not reach
    // React's state — and it must not leak either, because the teardown that would
    // have freed it has already run.
    const gate = deferred<SceneModelEntry>();
    parseMock.mockImplementation(async (model: SceneModel) => {
      const made = parsedEntry(model);
      parsed.push(made);
      return gate.promise;
    });

    const view = render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(parsed).toHaveLength(1));

    view.unmount();
    gate.settle(parsed[0].entry);

    await waitFor(() => expect(parsed[0].geometryDispose).toHaveBeenCalledTimes(1));
    expect(parsed[0].materialDispose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('r3f-canvas')).toBeNull();
  });

  it('stops a download that was never going to be drawn', async () => {
    // The same guard, one step earlier: unmounting while the bytes are still coming
    // means there is no point parsing them at all.
    const gate = deferred<File>();
    fetchMock.mockReturnValue(gate.promise);

    const view = render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.unmount();
    // act, so the settled download's continuation has definitely run by the time
    // the assertion is made rather than by the time the microtask queue got to it.
    await act(async () => {
      gate.settle(new File(['bytes'], 'bracket.step'));
    });

    expect(parseMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('r3f-canvas')).toBeNull();
  });

  it("leaves the room's own scene exactly as it found it", async () => {
    const { useStore } = await import('../../../store');
    const before = useStore.getState().scene;

    render(<ReviewModelViewer reviewId={REVIEW_ID} />);
    await waitFor(() => expect(screen.getByTestId('r3f-canvas')).toBeTruthy());

    // Identity, not equality: the viewer computes its scene into its own state and
    // never calls a store mutator, so the room's object is the same one it was.
    expect(useStore.getState().scene).toBe(before);
  });
});
