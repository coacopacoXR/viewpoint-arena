// The room's cut plane as renderer state — task 08a.
//
// What is load-bearing here, and what has a silent failure mode:
//
//   • EVERY material a model can be drawn with has to hold the ONE shared plane, and the
//     four ways a model is drawn do not share a code path: a mesh batching left alone, a
//     BatchedMesh, the overlay mesh task 04b raises for a selected part, and the clone a
//     selection swaps onto a mesh. A material missed is a part that keeps drawing on the
//     far side of a section — the exact thing the cut is there to remove, and invisible in
//     a test that only looks at the mesh side.
//   • NOTHING that is not a model may hold it. The room, the floor, the grid, an avatar, a
//     laser and the cut's own guide rectangle all have to stay whole, because the one thing
//     a section view has to leave alone is the room you are standing in.
//   • A material created AFTER the cut was turned on has to be born cutting. Selections
//     happen while a meeting is looking at a section, and a clone made then is a material
//     no walk has ever seen.
//   • Turning the cut off has to give every material back exactly what the file brought:
//     its own `side`, its own `onBeforeCompile`, no `defines` of ours, no planes. A cut
//     that cannot be undone is not a view tool.
//   • The pick has to agree with the picture. Three's Raycaster never looks at a material's
//     clipping planes, so a hit on the clipped side is a hit on a face nobody can see.
//
// Fixtures are built the way lib/scene/__tests__/batchedParts.test.ts builds them, so the
// same description produces a model below BATCH_MIN_PARTS (drawn as the meshes it was
// parsed as) and one above it (drawn as batches) — and the cut has to be right on both
// sides of a number that depends only on how many parts a file happened to have.

import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  applyCut,
  CAP_COLOUR,
  CUT_PLANE,
  cutEnabled,
  isCutAway,
  setCutEnabled,
  syncCut,
  writeCutPlane,
} from '../cutPlane';
import { firstUncutHit, isHitCutAway, uncutHits } from '../cutPick';
import { partHighlightFlags, partHighlightMaterial, type EmissiveHighlight } from '../materialHighlight';
import { HighlightMaterials, MeshPartRegistry, hitParts, isPointableHit } from '../partRegistry';
import { BATCH_MIN_PARTS, BatchedPartRegistry } from '../batchedParts';
import { buildSceneTree } from '../../../utils/modelLoader';
import { sceneModelPrefix } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'a1'.repeat(32);
const PREFIX = sceneModelPrefix(HASH);

/**
 * The one selection glow the app has: components/Scene/ImportedModel.tsx's
 * SELECTION_HIGHLIGHT, copied rather than imported because a component module cannot be
 * imported into a node test without dragging R3F and a canvas with it.
 */
const GLOW: EmissiveHighlight = { color: new THREE.Color(0x0044aa), intensity: 0.5 };

/** The define the cap patch is guarded by, which is how a test tells a capped material. */
const CAP_DEFINE = 'USE_VIEWPOINT_CUT_CAP';

// ─── fixtures ───────────────────────────────────────────────────────────────

/**
 * A model of `bolts` boxes on two materials, as a group and its tree.
 *
 * Two materials so there is more than one thing to miss, and a count that can be pushed
 * over BATCH_MIN_PARTS so the same description builds either side of the batching line.
 */
function buildModel(bolts: number): { root: THREE.Group; tree: SceneNode; idOf: Map<string, string> } {
  const steel = new THREE.MeshStandardMaterial({ color: 0x8899aa, metalness: 0.6, roughness: 0.4 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xaa8844, metalness: 0.8, roughness: 0.3 });
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const root = new THREE.Group();
  root.name = 'Assembly';
  const idOf = new Map<string, string>();

  for (let index = 0; index < bolts; index += 1) {
    const mesh = new THREE.Mesh(geometry, index % 2 === 0 ? steel : brass);
    mesh.name = `Bolt ${index}`;
    mesh.position.set(index * 1.5 - (bolts * 1.5) / 2, 0, 0);
    root.add(mesh);
  }

  const tree = buildSceneTree(root, { value: 0 }, PREFIX);
  if (!tree) throw new Error('fixture produced no tree');
  root.traverse((object) => {
    const id = object.userData?.modelId;
    if (typeof id === 'string') idOf.set(object.name, id);
  });
  root.updateMatrixWorld(true);
  return { root, tree, idOf };
}

