// Where a model goes when it joins a scene that already has something in it.
//
// The plan asks for two arrangements, and both are the same idea: put the new
// thing BESIDE what is there, far enough away that neither overlaps the other,
// and leave everything else where it was.
//
//   * importing a different model adds it "next to" the current one;
//   * comparing two revisions puts the older at its own offset and shifts the
//     newer out by the older's width plus the same gap.
//
// The gap is a fraction of the width rather than a fixed distance because an
// imported model is normalised to about two scene units across (centerModel in
// utils/modelLoader.ts scales the longest dimension to 2) but the user's scale
// slider can make it ten times that, and a fixed gap that looked right for a
// bracket would have put a scaled-up assembly on top of its neighbour.
//
// Pure and three-free on purpose: the caller measures the geometry and passes
// widths in, which is what makes these testable without a WebGL context.

import {
  IDENTITY_SCENE_TRANSFORM,
  hasPartTransforms,
  samePartTransforms,
  sceneModelTransform,
  type PartTransforms,
  type RoomScene,
  type SceneModel,
  type SceneModelTransform,
} from './roomScene';

/** How much of the existing models' combined width to leave as a gap. */
export const PLACEMENT_GAP_FRACTION = 0.2;

/**
 * A model's footprint along X: where it sits, and how wide it is.
 *
 * `offset` is the SceneModel's, and `width` is the model's extent in scene
 * units AFTER the base normalisation and the user's scale slider. An imported
 * model is centred on its own origin in X and Z by centerModel, so its extent
 * is symmetric about offset[0] — which is the only assumption the arithmetic
 * below makes.
 */
export interface SceneExtent {
  offset: [number, number, number];
  width: number;
}

/** A scene model's width in scene units, from the geometry the caller measured. */
export function sceneWidth(localWidth: number, baseScale: number, scale: number): number {
  return localWidth * baseScale * scale;
}

/** The left and right edge of everything in `extents`, or null when there is nothing. */
export function combinedXExtent(extents: SceneExtent[]): { min: number; max: number } | null {
  if (extents.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const extent of extents) {
    const half = extent.width / 2;
    min = Math.min(min, extent.offset[0] - half);
    max = Math.max(max, extent.offset[0] + half);
  }
  return { min, max };
}

/**
 * Where a model of `width` goes so it sits beside everything already there.
 *
 * Its left edge lands one gap beyond the right edge of the combined bounding
 * box, and the gap is PLACEMENT_GAP_FRACTION of that box's width — so a scene
 * holding one two-unit model puts the next one's centre at 2.4, and a scene
 * holding a wide assembly leaves proportionally more air. Nothing else moves,
 * which is what makes "add next to it" different from "replace everything": the
 * models already under discussion stay exactly where the room put them.
 *
 * An empty scene gets the origin, because there is nothing to be beside.
 */
export function nextToOffset(
  existing: SceneExtent[],
  width: number,
  gapFraction: number = PLACEMENT_GAP_FRACTION,
): [number, number, number] {
  const extent = combinedXExtent(existing);
  if (!extent) return [0, 0, 0];
  const gap = (extent.max - extent.min) * gapFraction;
  return [extent.max + gap + width / 2, 0, 0];
}

/**
 * Side-by-side placement for Compare: the older revision stays where the room
 * had it, the newer one moves out beside it.
 *
 * Moving the NEWER one and not the older is deliberate. The older revision is
 * the one the room has been discussing — the viewpoints, pins and comments all
 * point at where it is — so a comparison that slid it sideways would have left
 * every pin floating in empty space next to the model it was placed on.
 *
 * Both models keep their Y and Z: revisions of one product differ in detail,
 * not in size, and lifting one off the floor to make room would have read as a
 * mistake rather than a comparison.
 */
