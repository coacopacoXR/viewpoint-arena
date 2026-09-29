// The amber strip's Undo / Redo — batch BT.
//
// What is pinned here is the strip's half of the contract, which is the half a person
// sees. The stack itself and the rules that make an undo safe are lib/scene/editHistory.ts
// and its own test; the gizmo's drag-end is components/Scene/ReviewModelGizmo.tsx.
//
//   • Two icon buttons at the START of the strip, disabled when there is nothing to do,
//     with the shortcut in the tooltip — because a control whose keyboard equivalent
//     nobody knows about is a control only half the room can use.
//   • They keep their icons at every width. Batch BS made this strip fit by shedding
//     words, least-important first; these two have no words to shed and are not in the
//     drop order, so a narrow window cannot make the way back disappear.
//   • Reset part is a step like any other, so the press that removes an override is the
//     press Ctrl+Z gives back — which is the difference between "the way back to the
//     FILE" and "the way back to a moment ago", the two things this strip now offers.
//   • An undo is a scene change: sent to the room, predicted here, and the review's own
//     copy of the placements written too.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import * as THREE from 'three';
import { SCENE_ROOT_ID, useStore } from '../../../store';
import { useActiveReviewStore } from '../../../lib/activeReviewStore';
import { createReviewDraft } from '../../../lib/reviewSetupStore';
import { forgetLocalEdit } from '../../../lib/reviewLocalEdit';
import { useEditHistory } from '../../../lib/scene/editHistory';
import {
  sceneModelId,
  sceneModelPrefix,
  type PartTransforms,
  type SceneModel,
  type SceneUpdate,
} from '../../../lib/scene/roomScene';
import type { SceneModelEntry } from '../../../lib/scene/sceneEntries';
import type { SceneNode, ObjectState } from '../../../types';

const { presenceMock, wire } = vi.hoisted(() => ({
  presenceMock: {
    broadcastReviewConfig: vi.fn(() => true),
  },
  wire: { sceneUpdates: [] as SceneUpdate[] },
}));

// Only presence is faked: both stores are the real ones, so an undo can be followed from
// the button all the way to the record in the scene and the operation on the wire. The
// operations are collected by hand rather than read off a mock's `calls`, because a
// `vi.fn(() => true)` declares no parameters and its call tuples are therefore empty to
// the type checker.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    broadcastSceneUpdate: (update: SceneUpdate) => {
      wire.sceneUpdates.push(update);
      return true;
    },
    broadcastReviewConfig: presenceMock.broadcastReviewConfig,
  }),
}));

import EditingStrip, { EDITING_STRIP_DROP_ORDER } from '../EditingStrip';

const HASH = 'a1'.repeat(32);
const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const ROOT = `${PREFIX}_0`;
const FLANGE = `${PREFIX}_1`;

const RESET_PART = 'Reset part puts it back where the file had it';
const PARTS: PartTransforms = { [FLANGE]: { position: [1, 2, 3] } };

