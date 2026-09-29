// What is on screen in a room, as data — and the rules for changing it.
//
// Batch BA made a model a hash: one file, stored once, fetched by everybody.
// This is the next step the plan asks for (docs/plan/14-rooms-models-admin-ai.md,
// "Other models in the scene", "Model and revisions", "Who may change models"):
// the room holds a LIST of models, each one a revision of a product line, and
// the list is the room server's to keep.
//
// Everything here is pure and dependency-free on purpose. The room server runs
// inside workerd and imports this module to apply a change to its own copy of
// the scene; the browser imports the same module to predict what the server
// will do and to render the result. One reducer, two callers — which is what
// stops a client from believing something the server would never have allowed.

// lib/reviews/roles.ts is the one import, and it is pure for the same reason: no
// Supabase, no DOM, no clock, so workerd can load it too. It is what lets
// scenePermissions below be ONE function the browser and the room server both
// ask, rather than two that drift apart.
import { can, type Role } from '../reviews/roles';

/** A model that ships with the app and has nothing to fetch. */
export type BuiltInModel = 'synth' | 'headphones' | 'bicycle';

/**
 * One PART of one model, moved / turned / resized away from where its file had it.
 *
 * Every field is optional and in the node's LOCAL (parent) space, and each one is
 * an OVERRIDE of the transform the file gave the node rather than a delta on top of
 * it — so applying the same override twice is a no-op, and "Reset part" is a delete
 * of the entry rather than an arithmetic inverse. Batch BR
 * (docs/plan/14-rooms-models-admin-ai.md).
 *
 * Scale is three numbers and non-uniform on purpose, unlike the model's own single
 * `scale`: a whole model has to stay readable by the bounding box, the label height
 * and placement, which all assume one number, while a part is inside that box and
 * stretching one flange is exactly the thing an assembly review wants to do.
 */
