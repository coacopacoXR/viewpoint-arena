// The room's view-tools control — task 08a.
//
// What is asserted here is the half a rendering test cannot see: that the control is
// reachable and honest about what it is doing.
//
//   • it is ONE rail with a popover, on screen whatever else is open, and it is not behind
//     the Edit switch — a cut is something the whole meeting looks at, so it cannot live
//     behind the one lock only one person holds;
//   • every control writes the ROOM's value through `setViewTools` and nothing local, so
//     what is on this screen is what is on everybody else's;
//   • the slider's release is what flushes the throttle, because that is the moment the
//     person considers the value final;
//   • the explode is rendered and disabled with the reason on it, rather than absent — a
//     control that appears later is a control the room has to learn twice;
//   • and when there is nothing to cut the control says SO, with which of the three reasons
//     it is: no model, still loading, or every model hidden. "Disabled" on its own is the
//     one state a person cannot diagnose.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DEFAULT_VIEW_TOOLS, type ViewTools } from '../../../lib/scene/viewTools';

let storeState: Record<string, unknown>;
let setViewTools: ReturnType<typeof vi.fn>;
// Typed as a mock OF a function rather than a bare `vi.fn()`, which @types/vitest answers as
// `Mock<Procedure | Constructable>` — a thing that might be a constructor and so cannot be
// called. The store's `flushViewTools` takes nothing and answers nothing, and that is the
// signature being spied on.
let flush: ReturnType<typeof vi.fn<() => void>>;

vi.mock('../../../store', async () => {
  const actual = await vi.importActual<typeof import('../../../store')>('../../../store');
  return {
    // `sceneModelVisible` is the store's own answer to "is this model shown", and the
    // control has to use it rather than invent a second one — so the real function is kept
    // and only the hook and the flush are faked.
    ...actual,
    useStore: (selector?: (s: Record<string, unknown>) => unknown) =>
      typeof selector === 'function' ? selector(storeState) : storeState,
    flushViewTools: () => flush(),
  };
});

import RoomViewTools from '../room/RoomViewTools';

const CUT = { axis: 'x' as const, position: 0.5, flip: false };

/** A room with one imported model, parsed and shown. */
function setup(overrides: Partial<Record<string, unknown>> = {}) {
  setViewTools = vi.fn();
  flush = vi.fn(() => {});
  storeState = {
    viewTools: DEFAULT_VIEW_TOOLS,
    setViewTools,
    activeModelType: 'imported',
    // `visible` is the SHARED half of sceneModelVisible — the room agreed this model shows.
    // A fixture without it is a model the room has hidden, and the control would be right to
    // say there is nothing to cut.
    scene: { models: [{ id: 'm1', line: 'A', revision: 1, visible: true }] },
    sceneEntries: { m1: { id: 'm1' } },
    localModelVisibility: {},
    ...overrides,
  };
  return storeState;
}

function open() {
  fireEvent.click(screen.getByTestId('view-tools-toggle'));
  return screen.getByTestId('view-tools-popover');
}

/** What the control asked the store to write, most recent first. */
const written = (): ViewTools[] => setViewTools.mock.calls.map((call) => call[0] as ViewTools);
const lastWritten = (): ViewTools => written()[written().length - 1];

