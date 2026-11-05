// Whether the model is hiding a comment bubble or a review pin — task 09a.
//
// What is load-bearing here, and what fails silently when it is wrong:
//
//   • A marker on the FAR side of a part is hidden. That is the whole feature, and it is the
//     one a person notices: a comment floating over the geometry that is in front of it.
//   • A marker ON the surface it was placed on is NOT hidden by that surface. The anchor is
//     the placement raycast's own hit point, so the surface is guaranteed to be in the way at
//     exactly the anchor's distance — get the margin wrong and every comment in the room
//     fades the moment it is dropped.
//   • Only the PRODUCT can hide anything. An avatar, a laser, the gizmo's picker meshes and
//     another pin are all in the scene graph and none of them is the thing under discussion.
//   • A part the Model Tree has hidden stops hiding markers, because three's Raycaster never
//     reads `Object3D.visible` and the registry's `partChainForHit` is the only thing that
//     does.
//   • Geometry the room has CUT AWAY stops hiding markers, through the same `firstUncutHit`
//     every other pick path uses — a marker behind a section is a marker in open air.
//   • The answer follows where the parts ARE, not where they were parsed: an exploded or
//     dragged part occludes from its displayed position.
//   • A pass runs when something moved and not otherwise. This is the half that is invisible
//     when it is wrong and expensive when it is wrong the other way: the room renders on
//     demand, so a pass that runs when nothing moved is a canvas that never sleeps.
//
// The fixtures are real three objects and a real `Raycaster`, the way
// components/Scene/__tests__/sceneClickSelect.test.tsx builds them. A fake that answered
// "the wall is in the way" would be a test of the fake.

import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { MeshPartRegistry, type PartRegistry } from '../partRegistry';
import { setCutEnabled, writeCutPlane } from '../cutPlane';
import {
  OCCLUSION_EPSILON_MIN,
  OCCLUSION_MIN_INTERVAL_MS,
  clearOccludedMarkers,
  currentMarkerVersion,
  isAnchorOccluded,
  occludedMarkerCount,
  occlusionEpsilon,
  readOcclusionInputs,
  registerOccludedMarker,
  sameOcclusionInputs,
  shouldRunOcclusionPass,
  type OccludedMarker,
  type OcclusionProbe,
} from '../markerOcclusion';
import type { SceneNode } from '../../../types';

const MODEL = 'model_root';
const WALL = 'model_wall';
const TARGET = 'model_target';

/** The eye, five units in front of the wall and ten in front of the target. */
const EYE = new THREE.Vector3(0, 0, 10);
/**
 * Where the comment is: on the near face of the target, which is the part behind the wall.
 *
 * ON the face rather than at the part's centre, because that is what a placement raycast
 * answers and because the centre would be inside the mesh — a ray to a point inside a box
 * strikes the box's own front face well short of it, and the fixture would be measuring the
 * margin instead of the wall.
 */
const BEHIND = new THREE.Vector3(0, 0, -5.1);
/** Where a comment on the wall's own near face is. */
const ON_THE_WALL = new THREE.Vector3(0, 0, 0.1);

interface Room {
  root: THREE.Group;
  wall: THREE.Mesh;
  target: THREE.Mesh;
  probe: OcclusionProbe;
}

/** A tagged mesh, the way utils/modelLoader's buildSceneTree tags one. */
function tagged(id: string, size: [number, number, number], z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial(),
  );
  mesh.name = id;
  mesh.position.set(0, 0, z);
  mesh.userData.modelId = id;
  mesh.userData.nodeId = id;
  return mesh;
}

/**
 * One model with two parts in it: a wall at z=0 and a target whose near face is at z=-5.1,
 * with the eye at z=10.
 *
 * A registry is built over it because that is what the room has, and the registry is the
 * only thing in the pick path that knows a part was hidden — see `partChainForHit`.
 */
function buildRoom(): Room {
  const root = new THREE.Group();
  root.name = 'Assembly';
  root.userData.modelId = MODEL;
  root.userData.nodeId = MODEL;

  const wall = tagged(WALL, [2, 2, 0.2], 0);
  const target = tagged(TARGET, [2, 2, 0.2], -5.2);
  root.add(wall, target);
  root.updateMatrixWorld(true);

  const tree: SceneNode = {
    id: MODEL,
    name: 'Assembly',
    type: 'GROUP',
    children: [
      { id: WALL, name: 'Wall', type: 'MESH' },
      { id: TARGET, name: 'Target', type: 'MESH' },
    ],
  };

  const probe: OcclusionProbe = {
    raycaster: new THREE.Raycaster(),
    roots: [root],
    registries: [new MeshPartRegistry(root, tree)] as PartRegistry[],
  };
  return { root, wall, target, probe };
}

function occluded(room: Room, anchor: THREE.Vector3, attachedTo: string | null = null): boolean {
  return isAnchorOccluded(anchor, EYE, room.probe, attachedTo);
}

afterEach(() => {
  setCutEnabled(false);
  clearOccludedMarkers();
});

