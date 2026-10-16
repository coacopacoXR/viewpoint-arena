// The batched part registry — task 04b stage 4.
//
// What this file is for is PARITY, not cleverness. A model is drawn as batches above
// BATCH_MIN_PARTS and as the Object3Ds it was parsed as below it, and the app cannot be
// allowed to behave differently on either side of a number that depends only on how many
// parts a file happened to have. So nearly every test here builds the SAME fixture twice —
// once through MeshPartRegistry, once through BatchedPartRegistry — and asserts the two
// answer alike. Where a test does not do that, it is about something only a batch can do.
//
// The risks from the render audit that have a silent failure mode are each covered:
//
//   • R1 — `bounds()` must be the box `Box3.setFromObject` measures, because every caller
//     reads a wrong or an empty box as "there is nothing to frame" and the thumbnails go
//     blank rather than throwing. A batch's geometry is the merged buffer in the batch's own
//     space, so this is the measurement batching is most likely to get quietly wrong.
//   • R2 — a hidden part must not be pickable, and must be pickable again at the SAME id once
//     it is shown. This is the invariant at the foot of components/Scene/ImportedModel.tsx:
//     pointing at where a hidden part was should point at whatever is behind it, which is why
//     somebody hid it.
//   • R6/R10 — build, dispose, and nothing the registry allocated is left behind. A batch owns
//     buffers three does not free on a dropped reference, and the lobby mounts a viewer per
//     review, so a leak there is one per review scrolled past.
//   • The perf gate — the draw objects must be a function of the MATERIALS and not of the
//     parts, and one selection change must still cost the parts that changed.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { OcctImportResult, OcctMesh } from 'occt-import-js';
import { cadResultToGroup } from '../../../utils/cadToThree';
import { buildSceneTree } from '../../../utils/modelLoader';
import { countParts } from '../../../store';
import { applyPartTransforms, usablePartScale } from '../partTransforms';
import { MeshPartRegistry, hitParts, isPointableHit, type PartHandle, type PartRegistry, type PartState } from '../partRegistry';
import { BATCH_MIN_PARTS, BatchedPartRegistry, MAX_OVERLAY_PARTS, partRegistryFor } from '../batchedParts';
import { partHighlightFlags, partHighlightMaterial } from '../materialHighlight';
import { hideEditingHelpers } from '../captureClean';
import { sceneModelPrefix } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'a1'.repeat(32);
const PREFIX = sceneModelPrefix(HASH);

/**
 * The one selection glow the app has: components/Scene/ImportedModel.tsx's
 * SELECTION_HIGHLIGHT, copied rather than imported because a component module cannot be
 * imported into a node test without dragging R3F and a canvas with it.
 */
const GLOW = { color: new THREE.Color(0x0044aa), intensity: 0.5 };

type Triple = [number, number, number];

const at = (position: Triple, rotation: Triple = [0, 0, 0], scale: Triple = [1, 1, 1]) => ({
  position,
  rotation,
  scale,
});

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A shape a fixture can be built to, so the SAME model can be handed to both registries. */
interface FixtureShape {
  /** How many bolts per group. */
  perGroup?: number;
  /** One BufferGeometry for every bolt, which is what a file that repeats a template does. */
  sharedGeometry?: boolean;
  /** Give one part a material array, which batching cannot represent. */
  multiMaterial?: boolean;
  /** Throw one part 100 units out along x, which is the case placement exists for. */
  scattered?: boolean;
}

interface Fixture {
  root: THREE.Group;
  tree: SceneNode;
  /** Named object → the Object3D it was parsed as. Only meaningful before batching. */
  objects: Map<string, THREE.Object3D>;
  /** The id buildSceneTree gave each named object. */
  idOf: Map<string, string>;
}

/**
 * Build one fixture. Called twice per test — once to be indexed by each implementation — so
 * that "the two registries agree" is a statement about two independent builds of one
 * description and not about one object read two ways.
 *
 * Two groups of two bolts on two materials, so there is more than one batch, a group to hide
 * and to move, and leaves to hide inside it.
 */
function build(shape: FixtureShape = {}, prefix: string = PREFIX): Fixture {
  const perGroup = shape.perGroup ?? 2;
  const steel = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.6, roughness: 0.4 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xaa8844, metalness: 0.8, roughness: 0.3 });
  const shared = shape.sharedGeometry ? new THREE.BoxGeometry(1, 1, 1) : null;
  const objects = new Map<string, THREE.Object3D>();
  const idOf = new Map<string, string>();

  const root = new THREE.Group();
  root.name = 'Assembly';
  objects.set('Assembly', root);

  const bolt = (name: string, position: Triple, material: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(shared ?? new THREE.BoxGeometry(1, 1, 1), material);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    objects.set(name, mesh);
    return mesh;
  };

  for (const [groupName, material, sign] of [['Left', steel, -1], ['Right', brass, 1]] as const) {
    const group = new THREE.Group();
    group.name = groupName;
    for (let index = 0; index < perGroup; index += 1) {
      const far = shape.scattered === true && groupName === 'Left' && index === 0;
      group.add(bolt(`${groupName} Bolt ${index}`, [sign * (far ? 100 : 2 + index), index, 0], material));
    }
    if (shape.multiMaterial === true && groupName === 'Right') {
      // A material array is geometry groups: utils/cadToThree splits a solid whose faces
      // differ in colour into one material each, and a batch draws one material.
      const split = new THREE.Mesh(shared ?? new THREE.BoxGeometry(1, 1, 1), [steel, brass]);
      split.name = 'Split Face';
      split.position.set(sign * 8, 0, 0);
      objects.set('Split Face', split);
      group.add(split);
    }
    objects.set(groupName, group);
    root.add(group);
  }

  const tree = buildSceneTree(root, { value: 0 }, prefix);
  if (!tree) throw new Error('fixture produced no tree');
  for (const [name, object] of objects) {
    const id = object.userData.modelId;
    if (typeof id === 'string') idOf.set(name, id);
  }
  root.updateMatrixWorld(true);
  return { root, tree, objects, idOf };
}

/** The same fixture indexed both ways, which is what most of this file asserts on. */
function pair(shape: FixtureShape = {}) {
  const meshSide = build(shape);
  const batchSide = build(shape);
  return {
    meshSide,
    batchSide,
    mesh: new MeshPartRegistry(meshSide.root, meshSide.tree),
    batched: new BatchedPartRegistry(batchSide.root, batchSide.tree),
  };
}

/** Every id in a SceneNode tree, pre-order — the order buildSceneTree minted them in. */
function treeIds(node: SceneNode, out: string[] = []): string[] {
  out.push(node.id);
  for (const child of node.children ?? []) treeIds(child, out);
  return out;
}

const idsOf = (registry: PartRegistry): string[] => registry.parts().map((part) => part.id);

/** The part a fixture named, or a thrown explanation of which of the two lookups failed. */
function partNamed(fixture: Fixture, registry: PartRegistry, name: string): PartHandle {
  const id = fixture.idOf.get(name);
  if (!id) throw new Error(`the fixture has no part named ${name}`);
  const handle = registry.get(id);
  if (!handle) throw new Error(`the registry has no part ${id} (${name})`);
  return handle;
}

/** How many objects in a graph the renderer would issue a draw call for. */
function drawables(root: THREE.Object3D): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh === true && mesh.geometry) found.push(object);
  });
  return found;
}

const batchesOf = (root: THREE.Object3D) =>
  drawables(root).filter((one) => (one as THREE.BatchedMesh).isBatchedMesh === true) as THREE.BatchedMesh[];

/**
 * The ids a ray answers, nearest first, skipping the hits that resolve to nothing.
 *
 * A real Raycaster over the real graph, which is what the laser and the click both do: a
 * BatchedMesh answers from `batchId` rather than from the object, so a fake hit would test
 * the mapping and not the pick.
 */
function picked(registry: BatchedPartRegistry | MeshPartRegistry, root: THREE.Object3D, from: Triple): string[] {
  const raycaster = new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(0, 0, -1));
  const resolved: string[] = [];
  for (const hit of raycaster.intersectObjects([root], true)) {
    const parts = hitParts(hit, [registry]);
    if (parts.chain.length > 0) resolved.push(parts.chain[0]);
  }
  return resolved;
}

/** A model of `count` parts under `materials` distinct materials, all one shared geometry. */
function assembly(count: number, materials: number): Fixture {
  const root = new THREE.Group();
  root.name = 'Big';
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const palette = Array.from(
    { length: materials },
    (_, index) => new THREE.MeshStandardMaterial({ color: 0x808080 + index }),
  );
  for (let index = 0; index < count; index += 1) {
    const mesh = new THREE.Mesh(geometry, palette[index % materials]);
    mesh.name = `Part ${index}`;
    mesh.position.set(index % 40, Math.floor(index / 40) % 40, Math.floor(index / 1600));
    root.add(mesh);
  }
  const tree = buildSceneTree(root, { value: 0 }, PREFIX);
  if (!tree) throw new Error('fixture produced no tree');
  root.updateMatrixWorld(true);
  return { root, tree, objects: new Map(), idOf: new Map() };
}

