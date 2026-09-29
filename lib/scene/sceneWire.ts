// Reading a scene off the wire, and off the room's persisted storage.
//
// Both are untrusted: one comes from a browser this server has never seen, the
// other from a record a PREVIOUS BUILD of this server wrote. Batch BA learned
// why that second one matters the hard way — a room server that stored its
// model before models were synced by reference had written up to 50 MB of
// base64 into room storage, and restoring that record would have replayed the
// bytes to every connection that joined. So every value here is rebuilt field
// by field from what it should be, never returned as received, and anything
// that does not parse is refused rather than rescued.
//
// Nothing in this module imports from party/ or from three, so the room server
// and the browser can share it.

import {
  FIRST_REVISION,
  lineFromFileName,
  MAX_PART_NODE_ID,
  MAX_SCENE_PARTS,
  sceneModelId,
  type BuiltInModel,
  type ModelEditors,
  type PartTransform,
  type PartTransforms,
  type RoomScene,
  type SceneModel,
  type SceneStatePayload,
  type SceneUpdate,
} from './roomScene';

/**
 * A model reference as batch BA defined it — what an un-updated client still
 * sends as MODEL_CHANGE, and what an un-updated server persisted. Declared
 * structurally here so this module does not have to import from party/, which
 * imports from here.
 */
export interface LegacyModelReference {
  modelType: 'synth' | 'bicycle' | 'imported';
  hash?: string;
  fileName?: string;
  size?: number;
}

const BUILT_IN_MODELS: BuiltInModel[] = ['synth', 'headphones', 'bicycle'];

/** Three finite numbers, or nothing. A NaN in an offset would poison every render. */
export function asOffset(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

function asBuiltIn(value: unknown): BuiltInModel | null {
  return typeof value === 'string' && (BUILT_IN_MODELS as string[]).includes(value)
    ? (value as BuiltInModel)
    : null;
}

/**
 * A part's scale, or nothing.
 *
 * Every component has to be a positive finite number, which is `asOffset`'s rule
 * plus the model-scale rule the setTransform case below already applies: zero would
 * flatten the part for everybody in the room and a negative one would turn it inside
 * out, and neither is a resize anybody meant. Non-uniform IS allowed — that is the
 * difference between a part and a model, and the reason this is not `asOffset`.
 */
function asPartScale(value: unknown): [number, number, number] | null {
  const triple = asOffset(value);
  if (!triple) return null;
  return triple[0] > 0 && triple[1] > 0 && triple[2] > 0 ? triple : null;
}

/**
 * One part's override, rebuilt. Null for anything this server could not read.
 *
 * An override with NONE of the three fields is refused rather than kept as `{}`: it
 * would be a record that changes nothing, persisted and replayed for ever, and the
 * only client that sends one is a client that is broken.
 */
export function asPartTransform(value: unknown): PartTransform | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const next: PartTransform = {};
  let fields = 0;
  if (record.position !== undefined) {
    const position = asOffset(record.position);
    if (!position) return null;
    next.position = position;
    fields += 1;
  }
  if (record.rotation !== undefined) {
    const rotation = asOffset(record.rotation);
    if (!rotation) return null;
    next.rotation = rotation;
    fields += 1;
  }
  if (record.scale !== undefined) {
    const scale = asPartScale(record.scale);
    if (!scale) return null;
    next.scale = scale;
    fields += 1;
  }
  return fields === 0 ? null : next;
}

/**
 * A model's part overrides, rebuilt — capped, and refusing the whole record rather
 * than one entry of it.
 *
 * Three answers, and the third is why this is not `… | null`:
 *   `undefined` — the record has no parts, which is every record written before batch
 *     BR and every model nobody has moved a part of since;
 *   `null` — the record has something this server cannot read;
 *   a `PartTransforms` — the overrides, rebuilt field by field.
 *
 * Refusing the whole set rather than dropping the bad entry is the opposite of what
 * asRoomScene does to a bad MODEL, and deliberately so: one unreadable model costs the
 * room a model it can get back, while a part entry quietly dropped would leave the
 * person who moved it looking at a part that is where they put it and everybody else
 * looking at one that is not.
 */
export function asPartTransforms(
  value: unknown,
  maxEntries: number = MAX_SCENE_PARTS,
): PartTransforms | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ids = Object.keys(record);
  if (ids.length > maxEntries) return null;
  const parts: PartTransforms = {};
  for (const id of ids) {
    if (id === '' || id.length > MAX_PART_NODE_ID) return null;
    const transform = asPartTransform(record[id]);
    if (!transform) return null;
    parts[id] = transform;
  }
  // An empty record means what an absent one means, so it reads as one.
  return ids.length === 0 ? undefined : parts;
}

/**
 * One scene model, rebuilt.
 *
 * A model with no hash is refused: there would be nothing for anybody to fetch,
 * so accepting it would tell every participant to render a model that does not
 * exist. `line` and `revision` fall back rather than fail, because a record
 * written before revisions existed is still a perfectly good model — it is the
 * first revision of a line named after its file.
 *
 * `fileBase64` is checked for and refused, which is BA's rule surviving into
 * the list shape: a payload carrying bytes is from a client that has not been
 * updated, and dropping it is what keeps 50 MB off the socket and out of
 * storage. The field is never read.
 */
