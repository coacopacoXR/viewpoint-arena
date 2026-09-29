// The amber strip: what the top bar becomes while this person has Edit on.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. What is pinned here is the
// strip's contract with the two stores it sits between.
//
//   • Its three tools are a SWITCH, not the gizmo: they write reviewGizmoMode in
//     the main store using drei's names ('translate', not "Move"), because the
//     TransformControls that reads it lives inside the canvas and there is no prop
//     path between the two trees. Pressing the tool that is already on turns it
//     off again, so the strip is the only thing that can say "no gizmo".
//   • With nothing selected in the model tree the tools are disabled — not hidden,
//     so the strip does not change shape as the selection moves — and say why in
//     their title.
//   • "Save this view" is a TWO-STEP write: the viewpoint goes into
//     lib/activeReviewStore first, and the draft that came back is the one
//     broadcast. Asserting the broadcast carries the store's own config is the
//     point of the test — a broadcast of anything else would show five other
//     people a review this screen does not have.
//   • A camera pose the canvas will not hand over is a silent no-op rather than a
//     viewpoint at the origin, because a view that jumps somewhere nobody was is
//     worse than a button that appears not to have worked.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useStore } from '../../../store';
import { useActiveReviewStore } from '../../../lib/activeReviewStore';
import { createReviewDraft } from '../../../lib/reviewSetupStore';
import type { ReviewDraft } from '../../../lib/reviewSetupStore';
import type { ViewCapture } from '../../../types';

const { presenceMock } = vi.hoisted(() => ({
  presenceMock: { broadcastReviewConfig: vi.fn(() => true) },
}));

// Only presence is faked: both stores are the real ones, which is what makes the
// two-step write below observable. vi.hoisted keeps the spy reachable from the
// factory, which runs before any top-level const here does.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => presenceMock,
}));

import EditingStrip from '../EditingStrip';

const MOVE = 'Move the selected model';
const ROTATE = 'Rotate the selected model';
const SCALE = 'Resize the selected model';
const NOTHING_SELECTED = 'Select a model in the tree first';
const SAVE = 'Add the current camera as a viewpoint of the review';
const DONE = 'Finish editing and go back to the meeting';

/**
 * A review with two viewpoints already in it, so the "View N" a save produces is
 * the third and cannot be mistaken for a hardcoded first.
 */
function seededDraft(): ReviewDraft {
  return {
    ...createReviewDraft('rev-1', 'Landing gear review'),
    viewpoints: [
      { id: 'vp-1', label: 'View 1', position: [1, 1, 1], lookAt: [0, 0, 0], createdAt: 1 },
      { id: 'vp-2', label: 'View 2', position: [2, 2, 2], lookAt: [0, 0, 0], createdAt: 2 },
    ],
  };
}

/** Where the canvas says the camera is, or that it will not say. */
function pinCapture(capture: (() => ViewCapture | null) | null) {
  useStore.setState({ _viewCapture: capture });
}

function selectModel(id: string | null) {
  useStore.setState({ activeSceneModelId: id });
}

beforeEach(() => {
  presenceMock.broadcastReviewConfig.mockClear();
  useStore.setState({ reviewGizmoMode: null, activeSceneModelId: null, _viewCapture: null });
  useActiveReviewStore.setState({ config: seededDraft() });
});

afterEach(() => {
  cleanup();
  useStore.setState({ reviewGizmoMode: null, activeSceneModelId: null, _viewCapture: null });
  useActiveReviewStore.setState({ config: null });
});

