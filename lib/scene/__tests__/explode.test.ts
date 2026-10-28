// The room's explode view — task 08b.
//
// WHAT IS ASSERTED HERE is the rule the task states, as numbers rather than as a picture:
// a part moves along the line from its MODEL's centre to its own, by `factor × spread × that
// distance`; a part at the centre does not move; factor 0 is bit-for-bit the model the file
// describes; and the two registries agree, because a room that exploded a 300-part bracket one
// way and a 3 000-part assembly another would be two features wearing one slider.
//
// THE HALF THAT IS EASY TO GET WRONG, and the reason `NESTED` exists: a parsed model is a
// real hierarchy, so writing "move by D" to a group moves everything inside it by D as well.
// An explode that did that would push a bolt by its own distance plus its arm's plus its
// assembly's, and the deeper the file the further the model would come apart. What the rule
// says is where a part ENDS UP, so a nested part's own offset is its direction less what its
// ancestors already contribute — the same number for a flat model and a different one for a
// nested one, with the picture identical either way.
//
// ALSO ASSERTED: that the explode is DISPLAY ONLY. It never appears in a handle's transform,
// never becomes a bind pose, never reaches `SceneModel.parts`, and never changes the box the
// cut plane resolves against — which is the one other view tool that would otherwise be moved
// by it.
//
// Fixtures are hand-built rather than parsed, so the expected vectors are numbers a reader can
// check against the rule by hand. Where the two registries are compared they are built from
// INDEPENDENT builds of the same description, which is what makes "the two agree" a statement
// about two models and not about one object read twice.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildSceneTree } from '../../../utils/modelLoader';
import { BatchedPartRegistry } from '../batchedParts';
import { MeshPartRegistry, hitParts, type PartRegistry } from '../partRegistry';
import { EXPLODE_SPREAD } from '../explode';
import { CUT_PLANE, writeCutPlane } from '../cutPlane';
import { sceneModelPrefix } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'a1'.repeat(32);
const PREFIX = sceneModelPrefix(HASH);

type Triple = [number, number, number];

/** A node of a fixture: a box of `size` at `position`, or a group when it has no size. */
interface Spec {
  name: string;
  position: Triple;
  size?: Triple;
  children?: Spec[];
}

interface Fixture {
  root: THREE.Group;
  tree: SceneNode;
  /** The id buildSceneTree gave each named object. */
  idOf: Map<string, string>;
}

/**
 * Build one fixture from a description.
 *
 * A BoxGeometry and a material per node rather than one shared template, so a part's own box
 * is the box this file says it is and "which geometry answered" is never a second question.
 */
function build(spec: Spec[], prefix: string = PREFIX): Fixture {
  const root = new THREE.Group();
  root.name = 'Assembly';
  const idOf = new Map<string, string>();

  const add = (node: Spec, parent: THREE.Object3D): void => {
    const object: THREE.Object3D = node.size
      ? new THREE.Mesh(
          new THREE.BoxGeometry(node.size[0], node.size[1], node.size[2]),
          new THREE.MeshStandardMaterial({ color: 0x8899aa }),
        )
      : new THREE.Group();
    object.name = node.name;
    object.position.set(node.position[0], node.position[1], node.position[2]);
    parent.add(object);
    for (const child of node.children ?? []) add(child, object);
  };
  for (const node of spec) add(node, root);

  const tree = buildSceneTree(root, { value: 0 }, prefix);
  if (!tree) throw new Error('fixture produced no tree');
  root.traverse((object) => {
    const id = object.userData.modelId;
    if (typeof id === 'string' && object.name) idOf.set(object.name, id);
  });
  root.updateMatrixWorld(true);
  return { root, tree, idOf };
}

/**
 * Three boxes on the x axis at −2, 0 and 2, and a model whose centre is therefore the origin.
 *
 * Symmetric on purpose: the middle part sits AT the centre, so its direction is the zero
 * vector and "a part at the centre does not move" is a fact about this fixture rather than a
 * tolerance. The outer two are 2 units out, so at factor `f` each moves 3f — a number a reader
 * can get from the rule without a calculator.
 */
const SYMMETRIC: Spec[] = [
  { name: 'Left', position: [-2, 0, 0], size: [1, 1, 1] },
  { name: 'Hub', position: [0, 0, 0], size: [1, 1, 1] },
  { name: 'Right', position: [2, 0, 0], size: [1, 1, 1] },
];

