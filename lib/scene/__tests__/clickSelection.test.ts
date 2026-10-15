// Which node a click in the 3D view selects — batch BT.
//
// The resolution is a pure function because the answer has to be the SAME id the Model
// Tree would select: an id with no row is a gizmo attached to something the person
// cannot see selected, and a tree that does not scroll to it is a tree that looks
// broken. Every case here is one shape of scene graph, and the two that matter most are
// the ones that differ by a switch — Part mode answers the mesh, Whole model mode
// answers the model's root — because they are the same click on the same triangle.
//
// The last two describes are task 04b's. `laserSelectionId` is lib/pickSelectionId.ts
// moved here and its cases moved with it, because the laser's granularity switch and
// the click were two copies of one parent walk and the audit's R9 is that porting one
// without the other recreates the disagreement this file exists to prevent. The
// registry describe proves the two paths agree: the same scene graph resolved through a
// MeshPartRegistry and through the legacy tag walk must answer identically, or swapping
// the renderer underneath in stage 4 would silently move the selection.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  CLICK_DRAG_THRESHOLD_PX,
  clickedNodeId,
  isClick,
  isTextInput,
  laserSelectionId,
} from '../clickSelection';
import { MeshPartRegistry, hitParts, type PartRegistry, type PickHit } from '../partRegistry';
import { sceneModelId, sceneModelPrefix, type SceneModel } from '../roomScene';
import type { SceneNode } from '../../../types';

const HASH = 'a1'.repeat(32);
const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const ROOT = `${PREFIX}_0`;
const HOUSING = `${PREFIX}_1`;
const FLANGE = `${PREFIX}_2`;
/** A built-in's root and one of its meshes: tagged the way Headphones.tsx tags them. */
const BUILT_IN_ROOT = 'headphones_0';
const BUILT_IN_MESH = 'headphones_3';

const MODEL: SceneModel = {
  id: MODEL_ID,
  hash: HASH,
  fileName: 'bracket.step',
  line: 'bracket',
  revision: 'A',
  visible: true,
  offset: [0, 0, 0],
};

/**
 * A mesh, tagged the way utils/modelLoader's buildSceneTree tags every object it walks:
 * the same id in both fields, because a node's id IS the id its geometry carries.
 */
function mesh(id: string): THREE.Mesh {
  const node = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  node.userData.modelId = id;
  node.userData.nodeId = id;
  return node;
}

function group(id: string): THREE.Group {
  const node = new THREE.Group();
  node.userData.modelId = id;
  node.userData.nodeId = id;
  return node;
}

/** What a raycaster hands back, narrowed to the three fields a part lookup may read. */
function hitOf(object: THREE.Object3D): PickHit {
  return { object };
}

/**
 * The tree the Model Tree shows, as a set of ids.
 *
 * HOUSING is missing on purpose: buildSceneTree tags a group whose only child is a
 * mesh, and collapseSingleChildGroups then promotes the child and drops the group's
 * row. The group still carries its id in userData, so it is exactly the case where
 * "the nearest tagged ancestor" is an id nothing can highlight.
 */
const LISTED = new Set([ROOT, FLANGE, BUILT_IN_ROOT, BUILT_IN_MESH]);

function context(target: 'model' | 'part', registries: readonly PartRegistry[] = []) {
  return {
    target,
    models: [MODEL],
    registries,
    rootIdOf: (modelId: string) => (modelId === MODEL_ID ? ROOT : null),
    lists: (id: string) => LISTED.has(id),
  };
}

