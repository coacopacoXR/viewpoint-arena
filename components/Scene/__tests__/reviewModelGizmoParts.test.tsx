// The gizmo in Part mode — batch BR.
//
// What only this render can prove is WHICH object the drag is attached to and WHAT
// goes on the wire when it ends. The strip's switch writes `reviewGizmoTarget`; this
// is the component that reads it, and the two things it must not get wrong are:
//
//   • attaching to the part rather than to the model. Attaching to the wrapper group
//     would still feel like it worked — the handles appear, the thing moves — and
//     would write a whole-model transform for a drag the person meant as one bolt.
//   • writing the part's LOCAL transform as an override, not as a delta on it. See
//     lib/scene/partTransforms.ts for why the distinction is the whole feature.
//
// And the two edges: a model's own root selected in Part mode is the whole model, and
// a part id that resolves to no object gets NO gizmo rather than a quiet fallback to
// moving the product.
//
// Task 04b stage 3 moved the thing the gizmo attaches to. A part is addressed by id
// through the model's registry now, and since drei's TransformControls is the one
// consumer that genuinely needs a real Object3D, the registry hands over ONE per model —
// parked in the selected part's own parent and carrying the part's own local transform.
// So what these tests drag is that proxy, and what they assert is both halves of the
// seam: the numbers read off the proxy are the override that goes on the wire, and the
// numbers written back through the handle are where the part ends up.
//
// drei's TransformControls is faked, because there is no WebGL here; what stands in
// for a drag is the proxy's transform plus the callbacks the real gizmo fires.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import * as THREE from 'three';
import type { ReviewDraft } from '../../../lib/reviewSetupStore';
import type { SceneUpdate } from '../../../lib/scene/roomScene';
import { MeshPartRegistry } from '../../../lib/scene/partRegistry';

const ME = 'me';
const HASH = 'a1'.repeat(32);

interface CapturedGizmo {
  object: THREE.Object3D;
  mode: string;
  onMouseDown: () => void;
  onMouseUp: () => void;
  onObjectChange: () => void;
}

const gizmo = vi.hoisted(() => ({ current: null as CapturedGizmo | null }));
const wire = vi.hoisted(() => ({
  sceneUpdates: [] as SceneUpdate[],
  reviewConfigs: [] as ReviewDraft[],
}));

// useFrame needs a Canvas; the callbacks are kept so a test can step a frame by hand.
const frames = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }));
vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: () => void) => {
    frames.callbacks.push(callback);
  },
}));

vi.mock('@react-three/drei', () => ({
  TransformControls: (props: CapturedGizmo) => {
    gizmo.current = props;
    return null;
  },
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: ME,
    remoteParticipantList: [],
    broadcastSceneUpdate: (update: SceneUpdate) => {
      wire.sceneUpdates.push(update);
      return true;
    },
    broadcastReviewConfig: (draft: ReviewDraft) => {
      wire.reviewConfigs.push(draft);
      return true;
    },
  }),
}));

const { default: ReviewModelGizmo } = await import('../ReviewModelGizmo');
const { useStore } = await import('../../../store');
const { useActiveReviewStore } = await import('../../../lib/activeReviewStore');
const { useEditHistory } = await import('../../../lib/scene/editHistory');
const { forgetLocalEdit } = await import('../../../lib/reviewLocalEdit');
const { createReviewDraft } = await import('../../../lib/reviewSetupStore');
const { sceneModelId, sceneModelPrefix } = await import('../../../lib/scene/roomScene');

const controlsRef: { current: { enabled: boolean } | null } = { current: null };

const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const ROOT = `${PREFIX}_0`;
const FLANGE = `${PREFIX}_1`;
const BOLT = `${PREFIX}_2`;

/** The rendered wrapper group, the parsed model inside it, and its registry. */
let wrapper: THREE.Group;
let flange: THREE.Mesh;
let registry: MeshPartRegistry;

/** A node tagged the way utils/modelLoader's buildSceneTree tags it. */
function part(parent: THREE.Object3D, id: string, at: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.userData.modelId = id;
  mesh.position.set(at[0], at[1], at[2]);
  parent.add(mesh);
  return mesh;
}