export interface PartTransform {
  position?: [number, number, number];
  /** Euler radians in XYZ, the order three.js reads an object's rotation in. */
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

/**
 * Every moved part of one model, keyed by NODE ID — the id `buildSceneTree` writes
 * into `userData.modelId`, which is the id the Model Tree shows, the id a card's
 * `componentReference` carries and the id the pointing timeline resolves. Keying on
 * that rather than on a name or an index is what makes a moved part still be the part
 * everything else in the app already refers to.
 */
export type PartTransforms = Record<string, PartTransform>;

/**
 * How many part overrides one model may carry.
 *
 * The scene is persisted whole and replayed to every connection that joins, so this
 * is the same kind of ceiling as MAX_SCENE_MODELS: nothing here grows on its own, but
 * a client could otherwise grow it without bound. 500 is far past the number of parts
 * anybody moves by hand in a design review and far below the node count of a big CAD
 * assembly, which is the case the cap exists to stop.
 */
export const MAX_SCENE_PARTS = 500;

/** A node id longer than this is not one this app minted. See MAX_SCENE_PARTS. */
export const MAX_PART_NODE_ID = 200;

/**
 * One model in the room's scene.
 *
 * `hash` is BA's content address: the bytes live in model storage and every
 * participant fetches them from /api/models/<hash>, so this record is small
 * enough to persist, replay to a late joiner and relay on every change.
 *
 * `line` is the product this is — a bracket, a mating part, a competitor's
 * unit — and `revision` is which version of it. Revisions of one line are the
 * continuity the plan asks for: uploading a variation of a model adds Rev B to
 * the same room instead of starting a new one, and Compare can then put A and B
 * side by side.
 *
 * `id` is minted by sceneModelId(hash) and is what everything else keys on: the
 * parsed geometry in the store, and every SCENE_UPDATE that refers to the model.
 * It is derived from the hash rather than random, for the reason given there.
 */
export interface SceneModel {
  id: string;
  hash: string;
  fileName: string;
  line: string;
  revision: string;
  visible: boolean;
  /** Placement in the room, in scene units. See lib/scene/placement.ts. */
  offset: [number, number, number];
  /**
   * Turn and size, both OPTIONAL and both absent on every model written before
   * batch BH put Move / Rotate / Scale in the room's amber strip. Absent means
   * identity — see sceneModelTransform — which is what a scene persisted by an
   * older build, or sent by an older client, has to mean: a model that was placed
   * but never turned is a model standing the way it arrived.
   *
   * Euler radians in XYZ, the order three.js reads a group's rotation in, so the
   * value the gizmo produces is the value the renderer consumes.
   */
  rotation?: [number, number, number];
  /** Uniform, multiplying the entry's own baseScale and the user's slider. */
  scale?: number;
  /**
   * Parts of THIS model somebody moved on their own, keyed by node id — batch BR.
   *
   * Optional and absent on every model written before this batch, on every new
   * revision (a different file, whose nodes are not the same nodes), and on every
   * model added beside another. Absent means "stand exactly as the file says", which
   * is what an older build's scene and an older client's payload both have to keep
   * meaning: a reader that has never heard of parts renders the model unchanged, and
   * a writer that has never heard of them sends an update that leaves them alone.
   */
  parts?: PartTransforms;
}

/** Where one model sits in the room, and how it is turned and sized. */
export interface SceneModelTransform {
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: number;
}

/** A model nobody has moved, turned or resized. */
export const IDENTITY_SCENE_TRANSFORM: SceneModelTransform = {
  offset: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: 1,
};

/**
 * One model's transform, with the optional fields filled in.
 *
 * Every reader goes through this rather than reaching for `model.rotation ?? …`,
 * so "absent means identity" is written down once. A scale that is not a usable
 * number — zero would make a model vanish, a negative one would invert it, and
 * both can only arrive from a client that meant something else — falls back to 1.
 */
export function sceneModelTransform(model: SceneModel): SceneModelTransform {
  const scale = typeof model.scale === 'number' && Number.isFinite(model.scale) && model.scale > 0
    ? model.scale
    : 1;
  return {
    offset: model.offset ?? IDENTITY_SCENE_TRANSFORM.offset,
    rotation: model.rotation ?? IDENTITY_SCENE_TRANSFORM.rotation,
    scale,
  };
}

/**
 * Whether two part overrides say the same thing.
 *
 * Field by field, with an absent field and a present one meaning different things
 * only when the numbers differ: `{ position: [0,0,0] }` and `{}` both leave a node
 * where its file had it IF the file had it at the origin, and the reducer cannot
 * know that — so it compares what is written, not what it would do. That is the same
 * choice applySceneUpdate's setTransform makes about a model's own rotation.
 */
export function samePartTransform(a: PartTransform, b: PartTransform): boolean {
  const fields: Array<'position' | 'rotation' | 'scale'> = ['position', 'rotation', 'scale'];
  for (const field of fields) {
    const left = a[field];
    const right = b[field];
    if (left === undefined || right === undefined) {
      if (left !== right) return false;
      continue;
    }
    if (left[0] !== right[0] || left[1] !== right[1] || left[2] !== right[2]) return false;
  }
  return true;
}

/** Whether two models' part overrides are the same set of the same changes. */
export function samePartTransforms(
  a: PartTransforms | undefined | null,
  b: PartTransforms | undefined | null,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  if (leftIds.length !== rightIds.length) return false;
  return leftIds.every((id) => right[id] !== undefined && samePartTransform(left[id], right[id]));
}

/** Whether a model has any part overrides at all. */
export function hasPartTransforms(model: Pick<SceneModel, 'parts'>): boolean {
  return model.parts !== undefined && Object.keys(model.parts).length > 0;
}

/**
 * Which model a node id belongs to, or null when it belongs to none of them.
 *
 * By the id's PREFIX rather than by walking the parsed trees, because the prefix is
 * derived from the file's hash (see sceneModelPrefix) and so is available before the
 * file has been fetched, on the room server, and in every test. A node id that
 * matches no model's prefix is a built-in's — the synth's and the headphones' parts
 * are React components with no SceneModel behind them, and batch BR moves parts of
 * imported models only.
 */
export function sceneModelForNode(
  models: readonly SceneModel[],
  nodeId: string,
): SceneModel | null {
  for (const model of models) {
    if (model.hash === '') continue;
    if (nodeId.startsWith(`${sceneModelPrefix(model.hash)}_`)) return model;
  }
  return null;
}

/**
 * The scene: every model the room is showing, plus which built-in is up when
 * there are none. `builtIn` is null for a room that has only ever held imports.
 */
export interface RoomScene {
  models: SceneModel[];
  builtIn: BuiltInModel | null;
}

/**
 * Who may change the models in this room.
 *
 * 'host' is the default and the safe direction: a design review where a
 * supplier's guest can swap the product under discussion for something else is
 * a meeting nobody controls. 'everyone' is what a team working alone wants, and
 * a list of userIds is the middle ground — the plan's "named people".
 */
export type ModelEditors = 'host' | 'everyone' | string[];

/** What SCENE_STATE carries: the scene, who may change it, and whether it was ever set. */
export interface SceneStatePayload extends RoomScene {
  modelEditors: ModelEditors;
  /**
   * Whether this room's scene has EVER been set — by an import, by a change, or by
   * a seed. Batch BQ2.
   *
   * A room server that has never held a scene sends an empty one, and the client
   * replaces its own with whatever arrives (that is batch BB's rule and it does not
   * change). So "empty" used to mean two different things with no way to tell them
   * apart: a room somebody deliberately cleared, and a room nobody has ever put
   * anything in — every new variant room, and any main room whose server storage is
   * gone. The second one is a room that should start from the design review's stored
   * models, and until this flag existed nothing ever put them there: the variant of a
   * review with two imported models opened on "No model yet", and stayed that way
   * after a reload.
   *
   * False therefore means "this room is waiting for somebody to say what it shows",
   * which is a request a client that may change models answers with SCENE_SEED. It is
   * a fact about the ROOM rather than about the models: once anything has been
   * accepted it is true for ever, so an emptied room stays emptied instead of being
   * refilled from the database behind the person who emptied it.
   */
  seeded: boolean;
}

/**
 * One change a client asks the room server to make.
 *
 * Operations rather than whole scenes, and that is the point: two people who
 * each sent "here is my scene list" would have the second silently undo the
 * first, because neither had seen the other's change yet. An operation says
 * only what it means — hide THIS model, move THAT one — so the server can apply
 * both to its single copy and relay a list that is true for everybody.
 */
export type SceneUpdate =
  | { op: 'add'; model: SceneModel }
  | { op: 'setVisible'; id: string; visible: boolean }
  | { op: 'remove'; id: string }
  | { op: 'setOffset'; id: string; offset: [number, number, number] }
  /**
   * One model's whole transform, from the amber strip's gizmo.
   *
   * All three fields at once rather than one op per axis, because the gizmo
   * produces all three on every drag frame and a room that received "rotate" and
   * "scale" as separate operations would relay two SCENE_STATEs per frame to
   * everybody. `setOffset` stays: it is what placement.ts sends when it puts a
   * newly imported model beside the others, and it does not know or care about
   * turn and size.
   */
  | { op: 'setTransform'; id: string; transform: SceneModelTransform }
  /**
   * One PART of one model, moved — batch BR.
   *
   * The gizmo produces all three fields on every drag frame, so this carries all
   * three for the same reason `setTransform` does. `null` is the operation "Reset
   * part": it deletes the override, which puts the node back where its file had it,
   * because an override REPLACES the file's transform rather than adding to it.
   *
   * Deliberately not one op per axis and not a delta: a delta would have to be
   * applied in order by every client, and a client that joined late or missed one
   * message would end up with a part in a place nobody put it.
   */
  | { op: 'setPartTransform'; id: string; nodeId: string; transform: PartTransform | null }
  /**
   * Every part of one model back where its file had it — the strip's "Reset all
   * parts". One operation rather than N `setPartTransform`s so the room relays one
   * SCENE_STATE for it, not five hundred.
   */
  | { op: 'clearPartTransforms'; id: string }
  | { op: 'setBuiltIn'; builtIn: BuiltInModel | null };

/**
 * Why the room server turned a change down. The words a person reads live in describeSceneRefusal.
 *
 * 'host-only' and 'host-only-setting' are batch BB's answers, and they are what
 * a deployment on identity.mode 'none' still gets — there, the meeting host is
 * the only thing resembling an authority. The two 'role-' reasons are batch BC's:
 * on a deployment with accounts, the room server looks up what the signed-in
 * person is IN THIS DESIGN REVIEW (lib/reviews/roles.ts) and refuses them by
 * role, which is a different fact with a different explanation. Telling an
 * editor "only the host can" would have sent them looking for a host who was not
 * the thing standing in their way.
 */
export type SceneRefusalReason =
  | 'host-only'
  | 'not-an-editor'
  | 'host-only-setting'
  | 'role-forbidden'
  | 'role-forbidden-setting'
  | 'scene-full'
  // This room is on a variant the review has DROPPED (docs/plan/15-sessions-and-variants.md
  // batch BX). A dropped line is kept for the record and its room is still reachable by
  // address, so somebody can walk into it and move a model — and the room server would
  // happily persist it, relay it, and let lib/scene/keepPlacements write it into the
  // review's saved positions for a line nobody is exploring any more. It is a fact
  // about the ROOM rather than about the person asking, which is why the server answers
  // it before it looks anybody's role up: an owner refused here would otherwise be told
  // "only the host can change the models", a sentence about a rule that is not the one
  // standing in their way.
  | 'dropped-line'
  // A SCENE_SEED that arrived after the room had already been seeded — two people
  // opened the same empty variant room at the same moment and both offered its
  // review's models. Not a refusal anybody did anything wrong, which is why the
  // client drops it instead of showing it: the winner's SCENE_STATE is already on
  // its way and says the same thing.
  | 'already_seeded'
  | 'unreadable-update';

/**
 * How many models one room's scene may hold.
 *
 * Every model is a record the room persists and replays to each connection that
 * joins, and a file every one of those connections then downloads. A review
 * compares a product against a mating part and a competitor's version, so the
 * useful number is single figures; the cap exists for the same reason
 * MAX_PERSISTED_ADMISSIONS does, which is that a room server has no other way
 * to stop a client growing its state without bound.
 */
export const MAX_SCENE_MODELS = 24;

/** A scene with nothing in it and no built-in chosen. */
export function emptyScene(): RoomScene {
  return { models: [], builtIn: null };
}

/**
 * The two fields that make something "a revision of a line".
 *
 * A SceneModel has them, and so does a model_revisions row
 * (lib/reviews/revisionsRepo.ts). Taking this instead of SceneModel is what lets
 * the revision-letter arithmetic below have ONE implementation across the scene
 * the room is showing and the history the review has stored — the two lists are
 * not the same, and a second copy of the arithmetic would eventually disagree.
 */
export interface LineRevision {
  line: string;
  revision: string;
}

/** The label the model tree shows: "Bracket · Rev B". */
export function sceneModelLabel(model: Pick<SceneModel, 'line' | 'revision'>): string {
  return `${model.line} · Rev ${model.revision}`;
}

/** A line's name is the file it was first imported from, without the extension. */
export function lineFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^/.]+$/, '').trim();
  return base === '' ? fileName : base;
}

