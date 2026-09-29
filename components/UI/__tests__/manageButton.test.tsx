// The Manage button is the ONE entry point to the host's split-screen manager
// workspace. It used to live at the foot of ReviewPanelContent, which only
// renders when the review already has viewpoints, pins or slides — so the
// workspace was unreachable in exactly the meeting that has produced nothing
// yet. These tests never give the review store a config at all.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

let storeState: Record<string, unknown>;
let localUserId = 'local-1';

vi.mock('../../../store', () => ({
  useStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(storeState);
    return storeState;
  },
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({ localUserId }),
}));

const setManagerMode = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/activeReviewStore', () => ({
  useActiveReviewStore: { getState: () => ({ setManagerMode }) },
}));

import ManageButton from '../room/ManageButton';

describe('ManageButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localUserId = 'local-1';
    storeState = { sessionHostId: 'local-1' };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders for the host with no review config at all', () => {
    render(<ManageButton />);

    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('renders for a solo session, where no host was ever recorded', () => {
    storeState = { sessionHostId: null };
    render(<ManageButton />);

    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('does not render for somebody who is not the host', () => {
    storeState = { sessionHostId: 'somebody-else' };
    const { container } = render(<ManageButton />);

    expect(container.firstChild).toBeNull();
  });

  it('opens the manager workspace', () => {
    render(<ManageButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));

    expect(setManagerMode).toHaveBeenCalledTimes(1);
    expect(setManagerMode).toHaveBeenCalledWith(true);
  });
});