function mountGizmo(options: { target?: 'model' | 'part'; selected?: string | null } = {}) {
  const target = options.target ?? 'part';
  const selected = options.selected === undefined ? FLANGE : options.selected;

  const group = new THREE.Group();
  group.userData.modelId = ROOT;
  flange = part(group, FLANGE, [1, 2, 3]);
  part(group, BOLT, [0, 0, 0]);
  wrapper = new THREE.Group();
  wrapper.add(group);

  const sceneTree = {
    id: ROOT,
    name: 'bracket.step',
    type: 'GROUP' as const,
    children: [
      { id: FLANGE, name: 'Flange', type: 'MESH' as const },
      { id: BOLT, name: 'M8 bolt', type: 'MESH' as const },
    ],
  };

  // The scene FIRST and the selection after, in that order: adopting a scene with
  // `fresh` rebuilds every node's state from the tree, so an objectStates written
  // before it would have been wiped — including the selection this whole test is
  // about. sceneEntries has to be there before it too, because the tree the states
  // are built from is derived from the scene AND the parsed geometry.
  registry = new MeshPartRegistry(group, sceneTree);
  useStore.setState({
    sceneEntries: {
      [MODEL_ID]: {
        id: MODEL_ID,
        group,
        sceneTree,
        partRegistry: registry,
        fileName: 'bracket.step',
        line: 'bracket',
        revision: 'A',
        baseScale: 1,
        basePosition: new THREE.Vector3(),
        scale: 1,
        size: { x: 1, y: 1, z: 1 },
      },
    },
  });
  useStore.getState().setRoomScene({
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
  }, { fresh: true });
  if (selected) {
    // Through the store's own action, the way the Model Tree and the laser both do
    // it. A node the tree does not hold needs a state of its own first, which is
    // exactly the stale-id case.
    if (!useStore.getState().objectStates[selected]) {
      useStore.setState((state) => ({
        objectStates: {
          ...state.objectStates,
          [selected]: { id: selected, visible: true, selected: false, expanded: true },
        },
      }));
    }
    useStore.getState().selectNode(selected);
  }
  useStore.setState({
    reviewGizmoMode: 'translate',
    reviewGizmoTarget: target,
    reviewEditing: { userId: ME, name: 'Me' },
    activeSceneModelId: MODEL_ID,
    sceneModelGroups: { [MODEL_ID]: wrapper },
  });
  useActiveReviewStore.getState().setConfig(createReviewDraft('room-1', 'Landing gear review'));
  forgetLocalEdit();
  wire.sceneUpdates.length = 0;
  wire.reviewConfigs.length = 0;
  gizmo.current = null;
  frames.callbacks.length = 0;

  render(<ReviewModelGizmo controlsRef={controlsRef} />);
  return gizmo.current;
}

function partsInStore() {
  return useStore.getState().scene.models[0].parts;
}

/**
 * What a drag does to the object the gizmo is holding.
 *
 * Written against `handles.object` rather than against a proxy captured out of the
 * registry, so each test drags whatever the component actually attached — the gizmo does
 * not know whether that is the part itself or a stand-in for it, and neither should these.
 */
function dragPart(handles: CapturedGizmo, over: {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}) {
  if (over.position) handles.object.position.set(...over.position);
  if (over.rotation) handles.object.rotation.set(...over.rotation);
  if (over.scale) handles.object.scale.set(...over.scale);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  useStore.setState({ reviewGizmoMode: null, reviewGizmoTarget: 'model' });
  useActiveReviewStore.setState({ config: null });
});

