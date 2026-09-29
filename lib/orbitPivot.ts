// Where the orbit pivot belongs once a driven camera mode hands control back.
//
// Presence broadcasts `lookAt = position + forward`, i.e. a point one unit in
// front of the eye, and the follow/POV frame branches lerp `controls.target`
// onto it. Leaving that as the orbit pivot makes a free-view drag spin the
// user on the spot instead of around the model, and leaves zoom stuck at
// `minDistance`. The fix is to move the pivot out to the model's depth — but
// only *along the line of sight*, so nothing on screen moves.

import * as THREE from 'three';

/**
 * World-space centre of the model loaded into the scene — the objects tagged
 * with `userData.modelId` — or null when there is no model.
 */
export function getModelCenter(scene: THREE.Scene): THREE.Vector3 | null {
  const box = new THREE.Box3();
  let found = false;
  scene.traverse((obj) => {
    if ((obj as { isMesh?: boolean }).isMesh === true && obj.userData?.modelId) {
      box.expandByObject(obj);
      found = true;
    }
  });
  if (!found) return null;
  return box.getCenter(new THREE.Vector3());
}

/**
 * The point on the camera's line of sight that sits at `modelCenter`'s depth.
 *
 * Because the result is on the line of sight, setting `controls.target` to it
 * changes nothing about what the user sees — there is no visible jump — while
 * rotation now pivots around the model rather than around the eye. Depth is
 * clamped so a model behind the camera (or at it) still leaves enough room to
 * orbit and zoom.
 */
export function computeOrbitPivot(
  camPos: THREE.Vector3,
  forward: THREE.Vector3,
  modelCenter: THREE.Vector3 | null,
  minDist = 1.5,
  maxDist = 15,
): THREE.Vector3 {
  const dir = forward.clone();
  if (dir.lengthSq() < 1e-9) dir.set(0, 0, -1);
  dir.normalize();

  const centre = modelCenter ?? new THREE.Vector3(0, 0, 0);
  const depth = THREE.MathUtils.clamp(centre.clone().sub(camPos).dot(dir), minDist, maxDist);

  return camPos.clone().add(dir.multiplyScalar(depth));
}
