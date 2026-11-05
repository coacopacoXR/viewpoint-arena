// Hiding every comment bubble and review pin in the 3D view, and what hiding them must NOT
// hide — task 09a.
//
// What only a render can prove here:
//
//   • the switch removes the markers from BOTH families — the bubbles in
//     components/Scene/SpatialComments.tsx and the pins in components/Scene/ReviewArtifacts.tsx
//     — and puts them back, which is the whole feature and the half that is easy to do for
//     one family and forget the other;
//   • a hidden marker is not mounted at all, so it costs no `<Html>` element, no click
//     target and no entry in the occlusion registry that the driver raycasts ten times a
//     second. `visible={false}` would have passed a "I cannot see it" test and failed this
//     one, and this one is the reason the switch is worth having on a review with forty
//     comments on it;
//   • the placement preview survives the switch. Arming "Comment" while the bubbles are
//     hidden is a person about to drop one, and the crosshair is the only feedback the drop
//     has — a switch that took it away would make the room un-annotatable while it was on;
//   • the Comments tab still lists everything. The markers are a picture of the comments and
//     the tab is the comments; hiding the picture has to leave the list alone, or the switch
//     reads as "delete them";
//   • and the markers that ARE drawn are drawn on the layer lib/scene/markerLayers.ts says,
//     which is the assertion that the panels stopped being underneath them.
//
// There is no WebGL here, so R3F's `useThree` is faked with a real camera, a real scene and a
// real element the way components/Scene/__tests__/sceneClickSelect.test.tsx fakes it, and
// drei's `<Html>` is a div that records the props it was handed. The z-index range is the
// interesting one: what `<Html>` does with it is a browser question that
// e2e/pinsOcclusion.spec.ts answers against real panels.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import * as THREE from 'three';
import type { SpatialComment } from '../../../types';

interface FakeCanvas {
  camera: THREE.Camera;
  scene: THREE.Scene;
  gl: { domElement: HTMLCanvasElement };
  invalidate: () => void;
}

const canvas = vi.hoisted(() => ({ current: null as FakeCanvas | null }));

vi.mock('@react-three/fiber', () => ({
  useThree: (selector?: (state: FakeCanvas) => unknown) => {
    const state = canvas.current;
    if (!state) throw new Error('no canvas');
    return selector ? selector(state) : state;
  },
  // Nothing here is a frame loop: the placement preview's pointer tracking and the viewpoint
  // animator's camera ride are other tasks' business, and a no-op is what lets both mount.
  useFrame: () => {},
}));

vi.mock('@react-three/drei', async () => {
  const React = await import('react');
  return {
    // Records the layer it was asked for, because that is the half of the fix a screenshot
    // cannot show on its own: a marker under the panels and a marker nobody drew look the
    // same in a picture of an empty corner.
    Html: (props: { children?: React.ReactNode; style?: React.CSSProperties; zIndexRange?: number[] }) =>
      React.createElement(
        'div',
        {
          'data-testid': 'scene-html',
          'data-z-range': JSON.stringify(props.zIndexRange ?? null),
          style: props.style,
        },
        props.children,
      ),
  };
});

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'me',
    broadcastCommentAdd: () => {},
    broadcastCommentUpdate: () => {},
    broadcastCommentDelete: () => {},
    broadcastCommentResolve: () => {},
    broadcastReviewConfig: () => {},
  }),
}));

const { default: SpatialComments } = await import('../SpatialComments');
const { default: ReviewArtifacts } = await import('../ReviewArtifacts');
const { default: CommentsPanel } = await import('../../UI/CommentsPanel');
const { useStore } = await import('../../../store');
const { useActiveReviewStore } = await import('../../../lib/activeReviewStore');
const { createReviewDraft } = await import('../../../lib/reviewSetupStore');
const { occludedMarkerCount, clearOccludedMarkers } = await import('../../../lib/scene/markerOcclusion');
const { MARKER_Z_RANGE, MARKER_Z_RANGE_EXPANDED } = await import('../../../lib/scene/markerLayers');