describe('isClick', () => {
  it('is a click within the threshold, and a camera drag beyond it', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(true);
    expect(isClick({ x: 100, y: 100 }, { x: 102, y: 101 })).toBe(true);
    // Exactly at the threshold is still a click: a hand holding a mouse moves it a
    // pixel or two, and the number exists to forgive that, not to punish it.
    expect(isClick({ x: 100, y: 100 }, { x: 100 + CLICK_DRAG_THRESHOLD_PX, y: 100 })).toBe(true);
    expect(isClick({ x: 100, y: 100 }, { x: 100 + CLICK_DRAG_THRESHOLD_PX + 1, y: 100 })).toBe(false);
  });

  it('measures the straight line, so an orbit straight up the screen is still a drag', () => {
    expect(isClick({ x: 100, y: 100 }, { x: 100, y: 130 })).toBe(false);
    // Three pixels on both axes is 4.2 of travel, which is past the threshold: the
    // test is the diagonal, and the diagonal is the one a per-axis test would miss.
    expect(isClick({ x: 100, y: 100 }, { x: 102, y: 102 })).toBe(true);
    expect(isClick({ x: 100, y: 100 }, { x: 103, y: 103 })).toBe(false);
  });

  it('takes its own threshold, so the number can be pinned without being retyped', () => {
    expect(isClick({ x: 0, y: 0 }, { x: 40, y: 0 }, 50)).toBe(true);
    expect(isClick({ x: 0, y: 0 }, { x: 40, y: 0 }, 10)).toBe(false);
  });
});

describe('isTextInput', () => {
  const element = (tag: string, editable = false) => {
    const node = document.createElement(tag);
    if (editable) {
      node.contentEditable = 'true';
      // jsdom sets the attribute but never computes the property from it, so this says
      // what a browser reports for the element just built. The function under test
      // reads the property, which is the one thing a real contenteditable has.
      Object.defineProperty(node, 'isContentEditable', { value: true });
    }
    return node;
  };

  it('is true for the fields where Ctrl+Z belongs to the browser', () => {
    expect(isTextInput(element('input'))).toBe(true);
    expect(isTextInput(element('textarea'))).toBe(true);
    expect(isTextInput(element('select'))).toBe(true);
    expect(isTextInput(element('div', true))).toBe(true);
  });

  it('is false everywhere else, including nothing focused at all', () => {
    expect(isTextInput(element('div'))).toBe(false);
    expect(isTextInput(element('button'))).toBe(false);
    expect(isTextInput(document.body)).toBe(false);
    expect(isTextInput(null)).toBe(false);
  });
});

describe('clickedNodeId', () => {
  /** root group > housing group (no row) > flange mesh */
  function assembly(): { root: THREE.Group; flange: THREE.Mesh } {
    const root = group(ROOT);
    const housing = group(HOUSING);
    const flange = mesh(FLANGE);
    housing.add(flange);
    root.add(housing);
    root.updateMatrixWorld(true);
    return { root, flange };
  }

  it('selects the clicked mesh in Part mode', () => {
    const { flange } = assembly();
    expect(clickedNodeId(hitOf(flange), context('part'))).toBe(FLANGE);
  });

  it('selects the model\'s own root in Whole model mode, not the mesh that was clicked', () => {
    const { flange } = assembly();
    expect(clickedNodeId(hitOf(flange), context('model'))).toBe(ROOT);
  });

  it('walks up to the nearest node the tree lists when the mesh\'s own group has no row', () => {
    const { root } = assembly();
    const housing = root.children[0];
    // The housing group is tagged but collapsed away, so it is not a row. Its child is,
    // and a click that answered the group would light up a gizmo and no tree row.
    expect(LISTED.has(HOUSING)).toBe(false);
    expect(clickedNodeId(hitOf(housing), context('part'))).toBe(ROOT);
  });

  it('falls back to the tagged chain for a model the scene does not hold', () => {
    // A built-in's meshes carry the ROOT id as their modelId and their own id as their
    // nodeId, and there is no SceneModel behind them to trace a root through. Nor is
    // there a PartRegistry: components/Scene/Product.tsx builds its parts in React and
    // never parses a file, so the tag walk is still the only resolution it has.
    const root = new THREE.Group();
    root.userData.nodeId = BUILT_IN_ROOT;
    const cup = mesh(BUILT_IN_MESH);
    cup.userData.modelId = BUILT_IN_ROOT;
    root.add(cup);
    root.updateMatrixWorld(true);

    expect(clickedNodeId(hitOf(cup), context('part'))).toBe(BUILT_IN_MESH);
    expect(clickedNodeId(hitOf(cup), context('model'))).toBe(BUILT_IN_ROOT);
  });

  it('answers nothing for a click that hit no model at all', () => {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
    expect(clickedNodeId(hitOf(floor), context('part'))).toBeNull();
    expect(clickedNodeId(null, context('part'))).toBeNull();
  });

  it('answers nothing for something the raycaster was told to ignore', () => {
    const { flange } = assembly();
    flange.userData.skipRaycast = true;
    expect(clickedNodeId(hitOf(flange), context('part'))).toBeNull();

    // An ancestor's flag covers the whole subtree, the way the laser's own walk does:
    // an avatar standing in front of a model is not a way to select the model.
    const { root } = assembly();
    root.userData.skipRaycast = true;
    const inside = root.children[0].children[0];
    expect(clickedNodeId(hitOf(inside), context('part'))).toBeNull();
  });

  it('answers nothing for a node the tree has never heard of', () => {
    // A model still downloading has no rows, and selecting an id with no state would
    // silently do nothing at all — the store's selectNode ignores it — so the honest
    // answer is that there is nothing to select.
    const { flange } = assembly();
    const strict = { ...context('part'), lists: () => false };
    expect(clickedNodeId(hitOf(flange), strict)).toBeNull();
  });
});