/** Every material in a graph, once each, in walk order. */
function materialsOf(root: THREE.Object3D): THREE.Material[] {
  const found: THREE.Material[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!found.includes(material)) found.push(material);
    }
  });
  return found;
}

const hasCut = (material: THREE.Material): boolean =>
  Array.isArray(material.clippingPlanes) && material.clippingPlanes.includes(CUT_PLANE);

/**
 * A scene that holds a model AND the things that are not one.
 *
 * The room's own furniture, built the way the app builds it: a floor with no `modelId`, an
 * agent whose name starts with 'Agent', a laser dot tagged `skipRaycast`, and a helper
 * tagged the way lib/scene/captureClean.ts reads helpers. None of them may end up clipping,
 * and the only thing standing between them and the plane is that `applyCut` is handed the
 * model's group and not the scene.
 */
function buildRoom(bolts: number) {
  const model = buildModel(bolts);
  const scene = new THREE.Scene();
  const room = new THREE.Group();
  room.name = 'Room';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 20),
    new THREE.MeshStandardMaterial({ color: 0xdddddd }),
  );
  floor.name = 'Floor';
  floor.rotation.x = -Math.PI / 2;

  const agent = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 1.8, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xff4400 }),
  );
  agent.name = 'Agent-1';

  const laserDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.035),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  laserDot.name = 'LaserDot';
  laserDot.userData.skipRaycast = true;

  const gizmo = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.2),
    new THREE.MeshBasicMaterial({ color: 0xfbbf24 }),
  );
  gizmo.name = 'TransformControlsGizmo';
  gizmo.userData.editingHelper = true;

  room.add(floor, agent, laserDot, gizmo);
  scene.add(room, model.root);
  scene.updateMatrixWorld(true);

  return { ...model, scene, notModel: [floor, agent, laserDot, gizmo] };
}

/** Put the room into the state the cut's own component puts it into. */
function enableCut(axis: 'x' | 'y' | 'z' = 'x', position = 0.5, flip = false) {
  const bounds = new THREE.Box3().setFromObject(CURRENT.root);
  const cutting = writeCutPlane({ axis, position, flip }, bounds);
  setCutEnabled(cutting);
  applyCut(CURRENT.root);
  return cutting;
}

/**
 * Resolve a plane against a box WITHOUT touching any material.
 *
 * The half of `enableCut` the geometry tests need: what the plane's sign convention does is
 * a question about a Plane and a point, and a test that also had to build a model to ask it
 * would be testing two things and failing for either.
 */
function resolve(cut: { axis: 'x' | 'y' | 'z'; position: number; flip: boolean }, bounds: THREE.Box3) {
  const resolved = writeCutPlane(cut, bounds);
  setCutEnabled(resolved);
  return resolved;
}

/** The fixture the shared helpers below resolve against. */
let CURRENT: { root: THREE.Group };

afterEach(() => {
  // Module state, and a test that leaves the room cutting would cut every fixture after it.
  setCutEnabled(false);
  if (CURRENT) applyCut(CURRENT.root);
  writeCutPlane(null, new THREE.Box3());
  CURRENT = { root: new THREE.Group() };
});

// ─── the shared plane ───────────────────────────────────────────────────────