/**
 * A group with two parts in it, beside a base — the shape that makes an explode compound.
 *
 * 'Arm' has no geometry of its own, so its box is the union of the two inside it and its own
 * centre (3.5, 0, 0) is neither of theirs. The model is symmetric about x = 0 — Base at −4,
 * Tip at +4 — so its centre is the origin and every expected distance is a part's own x.
 */
const NESTED: Spec[] = [
  { name: 'Base', position: [-4, 0, 0], size: [1, 1, 1] },
  {
    name: 'Arm',
    position: [3, 0, 0],
    children: [
      { name: 'Root Bolt', position: [0, 0, 0], size: [1, 1, 1] },
      { name: 'Tip', position: [1, 0, 0], size: [1, 1, 1] },
    ],
  },
];

/** Both implementations, so a rule that holds for one is shown to hold for the other. */
const BOTH = ['mesh', 'batched'] as const;
type Which = (typeof BOTH)[number];

/** One description, indexed one way. Its own build, because a registry owns what it indexes. */
function side(spec: Spec[], which: Which): { fixture: Fixture; registry: PartRegistry } {
  const fixture = build(spec);
  return {
    fixture,
    registry: which === 'mesh'
      ? new MeshPartRegistry(fixture.root, fixture.tree)
      : new BatchedPartRegistry(fixture.root, fixture.tree),
  };
}

/** One description indexed BOTH ways, from two independent builds of it. */
function pair(spec: Spec[]) {
  const meshSide = build(spec);
  const batchSide = build(spec);
  return {
    meshSide,
    batchSide,
    mesh: new MeshPartRegistry(meshSide.root, meshSide.tree) as PartRegistry,
    batched: new BatchedPartRegistry(batchSide.root, batchSide.tree) as PartRegistry,
  };
}

/**
 * The centre of a part's drawn box, in world space.
 *
 * Matrices are updated first because nothing else has: a registry writes positions and
 * instance matrices and leaves the composition to the renderer, so a measurement taken between
 * the write and the next frame is of the pose before it. `Box3.setFromObject` refreshes the
 * object it is given and everything under it but NOT that object's ancestors, which is exactly
 * the case a nested part is.
 */
function centreOf(registry: PartRegistry, root: THREE.Object3D, id: string): THREE.Vector3 {
  root.updateMatrixWorld(true);
  const handle = registry.get(id);
  if (!handle) throw new Error(`no part ${id}`);
  return handle.getBoundingBox(new THREE.Box3()).getCenter(new THREE.Vector3());
}

/** Every part's drawn centre, keyed by the name the fixture gave it. */
function centresOf(fixture: Fixture, registry: PartRegistry): Record<string, THREE.Vector3> {
  const out: Record<string, THREE.Vector3> = {};
  for (const [name, id] of fixture.idOf) out[name] = centreOf(registry, fixture.root, id);
  return out;
}

/** The same, as plain arrays in the order given — for a compare that has to be bit for bit. */
function centresInOrder(registry: PartRegistry, fixture: Fixture, ids: string[]): number[][] {
  return ids.map((id) => centreOf(registry, fixture.root, id).toArray());
}

/**
 * The model's own centre, which is what every direction is measured from.
 *
 * Asked of the registry rather than computed from the fixture, because "the model's centre"
 * means the box the registry answers for `bounds` — a test that measured it another way would
 * be checking the rule against its own idea of the model.
 */
function modelCentre(registry: PartRegistry): THREE.Vector3 {
  return registry.bounds(new THREE.Box3()).getCenter(new THREE.Vector3());
}

/** What a ray from `from` straight down −z answers, as part ids, nearest first. */
function picked(registry: PartRegistry, root: THREE.Object3D, from: Triple): string[] {
  root.updateMatrixWorld(true);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(0, 0, -1));
  const found: string[] = [];
  for (const hit of raycaster.intersectObjects([root], true)) {
    const parts = hitParts(hit, [registry]);
    if (parts.chain.length > 0) found.push(parts.chain[0]);
  }
  return found;
}

const near = (actual: THREE.Vector3, expected: Triple, what: string): void => {
  expect(actual.x, `${what}.x`).toBeCloseTo(expected[0], 9);
  expect(actual.y, `${what}.y`).toBeCloseTo(expected[1], 9);
  expect(actual.z, `${what}.z`).toBeCloseTo(expected[2], 9);
};

