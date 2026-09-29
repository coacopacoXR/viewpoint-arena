// Moving one part of a model, and putting it back — batch BR.
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
// And the original has to be known BEFORE anything moves the node, which is what
// rememberOriginalLocalTransform is for and what the gizmo calls at pointer-down.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyPartTransforms,
  findPartNode,
  partTargetFor,
  partTransformFromObject,
  rememberOriginalLocalTransform,
  usablePartScale,
} from '../partTransforms';
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

/** A group standing in for one parsed model: a root and three parts of it. */
function modelGroup(prefix: string): { root: THREE.Group; flange: THREE.Mesh; bolt: THREE.Mesh } {
  const root = new THREE.Group();
  root.userData.modelId = `${prefix}_0`;
  const flange = part(root, `${prefix}_1`, [1, 2, 3]);
  const bolt = part(root, `${prefix}_2`);
  return { root, flange, bolt };
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
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));
    expect(flange.position.toArray()).toEqual([1, 2, 3]);

    applyPartTransforms(root, { [flange.userData.modelId as string]: { position: [5, 0, 0] } });

    // Not [6,2,3]: the override is the node's local transform, not a delta on it.
    expect(flange.position.toArray()).toEqual([5, 0, 0]);
  });

  it('is a no-op the second time, which is what an echo mid-drag needs', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const parts: PartTransforms = { [flange.userData.modelId as string]: { position: [5, 0, 0] } };

    applyPartTransforms(root, parts);
    applyPartTransforms(root, parts);
    applyPartTransforms(root, parts);

    expect(flange.position.toArray()).toEqual([5, 0, 0]);
  });

  it('leaves the fields an override does not mention as the file had them', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));
    flange.rotation.set(0.5, 0, 0);
    flange.scale.set(2, 2, 2);

    applyPartTransforms(root, { [flange.userData.modelId as string]: { position: [9, 9, 9] } });

    expect(flange.position.toArray()).toEqual([9, 9, 9]);
    expect(flange.rotation.toArray().slice(0, 3)).toEqual([0.5, 0, 0]);
    expect(flange.scale.toArray()).toEqual([2, 2, 2]);
  });

  it('allows a non-uniform scale, which the whole model\'s single number cannot be', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));

    applyPartTransforms(root, { [flange.userData.modelId as string]: { scale: [2, 1, 0.5] } });

    expect(flange.scale.toArray()).toEqual([2, 1, 0.5]);
  });

  it('puts a node back where the file had it when its override is gone', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));
    const id = flange.userData.modelId as string;

    applyPartTransforms(root, { [id]: { position: [5, 0, 0], rotation: [0, 1, 0], scale: [3, 3, 3] } });
    applyPartTransforms(root, {});

    expect(flange.position.toArray()).toEqual([1, 2, 3]);
    expect(flange.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
    expect(flange.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('restores only the part that was reset, and leaves its neighbours moved', () => {
    const { root, flange, bolt } = modelGroup(sceneModelPrefix(HASH_A));
    const flangeId = flange.userData.modelId as string;
    const boltId = bolt.userData.modelId as string;

    applyPartTransforms(root, { [flangeId]: { position: [5, 0, 0] }, [boltId]: { position: [0, 7, 0] } });
    applyPartTransforms(root, { [boltId]: { position: [0, 7, 0] } });

    expect(flange.position.toArray()).toEqual([1, 2, 3]);
    expect(bolt.position.toArray()).toEqual([0, 7, 0]);
  });

  it('leaves a model nobody moved completely alone', () => {
    const { root, flange, bolt } = modelGroup(sceneModelPrefix(HASH_A));
    const untouched = { position: flange.position.clone(), scale: bolt.scale.clone() };

    applyPartTransforms(root, undefined);

    expect(flange.position).toEqual(untouched.position);
    expect(bolt.scale).toEqual(untouched.scale);
    // Nothing was remembered either, so an untouched model costs no userData on any
    // of the tens of thousands of nodes a big assembly can have.
    expect(flange.userData.originalLocalTransform).toBeUndefined();
  });

  it('never treats the root as a part, because the root IS the whole model', () => {
    const { root } = modelGroup(sceneModelPrefix(HASH_A));
    const rootId = root.userData.modelId as string;

    applyPartTransforms(root, { [rootId]: { position: [9, 9, 9], scale: [4, 4, 4] } });

    // placeImportedGroup owns this group's local transform — it is the centring and
    // the baseScale — and the model's own offset/rotation/scale sit on the wrapper
    // above it. A third opinion about the same object would slide the product.
    expect(root.position.toArray()).toEqual([0, 0, 0]);
    expect(root.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('refuses a scale the renderer could not use, axis by axis', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));
    flange.scale.set(2, 2, 2);
    rememberOriginalLocalTransform(flange);

    // drei's scale gizmo can be dragged through zero and out the other side. The
    // wire refuses a part scaled to nothing, so a drag that produced one would be
    // refused by the room and this browser left showing what the room does not have.
    applyPartTransforms(root, { [flange.userData.modelId as string]: { scale: [3, 0, -1] } });

    expect(flange.scale.toArray()).toEqual([3, 2, 2]);
  });
});

describe('rememberOriginalLocalTransform — the file\'s own numbers, kept once', () => {
  it('answers what the node had before anything moved it, however often it is asked', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));

    const before = rememberOriginalLocalTransform(flange);
    applyPartTransforms(root, { [flange.userData.modelId as string]: { position: [5, 5, 5] } });
    const after = rememberOriginalLocalTransform(flange);

    expect(before.position).toEqual([1, 2, 3]);
    expect(after.position).toEqual([1, 2, 3]);
  });

  it('is what the gizmo writes, so the override is the node as it now stands', () => {
    const { root, flange } = modelGroup(sceneModelPrefix(HASH_A));
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
    applyPartTransforms(root, { [flange.userData.modelId as string]: partTransformFromObject(flange) });
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

describe('findPartNode', () => {
  it('finds a node by the id the model tree shows, at any depth', () => {
    const { root, bolt } = modelGroup(sceneModelPrefix(HASH_A));
    const nested = new THREE.Group();
    nested.userData.modelId = 'ma1a1a1a1_9';
    bolt.add(nested);

    expect(findPartNode(root, 'ma1a1a1a1_2')).toBe(bolt);
    expect(findPartNode(root, 'ma1a1a1a1_9')).toBe(nested);
    expect(findPartNode(root, 'ma1a1a1a1_404')).toBeNull();
  });

  it('does not answer the root, which is the whole model and not a part of it', () => {
    const { root } = modelGroup(sceneModelPrefix(HASH_A));
    expect(findPartNode(root, root.userData.modelId as string)).toBeNull();
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