/**
 * A scene model's id, derived from the file's content hash.
 *
 * A random uuid would be stable inside one room, and the plan asks for a stable
 * id — but it would be a DIFFERENT stable id on every client that built the
 * scene itself, and two of those exist: a review opened from its curation
 * (lib/activeReviewStore) makes a one-model scene out of `asset.modelHash` with
 * no room server involved, and a room makes one out of what the server relays.
 * Pins and comments name the mesh they were placed on, so the same file has to
 * produce the same scene on both paths or a pin made while curating points at
 * nothing once the review is open.
 *
 * The consequence is that one file cannot be in a scene twice: `add` refuses an
 * id that is already there. The import flow says so rather than doing nothing.
 */
export function sceneModelId(hash: string): string {
  return `model-${hash}`;
}

/** The first revision of a new line. */
export const FIRST_REVISION = 'A';

/**
 * The revision letter after this one: A→B, Y→Z, Z→AA, AZ→BA, ZZ→AAA.
 *
 * Excel-column arithmetic, because a product that outlives 26 meetings in one
 * room is exactly the product whose history is worth keeping, and running out
 * of letters in the middle of it would be a silly thing to explain.
 *
 * Anything that is not a run of letters — an empty revision, a restored record
 * somebody hand-edited — reads as "no revision yet", so the next one is A.
 */