describe('the rule: a part moves along the line from its model’s centre to its own', () => {
  it.each(BOTH)('moves each part by factor × spread × its own distance (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const assembled = centresOf(fixture, registry);
    const centre = modelCentre(registry);
    near(centre, [0, 0, 0], 'the symmetric model’s centre');

    const factor = 0.5;
    expect(registry.setExplode(factor)).toBeGreaterThan(0);
    const exploded = centresOf(fixture, registry);

    // The numbers first, so the assertion is a fact about the fixture rather than a
    // restatement of the implementation: the outer parts are 2 units from the centre, the
    // spread is 1.5 and the factor a half, so each moves 1.5 further out and the part at the
    // centre does not move at all.
    near(exploded.Left, [-2 - 1.5, 0, 0], 'Left at 0.5');
    near(exploded.Hub, [0, 0, 0], 'Hub at 0.5');
    near(exploded.Right, [2 + 1.5, 0, 0], 'Right at 0.5');

    // Then the rule for every part, as the task states it: along the line from the model's
    // centre to the part's own, by factor × spread × the distance between them. A direction
    // times its own distance IS the vector between the two points, which is why this needs no
    // normalising to write down.
    for (const name of ['Left', 'Hub', 'Right']) {
      const expected = assembled[name]
        .clone()
        .sub(centre)
        .multiplyScalar(factor * EXPLODE_SPREAD)
        .add(assembled[name]);
      near(exploded[name], [expected.x, expected.y, expected.z], `${name} by the rule`);
    }
  });

  it.each(BOTH)('leaves a part at the model’s centre exactly where it was (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const hub = fixture.idOf.get('Hub')!;
    const before = centreOf(registry, fixture.root, hub);

    registry.setExplode(1);
    near(centreOf(registry, fixture.root, hub), [before.x, before.y, before.z], 'the hub at full spread');
    // Its neighbours went, so this is a part that did not move and not a model that did not.
    expect(centreOf(registry, fixture.root, fixture.idOf.get('Left')!).x).toBeLessThan(before.x - 1);
  });

  it.each(BOTH)('does not compound through a group: a nested part moves by ITS OWN distance (%s registry)', (which) => {
    const { fixture, registry } = side(NESTED, which);
    const assembled = centresOf(fixture, registry);
    near(modelCentre(registry), [0, 0, 0], 'the nested model’s centre');

    registry.setExplode(0.5);
    const exploded = centresOf(fixture, registry);

    // Tip is 4 out and Root Bolt 3 out, so at factor 0.5 with a spread of 1.5 they move 3 and
    // 2.25 — and NOT 3 plus whatever their arm did. An explode that compounded would have put
    // Tip at 4 + 3 + 2.25 + 2.625, and a model would come apart the further the deeper the
    // file happened to nest it.
    near(exploded.Tip, [4 + 3, 0, 0], 'Tip');
    near(exploded['Root Bolt'], [3 + 2.25, 0, 0], 'Root Bolt');
    near(exploded.Base, [-4 - 3, 0, 0], 'Base');
    expect(assembled.Tip.x).toBeCloseTo(4, 9);
  });

  it.each(BOTH)('explodes each model about ITS OWN centre, not the room’s (%s registry)', (which) => {
    // The same fixture twice, one of them standing ten units away at twice the size, which is
    // what a room with two products in it looks like. If the directions were measured in world
    // space rather than in the model's own, the moved model would explode away from an origin
    // it no longer sits on and its parts would fly off in the wrong direction.
    const here = build(SYMMETRIC);
    const there = build(SYMMETRIC, `${PREFIX}b`);
    const wrapper = new THREE.Group();
    wrapper.position.set(10, 4, 0);
    wrapper.scale.setScalar(2);
    wrapper.add(there.root);
    wrapper.updateMatrixWorld(true);

    const index = (fixture: Fixture): PartRegistry => which === 'mesh'
      ? new MeshPartRegistry(fixture.root, fixture.tree)
      : new BatchedPartRegistry(fixture.root, fixture.tree);
    const beside = index(here);
    const moved = index(there);

    const before = centresOf(there, moved);
    beside.setExplode(0.5);
    moved.setExplode(0.5);
    const after = centresOf(there, moved);

    // Each part moved by its own distance from its own model's centre, doubled because that is
    // what a root-space vector becomes under a wrapper scaled by 2 — and by nothing to do with
    // the ten units the model was moved, or with the model standing beside it.
    const centre = before.Right.clone().add(before.Left).multiplyScalar(0.5);
    for (const name of ['Left', 'Right']) {
      const displacement = after[name].clone().sub(before[name]);
      const expected = before[name].clone().sub(centre).multiplyScalar(0.5 * EXPLODE_SPREAD);
      near(displacement, [expected.x, expected.y, expected.z], `${name}’s displacement`);
    }
    // The moved model's hub did not move either, which is the same fact from the other end: a
    // model's centre is its own wherever in the room the model is standing.
    near(after.Hub, [before.Hub.x, before.Hub.y, before.Hub.z], 'the moved model’s hub');
  });
});