export function compareOffsets(
  older: SceneExtent,
  newer: SceneExtent,
  gapFraction: number = PLACEMENT_GAP_FRACTION,
): { older: [number, number, number]; newer: [number, number, number] } {
  const gap = older.width * gapFraction;
  const newerX = older.offset[0] + older.width / 2 + gap + newer.width / 2;
  return {
    older: [older.offset[0], older.offset[1], older.offset[2]],
    newer: [newerX, newer.offset[1], newer.offset[2]],
  };
}

/** The footprints of every model in a scene, measured by the caller. */
export function sceneExtents(
  models: SceneModel[],
  widthOf: (model: SceneModel) => number,
): SceneExtent[] {
  return models.map((model) => ({ offset: model.offset, width: widthOf(model) }));
}

// ─── Placement the review keeps ───────────────────────────────────────────────
//
// Batch BI. Move / Rotate / Scale in the room's Edit mode write a SceneModel's
// offset, rotation and scale, and the room server persists that with its scene —
// but room storage is the ROOM's, and a review outlives its room: it is opened
// again next month, from the lobby, on an install whose room server hibernated and
// lost it, or by somebody who was not in the meeting where the model was turned
// round to face the camera. So the placement travels with the review as well.
//
// WHERE it travels is the question the batch asked, and the answer is the review's
// own `asset` jsonb (ReviewAsset.placements) rather than a column on
// model_revisions. Three reasons, in order of weight:
//
//   1. It is per REVISION either way, which is the requirement — a placement is
//      keyed by (line, revision) below, exactly the pair model_revisions is unique
//      on, so a Rev B moved to the left does not move Rev A with it.
//   2. It rides the REVIEW_CONFIG the room already broadcasts. A placement stored
//      only in the database reaches the person who opened the review; one inside
//      the review reaches everybody in the room the moment it is written, and
//      works on an install with no database at all, where the draft in
//      localStorage is the only copy of the review there is.
//   3. It is written by the save the review already makes. `draftToRow` stores the
//      whole asset, so there is no second writer, no second failure mode and no
//      migration — a column would have needed one, in a schema this batch was not
//      allowed to touch.
//
// `asset.transform` — the single ModelTransform a curator used to fix one model's
// scale and orientation — is deliberately NOT reused for this. It is one transform
// for whatever model is loaded, and a scene holds up to MAX_SCENE_MODELS of them;
// it still does its own job, which is the preset-and-curation case World.tsx wraps
// the whole model group in.

/**
 * One model's placement, as the review row stores it.
 *
 * Keyed by the same (line, revision) pair the model_revisions table is unique on,
 * and matched the way revisionsOnScreen matches — case-insensitively on the letter,
 * because a hand-edited row and a scene built by two different clients have to
 * agree. The transform is the FILLED-IN one (see sceneModelTransform), so a reader
 * never has to re-derive "absent means identity" from a stored record.
 */
export interface StoredPlacement {
  line: string;
  revision: string;
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: number;
  /**
   * Parts somebody moved on their own, batch BR — carried here for exactly the
   * reason the three fields above are: room storage is the room's and a review
   * outlives it, so a bracket whose flange was pulled out to show the clearance has
   * to come back pulled out when the review is opened next month, and the lobby's
   * "Turn in 3D" has to be turning the same thing the room was looking at.
   *
   * Keyed by node id, which is derived from the file's hash, so it means the same
   * nodes here as it did in the room that wrote it — and it is per (line, revision)
   * like everything else in this record, which is what makes "a new revision starts
   * with no part overrides" fall out for free: Rev B is a different file with a
   * different hash, so none of Rev A's ids can match a node of it.
   *
   * Absent, not `{}`, when nothing was moved — see withParts in roomScene.ts.
   */
  parts?: PartTransforms;
}

/** Whether a transform is the one a model nobody touched has. */
function isIdentity(transform: SceneModelTransform): boolean {
  const identity = IDENTITY_SCENE_TRANSFORM;
  return (
    transform.offset[0] === identity.offset[0] &&
    transform.offset[1] === identity.offset[1] &&
    transform.offset[2] === identity.offset[2] &&
    transform.rotation[0] === identity.rotation[0] &&
    transform.rotation[1] === identity.rotation[1] &&
    transform.rotation[2] === identity.rotation[2] &&
    transform.scale === identity.scale
  );
}

