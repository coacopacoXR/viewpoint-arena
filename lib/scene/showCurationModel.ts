// Putting a curated review's model on screen.
//
// Two places have to do it and they must do it the SAME way: lib/activeReviewStore,
// which applies a review config the room server relayed, and pages/ReviewSetupPage,
// which applies the draft the curator is editing with no room involved at all. A
// pin names the mesh it was placed on, so if one path built the scene differently
// from the other, pins made while curating would resolve to nothing once the
// review was open. Hence one function, and both call it.

import { useStore } from '../../store';
import { parseModelFile } from '../../utils/modelLoader';
import { modelFileMime } from '../../utils/modelFormats';
import { curationScene, curationSceneModel, legacyCurationModel } from './curationScene';
import { sceneModelPrefix } from './roomScene';
import { sceneModelEntry } from './sceneEntries';
import { applyStoredPlacements, placementsForLine, type PlacementSlots } from './placement';
import { listModelRevisions, revisionsForSession, sceneFromRevisions } from '../reviews/revisionsRepo';
import { originRevisionIds, placementSlotsFor } from '../reviews/linesRepo';

/**
 * The part of a curation's asset that decides what to show.
 *
 * It carries the review's stored positions as well, through `PlacementSlots`:
 * `placements` is the MAIN line's and `linePlacements` one slot per variant, keyed by
 * its review_lines id. Batch BV split what batch BI had made a single field, because a
 * single field was shared by every line — a variant that moved a model overwrote where
 * the main line had left it, and whichever room re-seeded from the database last won.
 * Nothing below reads either field directly; which slot a line opens on is
 * lib/scene/placement.placementsForLine, so the reading half and the writing half
 * (lib/scene/keepPlacements) cannot drift apart.
 */
export interface CurationAssetModel extends PlacementSlots {
  modelType?: string;
  modelHash?: string;
  importedFileName?: string;
  importedFileBase64?: string;
}

/**
 * The slot of the review's positions this browser should open on, and the order of
 * slots to look in.
 *
 * `slot` is null for the main line, and null for the four cases that mean the same
 * thing: a room on the main line, an ad-hoc room with no review, an install with no
 * lines, and the curator's setup page, which has no room at all. `activeLine` is
 * resolved by pages/RoomPage BEFORE the socket opens, so by the time a seed runs it is
 * already the line this room is on.
 *
 * `order` is batch BX's addition and it is the one `placementsForLine` reads first:
 * the line's own slot, then its parents', because a variant started from another
 * variant shows what THAT variant left its models at until somebody moves one here.
 * Read from lib/reviews/linesRepo.cachedLines rather than awaited — this is called
 * synchronously in the middle of putting a scene up — and the cache is warm for the
 * same reason `activeLine` is: the room resolved its line before it connected.
 */
function activePlacementSlot(): { slot: string | null; order: string[] } {
  const line = useStore.getState().activeLine;
  if (!line || line.kind !== 'variant') return { slot: null, order: [] };
  return { slot: line.id, order: placementSlotsFor(line.reviewId, line) };
}

/**
 * Show a curation's imported model, as the one-model scene it is.
 *
 * Answers false when the asset is not an imported model, which is the caller's
 * cue to fall back to a preset. `logAs` names the caller in the one warning this
 * can produce, so a log line says which of the two paths hit it.
 */
