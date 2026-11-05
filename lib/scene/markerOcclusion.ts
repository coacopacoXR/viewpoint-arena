// Whether the model is in front of a comment bubble or a review pin — task 09a.
//
// Until this file existed neither kind of marker knew the product was there. The pin
// meshes are drawn with `depthTest={false}`, which is what makes a pin readable when its
// own model's shell is a millimetre in front of it — and also what makes it readable when
// the whole model is. The bubbles are DOM, which is never depth-tested against anything.
// So a comment placed on the back face of a housing stayed on screen while you looked at
// the front of it, floating over the geometry that was hiding it, and the person reading
// the screen could not tell a comment on the near face from one on the far side.
//
// THE ANSWER IS A RAYCAST, and it is the same raycast every other pick path in this app
// makes, through the same two filters:
//
//   • `isPointableHit` and `hitParts` (lib/scene/partRegistry.ts), so that only PRODUCT
//     geometry can hide a marker. An avatar, a laser beam, the floor grid, the contact
//     shadows, the cut guide, another pin and the gizmo's own picker meshes are all in the
//     scene and none of them is the thing under discussion. `hitParts` also refuses an
//     invisible part, so a model hidden in the Model Tree stops hiding markers the moment
//     it stops being drawn — which three's `Raycaster` would not do on its own, because it
//     never reads `Object3D.visible`.
//   • `firstUncutHit` (lib/scene/cutPick.ts), so that geometry the room has CUT AWAY does
//     not hide anything. A marker behind the half a section removed is a marker standing in
//     open air, and hiding it would be the cut filter drifting out of a seventh pick path —
//     exactly what lib/scene/cutPick.ts's header exists to prevent.
//
// WHAT IT COSTS, because this scene can hold ten thousand batched parts and renders on
// demand (`frameloop="demand"`, components/Scene/ViewpointCanvas.tsx):
//
//   • ONE raycast per marker per pass, aimed at that marker's own anchor and at nothing
//     else. Not drei's `occlude`, which raycasts the whole scene per marker per FRAME.
//   • Against the models' group rather than `scene.children`, which is the same object
//     components/Scene/ViewToolsCut.tsx walks: the floor, the grid, the shadows and every
//     avatar are outside it, so they are not even traversed.
//   • With `raycaster.far` clamped to just short of the anchor. That is not a filter on
//     the answer, it is the cheap part: three's `Mesh.raycast` drops a mesh whose bounding
//     sphere is beyond `far` after ONE sphere test, so everything behind the marker costs
//     a comparison and no triangle work.
//   • At most ten times a second, and only when something moved — see
//     `shouldRunOcclusionPass`. A room nobody is orbiting runs no passes at all, because
//     under `frameloop="demand"` it draws no frames at all.
//
// There is no BVH here. Task 05 measured `three-mesh-bvh` and did not merge it, so
// `three-mesh-bvh` is in node_modules only as a dependency of drei and no pick path in
// this app uses it; 00-RULES.md rule 5 forbids adding one for this task. The four limits
// above are what stands in for it.
//
// THE ANSWER IS A FADE, not a removal: see `MARKER_OCCLUDED_OPACITY` in
// lib/scene/markerLayers.ts for why 0.15 and not 0.

import { useEffect, useRef, useState } from 'react';
import { Vector3, type Camera, type Object3D, type Raycaster } from 'three';
import { uncutHits } from './cutPick';
import { hitParts, isPointableHit, type PartRegistry } from './partRegistry';

/**
 * How often a pass may run, in milliseconds.
 *
 * Ten hertz. An orbit is smooth at sixty and a marker that faded in a tenth of a second
 * later is not a marker anybody notices lagging — the eye is following the model, not the
 * bubbles. Below this the raycasts start to compete with the frames they are deciding
 * about; above it nothing is gained, because the fade itself takes 200 ms
 * (`transition: all 0.2s` on the bubble's own style).
 */
export const OCCLUSION_MIN_INTERVAL_MS = 100;

