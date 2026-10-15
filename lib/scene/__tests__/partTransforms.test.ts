// Moving one part of a model, and putting it back — batch BR, re-pointed at the part
// registry by task 04b stage 3.
//
// The rule the whole feature rests on: an override REPLACES the transform the file
// gave the node, in the node's own local space. It is never a delta. So
//
//   • applying the same override twice is a no-op the second time, which is what
//     lets a SCENE_STATE echo land in the middle of a drag without the part jumping
//     a second time;
//   • "Reset part" is a delete of the entry rather than an arithmetic inverse, which
//     is the only version of undo that cannot drift;
//   • a node the file put somewhere and nobody moved is not touched at all.
//
// And the original has to be known BEFORE anything moves the node. That used to be a
// `userData` stamp this test watched appear at pointer-down; it is now taken inside the
// handle's own write path (PartHandle.bindPose), so the moment cannot be got wrong and
// what is left to pin is that the answer survives the move it was taken before.
//
// Fixtures build a MeshPartRegistry over a hand-tagged group rather than a real parse:
// what is under test is the rule, and the registry is the seam that lets the same rule
// hold once a part is a slot in a batch instead of an object of its own.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyPartTransforms,
  partTargetFor,
  partTransformFromObject,
  usablePartScale,
} from '../partTransforms';
import { MeshPartRegistry } from '../partRegistry';
import { sceneModelPrefix, type PartTransforms, type SceneModel } from '../roomScene';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);

/** A node of a model, tagged the way utils/modelLoader's buildSceneTree tags it. */
function part(parent: THREE.Object3D, id: string, at: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.name = id;
  mesh.userData.modelId = id;
  mesh.position.set(at[0], at[1], at[2]);
  parent.add(mesh);
  return mesh;
}

/**
 * A group standing in for one parsed model: a root and two parts of it, plus the registry
 * that indexes them and the root's own id.
 *
 * The registry is built without a SceneNode tree, so a handle's name falls back to the
 * object's — these tests are about transforms, and lib/scene/__tests__/partRegistry.test.ts
 * is where the tree-named half is pinned.
 */
function modelGroup(prefix: string) {
  const root = new THREE.Group();
  const rootId = `${prefix}_0`;
  root.userData.modelId = rootId;
  const flange = part(root, `${prefix}_1`, [1, 2, 3]);
  const bolt = part(root, `${prefix}_2`);
  return { root, flange, bolt, rootId, registry: new MeshPartRegistry(root) };
}

function sceneModel(hash: string, line: string, revision: string): SceneModel {
  return {
    id: `model-${hash}`,
    hash,
    fileName: `${line}.step`,
    line,
    revision,
    visible: true,
    offset: [0, 0, 0],
  };
}