export function nextRevisionLetter(revision: string): string {
  const current = revision.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(current)) return FIRST_REVISION;
  const letters = current.split('');
  for (let i = letters.length - 1; i >= 0; i -= 1) {
    if (letters[i] === 'Z') {
      letters[i] = 'A';
      continue;
    }
    letters[i] = String.fromCharCode(letters[i].charCodeAt(0) + 1);
    return letters.join('');
  }
  // Every letter carried: ZZ becomes AAA.
  return `A${letters.join('')}`;
}

/** Which revision of a line is the newest. Later letters are longer, then alphabetical. */
export function latestRevision(models: readonly LineRevision[], line: string): string | null {
  let latest: string | null = null;
  for (const model of models) {
    if (model.line !== line) continue;
    const candidate = model.revision.trim().toUpperCase();
    if (candidate === '') continue;
    if (latest === null || candidate.length > latest.length || (candidate.length === latest.length && candidate > latest)) {
      latest = candidate;
    }
  }
  return latest;
}

/**
 * The revision letter a new upload into `line` should get.
 *
 * Computed from the line's newest letter rather than from the last entry in the
 * array: the array is in the order additions arrived, which is the same thing
 * for a room that has only ever been added to, and is not the same thing for a
 * scene restored from storage that somebody rearranged.
 *
 * Takes anything with a line and a revision, not only a SceneModel, because the
 * same arithmetic decides the letter for a model_revisions row — and there the
 * stored history is the truth rather than whatever the scene happens to hold.
 */
