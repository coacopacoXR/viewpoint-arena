// Tests for showReviewScene — what a design review puts on screen when it is
// opened, which since batch BC is its whole stored revision history rather than
// only the single model its curation row names.
//
// docs/plan/14-rooms-models-admin-ai.md: "Opening a design review builds its
// scene from its revisions (the latest revision of each line visible) instead of
// only asset.modelHash — keep asset.modelHash working for reviews that have no
// revisions yet." The second half of that sentence is the regression this file
// spends most of its time on, because every review that exists today has no
// revisions and must open exactly as it did before.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoomScene } from '../roomScene';
import type { ModelRevision } from '../../reviews/revisionsRepo';

const { state } = vi.hoisted(() => ({
  state: {
    scene: { models: [], builtIn: null } as RoomScene,
    stored: [] as ModelRevision[],
    // Which line of the review the room is on. Batch BQ2 made the once-per-open guard per
    // LINE, so a test has to be able to move the room to another one.
    activeLine: null as { id: string } | null,
    setRoomScene: vi.fn(),
    upsertSceneModel: vi.fn(),
  },
}));

vi.mock('../../../store', () => ({
  useStore: {
    getState: () => ({
      get scene() {
        return state.scene;
      },
      get activeLine() {
        return state.activeLine;
      },
      setRoomScene: (scene: RoomScene) => {
        state.scene = scene;
        state.setRoomScene(scene);
      },
      upsertSceneModel: state.upsertSceneModel,
    }),
  },
}));

// Only the READ is faked: sceneFromRevisions is the real one, so what these tests
// assert is the scene a history actually produces.
vi.mock('../../reviews/revisionsRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../reviews/revisionsRepo')>();
  return {
    ...actual,
    listModelRevisions: vi.fn(async () => state.stored),
  };
});

vi.mock('../../../utils/modelLoader', () => ({ parseModelFile: vi.fn() }));

// Since batch BK the scene also depends on which LINE the room is on: a session
// starts from what its line was last looking at, not from the review's newest
// upload. That read goes to two more tables through the same client, so it is faked
// here — the read itself is pinned in lib/reviews/__tests__/linesRepo.test.ts, and
// what this file adds is the scene it produces.
const origin = vi.hoisted(() => ({ revisionIds: null as string[] | null }));

vi.mock('../../reviews/linesRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../reviews/linesRepo')>();
  return { ...actual, originRevisionIds: vi.fn(async () => origin.revisionIds) };
});

import { forgetReviewScene, showReviewScene } from '../showCurationModel';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