export function asSceneModel(value: unknown): SceneModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if ('fileBase64' in record) return null;

  const id = typeof record.id === 'string' && record.id !== '' ? record.id : null;
  const hash = typeof record.hash === 'string' && record.hash !== '' ? record.hash : null;
  const fileName = typeof record.fileName === 'string' && record.fileName !== '' ? record.fileName : null;
  if (!id || !hash || !fileName) return null;

  const line = typeof record.line === 'string' && record.line !== '' ? record.line : lineFromFileName(fileName);
  const revision = typeof record.revision === 'string' && record.revision !== '' ? record.revision : FIRST_REVISION;
  const offset = asOffset(record.offset) ?? [0, 0, 0];
  // Rotation and scale, which batch BI found being DROPPED here. asSceneUpdate's
  // setTransform carries both, the room server applies and persists both, and this
  // is the function that reads a scene back off the wire — so a model somebody
  // turned round or resized in Edit mode reached every other participant unturned,
  // and came back unturned to everybody after a room reload from storage. Read the
  // way setTransform reads them: a rotation that is not three finite numbers, or a
  // scale that is not a positive finite one, is left OUT rather than rescued, so
  // "absent means identity" stays the single rule (see sceneModelTransform).
  const rotation = asOffset(record.rotation);
  const rawScale = record.scale;
  const scale = typeof rawScale === 'number' && Number.isFinite(rawScale) && rawScale > 0
    ? rawScale
    : null;
  // Part overrides, batch BR. Read with the SAME asymmetry as the rotation and scale
  // above rather than with asSceneUpdate's: unreadable parts are left out and the
  // model is kept, because this is the function that restores a scene from the
  // server's own storage as well as the one that reads a relay, and dropping a model
  // over one bad part entry would take a product off everybody's screen in the middle
  // of a review. An operation that ASKS for a change is refused outright instead —
  // see the setPartTransform case below — because there the sender is still there to
  // be told.
  const parts = asPartTransforms(record.parts);

  return {
    id,
    hash,
    fileName,
    line,
    revision,
    visible: record.visible === undefined ? true : record.visible === true,
    offset,
    ...(rotation ? { rotation } : {}),
    ...(scale === null ? {} : { scale }),
    ...(parts ? { parts } : {}),
  };
}

/** A whole scene, rebuilt. Anything unreadable inside it is dropped, not fatal. */
export function asRoomScene(value: unknown): RoomScene | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.models)) return null;
  const models: SceneModel[] = [];
  for (const entry of record.models) {
    const model = asSceneModel(entry);
    // One bad record must not cost the room the rest of its scene: a model
    // somebody can no longer see is recoverable, an empty room in the middle of
    // a review is not. Duplicate ids are dropped so the list stays addressable.
    if (model && !models.some((existing) => existing.id === model.id)) models.push(model);
  }
  const builtIn = record.builtIn === undefined || record.builtIn === null ? null : asBuiltIn(record.builtIn);
  return { models, builtIn };
}

/**
 * What SCENE_STATE carries, rebuilt — the scene, who may change it, and whether the
 * room has ever held one.
 *
 * The client validates it too, even though its own room server built it: a
 * SCENE_STATE that threw would take the rest of the message loop with it, and
 * the roster, the transcript and the comments all arrive through the same
 * handler.
 */
export function asSceneStatePayload(value: unknown): SceneStatePayload | null {
  const scene = asRoomScene(value);
  if (!scene) return null;
  const record = value as Record<string, unknown>;
  return {
    ...scene,
    modelEditors: asModelEditors(record.modelEditors) ?? 'host',
    // ABSENT reads as seeded, and that asymmetry is deliberate: a room server that
    // has not been updated sends no flag at all, and a client that read that as
    // "never seeded" would rebuild its scene from the database over whatever that
    // server was actually holding. Only an explicit false — which only a server that
    // can accept a SCENE_SEED ever sends — asks a client to seed one.
    seeded: record.seeded !== false,
  };
}

/**
 * Whether a record this room server finds in its OWN storage means "already seeded".
 *
 * A record written by this build carries `seeded` and is believed. One written by an
 * older build does not, and there the content is the evidence: a build with no seed
 * path only ever persisted a scene it had been handed, so a record holding any model —
 * or a chosen sample — came from an import or a change, which is what seeded means. An
 * older record holding NOTHING is the one case that reads as unseeded, and correctly:
 * that room was empty when it was written and is empty now, so starting it from its
 * design review's stored models is still the thing nobody has done.
 */
export function seededFromStorage(record: Record<string, unknown>, scene: RoomScene): boolean {
  if (typeof record.seeded === 'boolean') return record.seeded;
  return scene.models.length > 0 || scene.builtIn !== null;
}

