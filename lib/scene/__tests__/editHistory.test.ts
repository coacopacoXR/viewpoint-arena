// The undo stack and the rules that make an undo safe — batch BT.
//
// Everything here is pure, which is the reason the split in lib/scene/editHistory.ts
// exists: an undo is an EDIT, sent to a room server that applies it to its own copy and
// relays it to everybody, so a wrong answer is not "my model jumped" but "everybody's
// model jumped, and the review remembered it". The two rules that get their own test are
// the cap (fifty, oldest first) and the redo stack (a new edit replaces it), because
// both are the kind of thing that silently rots: nothing looks broken the day the cap
// stops being applied, and a redo stack that survives a new edit offers to put back a
// scene that has not existed for twenty steps.
//
// The other half — planRestore — is here because it is the part that has to be right
// about a model somebody ELSE removed while this person was undoing. Re-adding it would
// put a product back into a meeting that has moved on without it.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_HISTORY_STEPS,
  canRedo,
  canUndo,
  changedSinceStep,
  historyNotice,
  historyRefusalNotice,
  modelsForIds,
  planRestore,
  sameSceneModel,
  sameSceneModels,
  stepIndex,
  stepToRedo,
  stepToUndo,
  useEditHistory,
  type HistoryStep,
} from '../editHistory';
import { applySceneUpdate, type RoomScene, type SceneModel } from '../roomScene';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

function model(id: string, hash: string, over: Partial<SceneModel> = {}): SceneModel {
  return {
    id,
    hash,
    fileName: `${id}.step`,
    line: id,
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...over,
  };
}

function sceneWith(...models: SceneModel[]): RoomScene {
  return { models, builtIn: null };
}

/** One step that moved `id` from `before` to `after`. */
function moveStep(id: string, before: SceneModel, after: SceneModel, label = 'Moved it'): HistoryStep {
  return { label, ids: [id], before: [before], after: [after] };
}

function resetHistory() {
  useEditHistory.getState().clear();
}

beforeEach(resetHistory);

describe('the stack', () => {
  it('starts empty, with nothing to undo and nothing to redo', () => {
    const state = useEditHistory.getState();
    expect(state.steps).toEqual([]);
    expect(state.cursor).toBe(0);
    expect(canUndo(state)).toBe(false);
    expect(canRedo(state)).toBe(false);
    expect(stepToUndo(state)).toBeNull();
    expect(stepToRedo(state)).toBeNull();
  });

  it('keeps fifty steps and drops the oldest', () => {
    const { record } = useEditHistory.getState();
    for (let index = 0; index < MAX_HISTORY_STEPS + 5; index += 1) {
      record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), `step ${index}`));
    }

    const state = useEditHistory.getState();
    expect(state.steps).toHaveLength(MAX_HISTORY_STEPS);
    expect(state.steps[0].label).toBe('step 5');
    expect(state.steps[MAX_HISTORY_STEPS - 1].label).toBe(`step ${MAX_HISTORY_STEPS + 4}`);
    expect(state.cursor).toBe(MAX_HISTORY_STEPS);
  });

  it('moves the cursor back and forth without losing either side', () => {
    const { record, move } = useEditHistory.getState();
    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'one'));
    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'two'));

    move(-1);
    let state = useEditHistory.getState();
    expect(state.cursor).toBe(1);
    expect(stepToUndo(state)?.label).toBe('one');
    expect(stepToRedo(state)?.label).toBe('two');
    expect(canRedo(state)).toBe(true);

    move(-1);
    state = useEditHistory.getState();
    expect(state.cursor).toBe(0);
    expect(canUndo(state)).toBe(false);
    expect(stepToUndo(state)).toBeNull();

    // And it stops at both ends rather than wrapping or going negative.
    move(-1);
    expect(useEditHistory.getState().cursor).toBe(0);
    move(99);
    expect(useEditHistory.getState().cursor).toBe(2);
  });

  it('replaces the redo stack with a new edit, because that scene no longer exists', () => {
    const { record, move } = useEditHistory.getState();
    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'one'));
    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'two'));
    move(-1);
    expect(stepToRedo(useEditHistory.getState())?.label).toBe('two');

    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'three'));

    const state = useEditHistory.getState();
    expect(state.steps.map((step) => step.label)).toEqual(['one', 'three']);
    expect(state.cursor).toBe(2);
    expect(canRedo(state)).toBe(false);
  });

  it('drops a step below the cursor and takes the cursor with it', () => {
    const { record } = useEditHistory.getState();
    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'one'));
    record(moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'two'));

    useEditHistory.getState().drop(stepIndex(useEditHistory.getState(), 'undo'));

    const state = useEditHistory.getState();
    expect(state.steps.map((step) => step.label)).toEqual(['one']);
    expect(state.cursor).toBe(1);
    expect(canRedo(state)).toBe(false);
  });

  it('empties when the room is left', () => {
    useEditHistory.getState().record(
      moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'one'),
    );
    useEditHistory.getState().clear();
    expect(useEditHistory.getState()).toMatchObject({ steps: [], cursor: 0 });
  });
});

