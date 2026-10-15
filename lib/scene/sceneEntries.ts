// The parsed half of a scene model.
//
// The shared scene (lib/scene/roomScene.ts) is small enough to send down a
// socket and keep in room storage: a hash, a name, a line, a revision, a flag
// and a position. What a browser needs in order to actually RENDER one is the
// three.js group those bytes turned into, and that never travels — every client
// builds its own from the same hash, which is what makes the geometry
// byte-identical in every room without putting a 200 MB file on a websocket.
//
// This is the record of having done that, keyed in the store by SceneModel.id.

import type { Vector3, Group } from 'three';
import type { SceneNode } from '../../types';
import { parseModelFile, type ModelImportResult } from '../../utils/modelLoader';
import { MeshPartRegistry, type PartRegistry } from './partRegistry';
import { sceneModelPrefix, type SceneModel } from './roomScene';

export interface SceneModelEntry {
  id: string;
  /** The parsed group. An Object3D has one parent, so exactly one renderer may hold it. */
  group: Group;
  /** Its tree, with node ids prefixed so they cannot collide with another model's. */
  sceneTree: SceneNode;
  /**
   * Its parts, addressed by the same node ids the tree uses — the seam that lets the
   * renderer stop being one Object3D per part (lib/scene/partRegistry.ts).
   *
   * OPTIONAL, and only because the parse is not the only way to get an entry: tests
   * hand-build one around a bare Group to exercise a component that never looks at a
   * part, and making the field required would have nine of them fabricate a registry
   * for nothing. `sceneModelEntry` below always fills it, and a missing one is safe in
   * this stage rather than silently wrong — `hitParts` falls back to reading the ids
   * off the tagged objects, which is exactly what a MeshPartRegistry indexes. Stage 4
   * is where the fallback stops being able to answer for a batched model, and where
   * this becomes required.
   */
  partRegistry?: PartRegistry;
  fileName: string;
  line: string;
  revision: string;
  /** centerModel's normalisation: multiply the model's own units by this to get scene units. */
  baseScale: number;
  basePosition: Vector3;
  /** The user's scale slider. Local to this browser — it is not part of the shared scene. */
  scale: number;
  /** The unscaled bounding box, so placement can be computed without touching three. */
  size: { x: number; y: number; z: number };
}

/**
 * Parse a file into the entry for one scene model.
 *
 * The prefix comes from the model's HASH rather than from its id or from a
 * counter, so every participant — and the curator who opened the same file in
 * the review setup page, where there is no room server to hand out ids — gets
 * the same node ids for the same geometry. A pin names the mesh it was placed
 * on; if those ids differed between screens the pin would point at nothing.
 */
export async function parseSceneModelFile(model: SceneModel, file: File): Promise<SceneModelEntry> {
  const parsed = await parseModelFile(file, { treePrefix: sceneModelPrefix(model.hash) });
  return sceneModelEntry(model, parsed);
}

/** The entry for a model somebody has already parsed. */
export function sceneModelEntry(
  model: Pick<SceneModel, 'id' | 'fileName' | 'line' | 'revision'>,
  parsed: ModelImportResult,
): SceneModelEntry {
  return {
    id: model.id,
    group: parsed.root,
    sceneTree: parsed.sceneTree,
    // Built from the tree as well as the group so a handle's `name` is the name the
    // Model Tree's row shows rather than whatever the file left on the Object3D, which
    // is often nothing: collapseSingleChildGroups promotes a wrapped mesh and gives it
    // the wrapper's name in the tree only.
    partRegistry: new MeshPartRegistry(parsed.root, parsed.sceneTree),
    // The name the file was parsed under, which is the name the loader gave it
    // and the one utils/modelLoader.ts dispatched on — not whatever the scene
    // happens to call it.
    fileName: parsed.fileName || model.fileName,
    line: model.line,
    revision: model.revision,
    baseScale: parsed.baseScale,
    basePosition: parsed.basePosition,
    scale: 1,
    size: parsed.size,
  };
}
