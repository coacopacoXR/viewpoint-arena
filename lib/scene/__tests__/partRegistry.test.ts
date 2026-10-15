// The part registry — task 04b, stages 1 and 2.
//
// Four things here are load-bearing enough to have been called out as risks or defects
// in the render audit, and all four are about the registry AGREEING with what already
// exists rather than about the registry being clever:
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
//   • R1 — `bounds()` must be the box `Box3.setFromObject` measures today, because
//     every caller reads a wrong or an empty box as "there is nothing to frame" and
//     the thumbnails and the lobby previews go blank rather than throwing.
//   • D1 — a highlight must belong to ONE part. It used to be written onto a Material,
//     materials are shared, and selecting one bolt of a file whose 400 bolts share one
//     lit all 400 and left them lit.
//
// The rest is the contract the later stages hang off: picking, names, boxes,
// transforms, visibility, and the cost of a state change.
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
  type PartState,
  type PickHit,
} from '../partRegistry';
import { sceneModelPrefix } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'a1'.repeat(32);
const PREFIX = sceneModelPrefix(HASH);

/**
 * The one selection glow the app has: components/Scene/ImportedModel.tsx's
 * SELECTION_HIGHLIGHT, copied here rather than imported because a component module
 * cannot be imported into a node test without dragging R3F and a canvas with it.
 */
const GLOW = { color: new THREE.Color(0x0044aa), intensity: 0.5 };

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

  it('setHighlight lights every material of the part and gives the file its own back', () => {
    const { registry, meshNamed } = fixture();
    // "Pad" is the fixture's multi-material part: the CAD reader splits a solid whose
    // faces differ in colour into one material per colour, and a highlight that only
    // replaced the first of them would leave half a part glowing.
    const pad = registry.parts().find((part) => part.name === 'Pad')!;
    const mesh = meshNamed('Pad');
    const own = mesh.material as THREE.MeshStandardMaterial[];
    expect(Array.isArray(own)).toBe(true);

    pad.setHighlight(GLOW);
    const lit = mesh.material as THREE.MeshStandardMaterial[];
    // Drawn from private clones, one per material of the part. Writing the glow ONTO
    // `own` instead is the audit's D1: it lights every other part that shares them.
    expect(lit).not.toBe(own);
    for (const material of lit) {
      expect(material.emissive.getHex()).toBe(0x0044aa);
      expect(material.emissiveIntensity).toBe(0.5);
    }
    for (const material of own) {
      expect(material.emissive.getHex()).toBe(0x000000);
      // Never even stamped: remembering the original lazily exists so that a 40 000-part
      // assembly is not written to 40 000 times, and a source material is not touched at
      // all now.
      expect(material.userData.originalEmissive).toBeUndefined();
    }

    // Back to the file's own materials — the same objects, not copies of them, so a
    // texture or a vertex-colour attribute the file carried is still the one bound.
    pad.setHighlight(null);
    expect(mesh.material).toBe(own);
  });

  it('dispose() drops the index', () => {
    const { registry, tree } = fixture();
    expect(registry.get(tree.id)).not.toBeNull();
    registry.dispose();
    expect(registry.parts().length).toBe(0);
    expect(registry.get(tree.id)).toBeNull();
  });
});

