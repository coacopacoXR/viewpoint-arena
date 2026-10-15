// Which node a click in the 3D view selects — batch BT.
//
// Until this file existed the only way to select a part of an imported model was the
// Model Tree, because the one thing that already resolves a point in the 3D view to a
// node (components/Scene/UserLaser.tsx) only runs while the laser is engaged: both
// mouse buttons, or P, or a hand, or a hover-dwell. The amber strip's Part mode read
// whatever that left selected, so "move this flange" meant "find the flange in a
// 400-row tree, then press Move".
//
// This is the resolution half of the fix, and it is pure for two reasons. First, the
// answer has to be the SAME node id the tree would select for that mesh — the tree
// shows the scene graph, so a click that selected an id with no row would light up
// the gizmo and nothing else, and the person would have no idea what they were about
// to move. Second, "was that a click or a camera drag" is a number and a distance, and
// a number and a distance belong in a test rather than in a pointer handler.
//
// The raycast itself, the pointer events and the store writes live in
// components/Scene/SceneClickSelect.tsx.
//
// WHAT IT RESOLVES AGAINST. Not the scene graph directly: a raycast hit goes to the
// model's PartRegistry (lib/scene/partRegistry.ts), which is what answers "which part
// is this" once a part is no longer necessarily an Object3D of its own. The laser's
// granularity switch used to be a second copy of the same walk in
// lib/pickSelectionId.ts and lives here now, because two copies of one resolution is
// how the laser and the tree came to disagree in the first place.

import { sceneModelForNode, type SceneModel } from './roomScene';
import { hitParts, type HitParts, type PartRegistry, type PickHit } from './partRegistry';
import type { ReviewGizmoTarget } from '../../types';

/**
 * How far the pointer may travel between down and up and still be a click.
 *
 * Four pixels, not zero: a hand holding a mouse still moves it a pixel or two, and a
// threshold of zero turns every orbit-drag that ends where it started into a
 * selection. Four is below the smallest drag anybody means — one scene unit of a
// model two units wide is a hundred pixels — and above every jitter measured here.
 */
export const CLICK_DRAG_THRESHOLD_PX = 4;

/** A point on screen in CSS pixels, which is what pointer events report. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Whether a press that started at `down` and ended at `up` was a click.
 *
 * Straight-line distance rather than per-axis: a drag straight up the screen is a
 * camera orbit exactly as much as a diagonal one is, and treating the axes
 * separately would let a long vertical orbit select whatever it ended on.
 */
export function isClick(
  down: ScreenPoint,
  up: ScreenPoint,
  threshold: number = CLICK_DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= threshold;
}

/**
 * Whether the keyboard focus is somewhere the browser's own undo belongs.
 *
 * The same test components/Scene/UserLaser.tsx makes before treating P as "point":
 * a card being written, a slide title, a search box. Ctrl+Z in any of those has to
 * undo TEXT, which the browser does and this app cannot, so the scene's history
 * stands aside.
 */
export function isTextInput(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') return false;
  if (!(target instanceof HTMLElement)) return false;
  // `=== true` rather than the value itself: jsdom leaves `isContentEditable`
  // undefined, and a function typed `boolean` that answers undefined is a function
  // whose callers cannot trust `!isTextInput(x)`.
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable === true
  );
}

/** What a click has to resolve against: the scene, and what the tree lists. */
export interface ClickSelectionContext {
  /** The strip's other switch. Decides whether the answer is a part or a model. */
  target: ReviewGizmoTarget;
  /** The room's scene, so a node id can be traced to the model it belongs to. */
  models: readonly SceneModel[];
  /**
   * The parsed models' part registries, which is what turns a raycast hit into a part.
   * `partRegistries(store.sceneEntries)` answers it; the bundled sample has none and is
   * resolved from the tags on its own objects instead.
   */
  registries: readonly PartRegistry[];
  /**
   * The id of a model's own root node, from its parsed tree — the id the Model Tree's
   * model row selects. Null while the file is still downloading, when there is no row
   * to select either.
   */
  rootIdOf: (modelId: string) => string | null;
  /** Whether the Model Tree has a row for this node id. */
  lists: (nodeId: string) => boolean;
}