export function nextRevisionFor(models: readonly LineRevision[], line: string): string {
  const latest = latestRevision(models, line);
  return latest === null ? FIRST_REVISION : nextRevisionLetter(latest);
}

/**
 * The id prefix that keeps one model's tree node ids out of another's.
 *
 * Two imported models both number their nodes from zero, so without a prefix
 * the second one's `imported_4` is the first one's `imported_4`: the tree would
 * show one row for two meshes, hiding a part would hide a part of the other
 * model, and a pin would resolve to the wrong geometry on somebody else's
 * screen.
 *
 * Derived from the model's HASH, not from a counter and not from a random id, so
 * that every participant computes the same prefix for the same file — which is
 * what makes a pin placed on my screen point at the same mesh on yours, and what
 * lets a review opened from its curation agree with the same review opened in a
 * room. A counter would have made node ids depend on the order models happened
 * to load in.
 *
 * Eight hex characters collide at about one in four billion per pair, and a
 * scene holds a handful of models.
 */
export function sceneModelPrefix(hash: string): string {
  const slug = hash.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  return slug === '' ? 'model' : `m${slug}`;
}

/**
 * Whether this person may change the models in the room, by batch BB's rule.
 *
 * The host always may, whatever the setting says: a room whose host has been
 * locked out of its own scene is a room nobody can fix. A null host means
 * nobody has been named yet — a solo session, or a socket that has not heard
 * HOST_CHANGE — and the app reads that as "you are the host" everywhere else
 * (Interface, SharePanel, ManageButton), so it reads that way here too.
 *
 * This is the WHOLE rule on a deployment with no identities, and only half of it
 * on one with accounts — see scenePermissions, which is what both the room server
 * and the browser actually call.
 */