function revision(overrides: Partial<ModelRevision> = {}): ModelRevision {
  return {
    id: 'rev-1',
    reviewId: 'review-1',
    line: 'bracket',
    revision: 'A',
    hash: HASH_A,
    fileName: 'bracket.step',
    size: 1024,
    notes: '',
    uploadedBy: null,
    uploadedByName: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

const ASSET = { modelType: 'imported', modelHash: HASH_A, importedFileName: 'bracket.step' };

beforeEach(() => {
  vi.clearAllMocks();
  state.scene = { models: [], builtIn: null };
  state.stored = [];
  state.activeLine = null;
  origin.revisionIds = null;
  forgetReviewScene('review-1');
  forgetReviewScene('review-2');
});

describe('showReviewScene — the line the room is on', () => {
  beforeEach(() => {
    state.stored = [
      revision({ id: 'rev-1', revision: 'A', hash: HASH_A }),
      revision({ id: 'rev-2', revision: 'B', hash: HASH_B, fileName: 'bracket-v2.step' }),
    ];
  });

  it('opens on what its line was last looking at, not on the review\'s newest upload', async () => {
    // docs/plan/15 batch BK: a session starts where its line left off. The review
    // has been to Rev B; the line this room is on last met on Rev A.
    origin.revisionIds = ['rev-1'];
    await showReviewScene('review-1', ASSET, 'test');

    expect(state.scene.models).toHaveLength(1);
    expect(state.scene.models[0]).toMatchObject({ revision: 'A', visible: true });
  });

  it('opens on the whole history when the line has never met', async () => {
    // Which is exactly what opening such a review did before lines existed.
    origin.revisionIds = null;
    await showReviewScene('review-1', ASSET, 'test');

    expect(state.scene.models.map((model) => model.revision).sort()).toEqual(['A', 'B']);
    expect(state.scene.models.find((model) => model.revision === 'B')?.visible).toBe(true);
  });

  it('opens on the whole history when the line named revisions that are all gone', async () => {
    // A revision deleted from the review through the admin console. The fallback is
    // everything the review still has, never an empty room.
    origin.revisionIds = ['rev-deleted'];
    await showReviewScene('review-1', ASSET, 'test');

    expect(state.scene.models.map((model) => model.revision).sort()).toEqual(['A', 'B']);
  });

  it('still shows the curation model synchronously, before either read has answered', async () => {
    origin.revisionIds = ['rev-1'];
    const promise = showReviewScene('review-1', ASSET, 'test');
    expect(state.scene.models).toHaveLength(1);
    expect(state.scene.models[0].hash).toBe(HASH_A);
    await promise;
  });
});

describe('showReviewScene — the fallback every existing review takes', () => {
  it('answers false for a preset in a review with no stored revisions', async () => {
    // Batch BQ2 made this function read the history whatever the asset names, so the
    // preset fallback is now the answer for a review with NOTHING stored rather than for
    // any asset that is not an imported model. Same false, same reason for the caller.
    expect(await showReviewScene('review-1', { modelType: 'headphones' }, 'test')).toBe(false);
    expect(state.setRoomScene).not.toHaveBeenCalled();
  });

  it('shows the curation model synchronously, before any read has answered', async () => {
    // The point of doing it in two steps: the product is on screen immediately,
    // and a slow or failing query never leaves somebody looking at an empty room.
    const promise = showReviewScene('review-1', ASSET, 'test');
    expect(state.scene.models).toHaveLength(1);
    expect(state.scene.models[0].hash).toBe(HASH_A);
    await promise;
  });

  it('leaves that one-model scene alone when the review has no stored revisions', async () => {
    await showReviewScene('review-1', ASSET, 'test');

    expect(state.scene.models).toHaveLength(1);
    expect(state.scene.models[0]).toMatchObject({ hash: HASH_A, line: 'bracket', revision: 'A', visible: true });
    // Set once, by the synchronous half. A second setRoomScene with an identical
    // scene would drop and re-adopt the parsed geometry for no reason.
    expect(state.setRoomScene).toHaveBeenCalledTimes(1);
  });

  it('shows the curation model with no review id at all, and asks the database nothing', async () => {
    await showReviewScene(null, ASSET, 'test');
    expect(state.scene.models).toHaveLength(1);
    expect(state.stored).toEqual([]);
  });

  it('leaves a preset review to its caller, which then sets the active model type', async () => {
    expect(await showReviewScene('review-1', { modelType: 'bicycle' }, 'test')).toBe(false);
    expect(await showReviewScene('review-1', undefined, 'test')).toBe(false);
  });
});

describe('showReviewScene — a review with a history', () => {
  beforeEach(() => {
    state.stored = [
      revision({ id: 'rev-1', revision: 'A', hash: HASH_A }),
      revision({ id: 'rev-2', revision: 'B', hash: HASH_B, fileName: 'bracket-v2.step' }),
    ];
  });

  it('opens on the newest revision, with the one it superseded still there and hidden', async () => {
    await showReviewScene('review-1', ASSET, 'test');

    expect(state.scene.models).toHaveLength(2);
    const a = state.scene.models.find((model) => model.revision === 'A');
    const b = state.scene.models.find((model) => model.revision === 'B');
    expect(a?.visible).toBe(false);
    expect(b?.visible).toBe(true);
  });

  it('does not add the curation model twice when the history already holds that file', async () => {
    await showReviewScene('review-1', ASSET, 'test');
    expect(state.scene.models.filter((model) => model.hash === HASH_A)).toHaveLength(1);
  });

  it('keeps a curation model the history has never heard of, hidden behind what superseded it', async () => {
    // A review created before model_revisions existed, whose first recorded
    // upload became Rev B. Dropping the original would have left its pins
    // floating in empty space next to the model that replaced it.
    state.stored = [revision({ id: 'rev-2', revision: 'B', hash: HASH_B })];

    await showReviewScene('review-1', ASSET, 'test');

    expect(state.scene.models).toHaveLength(2);
    expect(state.scene.models.find((model) => model.hash === HASH_A)?.visible).toBe(false);
    expect(state.scene.models.find((model) => model.hash === HASH_B)?.visible).toBe(true);
  });

  it('reads the history once per review, so a realtime echo cannot rebuild the scene over what happened since', async () => {
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');

    await showReviewScene('review-1', ASSET, 'test');
    expect(state.scene.models).toHaveLength(2);
    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(1);

    // Somebody compares two revisions, or the room server relays a scene of its
    // own. setConfig runs again on the next realtime echo and must not go back to
    // the database and put the review's opening scene back over the top of it.
    await showReviewScene('review-1', ASSET, 'test');
    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(1);
  });

  it('rebuilds again after the review has been left, so a second visit opens like the first', async () => {
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');

    await showReviewScene('review-1', ASSET, 'test');
    expect(state.scene.models).toHaveLength(2);

    // Leaving the room clears the active config, which forgets the rebuild.
    forgetReviewScene('review-1');
    state.scene = { models: [], builtIn: null };

    await showReviewScene('review-1', ASSET, 'test');

    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(2);
    expect(state.scene.models).toHaveLength(2);
  });

  it('does not replace a scene that changed while the read was in flight', async () => {
    let release: (value: ModelRevision[]) => void = () => {};
    const held = new Promise<ModelRevision[]>((resolve) => { release = resolve; });
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');
    vi.mocked(listModelRevisions).mockReturnValueOnce(held);

    const promise = showReviewScene('review-2', ASSET, 'test');
    // An import lands while the query is still running.
    state.scene = { models: [{ ...state.scene.models[0], line: 'something-else' }], builtIn: null };
    const changed = state.scene;
    release(state.stored);
    await promise;

    expect(state.scene).toBe(changed);
  });
});

// ─── The placement the review kept (batch BI) ───────────────────────────────
//
// The room's Move / Rotate / Scale used to live only in the room server's
// storage, so a review reopened outside that room put every model back where it
// had arrived. The review now carries each revision's placement with it, and
// opening the review is where that copy is allowed to win — over the
// beside-each-other default sceneFromRevisions computes, which is a guess about
// a room nobody has been in since.

describe('showReviewScene — the placement the review kept', () => {
  beforeEach(() => {
    state.stored = [
      revision({ id: 'rev-1', revision: 'A', hash: HASH_A }),
      revision({ id: 'rev-2', revision: 'B', hash: HASH_B, fileName: 'bracket-v2.step' }),
    ];
  });

  it('puts the revision it was written for back where it was left', async () => {
    await showReviewScene('review-1', {
      ...ASSET,
      placements: [{ line: 'bracket', revision: 'B', offset: [5, 0, 0], rotation: [0, 1.5, 0], scale: 2 }],
    }, 'test');

    const b = state.scene.models.find((model) => model.revision === 'B');
    expect(b?.offset).toEqual([5, 0, 0]);
    expect(b?.rotation).toEqual([0, 1.5, 0]);
    expect(b?.scale).toBe(2);
  });

  it('leaves the revision it superseded where the scene put it', async () => {
    // Per REVISION, not per review. Rev A is still in the scene and hidden, so
    // Compare can reach it; a placement written for the model under discussion
    // must not drag the older one along with it.
    await showReviewScene('review-1', {
      ...ASSET,
      placements: [{ line: 'bracket', revision: 'B', offset: [5, 0, 0], rotation: [0, 1.5, 0], scale: 2 }],
    }, 'test');

    const a = state.scene.models.find((model) => model.revision === 'A');
    expect(a?.offset).not.toEqual([5, 0, 0]);
    expect(a?.rotation).toBeUndefined();
    expect(a?.scale).toBeUndefined();
  });

  it('applies the placement to the one-model fallback too, before any read answers', async () => {
    const promise = showReviewScene('review-1', {
      ...ASSET,
      placements: [{ line: 'bracket', revision: 'A', offset: [1, 2, 3], rotation: [0, 0, 0], scale: 1 }],
    }, 'test');

    // Synchronously, for the reason the fallback exists at all: the product is on
    // screen immediately and a slow query never leaves anybody looking at a model
    // standing somewhere it was not left.
    expect(state.scene.models[0].offset).toEqual([1, 2, 3]);
    await promise;
  });

  it('leaves a review that never moved anything with no rotation and no scale at all', async () => {
    await showReviewScene('review-1', ASSET, 'test');

    for (const model of state.scene.models) {
      expect(model.rotation).toBeUndefined();
      expect(model.scale).toBeUndefined();
    }
  });
});

// ─── A review whose models are only in its history (batch BQ2) ────────────────
//
// The live repro this batch exists for: a review created empty and filled by imports made
// inside the room. Its models are in model_revisions and nowhere else — the asset still says
// modelType 'none', because nothing writes an imported asset for a model a meeting added
// after the review was set up. showReviewScene used to return false on its first line for
// any asset that was not an imported model, so that history was never read at all and the
// room opened on nothing.

describe('showReviewScene — a review whose asset is not an imported model', () => {
  beforeEach(() => {
    state.stored = [
      revision({ id: 'rev-1', line: 'headphones', revision: 'A', hash: HASH_A, fileName: 'headphones.glb' }),
      revision({ id: 'rev-2', line: 'bicycle', revision: 'A', hash: HASH_B, fileName: 'bicycle.glb' }),
    ];
  });

  it('builds the scene from the stored revisions anyway', async () => {
    expect(await showReviewScene('review-1', { modelType: 'none' }, 'test')).toBe(true);

    expect(state.scene.models.map((model) => model.line).sort()).toEqual(['bicycle', 'headphones']);
    expect(state.scene.models.every((model) => model.visible)).toBe(true);
  });

  it('narrows to the line the room is on, the way it does for an imported asset', async () => {
    state.activeLine = { id: 'line-a' };
    origin.revisionIds = ['rev-2'];

    await showReviewScene('review-1', { modelType: 'none' }, 'test');

    expect(state.scene.models).toHaveLength(1);
    expect(state.scene.models[0]).toMatchObject({ line: 'bicycle', revision: 'A' });
  });

  it('keeps the placements the review stored', async () => {
    await showReviewScene('review-1', {
      modelType: 'none',
      placements: [{ line: 'bicycle', revision: 'A', offset: [3, 0, 0], rotation: [0, 1, 0], scale: 1.5 }],
    }, 'test');

    expect(state.scene.models.find((model) => model.line === 'bicycle')?.offset).toEqual([3, 0, 0]);
    expect(state.scene.models.find((model) => model.line === 'bicycle')?.scale).toBe(1.5);
  });

  it('answers false, and leaves the preset to its caller, when the review has no history', async () => {
    state.stored = [];

    expect(await showReviewScene('review-1', { modelType: 'headphones' }, 'test')).toBe(false);
    expect(await showReviewScene('review-1', undefined, 'test')).toBe(false);
    expect(state.setRoomScene).not.toHaveBeenCalled();
  });
});

// ─── Once per open, and an open is a review AND a line ────────────────────────
//
// The guard that stops a realtime echo from rebuilding the scene over what somebody has
// since hidden or moved used to be keyed by review id alone. A page that walks from a
// review's main room into one of its variants opens the SAME review on a different model,
// so the variant skipped the build and kept whatever the main line had left on screen —
// which in a variant room whose server has never held a scene is nothing at all.

describe('showReviewScene — once per review AND per line', () => {
  beforeEach(() => {
    state.stored = [
      revision({ id: 'rev-1', revision: 'A', hash: HASH_A }),
      revision({ id: 'rev-2', revision: 'B', hash: HASH_B, fileName: 'bracket-v2.step' }),
    ];
  });

  it('builds again when the same review is opened on another line', async () => {
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');
    const { originRevisionIds } = await import('../../reviews/linesRepo');

    await showReviewScene('review-1', ASSET, 'test');
    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(1);

    // The variant's room: same page, same review, a server that has never held a scene and
    // has just said so by emptying this one.
    state.activeLine = { id: 'line-a' };
    state.scene = { models: [], builtIn: null };

    await showReviewScene('review-1', ASSET, 'test');

    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(2);
    // And the read it makes is for the line the room is on, not for the review as a whole.
    expect(vi.mocked(originRevisionIds).mock.calls[1]?.[1]).toBe('line-a');
    expect(state.scene.models).toHaveLength(2);
  });

  it('does not build twice for the line it is already on', async () => {
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');
    state.activeLine = { id: 'line-a' };

    await showReviewScene('review-1', ASSET, 'test');
    await showReviewScene('review-1', ASSET, 'test');

    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(1);
  });

  it('answers a preset review false both times, rather than claiming a scene it did not build', async () => {
    // The guard's answer has to match the first one's: a caller reads false as "fall back to
    // a preset", and true would have told activeReviewStore's syncMainModel to leave the
    // screen alone after something else had already emptied it.
    state.stored = [];

    expect(await showReviewScene('review-1', { modelType: 'bicycle' }, 'test')).toBe(false);
    expect(await showReviewScene('review-1', { modelType: 'bicycle' }, 'test')).toBe(false);
  });

  it('rebuilds on demand for a room whose server has never held a scene', async () => {
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');

    await showReviewScene('review-1', ASSET, 'test');
    state.scene = { models: [], builtIn: null };

    await showReviewScene('review-1', ASSET, 'test', { force: true });

    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(2);
    expect(state.scene.models).toHaveLength(2);
  });

  it('forgets every line of a review when the review is left', async () => {
    const { listModelRevisions } = await import('../../reviews/revisionsRepo');

    await showReviewScene('review-1', ASSET, 'test');
    state.activeLine = { id: 'line-a' };
    await showReviewScene('review-1', ASSET, 'test');
    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(2);

    // Leaving the review leaves all of its lines, so coming back opens both like the first
    // time rather than only whichever one was last on screen.
    forgetReviewScene('review-1');
    state.activeLine = null;
    state.scene = { models: [], builtIn: null };

    await showReviewScene('review-1', ASSET, 'test');

    expect(vi.mocked(listModelRevisions).mock.calls).toHaveLength(3);
  });
});