const statesFor = (ids: readonly string[], changed: Array<[string, Partial<PartState>]>) => {
  const over = new Map(changed);
  const out: Record<string, PartState> = {};
  for (const id of ids) {
    const one = over.get(id);
    out[id] = { visible: one?.visible ?? true, selected: one?.selected ?? false };
  }
  return out;
};

// ─── the contract everything else rests on ──────────────────────────────────

describe('parity: the two implementations index the same parts', () => {
  it('answers the same ids in the same order, and the same names', () => {
    const { meshSide, mesh, batched } = pair({ multiMaterial: true });

    expect(idsOf(batched)).toEqual(idsOf(mesh));
    expect(idsOf(batched)).toEqual(treeIds(meshSide.tree));
    expect(batched.parts().map((part) => part.name)).toEqual(mesh.parts().map((part) => part.name));
  });

  it('leaves the tree, and so the "N parts" line, exactly as the parse made it', () => {
    // R8: batching runs AFTER buildSceneTree, on the hierarchy it tagged, and prunes only
    // objects the tree has already finished with. Run the other way round and the part count
    // in the import status line and the rows in the Model Tree would both move.
    const { meshSide, mesh, batched } = pair({ multiMaterial: true });

    // Assembly, Left, Right, and five meshes under them.
    expect(treeIds(meshSide.tree)).toHaveLength(8);
    expect(countParts(meshSide.tree)).toBe(5);
    expect(batched.parts()).toHaveLength(mesh.parts().length);
    expect(batched.get(meshSide.tree.id)).not.toBeNull();
  });

  it('is what partRegistryFor picks, on either side of the threshold', () => {
    // One tagged object is the root, so BATCH_MIN_PARTS - 1 meshes is the threshold exactly.
    const below = assembly(BATCH_MIN_PARTS - 2, 2);
    expect(partRegistryFor(below.root, below.tree)).toBeInstanceOf(MeshPartRegistry);

    const atLine = assembly(BATCH_MIN_PARTS - 1, 2);
    expect(partRegistryFor(atLine.root, atLine.tree)).toBeInstanceOf(BatchedPartRegistry);
  });

  it('is chosen by the part count alone, so the same bytes give the same ids everywhere', () => {
    // The threshold is a property of the file, which is what makes the ids in
    // lib/scene/sceneEntries.ts mean the same thing in every room: they come from the file's
    // hash, and a pin names the part it was dropped on.
    const one = assembly(BATCH_MIN_PARTS + 40, 3);
    const two = assembly(BATCH_MIN_PARTS + 40, 3);
    expect(partRegistryFor(one.root, one.tree)).toBeInstanceOf(BatchedPartRegistry);
    expect(idsOf(partRegistryFor(two.root, two.tree))).toEqual(treeIds(two.tree));
  });
});

describe('a real parse, indexed both ways', () => {
  const triangle = (): Pick<OcctMesh, 'attributes' | 'index'> => ({
    attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
    index: { array: [0, 1, 2] },
  });

  const BYTES = JSON.stringify({
    success: true,
    root: {
      name: 'Assembly',
      meshes: [0],
      children: [{ name: 'Bracket', meshes: [1, 2], children: [] }],
    },
    meshes: [
      { name: 'Base Plate', color: [1, 0, 0], brep_faces: [], ...triangle() },
      { name: '', color: [0, 1, 0], brep_faces: [], ...triangle() },
      { name: 'Pad', color: [0, 0, 1], brep_faces: [], ...triangle() },
    ],
  } satisfies OcctImportResult);

  function parse() {
    const result: OcctImportResult = JSON.parse(new TextDecoder().decode(new TextEncoder().encode(BYTES)));
    const root = cadResultToGroup(result, 'cube');
    const tree = buildSceneTree(root, { value: 0 }, PREFIX);
    if (!tree) throw new Error('fixture produced no tree');
    root.updateMatrixWorld(true);
    return { root, tree };
  }

  it('agrees on ids, order and names for bytes rather than for hand-built objects', () => {
    const one = parse();
    const two = parse();
    const mesh = new MeshPartRegistry(one.root, one.tree);
    const batched = new BatchedPartRegistry(two.root, two.tree);

    // R11: two independent parses of the same bytes. This is the pin contract.
    expect(idsOf(batched)).toEqual(idsOf(mesh));
    expect(idsOf(batched)).toEqual(treeIds(one.tree));
    expect(batched.parts().map((part) => part.name)).toEqual(mesh.parts().map((part) => part.name));
  });

  it('measures the same box for a CAD assembly', () => {
    const one = parse();
    const two = parse();
    const viaMesh = new MeshPartRegistry(one.root, one.tree).bounds(new THREE.Box3());
    const viaBatched = new BatchedPartRegistry(two.root, two.tree).bounds(new THREE.Box3());

    expect(viaBatched.min.distanceTo(viaMesh.min)).toBeLessThan(1e-9);
    expect(viaBatched.max.distanceTo(viaMesh.max)).toBeLessThan(1e-9);
    expect(viaBatched.isEmpty()).toBe(false);
  });
});

// ─── R1: the box ────────────────────────────────────────────────────────────

describe('R1: the box every caller used to measure with Box3.setFromObject', () => {
  it('is the same box for a model whose parts are far from its own origin', () => {
    const { meshSide, batched } = pair({ scattered: true });

    const viaBatched = batched.bounds(new THREE.Box3());
    const viaThree = new THREE.Box3().setFromObject(meshSide.root);

    expect(viaBatched.min.distanceTo(viaThree.min)).toBeLessThan(1e-9);
    expect(viaBatched.max.distanceTo(viaThree.max)).toBeLessThan(1e-9);
    // And not degenerate: a box that quietly answered the merged buffer would still be a box,
    // and every caller reads a wrong one as "there is nothing to frame". The far part is 100
    // units out along MINUS x, which is the direction a CAD file in millimetres goes.
    expect(viaBatched.min.x).toBeLessThan(-90);
  });

  it('follows the model once it has been scaled and dropped on the floor', () => {
    // Every caller runs AFTER something moved the geometry: placeImportedGroup scales the group
    // and then measures it to find the floor, a variant moves individual parts, and the lobby
    // measures a group it has just placed. A box captured at build would be the box of a model
    // nobody is looking at yet — which is why the instance matrices are kept in the ROOT's
    // space and the root's own transform is left to the scene graph.
    const { meshSide, batchSide, batched } = pair({ scattered: true });
    for (const root of [meshSide.root, batchSide.root]) {
      root.scale.setScalar(0.02);
      root.position.set(0, 3, 0);
      root.updateMatrixWorld(true);
    }

    const viaBatched = batched.bounds(new THREE.Box3());
    const viaThree = new THREE.Box3().setFromObject(meshSide.root);
    expect(viaBatched.min.distanceTo(viaThree.min)).toBeLessThan(1e-9);
    expect(viaBatched.max.distanceTo(viaThree.max)).toBeLessThan(1e-9);
  });

  it('answers the same box per part, including for a group', () => {
    const { meshSide, batchSide, mesh, batched } = pair();
    const viaMesh = new THREE.Box3();
    const viaBatched = new THREE.Box3();

    for (const name of ['Assembly', 'Left', 'Left Bolt 0', 'Right Bolt 1']) {
      partNamed(meshSide, mesh, name).getBoundingBox(viaMesh);
      partNamed(batchSide, batched, name).getBoundingBox(viaBatched);
      expect(viaBatched.min.distanceTo(viaMesh.min), name).toBeLessThan(1e-9);
      expect(viaBatched.max.distanceTo(viaMesh.max), name).toBeLessThan(1e-9);
    }
  });

  it('visibleBounds is bounds while the model is shown, and empty once it is not', () => {
    // Deliberately NOT per part, and the same answer MeshPartRegistry gives: a part hidden
    // inside a model that is still shown has never come out of this box, and a batch could
    // exclude one now. Doing so would frame a thumbnail differently on either side of the
    // threshold, which is the one thing this file exists to prevent.
    const { batchSide, batched } = pair();

    expect(batched.visibleBounds(new THREE.Box3()).equals(batched.bounds(new THREE.Box3()))).toBe(true);

    batched.get(batchSide.tree.id)!.setVisible(false);
    expect(batched.visibleBounds(new THREE.Box3()).isEmpty()).toBe(true);
    // The geometry has not gone anywhere, and the floor must not move with the eye toggle.
    expect(batched.bounds(new THREE.Box3()).isEmpty()).toBe(false);

    batched.get(batchSide.tree.id)!.setVisible(true);
    expect(batched.visibleBounds(new THREE.Box3()).isEmpty()).toBe(false);
  });
});

