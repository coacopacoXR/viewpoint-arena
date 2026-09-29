// The revisions a design review has stored, and the scene they mean.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. Batch BB made the room's scene
// a list of models with a line and a revision, and that list lives in the room
// server's memory and its own storage. This is the review's copy of the same
// history, in Postgres, and it is what makes the history outlive the room: a
// room server that hibernates, a meeting that ended last month, a tracker item
// that says "raised on Rev A" — all of them need to know which FILE was Rev A,
// and the room's storage is not where you would look for that.
//
// Two directions:
//
//   * `recordModelRevision` — a new model joined the scene, so the review now
//     has one more version of one more line. Written from the model tree at the
//     moment of import, next to the scene update that put it on screen.
//   * `sceneFromRevisions` — opening a review rebuilds its scene from what it has
//     shown, newest revision of each line visible. This is the path that makes a
//     review "always the same, but if there is some revision … it shouldn't be a
//     totally different room" (the user's note that started plan 14).
//
// Every read answers with an empty list rather than throwing. A review whose
// database predates the table, or whose write failed, still has to open — from
// `asset.modelHash`, which is what the caller falls back to and which is why
// `listModelRevisions` returning [] is not an error condition.

import { supabase } from '../supabase';
import { getStoredIdentity } from '../identity';
import {
  MAX_SCENE_MODELS,
  latestRevision,
  sceneModelId,
  sceneModelPrefix,
  type RoomScene,
  type SceneModel,
} from '../scene/roomScene';
import { nextToOffset, type SceneExtent } from '../scene/placement';

/** One row of model_revisions, in the app's own naming. */
export interface ModelRevision {
  id: string;
  reviewId: string;
  line: string;
  revision: string;
  /** The SHA-256 batch BA stored the file under. /api/models/<hash> serves it. */
  hash: string;
  fileName: string;
  size: number;
  notes: string;
  /** The account that uploaded it, or null on a deployment with no accounts. */
  uploadedBy: string | null;
  uploadedByName: string;
  createdAt: string;
}

/** What a caller has to know to record a revision. The letter is not here. */
export interface NewModelRevision {
  reviewId: string;
  line: string;
  revision: string;
  hash: string;
  fileName: string;
  size: number;
  notes?: string;
}