describe('applyPartTransforms — an override replaces the file', () => {
  it('puts the node where the override says, measured from where the file had it', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    expect(flange.position.toArray()).toEqual([1, 2, 3]);

    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { position: [5, 0, 0] } });

    // Not [6,2,3]: the override is the node's local transform, not a delta on it.
    expect(flange.position.toArray()).toEqual([5, 0, 0]);
  });

  it('is a no-op the second time, which is what an echo mid-drag needs', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const id = flange.userData.modelId as string;
    const parts: PartTransforms = { [id]: { position: [5, 0, 0] } };
    const handle = registry.get(id)!;

    applyPartTransforms(registry, rootId, parts);
    const once = handle.getMatrix(new THREE.Matrix4()).elements.slice();
    applyPartTransforms(registry, rootId, parts);
    applyPartTransforms(registry, rootId, parts);
    const thrice = handle.getMatrix(new THREE.Matrix4());

    expect(flange.position.toArray()).toEqual([5, 0, 0]);
    // The render audit's §3.7 item 5 asks for the MATRIX to be compared, not just the three
    // fields, because a batched part has nothing else. Through `setLocalTransform` the
    // round trip is exact — the drift lib/scene/__tests__/partRegistry.test.ts warns about
    // belongs to `setMatrix`, which decomposes — but the assertion is written with a
    // tolerance so it keeps holding when stage 4 answers from an instance buffer.
    thrice.elements.forEach((value, index) => {
      expect(value, `element ${index}`).toBeCloseTo(once[index], 10);
    });
  });

  it('leaves the fields an override does not mention as the file had them', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    flange.rotation.set(0.5, 0, 0);
    flange.scale.set(2, 2, 2);

    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { position: [9, 9, 9] } });

    expect(flange.position.toArray()).toEqual([9, 9, 9]);
    expect(flange.rotation.toArray().slice(0, 3)).toEqual([0.5, 0, 0]);
    expect(flange.scale.toArray()).toEqual([2, 2, 2]);
  });

  it('allows a non-uniform scale, which the whole model\'s single number cannot be', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));

    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { scale: [2, 1, 0.5] } });

    expect(flange.scale.toArray()).toEqual([2, 1, 0.5]);
  });

  it('puts a node back where the file had it when its override is gone', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const id = flange.userData.modelId as string;

    applyPartTransforms(registry, rootId, { [id]: { position: [5, 0, 0], rotation: [0, 1, 0], scale: [3, 3, 3] } });
    applyPartTransforms(registry, rootId, {});

    expect(flange.position.toArray()).toEqual([1, 2, 3]);
    expect(flange.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(flange.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('restores only the part that was reset, and leaves its neighbours moved', () => {
    const { registry, rootId, flange, bolt } = modelGroup(sceneModelPrefix(HASH_A));
    const flangeId = flange.userData.modelId as string;
    const boltId = bolt.userData.modelId as string;

    applyPartTransforms(registry, rootId, { [flangeId]: { position: [5, 0, 0] }, [boltId]: { position: [0, 7, 0] } });
    applyPartTransforms(registry, rootId, { [boltId]: { position: [0, 7, 0] } });

    expect(flange.position.toArray()).toEqual([1, 2, 3]);
    expect(bolt.position.toArray()).toEqual([0, 7, 0]);
  });

  it('leaves a model nobody moved completely alone', () => {
    const { registry, rootId, flange, bolt } = modelGroup(sceneModelPrefix(HASH_A));
    const untouched = { position: flange.position.clone(), scale: bolt.scale.clone() };

    applyPartTransforms(registry, rootId, undefined);

    expect(flange.position).toEqual(untouched.position);
    expect(bolt.scale).toEqual(untouched.scale);
    // Nothing was written, so nothing was recorded as moved either. That record is the
    // index the reset pass runs over, and it staying empty is what makes an untouched
    // model cost nothing at all — the traverse this replaced walked every node of it on
    // every `model.parts` change, which is the cost 04b exists to remove.
    expect(registry.movedPartIds()).toEqual([]);
  });

  it('never treats the root as a part, because the root IS the whole model', () => {
    const { registry, rootId, root } = modelGroup(sceneModelPrefix(HASH_A));

    applyPartTransforms(registry, rootId, { [rootId]: { position: [9, 9, 9], scale: [4, 4, 4] } });

    // placeImportedGroup owns this group's local transform — it is the centring and
    // the baseScale — and the model's own offset/rotation/scale sit on the wrapper
    // above it. A third opinion about the same object would slide the product.
    expect(root.position.toArray()).toEqual([0, 0, 0]);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('refuses a scale the renderer could not use, axis by axis', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    flange.scale.set(2, 2, 2);

    // drei's scale gizmo can be dragged through zero and out the other side. The
    // wire refuses a part scaled to nothing, so a drag that produced one would be
    // refused by the room and this browser left showing what the room does not have.
    // The fallback is the file's own number, and nothing had to stamp it: the handle
    // takes it on the write this is about to be.
    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { scale: [3, 0, -1] } });

    expect(flange.scale.toArray()).toEqual([3, 2, 2]);
  });

  it('ignores an override for a part this model does not have', () => {
    // A SCENE_STATE relayed from a room whose copy of the file was replaced, or a review
    // whose stored placements name a revision that is not this one.
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));

    applyPartTransforms(registry, rootId, { nope_7: { position: [9, 9, 9] } });

    expect(flange.position.toArray()).toEqual([1, 2, 3]);
    expect(registry.movedPartIds()).toEqual([]);
  });
});

