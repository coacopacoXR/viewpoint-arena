// The part registry — task 04b stage 1.
//
// Two things here are load-bearing enough to have been called out as risks in the
// render audit, and both are about the registry AGREEING with what already exists
// rather than about the registry being clever:
//
//   • R8 — the part count and the tree rows must not move. `countParts` feeds the
//     import status line's "N parts", and the Model Tree's rows come from the same
//     SceneNode data. A registry that indexed a different set of things than
//     buildSceneTree tagged would quietly change both, and stage 4 is exactly the
//     change that could.
//   • R11 — two registries built from the same bytes must produce the same ids in the
//     same order. Node ids come from the file's HASH (lib/scene/sceneEntries.ts) so
//     every participant in a room derives the same ones; a pin names the part it was
//     dropped on, and a pin whose id meant something different on another screen
//     would point at nothing.
//
// The rest is the contract the later stages hang off: picking, names, boxes,
// transforms, visibility, highlight.
//
// Fixtures go through cadResultToGroup rather than being hand-assembled where the
// point is "a real parse", because that converter is the one thing in the import path
// that is pure — no WASM, no worker, no File — so a deterministic assembly can be
// built from a byte string in jsdom.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { OcctImportResult, OcctMesh } from 'occt-import-js';
import { cadResultToGroup } from '../../../utils/cadToThree';
import { buildSceneTree } from '../../../utils/modelLoader';
import { countParts } from '../../../store';
import {
  MeshPartRegistry,
  hitParts,
  isPointableHit,
  partRegistries,
  type PartRegistry,
  type PickHit,
} from '../partRegistry';
import { sceneModelPrefix } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'a1'.repeat(32);
const PREFIX = sceneModelPrefix(HASH);

/** One triangle in the XY plane, which is all a fixture needs to be a solid. */
const triangle = (): Pick<OcctMesh, 'attributes' | 'index'> => ({
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
  index: { array: [0, 1, 2] },
});

/** Two triangles sharing an edge, so per-face colours have something to split. */
const quad = (): Pick<OcctMesh, 'attributes' | 'index'> => ({
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] } },
  index: { array: [0, 1, 2, 0, 2, 3] },
});

/**
 * A three-part assembly as the CAD reader's JSON, which is the "bytes" of these tests.
 * Serialised and re-parsed on every use so two builds really do start from the same
 * string rather than from one shared object somebody mutated.
 */
const ASSEMBLY_BYTES = JSON.stringify({
  success: true,
  root: {
    name: 'Assembly',
    meshes: [0],
    children: [{ name: 'Bracket', meshes: [1, 2], children: [] }],
  },
  meshes: [
    { name: 'Base Plate', color: [1, 0, 0], brep_faces: [], ...triangle() },
    { name: '', brep_faces: [], ...triangle() },
    {
      name: 'Pad',
      brep_faces: [
        { first: 0, last: 0, color: [0, 1, 0] },
        { first: 1, last: 1, color: [0, 0, 1] },
      ],
      ...quad(),
    },
  ],
} satisfies OcctImportResult);

/** One independent parse of the fixture: convert, then tag and build the tree. */
function parseAssembly(prefix: string = PREFIX): { root: THREE.Group; tree: SceneNode } {
  const bytes = new TextEncoder().encode(ASSEMBLY_BYTES);
  const result: OcctImportResult = JSON.parse(new TextDecoder().decode(bytes));
  const root = cadResultToGroup(result, 'cube');
  const tree = buildSceneTree(root, { value: 0 }, prefix);
  if (!tree) throw new Error('fixture produced no tree');
  return { root, tree };
}

/** Every id in a SceneNode tree, pre-order — the order buildSceneTree minted them in. */
function treeIds(node: SceneNode, out: string[] = []): string[] {
  out.push(node.id);
  for (const child of node.children ?? []) treeIds(child, out);
  return out;
}

