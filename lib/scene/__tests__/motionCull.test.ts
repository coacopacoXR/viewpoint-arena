// The motion cull — task 06 step 3.
//
// What this file is for is the COMPOSITION. Hiding a part because it is two pixels across while
// the camera moves is a frame-rate trick, and the trick is only safe if it can never be mistaken
// for the two other things that hide a part: a person turning it off in the Model Tree, and a
// selection drawing it from somewhere else. So nearly every test here is about what a restore
// gives back, not about what a cull takes — a cull that took the wrong parts would be a picture
// somebody noticed, while a restore that gave back a hidden part is a setting that quietly
// undid itself.
//
// And, as everywhere else in this directory, both implementations answer the same fixture: a
// model is batched above BATCH_MIN_PARTS and drawn as the Object3Ds it was parsed as below it,
// and a frame-rate trick that only worked on one side of that number would be a trick.
//
// WHAT IS ASSERTED IS PICKABILITY, not a visibility flag. A culled part is not drawn and, in
// both registries, is not hit by a ray either — three's Raycaster never reads `Object3D.visible`,
// so MeshPartRegistry refuses an invisible object itself, and a batch slot that is off produces
// no hit for three to find. Raycasting is the one observable both sides share, and it is what a
// person clicking the model would actually get.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSceneTree } from '../../../utils/modelLoader';
import { MeshPartRegistry, hitParts, type PartRegistry, type PartState } from '../partRegistry';
import { BatchedPartRegistry } from '../batchedParts';
import { sceneModelPrefix } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'b2'.repeat(32);
const PREFIX = sceneModelPrefix(HASH);

/** The one selection glow the app has, copied for the reason batchedParts.test.ts copies it. */
const GLOW = { color: new THREE.Color(0x0044aa), intensity: 0.5 };

/** A housing two units across, and four fasteners two hundredths of a unit across beside it. */
const BIG = 2;
const TINY = 0.02;
/** Where the fasteners stand, clear of the housing's own silhouette so a ray reaches only them. */
const boltX = (index: number) => 3 + index * 0.5;

/**
 * The cull's two numbers, chosen the way components/Scene/MotionQuality.tsx chooses them.
 *
 * `k` is `MOTION_CULL_PIXELS · 2·tan(fov/2) / heightPx` with a 60° fov and a 900 px viewport,
 * which at 0.001 is a threshold of about 0.8 px — a part smaller than that is a speck. The eye is
 * 100 units away, so a fastener of radius 0.017 is well under `k · d` (0.1) and the housing's
 * 1.7 is well over it, and the model's own span puts the housing outside the sorted prefix the
 * index walks: this fixture exercises the cull AND the bound that keeps it off every part.
 */
const EYE = new THREE.Vector3(0, 0, 100);
const K = 0.001;
const view = () => ({ eye: EYE, k: K });

interface Fixture {
  root: THREE.Group;
  tree: SceneNode;
  idOf: Map<string, string>;
}

/** One housing and four fasteners, all sharing one material so a batch takes all four. */
function build(): Fixture {
  const material = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.6 });
  const root = new THREE.Group();
  root.name = 'Assembly';
  const objects = new Map<string, THREE.Object3D>();

  const housing = new THREE.Mesh(new THREE.BoxGeometry(BIG, BIG, BIG), material);
  housing.name = 'Housing';
  root.add(housing);
  objects.set('Housing', housing);

  // ONE geometry for all four, which is what a file that repeats a template does and what makes
  // the batched side's cull build one sphere rather than four.
  const boltGeometry = new THREE.BoxGeometry(TINY, TINY, TINY);
  for (let index = 0; index < 4; index += 1) {
    const bolt = new THREE.Mesh(boltGeometry, material);
    bolt.name = `Bolt ${index}`;
    bolt.position.set(boltX(index), 0, 0);
    root.add(bolt);
    objects.set(bolt.name, bolt);
  }

  const tree = buildSceneTree(root, { value: 0 }, PREFIX);
  if (!tree) throw new Error('fixture produced no tree');
  root.updateMatrixWorld(true);

  const idOf = new Map<string, string>();
  for (const [name, object] of objects) {
    const id = object.userData.modelId;
    if (typeof id === 'string') idOf.set(name, id);
  }
  return { root, tree, idOf };
}

