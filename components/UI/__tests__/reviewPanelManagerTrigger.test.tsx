// The manager view has one entry point per surface: the call bar's Manage
// button in the arena, and — because the boardroom has no call bar — the
// trigger inside the boardroom's (dark) review panel. Removing the latter left
// a host presenting in the boardroom with no way to open the workspace.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const setManagerMode = vi.fn();
const reviewState: Record<string, unknown> = {
  config: { title: 'R', viewpoints: [{ id: 'v1', name: 'V1' }], pins: [], agenda: [] },
  activeViewpointIdx: 0,
  agendaIdx: 0,
  setManagerMode,
};

vi.mock('../../../lib/activeReviewStore', () => ({
  useActiveReviewStore: (sel: (s: Record<string, unknown>) => unknown) => sel(reviewState),
}));
vi.mock('../../../store', () => ({
  useStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ sessionHostId: 'me', addComment: vi.fn() }),
}));
vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({ broadcastReviewConfig: vi.fn(), broadcastCommentAdd: vi.fn(), localUserId: 'me' }),
}));

import ReviewPanelContent from '../ReviewPanelContent';

afterEach(() => {
  cleanup();
  setManagerMode.mockClear();
});

describe('ReviewPanelContent manager trigger', () => {
  it('is offered to the host in the boardroom (dark) panel', () => {
    render(<ReviewPanelContent theme="dark" />);
    fireEvent.click(screen.getByText('Open Manager view'));
    expect(setManagerMode).toHaveBeenCalledWith(true);
  });

  it('is not in the arena (light) panel, where the call bar has Manage', () => {
    render(<ReviewPanelContent theme="light" />);
    expect(screen.queryByText('Open Manager view')).toBeNull();
  });
});