describe('the shared plane', () => {
  it('is one instance, held by reference by every material, so moving it moves them all', () => {
    const fixture = buildRoom(4);
    CURRENT = fixture;
    enableCut('x', 0.5);

    const materials = materialsOf(fixture.root);
    expect(materials.length).toBe(2);
    for (const material of materials) {
      expect(material.clippingPlanes).toHaveLength(1);
      // The SAME object and not a copy: a copy would be a plane nobody updates when the
      // slider moves, and the room would be left cutting where the last model was.
      expect(material.clippingPlanes?.[0]).toBe(CUT_PLANE);
    }
  });

  it('resolves 0 to the near end of the bounds, 1 to the far end and 0.5 to the middle', () => {
    const fixture = buildRoom(4);
    CURRENT = fixture;
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    const span = bounds.max.x - bounds.min.x;

    resolve({ axis: 'x', position: 0, flip: false }, bounds);
    // Three clips the NEGATIVE side of a plane, so the normal points into what stays and
    // the kept half answers a signed distance of zero or more.
    expect(CUT_PLANE.distanceToPoint(new THREE.Vector3(bounds.min.x, 0, 0))).toBeCloseTo(0);
    expect(isCutAway(new THREE.Vector3(bounds.min.x + span * 0.5, 0, 0))).toBe(true);

    resolve({ axis: 'x', position: 0.5, flip: false }, bounds);
    expect(CUT_PLANE.distanceToPoint(new THREE.Vector3(bounds.min.x + span * 0.5, 0, 0))).toBeCloseTo(0);
    expect(isCutAway(new THREE.Vector3(bounds.min.x, 0, 0))).toBe(false);
    expect(isCutAway(new THREE.Vector3(bounds.max.x, 0, 0))).toBe(true);

    resolve({ axis: 'x', position: 1, flip: false }, bounds);
    expect(CUT_PLANE.distanceToPoint(new THREE.Vector3(bounds.max.x, 0, 0))).toBeCloseTo(0);
    expect(isCutAway(new THREE.Vector3(bounds.min.x, 0, 0))).toBe(false);
  });

  it.each(['x', 'y', 'z'] as const)('cuts perpendicular to %s', (axis) => {
    const fixture = buildRoom(4);
    CURRENT = fixture;
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    resolve({ axis, position: 0.5, flip: false }, bounds);

    const centre = bounds.getCenter(new THREE.Vector3());
    const along = centre.clone();
    if (axis === 'x') along.x = bounds.max.x;
    if (axis === 'y') along.y = bounds.max.y;
    if (axis === 'z') along.z = bounds.max.z;
    const across = centre.clone();
    if (axis === 'x') across.y = bounds.min.y;
    if (axis === 'y') across.x = bounds.min.x;
    if (axis === 'z') across.x = bounds.min.x;

    expect(isCutAway(along)).toBe(true);
    expect(isCutAway(across)).toBe(false);
  });

  it('cuts the other side when flipped', () => {
    const fixture = buildRoom(4);
    CURRENT = fixture;
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    const near = new THREE.Vector3(bounds.min.x, 0, 0);
    const far = new THREE.Vector3(bounds.max.x, 0, 0);

    resolve({ axis: 'x', position: 0.5, flip: false }, bounds);
    expect(isCutAway(near)).toBe(false);
    expect(isCutAway(far)).toBe(true);

    resolve({ axis: 'x', position: 0.5, flip: true }, bounds);
    expect(isCutAway(near)).toBe(true);
    expect(isCutAway(far)).toBe(false);
  });

  it('parks the plane far away for no cut, and for bounds with nothing in them', () => {
    setCutEnabled(true);
    // A room with no visible model: `writeCutPlane` answers false and the plane is parked,
    // so a material this walk never reached clips nothing rather than taking a slice out of
    // whatever it is drawing.
    expect(writeCutPlane({ axis: 'x', position: 0.5, flip: false }, new THREE.Box3())).toBe(false);
    expect(isCutAway(new THREE.Vector3(1e9, 1e9, 1e9))).toBe(false);

    const fixture = buildRoom(4);
    CURRENT = fixture;
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    expect(writeCutPlane(null, bounds)).toBe(false);
    expect(isCutAway(bounds.getCenter(new THREE.Vector3()))).toBe(false);
  });

  it('says nothing is cut away while the room is not cutting, wherever the plane is', () => {
    const fixture = buildRoom(4);
    CURRENT = fixture;
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    writeCutPlane({ axis: 'x', position: 0.5, flip: false }, bounds);
    setCutEnabled(false);

    expect(cutEnabled()).toBe(false);
    expect(isCutAway(new THREE.Vector3(bounds.max.x, 0, 0))).toBe(false);
  });
});

