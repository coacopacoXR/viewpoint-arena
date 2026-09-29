// Undo and redo for the room's scene — batch BT.
//
// "there is not ctrl+z, pretty important" is the report, and the shape of the answer
// follows from one fact about this app: a scene edit is not a local edit. Moving a
// model writes a SCENE_UPDATE to the room server, which applies it to its single copy
// and relays the result to everybody, and the review keeps its own copy of the
// placement beside that (lib/scene/keepPlacements.ts). So an undo is not a rewind of
// this browser — it is ONE MORE EDIT, sent the same way, through the same permission
// checks, that happens to put the record back the way it was. That is what keeps
// everybody else's screen true: an undo only this browser performed would be a model
// standing in two places at once.
//
// Two files, and the split is the point. THIS one is pure: what a step is, how the
// stack moves, and how to turn "make these models look like this record again" into
// operations the room already understands. It reads no store and holds no socket, so
// every rule in it is a test. lib/scene/useSceneEditHistory.ts is the wiring: it reads
// the scene before and after a mutation, sends the operations, and decides what the
// person sees when the room says no.
//
// WHAT IS REMEMBERED, and what is not. Model and part move/rotate/scale, Reset part
// and Reset all parts, showing and hiding a model or a revision, adding a model and
// removing one — every one of which is a change to the shared scene. Not the camera,
// not the tree's own eye toggles for one participant, not a viewpoint, not a pin:
// those are not scene records and undoing them would either undo somebody else's
// meeting or undo nothing at all.

import { create } from 'zustand';
import {
  samePartTransforms,
  sceneModelTransform,
  type RoomScene,
  type SceneModel,
  type SceneUpdate,
} from './roomScene';

/**
 * How many steps are kept.
 *
 * Fifty, and the oldest goes first. A step is a handful of SceneModel records — small
 * even for a model with five hundred moved parts, which is the cap
 * lib/scene/roomScene.ts puts on one model's overrides — so the limit is about
 * usefulness rather than memory: nobody means the four-hundredth press of Ctrl+Z, and
 * an unbounded stack in a room left open for a day is a stack of records for models
 * that have since been removed.
 */
export const MAX_HISTORY_STEPS = 50;

/**
 * One thing this person did to the scene, and what it takes to take it back.
 *
 * WHOLE RECORDS on both sides rather than a pair of operations, which is the simple
 * choice and the safe one: a record is what the room stores, what the review stores
 * and what the reducer compares, so "put these models back to this" cannot drift from
 * what a move means. It also makes a step survive a change to the wire — an operation
 * recorded by last month's build and replayed by this one is a compatibility question,
 * and a record is not.
 *
 * A model the step ADDED is absent from `before`, and one it REMOVED is absent from
 * `after`. That absence is the information `planRestore` needs to tell "re-add what I
 * removed" from "somebody else removed it and it is gone".
 */
export interface HistoryStep {
  /** What this was, in words: 'Moved Bracket · Rev A'. Shown in the notice. */
  label: string;
  /** Every model the step touched. */
  ids: string[];
  /** Those models as they were before it, absent for one it added. */
  before: SceneModel[];
  /** Those models as they are after it, absent for one it removed. */
  after: SceneModel[];
}

/** The stack, and the one number that says where in it this person is. */
export interface EditHistoryState {
  steps: HistoryStep[];
  /**
   * How many of `steps` are applied. `steps[cursor - 1]` is what Ctrl+Z undoes and
   * `steps[cursor]` is what Ctrl+Shift+Z redoes, so a cursor of 0 with steps in front
   * of it is "everything has been undone" and not "there is nothing".
   */
  cursor: number;
  record: (step: HistoryStep) => void;
  move: (delta: number) => void;
  /** Drop one step that cannot be replayed, keeping the cursor pointing where it did. */
  drop: (index: number) => void;
  clear: () => void;
}