describe('sameSceneModel', () => {
  it('reads an absent rotation and scale as the identity they mean', () => {
    // Without this the FIRST drag of a model that has never been turned records a step
    // for a drag that ended facing the way it started, and Ctrl+Z appears to do nothing.
    const untouched = model('bracket', HASH_A);
    const written = model('bracket', HASH_A, { rotation: [0, 0, 0], scale: 1 });
    expect(sameSceneModel(untouched, written)).toBe(true);
    expect(sameSceneModels([untouched], [written])).toBe(true);
  });

  it('notices a move, a turn, a size, a hide, a rename and a moved part', () => {
    const base = model('bracket', HASH_A);
    expect(sameSceneModel(base, model('bracket', HASH_A, { offset: [1, 0, 0] }))).toBe(false);
    expect(sameSceneModel(base, model('bracket', HASH_A, { rotation: [0, 1, 0] }))).toBe(false);
    expect(sameSceneModel(base, model('bracket', HASH_A, { scale: 2 }))).toBe(false);
    expect(sameSceneModel(base, model('bracket', HASH_A, { visible: false }))).toBe(false);
    expect(sameSceneModel(base, model('bracket', HASH_A, { revision: 'B' }))).toBe(false);
    expect(sameSceneModel(base, model('bracket', HASH_A, { parts: { n1: { position: [1, 0, 0] } } }))).toBe(false);
    expect(sameSceneModel(base, model('other', HASH_B))).toBe(false);
  });

  it('answers the same for two lists in a different order', () => {
    const a = model('bracket', HASH_A);
    const b = model('flange', HASH_B);
    expect(sameSceneModels([a, b], [b, a])).toBe(true);
    expect(sameSceneModels([a], [a, b])).toBe(false);
  });
});

