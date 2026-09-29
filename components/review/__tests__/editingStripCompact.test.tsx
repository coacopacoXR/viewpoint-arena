// The amber strip's compact states — components/review/EditingStrip.tsx.
//
// Live at 1600x900 after batch BR, the strip ran past its container: Reset part, Reset all
// parts and Save this view were drawn on top of the review's name in the room's left block,
// and Done — the only way out of Edit — was off the right-hand edge of the screen. It was
// answering the question with four different window media queries (`min-width: 1300px`,
// 1400px, 1500px, 1600px), and a window cannot tell it how wide the block beside it has
// grown or whether the side panel is open. Batch BS gives it what batch BQ2 gave the top
// bar it replaces: the box the room's header row hands it, measured, and a list of what to
// shed when that is not enough.
//
// The order is the part worth pinning. The sentence goes first, then Reset all parts, Reset
// part, Rotate, Scale, Move, Save this view, and the part's name last — and that one
// truncates rather than disappearing, with the whole name in the tooltip. Two things never
// go: Whole model | Part, which is the mode, and Done, which is the exit.
//
// jsdom does no layout: every element is 0x0. So the strip's measurement is stubbed — a
// natural width that grows with whatever still has its words — and what is asserted is the
// loop's behaviour: it sheds exactly as much as the box it was given needs, in the order
// above, and puts it all back when the box grows.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act } from '@testing-library/react';
import * as THREE from 'three';
import { SCENE_ROOT_ID, useStore } from '../../../store';
import {
  sceneModelId,
  sceneModelPrefix,
  type PartTransforms,
  type SceneModel,
} from '../../../lib/scene/roomScene';
import type { SceneModelEntry } from '../../../lib/scene/sceneEntries';
import type { SceneNode, ObjectState } from '../../../types';

const { presenceMock, noop } = vi.hoisted(() => ({
  presenceMock: {
    broadcastSceneUpdate: vi.fn(() => true),
    broadcastReviewConfig: vi.fn(() => true),
  },
  noop: () => {},
}));

// Only presence is faked: both stores are the real ones, so selecting a part in here is
// selecting a part in the room.
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => presenceMock,
}));

import EditingStrip, {
  EDITING_STRIP_DROP_ORDER,
  EDITING_STRIP_MAX_COMPACT,
  editingStripDropLevelOf,
  type EditingStripControl,
} from '../EditingStrip';

/** jsdom has no ResizeObserver, which is how the strip learns its box changed width. */
class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  private readonly callback: ResizeObserverCallback;
  private readonly self: ResizeObserver;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    // The strip reads nothing from the observer and calls it back with one, and never
    // touches what it is given — so a stand-in with the three methods is a ResizeObserver
    // as far as this file is concerned.
    this.self = { observe: noop, unobserve: noop, disconnect: noop };
    FakeResizeObserver.last = this;
  }

  observe(_target: Element) {}
  unobserve(_target: Element) {}
  disconnect() {}

  /** Report a resize. No entries: the strip then measures the box itself, as it does. */
  resized() {
    this.callback([], this.self);
  }
}

vi.stubGlobal('ResizeObserver', FakeResizeObserver);

const SENTENCE = 'Editing the review — changes are saved and seen by everyone';
const DONE = 'Finish editing and go back to the meeting';
const SAVE = 'Add the current camera as a viewpoint of the review';
const PART_MODE = 'Move, turn and resize one part of a model';
const MOVE_PART = 'Move the selected part';
const ROTATE_PART = 'Rotate the selected part';
const SCALE_PART = 'Resize the selected part, one axis at a time';
const RESET_PART = 'Reset part puts it back where the file had it';
const RESET_ALL = 'Put every part of this model back where the file had it';

const HASH = 'a1'.repeat(32);
const MODEL_ID = sceneModelId(HASH);
const PREFIX = sceneModelPrefix(HASH);
const ROOT = `${PREFIX}_0`;
const FLANGE = `${PREFIX}_1`;
const HINGE = `${PREFIX}_3`;
/** A name long enough that truncating it is visible, and that the tooltip has to rescue. */
const LONG_NAME = 'Landing gear door hinge bracket, upper left outboard';

/** What each control costs, in pixels, while it still has its words. */
const ROOMY_COST: Record<EditingStripControl, number> = {
  sentence: 260,
  resetAllParts: 100,
  resetPart: 80,
  rotate: 55,
  scale: 50,
  move: 50,
  saveView: 90,
  partName: 170,
};