describe('factor 0 is the model the file describes', () => {
  it.each(BOTH)('writes nothing at all, and answers that it wrote nothing (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);

    expect(registry.setExplode(0)).toBe(0);
    const centres = centresOf(fixture, registry);
    near(centres.Left, [-2, 0, 0], 'Left');
    near(centres.Right, [2, 0, 0], 'Right');
  });

  it.each(BOTH)('puts every part back bit for bit after an explode (%s registry)', (which) => {
    const { fixture, registry } = side(NESTED, which);
    const ids = [...fixture.idOf.values()];

    // The matrices rather than the boxes: a box that came back to within a micrometre would
    // pass and would still be a model that drifted a little every time somebody dragged the
    // slider. `(base + v) − v` is not `base` in floating point, so the collapse restores the
    // position it recorded rather than subtracting the offset it added.
    const before = ids.map((id) => registry.get(id)!.getMatrix(new THREE.Matrix4()).elements.slice());
    const boxesBefore = centresInOrder(registry, fixture, ids);

    registry.setExplode(0.8);
    registry.setExplode(0.2);
    registry.setExplode(1);
    registry.setExplode(0);

    expect(ids.map((id) => registry.get(id)!.getMatrix(new THREE.Matrix4()).elements.slice()))
      .toEqual(before);
    expect(centresInOrder(registry, fixture, ids)).toEqual(boxesBefore);
  });

  it.each(BOTH)('leaves the model’s own placement alone (%s registry)', (which) => {
    // The root's transform is the placement: components/Scene/ImportedModel.tsx scales it and
    // drops it on the floor AFTER the registry was built from it, so a plan that recorded the
    // root's position as a base to restore would put the product back where the parse found it
    // and the model would fall through the floor the first time somebody touched the slider.
    const { fixture, registry } = side(NESTED, which);
    fixture.root.position.set(0, 7, 0);
    fixture.root.scale.setScalar(3);
    fixture.root.updateMatrixWorld(true);
    const placement = fixture.root.matrixWorld.elements.slice();

    registry.setExplode(1);
    registry.setExplode(0);

    expect(fixture.root.matrixWorld.elements.slice()).toEqual(placement);
  });

  it.each(BOTH)('clamps what the room sends, because the wire carries a number anybody could write (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const left = fixture.idOf.get('Left')!;

    registry.setExplode(1);
    const full = centreOf(registry, fixture.root, left).x;
    registry.setExplode(0);
    // Past both ends of the range: more than full is full, less than nothing is nothing, and a
    // value that is not a number at all is nothing. The same clamping `asUnit` gives the cut's
    // position, because one shared value on the wire is one shared rule about what it may hold.
    registry.setExplode(3);
    expect(centreOf(registry, fixture.root, left).x).toBeCloseTo(full, 9);
    registry.setExplode(0);
    registry.setExplode(-2);
    expect(centreOf(registry, fixture.root, left).x).toBeCloseTo(-2, 9);
    registry.setExplode(Number.NaN);
    expect(centreOf(registry, fixture.root, left).x).toBeCloseTo(-2, 9);
  });

  it.each(BOTH)('is asked twice without being written twice (%s registry)', (which) => {
    const { registry } = side(SYMMETRIC, which);

    // The caller is a component effect, and it re-runs on every scene change as well as on
    // every step of the slider — see components/Scene/ViewToolsExplode.tsx. An apply that ran
    // on the value it already had would be ten thousand writes a second for a picture that did
    // not move.
    expect(registry.setExplode(0.6)).toBeGreaterThan(0);
    expect(registry.setExplode(0.6)).toBe(0);
    expect(registry.setExplode(0.6)).toBe(0);
    expect(registry.setExplode(0)).toBeGreaterThan(0);
    expect(registry.setExplode(0)).toBe(0);
  });
});