/** The MESH/PART rows, which is what `countParts` counts and the tree shows as parts. */
function partIds(node: SceneNode, out: string[] = []): string[] {
  if (node.type === 'MESH' || node.type === 'PART') out.push(node.id);
  for (const child of node.children ?? []) partIds(child, out);
  return out;
}

const idsOf = (registry: PartRegistry): string[] => registry.parts().map((part) => part.id);

describe('R8: the registry indexes exactly what the parse produced', () => {
  it('holds an entry for every id in the tree, and the tree\'s parts are its meshes', () => {
    const { root, tree } = parseAssembly();
    const registry = new MeshPartRegistry(root, tree);

    // Every row the Model Tree shows is addressable, including the model's own root,
    // and there is nothing else: one entry per object buildSceneTree tagged.
    expect(idsOf(registry)).toEqual(treeIds(tree));
    for (const id of treeIds(tree)) {
      expect(registry.get(id)?.id, id).toBe(id);
    }

    // The tree's part rows are exactly the tagged Meshes, and there are `countParts` of
    // them — the number the import status line prints. Measured off the group rather
    // than off the handles, because "which entries are meshes" is a fact about the
    // parse and not something the registry's public API claims. Groups are indexed too,
    // because a click on a collapsed group has to walk up through it.
    const meshIds: string[] = [];
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) meshIds.push(object.userData.modelId as string);
    });
    expect(meshIds).toEqual(partIds(tree));
    expect(meshIds.length).toBe(countParts(tree));
    expect(meshIds.length).toBeLessThan(registry.parts().length);
  });

  it('keeps the "N parts" number and the id set stable across two parses of one file', () => {
    const first = parseAssembly();
    const second = parseAssembly();

    expect(countParts(second.tree)).toBe(countParts(first.tree));
    expect(treeIds(second.tree)).toEqual(treeIds(first.tree));
    expect(idsOf(new MeshPartRegistry(second.root, second.tree)))
      .toEqual(idsOf(new MeshPartRegistry(first.root, first.tree)));
  });

  it('names a part after its tree row, not after the object the file left empty', () => {
    // The shape collapseSingleChildGroups exists for: a CAD export wraps each mesh in a
    // same-named group, the group's row is dropped and the mesh takes its name. The
    // Object3D's own `name` is still empty, so a handle that read the object would
    // answer an id where the laser's label should say "Hook Left".
    const root = new THREE.Group();
    root.name = 'Root';
    const wrapper = new THREE.Group();
    wrapper.name = 'Hook Left';
    const hook = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    wrapper.add(hook);
    root.add(wrapper);

    const tree = buildSceneTree(root, { value: 0 }, PREFIX)!;
    expect(tree.children?.[0].name).toBe('Hook Left');
    expect(tree.children?.[0].id).not.toBe(`${PREFIX}_1`);

    const registry = new MeshPartRegistry(root, tree);
    expect(registry.get(tree.children![0].id)?.name).toBe('Hook Left');
    expect(hook.name).toBe('');
  });

  it('falls back to the object\'s own name, then to the id, for a node with no row', () => {
    const { root, tree } = parseAssembly();
    const registry = new MeshPartRegistry(root, tree);
    // The CAD reader names an unnamed mesh after its assembly node, so this one has a
    // name of its own even though collapseSingleChildGroups gave it no row.
    for (const part of registry.parts()) {
      expect(part.name.length).toBeGreaterThan(0);
    }
    // Without a tree there is nothing to take a name from, and an id beats an empty
    // string: a laser label that said nothing would look like the pick had failed.
    const bare = new MeshPartRegistry(root);
    expect(bare.parts().every((part) => part.name.length > 0)).toBe(true);
  });
});