/**
 * Every placement in a scene worth remembering.
 *
 * Models nobody has moved are left out, so a review that has only ever imported
 * files stores nothing at all and a scene of twenty untouched models stores an
 * empty list rather than twenty identities. "Absent means where the room put it"
 * is the same rule SceneModel's optional rotation and scale already follow.
 */
export function placementsFromScene(models: readonly SceneModel[]): StoredPlacement[] {
  const stored: StoredPlacement[] = [];
  for (const model of models) {
    const transform = sceneModelTransform(model);
    // A model whose parts were moved is worth remembering even standing at the
    // origin: the identity check is about the model's OWN transform, and without
    // this second condition a pulled-apart assembly that nobody had dragged would
    // have been thrown away on the way to the review.
    const movedParts = hasPartTransforms(model);
    if (isIdentity(transform) && !movedParts) continue;
    stored.push({
      line: model.line,
      revision: model.revision,
      ...transform,
      ...(movedParts ? { parts: model.parts } : {}),
    });
  }
  return stored;
}

/**
 * The two slots of a review's asset that hold positions.
 *
 * Structural, and deliberately not `ReviewAsset`: the readers are lib/scene/
 * showCurationModel (which is handed a curation's asset as it arrived off the wire)
 * and components/lobby/ReviewModelViewer, and neither should have to import the whole
 * draft type to ask where a line's models stand.
 */
export interface PlacementSlots {
  /** The MAIN line's positions, and every review's positions before batch BV. */
  placements?: readonly StoredPlacement[] | null;
  /** A variant's own, keyed by its review_lines id. Absent until somebody moves one. */
  linePlacements?: Record<string, readonly StoredPlacement[]> | null;
}

/**
 * The positions ONE LINE opens on.
 *
 * Batch BV, and the reason it is a function rather than a field read: `placements`
 * used to be the review's one slot, shared by every line, so a variant that moved a
 * model overwrote where the main line had left it — and a room that re-seeded from the
 * database (BQ2: a room whose server has never held a scene) got whichever line wrote
 * last. Two slots and one rule for which to read.
 *
 * `lineId` null means the main line, and means it for the three cases that all answer
 * the same way: a room on the main line, a review on an install with no lines at all,
 * and the curator's own setup page, which has no room and no line.
 *
 * A variant with no slot of its own gets the MAIN line's positions, not nothing. That
 * is what "a variant starts where the main line is" means: it is handed the scene as
 * the main line has it, and from the first drag it writes to its own slot and diverges.
 * An empty slot of its own — a variant whose models were all moved back to where they
 * arrived — is NOT the same as no slot, and is honoured as the empty list it is.
 *
 * BATCH BX made "no slot of its own" a WALK rather than a jump to the main line, and
 * `slotOrder` is the walk: lib/reviews/lines.placementSlotOrder answers the line's own
 * id followed by its ancestors', so a variant of a variant nobody has moved shows what
 * its parent shows — which is the whole of "a variant starts from its parent line's
 * current state", and which a jump straight to `placements` would have answered with
 * the main line's positions instead. Omitted, and the order is the one id the caller
 * named, which is exactly what this did before and what a caller with no lines in hand
 * (the lobby's viewer, a test's fixtures) still wants.
 */
export function placementsForLine(
  asset: PlacementSlots | null | undefined,
  lineId: string | null | undefined,
  slotOrder?: readonly string[],
): readonly StoredPlacement[] | null | undefined {
  if (!asset) return undefined;
  const named = typeof lineId === 'string' ? lineId.trim() : '';
  const order =
    slotOrder && slotOrder.length > 0
      ? slotOrder
      : named === ''
        ? []
        : [named];
  const slots = asset.linePlacements;
  for (const id of order) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (key === '') continue;
    const slot = slots?.[key];
    if (slot !== undefined && slot !== null) return slot;
  }
  return asset.placements;
}

