// Clicking a part in the 3D view — batch BT.
//
// The resolution itself is lib/scene/clickSelection.ts and has its own test; what only
// this render can prove is WHEN a press becomes a selection and when it does not, which
// is the part that would otherwise be found by a person orbiting the camera and
// watching their selection jump:
//
//   • a press and a release in the same place selects, and a drag does not;
//   • a click on nothing clears, which is how the gizmo gets put down;
//   • outside Edit mode nothing here happens at all, so the laser, the pin drop and the
//     camera keep the clicks they have always had;
//   • a press the amber strip's gizmo has hold of is not a click, or releasing a drag
//     on a handle would deselect the very part being dragged.
//
// There is no WebGL here, so R3F's useThree is faked with a real scene, a real camera
// and a real element. The raycast is three's own against real geometry: a fake that
// answered "you hit the flange" would test the fake.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import * as THREE from 'three';

const ME = 'me';
const HASH = 'a1'.repeat(32);

interface FakeCanvas {
  gl: { domElement: HTMLElement };
  camera: THREE.Camera;
  scene: THREE.Scene;
}

const canvas = vi.hoisted(() => ({ current: null as FakeCanvas | null }));

vi.mock('@react-three/fiber', () => ({
  useThree: (selector: (state: FakeCanvas) => unknown) => {
    const state = canvas.current;
    if (!state) throw new Error('no canvas');
    return selector(state);
  },
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({ localUserId: ME }),
}));

const { default: SceneClickSelect } = await import('../SceneClickSelect');
const { useStore, selectedNodeId } = await import('../../../store');
const { sceneModelId, sceneModelPrefix } = await import('../../../lib/scene/roomScene');

const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const ROOT = `${PREFIX}_0`;
const FLANGE = `${PREFIX}_1`;

/** The canvas element, sized, because jsdom measures everything as zero. */
let element: HTMLElement;
let draggingRef: { current: boolean };

function box(rect: { left: number; top: number; width: number; height: number }): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** A tagged mesh, the way utils/modelLoader's buildSceneTree tags it. */
function tagged(id: string, size: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshStandardMaterial(),
  );
  mesh.userData.modelId = id;
  mesh.userData.nodeId = id;
  return mesh;
}

/**
 * A tagged GROUP, which is what a parsed model's root is and what buildSceneTree tags
 * on the way down. Not a mesh, so the raycast passes through it: the flange inside is
 * the only thing a ray can hit, exactly as it is in a real assembly.
 */
function taggedGroup(id: string): THREE.Group {
  const group = new THREE.Group();
  group.userData.modelId = id;
  group.userData.nodeId = id;
  return group;
}

/**
 * Mount the room: one parsed model whose root group holds one flange at the origin, a
 * camera five units back looking at it, and the store state a click reads.
 *
 * `at` is where on the 100×100 element the press lands, so a test can aim at the model
 * (50, 50 — the centre of the frame) or deliberately past it.
 */
function mountRoom(options: {
  target?: 'model' | 'part';
  editing?: { userId: string; name: string } | null;
  selected?: string | null;
} = {}) {
  const scene = new THREE.Scene();
  const wrapper = new THREE.Group();
  const root = taggedGroup(ROOT);
  const flange = tagged(FLANGE, 0.5);
  root.add(flange);
  wrapper.add(root);
  scene.add(wrapper);
  scene.updateMatrixWorld(true);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  element = document.createElement('div');
  element.getBoundingClientRect = () => box({ left: 0, top: 0, width: 100, height: 100 });
  canvas.current = { gl: { domElement: element }, camera, scene };
  draggingRef = { current: false };

  useStore.setState({
    scene: {
      models: [{
        id: MODEL_ID,
        hash: HASH,
        fileName: 'bracket.step',
        line: 'bracket',
        revision: 'A',
        visible: true,
        offset: [0, 0, 0],
      }],
      builtIn: null,
    },
    sceneEntries: {
      [MODEL_ID]: {
        id: MODEL_ID,
        group: root,
        sceneTree: {
          id: ROOT,
          name: 'bracket.step',
          type: 'GROUP' as const,
          children: [{ id: FLANGE, name: 'Flange', type: 'MESH' as const }],
        },
        fileName: 'bracket.step',
        line: 'bracket',
        revision: 'A',
        baseScale: 1,
        basePosition: new THREE.Vector3(),
        scale: 1,
        size: { x: 1, y: 1, z: 1 },
      },
    },
    objectStates: {
      [ROOT]: { id: ROOT, visible: true, selected: false, expanded: true },
      [FLANGE]: { id: FLANGE, visible: true, selected: false, expanded: true },
    },
    activeSceneModelId: null,
    reviewGizmoTarget: options.target ?? 'part',
    reviewEditing: options.editing === undefined ? { userId: ME, name: 'Me' } : options.editing,
    commentMode: 'none',
    drawingInteractionActive: false,
  });
  if (options.selected) act(() => useStore.getState().selectNode(options.selected));

  render(<SceneClickSelect draggingRef={draggingRef} />);
}