export const useEditHistory = create<EditHistoryState>((set) => ({
  steps: [],
  cursor: 0,
  record: (step) => set((state) => {
    // A new edit after an undo replaces the redo stack rather than sitting beside it:
    // the steps ahead of the cursor describe a scene that no longer exists, and
    // offering to redo them is offering to put back something nobody did.
    const steps = [...state.steps.slice(0, state.cursor), step].slice(-MAX_HISTORY_STEPS);
    return { steps, cursor: steps.length };
  }),
  move: (delta) => set((state) => {
    const cursor = Math.min(state.steps.length, Math.max(0, state.cursor + delta));
    return cursor === state.cursor ? state : { cursor };
  }),
  drop: (index) => set((state) => {
    if (index < 0 || index >= state.steps.length) return state;
    return {
      steps: state.steps.filter((_, at) => at !== index),
      // A step BELOW the cursor was one that had been applied, so removing it takes the
      // count of applied steps with it. One above it was a redo that can no longer
      // happen, and the cursor stays where it is.
      cursor: index < state.cursor ? state.cursor - 1 : state.cursor,
    };
  }),
  clear: () => set({ steps: [], cursor: 0 }),
}));

export const canUndo = (state: Pick<EditHistoryState, 'cursor'>): boolean => state.cursor > 0;

export const canRedo = (state: Pick<EditHistoryState, 'steps' | 'cursor'>): boolean =>
  state.cursor < state.steps.length;

/** The step Ctrl+Z would undo, or null. */
export function stepToUndo(state: EditHistoryState): HistoryStep | null {
  return state.cursor > 0 ? state.steps[state.cursor - 1] : null;
}

/** The step Ctrl+Shift+Z would redo, or null. */
export function stepToRedo(state: EditHistoryState): HistoryStep | null {
  return state.cursor < state.steps.length ? state.steps[state.cursor] : null;
}

/** The index `drop` wants for the step about to be replayed, or -1. */
export function stepIndex(state: EditHistoryState, direction: 'undo' | 'redo'): number {
  return direction === 'undo' ? state.cursor - 1 : state.cursor;
}

/** These models of this scene, in scene order. */
export function modelsForIds(scene: RoomScene, ids: readonly string[]): SceneModel[] {
  if (ids.length === 0) return [];
  return scene.models.filter((model) => ids.includes(model.id));
}

function sameTriple(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Whether two records of one model say the same thing.
 *
 * Through `sceneModelTransform` rather than field by field, because `rotation` and
 * `scale` are OPTIONAL and absent means identity: a model nobody has turned has no
 * rotation field, and the first drag that leaves it facing the way it arrived writes
 * `[0, 0, 0]`. Those are the same model standing in the same place, and calling them
 * different would put a step in the history for a drag that changed nothing.
 */
export function sameSceneModel(a: SceneModel, b: SceneModel): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.hash !== b.hash || a.fileName !== b.fileName) return false;
  if (a.line !== b.line || a.revision !== b.revision || a.visible !== b.visible) return false;
  const left = sceneModelTransform(a);
  const right = sceneModelTransform(b);
  if (!sameTriple(left.offset, right.offset)) return false;
  if (!sameTriple(left.rotation, right.rotation)) return false;
  if (left.scale !== right.scale) return false;
  return samePartTransforms(a.parts, b.parts);
}

