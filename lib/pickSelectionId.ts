import type * as THREE from 'three';

/**
 * Given a hit object and the laser highlight granularity, return the node id
 * to select in the scene tree.
 *
 * - 'part' granularity: select the nearest ancestor with a nodeId (the mesh
 *   itself, or the first group above it that has one).
 * - 'model' granularity: select the root modelId (the whole model highlights).
 * - If the hit object or any ancestor has skipRaycast, return null.
 */
export function pickSelectionId(
  hitObject: THREE.Object3D | null,
  granularity: 'model' | 'part'
): string | null {
  if (!hitObject) return null;

  let curr: THREE.Object3D | null = hitObject;
  let nearestNodeId: string | null = null;
  let rootModelId: string | null = null;

  while (curr) {
    if (curr.userData?.skipRaycast) return null;
    if (curr.name?.startsWith?.('Agent') || curr.type === 'Line' || curr.type === 'Points') {
      curr = curr.parent ?? null;
      continue;
    }

    // Remember the nearest nodeId (closest to the hit mesh)
    if (!nearestNodeId && curr.userData?.nodeId) {
      nearestNodeId = curr.userData.nodeId;
    }

    // Remember the root modelId (first ancestor with modelId)
    if (!rootModelId && curr.userData?.modelId) {
      rootModelId = curr.userData.modelId;
    }

    // Stop walking up once we have the modelId (the root)
    if (rootModelId) break;

    curr = curr.parent ?? null;
  }

  if (!rootModelId) return null;

  if (granularity === 'model') {
    return rootModelId;
  }

  // 'part' granularity: prefer the nearest nodeId, fall back to root modelId
  return nearestNodeId ?? rootModelId;
}