describe('what hides a marker', () => {
  it('is a part standing between the eye and the anchor', () => {
    const room = buildRoom();
    expect(occluded(room, BEHIND)).toBe(true);
  });

  it('is nothing when the anchor is on the near side of every part', () => {
    const room = buildRoom();
    // In front of the wall, from the eye's point of view: the target is behind the anchor
    // and so is the wall.
    expect(occluded(room, new THREE.Vector3(0, 0, 5))).toBe(false);
  });

  it('is nothing when the anchor is off to the side of every part', () => {
    const room = buildRoom();
    // Level with the target but two units to the right of a wall that is one unit either
    // side of the axis: no geometry between, and no grazing hit on the wall either.
    expect(occluded(room, new THREE.Vector3(4, 0, -5.1))).toBe(false);
  });

  it('is nothing at all when the room has no model in it', () => {
    const room = buildRoom();
    // World's group is null until it has committed, and an empty models list is the honest
    // answer rather than a raycast against nothing.
    room.probe.roots = [];
    expect(occluded(room, BEHIND)).toBe(false);
  });
});

describe('what does NOT hide a marker', () => {
  it('is not the surface the marker was placed on', () => {
    const room = buildRoom();
    // The anchor is the placement raycast's own hit point, so the wall is struck at exactly
    // the anchor's distance — and it is the wall the comment belongs to, named as such.
    expect(occluded(room, ON_THE_WALL, WALL)).toBe(false);
  });

  it('is not the surface the marker sits on even when nobody named the part', () => {
    const room = buildRoom();
    // A comment curated before attachments existed has no `attachedToNodeId`. The distance
    // margin alone has to carry it, which is what OCCLUSION_EPSILON_MIN is for: at ten units
    // the relative margin is 0.05 and the wall's own face is 0.1 away.
    expect(occlusionEpsilon(10)).toBeGreaterThan(0);
    expect(occluded(room, ON_THE_WALL)).toBe(false);
  });

  it('is not a part somebody hid in the Model Tree', () => {
    const room = buildRoom();
    expect(occluded(room, BEHIND)).toBe(true);
    room.wall.visible = false;
    // Three's Raycaster never reads `visible`; the registry's `partChainForHit` does, and
    // answering an empty chain is what makes the wall not the product any more.
    expect(occluded(room, BEHIND)).toBe(false);
  });

  it('is not geometry the room has cut away', () => {
    const room = buildRoom();
    expect(occluded(room, BEHIND)).toBe(true);
    // A section along z at the middle of a box from -2 to 0 keeps z <= -1 and takes the
    // wall at z=0 away, leaving the target at z=-5 standing.
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -2), new THREE.Vector3(1, 1, 0));
    writeCutPlane({ axis: 'z', position: 0.5, flip: false }, bounds);
    setCutEnabled(true);
    expect(occluded(room, BEHIND)).toBe(false);
    setCutEnabled(false);
    expect(occluded(room, BEHIND)).toBe(true);
  });

  it('is not an object that is in the scene but is not the product', () => {
    const room = buildRoom();
    // An avatar, a laser beam and the gizmo's own picker meshes are all inside the canvas.
    // They are outside World's models group in the app, and untagged here — either way the
    // answer has to be that they hide nothing.
    const helper = new THREE.Mesh(
      new THREE.BoxGeometry(4, 4, 0.2),
      new THREE.MeshBasicMaterial(),
    );
    helper.position.set(0, 0, 5);
    helper.userData.skipRaycast = true;
    room.root.add(helper);
    room.root.updateMatrixWorld(true);
    expect(occluded(room, BEHIND)).toBe(true); // the wall is still there
    room.wall.visible = false;
    expect(occluded(room, BEHIND)).toBe(false); // and the helper is not a substitute
  });

  it('is not a part that has been moved out of the way', () => {
    const room = buildRoom();
    expect(occluded(room, BEHIND)).toBe(true);
    // What an explode and a gizmo drag both do: write the part's transform and leave the
    // registry to answer from where it now stands. The pass reads `matrixWorld`, so a part
    // pushed behind the anchor stops hiding it.
    room.wall.position.set(0, 0, -12);
    room.root.updateMatrixWorld(true);
    expect(occluded(room, BEHIND)).toBe(false);
  });

  it('is not a part pushed sideways by an explode', () => {
    const room = buildRoom();
    expect(occluded(room, BEHIND)).toBe(true);
    room.wall.position.set(6, 0, 0);
    room.root.updateMatrixWorld(true);
    expect(occluded(room, BEHIND)).toBe(false);
  });
});

describe('the margin that keeps a marker from hiding itself', () => {
  it('is a fraction of the distance, with a floor under it', () => {
    expect(occlusionEpsilon(10)).toBeCloseTo(0.05, 6);
    expect(occlusionEpsilon(100)).toBeCloseTo(0.5, 6);
    // A camera brought right up to a part: the fraction alone would fall under the
    // precision of the geometry's own vertices, which is exactly where somebody leans in to
    // look at the thing they commented on.
    expect(occlusionEpsilon(0.01)).toBe(OCCLUSION_EPSILON_MIN);
  });

  it('is under the depth of a real part, so a thin flange still hides what is behind it', () => {
    const room = buildRoom();
    // The wall is 0.2 deep and ten units away, so the margin is a quarter of it: a marker
    // on the FAR face is still hidden by the wall, which is the answer that makes the
    // feature mean anything.
    expect(occluded(room, new THREE.Vector3(0, 0, -0.1))).toBe(true);
    expect(occluded(room, ON_THE_WALL, WALL)).toBe(false);
  });
});