export function showCurationModel(asset: CurationAssetModel | undefined, logAs: string): boolean {
  if (!asset || asset.modelType !== 'imported') return false;
  const { setRoomScene, upsertSceneModel } = useStore.getState();
  // Which line's positions this scene opens on — the main line's for every caller
  // that is not standing in a variant's room. Read once, before the async branch
  // below, so the two halves of a legacy parse cannot disagree about it.
  const slots = activePlacementSlot();

  if (asset.modelHash && asset.importedFileName) {
    // Stored by hash: say what to show and let lib/scene/useSceneModelLoader
    // fetch it from /api/models and parse it. The response is content-addressed
    // and immutable, so a browser that has this revision already pays a cache
    // lookup rather than a download — and a late joiner in a room goes down
    // exactly the same path, which is the point of having one.
    setRoomScene(applyStoredPlacements(
      curationScene(asset.modelHash, asset.importedFileName),
      placementsForLine(asset, slots.slot, slots.order),
    ));
    return true;
  }

  if (asset.importedFileBase64 && asset.importedFileName) {
    // LEGACY: a draft that has not been migrated yet (lib/migrateCurationAsset
    // runs on the load path, and a failed upload leaves the bytes in place so the
    // review still opens with its model). There is no hash to fetch, so this
    // parses the bytes itself and hands the store both halves — the scene entry
    // and the geometry for it.
    const fileName = asset.importedFileName;
    const model = legacyCurationModel(fileName);
    const file = new File(
      [Uint8Array.from(atob(asset.importedFileBase64), (c) => c.charCodeAt(0))],
      fileName,
      { type: modelFileMime(fileName) },
    );
    parseModelFile(file, { treePrefix: sceneModelPrefix(model.hash) })
      .then((parsed) => {
        setRoomScene(applyStoredPlacements(
          { models: [model], builtIn: null },
          placementsForLine(asset, slots.slot, slots.order),
        ));
        upsertSceneModel(sceneModelEntry(model, parsed));
      })
      .catch((err) => console.error(`[${logAs}] failed to parse imported model:`, err));
    return true;
  }

  // Neither a hash nor bytes: a curation recorded as 'imported' whose file is not
  // in this payload. Leave whatever model was already there so the scene is not
  // empty, and warn so the issue is visible.
  console.warn(
    `[${logAs}] curation uses an imported model but this payload has neither its hash nor its file — keeping the current model`,
  );
  return true;
}

// ─── The whole review, not just the model its curation names ────────────────

/**
 * Which review AND which line of it this browser has already rebuilt a scene for.
 *
 * A guard on OPENING rather than on correctness. setConfig runs on every
 * realtime echo and every poll of the curation row, and rebuilding the scene
 * from history each time would pull the models somebody had just hidden or moved
 * back to how the database says they were. Once per open is what "opening a
 * design review" means; after that the scene belongs to the room server (in a
 * room) and to the person using it (everywhere).
 *
 * Per LINE, not per review: a page that walks from a review's main room into one of
 * its variants opens the SAME review on a different model, and a review-wide key had
 * the variant skip the build altogether and keep whatever the main line had left on
 * screen — which in a variant room whose server has never held a scene is nothing.
 *
 * Cleared by forgetReviewScene when the review is left, so opening it again in
 * the same page session opens it properly rather than showing the single model
 * its curation row names. One call clears every line of that review: leaving a
 * review leaves all of them.
 */
const rebuilt = new Map<string, Set<string>>();

/**
 * The line's own key inside a review's set. The main line — and an install with no
 * database, where there are no lines — has no id, and gets the empty one.
 */
function lineKeyOf(lineId: string | null | undefined): string {
  return lineId ?? '';
}

function alreadyRebuilt(reviewId: string, key: string): boolean {
  return rebuilt.get(reviewId)?.has(key) ?? false;
}

function rememberRebuilt(reviewId: string, key: string): void {
  const lines = rebuilt.get(reviewId);
  if (lines) lines.add(key);
  else rebuilt.set(reviewId, new Set([key]));
}

/**
 * Forget that a review's scene was rebuilt, because the review is being left.
 *
 * Called from lib/activeReviewStore when its config is cleared and from the review
 * setup page on unmount. Without it, a curator who walks out of a review and back
 * in without reloading would get the curation's single model the second time and
 * the whole history the first — two different answers to the same question, which
 * is exactly the kind of inconsistency this batch exists to remove.
 */
export function forgetReviewScene(reviewId: string | null | undefined): void {
  if (reviewId) rebuilt.delete(reviewId);
}

/**
 * Show a design review's models: its whole stored history if it has one, and its
 * curation's single model if it does not.
 *
 * The synchronous half is `showCurationModel`, unchanged, so the product is on
 * screen immediately and a review with no revisions behaves EXACTLY as it did
 * before model_revisions existed. The revision read happens after, and replaces
 * that scene only when there is a history to replace it with — and only while
 * nobody has touched the scene in the meantime, which is what stops a slow query
 * from undoing an import the curator made while it was running.
 *
 * In a room this is the opening move and not the final word: the room server owns
 * the scene and relays SCENE_STATE once this connection is admitted, which
 * replaces whatever is here. That is batch BB's rule and it does not change —
 * the room is the live space, and what is on screen in it is the server's. The one
 * exception is a server that says it has NEVER held a scene (`seeded: false`): there
 * is nothing of its own to defer to, so lib/usePartyPresence calls this with `force`
 * and offers the answer back as SCENE_SEED.
 *
 * @returns false when there is nothing to show — an asset that is not an imported
 *          model in a review that has no stored revisions either — which is the
 *          caller's cue to fall back to a preset, exactly as showCurationModel
 *          answers. A review WITH revisions builds its scene from them whatever its
 *          asset names, and answers true.
 */