export function mayChangeModels(
  modelEditors: ModelEditors,
  userId: string | null,
  hostId: string | null,
): boolean {
  if (userId === null) return hostId === null;
  if (userId === hostId) return true;
  if (hostId === null) return true;
  if (modelEditors === 'everyone') return true;
  if (Array.isArray(modelEditors)) return modelEditors.includes(userId);
  return false;
}

/**
 * Everything the two scene-permission questions are decided from.
 *
 * Four facts and no runtime, so that the browser and the room server can be
 * handed the same four and cannot disagree — which is the failure this exists to
 * end. Batch BC made the server decide by ROLE when identities are on; the client
 * kept deciding by "am I the meeting host", and the result was an owner who had
 * created a review, made a colleague an editor, reloaded, and been shown "Import
 * locked" in their own review because the colleague had arrived first.
 */
export interface SceneAuthority {
  /**
   * This person's role in the design review, or NULL when the deployment has no
   * identities to resolve one from. Null is not a role and not a guess at one: it
   * is party/room.server.ts's `roleFor` answering from `reviewFactsCacheFor()`,
   * and lib/reviews/useReviewRole's `rolesApply: false`. With it, the host rule
   * below is the whole rule, exactly as it was before accounts existed.
   */
  role: Role | null;
  /** Who the review says may change its models. */
  modelEditors: ModelEditors;
  /** This person in the room, or null for a connection the room could not place. */
  userId: string | null;
  /** The meeting host — whoever arrived first — or null while nobody is named. */
  hostId: string | null;
}

/** Both answers, with the reason behind each refusal. */
export interface ScenePermissions {
  /** Import, hide for everybody, move, turn, resize, remove. */
  mayChangeModels: boolean;
  /** Why not, as describeSceneRefusal turns it into words. Null when they may. */
  changeRefusal: SceneRefusalReason | null;
  /** Choose who else may change the models. */
  maySetModelEditors: boolean;
  /** Why not. Null when they may. */
  editorsRefusal: SceneRefusalReason | null;
}

/**
 * What one person may do to this room's scene, and why not if not.
 *
 * TWO deployments, two rules, and the role being null is what selects between
 * them:
 *
 * WITHOUT accounts, batch BB's rule unchanged — the meeting host, widened by the
 * "who may change models" setting. There is no roster to read and nobody to be,
 * so a host is the only authority a password-protected install has.
 *
 * WITH accounts, the person's ROLE in the review replaces the host as the
 * authority, because the host is only whoever happened to arrive first and a
 * supplier's guest could be that. Owners and editors may change the models;
 * participants and guests may not — unless the review's own setting says
 * otherwise, which is still the owner's choice to make and the reason
 * 'everyone' and named people keep working rather than being overridden.
 *
 * Choosing who may change them is a step above changing them: it is how a power
 * is handed to somebody else, so it is its own question with its own answer.
 */
