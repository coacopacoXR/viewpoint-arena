// Pointer ▾ keeps the two set-and-forget deictic toggles out of the top bar —
// but an active pointer that you cannot see from the bar is how people end up
// pointing without knowing, so the button carries a dot while either is on.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

let storeState: Record<string, unknown>;

interface FingerState {
  mode: string;
  calibration: unknown;
  enableFingerPointer: ReturnType<typeof vi.fn>;
  disableFingerPointer: ReturnType<typeof vi.fn>;
  startRecalibration: ReturnType<typeof vi.fn>;
}

let fingerState: FingerState;

vi.mock('../../../store', () => ({
  useStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(storeState);
    return storeState;
  },
}));

vi.mock('../../../lib/fingerPointerStore', () => ({
  useFingerPointerStore: (selector?: (s: FingerState) => unknown) => {
    if (typeof selector === 'function') return selector(fingerState);
    return fingerState;
  },
}));

import PointerMenu from '../room/PointerMenu';

const MENU_BUTTON = 'Pointer tools: finger pointing and hover dwell';
const DOT = 'A pointer tool is on';

function setup(options: { fingerMode?: string; hover?: boolean } = {}) {
  storeState = {
    hoverPointingEnabled: options.hover ?? false,
    setHoverPointingEnabled: vi.fn(),
  };
  fingerState = {
    mode: options.fingerMode ?? 'disabled',
    calibration: null,
    enableFingerPointer: vi.fn(),
    disableFingerPointer: vi.fn(),
    startRecalibration: vi.fn(),
  };
}

function openMenu() {
  fireEvent.click(screen.getByTitle(MENU_BUTTON));
}

describe('PointerMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps both toggles folded until it is opened', () => {
    render(<PointerMenu onOpenExplainer={vi.fn()} />);

    expect(screen.queryByText('Finger')).toBeNull();
    expect(screen.queryByText('Hover')).toBeNull();

    openMenu();

    expect(screen.getByText('Finger')).toBeTruthy();
    expect(screen.getByText('Hover')).toBeTruthy();
  });

  it('toggling Finger calls the finger-pointer store', () => {
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    openMenu();

    fireEvent.click(screen.getByTitle('Enable finger pointer'));

    expect(fingerState.enableFingerPointer).toHaveBeenCalledTimes(1);
    expect(fingerState.disableFingerPointer).not.toHaveBeenCalled();
  });

  it('toggling an active Finger off calls disable, and offers recalibration', () => {
    setup({ fingerMode: 'active' });
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    openMenu();

    fireEvent.click(screen.getByTitle('Disable finger pointer'));
    expect(fingerState.disableFingerPointer).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle('Recalibrate corners')).toBeNull();
  });

  it('offers recalibration once a calibration exists', () => {
    setup({ fingerMode: 'active' });
    fingerState.calibration = { corners: [] };
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    openMenu();

    fireEvent.click(screen.getByTitle('Recalibrate corners'));

    expect(fingerState.startRecalibration).toHaveBeenCalledTimes(1);
  });

  it('toggling Hover calls the existing store setter', () => {
    setup({ hover: true });
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    openMenu();

    fireEvent.click(screen.getByTitle('Disable hover-to-point'));

    expect(storeState.setHoverPointingEnabled).toHaveBeenCalledTimes(1);
    expect(storeState.setHoverPointingEnabled).toHaveBeenCalledWith(false);
  });

  it('shows the dot when either toggle is on, and hides it when neither is', () => {
    const { unmount } = render(<PointerMenu onOpenExplainer={vi.fn()} />);
    expect(screen.queryByTitle(DOT)).toBeNull();
    unmount();

    setup({ hover: true });
    const second = render(<PointerMenu onOpenExplainer={vi.fn()} />);
    expect(screen.getByTitle(DOT)).toBeTruthy();
    second.unmount();

    setup({ fingerMode: 'active' });
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    expect(screen.getByTitle(DOT)).toBeTruthy();
  });

  it('closes on Escape', () => {
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    openMenu();
    expect(screen.getByText('Finger')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('Finger')).toBeNull();
  });

  it('closes on a click outside', () => {
    render(<PointerMenu onOpenExplainer={vi.fn()} />);
    openMenu();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText('Finger')).toBeNull();
  });

  it('"What are these?" opens the deictic explainer and closes the menu', () => {
    const onOpenExplainer = vi.fn();
    render(<PointerMenu onOpenExplainer={onOpenExplainer} />);
    openMenu();

    fireEvent.click(screen.getByText('What are these?'));

    expect(onOpenExplainer).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Finger')).toBeNull();
  });
});