describe('clickedNodeId through a model\'s part registry', () => {
  /**
   * The same assembly, resolved through the registry a parsed model carries instead of
   * through the tags on its objects.
   *
   * Every answer here is the one the describe above gets for the same scene graph, and
   * that is the assertion: stage 4 replaces MeshPartRegistry with one backed by
   * BatchedMeshes, where there are no per-part objects left to read a tag off, and a
   * click has to keep selecting exactly what it selects today.
   */
  function assembly(): { root: THREE.Group; flange: THREE.Mesh; registries: PartRegistry[] } {
    const root = group(ROOT);
    const housing = group(HOUSING);
    const flange = mesh(FLANGE);
    flange.name = 'Flange';
    housing.add(flange);
    root.add(housing);
    root.updateMatrixWorld(true);
    // What collapseSingleChildGroups leaves in the store: the housing group had one
    // child, so the child took its row and the group's own row is gone.
    const tree: SceneNode = {
      id: ROOT,
      name: 'bracket.step',
      type: 'GROUP',
      children: [{ id: FLANGE, name: 'Flange', type: 'MESH' }],
    };
    return { root, flange, registries: [new MeshPartRegistry(root, tree)] };
  }

  it('answers the same id in both modes as the tag walk does', () => {
    const { flange, registries } = assembly();
    expect(clickedNodeId(hitOf(flange), context('part', registries))).toBe(FLANGE);
    expect(clickedNodeId(hitOf(flange), context('model', registries))).toBe(ROOT);
  });

  it('still walks up through a group the tree collapsed away', () => {
    const { root, registries } = assembly();
    expect(clickedNodeId(hitOf(root.children[0]), context('part', registries))).toBe(ROOT);
  });

  it('still refuses a part whose model is marked skipRaycast', () => {
    const own = assembly();
    own.flange.userData.skipRaycast = true;
    expect(clickedNodeId(hitOf(own.flange), context('part', own.registries))).toBeNull();

    // An ancestor's flag covers the subtree, exactly as it does for the tag walk.
    const ancestor = assembly();
    ancestor.root.userData.skipRaycast = true;
    expect(clickedNodeId(hitOf(ancestor.flange), context('part', ancestor.registries))).toBeNull();
  });

  it('leaves a hit no registry owns to the tag walk', () => {
    // The floor is not inside any model, so every registry answers "not mine" and the
    // resolution falls through — which is what makes a click on empty space clear the
    // selection rather than select the nearest product.
    const { registries } = assembly();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
    expect(clickedNodeId(hitOf(floor), context('part', registries))).toBeNull();
  });
});

