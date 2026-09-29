// A scene model's rotation and scale survive the wire.
//
// Batch BI found them being dropped. `asSceneUpdate`'s setTransform carries an
// offset, a rotation AND a scale; the room server applies all three to its single
// copy and persists all three; and `asSceneModel` — the function that reads a scene
// back off the wire, both from a SCENE_STATE relay and from the server's own
// storage after a restart — rebuilt the model from the offset alone.
//
// So a model somebody turned round or resized with the amber strip's tools arrived
// at every other participant unturned, and came back unturned to everybody after a
// container restart. The drag appeared to work, because the person dragging had
// applied it locally, which is the worst shape for this kind of bug.

import { describe, it, expect } from 'vitest';
import { asRoomScene, asSceneModel } from '../sceneWire';

const HASH = 'a1'.repeat(32);

function wireModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'model-1',
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [1, 0, 2],
    ...overrides,
  };
}

describe('asSceneModel — the transform it carries', () => {
  it('keeps a rotation and a scale', () => {
    const parsed = asSceneModel(wireModel({ rotation: [0, 1.5708, 0], scale: 2.5 }));

    expect(parsed).not.toBeNull();
    expect(parsed?.offset).toEqual([1, 0, 2]);
    expect(parsed?.rotation).toEqual([0, 1.5708, 0]);
    expect(parsed?.scale).toBe(2.5);
  });

  it('leaves both OUT when the record has neither, rather than writing an identity', () => {
    // "Absent means identity" is the one rule SceneModel's optional rotation and
    // scale follow, and sceneModelTransform fills the defaults in. Rescuing a
    // missing field into [0,0,0] and 1 would make every model in every scene look
    // changed to a comparison that works field by field.
    const parsed = asSceneModel(wireModel());

    expect(parsed).not.toBeNull();
    expect(parsed && 'rotation' in parsed).toBe(false);
    expect(parsed && 'scale' in parsed).toBe(false);
  });

  it('refuses a rotation that is not three finite numbers, and keeps the rest of the model', () => {
    for (const rotation of [[0, 1], [0, NaN, 0], ['0', '0', '0'], 3, null, {}]) {
      const parsed = asSceneModel(wireModel({ rotation, scale: 2 }));
      expect(parsed?.rotation).toBeUndefined();
      // The scale beside it is still good, and dropping the whole model over one
      // unreadable field would take a product off everybody's screen.
      expect(parsed?.scale).toBe(2);
    }
  });

  it('refuses a scale the renderer could not use', () => {
    // Zero and negative are refused rather than rescued, exactly as asSceneUpdate's
    // setTransform refuses them: a model scaled to nothing is invisible and a
    // negatively scaled one is inside out, and neither is a placement anybody meant.
    for (const scale of [0, -1, NaN, Infinity, '2', null]) {
      const parsed = asSceneModel(wireModel({ rotation: [0, 1, 0], scale }));
      expect(parsed?.scale).toBeUndefined();
      expect(parsed?.rotation).toEqual([0, 1, 0]);
    }
  });
});

describe('asRoomScene — a whole scene with placements in it', () => {
  it('keeps every model\'s transform, which is what a restart restores from', () => {
    const parsed = asRoomScene({
      models: [
        wireModel(),
        wireModel({ id: 'model-2', hash: 'b2'.repeat(32), revision: 'B', offset: [4, 0, 0], rotation: [0, 0, 3.14], scale: 0.5 }),
      ],
      builtIn: null,
    });

    expect(parsed?.models).toHaveLength(2);
    expect(parsed?.models[0].rotation).toBeUndefined();
    expect(parsed?.models[1].rotation).toEqual([0, 0, 3.14]);
    expect(parsed?.models[1].scale).toBe(0.5);
    expect(parsed?.builtIn).toBeNull();
  });
});
