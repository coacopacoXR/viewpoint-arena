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
// Replacing rather than adding needs the ORIGINAL to compare against, and the original
// is only knowable before anything has moved the part. That used to be a `userData` stamp
// this module wrote lazily onto whichever Object3D it was about to move, with the gizmo
// having to remember to ask for it at pointer-down rather than at pointer-up. Task 04b
// moved it into the part handle, where the write path itself takes it and no caller can
// forget (`PartHandle.bindPose`), and with it went the walk that found the objects: the
// registry indexes them by id. What is left here is the rule, the guard on a scale dragged
// through zero, and the resolution of the one selection into a part.

import type { Object3D } from 'three';
import type { PartRegistry } from './partRegistry';
import {
  sceneModelForNode,
  type PartTransforms,
  type SceneModel,
} from './roomScene';

/**
 * A part's own local transform, as three triples of plain numbers.
 *
 * The shape `PartTransform` carries on the wire, so the two convert by copying rather
 * than by translating — which is what makes an override readable straight off a dragged
 * gizmo and writable straight back onto a part.
 */
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
export function partTransformFromObject(object: Object3D): StoredLocalTransform {
  return readLocal(object);
}

function sameTriple(
  current: readonly [number, number, number],
  next: readonly [number, number, number],
): boolean {
  return current[0] === next[0] && current[1] === next[1] && current[2] === next[2];
}

function sameTransform(current: StoredLocalTransform, next: StoredLocalTransform): boolean {
  return sameTriple(current.position, next.position)
    && sameTriple(current.rotation, next.rotation)
    && sameTriple(current.scale, next.scale);
}

/**
 * Put every override in `parts` onto the part it names, and put every part that no
 * longer has one back where its file had it.
 *
 * Idempotent and total, which is THE ONE RULE above: the same override applied twice is
 * the same pose, so a SCENE_STATE echo landing mid-drag cannot move the part a second
 * time, and "Reset part" is a delete rather than an arithmetic inverse.
 *
 * A part with no override that has never been moved is left completely alone, and the
 * index that says which parts those are belongs to the registry — so a model nobody has
 * moved a part of costs one empty pass and no writes at all. That is the change from the
 * traverse this replaced, which walked every node of the model on every `model.parts`
 * change to find the handful the wire allows an override for.
 *
 * `rootId` is skipped, because the root IS the whole model — placeImportedGroup owns its
 * local transform (it is the centring and the baseScale), the model's own
 * offset/rotation/scale sit on the wrapper above it, and an override on it would be a
 * third opinion about the same object. It is a parameter rather than something the
 * registry answers because the rule is this module's, and because the root's local
 * transform is the one a bind pose cannot describe: by the time anything asks, placement
 * has already written to it.
 */
export function applyPartTransforms(
  registry: PartRegistry,
  rootId: string,
  parts: PartTransforms | undefined,
): void {
  const overrides = parts ?? {};

  // Back to the file's own transform first. A part whose override was deleted — "Reset
  // part", an undo, a review whose stored placements never had one — has nothing in
  // `overrides` to be found by, and `movedPartIds` is the only index of which parts are
  // standing somewhere other than where their file put them.
  for (const id of registry.movedPartIds()) {
    if (id === rootId || overrides[id]) continue;
    const handle = registry.get(id);
    if (!handle) continue;
    const bind = handle.bindPose();
    if (sameTransform(handle.getLocalTransform(), bind)) continue;
    handle.setLocalTransform(bind);
  }

  for (const id of Object.keys(overrides)) {
    if (id === rootId) continue;
    const handle = registry.get(id);
    if (!handle) continue;
    const override = overrides[id];
    const bind = handle.bindPose();
    const next: StoredLocalTransform = {
      position: override.position ?? bind.position,
      rotation: override.rotation ?? bind.rotation,
      // Kept per axis: drei's scale gizmo can be dragged through zero and out the other
      // side, the wire refuses the result, and falling back to the file's own number on
      // that one axis keeps the other two — which is what the drag was about.
      scale: usablePartScale(override.scale ?? bind.scale, bind.scale),
    };
    if (sameTransform(handle.getLocalTransform(), next)) continue;
    handle.setLocalTransform(next);
  }
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
