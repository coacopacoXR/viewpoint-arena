// Moved parts ride the review's own copy of the placement — batch BR.
//
// Batch BI gave every model a second copy of where it stands, written into the
// review's `asset.placements`, because room storage is the ROOM's and a review is
// opened again long after that room is gone. A part override is the same fact at a
// smaller scale and needs the same second copy: without it, "Reset part" would have
// been the only change to a model that ever reached the review, and a bracket whose
// flange was pulled out to show a clearance would have come back closed.
//
// Keyed by (line, revision) like everything else in a StoredPlacement, which is what
// makes "a new revision starts with no part overrides" true of the stored copy too.

import { describe, it, expect } from 'vitest';
import {
  applyStoredPlacements,
  placementsFromScene,
  samePlacements,
} from '../placement';
import {
  sceneModelId,
  sceneModelPrefix,
  type PartTransforms,
  type RoomScene,
  type SceneModel,
} from '../roomScene';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const PREFIX_A = sceneModelPrefix(HASH_A);
const PREFIX_B = sceneModelPrefix(HASH_B);
const FLANGE = `${PREFIX_A}_3`;

function model(hash: string, line: string, revision: string, overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    id: sceneModelId(hash),
    hash,
    fileName: `${line}.step`,
    line,
    revision,
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

const PARTS: PartTransforms = { [FLANGE]: { position: [1, 0, 0], scale: [2, 1, 1] } };

describe('placementsFromScene', () => {
  it('remembers a model whose parts were moved even when the model itself never moved', () => {
    // The identity check is about the model's OWN transform. Without a second
    // condition beside it, a pulled-apart assembly standing at the origin — the
    // commonest case there is, because nobody dragged it anywhere — would have been
    // thrown away on the way to the review.
    const stored = placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: PARTS })]);

    expect(stored).toEqual([{
      line: 'bracket',
      revision: 'A',
      offset: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
      parts: PARTS,
    }]);
  });

  it('remembers the model\'s transform and its parts together', () => {
    const stored = placementsFromScene([
      model(HASH_A, 'bracket', 'A', { offset: [4, 0, 0], rotation: [0, 1, 0], scale: 2, parts: PARTS }),
    ]);

    expect(stored[0].offset).toEqual([4, 0, 0]);
    expect(stored[0].rotation).toEqual([0, 1, 0]);
    expect(stored[0].scale).toBe(2);
    expect(stored[0].parts).toEqual(PARTS);
  });

  it('leaves the field out for a model nobody moved a part of, rather than storing an empty record', () => {
    const stored = placementsFromScene([model(HASH_A, 'bracket', 'A', { offset: [4, 0, 0] })]);

    expect(stored).toHaveLength(1);
    expect('parts' in stored[0]).toBe(false);
  });

  it('still stores nothing at all for a scene nobody touched', () => {
    expect(placementsFromScene([model(HASH_A, 'bracket', 'A')])).toEqual([]);
    expect(placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: {} })])).toEqual([]);
  });
});

describe('applyStoredPlacements', () => {
  it('puts the moved parts back on the model they belong to', () => {
    const scene: RoomScene = { models: [model(HASH_A, 'bracket', 'A')], builtIn: null };
    const stored = placementsFromScene([model(HASH_A, 'bracket', 'A', { offset: [4, 0, 0], parts: PARTS })]);

    const next = applyStoredPlacements(scene, stored);

    expect(next.models[0].offset).toEqual([4, 0, 0]);
    expect(next.models[0].parts).toEqual(PARTS);
  });

  it('returns the SAME scene when it would change nothing, parts included', () => {
    const scene: RoomScene = { models: [model(HASH_A, 'bracket', 'A', { parts: PARTS })], builtIn: null };
    const stored = placementsFromScene(scene.models);

    expect(applyStoredPlacements(scene, stored)).toBe(scene);
  });

  it('sees a difference in the parts as a difference worth a new scene', () => {
    const scene: RoomScene = { models: [model(HASH_A, 'bracket', 'A')], builtIn: null };
    const stored = placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: PARTS })]);

    expect(applyStoredPlacements(scene, stored)).not.toBe(scene);
  });

  it('does not carry one revision\'s parts onto another', () => {
    // Rev B is a different file, whose node ids come from a different hash. A stored
    // placement matches on (line, revision), so Rev A's override cannot reach it —
    // and if it did it would move arbitrary geometry of the new file by accident.
    const scene: RoomScene = {
      models: [model(HASH_A, 'bracket', 'A'), model(HASH_B, 'bracket', 'B')],
      builtIn: null,
    };
    const stored = placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: PARTS })]);

    const next = applyStoredPlacements(scene, stored);

    expect(next.models[0].parts).toEqual(PARTS);
    expect(next.models[1].parts).toBeUndefined();
  });

  it('leaves a model alone when the review stored no placement for it', () => {
    const scene: RoomScene = { models: [model(HASH_B, 'mating-part', 'A')], builtIn: null };
    const stored = placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: PARTS })]);

    expect(applyStoredPlacements(scene, stored)).toBe(scene);
  });
});

describe('samePlacements — a parts-only change is a change', () => {
  const moved = placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: PARTS })]);
  const still = placementsFromScene([model(HASH_A, 'bracket', 'A')]);

  it('answers false, which is what marks the review edited and gets it saved', () => {
    expect(samePlacements(moved, still)).toBe(false);
    expect(samePlacements(still, moved)).toBe(false);
  });

  it('answers true for the same parts, however they are written', () => {
    expect(samePlacements(moved, placementsFromScene([model(HASH_A, 'bracket', 'A', { parts: { ...PARTS } })]))).toBe(true);
    expect(samePlacements(still, undefined)).toBe(true);
    expect(samePlacements(undefined, null)).toBe(true);
  });

  it('answers false when one part of the set differs', () => {
    const elsewhere = placementsFromScene([
      model(HASH_A, 'bracket', 'A', { parts: { [FLANGE]: { position: [9, 9, 9], scale: [2, 1, 1] } } }),
    ]);
    expect(samePlacements(moved, elsewhere)).toBe(false);
  });

  it('answers false when a second part was moved', () => {
    const more = placementsFromScene([
      model(HASH_A, 'bracket', 'A', { parts: { ...PARTS, [`${PREFIX_B}_1`]: { position: [0, 1, 0] } } }),
    ]);
    expect(samePlacements(moved, more)).toBe(false);
  });
});
