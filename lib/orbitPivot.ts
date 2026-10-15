// Where the orbit pivot belongs once a driven camera mode hands control back.
//
// Presence broadcasts `lookAt = position + forward`, i.e. a point one unit in
// front of the eye, and the follow/POV frame branches lerp `controls.target`
// onto it. Leaving that as the orbit pivot makes a free-view drag spin the
// user on the spot instead of around the model, and leaves zoom stuck at
// `minDistance`. The fix is to move the pivot out to the model's depth — but
// only *along the line of sight*, so nothing on screen moves.

import * as THREE from 'three';
import type { PartRegistry } from './scene/partRegistry';

/**
 * World-space centre of the models in the scene, or null when there are none.
 *
 * Asked of the part registries rather than found by walking the scene for objects tagged
 * `userData.modelId`, because a registry is the only thing that can answer for a model
 * that is not one Object3D per part: `Box3.expandByObject` walks a geometry, and a
 * BatchedMesh's geometry is the concatenated buffer in the batch's own space, so the
 * walk would pivot the camera on a box nobody is drawing (the render audit's R1).
 *
 * The bundled twelve-part synth is not in the answer, and never was: components/Scene/
 * Product.tsx tags its part GROUPS and leaves their meshes untagged, and this has always
 * asked for `isMesh` as well as the tag. A room showing only the synth still gets null
 * here, and both callers still fall back to where they already were.
 */
export function getModelCenter(registries: Iterable<PartRegistry>): THREE.Vector3 | null {
  const box = new THREE.Box3();
  const one = new THREE.Box3();
  let found = false;
  for (const registry of registries) {
    if (registry.parts().length > 0) found = true;
    if (registry.bounds(one).isEmpty()) continue;
    box.union(one);
  }
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
