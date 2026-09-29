// Moving one PART of a model: what an override means on the geometry, and which
// node the gizmo is pointing at.
//
// Batch BR (docs/plan/14-rooms-models-admin-ai.md). The amber strip's Move /
// Rotate / Scale have applied to a whole model since batch BH, writing
// SceneModel.offset/rotation/scale. This is the other half of the switch the strip
// now has: the same three tools, attached to one node of one imported model's scene
// graph instead, writing SceneModel.parts[nodeId].
//
// THE ONE RULE, which everything here exists to protect: an override REPLACES the
// transform the file gave the node, in the node's own local (parent) space. It is
// never a delta and never cumulative, so applying the same override twice changes
// nothing the second time, a client that missed one SCENE_STATE converges on the
// next one, and "Reset part" is a delete rather than an arithmetic inverse.
//
// Replacing rather than adding needs the ORIGINAL to compare against, and the
// original is only knowable before anything has moved the node — so it is stamped
// into `userData` the first time this module is about to touch that node, and read
// from there for ever after. Stamped lazily rather than for every node of every
// model because a STEP assembly can have tens of thousands of them and at most
// MAX_SCENE_PARTS of them can ever be overridden.

import type { Object3D } from 'three';
import {
  sceneModelForNode,
  type PartTransform,
  type PartTransforms,
  type SceneModel,
} from './roomScene';

/** Where the file's own local transform is kept once something has overridden it. */
const ORIGINAL_KEY = 'originalLocalTransform';

/** Three numbers per field, as plain arrays: it lives in userData, not in a class. */
export interface StoredLocalTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

function readLocal(object: Object3D): StoredLocalTransform {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [object.scale.x, object.scale.y, object.scale.z],
  };
}

/**
 * The transform this node's FILE gave it, remembered the first time it is asked for.
 *
 * Called by applyPartTransforms before it overwrites anything, and by the gizmo on
 * pointer-down — which is the moment that matters, because TransformControls moves
 * the object on the pointer-move that follows, and an original captured after that
 * would be the dragged value and "Reset part" would put the node where the drag
 * happened to end.
 */
export function rememberOriginalLocalTransform(object: Object3D): StoredLocalTransform {
  const stored = object.userData[ORIGINAL_KEY] as StoredLocalTransform | undefined;
  if (stored) return stored;
  const original = readLocal(object);
  object.userData[ORIGINAL_KEY] = original;
  return original;
}

/**
 * A part scale the renderer can use: three positive finite numbers.
 *
 * drei's scale gizmo drags one axis at a time and CAN be dragged through zero and
 * out the other side, which would hand back a negative or a zero. Neither is a size
 * anybody meant, and both are refused by the wire (see sceneWire.asPartScale), so a
 * drag that produced one would be refused by the room and this browser would be left
 * showing a part the room does not have. Falling back to the file's own number for
 * that one axis keeps the other two, which is what the drag was about.
 */
export function usablePartScale(
  scale: readonly [number, number, number],
  fallback: readonly [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((axis) => {
    const value = scale[axis];
    return Number.isFinite(value) && value > 0 ? value : fallback[axis];
  }) as [number, number, number];
}

/** What the gizmo writes after a drag: this node's local transform, all three fields. */
export function partTransformFromObject(object: Object3D): PartTransform {
  return readLocal(object);
}

function sameNumbers(
  object: { x: number; y: number; z: number },
  next: readonly [number, number, number],
): boolean {
  return object.x === next[0] && object.y === next[1] && object.z === next[2];
}

/**
 * Put every override in `parts` onto the node it names, and put every node that no
 * longer has one back where its file had it.
 *
 * Idempotent and total: a node with no override and no remembered original is left
 * completely alone, which is why a model nobody has moved a part of costs one
 * traverse and no writes. `root` itself is skipped, because the root IS the whole
 * model — placeImportedGroup owns its local transform (it is the centring and the
 * baseScale), the model's own offset/rotation/scale sit on the wrapper above it, and
 * an override on it would be a third opinion about the same object.
 */
export function applyPartTransforms(root: Object3D, parts: PartTransforms | undefined): void {
  const overrides = parts ?? {};
  root.traverse((object) => {
    if (object === root) return;
    const nodeId = object.userData.modelId as string | undefined;
    if (typeof nodeId !== 'string') return;
    const override = overrides[nodeId];
    const remembered = object.userData[ORIGINAL_KEY] as StoredLocalTransform | undefined;
    // Neither moved nor moveable-back: nothing to do, and nothing to remember.
    if (!override && !remembered) return;
    const original = remembered ?? rememberOriginalLocalTransform(object);
    const position = override?.position ?? original.position;
    const rotation = override?.rotation ?? original.rotation;
    const scale = override ? usablePartScale(override.scale ?? original.scale, original.scale) : original.scale;
    if (!sameNumbers(object.position, position)) object.position.set(position[0], position[1], position[2]);
    if (!sameNumbers(object.rotation, rotation)) object.rotation.set(rotation[0], rotation[1], rotation[2]);
    if (!sameNumbers(object.scale, scale)) object.scale.set(scale[0], scale[1], scale[2]);
  });
}

/**
 * The object a node id names inside one model's parsed group, or null.
 *
 * A walk rather than a lookup because the parsed group is the only index there is:
 * the tree the store holds (SceneModelEntry.sceneTree) is data describing these
 * objects, and it is the objects that TransformControls needs. Node ids are unique
 * within one model — buildSceneTree mints them from a counter — so the first match
 * is the only match.
 */
export function findPartNode(root: Object3D, nodeId: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((object) => {
    if (found || object === root) return;
    if ((object.userData.modelId as string | undefined) === nodeId) found = object;
  });
  return found;
}

// ─── Which part the gizmo is pointing at ─────────────────────────────────────

/**
 * What the strip's Part mode has to act on.
 *
 * `nodeId` null means the selection is the model's own root, which the batch brief
 * says behaves like Whole model — the root is the model, and moving it is what the
 * other half of the switch is for.
 */
export interface PartTarget {
  modelId: string;
  nodeId: string | null;
}

/**
 * Resolve the ONE selection the laser and the Model Tree already set into a part.
 *
 * Not a third selection, and not `activeSceneModelId` either: pointing at a part in
 * the 3D view sets the selection without touching which model the scale slider
 * refers to (components/Scene/UserLaser.tsx), so the model has to come from the node
 * id itself — which sceneModelForNode answers from the id's prefix, without needing
 * the parsed geometry to be loaded to say so.
 *
 * Null means "there is no part to move": nothing selected, or the selection is a
 * built-in's node, or it belongs to no model in this scene. That is the state the
 * strip answers with "Click a part to move it."
 */
export function partTargetFor(
  models: readonly SceneModel[],
  rootIdOf: (modelId: string) => string | null,
  selection: string | null,
): PartTarget | null {
  if (!selection) return null;
  const model = sceneModelForNode(models, selection);
  if (!model) return null;
  return rootIdOf(model.id) === selection
    ? { modelId: model.id, nodeId: null }
    : { modelId: model.id, nodeId: selection };
}