/** A press on the canvas, and the release that answers it. */
function click(from: { x: number; y: number }, to = from, button = 0) {
  act(() => {
    element.dispatchEvent(new MouseEvent('pointerdown', {
      clientX: from.x, clientY: from.y, button, bubbles: true,
    }));
  });
  act(() => {
    window.dispatchEvent(new MouseEvent('pointerup', {
      clientX: to.x, clientY: to.y, button, bubbles: true,
    }));
  });
}

const ON_THE_MODEL = { x: 50, y: 50 };
const OFF_THE_MODEL = { x: 2, y: 2 };

function selection(): string | null {
  return selectedNodeId(useStore.getState().objectStates);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  canvas.current = null;
  useStore.setState({ reviewEditing: null, reviewGizmoTarget: 'model', activeSceneModelId: null });
});

describe('clicking a model in Edit mode', () => {
  it('selects the part that was clicked, through the store action the tree uses', () => {
    mountRoom();
    click(ON_THE_MODEL);
    expect(selection()).toBe(FLANGE);
  });

  it('selects the model, and makes it the model the strip refers to, in Whole model mode', () => {
    mountRoom({ target: 'model' });
    click(ON_THE_MODEL);

    expect(selection()).toBe(ROOT);
    // The second half of what the tree's model row does: which model the scale slider
    // and the Reset buttons act on. A click that selected the root and left this alone
    // would put the gizmo on one model and the strip's numbers on another.
    expect(useStore.getState().activeSceneModelId).toBe(MODEL_ID);
  });

  it('clears the selection on a click that hit no model', () => {
    mountRoom({ selected: FLANGE });
    expect(selection()).toBe(FLANGE);

    click(OFF_THE_MODEL);
    expect(selection()).toBeNull();
  });

  it('replaces one selection with another rather than adding to it', () => {
    mountRoom({ selected: ROOT });
    click(ON_THE_MODEL);
    expect(selection()).toBe(FLANGE);
    expect(useStore.getState().objectStates[ROOT]?.selected).toBe(false);
  });
});

describe('what is NOT a click', () => {
  it('is a camera drag once the pointer has travelled further than the threshold', () => {
    mountRoom({ selected: ROOT });
    // The drag that would otherwise end by selecting whatever the orbit finished over.
    click(ON_THE_MODEL, { x: 50, y: 90 });
    expect(selection()).toBe(ROOT);
  });

  it('is not a click when the gizmo has hold of the pointer', () => {
    mountRoom({ selected: FLANGE });
    draggingRef.current = true;
    click(ON_THE_MODEL);
    // Not even a clear: releasing a drag on a handle has to leave the gizmo attached to
    // the part it was dragging, or the handles vanish at the end of every move.
    expect(selection()).toBe(FLANGE);
  });

  it('is not a click on any button but the left', () => {
    mountRoom({ selected: ROOT });
    click(ON_THE_MODEL, ON_THE_MODEL, 2);
    expect(selection()).toBe(ROOT);
  });

  it('is not a click that started outside Edit mode and ended inside it', () => {
    mountRoom({ editing: null });
    act(() => {
      element.dispatchEvent(new MouseEvent('pointerdown', {
        clientX: 50, clientY: 50, button: 0, bubbles: true,
      }));
    });
    act(() => useStore.setState({ reviewEditing: { userId: ME, name: 'Me' } }));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', {
        clientX: 50, clientY: 50, button: 0, bubbles: true,
      }));
    });
    expect(selection()).toBeNull();
  });

  it('is not a click when the click is already spoken for', () => {
    // Placing a pin is part of the SAME edit session as this — the pins tab lives in the
    // panel the amber strip swaps in — so a press that is dropping a pin must not also
    // move the selection and the gizmo with it.
    mountRoom({ selected: ROOT });
    act(() => useStore.setState({ commentMode: 'placing-pin' }));
    click(ON_THE_MODEL);
    expect(selection()).toBe(ROOT);

    act(() => useStore.setState({ commentMode: 'none', drawingInteractionActive: true }));
    click(ON_THE_MODEL);
    expect(selection()).toBe(ROOT);
  });
});

describe('outside Edit mode, clicks are exactly what they were', () => {
  it('selects nothing when nobody is editing', () => {
    mountRoom({ editing: null, selected: FLANGE });
    click(ON_THE_MODEL);
    // Neither a new selection nor a cleared one: the laser, the pin drop and the camera
    // own the pointer while the meeting is running.
    expect(selection()).toBe(FLANGE);
  });

  it('selects nothing when somebody else has the edit lock', () => {
    mountRoom({ editing: { userId: 'olga', name: 'Olga' }, selected: FLANGE });
    click(ON_THE_MODEL);
    expect(selection()).toBe(FLANGE);
  });
});