// ─── which materials get it ─────────────────────────────────────────────────

describe('which materials the cut reaches', () => {
  it('reaches every material of a model drawn as the meshes it was parsed as', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    expect(applyCut(fixture.root)).toBe(6); // three meshes per material, six meshes, two materials
    enableCut('x', 0.5);
    expect(applyCut(fixture.root)).toBe(6);

    const materials = materialsOf(fixture.root);
    expect(materials).toHaveLength(2);
    for (const material of materials) expect(hasCut(material)).toBe(true);
  });

  it('reaches every material of a model drawn as batches, and the batch is one of them', () => {
    const bolts = BATCH_MIN_PARTS + 40;
    const fixture = buildRoom(bolts);
    CURRENT = fixture;
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    try {
      const batches: THREE.BatchedMesh[] = [];
      fixture.root.traverse((object) => {
        if ((object as THREE.BatchedMesh).isBatchedMesh === true) batches.push(object as THREE.BatchedMesh);
      });
      expect(batches.length).toBeGreaterThan(0);

      enableCut('x', 0.5);

      // A batch draws every one of its instances from ONE material, so this is the case a
      // per-mesh walk would have missed entirely.
      for (const batch of batches) expect(hasCut(batch.material as THREE.Material)).toBe(true);
      const materials = materialsOf(fixture.root);
      expect(materials.length).toBeGreaterThan(0);
      for (const material of materials) expect(hasCut(material)).toBe(true);
      expect(registry.parts().length).toBeGreaterThanOrEqual(bolts);
    } finally {
      registry.dispose();
    }
  });

  it('reaches a highlight clone swapped onto a mesh, and the overlay raised for a batched part', () => {
    const bolts = BATCH_MIN_PARTS + 40;
    const fixture = buildRoom(bolts);
    CURRENT = fixture;
    const registry = new BatchedPartRegistry(fixture.root, fixture.tree);
    try {
      enableCut('x', 0.5);

      // A selection under the overlay cap raises an overlay Mesh whose material is a clone
      // made AFTER the cut was turned on, by a code path that never sees the model walk.
      const states: Record<string, { visible: boolean; selected: boolean }> = {};
      const first = registry.parts()[1];
      states[first.id] = { visible: true, selected: true };
      registry.syncStates(states, GLOW);

      const overlays: THREE.Mesh[] = [];
      fixture.root.traverse((object) => {
        if (object.name === 'PartHighlight') overlays.push(object as THREE.Mesh);
      });
      expect(overlays).toHaveLength(1);
      expect(hasCut(overlays[0].material as THREE.Material)).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('reaches the clone a selection swaps onto a mesh batching left alone', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    const registry = new MeshPartRegistry(fixture.root, fixture.tree);
    try {
      enableCut('x', 0.5);
      // A LEAF, by the id the tree gave it. `registry.parts()[0]` is the model's own root —
      // buildSceneTree tags it too — and a group has no material to swap.
      const id = fixture.idOf.get('Bolt 3');
      if (!id) throw new Error('the fixture has no Bolt 3');
      const target = registry.get(id);
      expect(target).not.toBeNull();
      registry.syncStates({ [id]: { visible: true, selected: true } }, GLOW);

      const mesh = fixture.root.getObjectByName('Bolt 3') as THREE.Mesh;
      // The clone, not the file's material — and it was born after the cut was on.
      expect(hasCut(mesh.material as THREE.Material)).toBe(true);
      expect(mesh.material).not.toBe((fixture.root.getObjectByName('Bolt 1') as THREE.Mesh).material);
    } finally {
      registry.dispose();
    }
  });

  it('leaves the room, the agents, the lasers and the helpers whole', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    enableCut('x', 0.5);

    for (const object of fixture.notModel) {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.Material;
      expect(hasCut(material)).toBe(false);
      expect(material.clippingPlanes ?? null).toBeNull();
      expect((material as THREE.Material & { defines?: Record<string, unknown> }).defines?.[CAP_DEFINE]).toBeUndefined();
    }
    // And the scene as a whole: only the model's two materials clip.
    const clipping = materialsOf(fixture.scene).filter(hasCut);
    expect(clipping).toHaveLength(2);
    expect(materialsOf(fixture.root).every(hasCut)).toBe(true);
  });
});

