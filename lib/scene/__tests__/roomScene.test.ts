// What is on screen in a room, as data — and the rules for changing it.
//
// Two properties here are load-bearing in ways that a read of the module does not
// make obvious, and they are what these tests are for.
//
// The first is IDENTITY. applySceneUpdate returns the very object it was given
// when an operation changed nothing, and party/room.server.ts decides there is
// nothing to persist or relay on `next === this.scene`. A client poking at a
// model that is not there must not push a fresh SCENE_STATE to everybody in the
// room, so "did it change" is asserted with toBe, not with toEqual.
//
// The second is DERIVATION. Scene ids and tree-node prefixes come from the file's
// content hash rather than from a counter or a random uuid, because two callers
// build the same scene independently — lib/scene/curationScene.ts from a stored
// asset, and a room from what the server relays — and a pin names the mesh it was
// placed on. A hash-derived id is the only thing that makes those two agree.

import { describe, expect, it } from 'vitest';
import {
  FIRST_REVISION,
  MAX_SCENE_MODELS,
  applySceneUpdate,
  describeSceneRefusal,
  emptyScene,
  latestRevision,
  lineFromFileName,
  mayChangeModels,
  nextRevisionFor,
  nextRevisionLetter,
  sceneModelId,
  sceneModelLabel,
  sceneModelPrefix,
} from '../roomScene';
import type {
  BuiltInModel,
  ModelEditors,
  RoomScene,
  SceneModel,
  SceneRefusalReason,
  SceneUpdate,
} from '../roomScene';

/** Two content addresses, as model storage would hand them back. */
const BRACKET_HASH = '3f8a1c9d47e2b6a05c1d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b';
const MATING_HASH = 'b71e4d09a2c5f8360de1a97c4b2f8e05d1c3a79b6e4f2d80c5a1937e6b4d2f08';

/**
 * A scene model, named by the test rather than generated, so that building the
 * same fixture twice yields the same id — the property the module promises about
 * hashes and the one a random uuid would have broken.
 */
function sceneModel(name: string, overrides: Partial<SceneModel> = {}): SceneModel {
  const hash = overrides.hash ?? `hash-${name}`;
  return {
    id: overrides.id ?? sceneModelId(hash),
    hash,
    fileName: overrides.fileName ?? `${name}.step`,
    line: overrides.line ?? 'Bracket',
    revision: overrides.revision ?? 'A',
    visible: overrides.visible ?? true,
    offset: overrides.offset ?? [0, 0, 0],
  };
}

/** One revision of a product line, which is all the revision tests need. */
function revisionOf(line: string, revision: string): SceneModel {
  return sceneModel(`${line}-${revision}`, { line, revision });
}

/**
 * Frozen all the way down, so that a reducer which mutated its input in place
 * would throw rather than quietly pass. The reducer is run by two callers on two
 * copies of the scene, and only one of them is allowed to be authoritative.
 */
function frozen(scene: RoomScene): RoomScene {
  for (const model of scene.models) {
    Object.freeze(model.offset);
    Object.freeze(model);
  }
  Object.freeze(scene.models);
  Object.freeze(scene);
  return scene;
}

function sceneWith(models: SceneModel[], builtIn: BuiltInModel | null = null): RoomScene {
  return frozen({ ...emptyScene(), models, builtIn });
}

describe('emptyScene', () => {
  it('hands out a fresh empty scene every time', () => {
    // A shared module-level empty scene would have let one room's additions turn
    // up in another's, because every caller spreads from the same array.
    expect(emptyScene()).not.toBe(emptyScene());
    expect(emptyScene()).toEqual({ models: [], builtIn: null });
  });
});