describe('R1: the box every caller used to measure with Box3.setFromObject', () => {
  /**
   * Two parts, one 100 units out along x and one the other side of the origin, which is
   * the shape the placement comment in components/Scene/ImportedModel.tsx exists for: a
   * CAD part in millimetres, far from its own origin, used to be pushed ~100 scene units
   * away and never appeared.
   */
  function scattered() {
    const root = new THREE.Group();
    root.name = 'Scattered';
    const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const far = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), material);
    far.name = 'Far';
    far.position.set(100, 5, -40);
    const near = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), material);
    near.name = 'Near';
    near.position.set(-30, 0, 12);
    root.add(far, near);
    const tree = buildSceneTree(root, { value: 0 }, PREFIX)!;
    root.updateMatrixWorld(true);
    return { root, registry: new MeshPartRegistry(root, tree) };
  }

  it('is the same box, to the last decimal, for a model far from its own origin', () => {
    const { root, registry } = scattered();

    const viaRegistry = registry.bounds(new THREE.Box3());
    const viaThree = new THREE.Box3().setFromObject(root);

    expect(viaRegistry.min.distanceTo(viaThree.min)).toBeLessThan(1e-9);
    expect(viaRegistry.max.distanceTo(viaThree.max)).toBeLessThan(1e-9);
    // And the numbers are the parts', not something degenerate: a box that quietly
    // answered a buffer instead of the geometry would still be a box, and every caller
    // reads an empty or a wrong one as "there is nothing to frame".
    expect(viaRegistry.max.x).toBeCloseTo(105, 6);
    expect(viaRegistry.min.x).toBeCloseTo(-32, 6);
  });

  it('follows the model once it has been scaled, centred and dropped on the floor', () => {
    // Measured on demand rather than cached at build, and this is why: every caller runs
    // AFTER something moved the geometry — placeImportedGroup scales the group and then
    // measures it to find the floor, a variant moves individual parts, the lobby measures
    // a group it has just placed. A box captured at parse time would be the box of a
    // model nobody is looking at yet.
    const { root, registry } = scattered();
    root.scale.setScalar(0.02);
    root.position.set(0, 3, 0);
    root.updateMatrixWorld(true);

    const viaRegistry = registry.bounds(new THREE.Box3());
    const viaThree = new THREE.Box3().setFromObject(root);

    expect(viaRegistry.min.distanceTo(viaThree.min)).toBeLessThan(1e-9);
    expect(viaRegistry.max.distanceTo(viaThree.max)).toBeLessThan(1e-9);
    expect(viaRegistry.getSize(new THREE.Vector3()).x).toBeCloseTo(137 * 0.02, 6);
  });

  it('visibleBounds is bounds while the model is shown, and empty once it is not', () => {
    // The two are separate because the callers want different answers: lib/scene/
    // modelBounds frames a picture on what the room is SHOWING, so a model somebody hid
    // in the tree comes out of it, while placement measures the whole file or a hidden
    // bolt would move the floor under the parts still on screen.
    const { registry } = scattered();

    expect(registry.visibleBounds(new THREE.Box3()).equals(registry.bounds(new THREE.Box3()))).toBe(true);

    registry.setVisibleSubtree(registry.parts()[0].id, false);
    expect(registry.visibleBounds(new THREE.Box3()).isEmpty()).toBe(true);
    // The geometry has not gone anywhere, and the floor must not move with the eye toggle.
    expect(registry.bounds(new THREE.Box3()).isEmpty()).toBe(false);

    registry.setVisibleSubtree(registry.parts()[0].id, true);
    expect(registry.visibleBounds(new THREE.Box3()).isEmpty()).toBe(false);
  });
});

