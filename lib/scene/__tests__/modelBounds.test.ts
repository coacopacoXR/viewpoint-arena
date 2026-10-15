// Which parts of a room's scene are the product, and how big they are — the box the
// lobby's thumbnail and the lobby's "Turn in 3D" viewer both compose a picture from.
//
// These pin the seam task 04b stage 2 put in: a parsed model answers its box from its
// PartRegistry, and only what has no registry — the bundled twelve-part synth, whose
// parts are React components rather than a parse — is still measured by walking the tags.
// The failure both halves guard is silent, which is why they exist at all: a box measured
// off a BatchedMesh's geometry is the concatenated buffer in the batch's own space, so
// framing composes a picture of somewhere the model is not, and an EMPTY box reads as
// "there is no picture to take" and the review quietly keeps whatever card it had.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { MODEL_ID_KEY, reviewModelBounds } from '../modelBounds';
import { MeshPartRegistry, type PartRegistry } from '../partRegistry';
import { sceneModelPrefix } from '../roomScene';
import { buildSceneTree } from '../../../utils/modelLoader';

const PREFIX = sceneModelPrefix('a1'.repeat(32));

/**
 * One parsed model in a room: an untagged wrapper group — the one carrying the model's
 * own offset, which components/Scene/ImportedModel.tsx renders — around the tagged group
 * the parse produced.
 */
function parsedModel(offset: THREE.Vector3): {
  wrapper: THREE.Group;
  registry: PartRegistry;
  rootId: string;
} {
  const root = new THREE.Group();
  root.name = 'Assembly';
  const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 2), material);
  base.name = 'Base';
  const bracket = new THREE.Group();
  bracket.name = 'Bracket';
  const arm = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), material);
  arm.name = 'Arm';
  arm.position.set(0, 3, 0);
  bracket.add(arm);
  root.add(base, bracket);
  const tree = buildSceneTree(root, { value: 0 }, PREFIX)!;

  const wrapper = new THREE.Group();
  wrapper.position.copy(offset);
  wrapper.add(root);
  wrapper.updateMatrixWorld(true);
  return { wrapper, registry: new MeshPartRegistry(root, tree), rootId: tree.id };
}

/**
 * The bundled synth, shaped the way components/Scene/Product.tsx builds it: tagged part
 * GROUPS, nested, with untagged meshes inside them and an untagged group of its own above
 * the lot. It has no registry, and never will — its parts are components, not a parse.
 */
function synth(offset: THREE.Vector3): THREE.Group {
  const holder = new THREE.Group();
  holder.position.copy(offset);
  const assembly = new THREE.Group();
  assembly.userData = { [MODEL_ID_KEY]: 'assembly', nodeId: 'assembly' };
  const body = new THREE.Group();
  body.userData = { [MODEL_ID_KEY]: 'main_body', nodeId: 'main_body' };
  body.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 1.6), new THREE.MeshStandardMaterial()));
  assembly.add(body);
  holder.add(assembly);
  holder.updateMatrixWorld(true);
  return holder;
}

function scene(...children: THREE.Object3D[]): THREE.Scene {
  const world = new THREE.Scene();
  for (const child of children) world.add(child);
  world.updateMatrixWorld(true);
  return world;
}

const sameBox = (a: THREE.Box3, b: THREE.Box3): void => {
  expect(a.isEmpty()).toBe(b.isEmpty());
  if (a.isEmpty()) return;
  expect(a.min.distanceTo(b.min)).toBeLessThan(1e-9);
  expect(a.max.distanceTo(b.max)).toBeLessThan(1e-9);
};

describe('reviewModelBounds', () => {
  it('answers an empty box for a scene with nothing tagged in it', () => {
    const world = scene(new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50)));
    // Empty and not null, and not a box at the origin: both callers read empty as "there
    // is no picture to take", and a box on the origin would frame one of the grey floor.
    expect(reviewModelBounds(world).isEmpty()).toBe(true);
    expect(reviewModelBounds(null).isEmpty()).toBe(true);
    expect(reviewModelBounds(undefined).isEmpty()).toBe(true);
  });

  it('answers the same box from a registry as the tag walk it replaces', () => {
    // The no-behaviour-change claim of the stage, and the one worth testing hardest:
    // while a part is still an Object3D of its own, the two readings have to agree to the
    // last decimal or every thumbnail in the app moves by whatever they disagree by.
    const model = parsedModel(new THREE.Vector3(3, 0, -2));
    const world = scene(model.wrapper);

    sameBox(reviewModelBounds(world, [model.registry]), reviewModelBounds(world));
    const box = reviewModelBounds(world, [model.registry]);
    expect(box.min.x).toBeCloseTo(1, 6);
    expect(box.max.x).toBeCloseTo(5, 6);
    // The arm sits 6 units above a base 2 units tall, so the top of the model is 6 and
    // not 1: a box that had measured the base alone would have framed half the product.
    expect(box.max.y).toBeCloseTo(6, 6);
  });

  it('leaves out a model whose own row is hidden, and gives it back', () => {
    const model = parsedModel(new THREE.Vector3(0, 0, 0));
    const world = scene(model.wrapper);
    const shown = reviewModelBounds(world, [model.registry]);
    expect(shown.isEmpty()).toBe(false);

    model.registry.setVisibleSubtree(model.rootId, false);
    expect(reviewModelBounds(world, [model.registry]).isEmpty()).toBe(true);

    model.registry.setVisibleSubtree(model.rootId, true);
    sameBox(reviewModelBounds(world, [model.registry]), shown);
  });

  it('still measures the synth by its tags, because the synth has no registry', () => {
    const world = scene(synth(new THREE.Vector3(0, 0, 0)));
    const walked = reviewModelBounds(world);
    expect(walked.isEmpty()).toBe(false);
    expect(walked.max.x).toBeCloseTo(1.2, 6);

    // A registry that owns nothing in the scene must not change the answer for what it
    // does not own.
    const model = parsedModel(new THREE.Vector3(100, 100, 100));
    sameBox(reviewModelBounds(world, [model.registry]), walked);
  });

  it('spans a parsed model and the synth in one room', () => {
    const model = parsedModel(new THREE.Vector3(10, 0, 0));
    const world = scene(model.wrapper, synth(new THREE.Vector3(-10, 0, 0)));

    const box = reviewModelBounds(world, [model.registry]);
    expect(box.min.x).toBeCloseTo(-11.2, 6);
    expect(box.max.x).toBeCloseTo(12, 6);
  });

  it('measures a model once, not once per tagged ancestor', () => {
    // The quadratic this has always guarded: an assembly tags every part under a tagged
    // root, and expandByObject walks the whole subtree it is given, so expanding by each
    // tagged node in turn would measure the same geometry once per ancestor. With a
    // registry the model's subtree is not walked at all — the registry answers for it —
    // which is the same guard and a cheaper one.
    const model = parsedModel(new THREE.Vector3(0, 0, 0));
    const world = scene(model.wrapper);

    const once = reviewModelBounds(world, [model.registry]);
    const walked = reviewModelBounds(world);
    sameBox(once, walked);
    expect(once.max.y).toBeCloseTo(6, 6);
  });
});
