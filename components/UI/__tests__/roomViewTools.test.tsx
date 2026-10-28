// The room's view-tools control — tasks 08a (the cut) and 08b (the explode).
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
//   • the explode is the same shape of control as the cut — a switch and a slider on the one
//     shared value — and switching it on says on screen that the part tools have gone grey,
//     because a restriction nobody is told about is a bug the person has to find;
//   • and when there is nothing to work on the control says SO, with which of the three
//     reasons it is: no model, still loading, or every model hidden. "Disabled" on its own is
//     the one state a person cannot diagnose.

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

  describe('the explode', () => {
    it('switches on at half spread, and keeps the cut the room already had', () => {
      setup({ viewTools: { cut: CUT, explode: 0 } });
      render(<RoomViewTools />);
      open();

      fireEvent.click(screen.getByTestId('view-tools-explode-toggle'));
      // One shared value carries both tools, so turning one on must not take the other off:
      // the room is looking at a section AND at the parts pulled apart, and the two are
      // independent questions about the same model. Half rather than full, because the first
      // frame is the one that teaches what the tool does and at full spread the outer parts
      // are outside the camera the room had settled on.
      expect(lastWritten()).toEqual({ cut: CUT, explode: 0.5 });
    });

    it('switches off, and leaves the cut alone', () => {
      setup({ viewTools: { cut: CUT, explode: 0.6 } });
      render(<RoomViewTools />);
      open();

      fireEvent.click(screen.getByTestId('view-tools-explode-toggle'));
      expect(lastWritten()).toEqual({ cut: CUT, explode: 0 });
    });

    it('has the slider live at the room’s value, and dead while the room is assembled', () => {
      // A fresh mount per state rather than a click, because `setViewTools` is faked here: the
      // component reads the room's value back from the store, and a fake store never answers
      // what the click asked it to write. What a mount shows is what a browser joining the room
      // shows, which is the state that matters.
      setup({ viewTools: { cut: null, explode: 0 } });
      render(<RoomViewTools />);
      open();
      // Off, and not merely at zero: a slider that moves and changes nothing is the one control
      // state this popover exists to avoid, so the switch is what turns it on.
      expect((screen.getByTestId('view-tools-explode') as HTMLInputElement).disabled).toBe(true);
      expect(screen.queryByTestId('view-tools-explode-note')).toBeNull();

      cleanup();
      setup({ viewTools: { cut: null, explode: 0.6 } });
      render(<RoomViewTools />);
      open();
      const slider = screen.getByTestId('view-tools-explode') as HTMLInputElement;
      expect(slider.disabled).toBe(false);
      expect(slider.value).toBe('60');
      expect(screen.getByTestId('view-tools-explode-toggle').textContent).toContain('On');
      expect(screen.getByTestId('view-tools-popover').textContent).toContain('60%');
    });

    it('writes the slider as a fraction of full spread, and flushes on release', () => {
      setup({ viewTools: { cut: null, explode: 0.5 } });
      render(<RoomViewTools />);
      open();
      const slider = screen.getByTestId('view-tools-explode');

      expect((slider as HTMLInputElement).value).toBe('50');
      fireEvent.change(slider, { target: { value: '80' } });
      expect(lastWritten()).toEqual({ cut: null, explode: 0.8 });
      // Not yet: the store throttles the wire, and the release is the moment the person
      // considers the value final. Same contract as the cut's slider, and the same reason —
      // a room that converges 66 ms late is a room that disagrees with the screen dragging it.
      expect(flush).not.toHaveBeenCalled();

      fireEvent.pointerUp(slider);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it('flushes on a keyboard arrow too, which is a drag with no pointer in it', () => {
      setup({ viewTools: { cut: null, explode: 0.5 } });
      render(<RoomViewTools />);
      open();

      fireEvent.keyUp(screen.getByTestId('view-tools-explode'), { key: 'ArrowRight' });
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it('puts the parts back with its own reset, without touching the cut', () => {
      setup({ viewTools: { cut: CUT, explode: 0.7 } });
      render(<RoomViewTools />);
      open();

      fireEvent.click(screen.getByTestId('view-tools-explode-reset'));
      expect(lastWritten()).toEqual({ cut: CUT, explode: 0 });
    });

    it('carries an explode the room already has, so a browser that joins sees what everybody sees', () => {
      setup({ viewTools: { cut: null, explode: 0.4 } });
      render(<RoomViewTools />);
      open();

      // Read off the shared value rather than from a local one: the room is exploded, so the
      // control says so and the slider starts where the room is rather than where this browser
      // last left it.
      expect((screen.getByTestId('view-tools-explode') as HTMLInputElement).value).toBe('40');
      expect(screen.getByTestId('view-tools-popover').textContent).toContain('40%');
    });

    it('says on screen that parts cannot be moved while the model is apart', () => {
      setup({ viewTools: { cut: null, explode: 0.6 } });
      const { container } = render(<RoomViewTools />);

      open();
      // The restriction is the amber strip's, and the strip is only on screen for whoever
      // holds the edit lock — so the sentence explaining it has to be here, where everybody
      // can see it, and not only in a tooltip on a button that may be shed for width.
      expect(screen.getByTestId('view-tools-explode-note').textContent).toContain(
        'Parts cannot be moved',
      );
      // And the rail says the room is exploded without the popover being open, which is the
      // same job the cut's badge has always had: one screen has the popover, everybody has
      // the model.
      expect(container.textContent).toContain('e60');
    });

    it('leaves the cut’s own badge exactly as it was when the room is only cutting', () => {
      // Two tools sharing one badge must not have changed what one of them reads as: a cut on
      // its own has said `x50` on the rail since 08a, and a check that runs against the room
      // server asserts on exactly that.
      setup({ viewTools: { cut: CUT, explode: 0 } });
      render(<RoomViewTools />);

      expect(screen.getByTestId('view-tools-badge').textContent).toBe('x50');
    });
  });

  describe('when there is nothing to work on', () => {
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

    it('disables the explode too, for the same reason', () => {
      setup({ activeModelType: 'none', scene: { models: [] }, sceneEntries: {} });
      render(<RoomViewTools />);
      open();

      const toggle = screen.getByTestId('view-tools-explode-toggle') as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
      expect(toggle.title).toContain('no model');
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

    it('cuts the bundled sample but does not offer to explode it, and says why', () => {
      setup({ activeModelType: 'synth', scene: { models: [] }, sceneEntries: {} });
      render(<RoomViewTools />);
      open();

      // A cut is a plane handed to a material, so anything drawn can be cut — including the
      // sample, whose parts are React components rather than a parse.
      expect(screen.queryByTestId('view-tools-unavailable')).toBeNull();
      expect((screen.getByTestId('view-tools-cut-toggle') as HTMLButtonElement).disabled).toBe(false);
      // An explode pushes parts apart through their registry, and the sample has none: the
      // slider would move and the model would not, which is the one control state this file
      // exists to avoid. Off, with the reason on it.
      const explode = screen.getByTestId('view-tools-explode-toggle') as HTMLButtonElement;
      expect(explode.disabled).toBe(true);
      expect(explode.title).toContain('no parts');
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
