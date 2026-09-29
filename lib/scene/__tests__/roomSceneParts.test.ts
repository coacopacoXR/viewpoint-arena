// Part overrides in the scene reducer — batch BR.
//
// What is pinned here is the contract the room server and the browser both rely on,
// which is the same contract `setTransform` has had since batch BH: the reducer is
// pure and total, and it returns the SAME object when an operation changed nothing.
// A scene that came back equal-but-not-identical would have the server persisting and
// relaying a whole SCENE_STATE for a drag that ended where it started.
//
// And the two rules the batch brief asks for by name: a model written before this
// batch — which has no `parts` field at all — is unchanged by everything here, and a
// new revision of a line starts with no overrides because it is a different file.

import { describe, it, expect } from 'vitest';
import {
  applySceneUpdate,
  emptyScene,
  hasPartTransforms,
  MAX_SCENE_PARTS,
  samePartTransform,
  samePartTransforms,
  sceneModelForNode,
  sceneModelId,
  sceneModelPrefix,
  type RoomScene,
  type SceneModel,
} from '../roomScene';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const ID_A = sceneModelId(HASH_A);
const PREFIX_A = sceneModelPrefix(HASH_A);

/** A model as every build before batch BR wrote one: no parts field at all. */
function modelA(overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    id: ID_A,
    hash: HASH_A,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

function sceneOf(...models: SceneModel[]): RoomScene {
  return { models, builtIn: null };
}

const FLANGE = `${PREFIX_A}_3`;
const BOLT = `${PREFIX_A}_7`;

describe('applySceneUpdate — setPartTransform', () => {
  it('adds an override to a model that had none, and leaves the rest of the model alone', () => {
    const scene = sceneOf(modelA({ scale: 2, offset: [4, 0, 0] }));

    const next = applySceneUpdate(scene, {
      op: 'setPartTransform',
      id: ID_A,
      nodeId: FLANGE,
      transform: { position: [1, 0, 0] },
    });

    expect(next.models[0].parts).toEqual({ [FLANGE]: { position: [1, 0, 0] } });
    // Moving a part is not moving the model: batch BH's whole-model transform is a
    // different field and a different operation, and one must not disturb the other.
    expect(next.models[0].scale).toBe(2);
    expect(next.models[0].offset).toEqual([4, 0, 0]);
  });

  it('replaces an override rather than adding to it, because the override IS the transform', () => {
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] } } }));

    const next = applySceneUpdate(scene, {
      op: 'setPartTransform',
      id: ID_A,
      nodeId: FLANGE,
      transform: { position: [5, 0, 0], scale: [2, 2, 2] },
    });

    expect(next.models[0].parts).toEqual({ [FLANGE]: { position: [5, 0, 0], scale: [2, 2, 2] } });
  });

  it('keeps two parts of one model independent', () => {
    let scene = sceneOf(modelA());
    scene = applySceneUpdate(scene, { op: 'setPartTransform', id: ID_A, nodeId: FLANGE, transform: { position: [1, 0, 0] } });
    scene = applySceneUpdate(scene, { op: 'setPartTransform', id: ID_A, nodeId: BOLT, transform: { position: [0, 2, 0] } });

    expect(scene.models[0].parts).toEqual({
      [FLANGE]: { position: [1, 0, 0] },
      [BOLT]: { position: [0, 2, 0] },
    });
  });

  it('returns the SAME scene for a move that changes nothing', () => {
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] } } }));

    expect(applySceneUpdate(scene, {
      op: 'setPartTransform',
      id: ID_A,
      nodeId: FLANGE,
      transform: { position: [1, 0, 0] },
    })).toBe(scene);
  });

  it('returns the SAME scene for a model that is not there', () => {
    const scene = sceneOf(modelA());
    expect(applySceneUpdate(scene, {
      op: 'setPartTransform',
      id: 'model-nobody',
      nodeId: FLANGE,
      transform: { position: [1, 0, 0] },
    })).toBe(scene);
  });

  it('stops at the cap, so the two callers of this reducer cannot disagree about what a scene may hold', () => {
    const parts: Record<string, { position: [number, number, number] }> = {};
    for (let i = 0; i < MAX_SCENE_PARTS; i += 1) parts[`${PREFIX_A}_${i}`] = { position: [i, 0, 0] };
    const scene = sceneOf(modelA({ parts }));

    const refused = applySceneUpdate(scene, {
      op: 'setPartTransform',
      id: ID_A,
      nodeId: `${PREFIX_A}_over`,
      transform: { position: [1, 0, 0] },
    });
    expect(refused).toBe(scene);
    expect(Object.keys(refused.models[0].parts ?? {})).toHaveLength(MAX_SCENE_PARTS);

    // A part that is ALREADY there is a change to it, not a 501st entry, so it still
    // applies: the cap is on how many parts a model may carry, not on editing them.
    const changed = applySceneUpdate(scene, {
      op: 'setPartTransform',
      id: ID_A,
      nodeId: `${PREFIX_A}_0`,
      transform: { position: [9, 9, 9] },
    });
    expect(changed.models[0].parts?.[`${PREFIX_A}_0`]).toEqual({ position: [9, 9, 9] });
  });
});