describe('ReviewModelGizmo — Part mode', () => {
  it('attaches to the selected part and not to the model', () => {
    const handles = mountGizmo();

    expect(handles).not.toBeNull();
    expect(handles?.object).not.toBe(wrapper);
    // Not the part's own object either, and that is the seam: the registry parks ONE proxy
    // per model in the selected part's own parent, carrying the part's own local transform.
    // Sharing the parent is what makes the numbers read off it the numbers a PartTransform
    // carries, and the numbers written back through the handle the part's new pose.
    expect(handles?.object).not.toBe(flange);
    expect(handles?.object?.parent).toBe(flange.parent);
    expect(handles?.object?.position.toArray()).toEqual([1, 2, 3]);
  });

  it('sends the part\'s local transform as an override when the drag ends', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    dragPart(handles, { position: [5, 0, 0], scale: [2, 1, 1] });
    handles.onMouseUp();

    expect(wire.sceneUpdates).toEqual([{
      op: 'setPartTransform',
      id: MODEL_ID,
      nodeId: FLANGE,
      transform: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] },
    }]);
    expect(partsInStore()).toEqual({ [FLANGE]: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 1] } });
    // And the model itself did not move, which is the mistake this mode exists to
    // avoid making: the wrapper's transform is untouched and so is SceneModel.offset.
    expect(useStore.getState().scene.models[0].offset).toEqual([0, 0, 0]);
    expect(wrapper.position.toArray()).toEqual([0, 0, 0]);
  });

  it('moves the part on every frame of the drag, not only when the throttled echo lands', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    dragPart(handles, { position: [2, 0, 0] });
    handles.onObjectChange();

    // A wire message goes out ten times a second at most, and the handles move on every
    // pointer move: without this the arrows would slide smoothly over a part that jumped
    // after them. It is also the first write the part sees, which is when its handle takes
    // the file's own transform.
    expect(flange.position.toArray()).toEqual([2, 0, 0]);
    expect(registry.get(FLANGE)?.bindPose().position).toEqual([1, 2, 3]);
    expect(registry.movedPartIds()).toEqual([FLANGE]);
  });

  it('keeps the handles on the part when something else moves it while it is selected', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    // The proxy is parked during render, but an undo, a "Reset part" or a remote edit moves
    // the part afterwards, in SceneModelView's effect. Without a re-park the handles would
    // stay where the part was, and the next drag would push that stale pose onto it.
    registry.get(FLANGE)?.setLocalTransform({ position: [7, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    frames.callbacks.forEach((callback) => callback());
    expect(handles.object.position.toArray()).toEqual([7, 0, 0]);

    // And never mid-drag: then the proxy is the source of truth.
    handles.onMouseDown();
    dragPart(handles, { position: [9, 0, 0] });
    frames.callbacks.forEach((callback) => callback());
    expect(handles.object.position.toArray()).toEqual([9, 0, 0]);
    handles.onMouseUp();
  });

  it('writes the moved part into the review, which is what outlives the room', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    dragPart(handles, { position: [5, 0, 0] });
    handles.onMouseUp();

    const config = useActiveReviewStore.getState().config;
    expect(config?.asset.placements?.[0].parts).toEqual({
      [FLANGE]: { position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(wire.reviewConfigs).toHaveLength(1);
    expect(wire.reviewConfigs[0]).toBe(config);
  });

  it('keeps the file\'s own transform, taken before the drag moved anything', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');
    const part = registry.get(FLANGE)!;

    handles.onMouseDown();
    dragPart(handles, { position: [5, 0, 0] });
    handles.onObjectChange();
    handles.onMouseUp();

    expect(part.bindPose()).toEqual({ position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] });

    // Which is what makes "Reset part" put the flange back where the FILE had it rather
    // than where the drag happened to end. The delete itself is the room server's, and
    // putting the part back is lib/scene/partTransforms.test.ts's to prove; what has to
    // hold here is that the number it will restore survived the drag.
    act(() => useStore.getState().applyLocalSceneUpdate({
      op: 'setPartTransform',
      id: MODEL_ID,
      nodeId: FLANGE,
      transform: null,
    }));
    expect(partsInStore()).toBeUndefined();
    expect(part.bindPose().position).toEqual([1, 2, 3]);
  });

  it('clamps a scale dragged through zero to the file\'s own number on that axis', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    dragPart(handles, { scale: [3, 0, -1] });
    handles.onMouseUp();

    // The wire refuses a part scaled to nothing, and a refused drag would leave this
    // browser showing what the room does not have. The usable axis is kept.
    expect(wire.sceneUpdates[0]).toMatchObject({
      op: 'setPartTransform',
      transform: { scale: [3, 1, 1] },
    });
  });

  it('treats the model\'s own root as the whole model', () => {
    const handles = mountGizmo({ selected: ROOT });
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    expect(handles.object).toBe(wrapper);

    wrapper.position.set(4, 0, 0);
    handles.onMouseUp();

    expect(wire.sceneUpdates).toEqual([{
      op: 'setTransform',
      id: MODEL_ID,
      transform: { offset: [4, 0, 0], rotation: [0, 0, 0], scale: 1 },
    }]);
    expect(partsInStore()).toBeUndefined();
  });

  it('renders no gizmo at all for a part id that resolves to nothing', () => {
    // A stale node id — a file replaced under a model, a tree from a parse that was
    // thrown away. Falling back to the wrapper here would move the whole product
    // when the person meant to move one bolt of it.
    const handles = mountGizmo({ selected: `${PREFIX}_404` });
    expect(handles).toBeNull();
  });

  it('renders no gizmo when nothing is selected', () => {
    expect(mountGizmo({ selected: null })).toBeNull();
  });

  it('still moves the whole model in Whole model mode, with a part selected or not', () => {
    // The regression this batch must not cause: the switch defaults to 'model', and
    // in that mode the selection is not consulted at all.
    const handles = mountGizmo({ target: 'model', selected: FLANGE });
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    expect(handles.object).toBe(wrapper);

    wrapper.position.set(4, 0, -1);
    wrapper.rotation.set(0, 1.5708, 0);
    wrapper.scale.set(2, 2, 2);
    handles.onMouseUp();

    expect(wire.sceneUpdates).toEqual([{
      op: 'setTransform',
      id: MODEL_ID,
      transform: { offset: [4, 0, -1], rotation: [0, 1.5708, 0], scale: 2 },
    }]);
    expect(partsInStore()).toBeUndefined();
  });

  it('throttles a part drag the way it throttles a model drag', () => {
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    dragPart(handles, { position: [1, 0, 0] });
    handles.onObjectChange();
    dragPart(handles, { position: [2, 0, 0] });
    handles.onObjectChange();
    dragPart(handles, { position: [3, 0, 0] });
    handles.onObjectChange();

    // One message went out and the review was not written at all yet: each of these
    // would be a whole review on the socket and a row written a second later. The part
    // itself, though, moved on every one of them — that is the write-back, not the wire.
    expect(wire.sceneUpdates.length).toBeLessThanOrEqual(1);
    expect(wire.reviewConfigs).toHaveLength(0);
    expect(flange.position.toArray()).toEqual([3, 0, 0]);

    handles.onMouseUp();

    expect(wire.reviewConfigs).toHaveLength(1);
    expect(partsInStore()?.[FLANGE].position).toEqual([3, 0, 0]);
  });

  it('is ONE step of history for a whole drag, and not one per frame', () => {
    // Batch BT. onObjectChange fires on every pointer move, so a history recorded there
    // would be a hundred steps for one move — and Ctrl+Z would appear to do nothing at
    // all, because the first hundred presses would walk back through one drag.
    useEditHistory.getState().clear();
    const handles = mountGizmo();
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    dragPart(handles, { position: [1, 0, 0] });
    handles.onObjectChange();
    dragPart(handles, { position: [2, 0, 0] });
    handles.onObjectChange();
    dragPart(handles, { position: [3, 0, 0] });
    handles.onObjectChange();
    handles.onMouseUp();

    const history = useEditHistory.getState();
    expect(history.steps).toHaveLength(1);
    expect(history.steps[0].label).toContain('bracket');
    expect(history.steps[0].before[0].parts).toBeUndefined();
    expect(history.steps[0].after[0].parts?.[FLANGE].position).toEqual([3, 0, 0]);
    expect(history.cursor).toBe(1);
  });

  it('records no step for a drag that ended where it started', () => {
    useEditHistory.getState().clear();
    const handles = mountGizmo({ target: 'model' });
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    handles.onMouseUp();

    // Somebody who took hold of a handle and put it down again has not made an edit,
    // and a step for it is a Ctrl+Z that appears to do nothing.
    expect(useEditHistory.getState().steps).toHaveLength(0);
  });

  it('says which model a drag was against, so four undos can be told apart', () => {
    useEditHistory.getState().clear();
    const handles = mountGizmo({ target: 'model' });
    if (!handles) throw new Error('the gizmo rendered no TransformControls');

    handles.onMouseDown();
    wrapper.position.set(4, 0, 0);
    handles.onMouseUp();

    expect(useEditHistory.getState().steps[0].label).toBe('Moved bracket · Rev A');
  });
});
