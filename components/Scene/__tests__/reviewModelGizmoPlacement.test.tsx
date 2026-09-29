// Where a model was left, written when the drag ends — batch BI's third section.
//
// The gizmo already sent the transform to the room server, which persists it with
// its scene. Room storage is the ROOM's, though: a review opened again next month,
// from the lobby, on an install whose server hibernated, would have put every model
// back where it arrived rather than where it was left. So the drag also writes the
// review's own copy, per revision.
//
// What only this render can prove is the moment it happens and what it costs. Once
// per drag and not once per frame — onObjectChange fires on every pointer move, and
// each of these is a whole review broadcast to everybody in the room plus a row
// written a second later. And not at all when the drag ended where it started.
//
// drei's TransformControls is faked, because there is no WebGL here; what stands in
// for a drag is the group's transform plus the two callbacks the real gizmo fires.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as THREE from 'three';
import type { ReviewDraft } from '../../../lib/reviewSetupStore';
import type { SceneUpdate } from '../../../lib/scene/roomScene';

const ME = 'me';
const HASH = 'a1'.repeat(32);

interface CapturedGizmo {
  onMouseDown: () => void;
  onMouseUp: () => void;
  onObjectChange: () => void;
}

const gizmo = vi.hoisted(() => ({ current: null as CapturedGizmo | null }));
const wire = vi.hoisted(() => ({
  sceneUpdates: [] as SceneUpdate[],
  reviewConfigs: [] as ReviewDraft[],
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
const { consumeLocalEdit, forgetLocalEdit } = await import('../../../lib/reviewLocalEdit');
const { createReviewDraft } = await import('../../../lib/reviewSetupStore');

const controlsRef: { current: { enabled: boolean } | null } = { current: null };

/** The room's one model, as a group the gizmo can be handed. */
let group: THREE.Group;

function mountGizmo() {
  group = new THREE.Group();
  useStore.setState({
    reviewGizmoMode: 'translate',
    reviewEditing: { userId: ME, name: 'Me' },
    activeSceneModelId: 'model-1',
    sceneModelGroups: { 'model-1': group },
    sceneEntries: {},
  });
  useStore.getState().setRoomScene({
    models: [{
      id: 'model-1',
      hash: HASH,
      fileName: 'bracket.step',
      line: 'bracket',
      revision: 'A',
      visible: true,
      offset: [0, 0, 0],
    }],
    builtIn: null,
  }, { fresh: true });
  useActiveReviewStore.getState().setConfig(createReviewDraft('room-1', 'Landing gear review'));
  forgetLocalEdit();
  wire.sceneUpdates.length = 0;
  wire.reviewConfigs.length = 0;
  gizmo.current = null;

  render(<ReviewModelGizmo controlsRef={controlsRef} />);
  if (!gizmo.current) throw new Error('the gizmo rendered no TransformControls');
  return gizmo.current;
}

/** What a drag does to the object the gizmo is holding. */
function dragTo(position: [number, number, number], rotationY = 0, scale = 1) {
  group.position.set(position[0], position[1], position[2]);
  group.rotation.set(0, rotationY, 0);
  group.scale.set(scale, scale, scale);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('ReviewModelGizmo — the review\'s copy of a placement', () => {
  it('sends the transform to the room, as it always did', () => {
    const handles = mountGizmo();
    dragTo([4, 0, -1]);

    handles.onMouseUp();

    expect(wire.sceneUpdates).toEqual([{
      op: 'setTransform',
      id: 'model-1',
      transform: { offset: [4, 0, -1], rotation: [0, 0, 0], scale: 1 },
    }]);
    expect(useStore.getState().scene.models[0].offset).toEqual([4, 0, -1]);
  });

  it('writes the same placement into the review, and broadcasts it', () => {
    const handles = mountGizmo();
    dragTo([4, 0, -1], 1.5708, 2);

    handles.onMouseUp();

    const config = useActiveReviewStore.getState().config;
    expect(config?.asset.placements).toEqual([{
      line: 'bracket',
      revision: 'A',
      offset: [4, 0, -1],
      rotation: [0, 1.5708, 0],
      scale: 2,
    }]);
    // One broadcast carrying the draft that came back, so everybody else's copy of
    // the review has the placement too and not only this screen's scene.
    expect(wire.reviewConfigs).toHaveLength(1);
    expect(wire.reviewConfigs[0]).toBe(config);
    // And the mark RoomPage's subscriber saves on (batch BH3): without it the
    // placement would live in this browser until the room server forgot it.
    expect(consumeLocalEdit()).toBe(true);
  });

  it('waits for the drag to end rather than writing on every frame of it', () => {
    const handles = mountGizmo();

    dragTo([1, 0, 0]);
    handles.onObjectChange();
    dragTo([2, 0, 0]);
    handles.onObjectChange();
    dragTo([3, 0, 0]);
    handles.onObjectChange();

    // The scene updates are throttled, and the review is not written at all yet:
    // each of these would be a whole review on the socket and a row a second later.
    expect(wire.reviewConfigs).toHaveLength(0);
    expect(consumeLocalEdit()).toBe(false);

    handles.onMouseUp();

    expect(wire.reviewConfigs).toHaveLength(1);
    expect(useActiveReviewStore.getState().config?.asset.placements?.[0].offset).toEqual([3, 0, 0]);
  });

  it('writes nothing when the drag ended where it started', () => {
    const handles = mountGizmo();
    dragTo([0, 0, 0]);

    handles.onMouseUp();

    expect(wire.reviewConfigs).toHaveLength(0);
    expect(consumeLocalEdit()).toBe(false);
    expect(useActiveReviewStore.getState().config?.asset.placements).toBeUndefined();
  });

  it('writes nothing when the room holds no review', () => {
    // An ad-hoc session: the drag still works, because the scene is the room
    // server's. Only the second copy has nowhere to go.
    const handles = mountGizmo();
    useActiveReviewStore.getState().setConfig(null);
    forgetLocalEdit();
    dragTo([4, 0, 0]);

    handles.onMouseUp();

    expect(wire.sceneUpdates).toHaveLength(1);
    expect(wire.reviewConfigs).toHaveLength(0);
    expect(consumeLocalEdit()).toBe(false);
  });

  it('gives the camera back and lands the last few centimetres of the move', () => {
    const handles = mountGizmo();
    controlsRef.current = { enabled: true };

    handles.onMouseDown();
    expect(controlsRef.current?.enabled).toBe(false);
    dragTo([2.5, 0, 0]);

    handles.onMouseUp();

    expect(controlsRef.current?.enabled).toBe(true);
    expect(useStore.getState().scene.models[0].offset).toEqual([2.5, 0, 0]);
    controlsRef.current = null;
  });
});