/**
 * Put the placements a review stored back onto the scene it means.
 *
 * Returns the SAME scene object when nothing in it changes, which is the contract
 * applySceneUpdate has and the one the room server and the store both rely on to
 * decide whether there is anything to adopt, relay or persist.
 *
 * A placement with no model to match is dropped rather than added: it describes a
 * revision this scene does not hold — one that fell off MAX_SCENE_MODELS, or a
 * review whose history and whose room have diverged — and inventing a model for it
 * would put a file on screen nobody asked to fetch.
 */
export function applyStoredPlacements(
  scene: RoomScene,
  placements: readonly StoredPlacement[] | undefined | null,
): RoomScene {
  if (!placements || placements.length === 0 || scene.models.length === 0) return scene;

  let changed = false;
  const models = scene.models.map((model) => {
    const wanted = model.revision.trim().toUpperCase();
    const stored = placements.find((placement) =>
      placement.line === model.line && placement.revision.trim().toUpperCase() === wanted,
    );
    if (!stored) return model;
    const next: SceneModelTransform = {
      offset: stored.offset,
      rotation: stored.rotation,
      scale: stored.scale,
    };
    // Compared against the FILLED-IN current value, not the stored optionals, for
    // the reason applySceneUpdate's setTransform gives: a model that has never
    // been turned has no rotation field at all, and restoring [0,0,0] onto it is
    // not a change worth a new scene object.
    const current = sceneModelTransform(model);
    const sameTransform =
      current.offset[0] === next.offset[0] &&
      current.offset[1] === next.offset[1] &&
      current.offset[2] === next.offset[2] &&
      current.rotation[0] === next.rotation[0] &&
      current.rotation[1] === next.rotation[1] &&
      current.rotation[2] === next.rotation[2] &&
      current.scale === next.scale;
    // Parts are compared too, and a placement with none does NOT clear the ones the
    // scene already has: this is called on a scene built from the review's history
    // or restored from room storage, and either could legitimately have arrived with
    // its own overrides. Only what was stored is written.
    const sameParts = samePartTransforms(model.parts, stored.parts);
    if (sameTransform && sameParts) return model;
    changed = true;
    return {
      ...model,
      offset: next.offset,
      rotation: next.rotation,
      scale: next.scale,
      ...(stored.parts ? { parts: stored.parts } : {}),
    };
  });

  return changed ? { ...scene, models } : scene;
}

/**
 * Whether two placement lists say the same thing.
 *
 * Order-insensitive and key-based, because the list is rebuilt from a scene every
 * time and a scene's model order is the order additions arrived in — which a
 * Compare, a removal and a re-import can all change without anybody moving
 * anything. Without this, writing the placements back after a drag would mark the
 * review edited, broadcast it and save it for a change that was not one.
 */
export function samePlacements(
  a: readonly StoredPlacement[] | undefined | null,
  b: readonly StoredPlacement[] | undefined | null,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((placement) => {
    const match = right.find((other) =>
      other.line === placement.line &&
      other.revision.trim().toUpperCase() === placement.revision.trim().toUpperCase(),
    );
    if (!match) return false;
    return (
      match.offset[0] === placement.offset[0] &&
      match.offset[1] === placement.offset[1] &&
      match.offset[2] === placement.offset[2] &&
      match.rotation[0] === placement.rotation[0] &&
      match.rotation[1] === placement.rotation[1] &&
      match.rotation[2] === placement.rotation[2] &&
      match.scale === placement.scale &&
      // Moved parts are part of the placement, so a drag that only moved a part
      // still counts as a change — which is what marks the review edited and gets
      // it saved. Without this, "Reset part" after a reload would have been the
      // only thing that ever wrote.
      samePartTransforms(match.parts, placement.parts)
    );
  });
}
