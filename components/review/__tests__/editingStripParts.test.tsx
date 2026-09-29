// The amber strip's second switch: Whole model | Part — batch BR.
//
// What is pinned here is the strip's half of the contract, which is the half a person
// sees. The gizmo's half is components/Scene/ReviewModelGizmo.tsx and its own test;
// both resolve the SAME selection with the SAME function, so they cannot disagree
// about what is about to move.
//
//   • The switch writes `reviewGizmoTarget` and nothing else. It is not a second
//     selection and it does not change the three tools — Move is Move either way.
//   • Part mode with nothing selected says "Click a part to move it." and gives the
//     tools nothing to act on. Disabled rather than hidden, the strip's rule for every
//     control whose subject comes and goes.
//   • A model's own ROOT selected in Part mode behaves like Whole model, and the tools
//     say so rather than promising a bolt and delivering a product.
//   • Reset part / Reset all parts are the way back, because there is no undo here,
//     and the tooltip says what "back" means: where the FILE had it.
//   • A reset is a scene change like any other: sent to the room, predicted here, and
//     remembered with the REVIEW — without that last step the override would come back
//     the next time the review was opened.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import * as THREE from 'three';
import { SCENE_ROOT_ID, useStore } from '../../../store';
import { useActiveReviewStore } from '../../../lib/activeReviewStore';
import { createReviewDraft } from '../../../lib/reviewSetupStore';
import { consumeLocalEdit, forgetLocalEdit } from '../../../lib/reviewLocalEdit';
import {
  sceneModelId,
  sceneModelPrefix,
  type PartTransforms,
  type SceneModel,
} from '../../../lib/scene/roomScene';
import type { SceneModelEntry } from '../../../lib/scene/sceneEntries';
import type { SceneNode, ObjectState } from '../../../types';

const { presenceMock } = vi.hoisted(() => ({
  presenceMock: {
    broadcastSceneUpdate: vi.fn(() => true),
    broadcastReviewConfig: vi.fn(() => true),
  },
}));

// Only presence is faked: both stores are the real ones, which is what makes the
// three-step write a reset does observable end to end.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => presenceMock,
}));

import EditingStrip from '../EditingStrip';

const HASH = 'a1'.repeat(32);
const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const ROOT = `${PREFIX}_0`;
const FLANGE = `${PREFIX}_1`;
const BOLT = `${PREFIX}_2`;

const WHOLE_MODEL = 'Move, turn and resize the whole model';
const PART = 'Move, turn and resize one part of a model';
const MOVE_MODEL = 'Move the selected model';
const MOVE_PART = 'Move the selected part';
const CLICK_A_PART = 'Click a part in the 3D view or in the model tree first';
const RESET_PART = 'Reset part puts it back where the file had it';
const RESET_ALL = 'Put every part of this model back where the file had it';
const NOTHING_MOVED = 'This part is already where the file had it';

const PARTS: PartTransforms = { [FLANGE]: { position: [1, 0, 0] } };

function model(parts?: PartTransforms): SceneModel {
  return {
    id: MODEL_ID,
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
    // Off the origin, so a reset that removes the last override still leaves a
    // placement worth writing to the review — which is what makes the broadcast
    // below observable rather than a no-op the test cannot tell from a bug.
    offset: [4, 0, 0],
    ...(parts ? { parts } : {}),
  };
}

function entry(): SceneModelEntry {
  return {
    id: MODEL_ID,
    group: new THREE.Group(),
    sceneTree: {
      id: ROOT,
      name: 'bracket.step',
      type: 'GROUP',
      children: [
        { id: FLANGE, name: 'Flange', type: 'MESH' },
        { id: BOLT, name: 'M8 bolt', type: 'MESH' },
      ],
    },
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    baseScale: 1,
    basePosition: new THREE.Vector3(),
    scale: 1,
    size: { x: 1, y: 1, z: 1 },
  };
}

/** The combined tree the store derives, with the model's root wearing its label. */
function tree(): SceneNode {
  return {
    id: SCENE_ROOT_ID,
    name: 'Scene',
    type: 'GROUP',
    children: [{ ...entry().sceneTree, name: 'bracket · Rev A' }],
  };
}

function nodeState(id: string): ObjectState {
  return { id, visible: true, selected: false, expanded: true };
}

/**
 * Put the room in the state the strip reads: one parsed model, its tree, and the node
 * states `selectNode` writes into.
 *
 * Set with setState rather than through setRoomScene because the store derives its
 * objectStates from the trees it holds, and a test that went that way round would be
 * asserting the derivation as much as the strip.
 */