describe('nextRevisionLetter', () => {
  it('steps a single letter forward', () => {
    // Uploading a variation of a model adds Rev B to the same room instead of
    // starting a new one, so the letter after the one on screen has to be
    // predictable rather than held in a counter somewhere else.
    expect(nextRevisionLetter('A')).toBe('B');
    expect(nextRevisionLetter('Y')).toBe('Z');
  });

  it('carries into a longer run of letters instead of stopping at Z', () => {
    // A product that outlives 26 meetings in one room is exactly the product
    // whose history is worth keeping; running out of letters in the middle of it
    // would have been a silly thing to explain.
    expect(nextRevisionLetter('Z')).toBe('AA');
    expect(nextRevisionLetter('AZ')).toBe('BA');
    expect(nextRevisionLetter('ZZ')).toBe('AAA');
    expect(nextRevisionLetter('AAA')).toBe('AAB');
  });

  it('reads anything that is not letters as no revision yet', () => {
    // An empty revision, or a restored record somebody hand-edited, is not a
    // revision to step on from: the next one is the first one.
    expect(nextRevisionLetter('')).toBe('A');
    expect(nextRevisionLetter('   ')).toBe('A');
    expect(nextRevisionLetter('12')).toBe('A');
    expect(nextRevisionLetter('B-1')).toBe('A');
    expect(FIRST_REVISION).toBe('A');
  });

  it('upper-cases and trims before stepping', () => {
    // Records travel through storage and through a wire that does not promise
    // case; 'a' is the first revision and must not produce a second 'a'.
    expect(nextRevisionLetter('a')).toBe('B');
    expect(nextRevisionLetter('az')).toBe('BA');
    expect(nextRevisionLetter(' A ')).toBe('B');
  });
});

describe('latestRevision', () => {
  it('finds the newest letter of a line rather than the last entry in the array', () => {
    // A scene restored from storage, or one whose additions arrived out of order,
    // has an array order that is not a revision order. Reading the last entry
    // would have handed out a letter the line already has.
    const scene = [revisionOf('Bracket', 'C'), revisionOf('Bracket', 'A'), revisionOf('Bracket', 'B')];
    expect(latestRevision(scene, 'Bracket')).toBe('C');
  });

  it('orders longer letters after shorter ones, so AA beats Z', () => {
    // Length first, then alphabet: a plain string comparison would call Z the
    // newest of ['Z', 'AA'], and last-entry-wins would call Z the newest of
    // ['AA', 'Z']. Both are wrong, and both are one revision away from handing
    // out a duplicate.
    expect(latestRevision([revisionOf('Bracket', 'AA'), revisionOf('Bracket', 'Z')], 'Bracket')).toBe('AA');
    expect(latestRevision([revisionOf('Bracket', 'Z'), revisionOf('Bracket', 'AA')], 'Bracket')).toBe('AA');
  });

  it('looks at one line only, and skips a revision that was never filled in', () => {
    const scene = [revisionOf('Bracket', 'B'), revisionOf('Mating Part', 'Z')];
    expect(latestRevision(scene, 'Bracket')).toBe('B');
    // A blank revision must not make the line look started, or the next upload
    // would be labelled B on a product nobody has ever seen an A of.
    expect(latestRevision([revisionOf('Bracket', '  ')], 'Bracket')).toBeNull();
  });

  it('has nothing to say about a line the scene does not hold', () => {
    expect(latestRevision([], 'Bracket')).toBeNull();
    expect(latestRevision([revisionOf('Mating Part', 'D')], 'Bracket')).toBeNull();
  });
});

describe('nextRevisionFor', () => {
  it('continues from the newest letter even when that is not the last one added', () => {
    const scene = [revisionOf('Bracket', 'C'), revisionOf('Bracket', 'A'), revisionOf('Bracket', 'B')];
    expect(nextRevisionFor(scene, 'Bracket')).toBe('D');
  });

  it('starts a new line at A', () => {
    expect(nextRevisionFor([], 'Bracket')).toBe('A');
    // A room that has only ever held a different product says nothing about this
    // one: importing a mating part is Rev A of the mating part.
    expect(nextRevisionFor([revisionOf('Mating Part', 'D')], 'Bracket')).toBe('A');
  });

  it('continues past Z when the line has got that far', () => {
    expect(nextRevisionFor([revisionOf('Bracket', 'Z')], 'Bracket')).toBe('AA');
  });
});