// ─── R2: a hidden part is not there to point at ─────────────────────────────

describe('R2: hide a part and it is not pickable, show it and it is', () => {
  /**
   * Two bolts one behind the other along the ray, sharing a material so they land in the SAME
   * batch. Which is the case that matters: two batches could each refuse a hit and look
   * correct while one batch silently answered for a slot it was not drawing.
   */
  function stacked() {
    const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const root = new THREE.Group();
    root.name = 'Stack';
    const near = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
    near.name = 'Near';
    const far = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
    far.name = 'Far';
    far.position.z = -10;
    root.add(near, far);
    const tree = buildSceneTree(root, { value: 0 }, PREFIX);
    if (!tree) throw new Error('fixture produced no tree');
    root.updateMatrixWorld(true);
    return {
      root,
      registry: new BatchedPartRegistry(root, tree),
      near: near.userData.modelId as string,
      far: far.userData.modelId as string,
    };
  }

  it('answers the part BEHIND a hidden one, which is why somebody hid it', () => {
    // Audit §3.7 item 2. This invariant did not hold for a part before stage 4: three's
    // Raycaster never reads `visible`, so hiding a mesh left it answering clicks and only a
    // hidden MODEL — which React unmounts — stayed out. A batch cannot do that, because
    // `setVisibleAt` is read by BatchedMesh.raycast as well as by its draw list, so both
    // implementations now refuse a hidden part.
    const fixture = stacked();
    expect(picked(fixture.registry, fixture.root, [0, 0, 10])[0]).toBe(fixture.near);

    fixture.registry.get(fixture.near)!.setVisible(false);
    expect(picked(fixture.registry, fixture.root, [0, 0, 10])[0]).toBe(fixture.far);
  });

  it('is pickable again at the SAME id once it is shown, having moved twice', () => {
    // Audit §3.7 item 3. The id is what the wire, the pins and the comments carry, so a hide
    // that renumbered anything would leave a pin pointing at a different part after two
    // toggles. Nothing here renumbers: a slot means the same part for the registry's life.
    const fixture = stacked();
    const handle = fixture.registry.get(fixture.near)!;
    const from: Triple = [0, 0, 10];

    handle.setVisible(false);
    expect(picked(fixture.registry, fixture.root, from)).not.toContain(fixture.near);
    handle.setVisible(true);
    expect(picked(fixture.registry, fixture.root, from)[0]).toBe(fixture.near);

    handle.setVisible(false);
    handle.setVisible(true);
    expect(picked(fixture.registry, fixture.root, from)[0]).toBe(fixture.near);
    expect(handle.name).toBe('Near');
    expect(fixture.registry.get(fixture.near)).toBe(handle);
  });

  it('takes a whole subtree out of the pick when a group is hidden', () => {
    const { batchSide, batched } = pair();
    const left = batchSide.idOf.get('Left')!;
    const bolt = batchSide.idOf.get('Left Bolt 0')!;
    const from: Triple = [-2, 0, 5];

    expect(picked(batched, batchSide.root, from)[0]).toBe(bolt);
    batched.get(left)!.setVisible(false);
    expect(picked(batched, batchSide.root, from)).not.toContain(bolt);
    // The part is still addressable — the tree still lists it, and showing the group again has
    // to bring it back — it is simply not drawn and not hit.
    expect(batched.get(bolt)).not.toBeNull();

    batched.get(left)!.setVisible(true);
    expect(picked(batched, batchSide.root, from)[0]).toBe(bolt);
  });

  it('agrees with the mesh registry about what a hide costs', () => {
    const { meshSide, batchSide, mesh, batched } = pair();
    const ids = idsOf(mesh);
    const hide = statesFor(ids, [[meshSide.idOf.get('Left')!, { visible: false }]]);

    expect(batched.syncStates(hide, GLOW)).toBe(mesh.syncStates(hide, GLOW));
    expect(batched.syncStates(hide, GLOW)).toBe(0);
    expect(batchSide.root.visible).toBe(meshSide.root.visible);
  });
});

// ─── §3.5: an override replaces the file's transform ────────────────────────

describe('§3.5: an override replaces, and a reset puts the part back', () => {
  it('is idempotent, and removing it restores the bind pose', () => {
    const { batchSide, batched } = pair();
    const bolt = partNamed(batchSide, batched, 'Left Bolt 0');
    const bind = bolt.bindPose();
    const override = at([bind.position[0] + 3, bind.position[1], bind.position[2]]);

    bolt.setLocalTransform(override);
    const once = bolt.getMatrix(new THREE.Matrix4()).clone();
    bolt.setLocalTransform(override);
    expect(bolt.getMatrix(new THREE.Matrix4()).equals(once)).toBe(true);

    applyPartTransforms(batched, batchSide.tree.id, {});
    expect(bolt.getLocalTransform()).toEqual(bind);
    expect(bolt.bindPose()).toEqual(bind);
  });

  it('moves every part below a group that was moved', () => {
    // A slot has no parent to inherit from, so moving an assembly has to move every bolt in it
    // by hand. This is the case a per-part matrix composition gets wrong most easily.
    const { meshSide, batchSide, mesh, batched } = pair();
    const move = at([5, -2, 1]);
    applyPartTransforms(mesh, meshSide.tree.id, { [meshSide.idOf.get('Left')!]: move });
    applyPartTransforms(batched, batchSide.tree.id, { [batchSide.idOf.get('Left')!]: move });

    const viaMesh = new THREE.Box3();
    const viaBatched = new THREE.Box3();
    for (const name of ['Left', 'Left Bolt 0', 'Left Bolt 1', 'Right Bolt 0']) {
      partNamed(meshSide, mesh, name).getBoundingBox(viaMesh);
      partNamed(batchSide, batched, name).getBoundingBox(viaBatched);
      expect(viaBatched.min.distanceTo(viaMesh.min), name).toBeLessThan(1e-9);
      expect(viaBatched.max.distanceTo(viaMesh.max), name).toBeLessThan(1e-9);
    }
    // And the parts outside the moved group did not move with it.
    expect(partNamed(batchSide, batched, 'Right Bolt 0').getBoundingBox(new THREE.Box3()).min.x)
      .toBeCloseTo(1.5, 6);
  });

  it('falls back per axis on a scale dragged through zero', () => {
    const { batchSide, batched } = pair();
    const bolt = partNamed(batchSide, batched, 'Left Bolt 0');
    const bind = bolt.bindPose();

    const usable = usablePartScale([0, -2, 3], bind.scale);
    expect(usable).toEqual([bind.scale[0], bind.scale[1], 3]);

    bolt.setLocalTransform({ ...bind, scale: usable });
    expect(bolt.getLocalTransform().scale).toEqual(usable);
  });

  it("answers the file's own numbers from bindPose after the part has moved", () => {
    // The bind pose is filled at build under batching, which is what makes the lazy stamp
    // lib/scene/partTransforms.ts used to write unnecessary: building the batches touches
    // every part once anyway, so there is no allocation left to avoid.
    const { batchSide, batched } = pair();
    const bolt = partNamed(batchSide, batched, 'Right Bolt 1');
    const bind = bolt.bindPose();

    bolt.setLocalTransform(at([9, 9, 9], [0.5, 0, 0], [2, 2, 2]));
    expect(bolt.bindPose()).toEqual(bind);
    expect(batched.movedPartIds()).toContain(bolt.id);
  });

  it('reads back through getMatrix what setMatrix wrote', () => {
    const { batchSide, batched } = pair();
    const bolt = partNamed(batchSide, batched, 'Left Bolt 1');
    const moved = new THREE.Matrix4().compose(
      new THREE.Vector3(1, 2, 3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0.5, 0)),
      new THREE.Vector3(2, 2, 2),
    );

    bolt.setMatrix(moved);

    // Compared with a tolerance and not with `equals`, for the reason
    // lib/scene/__tests__/partRegistry.test.ts gives and one more besides: a matrix written
    // through a handle goes decompose → compose, and a batched part has one further leg —
    // there is no Object3D left to hold a quaternion, so the rotation is stored as the three
    // Euler numbers a PartTransform carries and recomposed on the way back out.
    //
    // The path that has to be EXACT is `setLocalTransform`/`getLocalTransform`, because that
    // is the one "Reset part" and a PartTransform relayed from the room both take, and
    // applyPartTransforms compares those numbers with `===` to decide whether to write.
    const readBack = bolt.getMatrix(new THREE.Matrix4()).elements;
    moved.elements.forEach((value, index) => {
      expect(readBack[index], `element ${index}`).toBeCloseTo(value, 10);
    });
    const local = bolt.getLocalTransform();
    expect(local.position).toEqual([1, 2, 3]);
    expect(local.rotation[0]).toBeCloseTo(0.25, 10);
    local.scale.forEach((value, axis) => expect(value, `scale axis ${axis}`).toBeCloseTo(2, 10));

    const bind = bolt.bindPose();
    bolt.setLocalTransform(bind);
    expect(bolt.getLocalTransform()).toEqual(bind);
  });
});