describe('display only: the explode is never the part’s own transform', () => {
  it.each(BOTH)('is not what a handle answers for its transform (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const handle = registry.get(fixture.idOf.get('Left')!)!;

    const before = handle.getLocalTransform();
    const matrixBefore = handle.getMatrix(new THREE.Matrix4()).elements.slice();
    registry.setExplode(1);
    // The wire, the gizmo and the review's own placements all speak this transform. If an
    // explode appeared in it, a drag that landed while the room was exploded would have
    // written the pushed-out position into SceneModel.parts, and the product would have come
    // back apart the next time the room was opened.
    expect(handle.getLocalTransform()).toEqual(before);
    expect(handle.getMatrix(new THREE.Matrix4()).elements.slice()).toEqual(matrixBefore);

    // And the part IS being drawn somewhere else, so the two answers really do differ.
    expect(centreOf(registry, fixture.root, handle.id).x).toBeCloseTo(-2 - EXPLODE_SPREAD * 2, 9);
  });

  it.each(BOTH)('never becomes a bind pose, so "Reset part" still means the file (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const handle = registry.get(fixture.idOf.get('Left')!)!;

    registry.setExplode(0.6);
    // A write landing while the room is exploded — an override from a colleague, an undo —
    // takes the bind pose at that moment, and the bind pose is what "Reset part" restores. If
    // it took the exploded one, resetting a part would put it where the slider happened to be.
    handle.setLocalTransform({ position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(handle.bindPose()).toEqual({ position: [-2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    // The override itself is the logical one, with no explode folded into it — which is what
    // goes on the wire, so the room sees the move the person meant and not the view they had.
    expect(handle.getLocalTransform().position).toEqual([0, 3, 0]);
    expect(registry.movedPartIds()).toEqual([handle.id]);
  });

  it.each(BOTH)('leaves a part somebody hid hidden (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const left = fixture.idOf.get('Left')!;
    const right = fixture.idOf.get('Right')!;

    const states: Record<string, { visible: boolean; selected: boolean }> = {};
    for (const id of fixture.idOf.values()) states[id] = { visible: id !== left, selected: false };
    registry.syncStates(states, null);

    // Asserted through a pick, which is the answer both registries give the same way: a
    // batched part is hidden by clearing a slot flag and an Object3D one by `visible`, and
    // only the pick path sees both.
    expect(picked(registry, fixture.root, [-2, 0, 5])).not.toContain(left);
    registry.setExplode(0.8);
    expect(picked(registry, fixture.root, [-2 - 2.4, 0, 5])).not.toContain(left);
    registry.setExplode(0);
    expect(picked(registry, fixture.root, [-2, 0, 5])).not.toContain(left);
    // And what was shown is still shown: a hide is not a cull, and an explode is not a reason
    // to give one back.
    expect(picked(registry, fixture.root, [2, 0, 5])).toContain(right);
  });

  it.each(BOTH)('moves the pick with the part, so the laser names what is under it (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const left = fixture.idOf.get('Left')!;

    expect(picked(registry, fixture.root, [-2, 0, 5])[0]).toBe(left);
    registry.setExplode(1);
    // Where it was is empty space now, and where it is answers it — which is the difference
    // between an explode that moved the model and one that moved a picture of it.
    expect(picked(registry, fixture.root, [-2, 0, 5])).not.toContain(left);
    expect(picked(registry, fixture.root, [-2 - EXPLODE_SPREAD * 2, 0, 5])[0]).toBe(left);
  });
});

describe('the boxes: framing sees the explode, the cut does not', () => {
  it.each(BOTH)('answers a bigger box while exploded, and the file’s own when asked for it (%s registry)', (which) => {
    const { fixture, registry } = side(SYMMETRIC, which);
    const assembled = registry.bounds(new THREE.Box3()).clone();
    expect(registry.visibleBounds(new THREE.Box3()).equals(assembled)).toBe(true);

    registry.setExplode(0.5);
    const exploded = registry.bounds(new THREE.Box3());
    // Bigger, and by exactly the spread on the axis the parts moved along: the outermost went
    // out by factor × spread × their own distance, so the box grew by that at both ends.
    expect(exploded.min.x).toBeCloseTo(assembled.min.x - 0.5 * EXPLODE_SPREAD * 2, 9);
    expect(exploded.max.x).toBeCloseTo(assembled.max.x + 0.5 * EXPLODE_SPREAD * 2, 9);
    expect(exploded.max.y).toBeCloseTo(assembled.max.y, 9);

    // The box the CUT resolves against. The value on the wire is a fraction of the models'
    // extent, so a plane resolved against the exploded box would slide every time somebody
    // dragged this slider — a section that moves because a different view tool moved is a
    // section nobody can hold still.
    expect(registry.bounds(new THREE.Box3(), { assembled: true }).equals(assembled)).toBe(true);
    expect(registry.visibleBounds(new THREE.Box3(), { assembled: true }).equals(assembled)).toBe(true);
    // Asking for the file's box is a question and not a collapse: the model is still apart,
    // and the next box asked for without the option is the exploded one again.
    near(centreOf(registry, fixture.root, fixture.idOf.get('Left')!), [-3.5, 0, 0], 'Left');
    expect(registry.bounds(new THREE.Box3()).equals(exploded)).toBe(true);
  });

  it('is the same box from both registries, so a thumbnail does not depend on how many parts a file had', () => {
    const { mesh, batched } = pair(NESTED);
    for (const factor of [0, 0.4, 1]) {
      mesh.setExplode(factor);
      batched.setExplode(factor);
      const one = mesh.bounds(new THREE.Box3());
      const two = batched.bounds(new THREE.Box3());
      expect(two.min.toArray(), `min at ${factor}`).toEqual(one.min.toArray());
      expect(two.max.toArray(), `max at ${factor}`).toEqual(one.max.toArray());
    }
  });
});

describe('the other view tool: a cut does not move because the model did', () => {
  it.each(BOTH)('resolves to the same plane exploded as assembled (%s registry)', (which) => {
    const { registry } = side(SYMMETRIC, which);
    // A quarter rather than the middle: the fixture is symmetric about its own centre, so an
    // explode grows its box equally at both ends and a cut at 0.5 would land on the same plane
    // either way — a test that passed for a reason that has nothing to do with the option.
    const cut = { axis: 'x' as const, position: 0.25, flip: false };
    const plane = (): number[] => [
      CUT_PLANE.normal.x,
      CUT_PLANE.normal.y,
      CUT_PLANE.normal.z,
      CUT_PLANE.constant,
    ];

    writeCutPlane(cut, registry.bounds(new THREE.Box3(), { assembled: true }));
    const assembled = plane();

    registry.setExplode(0.8);
    // What components/Scene/ViewToolsCut.tsx asks for. The value on the wire is a FRACTION of
    // the models' extent, so a plane resolved against anything that grew would slide — and a
    // section that moves because somebody dragged a different slider is a section nobody can
    // hold still, in a room where five people are looking at it.
    writeCutPlane(cut, registry.bounds(new THREE.Box3(), { assembled: true }));
    expect(plane()).toEqual(assembled);

    // And the reason that option has to exist rather than the box simply being stable: the box
    // the model is DRAWN in did grow, so resolving against it would have moved the section.
    writeCutPlane(cut, registry.bounds(new THREE.Box3()));
    expect(plane()).not.toEqual(assembled);
  });
});

describe.each([
  { which: 'a flat model', spec: SYMMETRIC },
  // The nested one is the case that separates the two ways an explode can be written: a flat
  // model gives the same answer whether or not the offsets are corrected for what an ancestor
  // already contributes, so a flat-only parity test would pass an implementation that came
  // apart twice as far as it should on a real assembly.
  { which: 'a nested one', spec: NESTED },
])('parity: the two registries put every part of $which in the same place', ({ spec }) => {
  it('agrees on every part at every factor, including on the way back down', () => {
    const { meshSide, batchSide, mesh, batched } = pair(spec);
    const names = [...meshSide.idOf.keys()];

    for (const factor of [0, 0.25, 0.6, 1, 0.6, 0]) {
      mesh.setExplode(factor);
      batched.setExplode(factor);
      const one = centresOf(meshSide, mesh);
      const two = centresOf(batchSide, batched);
      for (const name of names) {
        expect(two[name].toArray(), `${name} at ${factor}`).toEqual(one[name].toArray());
      }
    }
  });
});