/** The same fixture indexed both ways, which is what every parity assertion below runs over. */
function pair() {
  const meshSide = build();
  const batchSide = build();
  return [
    { side: meshSide, registry: new MeshPartRegistry(meshSide.root, meshSide.tree) as PartRegistry },
    { side: batchSide, registry: new BatchedPartRegistry(batchSide.root, batchSide.tree) as PartRegistry },
  ];
}

/** Whether a ray from the eye through x reaches anything this registry will name. */
function pickable(registry: PartRegistry, root: THREE.Object3D, x: number): boolean {
  // What a frame does before it draws, and what a highlight overlay needs: an overlay is
  // positioned by an explicit matrix with `matrixAutoUpdate` off, so its matrixWorld is composed
  // by the scene update and not by the write that placed it.
  root.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, 0, 100), new THREE.Vector3(0, 0, -1));
  return raycaster
    .intersectObjects([root], true)
    .some((hit) => hitParts(hit, [registry]).chain.length > 0);
}

/** The tree's own state for every part of a registry, with the listed ones changed. */
function statesFor(
  registry: PartRegistry,
  changed: Array<[string, Partial<PartState>]>,
): Record<string, PartState> {
  const over = new Map(changed);
  const out: Record<string, PartState> = {};
  for (const part of registry.parts()) {
    const one = over.get(part.id);
    out[part.id] = { visible: one?.visible ?? true, selected: one?.selected ?? false };
  }
  return out;
}

const idOf = (fixture: Fixture, name: string): string => {
  const id = fixture.idOf.get(name);
  if (!id) throw new Error(`the fixture has no part named ${name}`);
  return id;
};