function comment(id: string, content: string, attachedToNodeId = 'flange_1'): SpatialComment {
  return {
    id,
    type: 'text',
    content,
    author: 'Olga',
    authorColor: '#4F8EF7',
    timestamp: Date.now(),
    position: { x: 0, y: 1, z: 0 },
    attachedToNodeId,
    attachedToNodeName: 'Flange',
    assignees: [],
    resolved: false,
    linkedToMeeting: false,
  };
}

/** Two comments and one curated pin, which is one of each family the switch has to reach. */
function mountRoom() {
  canvas.current = {
    camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
    scene: new THREE.Scene(),
    gl: { domElement: document.createElement('canvas') },
    invalidate: () => {},
  };
  canvas.current.camera.position.set(8, 6, 8);

  useStore.setState({
    comments: [comment('c1', 'The flange is 2mm off'), comment('c2', 'Wrong paint')],
    commentsExpandedInScene: false,
    commentMode: 'none',
    sceneMarkersHidden: false,
  });
  useActiveReviewStore.setState({
    config: {
      ...createReviewDraft('rev-1', 'Door hinge'),
      pins: [
        {
          id: 'p1',
          label: 'P1',
          worldPos: [0, 1, 0],
          meshIndex: 'flange_1',
          severity: 'blocker',
          createdAt: Date.now(),
        },
      ],
    },
  });
}

function markers(): HTMLElement[] {
  return screen.queryAllByTestId('scene-html');
}

/** The controlsRef ReviewArtifacts hands its viewpoint animator. Nothing rides it here. */
const controlsRef = { current: null } as React.MutableRefObject<unknown>;

beforeEach(() => {
  mountRoom();
});

afterEach(() => {
  cleanup();
  canvas.current = null;
  clearOccludedMarkers();
  useStore.setState({ comments: [], commentMode: 'none', sceneMarkersHidden: false });
  useActiveReviewStore.setState({ config: null });
});

describe('the switch that hides every marker', () => {
  it('draws a bubble for each comment and a label for each pin', () => {
    render(
      <>
        <SpatialComments />
        <ReviewArtifacts controlsRef={controlsRef} />
      </>,
    );

    // Two bubbles and one pin label. Asserted before anything is hidden, because "nothing
    // was drawn" passes every assertion below it on its own.
    //
    // A collapsed bubble carries its comment's text in the hover tooltip beside the dot, in
    // the same element as the author's name — hence the regex rather than an exact string.
    // The pin's label is its own element and is matched exactly.
    expect(markers()).toHaveLength(3);
    expect(screen.getByText(/The flange is 2mm off/)).toBeTruthy();
    expect(screen.getByText(/Wrong paint/)).toBeTruthy();
    expect(screen.getByText('P1')).toBeTruthy();
    expect(occludedMarkerCount()).toBe(3);
  });

  it('takes both families off the canvas, and shows them again', () => {
    const { rerender } = render(
      <>
        <SpatialComments />
        <ReviewArtifacts controlsRef={controlsRef} />
      </>,
    );
    expect(markers()).toHaveLength(3);

    act(() => useStore.getState().toggleSceneMarkersHidden());
    rerender(
      <>
        <SpatialComments />
        <ReviewArtifacts controlsRef={controlsRef} />
      </>,
    );
    expect(markers()).toHaveLength(0);
    expect(screen.queryByText(/The flange is 2mm off/)).toBeNull();
    expect(screen.queryByText(/Wrong paint/)).toBeNull();
    expect(screen.queryByText('P1')).toBeNull();

    act(() => useStore.getState().toggleSceneMarkersHidden());
    rerender(
      <>
        <SpatialComments />
        <ReviewArtifacts controlsRef={controlsRef} />
      </>,
    );
    expect(markers()).toHaveLength(3);
    expect(screen.getByText(/The flange is 2mm off/)).toBeTruthy();
  });

  it('unmounts a hidden marker rather than drawing it invisibly', () => {
    render(
      <>
        <SpatialComments />
        <ReviewArtifacts controlsRef={controlsRef} />
      </>,
    );
    expect(occludedMarkerCount()).toBe(3);

    act(() => useStore.getState().setSceneMarkersHidden(true));

    // The registry is what the driver in components/Scene/MarkerOcclusion.tsx raycasts, once
    // per entry, ten times a second. A marker that is hidden but still in it is a marker the
    // room is still paying for — and an `invisible` one would be, because `visible={false}`
    // on the group leaves the component mounted and its entry with it.
    expect(occludedMarkerCount()).toBe(0);
  });

  it('keeps the placement preview, which is the crosshair of a click about to happen', () => {
    act(() => useStore.getState().setSceneMarkersHidden(true));
    act(() => useStore.getState().setCommentMode('placing-pin'));

    render(<SpatialComments />);

    expect(markers()).toHaveLength(1);
    // And it is on the markers' layer: under the panels like every other marker, so the
    // crosshair cannot cover the amber strip the person armed it from.
    expect(markers()[0].dataset.zRange).toBe(JSON.stringify(MARKER_Z_RANGE));
  });
});

