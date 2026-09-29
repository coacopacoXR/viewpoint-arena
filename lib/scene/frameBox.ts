// How far back a camera has to sit for a box to fill its frame.
//
// docs/plan/15-sessions-and-variants.md batch BP. Two places compose a picture of one
// design review's models, and they have to compose the SAME picture: the lobby's live
// viewer (components/lobby/ReviewModelViewer.tsx) frames the models it has just parsed,
// and the room's thumbnail capture (lib/reviews/thumbnail.ts) frames the models already
// standing in the room. A card whose snapshot is a tight three-quarter shot of a bracket
// and whose "Turn in 3D" is that bracket from a different distance and a different
// angle reads as two different things — and the whole claim of the preview is that
// pressing the button shows you what the picture was of.
//
// So the arithmetic lives here once: a bounding box in, a camera pose out. Pure, and
// three-only — no React, no renderer, no canvas, no WebGL context — which is what lets
// it be tested with a Box3 and nothing else standing in for a browser.

import * as THREE from 'three';

/** The field of view framing falls back to, and the one both callers render with. */
export const FRAME_FOV = 45;

/**
 * How much further back than "exactly fills the frame" the camera sits.
 *
 * A model that touches all four edges reads as a thumbnail that was cropped, not as
 * something you are looking at, and it leaves nowhere for the eye to go when the first
 * thing somebody does is drag it.
 */
export const FRAME_PADDING = 1.4;

/**
 * The angle the camera arrives from, as a direction.
 *
 * The room's own default camera is at [8, 6, 8] (components/Scene/
 * ViewpointCanvas.tsx), so this is that same three-quarter view from slightly above,
 * scaled to whatever the model turns out to be — the lobby picture, the snapshot of the
 * room and the room itself all start from the same place.
 */
export const FRAME_DIRECTION = new THREE.Vector3(8, 6, 8).normalize();

/** Where a camera has to be, and how it has to be clipped, to frame one box. */
export interface FramedView {
  /** The point the camera looks at: the box's bounding sphere's centre. */
  target: THREE.Vector3;
  /** Where the camera sits: `target` pushed out along FRAME_DIRECTION. */
  position: THREE.Vector3;
  /** How far that is, in world units — the number near and far are derived from. */
  distance: number;
  near: number;
  far: number;
}

/**
 * The camera pose that fits `box` into a frame `fov` degrees tall, or null when there
 * is nothing to fit.
 *
 * The distance is the bounding sphere's radius over tan(fov/2), padded — good enough
 * for a 20 mm fastener and for a 6 m assembly alike, and it needs no knowledge of what
 * the model is. A sphere rather than the box's own three extents because the box is
 * axis-aligned and the camera is not: measuring along the view direction would need the
 * direction first, and the difference is a frame that is a little loose on a long
 * diagonal object, which is the padded-frame answer anyway.
 *
 * An empty box, a zero-radius one and a NaN one all answer null. They are what a scene
 * with nothing tagged in it measures as, and both callers read null as "there is no
 * picture here" rather than as "put the camera at the origin".
 *
 * near and far come from the distance rather than from a constant, because a 20 mm
 * fastener and a 6 m assembly cannot share a near plane and guessing wrong clips one
 * of them into nothing.
 */
export function frameBox(box: THREE.Box3, fov: number = FRAME_FOV): FramedView | null {
  if (!box || box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return null;

  const usableFov = Number.isFinite(fov) && fov > 0 && fov < 180 ? fov : FRAME_FOV;
  const distance = (sphere.radius / Math.tan((usableFov * Math.PI) / 360)) * FRAME_PADDING;
  if (!Number.isFinite(distance) || distance <= 0) return null;

  return {
    target: sphere.center.clone(),
    position: sphere.center.clone().addScaledVector(FRAME_DIRECTION, distance),
    distance,
    near: Math.max(distance / 1000, 0.001),
    far: distance * 100 + sphere.radius * 10,
  };
}

/**
 * Put a camera where `framed` says, looking at what it says.
 *
 * Everything the two callers do to a camera is in here and nothing else is, so the
 * viewer's live camera and the capture's temporary one are posed by the same three
 * assignments. Neither of them touches anything but the camera it was handed — in
 * particular neither reaches for the room's own, which belongs to whoever is standing
 * in it.
 */
export function applyFrame(camera: THREE.PerspectiveCamera, framed: FramedView): void {
  camera.position.copy(framed.position);
  camera.near = framed.near;
  camera.far = framed.far;
  camera.updateProjectionMatrix();
  camera.lookAt(framed.target);
}