interface RevisionRow {
  id: string;
  review_id: string;
  line: string;
  revision: string;
  hash: string;
  file_name: string | null;
  size: number | string | null;
  notes: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

const REVISION_COLUMNS =
  'id,review_id,line,revision,hash,file_name,size,notes,uploaded_by,uploaded_by_name,created_at';

function rowToRevision(row: RevisionRow): ModelRevision {
  return {
    id: row.id,
    reviewId: row.review_id,
    line: row.line,
    revision: row.revision,
    hash: row.hash,
    fileName: row.file_name ?? '',
    // bigint arrives as a string from PostgREST, which is the point of bigint —
    // and a file size is only ever displayed or summed, so a number is fine here.
    size: typeof row.size === 'number' ? row.size : Number(row.size ?? 0),
    notes: row.notes ?? '',
    uploadedBy: row.uploaded_by ?? null,
    uploadedByName: row.uploaded_by_name ?? '',
    createdAt: row.created_at,
  };
}

/**
 * The account this browser is signed in with, or null — the same gate
 * lib/reviewParticipantsRepo uses, for the same reason: a guest has no account
 * to attribute an upload to, and a deployment on identity.mode 'none' never
 * writes one into vp_user.
 *
 * `uploadedByName` is filled in either way, because "who put this revision here"
 * is a question the review's history should answer even on an install with no
 * accounts — it is just a name that person typed, and the column says so.
 */
function attribution(): { uploadedBy: string | null; uploadedByName: string } {
  const stored = getStoredIdentity();
  const name = stored?.name?.trim() || '';
  if (stored?.guest === true) return { uploadedBy: null, uploadedByName: name };
  const accountId = stored?.accountId;
  return {
    uploadedBy: typeof accountId === 'string' && accountId !== '' ? accountId : null,
    uploadedByName: name,
  };
}

/**
 * Record that this review showed this file, as this revision of this line.
 *
 * @returns the stored row, or null when it was not stored — no review to store
 *          it against, or the database refused. A null is logged and the import
 *          is NOT undone: the model is on everybody's screen and works, and a
 *          review whose history is one row short is a smaller problem than a
 *          meeting that lost its model because a bookkeeping write failed.
 *
 * The one refusal worth knowing about is `unique (review_id, line, revision)`:
 * two people importing into the same line at the same moment both compute Rev B
 * from the scene they can see, and the second insert is the one that fails. That
 * is the constraint doing its job — the alternative is two different files both
 * claiming to be Rev B of the bracket, and no way to tell afterwards which one a
 * card was raised against.
 */
export async function recordModelRevision(input: NewModelRevision): Promise<ModelRevision | null> {
  if (!input.reviewId || !input.hash) return null;

  const who = attribution();
  try {
    const { data, error } = await supabase
      .from('model_revisions')
      .insert({
        review_id: input.reviewId,
        line: input.line,
        revision: input.revision,
        hash: input.hash,
        file_name: input.fileName,
        size: input.size,
        notes: input.notes ?? '',
        uploaded_by: who.uploadedBy,
        uploaded_by_name: who.uploadedByName,
      })
      .select(REVISION_COLUMNS)
      .single();
    if (error || !data) {
      // 23505 is the unique violation described above; anything else is a
      // database that does not have the table yet (42P01) or a network that did
      // not arrive. All of them are "this review's history is missing a row",
      // and the code distinguishes them only in the log.
      console.error('[revisionsRepo] could not record the revision:', error?.code ?? '', error?.message ?? '');
      return null;
    }
    return rowToRevision(data as RevisionRow);
  } catch (err) {
    console.error('[revisionsRepo] recordModelRevision threw:', err);
    return null;
  }
}

/**
 * Every revision this review has stored, oldest first.
 *
 * Oldest first because that is the order a history reads in and the order
 * `sceneFromRevisions` needs to place lines. Answers [] for a review that has
 * none, for a database that predates the table, and for any failure — the caller
 * falls back to `asset.modelHash`, which is the only model such a review has.
 */
export async function listModelRevisions(reviewId: string): Promise<ModelRevision[]> {
  if (!reviewId) return [];
  try {
    const { data, error } = await supabase
      .from('model_revisions')
      .select(REVISION_COLUMNS)
      .eq('review_id', reviewId)
      .order('created_at', { ascending: true });
    if (error || !data) {
      // Not logged as an error: an install whose database has not re-applied
      // docs/supabase-schema.sql gets here on every open, and it is not broken —
      // it has no stored revisions, which is exactly what [] says.
      return [];
    }
    return (data as RevisionRow[]).map(rowToRevision);
  } catch (err) {
    console.error('[revisionsRepo] listModelRevisions threw:', err);
    return [];
  }
}

/**
 * How wide a model is assumed to be when a scene is rebuilt from history.
 *
 * An imported model is normalised to about two scene units across (centerModel in
 * utils/modelLoader.ts scales its longest dimension to 2), so this is the honest
 * guess for a model whose geometry has not been parsed yet — and rebuilding a
 * scene must not wait on parsing a 200 MB file per line just to know where to put
 * it. The loader measures the real thing a moment later; the user's scale slider
 * moves it again after that. Placement here only has to be "beside, not inside".
 */
export const NOMINAL_MODEL_WIDTH = 2;

/** The four fields of a revision the scene needs, from either source. */
interface SceneRevision {
  line: string;
  revision: string;
  hash: string;
  fileName: string;
}

/**
 * The scene a review's stored history means.
 *
 * One model per revision. Per line, the NEWEST revision is the visible one and
 * every older one is present but hidden — which is exactly the state batch BB's
 * import flow leaves the scene in, and what makes Compare work on a review that
 * was closed and reopened rather than only on one where the meeting is still
 * running. Lines sit beside each other in the order they were first added.
 *
 * `unrecorded` is the review's own `asset.modelHash`, and it is here because a
 * review created before this table existed has a model nobody ever recorded. It
 * joins the scene only when history does not already hold that file, and it joins
 * as its line's Rev A — so the product a curator placed pins on is still in the
 * room, hidden behind the revision that superseded it rather than dropped, and
 * Compare can still put the two side by side.
 *
 * Bounded by MAX_SCENE_MODELS, newest revisions kept: the room server refuses an
 * `add` beyond that, and a review that has outlived 24 uploads would otherwise
 * hand every client a scene bigger than the one the server would ever have
 * relayed. What falls off is still in the database, and still what a tracker
 * item's `raised_on_revision` points at — the tracker reads history, not scenes.
 */
export function sceneFromRevisions(
  revisions: readonly ModelRevision[],
  unrecorded?: Pick<SceneModel, 'line' | 'revision' | 'hash' | 'fileName'> | null,
): RoomScene {
  const kept: SceneRevision[] = revisions
    .slice(-MAX_SCENE_MODELS)
    .map((revision) => ({
      line: revision.line,
      revision: revision.revision,
      hash: revision.hash,
      fileName: revision.fileName,
    }));
  if (unrecorded && unrecorded.hash && !kept.some((entry) => entry.hash === unrecorded.hash)) {
    kept.push({
      line: unrecorded.line,
      revision: unrecorded.revision,
      hash: unrecorded.hash,
      fileName: unrecorded.fileName,
    });
  }

  // Lines in the order they first appear, so a review reads left to right the
  // way it was built: the product under review, then the mating part somebody
  // added beside it.
  const lines: string[] = [];
  for (const entry of kept) {
    if (!lines.includes(entry.line)) lines.push(entry.line);
  }

  const models: SceneModel[] = [];
  const extents: SceneExtent[] = [];
  for (const line of lines) {
    const ofLine = kept.filter((entry) => entry.line === line);
    const newest = latestRevision(ofLine, line);
    const offset = nextToOffset(extents, NOMINAL_MODEL_WIDTH);
    extents.push({ offset, width: NOMINAL_MODEL_WIDTH });
    for (const entry of ofLine) {
      models.push({
        // The id comes from the hash, so a pin placed on this file while
        // curating still resolves to the same mesh now that the review has three
        // more revisions beside it. See sceneModelId.
        id: sceneModelId(entry.hash),
        hash: entry.hash,
        fileName: entry.fileName === '' ? line : entry.fileName,
        line,
        revision: entry.revision,
        visible: entry.revision.trim().toUpperCase() === newest,
        // Every revision of a line shares the line's place: the newer one is
        // where the older one was, which is where the viewpoints and pins are.
        offset,
      });
    }
  }

  return { models, builtIn: null };
}

/**
 * The revision rows for the models a scene is actually showing.
 *
 * Matched on (line, revision) rather than on hash: the unique key of the table
 * is exactly that pair, and a hash could legitimately be the same file added as
 * Rev A of two different lines. Models with no stored row — a scene built from
 * `asset.modelHash` before this table existed — are skipped, so the answer can be
 * shorter than the scene and the caller writes an empty `revision_ids` rather
 * than a null in it.
 */
export function revisionsOnScreen(
  revisions: readonly ModelRevision[],
  models: readonly Pick<SceneModel, 'line' | 'revision' | 'visible'>[],
): ModelRevision[] {
  const found: ModelRevision[] = [];
  for (const model of models) {
    if (!model.visible) continue;
    const wanted = model.revision.trim().toUpperCase();
    for (const revision of revisions) {
      if (revision.line !== model.line) continue;
      if (revision.revision.trim().toUpperCase() !== wanted) continue;
      if (!found.some((already) => already.id === revision.id)) found.push(revision);
      break;
    }
  }
  return found;
}

/**
 * The rows a meeting said were on screen, out of a review's whole history.
 *
 * This is how a session starts where its line left off (docs/plan/15 batch BK):
 * tracker_sessions.revision_ids is the set that was VISIBLE when a meeting ended,
 * and narrowing the history to it before handing it to `sceneFromRevisions` gives a
 * room the model that meeting was looking at rather than the newest revision of
 * every line the review has ever stored. The difference is a review whose main line
 * went to Rev C in the last meeting and whose variant is still on Rev A: opened on
 * the variant, the room shows Rev A.
 *
 * Ids that no longer have a row — a revision deleted from the review through the
 * admin console — are skipped rather than causing an empty answer, so a history
 * that has moved on still opens on the part of it the meeting named. An empty
 * `revisionIds` answers the whole history, because that is what a meeting recorded
 * before revision_ids existed means: nothing was stored, so there is nothing to
 * narrow to.
 */
export function revisionsForSession(
  revisions: readonly ModelRevision[],
  revisionIds: readonly string[] | null | undefined,
): ModelRevision[] {
  if (!revisionIds || revisionIds.length === 0) return [...revisions];
  const narrowed = revisions.filter((revision) => revisionIds.includes(revision.id));
  // Nothing it named survives, so there is no origin to honour — and an empty scene
  // is not a fallback, it is a room that appears to have lost its model.
  return narrowed.length > 0 ? narrowed : [...revisions];
}

/**
 * Which stored revision a part belongs to, from the node id it was pointed at.
 *
 * Node ids in an imported model's tree are prefixed with `sceneModelPrefix(hash)`
 * (utils/modelLoader.ts), and that prefix is derived from the file's hash on
 * every client — so the prefix a card's `componentReference` carries says which
 * file the mesh came from, and the file says which revision. This is what lets a
 * card be recorded against Rev B rather than against "the model", which is the
 * difference between a tracker that can say "still open on Rev C" and one that
 * cannot.
 *
 * Null when the part is from a built-in preset (headphones, bicycle, synth), from
 * a legacy curation model, or from a revision this review never stored. All three
 * are ordinary, and a card with no revision is rendered without one.
 *
 * Two revisions holding the same file answer the first of them: the same bytes
 * imported as Rev A of two lines is a scene that cannot tell them apart either,
 * and picking one deterministically beats picking at random.
 */
export function revisionIdForPart(
  partNodeId: string | null | undefined,
  revisions: readonly ModelRevision[],
): string | null {
  if (!partNodeId) return null;
  for (const revision of revisions) {
    if (!revision.hash) continue;
    if (partNodeId.startsWith(`${sceneModelPrefix(revision.hash)}_`)) return revision.id;
  }
  return null;
}