/** The laser's own switch: point at one part, or at the whole model. */
export type LaserGranularity = 'model' | 'part';

/**
 * The node id the LASER selects for a hit, given its granularity — the second consumer
 * of one resolution, and the reason `hitParts` answers a chain rather than an id.
 *
 * 'part' wants the nearest part and 'model' wants the model it belongs to, which for an
 * imported model are the same string: buildSceneTree stamps a node's own id into both
 * `userData.modelId` and `userData.nodeId`. They differ only for the bundled sample,
 * whose meshes carry the sample's root as their `modelId` and their own id as their
 * `nodeId`, so 'model' has to keep answering the `modelId` rather than the chain's head.
 *
 * Null when the hit names no model at all — the floor, empty space, a helper — which
 * the laser answers by clearing the selection.
 *
 * Moved here from lib/pickSelectionId.ts, deleted: it was the same parent walk as the
 * click's, with the same skipRaycast bail and the same avatar/beam/point-cloud skip,
 * and two copies of one resolution is exactly the divergence this file's header exists
 * to prevent.
 */
export function laserSelectionId(parts: HitParts, granularity: LaserGranularity): string | null {
  if (parts.modelId === null) return null;
  if (granularity === 'model') return parts.modelId;
  // 'part': the nearest id, falling back to the model's when the hit object carried none
  // of its own — a mesh the file left untagged inside a tagged group.
  return parts.chain[0] ?? parts.modelId;
}

/**
 * The node id a click on `hit` selects, or null for "nothing to select".
 *
 * Null means empty space, an avatar, a helper, or a mesh whose model has not been
 * parsed yet. components/Scene/SceneClickSelect.tsx answers it by clearing the
 * selection, which is the other half of the batch's ask: clicking away from a model
 * has to put the gizmo down.
 *
 * In Part mode the answer is the clicked mesh's own node, or the nearest ancestor of
 * it that the tree lists. Walking the chain until the tree recognises one is what makes
 * a click always land on something the person can see selected: a tagged object is not
 * always a row, because collapseSingleChildGroups promotes a group's only child and
 * drops the group's row while the group keeps its id.
 *
 * In Whole model mode it is the model's root — the id the tree's model row selects —
 * because that is what "selects that model" means to the rest of the app: the gizmo
 * attaches to the wrapper, the scale slider refers to it, and the tree highlights one
 * row rather than one mesh of it.
 */
export function clickedNodeId(hit: PickHit | null, context: ClickSelectionContext): string | null {
  if (!hit) return null;
  const { chain, modelId } = hitParts(hit, context.registries);
  if (chain.length === 0) return null;

  if (context.target === 'model') {
    // Traced through the scene rather than taken from the chain: an imported model tags
    // EVERY object it walks with that object's own id, so a mesh's `modelId` is the mesh
    // and says nothing about which product it is part of. Asking the scene which model
    // the id belongs to, and then that model's parsed tree for its root, is the same
    // resolution the amber strip's Part mode already uses (partTargetFor), so the click
    // and the strip cannot disagree about what was selected.
    const model = sceneModelForNode(context.models, chain[0]);
    const rootId = model ? context.rootIdOf(model.id) : null;
    if (rootId && context.lists(rootId)) return rootId;
    // No SceneModel behind it — one of the three bundled samples, whose parts are React
    // components. Their nearest `modelId` IS the model, so it is the answer, and it is
    // the answer the laser's 'model' granularity has always given for the same click.
    if (modelId && context.lists(modelId)) return modelId;
  }

  return chain.find((id) => context.lists(id)) ?? null;
}