function mountStrip(parts?: PartTransforms) {
  useStore.setState({
    scene: { models: [model(parts)], builtIn: null },
    sceneEntries: { [MODEL_ID]: entry() },
    importedSceneTree: tree(),
    objectStates: { [ROOT]: nodeState(ROOT), [FLANGE]: nodeState(FLANGE), [BOLT]: nodeState(BOLT) },
    activeSceneModelId: MODEL_ID,
    reviewGizmoMode: null,
    reviewGizmoTarget: 'model',
    _viewCapture: null,
  });
  useActiveReviewStore.setState({ config: createReviewDraft('rev-1', 'Landing gear review') });
  forgetLocalEdit();
  presenceMock.broadcastSceneUpdate.mockClear();
  presenceMock.broadcastReviewConfig.mockClear();

  render(<EditingStrip onDone={vi.fn()} />);
}

/**
 * Change the store from outside an event handler, and let React catch up.
 *
 * Wrapped in act because zustand notifies its subscribers synchronously and React
 * does not flush an external-store update outside one. Without this the strip is
 * still showing the render from before the change, and every assertion reads as a
 * bug in the strip rather than as a test that never told React to re-render.
 */
function mutate(change: () => void) {
  act(change);
}

/** Select a node the way the Model Tree and the laser both do. */
function select(id: string | null) {
  mutate(() => useStore.getState().selectNode(id));
}

function partsInStore(): PartTransforms | undefined {
  return useStore.getState().scene.models[0].parts;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  useStore.setState({ reviewGizmoMode: null, reviewGizmoTarget: 'model', activeSceneModelId: null });
  useActiveReviewStore.setState({ config: null });
});

describe('the Whole model | Part switch', () => {
  it('is there, and Whole model is the half every earlier build meant', () => {
    mountStrip();

    expect(screen.getByTestId('gizmo-target-model')).toHaveTextContent('Whole model');
    expect(screen.getByTestId('gizmo-target-part')).toHaveTextContent('Part');
    expect(useStore.getState().reviewGizmoTarget).toBe('model');
  });

  it('writes reviewGizmoTarget, and leaves the three tools exactly as they were', () => {
    mountStrip();

    fireEvent.click(screen.getByTitle(PART));
    expect(useStore.getState().reviewGizmoTarget).toBe('part');

    fireEvent.click(screen.getByTitle(WHOLE_MODEL));
    expect(useStore.getState().reviewGizmoTarget).toBe('model');

    // Not a second set of tools and not a change to the first three: a person who has
    // found Move should not have to find it again to use it on something smaller.
    fireEvent.click(screen.getByTitle(MOVE_MODEL));
    expect(useStore.getState().reviewGizmoMode).toBe('translate');
  });

  it('keeps the tool it was on when the switch moves, which is the point of a switch', () => {
    mountStrip();
    fireEvent.click(screen.getByTitle(MOVE_MODEL));
    expect(useStore.getState().reviewGizmoMode).toBe('translate');

    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    // Still Move — the switch changes WHAT is moved, not HOW.
    expect(useStore.getState().reviewGizmoMode).toBe('translate');
    expect(screen.getByTitle(MOVE_PART)).toBeEnabled();
  });

  it('says nothing about parts while it is in Whole model mode', () => {
    mountStrip();

    expect(screen.queryByText('Click a part to move it.')).toBeNull();
    expect(screen.queryByTitle(RESET_PART)).toBeNull();
    expect(screen.queryByTitle(RESET_ALL)).toBeNull();
  });
});

describe('Part mode with nothing selected', () => {
  it('says "Click a part to move it." and gives the tools nothing to act on', () => {
    mountStrip();
    fireEvent.click(screen.getByTitle(PART));

    expect(screen.getByText('Click a part to move it.')).toBeInTheDocument();
    const tools = screen.getAllByTitle(CLICK_A_PART);
    expect(tools).toHaveLength(3);
    for (const tool of tools) expect(tool).toBeDisabled();
  });

  it('has nothing to reset either, because there is nothing to reset it on', () => {
    mountStrip(PARTS);
    fireEvent.click(screen.getByTitle(PART));

    expect(screen.getByText('Click a part to move it.')).toBeInTheDocument();
    expect(screen.queryByTitle(RESET_PART)).toBeNull();
    expect(screen.queryByTitle(RESET_ALL)).toBeNull();
  });

  it('does not answer for a built-in\'s node, whose parts belong to no SceneModel', () => {
    mountStrip();
    mutate(() => useStore.setState({ objectStates: { headphones_2: nodeState('headphones_2') } }));
    fireEvent.click(screen.getByTitle(PART));
    select('headphones_2');

    expect(screen.getByText('Click a part to move it.')).toBeInTheDocument();
    expect(screen.getAllByTitle(CLICK_A_PART)).toHaveLength(3);
  });
});