function model(parts?: PartTransforms): SceneModel {
  return {
    id: MODEL_ID,
    hash: HASH,
    fileName: 'bracket.step',
    line: 'bracket',
    revision: 'A',
    visible: true,
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
      children: [{ id: FLANGE, name: 'Flange', type: 'MESH' }],
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

/** The room in Part mode, with the flange selected and moved. */
function mountStrip() {
  useStore.setState({
    scene: { models: [model(PARTS)], builtIn: null },
    sceneEntries: { [MODEL_ID]: entry() },
    importedSceneTree: tree(),
    objectStates: { [ROOT]: nodeState(ROOT), [FLANGE]: nodeState(FLANGE) },
    activeSceneModelId: MODEL_ID,
    reviewGizmoMode: null,
    reviewGizmoTarget: 'part',
    reviewEditNotice: null,
    _viewCapture: null,
  });
  useStore.getState().selectNode(FLANGE);
  useActiveReviewStore.setState({ config: createReviewDraft('rev-1', 'Landing gear review') });
  forgetLocalEdit();
  useEditHistory.getState().clear();
  wire.sceneUpdates.length = 0;
  presenceMock.broadcastReviewConfig.mockClear();

  render(<EditingStrip onDone={vi.fn()} />);
}

function mutate(change: () => void) {
  act(change);
}

const undo = () => screen.getByTestId('undo-scene-edit');
const redo = () => screen.getByTestId('redo-scene-edit');

function partsInStore(): PartTransforms | undefined {
  return useStore.getState().scene.models[0]?.parts;
}

function sent(): SceneUpdate[] {
  return wire.sceneUpdates;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  useStore.setState({
    reviewGizmoMode: null,
    reviewGizmoTarget: 'model',
    activeSceneModelId: null,
    reviewEditNotice: null,
  });
  useActiveReviewStore.setState({ config: null });
  useEditHistory.getState().clear();
});

describe('the two buttons', () => {
  it('are at the start of the strip, disabled, with the shortcut in the tooltip', () => {
    mountStrip();

    expect(undo()).toBeDisabled();
    expect(redo()).toBeDisabled();
    expect(undo().getAttribute('title')).toBe('Undo (Ctrl+Z)');
    expect(redo().getAttribute('title')).toBe('Redo (Ctrl+Shift+Z)');

    const strip = screen.getByTestId('editing-strip');
    const buttons = Array.from(strip.querySelectorAll('button'));
    expect(buttons[0]).toBe(undo());
    expect(buttons[1]).toBe(redo());
  });

  it('are icon-only at every width, so they are not in the shedding order', () => {
    mountStrip();

    expect(undo()).toHaveTextContent('');
    expect(redo()).toHaveTextContent('');
    const order = EDITING_STRIP_DROP_ORDER as readonly string[];
    expect(order).not.toContain('undo');
    expect(order).not.toContain('redo');
  });
});

describe('Reset part, and then undoing it', () => {
  it('is one step, which puts the override back', () => {
    mountStrip();

    fireEvent.click(screen.getByTitle(RESET_PART));
    expect(partsInStore()).toBeUndefined();
    expect(undo()).toBeEnabled();
    expect(redo()).toBeDisabled();

    wire.sceneUpdates.length = 0;
    fireEvent.click(undo());

    expect(partsInStore()).toEqual(PARTS);
    // Through the normal path: the same operation the strip sent, so the room applies it
    // to its own copy with the same permission checks and relays it to everybody.
    expect(sent()).toEqual([
      { op: 'setPartTransform', id: MODEL_ID, nodeId: FLANGE, transform: PARTS[FLANGE] },
    ]);
    expect(redo()).toBeEnabled();
    expect(undo()).toBeDisabled();
  });

  it('says what happened, and keeps the review\'s own copy of the placement', () => {
    mountStrip();

    fireEvent.click(screen.getByTitle(RESET_PART));
    fireEvent.click(undo());

    // The scene has no last-changed-by to name, so the short sentence is the answer —
    // see historyNotice in lib/scene/editHistory.ts.
    expect(useStore.getState().reviewEditNotice).toBe('Undone.');
    // The review outlives the room, so an undo that reached only the room would come back
    // the next time the review was opened.
    expect(presenceMock.broadcastReviewConfig).toHaveBeenCalled();
  });

  it('redoes the reset', () => {
    mountStrip();

    fireEvent.click(screen.getByTitle(RESET_PART));
    fireEvent.click(undo());
    expect(partsInStore()).toEqual(PARTS);

    wire.sceneUpdates.length = 0;
    fireEvent.click(redo());

    expect(partsInStore()).toBeUndefined();
    // One clear rather than a deletion per node: the step's `after` has no overrides at
    // all, so that is the operation that says it.
    expect(sent()).toEqual([{ op: 'clearPartTransforms', id: MODEL_ID }]);
    expect(redo()).toBeDisabled();
    expect(undo()).toBeEnabled();
    expect(useStore.getState().reviewEditNotice).toBe('Redone.');
  });

  it('walks back through two steps in the order they happened', () => {
    mountStrip();

    fireEvent.click(screen.getByTitle(RESET_PART));
    mutate(() => useStore.getState().applyLocalSceneUpdate({
      op: 'setVisible', id: MODEL_ID, visible: false,
    }));
    // The hide went through the store rather than the strip, which is the point: the
    // stack is the room's, not one control's, and the eye in the model tree records too.
    act(() => useEditHistory.getState().record({
      label: 'Hid bracket · Rev A',
      ids: [MODEL_ID],
      before: [model()],
      after: [{ ...model(), visible: false }],
    }));

    fireEvent.click(undo());
    expect(useStore.getState().scene.models[0].visible).toBe(true);
    expect(partsInStore()).toBeUndefined();

    fireEvent.click(undo());
    expect(partsInStore()).toEqual(PARTS);
    expect(undo()).toBeDisabled();
  });
});