describe('what the switch does NOT hide', () => {
  it('leaves the Comments tab listing every comment', () => {
    act(() => useStore.getState().setSceneMarkersHidden(true));

    render(<CommentsPanel />);

    expect(screen.getByText('The flange is 2mm off')).toBeTruthy();
    expect(screen.getByText('Wrong paint')).toBeTruthy();
    // And says how many are open, which is the number a person checks the switch against.
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('leaves the comments themselves alone', () => {
    act(() => useStore.getState().setSceneMarkersHidden(true));

    // The switch is a display preference in localStorage, not a write to the room's
    // annotations: hiding them here must not remove them there, or the next person to join
    // inherits one browser's tidy screen.
    expect(useStore.getState().comments).toHaveLength(2);
    expect(localStorage.getItem('vp_markers_hidden')).toBe('1');

    act(() => useStore.getState().setSceneMarkersHidden(false));
    expect(localStorage.getItem('vp_markers_hidden')).toBeNull();
  });
});

describe('the one place the two switches meet', () => {
  it('shows the markers again when every card is expanded in the scene', () => {
    act(() => useStore.getState().setSceneMarkersHidden(true));

    // "Expand All in Scene" is a request to SEE the markers. Left alone it would open every
    // card onto a canvas this browser had emptied of them — a button that moves and changes
    // nothing, which is the one state a person cannot diagnose from the screen.
    act(() => useStore.getState().toggleCommentsExpandedInScene());

    expect(useStore.getState().commentsExpandedInScene).toBe(true);
    expect(useStore.getState().sceneMarkersHidden).toBe(false);
  });

  it('leaves them hidden when the cards are collapsed instead', () => {
    act(() => useStore.getState().setSceneMarkersHidden(true));
    act(() => useStore.setState({ commentsExpandedInScene: true }));

    // Collapsing the cards is not a request to hide the bubbles, so it does not touch the
    // switch — and a second click on the same button must not show them as a side effect.
    act(() => useStore.getState().toggleCommentsExpandedInScene());

    expect(useStore.getState().commentsExpandedInScene).toBe(false);
    expect(useStore.getState().sceneMarkersHidden).toBe(true);
  });
});

describe('the layer the markers that are drawn sit on', () => {
  it('is under the room overlay for a collapsed bubble and a pin label', () => {
    render(
      <>
        <SpatialComments />
        <ReviewArtifacts controlsRef={controlsRef} />
      </>,
    );

    for (const marker of markers()) {
      expect(marker.dataset.zRange).toBe(JSON.stringify(MARKER_Z_RANGE));
    }
  });

  it('is above every collapsed marker for a card somebody opened', () => {
    act(() => useStore.getState().toggleCommentExpanded('c1'));

    render(<SpatialComments />);

    const ranges = markers().map((marker) => marker.dataset.zRange);
    expect(ranges).toContain(JSON.stringify(MARKER_Z_RANGE_EXPANDED));
    expect(ranges).toContain(JSON.stringify(MARKER_Z_RANGE));
  });
});