/** The words each control sheds. The part name sheds width instead, so it is not here. */
const ROOMY_TEXT: Record<string, string> = {
  sentence: SENTENCE,
  resetAllParts: 'Reset all parts',
  resetPart: 'Reset part',
  rotate: 'Rotate',
  scale: 'Scale',
  move: 'Move',
  saveView: 'Save this view',
};

/** What the icons, gaps, dividers, the mode, "Editing", 8ch of name and Done cost. */
const BARE_WIDTH = 420;

function model(parts?: PartTransforms): SceneModel {
  return {
    id: MODEL_ID,
    hash: HASH,
    fileName: 'gear.step',
    line: 'gear',
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
      name: 'gear.step',
      type: 'GROUP',
      children: [
        { id: FLANGE, name: 'Flange', type: 'MESH' },
        { id: HINGE, name: LONG_NAME, type: 'MESH' },
      ],
    },
    fileName: 'gear.step',
    line: 'gear',
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
    children: [{ ...entry().sceneTree, name: 'gear · Rev A' }],
  };
}

function nodeState(id: string): ObjectState {
  return { id, visible: true, selected: false, expanded: true };
}

/** The box width at which the strip needs exactly `level`, and no more, to fit. */
function widthForLevel(level: number): number {
  return BARE_WIDTH + EDITING_STRIP_DROP_ORDER.slice(level)
    .reduce((total, control) => total + ROOMY_COST[control], 0);
}

/** A box wide enough for every word the strip has, plus a margin. */
const ROOMY = widthForLevel(0) + 200;

/** Is this control still wearing its words? */
function isRoomy(bar: HTMLElement, control: EditingStripControl): boolean {
  if (control === 'partName') {
    const name = within(bar).queryByTestId('gizmo-part-name');
    return name !== null && name.className.includes('max-w-[14rem]');
  }
  const label = ROOMY_TEXT[control];
  return label !== undefined && within(bar).queryAllByText(label).length > 0;
}

/** What the strip is still wearing, in the order it would shed it. */
function roomyOn(bar: HTMLElement): EditingStripControl[] {
  return EDITING_STRIP_DROP_ORDER.filter((control) => isRoomy(bar, control));
}

/** The strip's own scrollWidth: its natural width, which grows with its words. */
function naturalWidth(bar: HTMLElement): number {
  return BARE_WIDTH + roomyOn(bar).reduce((total, control) => total + ROOMY_COST[control], 0);
}

const boxWidth = { current: ROOMY };

/**
 * The strip on screen, in a box `available` pixels wide.
 *
 * Part mode with a part selected unless a test says otherwise, because that is the fullest
 * strip there is: it is the only state with a name to truncate and two Resets to shed. The
 * width is delivered the way a browser delivers it — through the observer, after the first
 * measurement — rather than by re-rendering, because that is the path the real one takes
 * when the side panel opens or the window changes.
 */
function renderStrip(available = ROOMY, options: { select?: string | null; onDone?: () => void } = {}) {
  const onDone = options.onDone ?? vi.fn();
  useStore.setState({
    scene: { models: [model({ [FLANGE]: { position: [1, 0, 0] } })], builtIn: null },
    sceneEntries: { [MODEL_ID]: entry() },
    importedSceneTree: tree(),
    objectStates: {
      [ROOT]: nodeState(ROOT), [FLANGE]: nodeState(FLANGE), [HINGE]: nodeState(HINGE),
    },
    activeSceneModelId: MODEL_ID,
    reviewGizmoMode: null,
    reviewGizmoTarget: 'model',
    _viewCapture: null,
  });

  boxWidth.current = ROOMY;
  const view = render(<EditingStrip onDone={onDone} />);
  const box = screen.getByTestId('editing-strip-box');
  const bar = screen.getByTestId('editing-strip');

  // The box is what the room's header row gives the strip; the bar's own scrollWidth is its
  // natural width — a flex item whose `shrink-0` children overflow it, which is what
  // scrollWidth reports and clientWidth does not.
  Object.defineProperty(box, 'clientWidth', { configurable: true, get: () => boxWidth.current });
  Object.defineProperty(box, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width: boxWidth.current, height: 48, top: 0, left: 0, bottom: 48,
      right: boxWidth.current, x: 0, y: 0,
    }),
  });
  Object.defineProperty(bar, 'scrollWidth', { configurable: true, get: () => naturalWidth(bar) });

  const resize = (to: number) => {
    boxWidth.current = to;
    act(() => {
      FakeResizeObserver.last?.resized();
    });
  };

  // Into Part mode, and onto a part, before the box is sized: both are things the strip has
  // to notice about ITSELF rather than about the room, and both are in its content key.
  fireEvent.click(screen.getByTitle(PART_MODE));
  act(() => useStore.getState().selectNode(options.select === undefined ? FLANGE : options.select));

  resize(available);

  return { view, box, bar, resize, onDone };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  FakeResizeObserver.last = null;
  useStore.setState({
    reviewGizmoMode: null, reviewGizmoTarget: 'model', activeSceneModelId: null,
    scene: { models: [], builtIn: null }, sceneEntries: {}, importedSceneTree: null,
  });
});