describe('applySceneUpdate: add', () => {
  it('appends the model and leaves what was there alone', () => {
    const first = sceneModel('first');
    const scene = sceneWith([first]);
    const before = JSON.stringify(scene);
    const added = sceneModel('second', { line: 'Mating Part' });

    const next = applySceneUpdate(scene, { op: 'add', model: added });

    expect(next).not.toBe(scene);
    expect(next.models).toEqual([first, added]);
    // Appended rather than sorted or replaced: the models already under
    // discussion stay where the room put them, and an untouched sibling keeps its
    // identity so the tree does not re-render rows that did not change.
    expect(next.models[0]).toBe(first);
    expect(next.builtIn).toBeNull();
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('returns the identical scene for an id that is already there', () => {
    // One file cannot be in a scene twice, because its id is its hash. The
    // identical object is what lets the server stay quiet while the import flow
    // tells the person it happened; a fresh equal scene would have relayed a
    // change that was not one.
    const model = sceneModel('first', { hash: BRACKET_HASH });
    const scene = sceneWith([model]);
    const before = JSON.stringify(scene);

    const next = applySceneUpdate(scene, {
      op: 'add',
      model: sceneModel('first-again', { hash: BRACKET_HASH, offset: [9, 9, 9] }),
    });

    expect(next).toBe(scene);
    expect(next.models).toHaveLength(1);
    // Nor does a duplicate add smuggle in its own offset.
    expect(next.models[0].offset).toEqual([0, 0, 0]);
    expect(JSON.stringify(scene)).toBe(before);
  });
});

describe('applySceneUpdate: setVisible', () => {
  it('flips the flag on one model only', () => {
    const a = sceneModel('a');
    const b = sceneModel('b');
    const scene = sceneWith([a, b]);
    const before = JSON.stringify(scene);

    const next = applySceneUpdate(scene, { op: 'setVisible', id: a.id, visible: false });

    expect(next).not.toBe(scene);
    expect(next.models.map((model) => model.visible)).toEqual([false, true]);
    expect(next.models[1]).toBe(b);
    expect(a.visible).toBe(true);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('returns the identical scene when the flag already had that value', () => {
    // Toggling a checkbox twice, or two clients racing to hide the same model,
    // is not a change and must not become a broadcast.
    const scene = sceneWith([sceneModel('a', { visible: true })]);
    expect(applySceneUpdate(scene, { op: 'setVisible', id: scene.models[0].id, visible: true })).toBe(scene);
  });

  it('returns the identical scene for a model it does not have', () => {
    // A client that has not caught up can still be showing a model the room
    // removed. Answering that with a fresh SCENE_STATE would have ping-ponned
    // two clients that disagree about what is on screen.
    const scene = sceneWith([sceneModel('a')]);
    expect(applySceneUpdate(scene, { op: 'setVisible', id: 'model-gone', visible: false })).toBe(scene);
    expect(scene.models[0].visible).toBe(true);
  });
});

describe('applySceneUpdate: remove', () => {
  it('drops the model and keeps the rest in order', () => {
    const a = sceneModel('a');
    const b = sceneModel('b');
    const c = sceneModel('c');
    const scene = sceneWith([a, b, c]);
    const before = JSON.stringify(scene);

    const next = applySceneUpdate(scene, { op: 'remove', id: b.id });

    expect(next).not.toBe(scene);
    expect(next.models).toEqual([a, c]);
    expect(scene.models).toEqual([a, b, c]);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('returns the identical scene for an unknown id', () => {
    const scene = sceneWith([sceneModel('a')]);
    expect(applySceneUpdate(scene, { op: 'remove', id: 'model-gone' })).toBe(scene);
    expect(scene.models).toHaveLength(1);
  });
});

describe('applySceneUpdate: setOffset', () => {
  it('replaces the offset of one model', () => {
    const a = sceneModel('a');
    const b = sceneModel('b', { offset: [4, 0, 0] });
    const scene = sceneWith([a, b]);
    const before = JSON.stringify(scene);

    const next = applySceneUpdate(scene, { op: 'setOffset', id: b.id, offset: [-2.5, 1, 3] });

    expect(next).not.toBe(scene);
    expect(next.models[1].offset).toEqual([-2.5, 1, 3]);
    expect(next.models[0]).toBe(a);
    expect(b.offset).toEqual([4, 0, 0]);
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('returns the identical scene for an offset that is already there', () => {
    // A drag sends setOffset on every pointer move, including the move that put
    // the model back where it started. Equality is by value, so a freshly built
    // tuple with the same numbers is still a no-op and not a relay to the room.
    const scene = sceneWith([sceneModel('a', { offset: [1, 2, 3] })]);
    const held = scene.models[0].offset;

    const next = applySceneUpdate(scene, { op: 'setOffset', id: scene.models[0].id, offset: [1, 2, 3] });

    expect(next).toBe(scene);
    // The equal-but-distinct tuple was not adopted either: the model still holds
    // the array it was given, so nothing downstream sees a new reference.
    expect(next.models[0].offset).toBe(held);
  });

  it('returns the identical scene for an unknown id', () => {
    const scene = sceneWith([sceneModel('a', { offset: [1, 2, 3] })]);
    expect(applySceneUpdate(scene, { op: 'setOffset', id: 'model-gone', offset: [9, 9, 9] })).toBe(scene);
    expect(scene.models[0].offset).toEqual([1, 2, 3]);
  });
});

describe('applySceneUpdate: setBuiltIn', () => {
  it('sets and clears the built-in model', () => {
    const scene = sceneWith([], 'synth');

    const cleared = applySceneUpdate(scene, { op: 'setBuiltIn', builtIn: null });
    expect(cleared).not.toBe(scene);
    expect(cleared.builtIn).toBeNull();

    // A room that has only ever held imports keeps builtIn null, and choosing one
    // again has to come back — it is what is on screen while there are no models.
    const chosen = applySceneUpdate(cleared, { op: 'setBuiltIn', builtIn: 'headphones' });
    expect(chosen.builtIn).toBe('headphones');
    expect(chosen.models).toEqual([]);
    expect(scene.builtIn).toBe('synth');
  });

  it('returns the identical scene when the built-in did not change', () => {
    // Re-choosing the built-in that is already up happens every time a client
    // re-sends the scene it was just given.
    const scene = sceneWith([sceneModel('a')], 'bicycle');
    expect(applySceneUpdate(scene, { op: 'setBuiltIn', builtIn: 'bicycle' })).toBe(scene);
    expect(scene.builtIn).toBe('bicycle');
  });

  it('returns the identical scene when a null built-in is set to null again', () => {
    // The common case, and the one a `!builtIn` guard would have got wrong: a room
    // that has only ever held imports has nothing to clear.
    const scene = sceneWith([sceneModel('a')]);
    expect(scene.builtIn).toBeNull();
    expect(applySceneUpdate(scene, { op: 'setBuiltIn', builtIn: null })).toBe(scene);
  });
});

describe('applySceneUpdate: an operation it has never heard of', () => {
  it('leaves the scene alone instead of throwing', () => {
    // The room server is deployed once and the browser is deployed many times, so
    // a client built after it will send an op the server does not know. Crashing
    // the isolate on an unrecognised message would take the room down for
    // everybody in it, which is worse than ignoring the message.
    const scene = sceneWith([sceneModel('a')], 'synth');
    const unheard = { op: 'explode' } as unknown as SceneUpdate;
    const before = JSON.stringify(scene);

    let next: RoomScene = emptyScene();
    expect(() => {
      next = applySceneUpdate(scene, unheard);
    }).not.toThrow();

    expect(next).toBe(scene);
    expect(JSON.stringify(scene)).toBe(before);
  });
});

describe('applySceneUpdate: purity', () => {
  it('leaves the scene it was given exactly as it found it, for every operation', () => {
    // Two callers run this reducer on their own copy — the server on the
    // authoritative one, the browser on its prediction of what the server will
    // do. Mutating in place would have made the browser's copy true before the
    // server had agreed to anything, which is the whole thing the operation-based
    // protocol exists to prevent. The fixtures are frozen, so a mutation would
    // throw rather than pass silently.
    const a = sceneModel('a');
    const b = sceneModel('b', { visible: false, offset: [3, 0, 0] });
    const updates: SceneUpdate[] = [
      { op: 'add', model: sceneModel('c') },
      { op: 'setVisible', id: b.id, visible: true },
      { op: 'setOffset', id: a.id, offset: [1, 1, 1] },
      { op: 'remove', id: a.id },
      { op: 'setBuiltIn', builtIn: 'bicycle' },
      { op: 'explode' } as unknown as SceneUpdate,
    ];

    for (const update of updates) {
      const scene = sceneWith([a, b], 'synth');
      const before = JSON.stringify(scene);
      applySceneUpdate(scene, update);
      expect(JSON.stringify(scene)).toBe(before);
      expect(scene.models).toHaveLength(2);
      expect(scene.builtIn).toBe('synth');
    }

    expect(a.visible).toBe(true);
    expect(a.offset).toEqual([0, 0, 0]);
    expect(b.visible).toBe(false);
    expect(b.offset).toEqual([3, 0, 0]);
  });
});

describe('mayChangeModels', () => {
  const HOST = 'host-1';
  const GUEST = 'guest-2';

  it('lets the host in whatever the setting says', () => {
    // A room whose host has been locked out of its own scene is a room nobody can
    // fix — including by changing the setting that locked them out.
    expect(mayChangeModels('host', HOST, HOST)).toBe(true);
    expect(mayChangeModels('everyone', HOST, HOST)).toBe(true);
    // Not even a named list that leaves them off it.
    expect(mayChangeModels([GUEST], HOST, HOST)).toBe(true);
  });

  it('lets anybody in when the setting is everyone', () => {
    expect(mayChangeModels('everyone', GUEST, HOST)).toBe(true);
  });

  it('refuses a guest when the setting is host', () => {
    // The default, and the safe direction: a design review where a supplier's
    // guest can swap the product under discussion for something else is a meeting
    // nobody controls.
    expect(mayChangeModels('host', GUEST, HOST)).toBe(false);
  });

  it('admits exactly the named people', () => {
    const editors: ModelEditors = ['colleague-1', GUEST];
    expect(mayChangeModels(editors, GUEST, HOST)).toBe(true);
    expect(mayChangeModels(editors, 'colleague-1', HOST)).toBe(true);
    expect(mayChangeModels(editors, 'supplier-3', HOST)).toBe(false);
    // An empty list is not "everybody": it is a host who has named nobody.
    expect(mayChangeModels([], GUEST, HOST)).toBe(false);
  });

  it('reads a null host as you are the host', () => {
    // Nobody has been named yet — a solo session, or a socket that has not heard
    // HOST_CHANGE. Interface, SharePanel and ManageButton all read a null host
    // that way, and reading it the other way here would have locked a solo review
    // out of its own imports.
    expect(mayChangeModels('host', GUEST, null)).toBe(true);
    expect(mayChangeModels('everyone', GUEST, null)).toBe(true);
    expect(mayChangeModels([HOST], GUEST, null)).toBe(true);
    expect(mayChangeModels('host', null, null)).toBe(true);
  });

  it('refuses a client it has no id for once there is a real host', () => {
    // A null userId is a connection that has not identified itself. Treating that
    // as the host would have let the first message on any socket change the scene.
    expect(mayChangeModels('everyone', null, HOST)).toBe(false);
    expect(mayChangeModels('host', null, HOST)).toBe(false);
    expect(mayChangeModels([GUEST], null, HOST)).toBe(false);
  });
});

describe('sceneModelPrefix', () => {
  it('gives one hash one prefix, on every call', () => {
    // Every participant computes this for itself, so it has to be a function of
    // the hash and of nothing else — not a counter, which would make node ids
    // depend on the order models happened to load in, and not a random id, which
    // would make a pin mean something different on every screen.
    expect(sceneModelPrefix(BRACKET_HASH)).toBe(sceneModelPrefix(BRACKET_HASH));
    expect(sceneModelPrefix(BRACKET_HASH)).toBe('m3f8a1c9d');
  });

  it('gives two different files two different prefixes', () => {
    // Two imported models both number their nodes from zero. Without the prefix
    // the second one's `imported_4` is the first one's `imported_4`: the tree
    // would show one row for two meshes, hiding a part would hide a part of the
    // other model, and a pin would resolve to the wrong geometry on somebody
    // else's screen.
    expect(sceneModelPrefix(BRACKET_HASH)).not.toBe(sceneModelPrefix(MATING_HASH));
    expect(`${sceneModelPrefix(BRACKET_HASH)}_4`).not.toBe(`${sceneModelPrefix(MATING_HASH)}_4`);
    expect(`${sceneModelPrefix(BRACKET_HASH)}_4`).toBe('m3f8a1c9d_4');
  });

  it('is short, lowercase and alphanumeric, so it is safe inside a node id', () => {
    expect(sceneModelPrefix(BRACKET_HASH)).toMatch(/^m[a-z0-9]{8}$/);
    // A hash that travelled through a header can come back in a different case or
    // wrapped in punctuation; two participants must still compute the same prefix
    // for the same file.
    expect(sceneModelPrefix('ABC-DEF_12 34')).toBe(sceneModelPrefix('abcdef1234'));
    expect(sceneModelPrefix('ABC-DEF_12 34')).toBe('mabcdef12');
  });

  it('falls back to a plain prefix when the hash has nothing to slug', () => {
    // A legacy curation holds inline bytes and therefore an empty hash
    // (legacyCurationModel in lib/scene/curationScene.ts). It still needs usable
    // node ids, and an empty prefix would have produced ids beginning with '_'.
    expect(sceneModelPrefix('')).toBe('model');
    expect(sceneModelPrefix('---..//')).toBe('model');
    expect(sceneModelPrefix('···')).toBe('model');
  });
});

describe('sceneModelId', () => {
  it('gives the same file the same id every time', () => {
    // A review opened from its curation builds a one-model scene out of
    // asset.modelHash with no room server involved, and a room builds one out of
    // what the server relays. Pins and comments name the mesh they were placed
    // on, so both paths have to agree or a pin made while curating points at
    // nothing once the review is open.
    const first = sceneModelId(BRACKET_HASH);
    expect(sceneModelId(BRACKET_HASH)).toBe(first);
    expect(sceneModelId(BRACKET_HASH)).toBe(first);
    // Derived from the hash rather than minted: nothing here can vary per call.
    expect(first).toContain(BRACKET_HASH);
  });

  it('gives two different files two different ids', () => {
    expect(sceneModelId(BRACKET_HASH)).not.toBe(sceneModelId(MATING_HASH));
  });

  it('is what the scene keys on, so one file cannot be in a scene twice', () => {
    // The consequence of deriving rather than minting: re-importing the same file
    // produces the same id, `add` refuses it, and the room keeps showing the one
    // model that was already there.
    const model = sceneModel('bracket', { hash: BRACKET_HASH });
    const scene = sceneWith([model]);
    const again = sceneModel('bracket-again', { hash: BRACKET_HASH, offset: [5, 0, 0] });

    expect(again.id).toBe(model.id);
    expect(applySceneUpdate(scene, { op: 'add', model: again })).toBe(scene);
  });
});

describe('sceneModelLabel', () => {
  it('names the line and the revision', () => {
    // The model tree shows one row per revision of a line, and this label is the
    // only thing telling A from B once both are on screen in Compare.
    expect(sceneModelLabel({ line: 'Bracket', revision: 'B' })).toBe('Bracket · Rev B');
    expect(sceneModelLabel(sceneModel('m', { line: 'Mating Part', revision: 'AA' }))).toBe('Mating Part · Rev AA');
  });
});

describe('lineFromFileName', () => {
  it('takes the file name without its extension', () => {
    // A line is named after the file it was first imported from, so that a second
    // upload of a variation joins the same line instead of starting another.
    expect(lineFromFileName('bracket.step')).toBe('bracket');
  });

  it('keeps the dots that are part of the name', () => {
    // Only the extension goes. 'bracket.v2.step' is the second version of a
    // bracket, and collapsing it to 'bracket' would have merged two lines that
    // Compare is supposed to be able to tell apart.
    expect(lineFromFileName('bracket.v2.step')).toBe('bracket.v2');
    expect(lineFromFileName('Bügel — Rev B.step')).toBe('Bügel — Rev B');
  });

  it('returns a name with no extension unchanged', () => {
    expect(lineFromFileName('bracket')).toBe('bracket');
  });

  it('does not collapse an extension-only name to nothing', () => {
    // A file really called '.step' would otherwise become an empty line: a line no
    // later revision could ever be found on, because latestRevision skips blanks.
    expect(lineFromFileName('.step')).toBe('.step');
    expect(lineFromFileName('')).toBe('');
  });
});

/**
 * Keyed by every member of SceneRefusalReason, so that adding a reason to the
 * union without adding a sentence for it is a typecheck failure here rather than
 * a person being shown the generic "could not read that" string.
 */
const EVERY_REFUSAL: Record<SceneRefusalReason, true> = {
  'host-only': true,
  'not-an-editor': true,
  'host-only-setting': true,
  // Batch BC (docs/plan/14): on a deployment with accounts the room server refuses
  // by the person's ROLE IN THE REVIEW rather than by who arrived first, and a
  // refusal that said "only the host can" would have pointed at the wrong thing.
  'role-forbidden': true,
  'role-forbidden-setting': true,
  'scene-full': true,
  // Batch BX (docs/plan/15): a dropped variant's room is still reachable by address,
  // and its model is a record rather than a live scene. The refusal is about the ROOM,
  // not about the person, which is why it has a sentence of its own — "only the host
  // can change the models" would name a rule that is not the one in the way.
  'dropped-line': true,
  // Batch BQ2: two connections offered the same never-seeded room its review's models
  // at the same moment. It has a sentence like any other reason, and the client drops
  // it without showing it — see the SCENE_REFUSED handler in lib/usePartyPresence.
  'already_seeded': true,
  'unreadable-update': true,
};
const REFUSAL_REASONS = Object.keys(EVERY_REFUSAL) as SceneRefusalReason[];

describe('describeSceneRefusal', () => {
  it('answers every reason the server can give with a sentence, not a code', () => {
    // The wire carries a short code and the words a person reads live here, the
    // way lib/modelsClient.ts does it. Somebody who was refused an import is
    // owed an explanation they can act on, not 'host-only'.
    for (const reason of REFUSAL_REASONS) {
      const sentence = describeSceneRefusal(reason);
      expect(sentence.trim().length).toBeGreaterThan(20);
      expect(sentence).not.toBe(reason);
      expect(sentence.toLowerCase()).not.toContain(reason);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('gives each reason its own sentence', () => {
    // A reason that fell through to the default would share the generic string
    // with 'unreadable-update' — the one failure mode the loop above cannot see,
    // because the generic string is itself a perfectly good sentence.
    const sentences = REFUSAL_REASONS.map((reason) => describeSceneRefusal(reason));
    expect(new Set(sentences).size).toBe(REFUSAL_REASONS.length);
  });

  it('says how full the scene is when the cap is what refused the change', () => {
    // The number in the message is the real cap, so raising MAX_SCENE_MODELS
    // cannot leave the sentence lying about it.
    expect(describeSceneRefusal('scene-full')).toContain(String(MAX_SCENE_MODELS));
  });
});

describe('revisionTargets', () => {
  it('puts the line with the file\'s own name first', async () => {
    const { revisionTargets } = await import('../roomScene');
    const models = [{ line: 'cube' }, { line: 'as1-oc-214' }, { line: 'as1-oc-214' }];
    expect(revisionTargets(models, 'cube.obj', 'as1-oc-214')).toEqual(['cube', 'as1-oc-214']);
  });
  it('falls back to the active line, then scene order', async () => {
    const { revisionTargets } = await import('../roomScene');
    const models = [{ line: 'a' }, { line: 'b' }, { line: 'c' }];
    expect(revisionTargets(models, 'other.step', 'b')).toEqual(['b', 'a', 'c']);
  });
  it('offers nothing for an empty scene', async () => {
    const { revisionTargets } = await import('../roomScene');
    expect(revisionTargets([], 'x.glb', null)).toEqual([]);
  });
});