/**
 * How far short of the anchor the ray stops, as a fraction of the distance to it.
 *
 * A marker is anchored ON a surface — components/Scene/SpatialComments.tsx drops it at the
 * raycast's own `hit.point` — so the surface it sits on is the one thing guaranteed to be
 * in the way, at exactly the anchor's distance. Without a margin that surface hides its
 * own marker, and every comment in the room fades the moment it is placed.
 *
 * Relative rather than absolute because the room has no unit: a model is normalised to
 * about two scene units whether it is a bracket in millimetres or a skid in metres, but
 * the camera can be a unit from it or ten, and a margin sized for one is wrong for the
 * other. Half a percent of the distance is about a pixel at either.
 */
export const OCCLUSION_EPSILON_RATIO = 0.005;

/**
 * The floor under that margin, in scene units.
 *
 * For a camera brought right up to a part the fraction alone shrinks below the precision
 * of the geometry's own vertex data, and the surface would start hiding its marker again
 * at exactly the distance somebody leans in to look at it.
 */
export const OCCLUSION_EPSILON_MIN = 0.002;

/** The margin, given the distance from the eye to the anchor. */
export function occlusionEpsilon(distance: number): number {
  return Math.max(OCCLUSION_EPSILON_MIN, distance * OCCLUSION_EPSILON_RATIO);
}

/** What one pass needs in order to raycast: the raycaster, what to aim at, and what to resolve a hit against. */
export interface OcclusionProbe {
  /** Reused across every marker of every pass. A raycaster allocates per call, not per frame. */
  raycaster: Raycaster;
  /**
   * The models, and nothing else — World's own group, the one
   * components/Scene/ViewToolsCut.tsx walks for the same reason. Empty means there is
   * nothing that could hide a marker, and the answer is "not occluded" without a raycast.
   */
  roots: readonly Object3D[];
  /** `partRegistries(store.sceneEntries)`, which is what turns a hit into a part. */
  registries: readonly PartRegistry[];
}

/** Scratch, so a pass over a hundred markers allocates one array (the raycaster's) and no vectors. */
const scratchDirection = new Vector3();

/**
 * Whether anything the room is drawing stands between the eye and this marker's anchor.
 *
 * `attachedTo` is the part the marker was placed on, and it is skipped by NAME as well as
 * by the distance margin above. The margin covers a marker sitting square on its own face;
 * the name covers one sitting on a face the ray reaches at a grazing angle, where the same
 * surface can be struck a long way in front of the anchor it belongs to. Together they are
 * what makes a marker on a surface never hide itself, from any angle.
 *
 * Only the NEAREST part is compared, not the whole chain: a comment attached to a
 * sub-assembly has to be hideable by that sub-assembly's own shell, and skipping every hit
 * whose chain merely CONTAINS the id would make a comment on a housing invisible-proof.
 *
 * The hits are WALKED rather than answered from the nearest, because the nearest is very
 * often not the product. Another pin's sphere, a laser beam, the gizmo's own picker meshes
 * and the cut's guide rectangle all sit between a camera and a marker in the ordinary case,
 * and every one of them is `skipRaycast` — so stopping at `firstUncutHit` would answer "not
 * occluded" for a marker behind a wall with a pin floating in front of it. `uncutHits`
 * returns the raycast's own array when the room is not cutting, which is the ordinary case,
 * so the walk costs nothing extra.
 */
export function isAnchorOccluded(
  anchor: Vector3,
  eye: Vector3,
  probe: OcclusionProbe,
  attachedTo: string | null,
): boolean {
  if (probe.roots.length === 0) return false;

  scratchDirection.subVectors(anchor, eye);
  const distance = scratchDirection.length();
  // An anchor AT the eye has no direction to aim in, and one behind it is drei's own
  // problem — `<Html>` hides an element whose object is behind the camera already.
  if (!(distance > 0)) return false;
  scratchDirection.divideScalar(distance);

  const { raycaster } = probe;
  raycaster.set(eye, scratchDirection);
  raycaster.near = 0;
  raycaster.far = distance - occlusionEpsilon(distance);
  // Nothing can be between the eye and the anchor if the ray is not allowed to reach it.
  if (raycaster.far <= raycaster.near) return false;

  for (const hit of uncutHits(raycaster.intersectObjects(probe.roots as Object3D[], true))) {
    // A pin, a beam, a helper: in the scene, not the product, and pointed through.
    if (!isPointableHit(hit)) continue;
    const parts = hitParts(hit, probe.registries);
    // Not the product either — a mesh no registry claims, or a part somebody hid in the
    // Model Tree, which `partChainForHit` refuses and three's Raycaster never would.
    if (parts.modelId === null) continue;
    // Its own surface.
    if (attachedTo !== null && parts.chain[0] === attachedTo) continue;
    return true;
  }
  return false;
}