describe('R11: the same bytes give the same ids in the same order', () => {
  it('agrees on the id → part mapping and its order across two registries', () => {
    const a = parseAssembly();
    const b = parseAssembly();
    const registryA = new MeshPartRegistry(a.root, a.tree);
    const registryB = new MeshPartRegistry(b.root, b.tree);

    expect(idsOf(registryB)).toEqual(idsOf(registryA));
    expect(registryB.parts().map((part) => part.name))
      .toEqual(registryA.parts().map((part) => part.name));
    // The pin contract: the SAME id names the SAME part on every screen, so a pin
    // dropped here is still on that part for somebody else.
    const namesA = idsOf(registryA).map((id) => registryA.get(id)?.name);
    const namesB = idsOf(registryB).map((id) => registryB.get(id)?.name);
    expect(namesB).toEqual(namesA);
  });

  it('answers nothing for an id from a different file', () => {
    const { root, tree } = parseAssembly();
    const registry = new MeshPartRegistry(root, tree);
    expect(registry.get(`${sceneModelPrefix('b2'.repeat(32))}_1`)).toBeNull();
    expect(registry.get('not-an-id')).toBeNull();
  });
});

describe('picking', () => {
  /** Two boxes side by side under one tagged root, and a camera looking at the left. */
  function scene(): {
    scene: THREE.Scene;
    registry: PartRegistry;
    left: THREE.Mesh;
    right: THREE.Mesh;
    root: THREE.Group;
  } {
    const root = new THREE.Group();
    root.name = 'Assembly';
    const material = new THREE.MeshStandardMaterial();
    const left = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    left.name = 'Left';
    left.position.x = -2;
    const right = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    right.name = 'Right';
    right.position.x = 2;
    root.add(left, right);
    const tree = buildSceneTree(root, { value: 0 }, PREFIX)!;

    const holder = new THREE.Scene();
    holder.add(root);
    root.updateMatrixWorld(true);
    return { scene: holder, registry: new MeshPartRegistry(root, tree), left, right, root };
  }

  const cast = (fixture: { scene: THREE.Scene }, from: THREE.Vector3): THREE.Intersection[] => {
    const raycaster = new THREE.Raycaster();
    raycaster.set(from, new THREE.Vector3(0, 0, -1));
    return raycaster.intersectObjects(fixture.scene.children, true);
  };

  it('resolves a real raycast hit to the part it landed on', () => {
    const fixture = scene();
    const hits = cast(fixture, new THREE.Vector3(-2, 0, 5));
    expect(hits.length).toBeGreaterThan(0);

    const parts = hitParts(hits[0], [fixture.registry]);
    // Nearest first: the mesh, then the group above it. A real Intersection carries
    // instanceId and batchId as undefined here, which is the point of taking the whole
    // hit rather than `hit.object` — stage 4's registry reads those two instead.
    expect(parts.chain[0]).toBe(fixture.registry.partIdForHit(hits[0]));
    expect(parts.chain).toContain(`${PREFIX}_0`);
    expect(parts.modelId).toBe(parts.chain[0]);
    expect(parts.handle?.name).toBe('Left');
  });

  it('answers null, not an empty chain, for a hit outside the model', () => {
    const fixture = scene();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
    // null = "not mine, ask somebody else"; [] = "mine, and refused". Conflating them
    // would let a refused hit fall through to the tag walk and get answered after all.
    expect(fixture.registry.partChainForHit({ object: floor })).toBeNull();
    expect(fixture.registry.partIdForHit({ object: floor })).toBeNull();
  });

  it('answers an empty chain for a model marked skipRaycast', () => {
    const fixture = scene();
    fixture.root.userData.skipRaycast = true;
    expect(fixture.registry.partChainForHit({ object: fixture.left })).toEqual([]);
    expect(fixture.registry.partIdForHit({ object: fixture.left })).toBeNull();
  });

  it('walks up from an untagged object to the part that holds it', () => {
    const fixture = scene();
    // Nothing in a parsed model is untagged — buildSceneTree tags every object it keeps
    // — but a helper parented into one must not stop the walk answering.
    const stray = new THREE.Object3D();
    fixture.left.add(stray);
    expect(fixture.registry.partIdForHit({ object: stray })).toBe(
      fixture.registry.partIdForHit({ object: fixture.left }),
    );
  });

  it('isPointableHit refuses helpers, avatars and beams, and accepts a part', () => {
    const fixture = scene();
    const hits = cast(fixture, new THREE.Vector3(2, 0, 5));
    expect(isPointableHit(hits[0] as PickHit)).toBe(true);

    const dot: THREE.Object3D = new THREE.Mesh(
      new THREE.SphereGeometry(0.05),
      new THREE.MeshBasicMaterial(),
    );
    dot.userData.skipRaycast = true;
    expect(isPointableHit({ object: dot })).toBe(false);

    const agent = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    agent.name = 'Agent-7';
    expect(isPointableHit({ object: agent })).toBe(false);

    const beam = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]),
      new THREE.LineBasicMaterial(),
    );
    expect(isPointableHit({ object: beam })).toBe(false);
  });
});