export async function showReviewScene(
  reviewId: string | null | undefined,
  asset: CurationAssetModel | undefined,
  logAs: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const shown = showCurationModel(asset, logAs);
  if (!reviewId) return shown;

  const lineId = useStore.getState().activeLine?.id ?? null;
  const key = lineKeyOf(lineId);
  // NOT the same thing as `lineId` above, and the difference is the whole of batch BV:
  // the rebuilt-key and the origin read want the line's own id whatever it is, while
  // the positions want the SLOT they live in, and the main line's slot has no id in it
  // at all — it is `asset.placements`, the field every review written before variants
  // keeps its positions in. Batch BX added the order the slots are looked in: a variant
  // of a variant opens on its parent's positions until somebody moves one here.
  const slots = activePlacementSlot();
  // `force` is a room whose server has just said it has NEVER held a scene, so there
  // is nothing on screen for the guard to protect: the reason it exists — not putting
  // the database's copy back over a model somebody has since hidden or moved — cannot
  // apply to a scene the room itself says is empty and nobody owns yet.
  if (!options?.force && alreadyRebuilt(reviewId, key)) return shown;
  rememberRebuilt(reviewId, key);

  const before = useStore.getState().scene;
  // Two reads, together: the review's whole history, and the part of it the LINE
  // this room is on was last looking at. The second is what makes a session start
  // where its line left off (docs/plan/15 batch BK) instead of where the review's
  // newest upload happens to be — a variant still on Rev A opens on Rev A even
  // though the main line has been to Rev C since. Null for a line that has never
  // met, for a meeting recorded before revision_ids existed, and for an install
  // with no database, and every one of those opens on the whole history, which is
  // exactly what it did before this batch.
  const [revisions, origin] = await Promise.all([
    listModelRevisions(reviewId),
    originRevisionIds(reviewId, lineId),
  ]);
  // No history to build from, so the synchronous half is the whole answer — and for an
  // asset that is not an imported model that half showed nothing, which is what `false`
  // tells the caller: fall back to a preset. Batch BQ2 moved this from an unconditional
  // `true`, and with it the case that was broken: a review created empty and filled by
  // imports made inside the room has its models ONLY in model_revisions, so the early
  // return this function used to take on a non-imported asset meant its history was
  // never read at all.
  if (revisions.length === 0) return shown;

  const state = useStore.getState();
  // Somebody changed the scene while the read was in flight — an import, a
  // Compare, a room server relay. Their change is the newer fact.
  if (state.scene !== before) return true;

  // The curation's own model goes in even when history has never heard of it,
  // which is every review created before the table existed: it is the product the
  // viewpoints and pins were placed on, and dropping it would have left them
  // floating in empty space next to whatever was uploaded afterwards.
  const unrecorded =
    asset?.modelHash && asset.importedFileName
      ? curationSceneModel(asset.modelHash, asset.importedFileName)
      : null;
  // History decides WHICH models are in the scene and which of them is visible;
  // the positions THIS LINE left them at then decide where each one stands. The stored
  // placement wins over the beside-each-other default sceneFromRevisions computes,
  // because that default is a guess about a room nobody has been in since, and the
  // placement is where somebody actually left it (batch BI). A variant with no slot of
  // its own gets the main line's, which is what "starts where the main line is" means.
  //
  // Narrowed to the line's last meeting when it named revisions that still exist.
  // revisionsForSession falls back to the whole history when it named none — a
  // revision deleted since, a meeting recorded before the column — so a line whose
  // origin cannot be honoured opens on everything rather than on an empty room.
  state.setRoomScene(applyStoredPlacements(
    sceneFromRevisions(revisionsForSession(revisions, origin), unrecorded),
    placementsForLine(asset, slots.slot, slots.order),
  ));
  return true;
}
