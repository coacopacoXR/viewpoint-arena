// Per-frame glow for the built-in GLB models (headphones, bicycle).
//
// Two things light a mesh up: someone's pointer (in that pointer's colour) and
// a selection in the model tree (blue). They have to be decided in ONE pass:
// the pointer code eases every un-pointed mesh back to no glow each frame, so a
// selection glow applied anywhere else is faded out within a few frames.
//
// Visibility is handled separately (object.visible, from the tree's eye
// toggles) — three.js already hides a hidden group's children.

import * as THREE from 'three';
import type { ObjectState } from '../types';
import { originalEmissiveOf } from './scene/materialHighlight';
import {
  remoteLaserTargets,
  remoteLaserColors,
  remoteLaserMeshNames,
  isLaserEntryFresh,
} from './laserTargetRef';

export const SELECTION_GLOW = '#0044aa';
const POINTER_INTENSITY = 0.45;
const SELECTION_INTENSITY = 0.5;

/**
 * The glow each mesh should have this frame: the pointer colour when someone
 * points at it (or at the whole model, in 'model' granularity), else the
 * selection colour when it or any ancestor is selected in the tree, else none.
 * Pure — takes the pointer map rather than reading globals — so it is testable.
 */
export function targetGlow(
  mesh: THREE.Object3D,
  opts: {
    granularity: 'model' | 'part';
    modelPointerColor: string | null;
    meshPointerColors: Map<string, string>;
    objectStates: Record<string, ObjectState>;
  },
): { color: string; intensity: number } | null {
  const pointer =
    opts.granularity === 'model'
      ? opts.modelPointerColor
      : opts.meshPointerColors.get(String(mesh.userData.meshIndex)) ?? null;
  if (pointer) return { color: pointer, intensity: POINTER_INTENSITY };

  let curr: THREE.Object3D | null = mesh;
  while (curr) {
    const id = curr.userData?.nodeId as string | undefined;
    if (id && opts.objectStates[id]?.selected) {
      return { color: SELECTION_GLOW, intensity: SELECTION_INTENSITY };
    }
    curr = curr.parent;
  }
  return null;
}

/** Collect who points at this model this frame, from the shared laser maps. */
function pointersOnModel(rootId: string): {
  modelPointerColor: string | null;
  meshPointerColors: Map<string, string>;
} {
  let modelPointerColor: string | null = null;
  const meshPointerColors = new Map<string, string>();
  remoteLaserTargets.forEach((targetId, userId) => {
    if (!isLaserEntryFresh(userId) || targetId !== rootId) return;
    const color = remoteLaserColors.get(userId) ?? '#ffffff';
    if (!modelPointerColor) modelPointerColor = color;
    const meshIdx = remoteLaserMeshNames.get(userId);
    if (meshIdx != null && !meshPointerColors.has(meshIdx)) meshPointerColors.set(meshIdx, color);
  });
  return { modelPointerColor, meshPointerColors };
}

/** Ease every mesh of a built-in model toward its target glow. Call from useFrame. */
export function applyBuiltInGlow(
  scene: THREE.Object3D,
  rootId: string,
  granularity: 'model' | 'part',
  objectStates: Record<string, ObjectState>,
  scratch: THREE.Color,
): void {
  const pointers = pointersOnModel(rootId);
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    if (!mat || !('emissive' in mat)) return;
    // Remembered the first time this mesh is passed over, before anything has eased
    // it anywhere. The GLBs this runs on carry their own emissive — a lens, a reflector,
    // a light pipe — and this pass used to ease every un-pointed mesh towards ZERO, so
    // one selection or one laser sweep took the file's own glow off it for good.
    const original = originalEmissiveOf(mat);
    if (!original) return;
    const glow = targetGlow(obj, { granularity, objectStates, ...pointers });
    if (glow) {
      scratch.set(glow.color);
      mat.emissive.lerp(scratch, 0.15);
      mat.emissiveIntensity = THREE.MathUtils.lerp(mat.emissiveIntensity, glow.intensity, 0.15);
    } else {
      mat.emissive.lerp(original.color, 0.1);
      mat.emissiveIntensity = THREE.MathUtils.lerp(mat.emissiveIntensity, original.intensity, 0.1);
    }
  });
}