describe('Part mode with a part selected', () => {
  it('names the part and enables the tools, in their part wording', () => {
    mountStrip();
    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    expect(screen.getByTestId('gizmo-part-name')).toHaveTextContent('Flange');
    expect(screen.getByTitle(MOVE_PART)).toBeEnabled();
    expect(screen.getByTitle('Rotate the selected part')).toBeEnabled();
    expect(screen.getByTitle('Resize the selected part, one axis at a time')).toBeEnabled();
  });

  it('treats the model\'s own root as the whole model, and says so', () => {
    mountStrip(PARTS);
    fireEvent.click(screen.getByTitle(PART));
    select(ROOT);

    // The root IS the model: the tools keep their whole-model wording, there is no
    // "Reset part" for a thing that is not a part, and the name shown is the label the
    // combined tree gives it.
    expect(screen.getByTitle(MOVE_MODEL)).toBeEnabled();
    expect(screen.queryByTitle(RESET_PART)).toBeNull();
    expect(screen.getByTestId('gizmo-part-name')).toHaveTextContent('bracket · Rev A');
    // "Reset all parts" is still the model's, and this model has moved one.
    expect(screen.getByTitle(RESET_ALL)).toBeEnabled();
  });

  it('answers for a part deeper in the tree by the name the file gave it', () => {
    mountStrip();
    fireEvent.click(screen.getByTitle(PART));
    select(BOLT);

    expect(screen.getByTestId('gizmo-part-name')).toHaveTextContent('M8 bolt');
  });
});

describe('Reset part', () => {
  it('is offered only while there is something to undo, and says what undo means', () => {
    mountStrip();
    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    // No override on this part yet, so nothing to put back.
    expect(screen.getByTitle(NOTHING_MOVED)).toBeDisabled();

    mutate(() => useStore.getState().applyLocalSceneUpdate({
      op: 'setPartTransform',
      id: MODEL_ID,
      nodeId: FLANGE,
      transform: { position: [1, 0, 0] },
    }));
    expect(screen.getByTitle(RESET_PART)).toBeEnabled();
  });

  it('sends the delete to the room, applies it here, and remembers it with the review', () => {
    mountStrip(PARTS);
    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    fireEvent.click(screen.getByTitle(RESET_PART));

    expect(presenceMock.broadcastSceneUpdate).toHaveBeenCalledWith({
      op: 'setPartTransform',
      id: MODEL_ID,
      nodeId: FLANGE,
      transform: null,
    });
    expect(partsInStore()).toBeUndefined();

    // The third step, and the one batch BR added to a flow batch BI only had for
    // drags: without it the override would still be in the review, and the part would
    // come back moved the next time the review was opened.
    expect(presenceMock.broadcastReviewConfig).toHaveBeenCalledTimes(1);
    const config = useActiveReviewStore.getState().config;
    expect(presenceMock.broadcastReviewConfig).toHaveBeenCalledWith(config);
    expect(config?.asset.placements).toEqual([{
      line: 'bracket',
      revision: 'A',
      offset: [4, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
    }]);
    expect(consumeLocalEdit()).toBe(true);
  });

  it('leaves the model\'s other moved parts where they were put', () => {
    mountStrip({ [FLANGE]: { position: [1, 0, 0] }, [BOLT]: { position: [0, 2, 0] } });
    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    fireEvent.click(screen.getByTitle(RESET_PART));

    expect(partsInStore()).toEqual({ [BOLT]: { position: [0, 2, 0] } });
  });
});

describe('Reset all parts', () => {
  it('is offered only while the model has a moved part', () => {
    mountStrip();
    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    expect(screen.getByTitle('No part of this model has been moved')).toBeDisabled();
  });

  it('clears every override on the model in one operation', () => {
    mountStrip({ [FLANGE]: { position: [1, 0, 0] }, [BOLT]: { position: [0, 2, 0] } });
    fireEvent.click(screen.getByTitle(PART));
    select(FLANGE);

    fireEvent.click(screen.getByTitle(RESET_ALL));

    // One operation rather than N, so the room relays one SCENE_STATE for it and not
    // one per part.
    expect(presenceMock.broadcastSceneUpdate).toHaveBeenCalledTimes(1);
    expect(presenceMock.broadcastSceneUpdate).toHaveBeenCalledWith({
      op: 'clearPartTransforms',
      id: MODEL_ID,
    });
    expect(partsInStore()).toBeUndefined();
    expect(presenceMock.broadcastReviewConfig).toHaveBeenCalledTimes(1);
  });
});