describe('motionCull: what a moving camera stops drawing', () => {
  it('takes the parts under the threshold and leaves the ones over it, in both registries', () => {
    for (const { side, registry } of pair()) {
      const culled = registry.motionCull(view());
      // Four fasteners. The housing and the model's own root are both far too big to be
      // candidates, and the count is what MotionQuality would report if it ever logged one.
      expect(culled).toBe(4);
      for (let index = 0; index < 4; index += 1) {
        expect(pickable(registry, side.root, boltX(index))).toBe(false);
      }
      expect(pickable(registry, side.root, 0)).toBe(true);
    }
  });

  it('gives every part back on settle, and says nothing is left culled', () => {
    for (const { side, registry } of pair()) {
      registry.motionCull(view());
      expect(registry.motionCull(null)).toBe(0);
      for (let index = 0; index < 4; index += 1) {
        expect(pickable(registry, side.root, boltX(index))).toBe(true);
      }
      expect(pickable(registry, side.root, 0)).toBe(true);
    }
  });

  it('writes only what moved, so a second frame of the same viewpoint costs nothing', () => {
    const [{ side, registry }] = pair();
    registry.motionCull(view());
    // The same view again. Every part keeps the answer it had, and the index answers the same
    // count without a write — which is what makes a ten-second orbit cost four writes and not
    // four thousand, and is the reason the frame loop can afford to ask every frame.
    expect(registry.motionCull(view())).toBe(4);
    expect(pickable(registry, side.root, boltX(0))).toBe(false);
  });

  it('never gives back a part the person hid in the tree', () => {
    for (const { side, registry } of pair()) {
      const hidden = idOf(side, 'Bolt 0');
      registry.syncStates(statesFor(registry, [[hidden, { visible: false }]]), null);
      expect(pickable(registry, side.root, boltX(0))).toBe(false);

      registry.motionCull(view());
      registry.motionCull(null);

      // THE ASSERTION THIS FILE EXISTS FOR. A restore that went through the visibility path
      // would have written `true` here and quietly turned a part back on that somebody had
      // turned off, which is a setting undoing itself with nothing on screen to say so.
      expect(pickable(registry, side.root, boltX(0))).toBe(false);
      // And the parts the cull did take are back, so the restore was not simply a no-op.
      expect(pickable(registry, side.root, boltX(1))).toBe(true);

      // Showing it again in the tree still shows it: the user's flag was never overwritten.
      registry.syncStates(statesFor(registry, [[hidden, { visible: true }]]), null);
      expect(pickable(registry, side.root, boltX(0))).toBe(true);
    }
  });

  it('hides a part the tree hid while the camera is moving, and keeps it hidden after', () => {
    const [{ side, registry }] = pair();
    registry.motionCull(view());
    const hidden = idOf(side, 'Bolt 2');
    registry.syncStates(statesFor(registry, [[hidden, { visible: false }]]), null);
    registry.motionCull(null);
    expect(pickable(registry, side.root, boltX(2))).toBe(false);
    expect(pickable(registry, side.root, boltX(3))).toBe(true);
  });

  it('never culls a part somebody has selected', () => {
    for (const { side, registry } of pair()) {
      const selected = idOf(side, 'Bolt 1');
      registry.syncStates(statesFor(registry, [[selected, { selected: true }]]), GLOW);

      // Three of the four: the selected one is the part a person is looking at, and a glow that
      // vanished while the camera moved would be the one disappearance somebody would notice.
      expect(registry.motionCull(view())).toBe(3);
      expect(pickable(registry, side.root, boltX(1))).toBe(true);
      expect(pickable(registry, side.root, boltX(0))).toBe(false);

      registry.syncStates(statesFor(registry, [[selected, { selected: false }]]), null);
      // Unselected, and the camera is still moving: it is a candidate again.
      expect(registry.motionCull(view())).toBe(4);
      expect(pickable(registry, side.root, boltX(1))).toBe(false);
    }
  });

  it('measures a part where it has been moved to, not where the file put it', () => {
    for (const { side, registry } of pair()) {
      const bolt = registry.get(idOf(side, 'Bolt 0'));
      if (!bolt) throw new Error('no Bolt 0');
      // A gizmo drag that moved one fastener clear of the others and scaled it up to four units
      // across. The spheres were measured at build, so this is the case that has to dirty them —
      // and the registry notices without the drag having to tell it, because a transform write is
      // the one thing that grows `movedPartIds`.
      bolt.setLocalTransform({ position: [20, 0, 0], rotation: [0, 0, 0], scale: [200, 200, 200] });
      side.root.updateMatrixWorld(true);

      expect(registry.motionCull(view())).toBe(3);
      expect(pickable(registry, side.root, 20)).toBe(true);
      // The other three were not moved and are still specks, so they are still gone.
      expect(pickable(registry, side.root, boltX(1))).toBe(false);
      expect(pickable(registry, side.root, boltX(3))).toBe(false);
    }
  });

  it('measures a part moved a second time where it went the second time', () => {
    for (const { side, registry } of pair()) {
      const bolt = registry.get(idOf(side, 'Bolt 0'));
      if (!bolt) throw new Error('no Bolt 0');
      // Scaled up once and culled against, then shrunk back to a speck. The set of moved parts
      // is the same size both times, so an index keyed on that size would keep measuring the
      // four-unit part and leave a speck drawn — or, the other way round, cull a part that had
      // just been made big.
      bolt.setLocalTransform({ position: [20, 0, 0], rotation: [0, 0, 0], scale: [200, 200, 200] });
      side.root.updateMatrixWorld(true);
      expect(registry.motionCull(view())).toBe(3);

      bolt.setLocalTransform({ position: [20, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
      side.root.updateMatrixWorld(true);
      expect(registry.motionCull(view())).toBe(4);
      expect(pickable(registry, side.root, 20)).toBe(false);
    }
  });

  it('culles the same parts after the model has been placed somewhere else', () => {
    for (const { side, registry } of pair()) {
      // Placed 40 across and 20 back, with the eye moved the same way: the same view of the same
      // model, so the same four fasteners. The spheres are in the ROOT's space, so a placement
      // does not stale them and this costs no rebuild — which is the whole reason they are not in
      // the world's, and the reason dragging a model across the floor is free.
      side.root.position.set(40, 0, -20);
      side.root.updateMatrixWorld(true);
      expect(registry.motionCull({ eye: new THREE.Vector3(40, 0, 80), k: K })).toBe(4);
      for (let index = 0; index < 4; index += 1) {
        expect(pickable(registry, side.root, 40 + boltX(index))).toBe(false);
      }
      expect(pickable(registry, side.root, 40)).toBe(true);
    }
  });

  it('gives everything back when the eye is inside the model, where nothing is small', () => {
    const [{ registry }] = pair();
    expect(registry.motionCull(view())).toBe(4);
    // Up close, `k · d` falls under every radius in the file, so the sorted prefix is empty and
    // the answer is nothing culled. A zoom that hid MORE would be the bug this checks for.
    expect(registry.motionCull({ eye: new THREE.Vector3(3, 0, 0.4), k: K })).toBe(0);
  });
});