// ─── when a pass runs ─────────────────────────────────────────────────────────
//
// A pass is N raycasts, so the question "has anything that could change the answer
// changed?" is asked every frame and answered every frame, and the answer has to be cheap
// and has to be a NUMBER rather than a traversal. Both halves are pure functions below so
// that lib/scene/__tests__/markerOcclusion.test.ts can assert the one behaviour that is
// invisible when it is wrong and expensive when it is: that a room nobody is touching runs
// no passes at all.

/**
 * How finely the camera is read.
 *
 * Quantised rather than compared exactly, because OrbitControls runs with damping and a
 * camera that has been let go keeps moving by a millionth of a unit for a second
 * afterwards. Exact comparison would keep re-checking a picture that has stopped
 * changing, which under `frameloop="demand"` means keeping the canvas awake — the one
 * thing task 06 exists to stop.
 *
 * A thousandth of a scene unit on position and a ten-thousandth on orientation are both
 * well under a pixel at the distances this room is looked at from.
 */
const EYE_STEP = 1e-3;
const LOOK_STEP = 1e-4;

function quantize(value: number, step: number): number {
  return Math.round(value / step);
}

/**
 * Everything a pass's answer depends on, as flat numbers.
 *
 * Flat and numeric rather than a nested object holding the camera itself, so that
 * comparing two of them is seven subtractions and no allocation — which matters because
 * the comparison runs on every frame a marker exists.
 */
export interface OcclusionInputs {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  lookW: number;
  /**
   * Bumped by the driver when the models, their visibility, the cut or the explode moved.
   *
   * A counter rather than the values themselves, because what has to be noticed is a
   * reference change in four store fields — and the parts' displayed positions, which an
   * explode writes straight into the registries, are not in the store at all. The
   * subscription that bumps it is in components/Scene/MarkerOcclusion.tsx.
   */
  sceneVersion: number;
  /** Bumped when a marker arrived or left, so a new comment is checked without waiting for the camera. */
  markerVersion: number;
}

/** Read the camera and the two counters into a fresh `OcclusionInputs`. */
export function readOcclusionInputs(
  camera: Camera,
  sceneVersion: number,
  markerVersion: number,
): OcclusionInputs {
  const { position, quaternion } = camera;
  return {
    eyeX: quantize(position.x, EYE_STEP),
    eyeY: quantize(position.y, EYE_STEP),
    eyeZ: quantize(position.z, EYE_STEP),
    lookX: quantize(quaternion.x, LOOK_STEP),
    lookY: quantize(quaternion.y, LOOK_STEP),
    lookZ: quantize(quaternion.z, LOOK_STEP),
    lookW: quantize(quaternion.w, LOOK_STEP),
    sceneVersion,
    markerVersion,
  };
}

/** Whether two reads say the same thing about the room. */
export function sameOcclusionInputs(a: OcclusionInputs | null, b: OcclusionInputs): boolean {
  if (a === null) return false;
  return (
    a.eyeX === b.eyeX &&
    a.eyeY === b.eyeY &&
    a.eyeZ === b.eyeZ &&
    a.lookX === b.lookX &&
    a.lookY === b.lookY &&
    a.lookZ === b.lookZ &&
    a.lookW === b.lookW &&
    a.sceneVersion === b.sceneVersion &&
    a.markerVersion === b.markerVersion
  );
}

/**
 * Whether a pass should run now.
 *
 * Two rules and not one. Nothing changed → never, at any interval: a room being looked at
 * rather than moved costs no raycasts at all. Something changed → at most once per
 * `OCCLUSION_MIN_INTERVAL_MS`: an orbit re-asks every frame, and the frames in between are
 * the ones the throttle exists to keep free.
 *
 * `previous === null` is the first pass of a canvas, which runs whatever the clock says —
 * a marker mounted into a room that is standing still has to be checked once, or it is
 * never checked at all.
 */
export function shouldRunOcclusionPass(
  previous: OcclusionInputs | null,
  next: OcclusionInputs,
  sinceLastPassMs: number,
): boolean {
  if (previous === null) return true;
  if (sameOcclusionInputs(previous, next)) return false;
  return sinceLastPassMs >= OCCLUSION_MIN_INTERVAL_MS;
}

