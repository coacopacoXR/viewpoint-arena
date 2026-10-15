// Which parts of a room's scene are the product, and how big they are.
//
// docs/plan/15-sessions-and-variants.md batch BP. The room's scene holds a great deal
// that is not the thing under review: an infinite grid, a floor of contact shadows, the
// agents, everybody's avatar and their laser, and the pins a meeting left on the model.
// A picture framed on all of that is the one the lobby shipped with — the model a speck
// in a wide grey floor — so framing needs an answer to "which of these is the design?".
//
// The room already has one, and it is `userData.modelId`. Every part of every product
// carries it: utils/modelLoader stamps it on the meshes it parses, and
// components/Scene/Product.tsx puts it on each of the synth's part groups. The laser,
// the tree panel and the pointer's pop-up all resolve a hit through it, and
// lib/orbitPivot.ts's getModelCenter measures the model by it. Nothing else in the
// scene has it — the avatars, the lasers and the pins are tagged `skipRaycast` instead
// — so it is exactly the marker this needs and inventing a second one would be a second
// way to disagree with the room about what the product is.
//
// GROUPS AND NOT ONLY MESHES, which is the one place this is broader than
// getModelCenter. That helper asks for a mesh, which the synth never satisfies:
// Product.tsx tags its part GROUPS and leaves their meshes untagged, so a room showing
// the bundled synth would measure as having no model in it at all. Reading the tag on
// any object covers the synth and every imported file alike.
//
// AND A REGISTRY FOR EVERY MODEL THAT HAS ONE, which is where the tag stops being
// enough. A parsed model is indexed by lib/scene/partRegistry.ts, and its box has to be
// asked of that index: `expandByObject` walks a geometry, and a BatchedMesh's geometry
// is the concatenated buffer in the batch's own space, so measuring one walks a box no
// part is in (the render audit's R1). The tag walk is left for what has no registry —
// the synth, whose parts are React components rather than a parse — and a model whose
// registry owns it is skipped so nothing is measured twice.

import * as THREE from 'three';
import type { PartRegistry } from './partRegistry';

/** The marker the room stamps on every part of the product under review. */
export const MODEL_ID_KEY = 'modelId';

/** Whether this object is part of the product. */
function isModelPart(object: THREE.Object3D): boolean {
  return object.userData?.[MODEL_ID_KEY] !== undefined && object.userData[MODEL_ID_KEY] !== null;
}

/**
 * The world-space box around everything the scene says is the product.
 *
 * Answers an EMPTY box — not null, and not a box at the origin — when there is nothing
 * tagged in it, so "no model" and "a model that happens to sit on the origin" stay two
 * different facts. Both callers read empty as "there is no picture to take".
 *
 * Only the OUTERMOST tagged object of each subtree is measured. A tagged group's
 * children are usually tagged too (Product.tsx nests twelve of them, and an imported
 * assembly tags every part under a tagged root), and `expandByObject` walks the whole
 * subtree it is given — so expanding by each of them in turn would measure the same
 * geometry once per ancestor, which on a large CAD file is quadratic in its node count
 * for a box that comes out identical.
 *
 * Invisible parts are left out, by walking with `traverseVisible` rather than
 * `traverse`: hiding a node in the tree panel sets `visible = false` on it, and a
 * picture framed on something a participant hid to see the one behind it is framed on
 * the wrong thing. For a parsed model that is the model's own root and nothing finer,
 * because `expandByObject` walks every child whether it is visible or not — see
 * `PartRegistry.visibleBounds` for why this does not get finer until the renderer does.
 *
 * @param registries the parsed models in the scene, from `partRegistries(store.sceneEntries)`.
 *        Empty for a scene holding only the bundled synth, which is the default so that
 *        a caller framing a sample has nothing to collect.
 */
export function reviewModelBounds(
  root: THREE.Object3D | null | undefined,
  registries: readonly PartRegistry[] = [],
): THREE.Box3 {
  const box = new THREE.Box3();
  if (!root || typeof root.traverseVisible !== 'function') return box;
  const one = new THREE.Box3();

  root.traverseVisible((object) => {
    if (!isModelPart(object)) return;
    if (object.parent && isModelPart(object.parent)) return;
    // A parsed model's outermost tagged object is its own root, which the registry
    // indexes — so this is the "is it mine" question asked through the public API, with
    // no need for a registry to know about objects it was not given.
    const id = object.userData[MODEL_ID_KEY];
    const owner =
      typeof id === 'string' ? registries.find((registry) => registry.get(id) !== null) : undefined;
    if (owner) {
      box.union(owner.visibleBounds(one));
      return;
    }
    box.expandByObject(object);
  });

  return box;
}