// ─── materials born after the cut ───────────────────────────────────────────

describe('a material created after the cut was turned on', () => {
  it('is born cutting, from the registry that makes every highlight clone', () => {
    const source = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    const highlighted = new HighlightMaterials();
    try {
      setCutEnabled(false);
      const before = highlighted.of(source, GLOW);
      expect(hasCut(before)).toBe(false);

      setCutEnabled(true);
      // The cached path as well as the fresh one: a clone made while the room was NOT
      // cutting is handed out again while it is, and a plane it never had is not a plane it
      // can be assumed to have.
      expect(highlighted.of(source, GLOW)).toBe(before);
      expect(hasCut(before)).toBe(true);

      const second = highlighted.of(new THREE.MeshStandardMaterial({ color: 0xaa8844 }), GLOW);
      expect(hasCut(second)).toBe(true);
      expect(second.clippingPlanes?.[0]).toBe(CUT_PLANE);
    } finally {
      setCutEnabled(false);
      highlighted.dispose();
    }
  });

  it('is born cutting, from the batch glow clone task 04c makes', () => {
    const source = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    setCutEnabled(true);
    const clone = partHighlightMaterial(source, GLOW, partHighlightFlags(8));
    try {
      expect(clone).not.toBeNull();
      expect(hasCut(clone!)).toBe(true);
    } finally {
      setCutEnabled(false);
      clone?.dispose();
    }
  });

  it('composes with task 04c’s per-instance glow rather than replacing it', () => {
    // The ordering this pins: `partHighlightMaterial` assigns its own `onBeforeCompile`
    // AFTER `highlightClone` has run, so a cut patch installed first would be overwritten
    // and a batch would stop being cut the first time one of its parts was selected past
    // the overlay cap. `syncCut` runs last and wraps whatever is there.
    const source = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    setCutEnabled(true);
    const clone = partHighlightMaterial(source, GLOW, partHighlightFlags(8));
    try {
      const shader = {
        vertexShader: ['#include <batching_pars_vertex>', '#include <batching_vertex>'].join('\n'),
        fragmentShader: [
          '#include <common>',
          '#include <emissivemap_pars_fragment>',
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          '#include <roughnessmap_fragment>',
          '#include <metalnessmap_fragment>',
          'vec3 totalEmissiveRadiance = emissive;',
        ].join('\n'),
        uniforms: {} as Record<string, { value: unknown }>,
      };
      clone!.onBeforeCompile(shader as never, {} as never);

      // Task 04c's half: the per-instance glow, read with gl_DrawID.
      expect(shader.vertexShader).toContain('partHighlightTexture');
      expect(shader.fragmentShader).toContain('totalEmissiveRadiance = mix(');
      expect(shader.uniforms.partBaseEmissive).toBeDefined();
      // This task's half: the cap.
      expect(shader.fragmentShader).toContain('viewpointCutCap');
      expect(shader.fragmentShader).toContain('gl_FrontFacing');
      expect(shader.uniforms.viewpointCutCap.value).toBe(CAP_COLOUR);
      // Both patches declare themselves to the program cache key, so a capped material never
      // shares a program with an uncapped one.
      const defines = (clone as THREE.Material & { defines?: Record<string, unknown> }).defines ?? {};
      expect(defines.USE_PART_HIGHLIGHT).toBe('');
      expect(defines[CAP_DEFINE]).toBe('');
    } finally {
      setCutEnabled(false);
      clone?.dispose();
    }
  });

  it('gives a fresh material the cap even when the room is not cutting, so no program is shared across the change', () => {
    const source = new THREE.MeshStandardMaterial({ color: 0x8899aa });
    setCutEnabled(false);
    const highlighted = new HighlightMaterials();
    try {
      const clone = highlighted.of(source, GLOW);
      expect(hasCut(clone)).toBe(false);
      // Turning the cut on later finds it, because the registry hands it out again through
      // `of` — which is the call every highlight in the app goes through.
      setCutEnabled(true);
      syncCut(clone);
      expect(hasCut(clone)).toBe(true);
      expect(clone.side).toBe(THREE.DoubleSide);
    } finally {
      setCutEnabled(false);
      highlighted.dispose();
    }
  });
});