describe('planRestore', () => {
  it('turns an undone move back into one setTransform, which is the op the gizmo sends', () => {
    const before = model('bracket', HASH_A, { offset: [1, 0, 0] });
    const after = model('bracket', HASH_A, { offset: [4, 0, 0], rotation: [0, 1, 0] });
    const step = moveStep('bracket', before, after);

    expect(planRestore(sceneWith(after), step, 'undo').updates).toEqual([
      { op: 'setTransform', id: 'bracket', transform: { offset: [1, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    ]);
    expect(planRestore(sceneWith(before), step, 'redo').updates).toEqual([
      { op: 'setTransform', id: 'bracket', transform: { offset: [4, 0, 0], rotation: [0, 1, 0], scale: 1 } },
    ]);
  });

  it('undoes a hide with a show, and an add with a remove, and a remove with an add', () => {
    const shown = model('bracket', HASH_A);
    const hidden = model('bracket', HASH_A, { visible: false });
    expect(planRestore(sceneWith(hidden), moveStep('bracket', shown, hidden), 'undo').updates)
      .toEqual([{ op: 'setVisible', id: 'bracket', visible: true }]);

    // A step that ADDED the model has no `before` record for it at all, which is how
    // planRestore tells "put back what I removed" from "somebody else removed it".
    const addStep: HistoryStep = { label: 'Added it', ids: ['bracket'], before: [], after: [shown] };
    expect(planRestore(sceneWith(shown), addStep, 'undo').updates).toEqual([{ op: 'remove', id: 'bracket' }]);
    expect(planRestore(sceneWith(), addStep, 'redo').updates).toEqual([{ op: 'add', model: shown }]);
  });

  it('sends nothing at all for a step the scene has already caught up with', () => {
    const before = model('bracket', HASH_A, { offset: [1, 0, 0] });
    const after = model('bracket', HASH_A, { offset: [4, 0, 0] });
    const step = moveStep('bracket', before, after);
    expect(planRestore(sceneWith(before), step, 'undo')).toEqual({ updates: [], missing: [] });
  });

  it('undoes a moved part with one override, and Reset all parts with one clear', () => {
    const before = model('bracket', HASH_A);
    const after = model('bracket', HASH_A, { parts: { flange_1: { position: [2, 0, 0] } } });
    const step = moveStep('bracket', before, after);

    expect(planRestore(sceneWith(after), step, 'undo').updates).toEqual([
      { op: 'clearPartTransforms', id: 'bracket' },
    ]);
    expect(planRestore(sceneWith(before), step, 'redo').updates).toEqual([
      { op: 'setPartTransform', id: 'bracket', nodeId: 'flange_1', transform: { position: [2, 0, 0] } },
    ]);
  });

  it('deletes only the overrides that have to go when both sides have parts', () => {
    const before = model('bracket', HASH_A, {
      parts: { flange_1: { position: [1, 0, 0] }, bolt_2: { position: [0, 1, 0] } },
    });
    const after = model('bracket', HASH_A, { parts: { flange_1: { position: [9, 0, 0] } } });
    const updates = planRestore(sceneWith(after), moveStep('bracket', before, after), 'undo').updates;

    expect(updates).toContainEqual({
      op: 'setPartTransform', id: 'bracket', nodeId: 'flange_1', transform: { position: [1, 0, 0] },
    });
    expect(updates).toContainEqual({
      op: 'setPartTransform', id: 'bracket', nodeId: 'bolt_2', transform: { position: [0, 1, 0] },
    });
  });

  it('refuses to re-add a model somebody else removed, and says which one is missing', () => {
    const before = model('bracket', HASH_A, { offset: [1, 0, 0] });
    const after = model('bracket', HASH_A, { offset: [4, 0, 0] });
    const step = moveStep('bracket', before, after);
    const plan = planRestore(sceneWith(model('something-else', HASH_B)), step, 'undo');

    expect(plan.updates).toEqual([]);
    expect(plan.missing).toEqual(['bracket']);
  });

  it('does re-add a model its own step added, which is what redoing an add means', () => {
    const added = model('bracket', HASH_A);
    const step: HistoryStep = { label: 'Added it', ids: ['bracket'], before: [], after: [added] };
    const plan = planRestore(sceneWith(), step, 'redo');

    expect(plan.missing).toEqual([]);
    expect(plan.updates).toEqual([{ op: 'add', model: added }]);
  });

  it('leaves a model this step never touched alone', () => {
    const moved = model('bracket', HASH_A, { offset: [4, 0, 0] });
    const other = model('flange', HASH_B);
    const step = moveStep('bracket', model('bracket', HASH_A), moved);
    const updates = planRestore(sceneWith(moved, other), step, 'undo').updates;

    // One operation, for one model. A whole-scene write is how two people silently
    // undo each other, which is the reason lib/scene/roomScene.ts has operations.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'bracket' });
  });
});

describe('changedSinceStep', () => {
  it('is true when somebody else moved the model after this step did', () => {
    const after = model('bracket', HASH_A, { offset: [4, 0, 0] });
    const step = moveStep('bracket', model('bracket', HASH_A), after);
    expect(changedSinceStep(sceneWith(after), step)).toBe(false);
    expect(changedSinceStep(sceneWith(model('bracket', HASH_A, { offset: [7, 0, 0] })), step)).toBe(true);
    expect(changedSinceStep(sceneWith(), step)).toBe(true);
  });
});

describe('the notice', () => {
  it('names whoever changed it in between when the scene says who that was', () => {
    expect(historyNotice('undo', true, 'Olga')).toBe('Undone — Olga had moved it since.');
    expect(historyNotice('redo', true, 'Olga')).toBe('Redone — Olga had moved it since.');
  });

  it('is the short sentence when it does not, and when nothing changed', () => {
    // SCENE_STATE carries no last-changed-by, so today every undo reads this one.
    expect(historyNotice('undo', true, null)).toBe('Undone.');
    expect(historyNotice('undo', false, 'Olga')).toBe('Undone.');
    expect(historyNotice('redo', false, null)).toBe('Redone.');
  });

  it('says so when a step had to be dropped instead', () => {
    const step = moveStep('bracket', model('bracket', HASH_A), model('bracket', HASH_A), 'Moved bracket');
    expect(historyRefusalNotice('undo', step)).toContain('Moved bracket');
    expect(historyRefusalNotice('undo', step)).toContain('Cannot undo');
  });
});

describe('modelsForIds', () => {
  it('answers these models of this scene and nothing else', () => {
    const scene = sceneWith(model('bracket', HASH_A), model('flange', HASH_B));
    expect(modelsForIds(scene, ['flange'])).toEqual([model('flange', HASH_B)]);
    expect(modelsForIds(scene, [])).toEqual([]);
    expect(modelsForIds(scene, ['gone'])).toEqual([]);
  });

  it('survives being handed the scene a reducer produced', () => {
    const scene = applySceneUpdate(sceneWith(model('bracket', HASH_A)), {
      op: 'setVisible', id: 'bracket', visible: false,
    });
    expect(modelsForIds(scene, ['bracket'])[0].visible).toBe(false);
  });
});