describe('laserSelectionId', () => {
  // The seven cases lib/pickSelectionId.ts had, unchanged in what they assert. They
  // resolve through hitParts with no registry, which is the tag walk pickSelectionId
  // did by hand; the last case proves a registry answers the same thing.
  const resolve = (object: THREE.Object3D | null, registries: readonly PartRegistry[] = []) =>
    hitParts(object ? hitOf(object) : null, registries);

  const tagged = (userData: Record<string, unknown> = {}): THREE.Object3D => {
    const obj = new THREE.Object3D();
    Object.assign(obj.userData, userData);
    return obj;
  };

  it('answers nothing for no hit at all', () => {
    expect(laserSelectionId(resolve(null), 'part')).toBeNull();
    expect(laserSelectionId(resolve(null), 'model')).toBeNull();
  });

  it('answers nothing when no ancestor names a model', () => {
    const parts = resolve(tagged({ nodeId: 'node_1' }));
    expect(laserSelectionId(parts, 'part')).toBeNull();
    expect(laserSelectionId(parts, 'model')).toBeNull();
  });

  it('answers nothing when an ancestor has skipRaycast', () => {
    const parent = tagged({ skipRaycast: true, modelId: 'root' });
    const child = tagged({ nodeId: 'node_1' });
    parent.add(child);
    expect(laserSelectionId(resolve(child), 'part')).toBeNull();
    expect(laserSelectionId(resolve(child), 'model')).toBeNull();
  });

  it('answers the model for model granularity', () => {
    const root = tagged({ modelId: 'headphones_assembly' });
    const child = tagged({ nodeId: 'headphones_0' });
    root.add(child);
    expect(laserSelectionId(resolve(child), 'model')).toBe('headphones_assembly');
  });

  it('answers the nearest part for part granularity', () => {
    const root = tagged({ modelId: 'headphones_assembly', nodeId: 'headphones_root' });
    const mid = tagged({ nodeId: 'headphones_1' });
    const leaf = tagged({ nodeId: 'headphones_2' });
    root.add(mid);
    mid.add(leaf);
    expect(laserSelectionId(resolve(leaf), 'part')).toBe('headphones_2');
  });

  it('falls back to the model when the hit object carries no id of its own', () => {
    const root = tagged({ modelId: 'headphones_assembly' });
    const leaf = tagged({});
    root.add(leaf);
    expect(laserSelectionId(resolve(leaf), 'part')).toBe('headphones_assembly');
  });

  it('points through an avatar and a beam to the model behind them', () => {
    const root = tagged({ modelId: 'root' });
    const agent = tagged({ nodeId: 'agent_node' });
    agent.name = 'Agent_1';
    const leaf = tagged({ nodeId: 'mesh_node' });
    root.add(agent);
    agent.add(leaf);

    const line = new THREE.Line();
    line.userData = { nodeId: 'line_node' };
    root.add(line);

    // The avatar is not the product, but the part inside it is: only the avatar's own id
    // is skipped, not the walk past it.
    expect(laserSelectionId(resolve(leaf), 'part')).toBe('mesh_node');
    expect(laserSelectionId(resolve(line), 'part')).toBe('root');
  });

  it('answers the same through a registry as through the tags', () => {
    const root = group(ROOT);
    const flange = mesh(FLANGE);
    root.add(flange);
    root.updateMatrixWorld(true);
    const registries = [new MeshPartRegistry(root)];

    expect(laserSelectionId(resolve(flange, registries), 'part')).toBe(FLANGE);
    // An imported model stamps a node's own id into BOTH userData fields, so 'model'
    // granularity names the nearest part too; clickedNodeId is what turns that into the
    // model's root, by asking the scene rather than the tags.
    expect(laserSelectionId(resolve(flange, registries), 'model')).toBe(FLANGE);
    expect(laserSelectionId(resolve(flange, registries), 'part'))
      .toBe(laserSelectionId(resolve(flange), 'part'));
  });
});

