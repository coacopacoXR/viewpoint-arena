// The top bar's compact state — components/UI/room/TopBar.tsx.
//
// Live at 1600x900 the room's top bar overlapped the logo block on its left and ran under
// the side panel on its right: it was absolutely centred on the free canvas from
// `left-[300px]` with no idea how wide the block beside it had grown, and it carried twelve
// controls. Batch BQ2 put the bar in the same flex row as that block, so it starts after it
// and ends before the panel — and, when that is still not enough, sheds button labels
// least-used first and keeps each icon with its `title`.
//
// The order is the part worth pinning. Privacy, Boardroom, Share, Pointer and Highlight go
// first; Edit, Sessions and Variant keep their words longest, because they are the three
// that say what the meeting is doing rather than how it is pointed at. A bar of unlabelled
// icons on a shared screen is a bar nobody can read, so where a future control goes in this
// list is a decision about the meeting and not about CSS.
//
// jsdom does no layout: every element is 0x0. So the bar's measurement is stubbed — a
// natural width that grows with the number of labels still on it — and what is asserted is
// the loop's behaviour: it sheds exactly as many labels as the box it was given needs.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopBar, { TOP_BAR_DROP_ORDER, TOP_BAR_MAX_COMPACT, dropLevelOf } from '../TopBar';

// XRButton reads the xrStore singleton, and createXRStore injects the WebXR emulator under
// jsdom (it wants WebGL2RenderingContext, and throws as an unhandled rejection that fails
// the run). The stub's no-op comes from vi.hoisted, because TopBar is imported statically
// and the factory therefore runs before any top-level const in this file.
const { noop } = vi.hoisted(() => ({ noop: () => {} }));

vi.mock('../../../../lib/xrStore', () => ({
  xrStore: {
    subscribe: () => noop,
    getState: () => ({ session: null }),
    enterAR: noop,
    enterVR: noop,
  },
}));

/** jsdom has no ResizeObserver, which is how the bar learns its box changed width. */
class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  private readonly callback: ResizeObserverCallback;
  private readonly self: ResizeObserver;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    // The bar reads nothing from the observer and calls it back with one, and never touches
    // what it is given — so a stand-in with the three methods is a ResizeObserver as far as
    // this file is concerned.
    this.self = { observe: noop, unobserve: noop, disconnect: noop };
    FakeResizeObserver.last = this;
  }

  observe(_target: Element) {}
  unobserve(_target: Element) {}
  disconnect() {}

  /** Report a resize. No entries: the bar then measures the box itself, as it does. */
  resized() {
    this.callback([], this.self);
  }
}

vi.stubGlobal('ResizeObserver', FakeResizeObserver);

/** The words the bar can shed, in the order it sheds them. */
const DROPPED_LABELS = TOP_BAR_DROP_ORDER.map((control) => control[0].toUpperCase() + control.slice(1));

/** What the icons, gaps and padding cost once every label has gone. */
const BARE_WIDTH = 500;
/** What one more word costs. */
const LABEL_WIDTH = 60;
/** Room for every label, which is what the bar is given until a test says otherwise. */
const ROOMY = BARE_WIDTH + LABEL_WIDTH * DROPPED_LABELS.length + 200;

type BarProps = React.ComponentProps<typeof TopBar>;

function barElement(overrides: Partial<BarProps> = {}): React.ReactElement {
  const props: BarProps = {
    isHost: true,
    roomId: 'room-1',
    showShare: false,
    onToggleShare: vi.fn(),
    showParticipants: false,
    onToggleParticipants: vi.fn(),
    onOpenDeicticExplainer: vi.fn(),
    canEditReview: true,
    onEditReview: vi.fn(),
    onOpenSessions: vi.fn(),
    ...overrides,
  };
  // Inside a router: the bar carries LineChip and StartVariant, and both navigate.
  return <MemoryRouter><TopBar {...props} /></MemoryRouter>;
}

