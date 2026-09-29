import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ViewMode } from '../../../types';

const mockSetSplitScreenTarget = vi.fn();
const mockSetViewMode = vi.fn();

let storeState: Record<string, unknown>;

vi.mock('../../../store', () => ({
  useStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(storeState);
    return storeState;
  },
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    remoteParticipantList: remoteParticipants,
    localUserId: 'local-1',
  }),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: (s: Record<string, unknown>) => unknown) => fn,
}));

let remoteParticipants: { userId: string; name: string; color: string }[] = [];

import SplitViewOverlay from '../SplitViewOverlay';

function baseStore(overrides: Record<string, unknown> = {}) {
  return {
    viewMode: ViewMode.SPLIT_SCREEN,
    setViewMode: mockSetViewMode,
    splitScreenTarget: null,
    setSplitScreenTarget: mockSetSplitScreenTarget,
    agents: [
      { id: 'a1', name: 'Atlas', color: '#f00', role: 'REVIEWER' },
    ],
    hideAgents: false,
    ...overrides,
  };
}

describe('SplitViewOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    remoteParticipants = [];
  });

  it('does not render the Agents section when hideAgents is true', () => {
    remoteParticipants = [{ userId: 'p1', name: 'Maria', color: '#0f0' }];
    storeState = baseStore({ hideAgents: true });
    render(<SplitViewOverlay />);

    // Open the picker
    fireEvent.click(screen.getByTitle('Switch split-screen target'));

    expect(screen.queryByText('Agents')).toBeNull();
    expect(screen.getByText('Participants')).toBeTruthy();
  });

  it('shows the empty-state line when the target is an agent but agents are hidden', () => {
    remoteParticipants = [];
    storeState = baseStore({
      hideAgents: true,
      splitScreenTarget: { kind: 'agent', id: 'a1' },
    });
    render(<SplitViewOverlay />);

    expect(
      screen.getByText(/No one else is here yet/),
    ).toBeTruthy();
  });
});

describe('SplitViewOverlay — someone joins while split view is empty', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    remoteParticipants = [];
  });

  it('picks the first participant when nothing was picked', () => {
    remoteParticipants = [{ userId: 'p1', name: 'Maria', color: '#0f0' }];
    storeState = baseStore({ splitScreenTarget: null });
    render(<SplitViewOverlay />);
    expect(mockSetSplitScreenTarget).toHaveBeenCalledWith({ kind: 'user', userId: 'p1' });
  });

  it('keeps a hidden agent target and offers a picker instead of the empty line', () => {
    remoteParticipants = [{ userId: 'p1', name: 'Maria', color: '#0f0' }];
    storeState = baseStore({ hideAgents: true, splitScreenTarget: { kind: 'agent', id: 'a1' } });
    render(<SplitViewOverlay />);
    expect(mockSetSplitScreenTarget).not.toHaveBeenCalled();
    expect(screen.queryByText(/No one else is here yet/)).toBeNull();
    expect(screen.getByText('+ Pick someone')).toBeTruthy();
  });
});