describe('the amber editing strip', () => {
  it('says what it is, and offers three tools, a save and a way out', () => {
    selectModel('model-1');
    render(<EditingStrip onDone={vi.fn()} />);

    expect(
      screen.getByText('Editing the review — changes are saved and seen by everyone'),
    ).toBeInTheDocument();

    // The labels are hidden below 1500px by a Tailwind arbitrary media query, so
    // the tools are found by the title each one carries at any width.
    expect(screen.getByTitle(MOVE)).toHaveTextContent('Move');
    expect(screen.getByTitle(ROTATE)).toHaveTextContent('Rotate');
    expect(screen.getByTitle(SCALE)).toHaveTextContent('Scale');
    expect(screen.getByTitle(SAVE)).toHaveTextContent('Save this view');
    expect(screen.getByTitle(DONE)).toHaveTextContent('Done');
  });

  it('gives the tools nothing to act on until the tree has a selection', () => {
    render(<EditingStrip onDone={vi.fn()} />);

    const tools = screen.getAllByTitle(NOTHING_SELECTED);
    expect(tools).toHaveLength(3);
    for (const tool of tools) expect(tool).toBeDisabled();
    expect(screen.queryByTitle(MOVE)).toBeNull();
  });

  it('enables all three once a scene model is selected', () => {
    selectModel('model-1');
    render(<EditingStrip onDone={vi.fn()} />);

    expect(screen.getByTitle(MOVE)).toBeEnabled();
    expect(screen.getByTitle(ROTATE)).toBeEnabled();
    expect(screen.getByTitle(SCALE)).toBeEnabled();
  });

  it('turns a tool into the drei mode of the same name, and back off on a second press', () => {
    selectModel('model-1');
    render(<EditingStrip onDone={vi.fn()} />);

    // 'translate' rather than the button's own "Move": the value goes straight to
    // drei's TransformControls from inside the canvas.
    fireEvent.click(screen.getByTitle(MOVE));
    expect(useStore.getState().reviewGizmoMode).toBe('translate');
    fireEvent.click(screen.getByTitle(MOVE));
    expect(useStore.getState().reviewGizmoMode).toBeNull();

    fireEvent.click(screen.getByTitle(ROTATE));
    expect(useStore.getState().reviewGizmoMode).toBe('rotate');
    fireEvent.click(screen.getByTitle(ROTATE));
    expect(useStore.getState().reviewGizmoMode).toBeNull();

    fireEvent.click(screen.getByTitle(SCALE));
    expect(useStore.getState().reviewGizmoMode).toBe('scale');
    fireEvent.click(screen.getByTitle(SCALE));
    expect(useStore.getState().reviewGizmoMode).toBeNull();
  });

  it('hands Done to the room rather than deciding to be finished itself', () => {
    const onDone = vi.fn();
    selectModel('model-1');
    render(<EditingStrip onDone={onDone} />);

    fireEvent.click(screen.getByTitle(DONE));

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('adds the camera as the next viewpoint and broadcasts the draft the store now holds', () => {
    selectModel('model-1');
    pinCapture(() => ({ position: [1, 2, 3], lookAt: [0, 0, 0], thumbnail: 'data:,' }));
    render(<EditingStrip onDone={vi.fn()} />);

    fireEvent.click(screen.getByTitle(SAVE));

    const config = useActiveReviewStore.getState().config;
    expect(config?.viewpoints).toHaveLength(3);
    const added = config?.viewpoints[2];
    expect(added?.label).toBe('View 3');
    expect(added?.position).toEqual([1, 2, 3]);
    expect(added?.lookAt).toEqual([0, 0, 0]);
    expect(added?.thumbnail).toBe('data:,');

    // The pairing is the whole point of the two-step write: what went out is what
    // this screen is now showing, not a second copy of it.
    expect(presenceMock.broadcastReviewConfig).toHaveBeenCalledTimes(1);
    expect(presenceMock.broadcastReviewConfig).toHaveBeenCalledWith(config);
  });

  it('does nothing at all when the room registered no camera to read', () => {
    selectModel('model-1');
    pinCapture(null);
    render(<EditingStrip onDone={vi.fn()} />);

    fireEvent.click(screen.getByTitle(SAVE));

    expect(useActiveReviewStore.getState().config?.viewpoints).toHaveLength(2);
    expect(presenceMock.broadcastReviewConfig).not.toHaveBeenCalled();
  });

  it('does nothing at all when the canvas will not give up a pose', () => {
    selectModel('model-1');
    pinCapture(() => null);
    render(<EditingStrip onDone={vi.fn()} />);

    fireEvent.click(screen.getByTitle(SAVE));

    // No viewpoint at the origin, and nothing told to the room.
    expect(useActiveReviewStore.getState().config?.viewpoints).toHaveLength(2);
    expect(presenceMock.broadcastReviewConfig).not.toHaveBeenCalled();
  });
});
