// Where an agent can be sent to look inside a model — task 04b stage 3, the render half
// of the audit's D3.
//
// Two things are pinned here that the mesh walk this replaces got wrong or could not do:
//
//   • it is measured through the registry. `Box3.setFromObject` over a parsed hierarchy is
//     the measurement that stops existing once a part is a slot in a batch, and a handle's
//     box is the same answer either way.
//   • it is CAPPED. A POI is a place to stand and look, and a 40 000-part assembly has
//     40 000 of them; the walk registered every one of them with its own store write. The
//     cap is the same number of components the extraction prompt is allowed, and it keeps
//     the LARGEST, because size is the only signal available at parse time that correlates
//     with "the part somebody means when they say the product".
//
// The store half of D3 — one write instead of one per part — is in
// __tests__/poiBatchWrite.test.ts.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { modelPointsOfInterest } from '../ImportedModel';
import { MeshPartRegistry } from '../../../lib/scene/partRegistry';
import { buildSceneTree } from '../../../utils/modelLoader';
import { DEFAULT_MAX_COMPONENTS } from '../../../lib/componentIndex';
import { applyPartTransforms } from '../../../lib/scene/partTransforms';

const MATERIAL = new THREE.MeshStandardMaterial({ color: 0x888888 });

/**
 * A model of `count` boxes whose volume grows with the index, tagged and indexed the way a
 * parse tags and indexes one — buildSceneTree does the tagging, so the registry is built
 * from the same thing lib/scene/sceneEntries.ts builds it from.
 *
 * Growing volume is what makes the cap testable: "the largest" and "the last" are the same
 * set, so a cap that kept the first `max` in tree order — which is what an uncapped
 * `flattenSceneTree`-style walk would do — is caught rather than passing by accident.
 */
function assembly(count: number) {
  const root = new THREE.Group();
  root.name = 'Assembly';
  for (let index = 0; index < count; index += 1) {
    const side = index + 1;
    const box = new THREE.Mesh(new THREE.BoxGeometry(side, side, side), MATERIAL);
    box.name = `Part ${index}`;
    box.position.set(index * 10, 0, 0);
    root.add(box);
  }
  const tree = buildSceneTree(root, { value: 0 }, 'poi');
  if (!tree) throw new Error('fixture produced no tree');
  root.updateMatrixWorld(true);
  return { root, tree, registry: new MeshPartRegistry(root, tree) };
}

describe('modelPointsOfInterest', () => {
  it('answers one POI per part, at the part\'s own world centre, named the way the tree names it', () => {
    const { tree, registry } = assembly(3);

    const pois = modelPointsOfInterest(registry, tree);

    expect(pois.map((poi) => poi.label)).toEqual(['Part 0', 'Part 1', 'Part 2']);
    expect(pois.map((poi) => poi.id)).toEqual(['poi_1', 'poi_2', 'poi_3']);
    // World, not parent space: a 2×2×2 box standing at x=10 has its centre at x=10, and an
    // agent that read a parent-space centre would look ten units off.
    expect(pois[0].position.toArray()).toEqual([0, 0, 0]);
    expect(pois[1].position.toArray()).toEqual([10, 0, 0]);
    expect(pois[2].position.toArray()).toEqual([20, 0, 0]);
    expect(pois.every((poi) => poi.type === 'GENERAL')).toBe(true);
  });

  it('answers the parts, not the containers they sit in', () => {
    // The root's box is the whole model and a sub-assembly's is the union of everything
    // inside it, so a cap that ranked the registry's own `parts()` by volume would have
    // answered the containers first — 200 places for an agent to stand and look at the
    // middle of an assembly, and not one fastener.
    const root = new THREE.Group();
    root.name = 'Assembly';
    const sub = new THREE.Group();
    sub.name = 'Sub';
    const big = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), MATERIAL);
    big.name = 'Big';
    sub.add(big);
    const small = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), MATERIAL);
    small.name = 'Small';
    small.position.set(40, 0, 0);
    root.add(sub, small);
    const tree = buildSceneTree(root, { value: 0 }, 'poi')!;
    root.updateMatrixWorld(true);
    const registry = new MeshPartRegistry(root, tree);

    expect(modelPointsOfInterest(registry, tree).map((poi) => poi.label)).toEqual(['Big', 'Small']);
    // And with room for only one, it is the part with the most metal in it.
    expect(modelPointsOfInterest(registry, tree, 1).map((poi) => poi.label)).toEqual(['Big']);
  });

  it('drops nothing and reorders nothing under the cap', () => {
    const { tree, registry } = assembly(5);

    const pois = modelPointsOfInterest(registry, tree);

    // Tree order, which is the order the traverse this replaced produced, so a model
    // nobody would call large behaves exactly as it did before the cap existed.
    expect(pois).toHaveLength(5);
    expect(pois.map((poi) => poi.id)).toEqual(['poi_1', 'poi_2', 'poi_3', 'poi_4', 'poi_5']);
  });

  it('caps at DEFAULT_MAX_COMPONENTS and keeps the largest', () => {
    const total = DEFAULT_MAX_COMPONENTS + 40;
    const { tree, registry } = assembly(total);

    const pois = modelPointsOfInterest(registry, tree);

    expect(pois).toHaveLength(DEFAULT_MAX_COMPONENTS);
    const kept = new Set(pois.map((poi) => poi.label));
    // The 40 smallest went, the biggest stayed. Every one of these is a place an agent can
    // be sent to look, so which 200 survive is the whole of the cap's visible effect.
    expect(kept.has('Part 0')).toBe(false);
    expect(kept.has(`Part ${total - 1}`)).toBe(true);
    expect(kept.size).toBe(DEFAULT_MAX_COMPONENTS);
  });

  it('honours a cap of its own, so the number is a parameter and not a constant baked in', () => {
    const { tree, registry } = assembly(6);

    expect(modelPointsOfInterest(registry, tree, 2).map((poi) => poi.label)).toEqual(['Part 5', 'Part 4']);
  });

  it('aims at where a moved part now stands, which is why it runs after applyPartTransforms', () => {
    const { tree, registry } = assembly(3);
    const before = modelPointsOfInterest(registry, tree)[2].position.clone();

    applyPartTransforms(registry, tree.id, { poi_3: { position: [99, 0, 0] } });
    const after = modelPointsOfInterest(registry, tree)[2].position;

    // A flange pulled out to show a clearance is exactly the part somebody wants an agent
    // to look at, and the laser points where the part IS rather than where the file had it.
    expect(after.x).toBeCloseTo(99, 5);
    expect(after.x - before.x).toBeCloseTo(79, 5);
  });
});