describe('applySceneUpdate — resetting', () => {
  it('deletes one part\'s override, which is what "Reset part" sends', () => {
    const scene = sceneOf(modelA({
      parts: { [FLANGE]: { position: [1, 0, 0] }, [BOLT]: { position: [0, 2, 0] } },
    }));

    const next = applySceneUpdate(scene, { op: 'setPartTransform', id: ID_A, nodeId: FLANGE, transform: null });

    expect(next.models[0].parts).toEqual({ [BOLT]: { position: [0, 2, 0] } });
  });

  it('drops the field entirely when the last override goes, rather than storing an empty record', () => {
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] } } }));

    const next = applySceneUpdate(scene, { op: 'setPartTransform', id: ID_A, nodeId: FLANGE, transform: null });

    // "Absent means the file's own transform" is the single rule, and a stored `{}`
    // would be a second way of saying it that every reader would have to know about.
    expect(next.models[0].parts).toBeUndefined();
    expect(hasPartTransforms(next.models[0])).toBe(false);
  });

  it('returns the SAME scene when the part was already where its file had it', () => {
    const scene = sceneOf(modelA());
    expect(applySceneUpdate(scene, { op: 'setPartTransform', id: ID_A, nodeId: FLANGE, transform: null })).toBe(scene);

    const withParts = sceneOf(modelA({ parts: { [BOLT]: { position: [0, 2, 0] } } }));
    expect(applySceneUpdate(withParts, { op: 'setPartTransform', id: ID_A, nodeId: FLANGE, transform: null })).toBe(withParts);
  });

  it('clears every part of one model and no other model\'s', () => {
    const other: SceneModel = {
      id: sceneModelId(HASH_B),
      hash: HASH_B,
      fileName: 'mating-part.step',
      line: 'mating-part',
      revision: 'A',
      visible: true,
      offset: [3, 0, 0],
      parts: { [`${sceneModelPrefix(HASH_B)}_1`]: { position: [0, 1, 0] } },
    };
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] }, [BOLT]: { position: [0, 2, 0] } } }), other);

    const next = applySceneUpdate(scene, { op: 'clearPartTransforms', id: ID_A });

    expect(next.models[0].parts).toBeUndefined();
    expect(next.models[1].parts).toEqual(other.parts);
  });

  it('returns the SAME scene for a model with nothing to clear', () => {
    const scene = sceneOf(modelA());
    expect(applySceneUpdate(scene, { op: 'clearPartTransforms', id: ID_A })).toBe(scene);
    expect(applySceneUpdate(scene, { op: 'clearPartTransforms', id: 'model-nobody' })).toBe(scene);
  });
});

describe('a scene written before batch BR', () => {
  it('is unchanged by everything a model move does to it', () => {
    const scene = sceneOf(modelA());

    const moved = applySceneUpdate(scene, {
      op: 'setTransform',
      id: ID_A,
      transform: { offset: [4, 0, 0], rotation: [0, 1, 0], scale: 2 },
    });

    expect(moved.models[0].parts).toBeUndefined();
    expect(hasPartTransforms(moved.models[0])).toBe(false);
    expect(moved.models[0].offset).toEqual([4, 0, 0]);
  });

  it('keeps its moved parts when the WHOLE model is then moved', () => {
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] } } }));

    const moved = applySceneUpdate(scene, {
      op: 'setTransform',
      id: ID_A,
      transform: { offset: [4, 0, 0], rotation: [0, 0, 0], scale: 1 },
    });

    // A part's override is in the node's own local space, so pulling the product
    // across the room takes its pulled-apart flange with it — which is the answer a
    // person who did both means by doing both.
    expect(moved.models[0].parts).toEqual({ [FLANGE]: { position: [1, 0, 0] } });
    expect(moved.models[0].offset).toEqual([4, 0, 0]);
  });

  it('is unchanged by a hide, a removal and a built-in choice', () => {
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] } } }));

    expect(applySceneUpdate(scene, { op: 'setVisible', id: ID_A, visible: false }).models[0].parts)
      .toEqual({ [FLANGE]: { position: [1, 0, 0] } });
    expect(applySceneUpdate(scene, { op: 'setOffset', id: ID_A, offset: [2, 0, 0] }).models[0].parts)
      .toEqual({ [FLANGE]: { position: [1, 0, 0] } });
  });
});