// ─── when a pass runs ────────────────────────────────────────────────────────

/** The camera the room has by default, which is what `readOcclusionInputs` is read from. */
function cameraAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('when a pass runs', () => {
  it('runs the first one whatever the clock says', () => {
    const inputs = readOcclusionInputs(cameraAt(8, 6, 8), 0, 0);
    expect(shouldRunOcclusionPass(null, inputs, 0)).toBe(true);
  });

  it('does not run again when nothing changed, at any interval', () => {
    const previous = readOcclusionInputs(cameraAt(8, 6, 8), 3, 1);
    const next = readOcclusionInputs(cameraAt(8, 6, 8), 3, 1);
    expect(sameOcclusionInputs(previous, next)).toBe(true);
    // The room nobody is touching. Under `frameloop="demand"` this is the difference between
    // a canvas that sleeps and one that does not, and it is the assertion that fails loudest
    // if a future field is added to the inputs and forgotten here.
    expect(shouldRunOcclusionPass(previous, next, 0)).toBe(false);
    expect(shouldRunOcclusionPass(previous, next, 10_000)).toBe(false);
  });

  it('runs when the camera moved, once the throttle has let go', () => {
    const previous = readOcclusionInputs(cameraAt(8, 6, 8), 0, 0);
    const moved = readOcclusionInputs(cameraAt(8.5, 6, 8), 0, 0);
    expect(sameOcclusionInputs(previous, moved)).toBe(false);
    expect(shouldRunOcclusionPass(previous, moved, OCCLUSION_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunOcclusionPass(previous, moved, OCCLUSION_MIN_INTERVAL_MS)).toBe(true);
  });

  it('runs when the camera turned rather than travelled', () => {
    const previous = readOcclusionInputs(cameraAt(8, 6, 8), 0, 0);
    const turned = cameraAt(8, 6, 8);
    turned.lookAt(0, 3, 0);
    turned.updateMatrixWorld(true);
    expect(sameOcclusionInputs(previous, readOcclusionInputs(turned, 0, 0))).toBe(false);
  });

  it('runs when the models changed and the camera did not', () => {
    const previous = readOcclusionInputs(cameraAt(8, 6, 8), 0, 0);
    const next = readOcclusionInputs(cameraAt(8, 6, 8), 1, 0);
    expect(sameOcclusionInputs(previous, next)).toBe(false);
    expect(shouldRunOcclusionPass(previous, next, OCCLUSION_MIN_INTERVAL_MS)).toBe(true);
  });

  it('runs when a marker arrived, so a new comment is checked without an orbit', () => {
    const previous = readOcclusionInputs(cameraAt(8, 6, 8), 0, 0);
    const next = readOcclusionInputs(cameraAt(8, 6, 8), 0, 1);
    expect(sameOcclusionInputs(previous, next)).toBe(false);
  });

  it('ignores a camera drifting by less than a pixel', () => {
    // OrbitControls damps, so a camera that has been let go keeps moving by amounts that
    // round to nothing on screen. Comparing those exactly would keep re-checking a picture
    // that has stopped changing — and keep a demand-mode canvas awake doing it.
    const previous = readOcclusionInputs(cameraAt(8, 6, 8), 0, 0);
    const drift = readOcclusionInputs(cameraAt(8 + 1e-6, 6, 8), 0, 0);
    expect(sameOcclusionInputs(previous, drift)).toBe(true);
    expect(shouldRunOcclusionPass(previous, drift, OCCLUSION_MIN_INTERVAL_MS)).toBe(false);
  });
});

// ─── the registry the driver reads ───────────────────────────────────────────

function marker(anchor: THREE.Vector3 | null, attachedTo: string | null = null): OccludedMarker {
  return { anchor, attachedTo, occluded: false, onOccluded: () => {} };
}

describe('the marker registry', () => {
  it('counts what it holds, and bumps its version on both ends', () => {
    expect(occludedMarkerCount()).toBe(0);
    const before = currentMarkerVersion();
    const unregister = registerOccludedMarker('a', marker(BEHIND));
    expect(occludedMarkerCount()).toBe(1);
    expect(currentMarkerVersion()).not.toBe(before);

    const afterRegister = currentMarkerVersion();
    unregister();
    expect(occludedMarkerCount()).toBe(0);
    expect(currentMarkerVersion()).not.toBe(afterRegister);
  });

  it('does not let a stale cleanup remove a marker that remounted under the same key', () => {
    // A comment list re-ordered, or a pin re-curated: the old entry's cleanup runs after the
    // new one registered, and a lookup by key alone would delete the live marker.
    const first = registerOccludedMarker('pin-1', marker(BEHIND));
    registerOccludedMarker('pin-1', marker(BEHIND));
    first();
    expect(occludedMarkerCount()).toBe(1);
  });
});