// ─── the markers themselves ───────────────────────────────────────────────────

/** One marker the driver is watching. */
export interface OccludedMarker {
  /**
   * Where it is anchored, in world space, or null while it has no position.
   *
   * Read at check time rather than copied at registration, because a marker's anchor is a
   * THREE.Vector3 the component owns and re-uses, and a copy taken at mount would go stale
   * the first time the comment moved.
   */
  anchor: Vector3 | null;
  /** The part it was placed on, which may not hide it. Null when the marker does not know one. */
  attachedTo: string | null;
  /**
   * The answer it was last given.
   *
   * Kept here rather than in React so the driver can tell a flip from a repeat without
   * asking the component, and so that a marker which never flips never re-renders.
   */
  occluded: boolean;
  /** Hand it a new answer. Called only when the answer moved. */
  onOccluded: (occluded: boolean) => void;
}

/** One registration: the key it is filed under, and the marker behind it. */
export interface OccludedMarkerEntry {
  key: string;
  marker: OccludedMarker;
}

const entries = new Map<string, OccludedMarkerEntry>();
let markerVersion = 0;

/**
 * Put a marker under the driver's watch, and hand back the call that takes it off.
 *
 * A module-level registry rather than a React context because the markers and the driver
 * are in different subtrees with no prop path between them — the bubbles are in
 * components/Scene/SpatialComments.tsx, the pins in components/Scene/ReviewArtifacts.tsx,
 * and the driver has to be inside World, which is the only component holding the models'
 * group. It is also the reason ONE pass covers every marker of both kinds: two drivers
 * would be two raycasts per marker.
 */
export function registerOccludedMarker(key: string, marker: OccludedMarker): () => void {
  const entry: OccludedMarkerEntry = { key, marker };
  entries.set(key, entry);
  markerVersion += 1;
  return () => {
    // Compared by identity, not by key: a marker that unmounted and remounted under the
    // same key — a comment list re-ordered, a pin re-curated — must not have its NEW entry
    // deleted by the OLD one's cleanup, or the remounted marker is never checked again.
    if (entries.get(key) === entry) entries.delete(key);
    markerVersion += 1;
  };
}

/** Every marker under watch, in registration order. */
export function occludedMarkers(): IterableIterator<OccludedMarkerEntry> {
  return entries.values();
}

/** How many markers a pass would cost. */
export function occludedMarkerCount(): number {
  return entries.size;
}

/** The counter `readOcclusionInputs` puts in `markerVersion`. */
export function currentMarkerVersion(): number {
  return markerVersion;
}

/** Empty the registry. Tests, and only tests: a canvas unmounts its own markers. */
export function clearOccludedMarkers(): void {
  entries.clear();
  markerVersion += 1;
}

/**
 * Whether the marker this component draws is behind the model, from where the camera is.
 *
 * `key` is the marker's own id, and null while there is nothing to watch — a marker with
 * no anchor yet registers nothing, so an empty room costs the driver a map lookup and no
 * raycast. The answer starts false: a marker is drawn until a pass says otherwise, which
 * is the right way round because the first pass runs on the first frame and a bubble that
 * blinked out and back in on mount would look like a bug in the comment.
 */
export function useMarkerOccluded(
  key: string | null,
  anchor: Vector3 | null,
  attachedTo: string | null,
): boolean {
  const [occluded, setOccluded] = useState(false);
  const entryRef = useRef<OccludedMarker | null>(null);
  if (entryRef.current === null) {
    entryRef.current = {
      anchor: null,
      attachedTo: null,
      occluded: false,
      onOccluded: (next) => {
        const entry = entryRef.current;
        if (entry) entry.occluded = next;
        setOccluded(next);
      },
    };
  }

  // Registered once, on the key. The anchor and the part it belongs to are refreshed below
  // instead of being dependencies here, because re-registering on every render would bump
  // `markerVersion` every render and every pass would look like a change.
  useEffect(() => {
    if (key === null) return;
    const entry = entryRef.current;
    if (!entry) return;
    entry.anchor = anchor;
    entry.attachedTo = attachedTo;
    entry.occluded = false;
    return registerOccludedMarker(key, entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    entry.anchor = anchor;
    entry.attachedTo = attachedTo;
  });

  return occluded;
}