describe('a new revision of a model', () => {
  /**
   * What the import flow builds, and the reason it starts clean: a fresh object
   * literal with the fields an import knows, and no spread of the revision it
   * supersedes. Rev B is a different FILE, so none of Rev A's node ids can name a
   * node of it — carrying them over would have moved arbitrary geometry of the new
   * file by accident.
   */
  function newRevisionOf(scene: RoomScene, hash: string, line: string): SceneModel {
    return {
      id: sceneModelId(hash),
      hash,
      fileName: `${line}-rev-b.step`,
      line,
      revision: 'B',
      visible: true,
      offset: scene.models.find((m) => m.line === line)?.offset ?? [0, 0, 0],
    };
  }

  it('starts with no part overrides, whatever the revision it follows had', () => {
    const scene = sceneOf(modelA({ parts: { [FLANGE]: { position: [1, 0, 0] } } }));
    const revB = newRevisionOf(scene, HASH_B, 'bracket');

    const next = applySceneUpdate(scene, { op: 'add', model: revB });

    expect(next.models).toHaveLength(2);
    expect(next.models[1].parts).toBeUndefined();
    expect(hasPartTransforms(next.models[1])).toBe(false);
    // And Rev A keeps its own: it is still in the scene, hidden by the import flow
    // but there, because Compare needs it and the older cards point at it.
    expect(next.models[0].parts).toEqual({ [FLANGE]: { position: [1, 0, 0] } });
  });

  it('cannot be reached by the old revision\'s node ids, which come from the file\'s hash', () => {
    const revB = newRevisionOf(sceneOf(modelA()), HASH_B, 'bracket');

    expect(sceneModelForNode([modelA(), revB], FLANGE)?.id).toBe(ID_A);
    expect(sceneModelForNode([modelA(), revB], `${sceneModelPrefix(HASH_B)}_3`)?.id).toBe(revB.id);
  });
});

describe('the comparisons', () => {
  it('samePartTransform compares what is written, field by field', () => {
    expect(samePartTransform({ position: [1, 2, 3] }, { position: [1, 2, 3] })).toBe(true);
    expect(samePartTransform({ position: [1, 2, 3] }, { position: [1, 2, 4] })).toBe(false);
    expect(samePartTransform({ position: [1, 2, 3] }, { position: [1, 2, 3], scale: [1, 1, 1] })).toBe(false);
    expect(samePartTransform({}, {})).toBe(true);
    expect(samePartTransform({ scale: [2, 1, 0.5] }, { scale: [2, 1, 0.5] })).toBe(true);
  });

  it('samePartTransforms reads an absent set and an empty one as the same thing', () => {
    expect(samePartTransforms(undefined, undefined)).toBe(true);
    expect(samePartTransforms(undefined, {})).toBe(true);
    expect(samePartTransforms(null, {})).toBe(true);
    expect(samePartTransforms({ [FLANGE]: { position: [1, 0, 0] } }, undefined)).toBe(false);
    expect(samePartTransforms(
      { [FLANGE]: { position: [1, 0, 0] }, [BOLT]: { scale: [2, 2, 2] } },
      { [BOLT]: { scale: [2, 2, 2] }, [FLANGE]: { position: [1, 0, 0] } },
    )).toBe(true);
    expect(samePartTransforms(
      { [FLANGE]: { position: [1, 0, 0] } },
      { [FLANGE]: { position: [1, 0, 0] }, [BOLT]: { scale: [2, 2, 2] } },
    )).toBe(false);
  });

  it('sceneModelForNode answers nothing for an empty scene', () => {
    expect(sceneModelForNode(emptyScene().models, FLANGE)).toBeNull();
  });
});