describe('bindPose — the file\'s own numbers, kept once', () => {
  it('answers what the node had before anything moved it, however often it is asked', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const handle = registry.get(flange.userData.modelId as string)!;

    const before = handle.bindPose();
    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { position: [5, 5, 5] } });
    const after = handle.bindPose();

    expect(before.position).toEqual([1, 2, 3]);
    expect(after.position).toEqual([1, 2, 3]);
  });

  it('is taken by the first write and not by a later one, which is what Reset restores', () => {
    // The moment used to be the gizmo's to get right: `rememberOriginalLocalTransform` had
    // to be called at pointer-DOWN, because TransformControls moves the object on the
    // pointer-move that follows and an original taken after that was the dragged value.
    // It is in the write path now, so a second move cannot overwrite the first answer.
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const handle = registry.get(flange.userData.modelId as string)!;

    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { position: [5, 5, 5] } });
    applyPartTransforms(registry, rootId, { [flange.userData.modelId as string]: { position: [8, 8, 8] } });

    expect(handle.bindPose().position).toEqual([1, 2, 3]);
    expect(flange.position.toArray()).toEqual([8, 8, 8]);
  });

  it('answers a copy, so a caller cannot write through it and lose the file', () => {
    const { registry, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const handle = registry.get(flange.userData.modelId as string)!;

    handle.bindPose().position[0] = 999;

    expect(handle.bindPose().position).toEqual([1, 2, 3]);
  });

  it('is the part\'s own transform while nothing has moved it', () => {
    const { registry, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const handle = registry.get(flange.userData.modelId as string)!;

    expect(handle.bindPose()).toEqual(handle.getLocalTransform());
    expect(registry.movedPartIds()).toEqual([]);
  });

  it('lists a part as moved once something has written to it, which is what the reset finds', () => {
    const { registry, rootId, flange, bolt } = modelGroup(sceneModelPrefix(HASH_A));
    const flangeId = flange.userData.modelId as string;
    const boltId = bolt.userData.modelId as string;

    applyPartTransforms(registry, rootId, { [flangeId]: { position: [5, 0, 0] } });
    expect(registry.movedPartIds()).toEqual([flangeId]);

    applyPartTransforms(registry, rootId, { [boltId]: { position: [0, 7, 0] } });
    expect(registry.movedPartIds()).toEqual([flangeId, boltId]);

    // Still listed after being put back: dropping it would need the write path to know a
    // part has landed exactly on its bind pose, and re-writing a part that is already
    // there costs nothing.
    applyPartTransforms(registry, rootId, {});
    expect(registry.movedPartIds()).toEqual([flangeId, boltId]);
    expect(bolt.position.toArray()).toEqual([0, 0, 0]);
  });

  it('is what the gizmo writes, so the override is the node as it now stands', () => {
    const { registry, rootId, flange } = modelGroup(sceneModelPrefix(HASH_A));
    flange.position.set(4, 0, 0);
    flange.rotation.set(0, 1.5708, 0);
    flange.scale.set(2, 2, 2);

    expect(partTransformFromObject(flange)).toEqual({
      position: [4, 0, 0],
      rotation: [0, 1.5708, 0],
      scale: [2, 2, 2],
    });

    // And re-applying what it produced changes nothing, which is the same property
    // the first test pinned from the other direction.
    applyPartTransforms(
      registry,
      rootId,
      { [flange.userData.modelId as string]: partTransformFromObject(flange) },
    );
    expect(flange.position.toArray()).toEqual([4, 0, 0]);
  });
});

describe('usablePartScale', () => {
  it('keeps what is usable and falls back per axis', () => {
    expect(usablePartScale([2, 3, 4], [1, 1, 1])).toEqual([2, 3, 4]);
    expect(usablePartScale([2, 0, 4], [1, 9, 1])).toEqual([2, 9, 4]);
    expect(usablePartScale([-1, NaN, Infinity], [7, 7, 7])).toEqual([7, 7, 7]);
  });
});

describe('partTargetFor — the one selection the laser and the tree already set', () => {
  const models = [sceneModel(HASH_A, 'bracket', 'A'), sceneModel(HASH_B, 'mating-part', 'A')];
  const rootIds: Record<string, string> = {
    [`model-${HASH_A}`]: `${sceneModelPrefix(HASH_A)}_0`,
    [`model-${HASH_B}`]: `${sceneModelPrefix(HASH_B)}_0`,
  };
  const rootIdOf = (modelId: string) => rootIds[modelId] ?? null;

  it('answers nothing when nothing is selected, which is the strip\'s "Click a part to move it."', () => {
    expect(partTargetFor(models, rootIdOf, null)).toBeNull();
  });

  it('answers the model a part belongs to, from the node id alone', () => {
    // The model comes from the id's PREFIX rather than from activeSceneModelId,
    // because pointing at a part in the 3D view selects it without changing which
    // model the scale slider refers to.
    expect(partTargetFor(models, rootIdOf, `${sceneModelPrefix(HASH_B)}_7`)).toEqual({
      modelId: `model-${HASH_B}`,
      nodeId: `${sceneModelPrefix(HASH_B)}_7`,
    });
  });

  it('answers the model\'s own root as no part at all, which behaves like Whole model', () => {
    expect(partTargetFor(models, rootIdOf, `${sceneModelPrefix(HASH_A)}_0`)).toEqual({
      modelId: `model-${HASH_A}`,
      nodeId: null,
    });
  });

  it('answers nothing for a built-in\'s node, whose parts are React components with no SceneModel', () => {
    expect(partTargetFor(models, rootIdOf, 'headphones_2')).toBeNull();
    expect(partTargetFor(models, rootIdOf, 'synth_body')).toBeNull();
  });

  it('answers nothing for a model whose file has not been fetched, so no root can be ruled a root', () => {
    expect(partTargetFor(models, () => null, `${sceneModelPrefix(HASH_A)}_3`)).toEqual({
      modelId: `model-${HASH_A}`,
      nodeId: `${sceneModelPrefix(HASH_A)}_3`,
    });
  });

  it('ignores a model with no hash, which is a draft whose bytes were never uploaded', () => {
    const draft: SceneModel = { ...sceneModel('', 'draft', 'A') };
    expect(partTargetFor([draft], () => null, '_3')).toBeNull();
  });
});
