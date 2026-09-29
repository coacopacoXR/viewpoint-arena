// The top bar's Edit button: who gets one, and what pressing it does.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. Two things are pinned here.
//
// The first is that the button is HIDDEN, never disabled, for somebody who may
// not edit this review: a control greyed out for a person who will never have it
// is a question the room then has to answer, and the room server would refuse the
// press anyway. That is also why `canEditReview` without an `onEditReview` shows
// nothing — the JSX asks for both, so a bar that was told "yes" but has nobody to
// ask cannot offer a button that does nothing.
//
// The second is that adding it displaced nothing: the highlight granularity, the
// pointer menu, People, Share, Privacy and Boardroom are the meeting's controls,
// and a person who is not editing must find them exactly where they were.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TopBar from '../TopBar';

// XRButton reads the xrStore singleton, and createXRStore injects the WebXR
// emulator under jsdom (it wants WebGL2RenderingContext, and throws as an
// unhandled rejection that fails the run). Nothing here is about XR, so the
// singleton is stubbed the way participantsPanelGuest.test.tsx stubs it — and
// the stub's no-op comes from vi.hoisted, because TopBar is imported statically
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

type BarProps = React.ComponentProps<typeof TopBar>;

/** The bar as a host sees it, with the room's own handlers already spies. */
function renderBar(overrides: Partial<BarProps> = {}) {
  const props: BarProps = {
    isHost: true,
    roomId: 'room-1',
    showShare: false,
    onToggleShare: vi.fn(),
    showParticipants: false,
    onToggleParticipants: vi.fn(),
    onOpenDeicticExplainer: vi.fn(),
    ...overrides,
  };
  // Inside a router: the bar carries LineChip and, since batch BQ, StartVariant, and
  // both navigate — the second unconditionally, because starting a variant ends in the
  // new variant's room.
  return render(<MemoryRouter><TopBar {...props} /></MemoryRouter>);
}

afterEach(() => {
  cleanup();
});

describe('the top bar\'s Edit button', () => {
  it('is there, and labelled Edit, for somebody who may edit the review', () => {
    renderBar({ canEditReview: true, onEditReview: vi.fn() });

    const edit = screen.getByTitle('Edit the review');
    expect(edit).toBeInTheDocument();
    expect(edit).toHaveTextContent('Edit');
    expect(edit).toBeEnabled();
  });

  it('is hidden, not disabled, for somebody who may not', () => {
    renderBar({ canEditReview: false, onEditReview: vi.fn() });

    // Absent rather than greyed out: there is no button to be found at all, and
    // nothing else on the bar became disabled to hide it.
    expect(screen.queryByTitle('Edit the review')).toBeNull();
    for (const button of screen.getAllByRole('button')) expect(button).toBeEnabled();
  });

  it('is hidden when there is nobody to ask, even with permission', () => {
    // The JSX is `canEditReview && onEditReview`, so "may edit" alone is not
    // enough — a bar with no handler would offer a press that goes nowhere.
    renderBar({ canEditReview: true });

    expect(screen.queryByTitle('Edit the review')).toBeNull();
  });

  it('asks the room exactly once per press', () => {
    const onEditReview = vi.fn();
    renderBar({ canEditReview: true, onEditReview });

    fireEvent.click(screen.getByTitle('Edit the review'));

    expect(onEditReview).toHaveBeenCalledTimes(1);
  });

  it('leaves the meeting\'s own controls on the bar beside it', () => {
    renderBar({ canEditReview: true, onEditReview: vi.fn() });

    expect(screen.getByTitle('Participants')).toBeInTheDocument();
    expect(screen.getByTitle('Share')).toBeInTheDocument();
    expect(screen.getByTitle('Privacy')).toBeInTheDocument();
    expect(screen.getByTitle('Boardroom')).toBeInTheDocument();
    expect(screen.getByTitle('Highlight whole model')).toBeInTheDocument();
    expect(
      screen.getByTitle('Pointer tools: finger pointing and hover dwell'),
    ).toBeInTheDocument();
  });

  it('leaves the meeting\'s own controls on the bar without it', () => {
    renderBar({ canEditReview: false });

    expect(screen.getByTitle('Participants')).toBeInTheDocument();
    expect(screen.getByTitle('Share')).toBeInTheDocument();
    expect(screen.getByTitle('Privacy')).toBeInTheDocument();
  });
});