describe('partRegistries', () => {
  it('collects the registries of the parsed models and skips an entry with none', () => {
    const a = parseAssembly();
    const b = parseAssembly();
    const one = new MeshPartRegistry(a.root, a.tree);
    const two = new MeshPartRegistry(b.root, b.tree);

    expect(partRegistries({ a: { partRegistry: one }, b: { partRegistry: two } })).toEqual([one, two]);
    // A hand-built fixture entry has no registry, and an empty scene has no entries:
    // both are an empty list, which sends every hit to the tag walk.
    expect(partRegistries({ a: {} })).toEqual([]);
    expect(partRegistries({ a: undefined })).toEqual([]);
    expect(partRegistries({})).toEqual([]);
  });
});

describe('the handle contract the later stages hang off', () => {
  /**
   * The registry plus the objects it indexes, reached through the fixture's own group
   * rather than through the handles: what a handle is backed by is exactly what stage 4
   * changes, so a test that read it back would only be asserting the implementation it
   * is meant to be allowing for.
   */
  function fixture() {
    const { root, tree } = parseAssembly();
    root.updateMatrixWorld(true);
    const registry = new MeshPartRegistry(root, tree);
    const objects: THREE.Object3D[] = [];
    root.traverse((object) => objects.push(object));
    const meshNamed = (name: string): THREE.Mesh => {
      const found = objects.find(
        (one): one is THREE.Mesh => one instanceof THREE.Mesh && one.name === name,
      );
      if (!found) throw new Error(`the fixture has no mesh named ${name}`);
      return found;
    };
    return { root, tree, registry, objects, meshNamed };
  }

  it('bounds() is the same box setFromObject measures', () => {
    const { root, registry } = fixture();
    const viaRegistry = registry.bounds(new THREE.Box3());
    const viaThree = new THREE.Box3().setFromObject(root);
    expect(viaRegistry.min.toArray()).toEqual(viaThree.min.toArray());
    expect(viaRegistry.max.toArray()).toEqual(viaThree.max.toArray());
    expect(viaRegistry.isEmpty()).toBe(false);
  });

  it('getBoundingBox() answers in world space, so a moved part is found where it is', () => {
    const { root, registry } = fixture();
    const part = registry.parts().find((one) => one.name === 'Base Plate')!;
    const centreBefore = part.getBoundingBox(new THREE.Box3()).getCenter(new THREE.Vector3());

    part.setLocalTransform({ position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    root.updateMatrixWorld(true);
    const centreAfter = part.getBoundingBox(new THREE.Box3()).getCenter(new THREE.Vector3());

    // The POI walk and the orbit pivot both read a WORLD centre, and a box that
    // answered in parent space would put the agent's target ten units off.
    expect(centreAfter.x - centreBefore.x).toBeCloseTo(10, 5);
    expect(centreAfter.y).toBeCloseTo(centreBefore.y, 5);
  });

  it('round-trips a matrix and the three fields the gizmo writes', () => {
    const { registry } = fixture();
    const part = registry.parts().find((one) => one.name === 'Pad')!;
    const bind = part.getLocalTransform();

    const moved = new THREE.Matrix4().compose(
      new THREE.Vector3(1, 2, 3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, 0.5, 0)),
      new THREE.Vector3(2, 2, 2),
    );
    part.setMatrix(moved);

    // Compared with a tolerance rather than with `equals` or `toEqual`, both of which
    // are exact: a matrix set through a handle goes decompose → compose, because that
    // is what an Object3D does with its own position/quaternion/scale, and three
    // normalises the rotation and re-derives the scale on the way in. A scale of 2
    // comes back as 1.9999999999999998. Worth knowing for stage 3, where §3.5's
    // idempotence test has to allow the same drift; the gizmo itself is unaffected,
    // because it writes the three fields it reads off a real Object3D.
    const readBack = part.getMatrix(new THREE.Matrix4()).elements;
    moved.elements.forEach((value, index) => {
      expect(readBack[index], `element ${index}`).toBeCloseTo(value, 10);
    });
    const after = part.getLocalTransform();
    expect(after.position).toEqual([1, 2, 3]);
    after.scale.forEach((value, axis) => expect(value, `scale axis ${axis}`).toBeCloseTo(2, 10));
    expect(after.rotation[0]).toBeCloseTo(0.25, 10);
    expect(after.rotation[1]).toBeCloseTo(0.5, 10);

    // And writing the three fields directly IS exact, which is the path "Reset part"
    // and a PartTransform relayed from the room both take.
    part.setLocalTransform(bind);
    expect(part.getLocalTransform()).toEqual(bind);
    expect(part.getMatrix(new THREE.Matrix4()).equals(moved)).toBe(false);
  });

  it('setVisibleSubtree hides the part and everything below it, and gives it back', () => {
    const { tree, registry, objects } = fixture();

    registry.setVisibleSubtree(tree.id, false);
    for (const object of objects) expect(object.visible, object.name).toBe(false);

    registry.setVisibleSubtree(tree.id, true);
    for (const object of objects) expect(object.visible, object.name).toBe(true);

    // An id that is not this model's does nothing at all, rather than throwing: a
    // SCENE_STATE can name a part a stale client no longer has.
    registry.setVisibleSubtree('nope_0', false);
    for (const object of objects) expect(object.visible, object.name).toBe(true);
  });

  it('setHighlight lights every material of the part and gives them back', () => {
    const { registry, meshNamed } = fixture();
    // "Pad" is the fixture's multi-material part: the CAD reader splits a solid whose
    // faces differ in colour into one material per colour, and a highlight that only
    // wrote the first of them would leave half a part glowing.
    const pad = registry.parts().find((part) => part.name === 'Pad')!;
    const materials = meshNamed('Pad').material;
    expect(Array.isArray(materials)).toBe(true);
    const all = materials as THREE.MeshStandardMaterial[];

    pad.setHighlight({ color: new THREE.Color(0x0044aa), intensity: 0.5 });
    for (const material of all) {
      expect(material.emissive.getHex()).toBe(0x0044aa);
      expect(material.emissiveIntensity).toBe(0.5);
    }

    // Back to the material's OWN emissive, not to black: lib/scene/materialHighlight
    // exists because writing zero here permanently killed a file's warning stripes.
    pad.setHighlight(null);
    for (const material of all) {
      expect(material.emissive.getHex()).toBe(0x000000);
      expect(material.emissiveIntensity).toBe(1);
    }
  });

  it('dispose() drops the index', () => {
    const { registry, tree } = fixture();
    expect(registry.get(tree.id)).not.toBeNull();
    registry.dispose();
    expect(registry.parts().length).toBe(0);
    expect(registry.get(tree.id)).toBeNull();
  });
});
