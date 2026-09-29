// Which node a click in the 3D view selects — batch BT.
//
// The resolution is a pure function because the answer has to be the SAME id the Model
// Tree would select: an id with no row is a gizmo attached to something the person
// cannot see selected, and a tree that does not scroll to it is a tree that looks
// broken. Every case here is one shape of scene graph, and the two that matter most are
// the ones that differ by a switch — Part mode answers the mesh, Whole model mode
// answers the model's root — because they are the same click on the same triangle.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  CLICK_DRAG_THRESHOLD_PX,
  clickedNodeId,
  isClick,
  isTextInput,
} from '../clickSelection';
import { sceneModelId, sceneModelPrefix, type SceneModel } from '../roomScene';

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

/**
 * The tree the Model Tree shows, as a set of ids.
 *
 * HOUSING is missing on purpose: buildSceneTree tags a group whose only child is a
 * mesh, and collapseSingleChildGroups then promotes the child and drops the group's
 * row. The group still carries its id in userData, so it is exactly the case where
 * "the nearest tagged ancestor" is an id nothing can highlight.
 */
const LISTED = new Set([ROOT, FLANGE, BUILT_IN_ROOT, BUILT_IN_MESH]);

function context(target: 'model' | 'part') {
  return {
    target,
    models: [MODEL],
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
    expect(clickedNodeId(flange, context('part'))).toBe(FLANGE);
  });

  it('selects the model\'s own root in Whole model mode, not the mesh that was clicked', () => {
    const { flange } = assembly();
    expect(clickedNodeId(flange, context('model'))).toBe(ROOT);
  });

  it('walks up to the nearest node the tree lists when the mesh\'s own group has no row', () => {
    const { root } = assembly();
    const housing = root.children[0];
    // The housing group is tagged but collapsed away, so it is not a row. Its child is,
    // and a click that answered the group would light up a gizmo and no tree row.
    expect(LISTED.has(HOUSING)).toBe(false);
    expect(clickedNodeId(housing, context('part'))).toBe(ROOT);
  });

  it('falls back to the tagged chain for a model the scene does not hold', () => {
    // A built-in's meshes carry the ROOT id as their modelId and their own id as their
    // nodeId, and there is no SceneModel behind them to trace a root through.
    const root = new THREE.Group();
    root.userData.nodeId = BUILT_IN_ROOT;
    const cup = mesh(BUILT_IN_MESH);
    cup.userData.modelId = BUILT_IN_ROOT;
    root.add(cup);
    root.updateMatrixWorld(true);

    expect(clickedNodeId(cup, context('part'))).toBe(BUILT_IN_MESH);
    expect(clickedNodeId(cup, context('model'))).toBe(BUILT_IN_ROOT);
  });

  it('answers nothing for a click that hit no model at all', () => {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
    expect(clickedNodeId(floor, context('part'))).toBeNull();
    expect(clickedNodeId(null, context('part'))).toBeNull();
  });

  it('answers nothing for something the raycaster was told to ignore', () => {
    const { flange } = assembly();
    flange.userData.skipRaycast = true;
    expect(clickedNodeId(flange, context('part'))).toBeNull();

    // An ancestor's flag covers the whole subtree, the way the laser's own walk does:
    // an avatar standing in front of a model is not a way to select the model.
    const { root } = assembly();
    root.userData.skipRaycast = true;
    const inside = root.children[0].children[0];
    expect(clickedNodeId(inside, context('part'))).toBeNull();
  });

  it('answers nothing for a node the tree has never heard of', () => {
    // A model still downloading has no rows, and selecting an id with no state would
    // silently do nothing at all — the store's selectNode ignores it — so the honest
    // answer is that there is nothing to select.
    const { flange } = assembly();
    const strict = { ...context('part'), lists: () => false };
    expect(clickedNodeId(flange, strict)).toBeNull();
  });
});
