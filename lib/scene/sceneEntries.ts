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
import { partRegistryFor } from './batchedParts';
import type { PartRegistry } from './partRegistry';
import { sceneModelPrefix, type SceneModel } from './roomScene';

export interface SceneModelEntry {
  id: string;
  /** The parsed group. An Object3D has one parent, so exactly one renderer may hold it. */
  group: Group;
  /** Its tree, with node ids prefixed so they cannot collide with another model's. */
  sceneTree: SceneNode;
  /**
   * Its parts, addressed by the same node ids the tree uses — the seam that lets the renderer
   * stop being one Object3D per part (lib/scene/partRegistry.ts).
   *
   * REQUIRED as of task 04b stage 4, which is the stage the fallbacks stopped being able to
   * answer: `hitParts` reading ids off tagged objects and `modelBox` measuring the group are
   * both exactly right for a model drawn the way it was parsed and both exactly wrong for one
   * drawn as batches, where the tags have been pruned out of the graph and the group's
   * geometry is a merged buffer in the batch's own space. Every construction path builds one
   * — `sceneModelEntry` below is the only producer in the app — so a missing registry is now
   * a compile error rather than a silently unaddressable model.
   *
   * It OWNS GPU buffers once the model is big enough to be batched, so it has to be disposed
   * with the entry: see store.ts's `pruneEntriesToScene` and `upsertSceneModel`, and
   * components/lobby/ReviewModelViewer's teardown.
   */
  partRegistry: PartRegistry;
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
    //
    // Which of the two implementations it is comes from the part count, not from here:
    // a model big enough to be worth merging is drawn as batches and everything else is
    // drawn the way it was parsed. See lib/scene/batchedParts.ts's BATCH_MIN_PARTS.
    partRegistry: partRegistryFor(parsed.root, parsed.sceneTree),
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