describe('RoomViewTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders one rail, closed, with the controls behind it', () => {
    setup();
    render(<RoomViewTools className="absolute right-6" />);

    expect(screen.getByTestId('view-tools-toggle')).toBeTruthy();
    expect(screen.queryByTestId('view-tools-popover')).toBeNull();
    // The rail is the whole of what is permanently on the canvas: the thing it controls is
    // the model, which is the middle of the canvas.
    fireEvent.click(screen.getByTestId('view-tools-toggle'));
    expect(screen.getByTestId('view-tools-popover')).toBeTruthy();
    expect(screen.getByTestId('view-tools-cut-toggle')).toBeTruthy();
    expect(screen.getByTestId('view-tools-position')).toBeTruthy();
    expect(screen.getByTestId('view-tools-explode')).toBeTruthy();
  });

  it('reads nothing about who is editing, so it is not behind the Edit switch', () => {
    // A cut is shared with the room rather than owned by one person, so it cannot live in the
    // amber strip: that strip only exists for whoever holds the edit lock.
    setup();
    render(<RoomViewTools />);
    expect(screen.getByTestId('view-tools-toggle')).toBeTruthy();
  });

  it('turns the cut on at the middle of the model, and off again', () => {
    setup();
    render(<RoomViewTools />);
    open();

    fireEvent.click(screen.getByTestId('view-tools-cut-toggle'));
    // The middle and not an end: a cut at 0 or 1 removes nothing and reads as a button that
    // did nothing, and a cut in the middle shows a section on the first frame.
    expect(lastWritten()).toEqual({ cut: { axis: 'x', position: 0.5, flip: false }, explode: 0 });

    // A fresh mount with the cut already on, which is the state everybody else in the room is
    // in when the person who turned it on turns it off again.
    cleanup();
    setup({ viewTools: { cut: CUT, explode: 0 } });
    render(<RoomViewTools />);
    open();
    fireEvent.click(screen.getByTestId('view-tools-cut-toggle'));
    expect(lastWritten()).toEqual({ cut: null, explode: 0 });
  });

  it('writes the axis the room is cutting on', () => {
    setup({ viewTools: { cut: CUT, explode: 0 } });
    render(<RoomViewTools />);
    open();

    fireEvent.click(screen.getByTestId('view-tools-axis-y'));
    expect(lastWritten()).toEqual({ cut: { axis: 'y', position: 0.5, flip: false }, explode: 0 });
    fireEvent.click(screen.getByTestId('view-tools-axis-z'));
    expect(lastWritten()).toEqual({ cut: { axis: 'z', position: 0.5, flip: false }, explode: 0 });
  });

  it('writes the slider as a fraction of the model, and flushes on release', () => {
    setup({ viewTools: { cut: CUT, explode: 0 } });
    render(<RoomViewTools />);
    open();
    const slider = screen.getByTestId('view-tools-position');

    expect((slider as HTMLInputElement).value).toBe('50');
    fireEvent.change(slider, { target: { value: '25' } });
    expect(lastWritten()).toEqual({ cut: { axis: 'x', position: 0.25, flip: false }, explode: 0 });
    // Not yet: the store throttles the wire, and the release is the moment the person
    // considers the value final.
    expect(flush).not.toHaveBeenCalled();

    fireEvent.pointerUp(slider);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flushes on a keyboard arrow too, which is a drag with no pointer in it', () => {
    setup({ viewTools: { cut: CUT, explode: 0 } });
    render(<RoomViewTools />);
    open();
    const slider = screen.getByTestId('view-tools-position');

    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flips which side of the plane is cut away', () => {
    setup({ viewTools: { cut: CUT, explode: 0 } });
    render(<RoomViewTools />);
    open();

    fireEvent.click(screen.getByTestId('view-tools-flip'));
    expect(lastWritten()).toEqual({ cut: { axis: 'x', position: 0.5, flip: true }, explode: 0 });
  });

  it('puts the plane back in the middle without turning the cut off', () => {
    setup({ viewTools: { cut: { axis: 'y', position: 0.1, flip: true }, explode: 0 } });
    render(<RoomViewTools />);
    open();

    fireEvent.click(screen.getByTestId('view-tools-reset'));
    // The axis survives a reset of the position: the person chose Y for a reason, and
    // "reset" on a slider is about the slider.
    expect(lastWritten()).toEqual({ cut: { axis: 'y', position: 0.5, flip: false }, explode: 0 });
  });

  it('puts everything back with the room-wide reset', () => {
    setup({ viewTools: { cut: CUT, explode: 0.5 } });
    render(<RoomViewTools />);
    open();

    fireEvent.click(screen.getByTestId('view-tools-reset-all'));
    expect(lastWritten()).toEqual(DEFAULT_VIEW_TOOLS);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('renders the explode disabled, with the task that lands it named on it', () => {
    setup({ viewTools: { cut: CUT, explode: 0 } });
    render(<RoomViewTools />);
    open();

    const explode = screen.getByTestId('view-tools-explode') as HTMLInputElement;
    expect(explode.disabled).toBe(true);
    expect(screen.getByTestId('view-tools-popover').textContent).toContain('08b');
  });

  it('carries an explode the room already has, so the day 08b lands nothing has to be re-learned', () => {
    setup({ viewTools: { cut: null, explode: 0.4 } });
    render(<RoomViewTools />);
    open();

    // Read off the shared value rather than from a local one: the room is exploded, so the
    // control says so even though this browser cannot render it yet.
    expect((screen.getByTestId('view-tools-explode') as HTMLInputElement).value).toBe('40');
    expect(screen.getByTestId('view-tools-popover').textContent).toContain('40%');
  });

  describe('when there is nothing to cut', () => {
    it('disables the cut and says the room has no model', () => {
      setup({ activeModelType: 'none', scene: { models: [] }, sceneEntries: {} });
      render(<RoomViewTools />);
      open();

      const toggle = screen.getByTestId('view-tools-cut-toggle') as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
      expect(toggle.title).toContain('no model');
      expect(screen.getByTestId('view-tools-unavailable').textContent).toContain('no model');
      // And nothing was written: a disabled control that still fires is worse than one that
      // does not say why.
      fireEvent.click(toggle);
      expect(setViewTools).not.toHaveBeenCalled();
    });

    it('says the model is still loading when it is in the scene but not parsed yet', () => {
      setup({ sceneEntries: {} });
      render(<RoomViewTools />);
      open();

      expect(screen.getByTestId('view-tools-unavailable').textContent).toContain('still loading');
    });

    it('says every model is hidden when the Model Tree has taken them all off', () => {
      setup({ localModelVisibility: { m1: false } });
      render(<RoomViewTools />);
      open();

      expect(screen.getByTestId('view-tools-unavailable').textContent).toContain('hidden');
    });

    it('is available for the bundled sample, which is a model too', () => {
      setup({ activeModelType: 'synth', scene: { models: [] }, sceneEntries: {} });
      render(<RoomViewTools />);
      open();

      expect(screen.queryByTestId('view-tools-unavailable')).toBeNull();
      expect((screen.getByTestId('view-tools-cut-toggle') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('shows the room’s cut on the rail while the popover is shut', () => {
    setup({ viewTools: { cut: { axis: 'z', position: 0.25, flip: false }, explode: 0 } });
    const { container } = render(<RoomViewTools />);

    // Legible from the canvas without the popover being open, which matters because the
    // popover is open on one screen and the cut is on everybody's.
    expect(container.textContent).toContain('z');
    expect(container.textContent).toContain('25');
    expect((screen.getByTestId('view-tools-toggle') as HTMLElement).className).toContain('bg-black');
  });
});