/**
 * The box the room's header row gives the bar: everything between the name plate and the
 * side panel. One mutable number, so a test can change it after the first render and the bar
 * can be told its box grew.
 */
const boxWidth = { current: ROOMY };

/**
 * The bar on screen, in a box `available` pixels wide.
 *
 * The width is delivered the way a browser delivers it — through the observer, after the
 * first measurement — rather than by re-rendering, because that is the path the real one
 * takes when the side panel opens or the window changes.
 */
function renderBar(overrides: Partial<BarProps> = {}, available = ROOMY) {
  boxWidth.current = ROOMY;
  const view = render(barElement(overrides));
  const box = screen.getByTestId('top-bar-box');
  const bar = screen.getByTestId('top-bar');

  // The bar's own scrollWidth is its natural width — a flex item that shrinks to the box
  // while its `shrink-0` children overflow it, which is what scrollWidth reports and
  // clientWidth does not. It grows with the labels still on it, which is the only part of
  // real layout this test needs to be true.
  Object.defineProperty(box, 'clientWidth', { configurable: true, get: () => boxWidth.current });
  Object.defineProperty(box, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width: boxWidth.current, height: 48, top: 0, left: 0, bottom: 48,
      right: boxWidth.current, x: 0, y: 0,
    }),
  });
  Object.defineProperty(bar, 'scrollWidth', {
    configurable: true,
    get: () => BARE_WIDTH + LABEL_WIDTH * labelsOn(bar).length,
  });

  const resize = (to: number) => {
    boxWidth.current = to;
    act(() => {
      FakeResizeObserver.last?.resized();
    });
  };
  if (available !== ROOMY) resize(available);

  return { view, box, bar, resize };
}

function labelsOn(bar: HTMLElement): string[] {
  return DROPPED_LABELS.filter((label) => within(bar).queryByText(label) !== null);
}

afterEach(() => {
  cleanup();
  FakeResizeObserver.last = null;
});

describe('the top bar with room to spare', () => {
  it('keeps every label', () => {
    const { bar } = renderBar();

    // The default is the labelled bar: nothing is hidden until the box says it has to be.
    expect(labelsOn(bar).sort()).toEqual([...DROPPED_LABELS].sort());
  });

  it('keeps the labels a window media query would have thrown away', () => {
    // 1280px with the side panel collapsed left the old `min-width: 1500px` rule with the bar
    // icon-only in a canvas wide enough for every word it had. jsdom has no window width to
    // speak of, which is also the proof that the bar no longer asks for one.
    const { bar } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * DROPPED_LABELS.length);

    expect(labelsOn(bar)).toHaveLength(DROPPED_LABELS.length);
  });
});