/** One operation, rebuilt. Null means "this server cannot apply that". */
export function asSceneUpdate(value: unknown): SceneUpdate | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  switch (record.op) {
    case 'add': {
      const model = asSceneModel(record.model);
      return model ? { op: 'add', model } : null;
    }
    case 'setVisible': {
      if (typeof record.id !== 'string' || record.id === '') return null;
      if (typeof record.visible !== 'boolean') return null;
      return { op: 'setVisible', id: record.id, visible: record.visible };
    }
    case 'remove': {
      if (typeof record.id !== 'string' || record.id === '') return null;
      return { op: 'remove', id: record.id };
    }
    case 'setOffset': {
      if (typeof record.id !== 'string' || record.id === '') return null;
      const offset = asOffset(record.offset);
      return offset ? { op: 'setOffset', id: record.id, offset } : null;
    }
    case 'setTransform': {
      if (typeof record.id !== 'string' || record.id === '') return null;
      const raw = record.transform;
      if (typeof raw !== 'object' || raw === null) return null;
      const fields = raw as Record<string, unknown>;
      const offset = asOffset(fields.offset);
      const rotation = asOffset(fields.rotation);
      if (!offset || !rotation) return null;
      // A scale the renderer could not use is refused rather than rescued: zero
      // would make the model vanish for everybody in the room and a negative one
      // would turn it inside out, and neither is a transform anybody meant.
      const scale = fields.scale;
      if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return null;
      return { op: 'setTransform', id: record.id, transform: { offset, rotation, scale } };
    }
    case 'setPartTransform': {
      if (typeof record.id !== 'string' || record.id === '') return null;
      // The node id is a key this server stores and replays, so it is capped the way
      // asModelEditors caps its list of names: without a length here a client could
      // write arbitrarily large keys into room storage one update at a time.
      const nodeId = record.nodeId;
      if (typeof nodeId !== 'string' || nodeId === '' || nodeId.length > MAX_PART_NODE_ID) return null;
      // `null` is "Reset part" and is a perfectly good transform — see the op's own
      // comment in lib/scene/roomScene.ts. Everything else is rebuilt field by field
      // and refused whole, so a caller cannot have one bad axis of a move applied and
      // the other two dropped.
      if (record.transform === null) {
        return { op: 'setPartTransform', id: record.id, nodeId, transform: null };
      }
      const transform = asPartTransform(record.transform);
      return transform ? { op: 'setPartTransform', id: record.id, nodeId, transform } : null;
    }
    case 'clearPartTransforms': {
      if (typeof record.id !== 'string' || record.id === '') return null;
      return { op: 'clearPartTransforms', id: record.id };
    }
    case 'setBuiltIn': {
      if (record.builtIn === null) return { op: 'setBuiltIn', builtIn: null };
      const builtIn = asBuiltIn(record.builtIn);
      return builtIn ? { op: 'setBuiltIn', builtIn } : null;
    }
    default:
      return null;
  }
}

/**
 * Who may change models, rebuilt.
 *
 * A list is de-duplicated and capped: it is persisted with the scene and
 * replayed to every connection, so it is the one field here a client could
 * otherwise grow without bound.
 */
export function asModelEditors(value: unknown, maxNamed = 100): ModelEditors | null {
  if (value === 'host' || value === 'everyone') return value;
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue;
    if (!ids.includes(entry)) ids.push(entry);
    if (ids.length >= maxNamed) break;
  }
  return ids;
}

/**
 * The scene an old MODEL_CHANGE meant.
 *
 * An un-updated client still sends "here is the model on screen", and the room
 * has to make sense of it rather than drop it: from that client's point of view
 * it imported a model, and everybody else should see it. So the reference
 * becomes a scene holding exactly that one model, which is what the message
 * always meant — it was the whole scene, when the whole scene was one model.
 *
 * The id is derived from the hash so translating the SAME reference twice (a
 * persisted BA record and then a replay of it from an old client) lands on the
 * same model instead of adding a second copy — and so a model an old client put
 * up is the same model a new one would have added, which is what keeps the pins
 * that name its meshes pointing at them.
 *
 * Returns null for a reference carrying bytes, or an imported one with no hash
 * to fetch — BA's refusals, unchanged.
 */
export function sceneFromLegacyReference(reference: LegacyModelReference & { fileBase64?: string }): RoomScene | null {
  if (typeof reference.fileBase64 === 'string') return null;
  if (reference.modelType === 'synth' || reference.modelType === 'bicycle') {
    return { models: [], builtIn: reference.modelType };
  }
  if (reference.modelType !== 'imported') return null;
  const hash = reference.hash ?? '';
  const model = asSceneModel({
    id: sceneModelId(hash),
    hash,
    fileName: reference.fileName ?? 'imported-model',
    line: reference.fileName ? lineFromFileName(reference.fileName) : 'Imported model',
    revision: FIRST_REVISION,
    visible: true,
    offset: [0, 0, 0],
  });
  if (!model) return null;
  return { models: [model], builtIn: null };
}