describe('the strip with room to spare', () => {
  it('keeps every word it has', () => {
    const { bar } = renderStrip();

    expect(roomyOn(bar)).toEqual([...EDITING_STRIP_DROP_ORDER]);
    expect(within(bar).getByText(SENTENCE)).toBeInTheDocument();
    // No tooltip needed while the whole sentence is on screen.
    expect(within(bar).getByText(SENTENCE)).not.toHaveAttribute('title');
  });

  it('stays on one row, because nothing in it is allowed to shrink', () => {
    // The premise the measurement runs on: the bar is a flex item that gives way to the box
    // while its children do not, which is what makes scrollWidth the natural width. A child
    // that could shrink would absorb the overflow instead, and the strip would never learn
    // it did not fit. `flex-wrap` is absent, so it cannot become two rows either.
    const { bar } = renderStrip();

    expect(bar.className).not.toContain('flex-wrap');
    expect(Array.from(bar.children).length).toBeGreaterThan(0);
    for (const child of Array.from(bar.children)) {
      expect(child.className).toContain('shrink-0');
    }
  });
});

describe('the strip when it does not fit', () => {
  it('sheds one thing at a time, in the order the batch asked for', () => {
    for (let level = 0; level <= EDITING_STRIP_MAX_COMPACT; level += 1) {
      cleanup();
      const { bar } = renderStrip(widthForLevel(level));

      // Exactly the tail of the order survives, which is the whole claim as one list.
      expect(roomyOn(bar)).toEqual([...EDITING_STRIP_DROP_ORDER.slice(level)]);
    }
  });

  it('shrinks the sentence to "Editing" first, and keeps all of it in the tooltip', () => {
    const { bar } = renderStrip(widthForLevel(1));

    expect(within(bar).queryByText(SENTENCE)).toBeNull();
    const short = within(bar).getByText('Editing');
    expect(short).toHaveAttribute('title', SENTENCE);
    // The first thing to go is the only text here that is not a control, so nothing has
    // lost its words yet.
    expect(within(bar).getByText('Reset all parts')).toBeTruthy();
    expect(within(bar).getByText('Save this view')).toBeTruthy();
  });

  it('drops the two Resets before the three tools, and the tools before Save this view', () => {
    const { bar } = renderStrip(widthForLevel(6));

    for (const gone of ['Reset all parts', 'Reset part', 'Rotate', 'Scale', 'Move']) {
      expect(within(bar).queryByText(gone)).toBeNull();
    }
    expect(within(bar).getByText('Save this view')).toBeTruthy();
  });

  it('keeps Whole model | Part, which is the mode, at every width', () => {
    const { bar } = renderStrip(widthForLevel(EDITING_STRIP_MAX_COMPACT));

    expect(within(bar).getByTestId('gizmo-target-model')).toHaveTextContent('Whole model');
    expect(within(bar).getByTestId('gizmo-target-part')).toHaveTextContent('Part');
  });

  it('keeps Done, with its word, at every width', () => {
    // The exit is the reason the strip sheds anything at all: before it did, Done was what
    // went off the screen. A control that loses the word saying what it does at a narrow
    // window is a room nobody can leave.
    for (let level = 0; level <= EDITING_STRIP_MAX_COMPACT; level += 1) {
      cleanup();
      const { bar } = renderStrip(widthForLevel(level));

      expect(within(bar).getByTitle(DONE)).toHaveTextContent('Done');
    }
  });

  it('keeps every control, its tooltip and its click when the words go', () => {
    // Shedding a label is not shedding a control.
    const { bar } = renderStrip(widthForLevel(EDITING_STRIP_MAX_COMPACT));

    for (const title of [MOVE_PART, ROTATE_PART, SCALE_PART, RESET_PART, RESET_ALL, SAVE, DONE]) {
      expect(within(bar).getByTitle(title)).toBeTruthy();
    }
    fireEvent.click(within(bar).getByTitle(MOVE_PART));
    expect(useStore.getState().reviewGizmoMode).toBe('translate');
  });

  it('truncates the part name last, with the whole name in the tooltip', () => {
    const { bar } = renderStrip(widthForLevel(EDITING_STRIP_MAX_COMPACT), { select: HINGE });
    const name = within(bar).getByTestId('gizmo-part-name');

    // The text is still the whole name; what changes is how much of it the box allows, down
    // to about eight characters rather than to nothing.
    expect(name).toHaveTextContent(LONG_NAME);
    expect(name.className).toContain('truncate');
    expect(name.className).toContain('max-w-[8ch]');
    expect(name.getAttribute('title')?.startsWith(LONG_NAME)).toBe(true);
  });

  it('leaves the name at its full width while there is room for it', () => {
    const { bar } = renderStrip(ROOMY, { select: HINGE });

    expect(within(bar).getByTestId('gizmo-part-name').className).toContain('max-w-[14rem]');
  });

  it('puts the words back when the box gets wider', () => {
    const { bar, resize } = renderStrip(widthForLevel(3));
    expect(roomyOn(bar)).toEqual([...EDITING_STRIP_DROP_ORDER.slice(3)]);

    // The side panel closing, or the window growing: the width to fit changed, so the
    // question is asked again from the top rather than answered from where it got to.
    resize(ROOMY);

    expect(roomyOn(bar)).toEqual([...EDITING_STRIP_DROP_ORDER]);
  });

  it('gets compact when the box gets narrower, not only when the strip grows', () => {
    // The same fact from the other side, and the one the four media queries could not see
    // at all: nothing about the strip changed, the room beside it did.
    const { bar, resize } = renderStrip();
    expect(roomyOn(bar)).toHaveLength(EDITING_STRIP_DROP_ORDER.length);

    resize(widthForLevel(3));

    expect(roomyOn(bar)).toEqual([...EDITING_STRIP_DROP_ORDER.slice(3)]);
  });

  it('re-measures when the strip itself grows, without the box changing', () => {
    // Whole model mode is a narrower strip than Part mode: switching into it and onto a
    // part adds a name and two Resets to a box that was already full.
    useStore.setState({
      scene: { models: [model()], builtIn: null },
      sceneEntries: { [MODEL_ID]: entry() },
      importedSceneTree: tree(),
      objectStates: { [ROOT]: nodeState(ROOT), [FLANGE]: nodeState(FLANGE) },
      activeSceneModelId: MODEL_ID,
      reviewGizmoMode: null,
      reviewGizmoTarget: 'model',
      _viewCapture: null,
    });
    render(<EditingStrip onDone={vi.fn()} />);
    const box = screen.getByTestId('editing-strip-box');
    const bar = screen.getByTestId('editing-strip');
    const fixed = 1000;
    Object.defineProperty(box, 'clientWidth', { configurable: true, get: () => fixed });
    Object.defineProperty(box, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        width: fixed, height: 48, top: 0, left: 0, bottom: 48, right: fixed, x: 0, y: 0,
      }),
    });
    Object.defineProperty(bar, 'scrollWidth', { configurable: true, get: () => naturalWidth(bar) });
    act(() => {
      FakeResizeObserver.last?.resized();
    });
    // Whole model mode has no name and no Resets to shed, so it is comfortable in a box
    // that the same strip in Part mode is not.
    expect(roomyOn(bar)).toEqual(['sentence', 'rotate', 'scale', 'move', 'saveView']);

    fireEvent.click(screen.getByTitle(PART_MODE));
    act(() => useStore.getState().selectNode(FLANGE));

    // The sentence and Reset all parts are what a Part-mode strip gives up first.
    expect(roomyOn(bar)).toEqual([...EDITING_STRIP_DROP_ORDER.slice(2)]);
  });

  it('stops asking once there is nothing left to shed', () => {
    // A box too narrow even for the icons. The level is clamped, so the climb ends rather
    // than re-rendering for ever, and Done is still there and still labelled.
    const { bar } = renderStrip(120);

    expect(roomyOn(bar)).toEqual([]);
    expect(EDITING_STRIP_MAX_COMPACT).toBe(EDITING_STRIP_DROP_ORDER.length);
    expect(within(bar).getByTitle(DONE)).toHaveTextContent('Done');
  });
});

describe('the order itself', () => {
  it('is the one the batch was asked for', () => {
    expect([...EDITING_STRIP_DROP_ORDER]).toEqual([
      'sentence', 'resetAllParts', 'resetPart', 'rotate', 'scale', 'move', 'saveView', 'partName',
    ]);
  });

  it('gives every control its own level, starting at one', () => {
    // Level 0 is the labelled strip, so the first thing to go goes at level 1 — and nothing
    // two controls share a level, because two that vanish together cannot be ordered.
    expect(EDITING_STRIP_DROP_ORDER.map((control) => editingStripDropLevelOf(control))).toEqual(
      EDITING_STRIP_DROP_ORDER.map((_, index) => index + 1),
    );
  });
});