export function scenePermissions(authority: SceneAuthority): ScenePermissions {
  const { role, modelEditors, userId, hostId } = authority;

  let changeRefusal: SceneRefusalReason | null;
  let editorsRefusal: SceneRefusalReason | null;

  if (role === null) {
    changeRefusal = mayChangeModels(modelEditors, userId, hostId)
      ? null
      : modelEditors === 'host'
        ? 'host-only'
        : 'not-an-editor';
    editorsRefusal = userId !== null && userId === hostId ? null : 'host-only-setting';
  } else {
    const named = Array.isArray(modelEditors)
      && userId !== null
      && modelEditors.includes(userId);
    changeRefusal = can(role, 'editReview') || modelEditors === 'everyone' || named
      ? null
      : 'role-forbidden';
    editorsRefusal = can(role, 'setModelEditors') ? null : 'role-forbidden-setting';
  }

  return {
    mayChangeModels: changeRefusal === null,
    changeRefusal,
    maySetModelEditors: editorsRefusal === null,
    editorsRefusal,
  };
}

/**
 * What a refusal says, in words.
 *
 * Written out here rather than sent by the server, for the same reason
 * lib/modelsClient.ts writes its own messages: the wire carries a short code
 * and the sentence a person reads lives in the code that shows it.
 */
export function describeSceneRefusal(reason: SceneRefusalReason): string {
  if (reason === 'host-only') {
    return 'Only the host can change the models in this room. Ask them to import it, or to let more people change models.';
  }
  if (reason === 'not-an-editor') {
    return 'The host has chosen who may change models in this room, and you are not one of them.';
  }
  if (reason === 'host-only-setting') {
    return 'Only the host can choose who may change models.';
  }
  if (reason === 'role-forbidden') {
    return 'Only the owner and the editors of this design review can change its models. Ask the owner to make you an editor.';
  }
  if (reason === 'role-forbidden-setting') {
    return 'Only the owner of this design review can choose who may change its models.';
  }
  if (reason === 'scene-full') {
    return `This room is already showing ${MAX_SCENE_MODELS} models. Hide or remove one before adding another.`;
  }
  if (reason === 'dropped-line') {
    return 'This variant was dropped, so its model can no longer be changed.';
  }
  if (reason === 'already_seeded') {
    return 'Somebody else already put this review’s models up, so this room kept theirs.';
  }
  return 'The room server could not read that scene change, so nothing was changed for anybody.';
}