/** Whether two lists are the same models, in any order. */
export function sameSceneModels(a: readonly SceneModel[], b: readonly SceneModel[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((model) => b.some((other) => sameSceneModel(model, other)));
}

/**
 * Whether the models a step touched are still exactly what the step left behind.
 *
 * False means somebody else has moved, hidden or replaced one of them since. The step
 * is still undone — the batch brief is explicit that a later change to the same model
 * is not a reason to refuse — but the person has to be TOLD, because an undo that
 * quietly overwrites a colleague's edit is how two people end up fighting over a
 * bracket with neither of them able to see why.
 */
export function changedSinceStep(scene: RoomScene, step: HistoryStep): boolean {
  return !sameSceneModels(modelsForIds(scene, step.ids), step.after);
}

/** What `planRestore` answered: the operations to send, and the ids it could not. */
export interface RestorePlan {
  updates: SceneUpdate[];
  /**
   * Models the step touched that are no longer in the scene and that the step did not
   * put there, so there is nothing honest to send for them. Somebody removed the model
   * while this person was doing something else, and an undo that re-added it would be
   * putting a product back into a meeting that has moved on without it.
   */
  missing: string[];
}

/**
 * The operations that make `ids` of this scene look like one side of a step again.
 *
 * Operations and not a whole scene, for the reason lib/scene/roomScene.ts gives for
 * having operations at all: a client that sent "here is my list" would silently undo
 * everybody else's changes to the models it is not undoing.
 *
 * The rule for a model that is not in the scene, which is the only subtle one here:
 * re-add it when the OTHER side of the step does not have it either — that is a step
 * whose whole job was to add it, and redoing an add is an add. Otherwise the model has
 * gone missing since the step was recorded, and it goes in `missing` instead.
 */
export function planRestore(
  scene: RoomScene,
  step: HistoryStep,
  direction: 'undo' | 'redo',
): RestorePlan {
  const target = direction === 'undo' ? step.before : step.after;
  const other = direction === 'undo' ? step.after : step.before;
  const updates: SceneUpdate[] = [];
  const missing: string[] = [];

  for (const id of step.ids) {
    const current = scene.models.find((model) => model.id === id);
    const wanted = target.find((model) => model.id === id);

    if (!wanted) {
      if (current) updates.push({ op: 'remove', id });
      continue;
    }
    if (!current) {
      if (other.some((model) => model.id === id)) missing.push(id);
      else updates.push({ op: 'add', model: wanted });
      continue;
    }
    if (current.visible !== wanted.visible) {
      updates.push({ op: 'setVisible', id, visible: wanted.visible });
    }
    const now = sceneModelTransform(current);
    const then = sceneModelTransform(wanted);
    if (
      !sameTriple(now.offset, then.offset) ||
      !sameTriple(now.rotation, then.rotation) ||
      now.scale !== then.scale
    ) {
      updates.push({ op: 'setTransform', id, transform: then });
    }
    if (!samePartTransforms(current.parts, wanted.parts)) {
      // One `clearPartTransforms` when the target has none at all, rather than a
      // deletion per node: "Reset all parts" undone is one operation either way.
      if (!wanted.parts || Object.keys(wanted.parts).length === 0) {
        updates.push({ op: 'clearPartTransforms', id });
      } else {
        const nodeIds = new Set([
          ...Object.keys(wanted.parts),
          ...Object.keys(current.parts ?? {}),
        ]);
        for (const nodeId of nodeIds) {
          updates.push({ op: 'setPartTransform', id, nodeId, transform: wanted.parts?.[nodeId] ?? null });
        }
      }
    }
  }

  return { updates, missing };
}

/**
 * What the notice says after a step is replayed.
 *
 * `changedBy` is the name of whoever touched the model in between, and today it is
 * always null: SCENE_STATE carries the scene, who may change it and whether it was
 * ever set — see SceneStatePayload — and not who changed it last. The batch brief
 * asks for the name when the scene has one and for the short sentence when it does
 * not, so the short sentence is what a person reads. The parameter stays because the
 * alternative is a string that cannot ever say the useful thing the moment the room
 * server starts attributing a scene change, and because "somebody moved this while
 * you were undoing" is worth its own test either way.
 */
export function historyNotice(
  direction: 'undo' | 'redo',
  changedSince: boolean,
  changedBy: string | null,
): string {
  const verb = direction === 'undo' ? 'Undone' : 'Redone';
  if (changedSince && changedBy) return `${verb} — ${changedBy} had moved it since.`;
  return `${verb}.`;
}

/** What the notice says when a step could not be replayed at all. */
export function historyRefusalNotice(direction: 'undo' | 'redo', step: HistoryStep): string {
  return `Cannot ${direction} “${step.label}” — the room's scene has moved on`;
}
