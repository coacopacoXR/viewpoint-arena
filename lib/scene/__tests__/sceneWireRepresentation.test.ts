// Which encoding of a model file a reference says to load, read off the wire.
//
// Task 03c. A CAD file has two possible representations — the bytes that were
// uploaded, and the GLB convert-service tessellated from them — and they are NOT
// the same tree: `buildSceneTree` numbers nodes positionally, so the two mint
// different ids for the same flange. A node id is what a pin, a comment, a
// selection and a moved part all name.
//
// So the importer decides once and the reference carries the decision, which
// makes `asSceneModel` the function that has to not lose it. This is the same
// shape of bug batch BI found with rotation and scale: applied locally, relayed,
// persisted, and then dropped on the read-back — so the drag looked like it
// worked on the screen that made it and nowhere else.
//
// The other half of the contract is the absent field. Every scene persisted
// before a deployment could run convert-service has no representation, and every
// one of them has to keep meaning "fetch the file that was uploaded".

import { describe, it, expect } from 'vitest';
import { asRepresentation, asRoomScene, asSceneModel, sceneFromLegacyReference } from '../sceneWire';
import { DEFAULT_REPRESENTATION, sceneModelRepresentation } from '../roomScene';

const HASH = 'a1'.repeat(32);

function wireModel(overrides: Record<string, unknown> = {}) {
  return {
    id: `model-${HASH}`,
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    offset: [0, 0, 0],
    ...overrides,
  };
}

describe('asRepresentation', () => {
  it('reads the two values a reference may carry', () => {
    expect(asRepresentation('source')).toBe('source');
    expect(asRepresentation('derived-glb')).toBe('derived-glb');
  });

  it('refuses anything else, so a string nobody wrote cannot pick a loader', () => {
    // The field decides which reader utils/modelLoader.ts hands the bytes to, so
    // an invented value would arrive there as an unknown extension and cost the
    // room a model rather than costing it a fallback.
    expect(asRepresentation('glb')).toBeNull();
    expect(asRepresentation('')).toBeNull();
    expect(asRepresentation(true)).toBeNull();
    expect(asRepresentation(1)).toBeNull();
    expect(asRepresentation({})).toBeNull();
    expect(asRepresentation(undefined)).toBeNull();
    expect(asRepresentation(null)).toBeNull();
  });
});

describe('asSceneModel and representation', () => {
  it('keeps a derivative a derivative, which is the whole point of the field', () => {
    const model = asSceneModel(wireModel({ representation: 'derived-glb' }));
    expect(model?.representation).toBe('derived-glb');
    expect(sceneModelRepresentation(model!)).toBe('derived-glb');
  });

  it('reads a reference that says "source" as one', () => {
    const model = asSceneModel(wireModel({ representation: 'source' }));
    expect(model?.representation).toBe('source');
  });

  it('leaves the field OUT of a reference that has none, rather than writing a default in', () => {
    // Read-back from the room server's own storage goes through this function,
    // so filling the field in here would rewrite every scene an older build
    // persisted on the first read of it — a write-shaped change on a read path.
    // "Absent means the source file" lives in sceneModelRepresentation instead.
    const model = asSceneModel(wireModel());
    expect(model).toBeTruthy();
    expect('representation' in model!).toBe(false);
    expect(sceneModelRepresentation(model!)).toBe(DEFAULT_REPRESENTATION);
  });

  it('drops a value it cannot read and keeps the model', () => {
    // Same asymmetry asSceneModel applies to a model's parts: this function
    // restores a scene from storage as well as reading a relay, and dropping a
    // product off everybody's screen over one unreadable field is the worse
    // mistake. What is left reads as the source, which every reader can open.
    const model = asSceneModel(wireModel({ representation: 'derived-obj' }));
    expect(model).toBeTruthy();
    expect('representation' in model!).toBe(false);
    expect(sceneModelRepresentation(model!)).toBe('source');
  });

  it('survives a whole scene, so a late joiner is told what to load', () => {
    const scene = asRoomScene({
      models: [wireModel(), wireModel({ id: 'model-2', hash: 'b2'.repeat(32), representation: 'derived-glb' })],
      builtIn: null,
    });
    expect(scene?.models.map((model) => sceneModelRepresentation(model))).toEqual([
      'source',
      'derived-glb',
    ]);
  });
});

describe('sceneFromLegacyReference and representation', () => {
  it('carries the field through a MODEL_CHANGE from a client that has not been updated', () => {
    // The room server translates that message into a one-model scene. Losing the
    // field on the way would have the sender loading the derivative and everybody
    // else the source: the same product on every screen, and every pin in the room
    // pointing at a different mesh on one of them.
    const scene = sceneFromLegacyReference({
      modelType: 'imported',
      hash: HASH,
      fileName: 'bracket.step',
      representation: 'derived-glb',
    });
    expect(scene?.models).toHaveLength(1);
    expect(scene?.models[0]?.representation).toBe('derived-glb');
  });

  it('reads a legacy reference with no field as the source, which is all such a client ever meant', () => {
    const scene = sceneFromLegacyReference({ modelType: 'imported', hash: HASH, fileName: 'bracket.step' });
    expect('representation' in scene!.models[0]).toBe(false);
    expect(sceneModelRepresentation(scene!.models[0])).toBe('source');
  });

  it('still refuses bytes, and still says nothing about a built-in', () => {
    expect(sceneFromLegacyReference({ modelType: 'imported', hash: HASH, fileBase64: 'Z2xURg==' })).toBeNull();
    // A built-in has nothing to fetch, so there is no encoding to choose.
    expect(sceneFromLegacyReference({ modelType: 'bicycle' })?.models).toEqual([]);
  });
});