/** Three numbers, equal component by component. */
function sameTriple(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * One model's part overrides, replaced — with an EMPTY set written as an absent
 * field rather than as `{}`.
 *
 * "Absent means the file's own transform" is the single rule SceneModel's optionals
 * follow, and a stored `{}` would be a second way of saying the same thing: it would
 * survive into room storage, into the review's placements and onto the wire, and every
 * comparison that asks "has anybody moved a part here" would have to remember to look
 * inside it. Deleting the key keeps that question a `!== undefined`.
 */
function withParts(scene: RoomScene, id: string, parts: PartTransforms): RoomScene {
  const empty = Object.keys(parts).length === 0;
  return {
    ...scene,
    models: scene.models.map((model) => {
      if (model.id !== id) return model;
      const next: SceneModel = { ...model };
      if (empty) delete next.parts;
      else next.parts = parts;
      return next;
    }),
  };
}

/**
 * Apply one operation to a scene.
 *
 * Returns the SAME object when the operation changes nothing — an unknown id, a
 * duplicate add, a flag that already had that value. The room server relies on
 * that identity to decide whether there is anything to persist or relay, so a
 * client poking at a model that is not there does not push a fresh SCENE_STATE
 * to everybody in the room.
 *
 * Pure and total: it never throws on an operation it does not recognise, it
 * just leaves the scene alone, because the alternative is a room server that
 * crashes on a message from a client built after it was.
 */
export function applySceneUpdate(scene: RoomScene, update: SceneUpdate): RoomScene {
  switch (update.op) {
    case 'add': {
      if (!scene.models.some((model) => model.id === update.model.id)) {
        return { ...scene, models: [...scene.models, update.model] };
      }
      return scene;
    }
    case 'setVisible': {
      const target = scene.models.find((model) => model.id === update.id);
      if (!target || target.visible === update.visible) return scene;
      return {
        ...scene,
        models: scene.models.map((model) =>
          model.id === update.id ? { ...model, visible: update.visible } : model,
        ),
      };
    }
    case 'remove': {
      if (!scene.models.some((model) => model.id === update.id)) return scene;
      return { ...scene, models: scene.models.filter((model) => model.id !== update.id) };
    }
    case 'setOffset': {
      const target = scene.models.find((model) => model.id === update.id);
      if (!target) return scene;
      if (
        target.offset[0] === update.offset[0] &&
        target.offset[1] === update.offset[1] &&
        target.offset[2] === update.offset[2]
      ) {
        return scene;
      }
      return {
        ...scene,
        models: scene.models.map((model) =>
          model.id === update.id ? { ...model, offset: update.offset } : model,
        ),
      };
    }
    case 'setBuiltIn': {
      if (scene.builtIn === update.builtIn) return scene;
      return { ...scene, builtIn: update.builtIn };
    }
    case 'setTransform': {
      const target = scene.models.find((model) => model.id === update.id);
      if (!target) return scene;
      const current = sceneModelTransform(target);
      const next = update.transform;
      // Compared field by field against the FILLED-IN current value, not against
      // the stored optionals: a model that has never been turned has no rotation
      // field at all, and a gizmo sending [0,0,0] for it is not a change. Without
      // this, the first drag of an untouched model would relay a scene whose
      // models are byte-identical to what everybody already has.
      if (
        sameTriple(current.offset, next.offset) &&
        sameTriple(current.rotation, next.rotation) &&
        current.scale === next.scale
      ) {
        return scene;
      }
      return {
        ...scene,
        models: scene.models.map((model) =>
          model.id === update.id
            ? { ...model, offset: next.offset, rotation: next.rotation, scale: next.scale }
            : model,
        ),
      };
    }
    case 'setPartTransform': {
      const target = scene.models.find((model) => model.id === update.id);
      if (!target) return scene;
      const current = target.parts;
      const existing = current?.[update.nodeId];
      if (update.transform === null) {
        // "Reset part". Already where its file had it — nothing to relay, and
        // relaying would redraw every participant's model tree for no change.
        if (!existing) return scene;
        const parts: PartTransforms = { ...current };
        delete parts[update.nodeId];
        return withParts(scene, update.id, parts);
      }
      if (existing && samePartTransform(existing, update.transform)) return scene;
      // Capped here as well as on the wire, so the two callers of this reducer
      // cannot disagree about what a scene may hold: a browser that applied a 501st
      // override locally would be showing a part the room server refused, and would
      // go on showing it until something else happened to change the scene.
      const count = current ? Object.keys(current).length : 0;
      if (!existing && count >= MAX_SCENE_PARTS) return scene;
      return withParts(scene, update.id, { ...(current ?? {}), [update.nodeId]: update.transform });
    }
    case 'clearPartTransforms': {
      const target = scene.models.find((model) => model.id === update.id);
      if (!target || !hasPartTransforms(target)) return scene;
      return withParts(scene, update.id, {});
    }
    default:
      return scene;
  }
}

/**
 * Which lines a newly imported file could be a revision of, best guess first:
 * the line with the file's own name ("bracket.step" continues "bracket"), then
 * the line the tree is pointing at, then the rest in scene order. Offering only
 * "the last model added" put a new cube in as Rev B of a STEP assembly and hid
 * the assembly (found live).
 */
export function revisionTargets(
  models: readonly { line: string }[],
  fileName: string,
  activeLine: string | null,
): string[] {
  const lines: string[] = [];
  for (const model of models) if (!lines.includes(model.line)) lines.push(model.line);
  const byName = lineFromFileName(fileName);
  const first = [byName, activeLine].filter((l): l is string => l !== null && lines.includes(l));
  return [...new Set([...first, ...lines])];
}