describe('the top bar when it does not fit', () => {
  it('sheds one label at a time, least-used first, until it fits', () => {
    for (let left = DROPPED_LABELS.length; left >= 0; left -= 1) {
      cleanup();
      const { bar } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * left);

      // Exactly `left` labels survive, and they are the LAST `left` in the order — the whole
      // claim this batch makes about the bar, as one list.
      expect(labelsOn(bar).sort()).toEqual([...DROPPED_LABELS.slice(DROPPED_LABELS.length - left)].sort());
    }
  });

  it('drops Privacy, Boardroom, Share, Pointer and Highlight before anything else', () => {
    // Room for four labels: the five least-used are gone, and Edit, Sessions, Variant and
    // People are not.
    const { bar } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * 4);

    for (const gone of ['Privacy', 'Boardroom', 'Share', 'Pointer', 'Highlight']) {
      expect(within(bar).queryByText(gone)).toBeNull();
    }
    for (const kept of ['Edit', 'Sessions', 'Variant', 'People']) {
      expect(within(bar).getByText(kept)).toBeTruthy();
    }
  });

  it('keeps Edit, Sessions and Variant to the very end', () => {
    const { bar } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * 2);

    expect(labelsOn(bar).sort()).toEqual(['Edit', 'Sessions']);
    expect(within(bar).queryByText('Variant')).toBeNull();
  });

  it('keeps the button, its tooltip and its click when the word goes', () => {
    // Shedding a label is not shedding a control: the bar has to stay usable, and a hover
    // still has to say what the icon is.
    const onToggleShare = vi.fn();
    const { bar } = renderBar({ onToggleShare }, BARE_WIDTH + LABEL_WIDTH * 4);

    expect(within(bar).queryByText('Share')).toBeNull();
    const share = within(bar).getByTitle('Share');
    expect(share).toBeEnabled();
    fireEvent.click(share);
    expect(onToggleShare).toHaveBeenCalledTimes(1);
  });

  it('keeps the People count, which is the answer that button exists to give', () => {
    // Room for three labels: Privacy, Boardroom, Share, Pointer, Highlight and the word
    // "People" have all gone, and the number has not.
    const { bar } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * 3);

    expect(within(bar).queryByText('People')).toBeNull();
    // "How many are here" is not something an icon says.
    expect(within(bar).getByTitle('Participants')).toHaveTextContent('0');
    for (const kept of ['Edit', 'Sessions', 'Variant']) {
      expect(within(bar).getByText(kept)).toBeTruthy();
    }
  });

  it('keeps Model and Part when the Highlight caption goes', () => {
    const { bar } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * 4);

    expect(within(bar).queryByText('Highlight')).toBeNull();
    // The caption is what a compact bar sheds; the two toggles are the control, and without
    // their own words they are two identical pills offering a choice nobody can read.
    expect(within(bar).getByTitle('Highlight whole model')).toHaveTextContent('Model');
    expect(within(bar).getByTitle('Highlight specific part')).toHaveTextContent('Part');
  });

  it('puts the labels back when the box gets wider', () => {
    const { bar, resize } = renderBar({}, BARE_WIDTH + LABEL_WIDTH * 2);
    expect(labelsOn(bar)).toHaveLength(2);

    // The side panel closing, or the window growing: the width the bar has to fit changed,
    // so the question is asked again from the top rather than answered from where it got to.
    resize(ROOMY);

    expect(labelsOn(bar)).toHaveLength(DROPPED_LABELS.length);
  });

  it('gets compact when the box gets narrower, not only when the bar grows', () => {
    // The same fact from the other side, and the one the old media query could not see at
    // all: nothing about the bar changed, the room beside it did.
    const { bar, resize } = renderBar();
    expect(labelsOn(bar)).toHaveLength(DROPPED_LABELS.length);

    resize(BARE_WIDTH + LABEL_WIDTH * 3);

    expect(labelsOn(bar)).toHaveLength(3);
  });

  it('stops asking once there is nothing left to shed', () => {
    // A box too narrow even for the icons. The level is clamped, so the climb ends rather
    // than re-rendering for ever, and the bar stays on one row with nothing wrapped.
    const { bar } = renderBar({}, 120);

    expect(labelsOn(bar)).toHaveLength(0);
    expect(TOP_BAR_MAX_COMPACT).toBe(DROPPED_LABELS.length);
  });
});

describe('the order itself', () => {
  it('is the one the batch was asked for', () => {
    expect([...TOP_BAR_DROP_ORDER]).toEqual([
      'privacy', 'boardroom', 'share', 'pointer', 'highlight', 'people', 'variant', 'sessions', 'edit',
    ]);
  });

  it('gives every control its own level, starting at one', () => {
    // Level 0 is the labelled bar, so the first thing to go goes at level 1 — and nothing two
    // controls share a level, because two that vanish together cannot be ordered.
    expect(TOP_BAR_DROP_ORDER.map((control) => dropLevelOf(control))).toEqual(
      TOP_BAR_DROP_ORDER.map((_, index) => index + 1),
    );
  });
});