// ─── turning it off ─────────────────────────────────────────────────────────

describe('turning the cut off', () => {
  it('gives every material back what the file brought', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    const materials = materialsOf(fixture.root);
    const before = materials.map((material) => ({
      side: material.side,
      onBeforeCompile: material.onBeforeCompile,
      clippingPlanes: material.clippingPlanes,
    }));

    enableCut('x', 0.5);
    for (const material of materials) {
      expect(hasCut(material)).toBe(true);
      expect(material.side).toBe(THREE.DoubleSide);
    }

    setCutEnabled(false);
    applyCut(fixture.root);

    materials.forEach((material, index) => {
      expect(material.clippingPlanes ?? null).toBe(before[index].clippingPlanes ?? null);
      expect(material.side).toBe(before[index].side);
      expect(material.onBeforeCompile).toBe(before[index].onBeforeCompile);
      const defines = (material as THREE.Material & { defines?: Record<string, unknown> }).defines;
      expect(defines?.[CAP_DEFINE]).toBeUndefined();
      expect(material.userData.viewpointCutCap).toBeUndefined();
    });
    expect(cutEnabled()).toBe(false);
  });

  it('takes the cut off a mesh whose material a selection had swapped, once the selection ends', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    const registry = new MeshPartRegistry(fixture.root, fixture.tree);
    try {
      enableCut('x', 0.5);
      const target = registry.parts()[0];
      registry.syncStates({ [target.id]: { visible: true, selected: true } }, GLOW);
      registry.syncStates({ [target.id]: { visible: true, selected: false } }, GLOW);

      setCutEnabled(false);
      applyCut(fixture.root);

      for (const material of materialsOf(fixture.root)) expect(hasCut(material)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('leaves nothing behind once the registry that made the clones is disposed', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    const registry = new MeshPartRegistry(fixture.root, fixture.tree);
    enableCut('x', 0.5);
    registry.syncStates(
      { [registry.parts()[0].id]: { visible: true, selected: true } },
      GLOW,
    );
    expect(materialsOf(fixture.root).some(hasCut)).toBe(true);

    // The teardown the cut's own component does on unmount, in the order it does it: the
    // flag first, so every material the walk reaches is taken off the plane, and the walk
    // second. A registry disposed without them would leave clones holding a plane nothing
    // resolves any more — and the plane is a module-level constant, so the NEXT room would
    // inherit the section.
    registry.dispose();
    setCutEnabled(false);
    applyCut(fixture.root);

    for (const material of materialsOf(fixture.root)) {
      expect(hasCut(material)).toBe(false);
      expect((material as THREE.Material & { defines?: Record<string, unknown> }).defines?.[CAP_DEFINE]).toBeUndefined();
    }
    expect(cutEnabled()).toBe(false);
  });
});

// ─── the pick ───────────────────────────────────────────────────────────────

describe('a ray into a cut model', () => {
  /** A ray along −X through the middle of the fixture, nearest hit first. */
  function castThrough(fixture: { root: THREE.Group }) {
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    const centre = bounds.getCenter(new THREE.Vector3());
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(bounds.max.x + 10, centre.y, centre.z),
      new THREE.Vector3(-1, 0, 0),
    );
    return raycaster.intersectObjects([fixture.root], true);
  }

  it('reports the parts on both sides of the plane, because three’s raycaster does not clip', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    // The claim the filter exists for: a real Raycaster over a real clipped model still
    // answers hits on the side nobody can see.
    enableCut('x', 0.5);
    const hits = castThrough(fixture);
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.some((hit) => isCutAway(hit.point))).toBe(true);
    expect(hits.some((hit) => !isCutAway(hit.point))).toBe(true);
  });

  it('drops the hits behind the cut and keeps the order of the ones in front', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    enableCut('x', 0.5);

    const hits = castThrough(fixture);
    const kept = uncutHits(hits);
    expect(kept.length).toBeLessThan(hits.length);
    expect(kept.every((hit) => !isCutAway(hit.point))).toBe(true);
    // Nearest first, and the kept ones in the same relative order the raycaster answered:
    // "take the next hit" is what every caller's own loop already does, so nothing had to
    // learn to walk past one. The first kept hit is the first hit that is not cut away,
    // which in this fixture is NOT `hits[0]` — the ray enters through the cut side.
    expect(kept[0]).toBe(hits.find((hit) => !isCutAway(hit.point)));
    const distances = kept.map((hit) => hit.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('costs nothing and allocates nothing when there is no cut', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    setCutEnabled(false);
    const hits = castThrough(fixture);
    // The SAME array back, which is what keeps a laser running sixty times a second from
    // allocating sixty arrays a second.
    expect(uncutHits(hits)).toBe(hits);
    expect(uncutHits(hits)).toHaveLength(hits.length);
  });

  it('answers the visible part as the one a click selects', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    const registry = new MeshPartRegistry(fixture.root, fixture.tree);
    try {
      enableCut('x', 0.5);
      const hits = castThrough(fixture);
      const visible = firstUncutHit(hits);
      expect(visible).not.toBeNull();

      const parts = hitParts(visible!, [registry]);
      expect(parts.modelId).not.toBeNull();
      expect(isPointableHit(visible!)).toBe(true);
      // The part the section is showing is on the kept side of the plane, which is the whole
      // of "clicking into a cut model selects the part you see in the section".
      expect(isCutAway(visible!.point)).toBe(false);
      const cutSide = hits.filter((hit) => isCutAway(hit.point));
      expect(cutSide.length).toBeGreaterThan(0);
      expect(cutSide.every((hit) => hitParts(hit, [registry]).modelId !== null)).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('keeps a hit exactly on the plane, which is three’s own rule and the one the cap draws on', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    // Position 0 puts the plane on the model's near face, so that face is exactly ON it.
    // Three discards where the signed distance is strictly negative, so a fragment on the
    // plane is drawn — which is what makes the cap the model's own surface rather than a
    // hole one fragment wide at the end of a slider's travel. The pick has to agree, or the
    // last click of a drag would select nothing at all.
    enableCut('x', 0);
    const hits = castThrough(fixture);
    const onThePlane = hits.filter((hit) => CUT_PLANE.distanceToPoint(hit.point) === 0);
    expect(onThePlane.length).toBeGreaterThan(0);
    expect(uncutHits(hits)).toEqual(expect.arrayContaining(onThePlane));
    for (const hit of onThePlane) expect(isHitCutAway(hit)).toBe(false);
  });

  it('drops every hit of a model the plane has passed completely', () => {
    const fixture = buildRoom(6);
    CURRENT = fixture;
    // Past the far end rather than at it, so nothing is left on the boundary: a plane at
    // `position: 1` still touches the model's own far face, and "the whole model is gone"
    // is a claim about a plane that has moved beyond it.
    const bounds = new THREE.Box3().setFromObject(fixture.root);
    resolve({ axis: 'x', position: 1, flip: true }, bounds);
    CUT_PLANE.constant -= 1;

    const hits = castThrough(fixture);
    expect(hits.length).toBeGreaterThan(0);
    expect(uncutHits(hits)).toHaveLength(0);
    expect(firstUncutHit(hits)).toBeNull();
  });

  it('says a hit with no point to test is not one the cut took', () => {
    expect(isHitCutAway(null)).toBe(false);
    expect(isHitCutAway(undefined)).toBe(false);
  });
});