// ─── decision 1(c): the highlight is an overlay ─────────────────────────────

describe('D1: a highlight belongs to the part that was selected', () => {
  it("lights one bolt and leaves the other on the file's own material", () => {
    const { batchSide, batched } = pair();
    const left = partNamed(batchSide, batched, 'Left Bolt 0');
    const steel = (batchSide.objects.get('Left Bolt 0') as THREE.Mesh).material as THREE.MeshStandardMaterial;

    left.setHighlight(GLOW);

    // The defect, and the assertion that fails without the overlay: both bolts share ONE
    // material, so writing the glow onto it lit all four hundred of an assembly's bolts.
    expect(steel.emissive.getHex()).toBe(0x000000);
    expect(steel.userData.originalEmissive).toBeUndefined();

    left.setHighlight(null);
    expect(steel.emissive.getHex()).toBe(0x000000);
  });

  it('draws the glowing part from an overlay and turns its own slot off underneath', () => {
    const { batchSide, batched } = pair();
    const left = partNamed(batchSide, batched, 'Left Bolt 0');
    const before = drawables(batchSide.root).length;
    expect(batchesOf(batchSide.root)).toHaveLength(2);

    left.setHighlight(GLOW);
    const overlays = drawables(batchSide.root).filter((one) => one.name === 'PartHighlight');
    expect(overlays).toHaveLength(1);
    expect(drawables(batchSide.root)).toHaveLength(before + 1);

    const overlay = overlays[0] as THREE.Mesh;
    expect((overlay.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0x0044aa);
    expect((overlay.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.5);

    // Standing exactly on the part, which is the only thing that makes the look unchanged.
    batchSide.root.updateMatrixWorld(true);
    const viaOverlay = new THREE.Box3().setFromObject(overlay);
    const viaHandle = left.getBoundingBox(new THREE.Box3());
    expect(viaOverlay.min.distanceTo(viaHandle.min)).toBeLessThan(1e-9);
    expect(viaOverlay.max.distanceTo(viaHandle.max)).toBeLessThan(1e-9);

    left.setHighlight(null);
    expect(drawables(batchSide.root).filter((one) => one.name === 'PartHighlight')).toHaveLength(0);
    expect(drawables(batchSide.root)).toHaveLength(before);
  });

  it('keeps a highlighted part pickable, as itself', () => {
    const { batchSide, batched } = pair();
    const left = partNamed(batchSide, batched, 'Left Bolt 0');
    left.setHighlight(GLOW);
    batchSide.root.updateMatrixWorld(true);

    // Its slot is off under the overlay, so if the overlay were looked through the selected
    // part — the one people point at and pin — would be the one part nobody could hit.
    const center = left.getBoundingBox(new THREE.Box3()).getCenter(new THREE.Vector3());
    const raycaster = new THREE.Raycaster(center.clone().setZ(center.z + 50), new THREE.Vector3(0, 0, -1));
    const first = raycaster.intersectObjects([batchSide.root], true).find(isPointableHit);
    expect(first?.object.name).toBe('PartHighlight');
    expect(hitParts(first!, [batched]).chain[0]).toBe(left.id);
  });

  it('reuses one clone per source material, however many parts share it', () => {
    const { batchSide, batched } = pair();
    const first = partNamed(batchSide, batched, 'Left Bolt 0');
    const second = partNamed(batchSide, batched, 'Left Bolt 1');

    first.setHighlight(GLOW);
    const material = (drawables(batchSide.root).find((one) => one.name === 'PartHighlight') as THREE.Mesh).material;
    second.setHighlight(GLOW);
    const materials = drawables(batchSide.root)
      .filter((one) => one.name === 'PartHighlight')
      .map((one) => (one as THREE.Mesh).material);

    // A group selection inherits downward and can name every part of an assembly, so one clone
    // per PART would allocate forty thousand materials to draw one colour.
    expect(materials).toEqual([material, material]);

    first.setHighlight(null);
    second.setHighlight(null);
    expect(drawables(batchSide.root).filter((one) => one.name === 'PartHighlight')).toHaveLength(0);
  });

  it('follows a part that is moved while it is glowing', () => {
    // The selected part IS the part the gizmo drags, so this is the ordinary case and not an
    // edge one: an overlay left standing where the part was would float over the assembly.
    const { batchSide, batched } = pair();
    const bolt = partNamed(batchSide, batched, 'Right Bolt 0');
    bolt.setHighlight(GLOW);

    const bind = bolt.bindPose();
    bolt.setLocalTransform({ ...bind, position: [bind.position[0] + 4, bind.position[1], bind.position[2]] });
    batchSide.root.updateMatrixWorld(true);

    const overlay = drawables(batchSide.root).find((one) => one.name === 'PartHighlight') as THREE.Mesh;
    const viaOverlay = new THREE.Box3().setFromObject(overlay);
    const viaHandle = bolt.getBoundingBox(new THREE.Box3());
    expect(viaOverlay.min.distanceTo(viaHandle.min)).toBeLessThan(1e-9);
    expect(viaOverlay.max.distanceTo(viaHandle.max)).toBeLessThan(1e-9);
  });

  it("gives a part batching refused the material swap instead, and takes it back", () => {
    const { batchSide, batched } = pair({ multiMaterial: true });
    const split = partNamed(batchSide, batched, 'Split Face');
    const mesh = batchSide.objects.get('Split Face') as THREE.Mesh;
    const own = mesh.material;

    split.setHighlight(GLOW);
    expect(mesh.material).not.toBe(own);
    expect(Array.isArray(mesh.material)).toBe(true);
    split.setHighlight(null);
    expect(mesh.material).toBe(own);
  });

  it('bounds the overlays when a whole model is selected, and gives the budget back', () => {
    // Selection inherits downward, so clicking the Model Tree's top row selects every part —
    // and one overlay Mesh per part would put the draw calls straight back where batching
    // found them. The OVERLAYS stay bounded at MAX_OVERLAY_PARTS and the parts past it glow
    // inside their batch instead (the tests below), which is what keeps the bound a bound on
    // draw calls rather than a bound on how much of a selection anybody can see.
    const fixture = assembly(400, 1);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const ids = idsOf(registry);
    const before = drawables(fixture.root).length;
    expect(before).toBe(1);

    registry.syncStates(statesFor(ids, [[fixture.tree.id, { selected: true }]]), GLOW);
    const overlays = drawables(fixture.root).filter((one) => one.name === 'PartHighlight');
    expect(overlays.length).toBe(MAX_OVERLAY_PARTS);
    expect(drawables(fixture.root)).toHaveLength(1 + MAX_OVERLAY_PARTS);
    // The selection itself is unaffected by the cap: every part is still selected, the tree
    // row and the strip's name for it are the model's, and each part is still addressable.
    expect(registry.get(fixture.tree.id)).not.toBeNull();

    registry.syncStates(statesFor(ids, []), GLOW);
    expect(drawables(fixture.root).filter((one) => one.name === 'PartHighlight')).toHaveLength(0);
    expect(drawables(fixture.root)).toHaveLength(before);

    // And the budget is back, so the next selection of one part still glows.
    const one = registry.parts()[1];
    one.setHighlight(GLOW);
    expect(drawables(fixture.root).filter((x) => x.name === 'PartHighlight')).toHaveLength(1);
  });
});

// ─── task 04c: past the cap, the glow moves inside the batch ────────────────

/** What three hands `onBeforeCompile`, shaped from three's own standard-material source. */
interface CompiledShader {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

/**
 * Run one material's patch the way three runs it, against the REAL r181 source.
 *
 * three's own ShaderLib text rather than a stub that happens to contain the anchors: a patch
 * anchored on a line three renamed is a patch that silently stops being applied, and a stub
 * would keep passing through that. `MeshStandardMaterial` compiles `ShaderLib.physical`, which
 * is what every material utils/modelLoader leaves on an imported part is.
 */
function compile(material: THREE.Material): CompiledShader {
  const shader: CompiledShader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    uniforms: {},
  };
  material.onBeforeCompile(shader as never, undefined as never);
  return shader;
}

/** The flag texels a batch's material reads, or null for a batch still on the file's material. */
function flagsOf(batch: THREE.BatchedMesh): Uint8Array | null {
  const material = batch.material as THREE.Material;
  const uniform = compile(material).uniforms.partHighlightTexture as { value: THREE.DataTexture } | undefined;
  return (uniform?.value.image.data as Uint8Array | undefined) ?? null;
}

/** Which slots of a batch are flagged, which is the only thing a flag texture has to say. */
const flaggedSlotsOf = (batch: THREE.BatchedMesh): number[] => {
  const data = flagsOf(batch);
  if (!data) return [];
  const out: number[] = [];
  data.forEach((byte, slot) => {
    if (byte !== 0) out.push(slot);
  });
  return out;
};

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, at) => from + at);