describe('D1: a highlight belongs to the part that was selected', () => {
  /**
   * Two bolts sharing ONE material, which is what a file does by default: utils/
   * modelLoader's ensureMeshMaterial converts a Basic/Lambert/Phong into a new Standard
   * material but for anything already standard it hands back the same object, so a GLB
   * or a STEP whose 400 bolts share a material has one Material between all of them.
   */
  function bolts() {
    const shared = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const root = new THREE.Group();
    root.name = 'Bolts';
    const left = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    left.name = 'Bolt Left';
    left.position.x = -2;
    const right = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    right.name = 'Bolt Right';
    right.position.x = 2;
    root.add(left, right);
    const tree = buildSceneTree(root, { value: 0 }, PREFIX)!;
    root.updateMatrixWorld(true);
    return { registry: new MeshPartRegistry(root, tree), left, right, shared };
  }

  const partNamed = (registry: MeshPartRegistry, name: string) => {
    const found = registry.parts().find((part) => part.name === name);
    if (!found) throw new Error(`the fixture has no part named ${name}`);
    return found;
  };

  it('lights one part and leaves the other on the file\'s own material', () => {
    const { registry, left, right, shared } = bolts();

    partNamed(registry, 'Bolt Left').setHighlight(GLOW);

    expect((left.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0x0044aa);
    expect((left.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.5);
    // The defect, and the assertion that failed before this stage: one material, so the
    // other bolt glowed too and stayed glowing after the selection moved on.
    expect(right.material).toBe(shared);
    expect(shared.emissive.getHex()).toBe(0x000000);
    expect(shared.userData.originalEmissive).toBeUndefined();

    partNamed(registry, 'Bolt Left').setHighlight(null);
    expect(left.material).toBe(shared);
  });

  it('draws every highlighted part from ONE clone per material, not one per part', () => {
    // Selecting a group inherits downward and can name every part of an assembly, so a
    // clone per part would allocate forty thousand materials to draw a glow that is the
    // same colour on all of them. Keyed on the source, the count is bounded by the file.
    const { registry, left, right, shared } = bolts();

    partNamed(registry, 'Bolt Left').setHighlight(GLOW);
    partNamed(registry, 'Bolt Right').setHighlight(GLOW);

    expect(left.material).toBe(right.material);
    expect(left.material).not.toBe(shared);
    expect((left.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0x0044aa);

    // And unselecting one leaves the other lit, which a shared write could never do.
    partNamed(registry, 'Bolt Left').setHighlight(null);
    expect(left.material).toBe(shared);
    expect((right.material as THREE.MeshStandardMaterial).emissive.getHex()).toBe(0x0044aa);
  });

  it('reuses the clone it already made, so selecting twice does not allocate twice', () => {
    const { registry, left } = bolts();
    const bolt = partNamed(registry, 'Bolt Left');

    bolt.setHighlight(GLOW);
    const first = left.material;
    bolt.setHighlight(null);
    bolt.setHighlight(GLOW);

    expect(left.material).toBe(first);
  });
});

describe('syncStates — a state change costs the parts that changed', () => {
  /**
   * An assembly of two groups of three bolts, sharing one material, tagged the way a
   * parse tags one. Nine parts, and the shape the cost claims are made about: a leaf is
   * one part, a group is a subtree.
   */
  function assembly() {
    const shared = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const root = new THREE.Group();
    root.name = 'Assembly';
    for (const side of ['Left', 'Right']) {
      const group = new THREE.Group();
      group.name = side;
      for (let index = 0; index < 3; index += 1) {
        const bolt = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
        bolt.name = `${side} Bolt ${index}`;
        bolt.position.set(index * 2, side === 'Left' ? 0 : 4, 0);
        group.add(bolt);
      }
      root.add(group);
    }
    const tree = buildSceneTree(root, { value: 0 }, PREFIX)!;
    root.updateMatrixWorld(true);

    const registry = new MeshPartRegistry(root, tree);
    const objects = new Map<string, THREE.Object3D>();
    root.traverse((object) => {
      if (object.name) objects.set(object.name, object);
    });
    const idOf = (name: string): string => {
      const found = registry.parts().find((part) => part.name === name);
      if (!found) throw new Error(`the fixture has no part named ${name}`);
      return found.id;
    };
    return { registry, objects, idOf, shared };
  }

  /**
   * An `objectStates` map holding only the ids named here. An id that is absent reads as
   * visible and unselected, which is what the store's own map says about a node it has
   * never seen.
   */
  function states(...changed: Array<[string, Partial<PartState>]>): Record<string, PartState> {
    const out: Record<string, PartState> = {};
    for (const [id, over] of changed) out[id] = { visible: true, selected: false, ...over };
    return out;
  }

  const glowing = (fixture: { objects: Map<string, THREE.Object3D> }, name: string): number => {
    const mesh = fixture.objects.get(name) as THREE.Mesh;
    return (mesh.material as THREE.MeshStandardMaterial).emissive.getHex();
  };

  it('writes nothing at all for a tree nobody has touched', () => {
    // The common case by a wide margin, and the one the walk it replaced never had: a
    // model sitting in a room was re-traversed, and every material in it re-written, on
    // every change to objectStates anywhere in the scene.
    const fixture = assembly();

    expect(fixture.registry.syncStates({}, GLOW)).toBe(0);
    expect(fixture.objects.get('Left Bolt 0')!.visible).toBe(true);
    expect(glowing(fixture, 'Left Bolt 0')).toBe(0x000000);
    expect(fixture.shared.userData.originalEmissive).toBeUndefined();
  });

  it('costs one part to select a part, and two to move the selection', () => {
    const fixture = assembly();
    const first = fixture.idOf('Left Bolt 0');
    const second = fixture.idOf('Right Bolt 2');

    expect(fixture.registry.syncStates(states([first, { selected: true }]), GLOW)).toBe(1);
    expect(glowing(fixture, 'Left Bolt 0')).toBe(0x0044aa);

    // store.ts's selectNode rewrites EVERY entry in objectStates to clear the old
    // selection, so a diff on object identity would see the whole scene as changed. The
    // diff is on the two booleans, and it is what keeps a click at two parts.
    expect(
      fixture.registry.syncStates(states([second, { selected: true }]), GLOW),
    ).toBe(2);
    expect(glowing(fixture, 'Left Bolt 0')).toBe(0x000000);
    expect(glowing(fixture, 'Right Bolt 2')).toBe(0x0044aa);
    expect(fixture.shared.emissive.getHex()).toBe(0x000000);
  });

  it('costs a group and everything in it to hide the group', () => {
    const fixture = assembly();
    const left = fixture.idOf('Left');

    // Four, not nine: the group and its three bolts, and nothing on the other side.
    expect(fixture.registry.syncStates(states([left, { visible: false }]), GLOW)).toBe(4);
    expect(fixture.objects.get('Left')!.visible).toBe(false);
    for (const index of [0, 1, 2]) {
      expect(fixture.objects.get(`Left Bolt ${index}`)!.visible, `Left Bolt ${index}`).toBe(false);
      expect(fixture.objects.get(`Right Bolt ${index}`)!.visible, `Right Bolt ${index}`).toBe(true);
    }
  });

  it('keeps a part hidden on its own when the group above it is shown again', () => {
    // The case a per-changed-id `setVisibleSubtree` would get wrong, and the reason the
    // inheritance lives in the registry: showing a group is not the same as showing every
    // part in it, because somebody may have turned one off first.
    const fixture = assembly();
    const left = fixture.idOf('Left');
    const bolt = fixture.idOf('Left Bolt 1');

    fixture.registry.syncStates(states([bolt, { visible: false }]), GLOW);
    expect(fixture.objects.get('Left Bolt 1')!.visible).toBe(false);

    fixture.registry.syncStates(states([bolt, { visible: false }], [left, { visible: false }]), GLOW);
    expect(fixture.objects.get('Left Bolt 0')!.visible).toBe(false);

    // The group comes back; the bolt does not.
    expect(fixture.registry.syncStates(states([bolt, { visible: false }]), GLOW)).toBe(3);
    expect(fixture.objects.get('Left Bolt 0')!.visible).toBe(true);
    expect(fixture.objects.get('Left Bolt 1')!.visible).toBe(false);
  });

  it('lights a whole group when the group is what was selected', () => {
    // Selection inherits downward exactly as visibility does, which is what the walk it
    // replaced did by threading `parentSelected` through the recursion.
    const fixture = assembly();

    fixture.registry.syncStates(states([fixture.idOf('Right'), { selected: true }]), GLOW);

    for (const index of [0, 1, 2]) {
      expect(glowing(fixture, `Right Bolt ${index}`), `Right Bolt ${index}`).toBe(0x0044aa);
      expect(glowing(fixture, `Left Bolt ${index}`), `Left Bolt ${index}`).toBe(0x000000);
    }
    // One clone between all three, from the same source material.
    const materials = [0, 1, 2].map((index) =>
      (fixture.objects.get(`Right Bolt ${index}`) as THREE.Mesh).material,
    );
    expect(new Set(materials).size).toBe(1);
    expect(materials[0]).not.toBe(fixture.shared);
  });

  it('takes the glow off again, and gives the file its own material back', () => {
    const fixture = assembly();
    const bolt = fixture.idOf('Left Bolt 0');

    fixture.registry.syncStates(states([bolt, { selected: true }]), GLOW);
    expect(fixture.registry.syncStates({}, GLOW)).toBe(1);

    expect(glowing(fixture, 'Left Bolt 0')).toBe(0x000000);
    expect((fixture.objects.get('Left Bolt 0') as THREE.Mesh).material).toBe(fixture.shared);
  });

  it('ignores an id that is not this model\'s, which is what a stale SCENE_STATE carries', () => {
    const fixture = assembly();
    expect(fixture.registry.syncStates(states(['nope_0', { visible: false }]), GLOW)).toBe(0);
    expect(fixture.objects.get('Left')!.visible).toBe(true);
  });
});
