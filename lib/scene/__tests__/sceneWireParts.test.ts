// A moved part survives the wire — and a malformed one is refused.
//
// Batch BR. SceneModel grew an optional `parts`, and the two functions that read a
// scene off an untrusted socket grew a decision about it. They answer differently,
// and on purpose:
//
//   asSceneUpdate REJECTS a malformed part entry outright, so the room server sends
//   'unreadable-update' and changes nothing for anybody. The sender is still there
//   to be told, and half-applying a move would leave the person who dragged a part
//   looking at it where they put it while everybody else looked at it where it was.
//
//   asSceneModel DROPS unreadable parts and keeps the model, because it is also the
//   function that restores a scene from the server's own storage — and dropping a
//   whole product over one bad part entry would empty a room in the middle of a
//   review. That is asRoomScene's existing rule for a bad model, applied one level
//   down.
//
// Both refuse the same shapes, which is what the cap and the finite-number checks
// below are for: the scene is persisted whole and replayed to every connection that
// joins, so without them a client could grow room storage without bound.

import { describe, it, expect } from 'vitest';
import { asPartTransform, asPartTransforms, asRoomScene, asSceneModel, asSceneUpdate } from '../sceneWire';
import { MAX_PART_NODE_ID, MAX_SCENE_PARTS } from '../roomScene';

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

describe('asPartTransform', () => {
  it('keeps all three fields of a well-formed override', () => {
    expect(asPartTransform({ position: [1, 2, 3], rotation: [0, 1.5708, 0], scale: [2, 1, 0.5] })).toEqual({
      position: [1, 2, 3],
      rotation: [0, 1.5708, 0],
      scale: [2, 1, 0.5],
    });
  });

  it('keeps one field on its own, because a part moved and not resized is the common case', () => {
    expect(asPartTransform({ position: [1, 2, 3] })).toEqual({ position: [1, 2, 3] });
    expect(asPartTransform({ rotation: [0, 0, 1] })).toEqual({ rotation: [0, 0, 1] });
    expect(asPartTransform({ scale: [1, 1, 1] })).toEqual({ scale: [1, 1, 1] });
  });

  it('allows a non-uniform scale, which the model\'s own single number may not be', () => {
    expect(asPartTransform({ scale: [3, 0.25, 1] })).toEqual({ scale: [3, 0.25, 1] });
  });

  it('refuses an override with nothing in it', () => {
    // A record that changes nothing would be persisted and replayed for ever, and
    // the only client that sends one is a client that is broken.
    expect(asPartTransform({})).toBeNull();
  });

  it('refuses numbers the renderer could not use', () => {
    for (const position of [[1, 2], [1, NaN, 3], ['1', '2', '3'], 3, null]) {
      expect(asPartTransform({ position })).toBeNull();
    }
    // Zero would flatten the part for everybody in the room and a negative one would
    // turn it inside out — asSceneUpdate's setTransform has refused both for a model
    // since batch BI, and a part is the same objection.
    for (const scale of [[1, 0, 1], [-1, 1, 1], [Infinity, 1, 1], [1, 2], 2]) {
      expect(asPartTransform({ scale })).toBeNull();
    }
  });

  it('refuses something that is not an object', () => {
    for (const value of [3, 'no', null, undefined, [1, 2, 3]]) {
      expect(asPartTransform(value)).toBeNull();
    }
  });
});

describe('asPartTransforms', () => {
  it('answers undefined for a record with no parts, which is every record written before batch BR', () => {
    expect(asPartTransforms(undefined)).toBeUndefined();
    expect(asPartTransforms(null)).toBeUndefined();
    // And an empty record reads as absent rather than as a stored `{}`, so "has
    // anybody moved a part here" stays a `!== undefined` question everywhere.
    expect(asPartTransforms({})).toBeUndefined();
  });

  it('rebuilds a whole set, keyed by node id', () => {
    expect(asPartTransforms({ m1_2: { position: [1, 0, 0] }, m1_7: { scale: [2, 2, 2] } })).toEqual({
      m1_2: { position: [1, 0, 0] },
      m1_7: { scale: [2, 2, 2] },
    });
  });

  it('refuses more entries than one model may carry', () => {
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_SCENE_PARTS; i += 1) tooMany[`m1_${i}`] = { position: [i, 0, 0] };
    expect(asPartTransforms(tooMany)).toBeNull();

    delete tooMany[`m1_${MAX_SCENE_PARTS}`];
    expect(Object.keys(tooMany)).toHaveLength(MAX_SCENE_PARTS);
    expect(asPartTransforms(tooMany)).not.toBeNull();
  });

  it('refuses a node id this app could not have minted', () => {
    expect(asPartTransforms({ '': { position: [1, 0, 0] } })).toBeNull();
    expect(asPartTransforms({ ['x'.repeat(MAX_PART_NODE_ID + 1)]: { position: [1, 0, 0] } })).toBeNull();
    expect(asPartTransforms({ ['x'.repeat(MAX_PART_NODE_ID)]: { position: [1, 0, 0] } })).not.toBeNull();
  });

  it('refuses the WHOLE set when one entry of it is unreadable', () => {
    // Not the model's rule: an entry quietly dropped would leave the person who
    // moved that part looking at it where they put it and everybody else looking at
    // it where it was, with nothing on either screen to say the two differ.
    expect(asPartTransforms({ m1_2: { position: [1, 0, 0] }, m1_7: { position: [NaN, 0, 0] } })).toBeNull();
    expect(asPartTransforms({ m1_2: { position: [1, 0, 0] }, m1_7: 'over there' })).toBeNull();
  });

  it('refuses something that is not a record of them', () => {
    expect(asPartTransforms([{ position: [1, 0, 0] }])).toBeNull();
    expect(asPartTransforms(7)).toBeNull();
  });
});