/** Every id selected, which is what clicking the Model Tree's top row writes. */
const allSelected = (ids: readonly string[], rootId: string) => statesFor(ids, [[rootId, { selected: true }]]);

/**
 * What a C preprocessor makes of `source` when `define` is NOT defined: every `#ifdef define`
 * block comes out, nested conditionals with it.
 *
 * Here to prove the patch is a no-op rather than to claim it — the assertion that follows it is
 * that what is left is three's own source, byte for byte, which is the whole of the reason a
 * material anything else draws with is safe to hand this patch.
 */
function stripIfdef(source: string, define: string): string {
  const kept: string[] = [];
  let skipping = false;
  let nested = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (skipping) {
      if (trimmed.startsWith('#if')) nested += 1;
      else if (trimmed === '#endif') {
        nested -= 1;
        if (nested < 0) skipping = false;
      }
      continue;
    }
    if (trimmed === `#ifdef ${define}`) {
      skipping = true;
      nested = 0;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

describe('past MAX_OVERLAY_PARTS: the glow moves inside the batch', () => {
  it('glows every part of a whole-model selection and adds no object for the ones past the cap', () => {
    const fixture = assembly(400, 1);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const ids = idsOf(registry);
    expect(drawables(fixture.root)).toHaveLength(1);

    registry.syncStates(allSelected(ids, fixture.tree.id), GLOW);

    const overlays = drawables(fixture.root).filter((one) => one.name === 'PartHighlight');
    expect(overlays).toHaveLength(MAX_OVERLAY_PARTS);
    // The 336 parts past the cap add nothing to the graph at all: they glow in the batch they
    // were already drawn by, which is the difference between this and ten thousand draw calls.
    expect(drawables(fixture.root)).toHaveLength(1 + MAX_OVERLAY_PARTS);
    expect(registry.flaggedParts()).toBe(ids.length - 1 - MAX_OVERLAY_PARTS);

    const batch = batchesOf(fixture.root)[0];
    // Every part of the model is on one path or the other, and the two paths do not overlap:
    // 400 parts, the first 64 as overlays, the rest as flagged slots of the one batch.
    expect(flaggedSlotsOf(batch)).toEqual(range(MAX_OVERLAY_PARTS, 400));
    expect(overlays.length + registry.flaggedParts()).toBe(ids.length - 1);
  });

  it('clears every flag when the selection goes, and glows the same parts when it comes back', () => {
    const fixture = assembly(400, 1);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const ids = idsOf(registry);
    const batch = batchesOf(fixture.root)[0];

    registry.syncStates(allSelected(ids, fixture.tree.id), GLOW);
    expect(registry.flaggedParts()).toBe(336);

    registry.syncStates(statesFor(ids, []), GLOW);
    expect(registry.flaggedParts()).toBe(0);
    // Not "the store was thrown away" but "every texel was written back to 0": a flag left set
    // is a part glowing after it was deselected, and nothing in the graph would show it.
    expect(flagsOf(batch)).not.toBeNull();
    expect(flaggedSlotsOf(batch)).toEqual([]);
    expect(drawables(fixture.root)).toHaveLength(1);

    registry.syncStates(allSelected(ids, fixture.tree.id), GLOW);
    expect(registry.flaggedParts()).toBe(336);
    expect(flaggedSlotsOf(batch)).toEqual(range(MAX_OVERLAY_PARTS, 400));
  });

  it("keeps one batch's flags out of another batch drawing the same source material", () => {
    // Two batches on ONE material object, which is not a hypothetical: `batchKeyOf` splits on
    // the shadow flags and on the geometry's attribute signature, so a file that mixes either
    // draws one material under two BatchedMeshes. A uniform lives on a MATERIAL, so a flag
    // texture hung off the shared one would be the audit's D1 leak wearing a different hat.
    const fixture = assembly(200, 1);
    const source = (fixture.root.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    for (const index of range(100, 200)) (fixture.root.children[index] as THREE.Mesh).castShadow = true;
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const ids = idsOf(registry);
    const [plain, shadowed] = batchesOf(fixture.root);
    expect([plain.castShadow, shadowed.castShadow]).toEqual([false, true]);

    // Only the first batch's parts, which is the first 100 ids after the model's own.
    registry.syncStates(
      statesFor(ids, ids.slice(1, 101).map((id) => [id, { selected: true }] as [string, Partial<PartState>])),
      GLOW,
    );
    expect(flaggedSlotsOf(plain)).toEqual(range(MAX_OVERLAY_PARTS, 100));
    // The other batch was never even given a clone, so there is nothing for a flag to reach.
    expect(flagsOf(shadowed)).toBeNull();
    expect(shadowed.material).toBe(source);
    expect(plain.material).not.toBe(source);

    registry.syncStates(allSelected(ids, fixture.tree.id), GLOW);
    const [plainFlags, shadowedFlags] = [flagsOf(plain), flagsOf(shadowed)];
    expect(plainFlags).not.toBeNull();
    expect(shadowedFlags).not.toBeNull();
    // Two stores, and each holds only its own batch's slots: one shared texture would answer
    // 136 set bytes on both sides instead of 36 on one and 100 on the other.
    expect(plainFlags).not.toBe(shadowedFlags);
    expect(flaggedSlotsOf(plain)).toEqual(range(MAX_OVERLAY_PARTS, 100));
    expect(flaggedSlotsOf(shadowed)).toEqual(range(0, 100));
    expect(plain.material).not.toBe(shadowed.material);
    expect(registry.flaggedParts()).toBe(136);
  });

  it("never writes to the file's own material, so a mesh outside the batch cannot glow", () => {
    // A material array is how a part ends up sharing a material with a batch and not being in
    // it: utils/cadToThree splits a solid whose faces differ in colour, and the split part is
    // exactly the one batching refuses. It keeps its own Object3D and draws the SAME material
    // object the batch was built from.
    const root = new THREE.Group();
    root.name = 'Mixed';
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const steel = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    const brass = new THREE.MeshStandardMaterial({ color: 0xaa8844 });
    for (const index of range(0, 100)) {
      const mesh = new THREE.Mesh(geometry, steel);
      mesh.name = `Part ${index}`;
      mesh.position.set(index % 10, Math.floor(index / 10), 0);
      root.add(mesh);
    }
    const split = new THREE.Mesh(geometry, [steel, brass]);
    split.name = 'Split Face';
    split.position.set(20, 0, 0);
    root.add(split);
    const tree = buildSceneTree(root, { value: 0 }, PREFIX);
    if (!tree) throw new Error('fixture produced no tree');
    root.updateMatrixWorld(true);

    const registry = new BatchedPartRegistry(root, tree);
    registry.syncStates(allSelected(idsOf(registry), tree.id), GLOW);
    expect(registry.flaggedParts()).toBe(100 - MAX_OVERLAY_PARTS);

    // The batch draws a clone; the file's material was never told anything. That is what makes
    // the patch safe on a material a non-batched mesh shares, before the shader is even
    // considered: the mesh outside the batch is still drawing an unpatched, unhighlighted
    // material object, and the audit's D1 is what put it there.
    expect(batchesOf(root)[0].material).not.toBe(steel);
    expect(steel.emissive.getHex()).toBe(0x000000);
    expect(steel.userData.originalEmissive).toBeUndefined();
    expect(steel.onBeforeCompile).toBe(THREE.Material.prototype.onBeforeCompile);
    expect(steel.customProgramCacheKey).toBe(THREE.Material.prototype.customProgramCacheKey);
    // `defines` is the channel the patch uses to reach three's fragment prefix, and a standard
    // material carries its own (`STANDARD`), so the assertion is that the patch's define is not
    // among them rather than that there are none.
    const defines = (steel as THREE.Material & { defines?: Record<string, unknown> }).defines;
    expect(Object.keys(defines ?? {})).not.toContain('USE_PART_HIGHLIGHT');
  });

  it('answers a pick of a flagged part as the part itself, because its slot never went off', () => {
    const fixture = assembly(200, 1);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const ids = idsOf(registry);
    registry.syncStates(allSelected(ids, fixture.tree.id), GLOW);
    const target = registry.parts()[ids.length - 1];
    expect(registry.flaggedParts()).toBeGreaterThan(0);

    // An overlay has to be pickable in its own right because it turns the slot off underneath.
    // A flagged part needs no such machinery: the ray hits the batch, at the part's own slot,
    // and `partChainForHit` answers from `partAtSlot` exactly as it did before the selection.
    const center = target.getBoundingBox(new THREE.Box3()).getCenter(new THREE.Vector3());
    const raycaster = new THREE.Raycaster(center.clone().setZ(center.z + 50), new THREE.Vector3(0, 0, -1));
    const first = raycaster.intersectObjects([fixture.root], true).find(isPointableHit);
    expect((first?.object as THREE.BatchedMesh).isBatchedMesh).toBe(true);
    expect(hitParts(first!, [registry]).chain[0]).toBe(target.id);
    expect(hitParts(first!, [registry]).handle?.name).toBe(target.name);
  });

  it('frees the flag texture and the material clone on dispose', () => {
    const fixture = assembly(200, 1);
    const source = (fixture.root.children[0] as THREE.Mesh).material as THREE.Material;
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    registry.syncStates(allSelected(idsOf(registry), fixture.tree.id), GLOW);

    const batch = batchesOf(fixture.root)[0];
    const clone = batch.material as THREE.Material;
    expect(clone).not.toBe(source);
    // Read before the dispose, because afterwards there is no batch left to ask.
    const texture = compile(clone).uniforms.partHighlightTexture as { value: THREE.DataTexture };
    const cloneDisposed = vi.spyOn(clone, 'dispose');
    const textureDisposed = vi.spyOn(texture.value, 'dispose');

    registry.dispose();

    expect(cloneDisposed).toHaveBeenCalled();
    expect(textureDisposed).toHaveBeenCalled();
    expect(registry.flaggedParts()).toBe(0);
  });

  it('is still the motion cull\'s to take while the camera moves, and comes back glowing', () => {
    // The decision the 10 000-part orbit made: an exemption that covered flags would name every
    // part of a whole-model selection as "being looked at" and switch the cull off for the whole
    // assembly, which is 7 ms becoming 17. So a flagged part is culled like the unglowing part it
    // was before this existed, while an overlay keeps the immunity it always had.
    const fixture = assembly(200, 1);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const ids = idsOf(registry);
    registry.syncStates(allSelected(ids, fixture.tree.id), GLOW);
    expect(registry.flaggedParts()).toBe(200 - MAX_OVERLAY_PARTS);
    fixture.root.updateMatrixWorld(true);

    const flagged = registry.parts()[ids.length - 1];
    const overlaid = registry.parts()[1];
    const above = (part: PartHandle) =>
      part.getBoundingBox(new THREE.Box3()).getCenter(new THREE.Vector3()).setZ(50);
    const pickable = (part: PartHandle) =>
      new THREE.Raycaster(above(part), new THREE.Vector3(0, 0, -1))
        .intersectObjects([fixture.root], true)
        .some((hit) => hitParts(hit, [registry]).chain[0] === part.id);

    // Every part of this fixture is the same size and all of them are under the threshold from
    // 1000 units out, so the cull wants the whole model — and takes everything but the overlays.
    expect(registry.motionCull({ eye: new THREE.Vector3(0, 0, 1000), k: 0.001 })).toBe(
      200 - MAX_OVERLAY_PARTS,
    );
    expect(pickable(flagged)).toBe(false);
    expect(pickable(overlaid)).toBe(true);
    // The flag survives the cull: it is a highlight, not a visibility state, and the restore is
    // what has to give the part back rather than what has to re-light it.
    expect(registry.flaggedParts()).toBe(200 - MAX_OVERLAY_PARTS);

    registry.motionCull(null);
    expect(pickable(flagged)).toBe(true);
    expect(registry.flaggedParts()).toBe(200 - MAX_OVERLAY_PARTS);
  });

  it('is calmed by a thumbnail capture and given back afterwards, like every other highlight', () => {
    // lib/scene/captureClean.ts looks for a material whose live emissive differs from the one it
    // remembers, which is what a flag clone is while any of its parts is flagged. So the lobby's
    // picture of a room keeps the selection glow out of it on the flag path too, without that
    // file knowing the flag path exists.
    const fixture = assembly(200, 1);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    registry.syncStates(allSelected(idsOf(registry), fixture.tree.id), GLOW);
    const clone = batchesOf(fixture.root)[0].material as THREE.MeshStandardMaterial;
    expect(clone.emissive.getHex()).toBe(0x0044aa);

    const clean = hideEditingHelpers(fixture.root);
    expect(clone.emissive.getHex()).toBe(0x000000);
    clean.restore();
    expect(clone.emissive.getHex()).toBe(0x0044aa);
    expect(clone.emissiveIntensity).toBe(GLOW.intensity);
  });
});

describe('the flag store and the shader patch it is read by', () => {
  it("sizes one batch's store to its slots, and writes the texel the shader fetches", () => {
    // Square, the way three sizes its own per-instance textures, so a 40 000-slot batch asks
    // for 200 × 200 rather than for a texture 40 000 pixels wide.
    const flags = partHighlightFlags(400);
    expect(flags.texture.image.width).toBe(20);
    expect(flags.texture.image.height).toBe(20);
    expect(flags.data).toHaveLength(400);
    expect(Array.from(flags.data).every((byte) => byte === 0)).toBe(true);

    const before = flags.texture.version;
    flags.write(399, true);
    // Slot 399 is texel (19, 19) of a 20 × 20 texture, which is byte 399 of the flat array —
    // the same arithmetic the patch does with `index % width` and `index / width`.
    expect(flags.data[399]).toBe(255);
    expect(flags.texture.version).toBeGreaterThan(before);
    flags.write(399, false);
    expect(flags.data[399]).toBe(0);
  });

  it("rewrites three's own standard-material shader at the anchors it names", () => {
    const flags = partHighlightFlags(4);
    const material = partHighlightMaterial(
      new THREE.MeshStandardMaterial({ color: 0x8899aa, emissive: 0x112233, emissiveIntensity: 2 }),
      GLOW,
      flags,
    );
    expect(material).not.toBeNull();

    const shader = compile(material!);
    expect(shader.vertexShader).toContain('uniform highp sampler2D partHighlightTexture;');
    // The instance index and NOT `gl_DrawID`: a BatchedMesh compacts the visible instances into
    // its indirect-draw list every frame, so reading the draw id as a slot would put a hidden
    // part's flag on whichever neighbour took its place in the list.
    expect(shader.vertexShader).toContain('int partIndex = int( getIndirectIndex( gl_DrawID ) );');
    expect(shader.vertexShader).toContain(
      'texelFetch( partHighlightTexture, ivec2( partIndex % partHighlightWidth, partIndex / partHighlightWidth ), 0 )',
    );
    expect(shader.fragmentShader).toContain(
      'totalEmissiveRadiance = mix( partBaseEmissive, totalEmissiveRadiance, vPartHighlight );',
    );
    expect(shader.uniforms.partHighlightTexture).toEqual({ value: flags.texture });
    // The store's width as a uniform: one texture-unit query per vertex of a ten-thousand-part
    // batch is a query the store already knew the answer to.
    expect(shader.uniforms.partHighlightWidth).toEqual({ value: flags.side });

    // A flagged instance gets what `setEmissiveHighlight` puts on the overlay's clone — the
    // highlight in the material's own emissive — and an unflagged one gets what three would have
    // uploaded for this material untouched: its own colour times its own intensity.
    expect((material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0x0044aa);
    expect((material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.5);
    const base = shader.uniforms.partBaseEmissive as { value: THREE.Color };
    expect(base.value.equals(new THREE.Color(0x112233).multiplyScalar(2))).toBe(true);
  });

  it('answers null for a material with no emissive to glow with, and leaves the source alone', () => {
    // The same answer an overlay gives: `setEmissiveHighlight` is a no-op on a material with no
    // emissive channel, so a part like this looks the same on either side of the cap. What must
    // NOT happen is the batch drawing an unpatched clone, whose emissive IS the highlight.
    const flags = partHighlightFlags(4);
    const basic = new THREE.MeshBasicMaterial({ color: 0x8899aa });
    const disposed = vi.spyOn(basic, 'dispose');
    expect(partHighlightMaterial(basic, GLOW, flags)).toBeNull();
    expect('emissive' in basic).toBe(false);
    expect(disposed).not.toHaveBeenCalled();
  });

  it('is a no-op with its own define off, which is what makes it safe on a shared material', () => {
    const flags = partHighlightFlags(4);
    const source = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    const material = partHighlightMaterial(source, GLOW, flags)!;
    // The define the patch added, found by difference rather than by name: a standard material
    // arrives with `STANDARD` of its own and `Material.copy` carries the bag across.
    const definesOf = (one: THREE.Material): string[] =>
      Object.keys((one as THREE.Material & { defines?: Record<string, unknown> }).defines ?? {});
    const added = definesOf(material).filter((name) => !definesOf(source).includes(name));
    expect(added).toHaveLength(1);
    const define = added[0];

    const shader = compile(material);
    // Byte for byte three's own source once the patch's blocks are preprocessed out. `defines`
    // goes into BOTH of three's shader prefixes, so a mesh that is not a BatchedMesh compiles
    // this same source with the define on and `USE_BATCHING` off — and the next assertion is
    // why that is still a no-op rather than a black emissive.
    expect(stripIfdef(shader.vertexShader, define)).toBe(THREE.ShaderLib.physical.vertexShader);
    expect(stripIfdef(shader.fragmentShader, define)).toBe(THREE.ShaderLib.physical.fragmentShader);

    // `USE_BATCHING` is defined in three's VERTEX prefix only, so the fragment half cannot test
    // it. The varying defaults to 0 outside the batching guard instead, which mixes all the way
    // back to the material's own emissive: a plain Mesh drawing with this material renders
    // exactly what it would have rendered unpatched.
    const injected = shader.vertexShader.slice(shader.vertexShader.indexOf(`#ifdef ${define}`));
    expect(injected.indexOf('vPartHighlight = 0.0;')).toBeLessThan(injected.indexOf('#ifdef USE_BATCHING'));
  });
});

// ─── decision 3, R4, R5: what goes into a batch ─────────────────────────────

describe('what batching merges, and what it leaves alone', () => {
  it('adds a shared geometry ONCE and instances it per part', () => {
    // Task 04b decision 3: the convert-service GLB shares one glTF mesh across repeated
    // instances, and merging it per part would copy the same vertices four thousand times for
    // the same one draw call either way.
    const fixture = assembly(600, 1);
    expect(drawables(fixture.root)).toHaveLength(600);

    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const batches = batchesOf(fixture.root);

    expect(batches).toHaveLength(1);
    expect(batches[0].instanceCount).toBe(600);
    // One draw object for six hundred parts, which is the whole point of the exercise.
    expect(drawables(fixture.root)).toHaveLength(1);
    expect(registry.parts()).toHaveLength(601);
    expect(registry.unbatchedParts()).toBe(0);
  });

  it('makes one batch per material-and-flags key, and not one per part', () => {
    const fixture = assembly(900, 3);
    new BatchedPartRegistry(fixture.root, fixture.tree);
    expect(drawables(fixture.root)).toHaveLength(3);
  });

  it('separates two parts that share a material but not a shadow flag', () => {
    // R4: the key is not just the material. applySceneDefaults sets both shadow flags per
    // mesh, so two parts can share a material object and still differ in castShadow — and a
    // batch that merged them would draw one of them without the shadow it was parsed with.
    // (These fixtures never run applySceneDefaults, so every part starts unshadowed and the
    // one flag set below is the only difference between them.)
    const fixture = assembly(60, 1);
    (fixture.root.children[7] as THREE.Mesh).castShadow = true;
    new BatchedPartRegistry(fixture.root, fixture.tree);

    const batches = batchesOf(fixture.root);
    expect(batches).toHaveLength(2);
    expect(batches.map((one) => one.castShadow).sort()).toEqual([false, true]);
    expect(batches.map((one) => one.instanceCount).sort((a, b) => a - b)).toEqual([1, 59]);
  });

  it('leaves a multi-material part addressable and counts it', () => {
    // R5: a material array is geometry groups and a batch draws one material, so batching it
    // would put the draw calls back inside the batch. Left as the Object3D it was, and
    // counted, so a file made of nothing else is visible rather than silently slow.
    const { batchSide, batched } = pair({ multiMaterial: true });

    expect(batched.unbatchedParts()).toBe(1);
    const kept = drawables(batchSide.root).filter((one) => (one as THREE.BatchedMesh).isBatchedMesh !== true);
    expect(kept.map((one) => one.name)).toEqual(['Split Face']);
    expect(Array.isArray((kept[0] as THREE.Mesh).material)).toBe(true);
    // Still pickable, still named, still boxable — nothing above the registry can tell.
    expect(batched.get(batchSide.idOf.get('Split Face')!)!.name).toBe('Split Face');
    expect(batched.get(batchSide.idOf.get('Split Face')!)!.getBoundingBox(new THREE.Box3()).isEmpty()).toBe(false);
  });

  it('prunes the branches batching emptied, and keeps the ones it could not take', () => {
    const { batchSide } = pair({ multiMaterial: true });
    // 'Left' held only batched bolts, so it is gone; 'Right' still holds the part batching
    // refused, so its whole ancestor chain survives and that part keeps its own semantics.
    expect(batchSide.objects.get('Left')!.parent).toBeNull();
    expect(batchSide.objects.get('Split Face')!.parent).toBe(batchSide.objects.get('Right'));
    expect(batchSide.objects.get('Right')!.parent).toBe(batchSide.root);
    expect(batchSide.objects.get('Assembly')).toBe(batchSide.root);
  });
});

// ─── picking ────────────────────────────────────────────────────────────────

describe('picking: a hit answers the same chain either way', () => {
  it('resolves a bolt to itself and its ancestors, nearest first', () => {
    const { meshSide, batchSide, mesh, batched } = pair();

    const viaMesh = hitParts(
      new THREE.Raycaster(new THREE.Vector3(-2, 0, 5), new THREE.Vector3(0, 0, -1))
        .intersectObjects([meshSide.root], true)[0],
      [mesh],
    );
    const viaBatched = hitParts(
      new THREE.Raycaster(new THREE.Vector3(-2, 0, 5), new THREE.Vector3(0, 0, -1))
        .intersectObjects([batchSide.root], true)[0],
      [batched],
    );

    expect(viaMesh.chain.length).toBeGreaterThan(1);
    // Same ids, same order, because both were minted by the same pre-order walk of the same
    // description — which is the only reason a pin dropped on one screen means the same part
    // on another.
    expect(viaBatched.chain).toEqual(viaMesh.chain);
    expect(viaBatched.handle?.name).toBe(viaMesh.handle?.name);
    expect(viaBatched.handle?.name).toBe('Left Bolt 0');
  });

  it('answers the whole chain for a hit on a part batching left alone', () => {
    const { batchSide, batched } = pair({ multiMaterial: true });
    const split = batchSide.objects.get('Split Face') as THREE.Mesh;
    const chain = batched.partChainForHit({ object: split, instanceId: undefined, batchId: undefined });

    expect(chain?.[0]).toBe(batchSide.idOf.get('Split Face'));
    expect(chain).toContain(batchSide.idOf.get('Right'));
    expect(chain).toContain(batchSide.tree.id);
  });

  it("refuses a hit that is not this model's, and says so with null", () => {
    // Null and not an empty chain, because the two mean different things to hitParts: null
    // says "ask the next registry", empty says "this model refused it, stop asking".
    const { batchSide, batched } = pair();
    const stranger = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    expect(batched.partChainForHit({ object: stranger, instanceId: undefined, batchId: undefined })).toBeNull();
    expect(batched.partChainForHit({ object: batchSide.root, instanceId: undefined, batchId: undefined }))
      .toEqual([batchSide.tree.id]);
  });

  it('refuses a batch hit whose slot it does not know', () => {
    const { batchSide, batched } = pair();
    const batch = batchesOf(batchSide.root)[0];
    expect(batched.partChainForHit({ object: batch, instanceId: undefined, batchId: 9999 })).toEqual([]);
    expect(batched.partChainForHit({ object: batch, instanceId: undefined, batchId: undefined })).toEqual([]);
  });
});

// ─── the gizmo proxy ────────────────────────────────────────────────────────

describe('gizmoProxyFor: the one Object3D drei still needs', () => {
  it("stands in the part's own frame, so what is read off it is what goes on the wire", () => {
    // The contract components/Scene/ReviewModelGizmo depends on: the proxy's LOCAL transform
    // is the part's, in the space a PartTransform carries. A proxy parented to the model root
    // instead would read root-space numbers off a part nested two groups deep and write them
    // back as parent-space ones, which is the same mistake twice over.
    const { meshSide, batchSide, mesh, batched } = pair();
    const frames: THREE.Matrix4[] = [];

    for (const [side, registry] of [
      [meshSide, mesh],
      [batchSide, batched],
    ] as const) {
      const bolt = partNamed(side, registry, 'Left Bolt 0');
      const proxy = registry.gizmoProxyFor(bolt.id)!;
      side.root.updateMatrixWorld(true);

      expect(proxy.position.toArray()).toEqual(bolt.getLocalTransform().position);
      expect(proxy.rotation.toArray().slice(0, 3)).toEqual(bolt.getLocalTransform().rotation);
      expect(proxy.scale.toArray()).toEqual(bolt.getLocalTransform().scale);
      frames.push(proxy.matrixWorld.clone());
    }

    // And the WORLD frame agrees between the two implementations, which is what drei draws
    // its handles in. Asserted against the frame and not against a part's object, because
    // what the part is backed by is exactly what this stage changes.
    expect(frames[1].equals(frames[0])).toBe(true);
  });

  it('re-parks on the part every call, which is what the gizmo does between drags', () => {
    // ReviewModelGizmo calls this in a useFrame while no hand is on the handles, so an undo, a
    // "Reset part" or a colleague's edit landing while a part is selected has to move the
    // handles with it — or the next drag would push a stale pose onto the part and make it
    // jump. Idempotent, and one map lookup and three copies a frame.
    const { batchSide, batched } = pair();
    const id = batchSide.idOf.get('Right Bolt 1')!;
    const first = batched.gizmoProxyFor(id)!;
    const parked = first.position.toArray();

    applyPartTransforms(batched, batchSide.tree.id, { [id]: at([4, 4, 4]) });
    const second = batched.gizmoProxyFor(id)!;

    expect(second).toBe(first);
    expect(second.position.toArray()).toEqual([4, 4, 4]);
    expect(second.position.toArray()).not.toEqual(parked);
    expect(batched.gizmoProxyFor(id)).toBe(first);
    expect(batched.gizmoProxyFor(id)!.position.toArray()).toEqual([4, 4, 4]);
  });

  it('is ONE proxy per model, moved between parts', () => {
    const { batchSide, batched } = pair();
    const left = batched.gizmoProxyFor(batchSide.idOf.get('Left Bolt 0')!)!;
    const right = batched.gizmoProxyFor(batchSide.idOf.get('Right Bolt 0')!)!;

    expect(right).toBe(left);
    expect(right.position.x).toBeCloseTo(2, 6);
    expect(batchSide.root.children.filter((one) => one.name === 'PartGizmoProxy')).toHaveLength(0);
  });

  it("answers null for an id that is not this model's", () => {
    const { batched } = pair();
    expect(batched.gizmoProxyFor('nope_0')).toBeNull();
  });

  it('stays out of bounds(), and comes back out of the group on dispose', () => {
    const { batchSide, batched } = pair();
    const before = batched.bounds(new THREE.Box3()).clone();

    batched.gizmoProxyFor(batchSide.idOf.get('Left Bolt 0')!);
    expect(batched.bounds(new THREE.Box3()).equals(before)).toBe(true);

    batched.dispose();
    expect(batchSide.root.children.some((child) => child.name.startsWith('PartGizmo'))).toBe(false);
  });
});

// ─── R6/R10: dispose ────────────────────────────────────────────────────────

describe('R6/R10: build, dispose, and nothing the registry allocated is left', () => {
  it('frees the source geometries once the batches have copied them', () => {
    // R6: batching copies every geometry into a merged buffer, so without this the peak is
    // twice the file's geometry — on a file already large enough to need the 100 MB slow
    // import warning. Freed at build rather than at dispose, because dispose runs when the
    // model goes away and this has to run before it is ever drawn.
    const root = new THREE.Group();
    root.name = 'Assembly';
    const material = new THREE.MeshStandardMaterial();
    const geometries = Array.from({ length: 4 }, (_, index) => {
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `Part ${index}`;
      mesh.position.x = index * 2;
      root.add(mesh);
      return geometry;
    });
    const tree = buildSceneTree(root, { value: 0 }, PREFIX);
    if (!tree) throw new Error('fixture produced no tree');
    root.updateMatrixWorld(true);
    const disposed = geometries.map((geometry) => vi.spyOn(geometry, 'dispose'));

    new BatchedPartRegistry(root, tree);

    for (const [index, spy] of disposed.entries()) expect(spy, `geometry ${index}`).toHaveBeenCalled();
  });

  it('frees the batches, their overlays and their highlight clones', () => {
    // R10: three frees none of this on a dropped reference, and a BatchedMesh owns two
    // DataTextures — the instance matrices and the indirect draw list — that are reachable
    // from neither `.geometry` nor `.material`.
    const fixture = build({ multiMaterial: true });
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const batches = batchesOf(fixture.root);
    expect(batches.length).toBeGreaterThan(0);
    const batchDisposers = batches.map((one) => vi.spyOn(one, 'dispose'));

    partNamed(fixture, registry, 'Left Bolt 0').setHighlight(GLOW);
    const overlay = drawables(fixture.root).find((one) => one.name === 'PartHighlight') as THREE.Mesh;
    const overlayGeometry = vi.spyOn(overlay.geometry, 'dispose');
    const clone = vi.spyOn(overlay.material as THREE.Material, 'dispose');

    registry.dispose();

    for (const [index, spy] of batchDisposers.entries()) expect(spy, `batch ${index}`).toHaveBeenCalled();
    expect(overlayGeometry).toHaveBeenCalled();
    expect(clone).toHaveBeenCalled();
    // Out of the graph, so a disposeGroup run afterwards does not find them and free the
    // merged buffer a second time.
    for (const batch of batches) expect(batch.parent).toBeNull();
    expect(batchesOf(fixture.root)).toHaveLength(0);
  });

  it('is safe to dispose twice, and every method answers afterwards', () => {
    // The room prunes its entries on every scene update, and a component holding the entry it
    // just lost can still have an effect queued. A registry that threw after dispose would
    // turn a leak fix into a crash.
    const { batchSide, batched } = pair();
    batched.dispose();
    batched.dispose();

    expect(batched.parts()).toHaveLength(0);
    expect(batched.get(batchSide.tree.id)).toBeNull();
    expect(batched.bounds(new THREE.Box3()).isEmpty()).toBe(true);
    expect(batched.movedPartIds()).toEqual([]);
    expect(batched.gizmoProxyFor(batchSide.tree.id)).toBeNull();
    expect(batched.syncStates({}, GLOW)).toBe(0);
    expect(batched.partChainForHit({ object: batchSide.root, instanceId: undefined, batchId: undefined })).toEqual([]);
  });
});

// ─── the perf gate ──────────────────────────────────────────────────────────

describe('the cost of a big model', () => {
  /**
   * How many parts this gate builds.
   *
   * The audit asks for 40 000, matching the number both lib/scene/materialHighlight.ts and
   * lib/scene/partTransforms.ts cite. This builds 3 000 instead, because the real 3 200- and
   * 10 000-part numbers are measured against the Task 02 fixtures by `npm run perf` in a real
   * browser on a real GPU — which is the measurement item 10 exists for, and the one the
   * report carries. What a unit test adds is the INVARIANCE: that the draw objects are a
   * function of the materials and not of the parts, and that a click costs the parts that
   * changed. Both hold at 3 000 and both would break at 40 000 the same way.
   */
  const MANY = 3000;

  it('draws one object per material, however many parts there are', () => {
    const small = assembly(600, 4);
    const large = assembly(MANY, 4);
    new BatchedPartRegistry(small.root, small.tree);
    new BatchedPartRegistry(large.root, large.tree);

    expect(drawables(small.root)).toHaveLength(4);
    expect(drawables(large.root)).toHaveLength(4);
    // The baseline this is measured against: perf/results/README.md records 3 202 draw calls
    // for 3 200 parts and 10 002 for 10 000 — one per part, plus the scene's own.
    expect(drawables(large.root).length).toBeLessThan(MANY / 100);
  });

  it('costs one selection change the parts that changed, not the model', () => {
    const { meshSide, mesh, batched } = pair();
    const ids = idsOf(mesh);
    const bolt = meshSide.idOf.get('Left Bolt 0')!;
    const group = meshSide.idOf.get('Left')!;

    // selectNode (store.ts) rewrites EVERY entry in objectStates to clear the old selection,
    // so a diff on object identity would see the whole scene as changed. A diff on the two
    // booleans sees the one id that moved — and the shared PartGraph is what makes the two
    // implementations answer the same number rather than two numbers that happen to agree.
    const select = statesFor(ids, [[bolt, { selected: true }]]);
    expect(batched.syncStates(select, GLOW)).toBe(1);
    expect(mesh.syncStates(select, GLOW)).toBe(1);
    expect(batched.syncStates(select, GLOW)).toBe(0);

    const move = statesFor(ids, [[bolt, { selected: false }], [group, { selected: true }]]);
    const viaBatched = batched.syncStates(move, GLOW);
    const viaMesh = mesh.syncStates(move, GLOW);
    expect(viaBatched).toBe(viaMesh);
    expect(viaBatched).toBeLessThan(ids.length);
  });

  it('answers bounds for a large model without walking a graph it no longer has', () => {
    const fixture = assembly(MANY, 4);
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    const box = registry.bounds(new THREE.Box3());

    expect(box.isEmpty()).toBe(false);
    // 3 000 unit cubes laid out on a 40 × 40 grid: the box has to describe the parts, not the
    // merged buffer sitting at the batch's own origin.
    expect(box.max.x).toBeGreaterThan(30);
    expect(box.min.x).toBeLessThan(-0.4);
    expect(registry.parts()).toHaveLength(MANY + 1);
    // And the graph it walks to get there is the batches, not thirty hundred meshes.
    expect(fixture.root.children.length).toBeLessThan(20);
  });
});
