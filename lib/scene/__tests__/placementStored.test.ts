// The placement a review keeps — batch BI's third section.
//
// Move / Rotate / Scale in the room's Edit mode write a SceneModel's transform,
// and the room server persists that with its scene. Room storage is the ROOM's,
// though, and a review is opened again long after that room is gone. These three
// functions are the whole of the review's copy: what to remember, how to put it
// back, and whether remembering it would be a change at all.
//
// Where the copy lives, and why it is not a column on model_revisions, is written
// at the top of lib/scene/placement.ts.

import { describe, it, expect } from 'vitest';
import {
  applyStoredPlacements,
  placementsFromScene,
  samePlacements,
  type StoredPlacement,
} from '../placement';
import type { RoomScene, SceneModel } from '../roomScene';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

function model(overrides: Partial<SceneModel> = {}): SceneModel {
  return {
    id: `model-${HASH_A.slice(0, 8)}`,
    hash: HASH_A,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

function scene(models: SceneModel[]): RoomScene {
  return { models, builtIn: null };
}

function placement(overrides: Partial<StoredPlacement> = {}): StoredPlacement {
  return {
    line: 'bracket',
    revision: 'A',
    offset: [3, 0, -1],
    rotation: [0, 1.5708, 0],
    scale: 1.5,
    ...overrides,
  };
}

describe('placementsFromScene — what is worth remembering', () => {
  it('remembers nothing for a scene nobody has moved', () => {
    // Absent means "where the room put it", which is the same rule SceneModel's
    // optional rotation and scale already follow. A review that has only ever
    // imported files therefore stores an empty list rather than a list of
    // identities, and the jsonb stays small however many models it has been
    // through.
    expect(placementsFromScene([model(), model({ hash: HASH_B, revision: 'B' })])).toEqual([]);
  });

  it('remembers a model that was moved, turned or resized, keyed by its revision', () => {
    const stored = placementsFromScene([
      model(),
      model({ id: 'model-b', hash: HASH_B, revision: 'B', offset: [4, 0, 0] }),
    ]);

    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ line: 'bracket', revision: 'B', offset: [4, 0, 0] });
    // The transform is the FILLED-IN one, so a reader never has to re-derive
    // "absent means identity" from a stored record.
    expect(stored[0].rotation).toEqual([0, 0, 0]);
    expect(stored[0].scale).toBe(1);
  });

  it('remembers a rotation and a scale with no offset at all', () => {
    const stored = placementsFromScene([model({ rotation: [0, 0, 3.14], scale: 2 })]);
    expect(stored).toHaveLength(1);
    expect(stored[0].rotation).toEqual([0, 0, 3.14]);
    expect(stored[0].scale).toBe(2);
  });

  it('remembers an empty scene as nothing', () => {
    expect(placementsFromScene([])).toEqual([]);
  });
});

describe('applyStoredPlacements — putting it back', () => {
  it('restores a placement onto the revision it was written for', () => {
    const restored = applyStoredPlacements(scene([model()]), [placement()]);
    expect(restored.models[0].offset).toEqual([3, 0, -1]);
    expect(restored.models[0].rotation).toEqual([0, 1.5708, 0]);
    expect(restored.models[0].scale).toBe(1.5);
  });

  it('leaves the other revisions of the same line where they are', () => {
    // Per revision is the whole point: the room discussed Rev B and moved it out
    // of the way, and Rev A — hidden behind it, still reachable through Compare —
    // must not have moved with it.
    const restored = applyStoredPlacements(
      scene([model({ visible: false }), model({ id: 'model-b', hash: HASH_B, revision: 'B' })]),
      [placement({ revision: 'B', offset: [9, 0, 0] })],
    );

    expect(restored.models[0].offset).toEqual([0, 0, 0]);
    expect(restored.models[0].rotation).toBeUndefined();
    expect(restored.models[1].offset).toEqual([9, 0, 0]);
  });

  it('matches the letter case-insensitively, the way revisionsOnScreen does', () => {
    const restored = applyStoredPlacements(scene([model({ revision: 'b' })]), [placement({ revision: 'B' })]);
    expect(restored.models[0].offset).toEqual([3, 0, -1]);
  });

  it('drops a placement whose revision this scene does not hold', () => {
    // A revision that fell off MAX_SCENE_MODELS, or a review whose history and
    // whose room have diverged. Inventing a model for it would put a file on
    // screen nobody asked to fetch.
    const restored = applyStoredPlacements(scene([model()]), [placement({ revision: 'Z' })]);
    expect(restored.models).toHaveLength(1);
    expect(restored.models[0].offset).toEqual([0, 0, 0]);
  });

  it('answers the SAME scene object when nothing in it changes', () => {
    const original = scene([model({ offset: [3, 0, -1], rotation: [0, 1.5708, 0], scale: 1.5 })]);

    expect(applyStoredPlacements(original, [placement()])).toBe(original);
    expect(applyStoredPlacements(original, [])).toBe(original);
    expect(applyStoredPlacements(original, undefined)).toBe(original);
    expect(applyStoredPlacements(original, null)).toBe(original);
    expect(applyStoredPlacements({ models: [], builtIn: null }, [placement()])).toEqual({ models: [], builtIn: null });
  });

  it('does not treat restoring identity onto an untouched model as a change', () => {
    // A model that has never been turned has no rotation field at all. Writing
    // [0,0,0] onto it would be a new scene object for nothing, and every caller
    // that compares by identity — the room server deciding whether to relay, the
    // store deciding whether to adopt — would do work for a scene that looks the
    // same.
    const original = scene([model()]);
    const restored = applyStoredPlacements(original, [
      placement({ offset: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }),
    ]);
    expect(restored).toBe(original);
  });
});

describe('samePlacements — whether remembering it would be a change', () => {
  it('says yes for two lists that mean the same thing in a different order', () => {
    // The list is rebuilt from a scene every time, and a scene's model order is
    // the order additions arrived in — which a Compare, a removal and a re-import
    // all change without anybody moving anything.
    const a = [placement({ revision: 'A' }), placement({ revision: 'B', offset: [4, 0, 0] })];
    const b = [placement({ revision: 'B', offset: [4, 0, 0] }), placement({ revision: 'A' })];
    expect(samePlacements(a, b)).toBe(true);
  });

  it('treats absent and empty as the same answer', () => {
    expect(samePlacements(undefined, [])).toBe(true);
    expect(samePlacements(null, undefined)).toBe(true);
    expect(samePlacements([], [placement()])).toBe(false);
  });

  it('says no when a placement moved, turned or resized', () => {
    const a = [placement()];
    expect(samePlacements(a, [placement({ offset: [3.5, 0, -1] })])).toBe(false);
    expect(samePlacements(a, [placement({ rotation: [0, 0, 0] })])).toBe(false);
    expect(samePlacements(a, [placement({ scale: 2 })])).toBe(false);
  });

  it('says no when a revision was added or taken away', () => {
    expect(samePlacements([placement()], [placement({ revision: 'B' })])).toBe(false);
    expect(samePlacements([placement()], [placement(), placement({ revision: 'B' })])).toBe(false);
  });

  it('matches the letter case-insensitively, like applyStoredPlacements does', () => {
    expect(samePlacements([placement({ revision: 'b' })], [placement({ revision: 'B' })])).toBe(true);
  });
});