describe('asSceneUpdate — the two new operations', () => {
  it('reads a part being moved', () => {
    expect(asSceneUpdate({
      op: 'setPartTransform',
      id: 'model-1',
      nodeId: 'ma1a1a1a1_3',
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })).toEqual({
      op: 'setPartTransform',
      id: 'model-1',
      nodeId: 'ma1a1a1a1_3',
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
  });

  it('reads a null transform as "Reset part", which is a perfectly good operation', () => {
    expect(asSceneUpdate({ op: 'setPartTransform', id: 'model-1', nodeId: 'm1_3', transform: null })).toEqual({
      op: 'setPartTransform',
      id: 'model-1',
      nodeId: 'm1_3',
      transform: null,
    });
  });

  it('reads "Reset all parts"', () => {
    expect(asSceneUpdate({ op: 'clearPartTransforms', id: 'model-1' })).toEqual({
      op: 'clearPartTransforms',
      id: 'model-1',
    });
    expect(asSceneUpdate({ op: 'clearPartTransforms', id: '' })).toBeNull();
    expect(asSceneUpdate({ op: 'clearPartTransforms' })).toBeNull();
  });

  it('rejects a malformed part entry rather than applying half of it', () => {
    for (const transform of [
      { position: [1, 2] },
      { position: [1, NaN, 3] },
      { scale: [1, 0, 1] },
      { scale: [1, -2, 1] },
      {},
      'moved',
      7,
      undefined,
      [{ position: [1, 2, 3] }],
    ]) {
      expect(asSceneUpdate({ op: 'setPartTransform', id: 'model-1', nodeId: 'm1_3', transform })).toBeNull();
    }
  });

  it('rejects a node id the server would have to store and replay', () => {
    for (const nodeId of ['', 7, null, undefined, 'x'.repeat(MAX_PART_NODE_ID + 1)]) {
      expect(asSceneUpdate({
        op: 'setPartTransform',
        id: 'model-1',
        nodeId,
        transform: { position: [1, 2, 3] },
      })).toBeNull();
    }
  });

  it('rejects a move with no model to move it on', () => {
    expect(asSceneUpdate({ op: 'setPartTransform', id: '', nodeId: 'm1_3', transform: { position: [1, 2, 3] } })).toBeNull();
    expect(asSceneUpdate({ op: 'setPartTransform', nodeId: 'm1_3', transform: { position: [1, 2, 3] } })).toBeNull();
  });

  it('still rejects an operation it has never heard of, which is what an updated client sends an old server', () => {
    expect(asSceneUpdate({ op: 'setPartTransforms', id: 'model-1' })).toBeNull();
  });
});

describe('asSceneModel — the parts it carries', () => {
  it('keeps them, which is what a restart restores from', () => {
    const parsed = asSceneModel(wireModel({ parts: { m1_3: { position: [1, 0, 0] } } }));

    expect(parsed?.parts).toEqual({ m1_3: { position: [1, 0, 0] } });
  });

  it('leaves the field OUT when the record has none, rather than writing an empty record', () => {
    // "Absent means the file's own transform" is the single rule SceneModel's
    // optionals follow, and it is what every model written before this batch means.
    const parsed = asSceneModel(wireModel());

    expect(parsed).not.toBeNull();
    expect(parsed && 'parts' in parsed).toBe(false);
  });

  it('drops unreadable parts and KEEPS the model', () => {
    // The opposite of asSceneUpdate, for the reason given at the top of this file:
    // this is also the storage-restore path, and a product taken off everybody's
    // screen in the middle of a review is not a recoverable mistake.
    const parsed = asSceneModel(wireModel({
      scale: 2,
      parts: { m1_3: { position: [1, 0, 0] }, m1_9: { scale: [0, 1, 1] } },
    }));

    expect(parsed?.parts).toBeUndefined();
    expect(parsed?.scale).toBe(2);
  });

  it('drops a part set too large to be a scene anybody built', () => {
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_SCENE_PARTS; i += 1) tooMany[`m1_${i}`] = { position: [i, 0, 0] };
    const parsed = asSceneModel(wireModel({ parts: tooMany }));

    expect(parsed).not.toBeNull();
    expect(parsed?.parts).toBeUndefined();
  });
});

describe('asRoomScene — a scene with moved parts in it', () => {
  it('keeps every model\'s parts, and every model that has none', () => {
    const parsed = asRoomScene({
      models: [
        wireModel(),
        wireModel({
          id: 'model-2',
          hash: 'b2'.repeat(32),
          revision: 'B',
          parts: { m2_1: { position: [0, 4, 0], scale: [1, 2, 1] } },
        }),
      ],
      builtIn: null,
    });

    expect(parsed?.models).toHaveLength(2);
    expect(parsed?.models[0].parts).toBeUndefined();
    expect(parsed?.models[1].parts).toEqual({ m2_1: { position: [0, 4, 0], scale: [1, 2, 1] } });
  });
});
