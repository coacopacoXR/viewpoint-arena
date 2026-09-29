// The way out of a room.
//
// docs/plan/15-sessions-and-variants.md batch BN. Until this batch the only way out of
// a meeting was the browser's back button or the address bar, and the room's logo —
// which every other screen in this app treats as home — went nowhere. What is pinned
// here is that the control is THERE, that it says where it goes, and that it goes to
// the lobby rather than one step back in history: a person who was sent a room link
// has no history to go back to, and a person who came from the tracker would land back
// in the tracker.
//
// It is also pinned that leaving this way does NOT end the meeting: nothing here calls
// `endMeeting` or broadcasts MEETING_END. The room's unmount path is what tears the
// meeting down for this browser — lib/usePartyPresence closes the socket, which is how
// the room server drops a closed tab's presence and hands the host to the next arrival,
// and lib/useWebRTC stops the microphone and camera and closes every peer connection.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReviewLine } from '../../../../lib/reviews/lines';
import LobbyLink from '../LobbyLink';

// vi.mock factories are hoisted above the imports, so anything they read has to come
// from vi.hoisted rather than from module scope.
const { noop } = vi.hoisted(() => ({ noop: () => {} }));

// The XR store's WebXR emulator wants WebGL2RenderingContext, which jsdom does not
// have, and it throws as an unhandled rejection that fails the whole run.
vi.mock('../../../../lib/xrStore', () => ({
  xrStore: {
    subscribe: () => noop,
    getState: () => ({ session: null }),
    enterAR: noop,
    enterVR: noop,
  },
}));
// The conversation column scrolls an element, which jsdom does not implement.
vi.mock('../../ConversationPanel', () => ({ default: () => <div data-testid="conversation" /> }));
// The mobile room's canvas mounts R3F, which is the one thing that genuinely cannot
// render here; the header this test is about does not need it.
vi.mock('../../../Scene/ViewpointCanvas', () => ({ default: () => <div data-testid="canvas" /> }));

// Imported after the mocks are registered.
const { default: Interface } = await import('../../Interface');
const { default: MobileRoomView } = await import('../../MobileRoomView');
// The same registries Interface itself resolved them from, so the stores set here are
// the stores the room reads.
const { useActiveReviewStore } = await import('../../../../lib/activeReviewStore');
const { createReviewDraft } = await import('../../../../lib/reviewSetupStore');
const { useStore } = await import('../../../../store');

/** Where the room went, which is the only thing this control has to prove. */
const PathProbe: React.FC = () => <div data-testid="path">{useLocation().pathname}</div>;

function inRoom(children: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/room/room-1']}>
      <Routes>
        <Route path="/room/:roomId" element={children} />
        <Route path="/" element={<PathProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: () => {},
    configurable: true,
    writable: true,
  });
});

afterEach(cleanup);

describe('the Lobby control', () => {
  it('is a link to the lobby, with the arrow and the word', () => {
    inRoom(<LobbyLink />);

    const link = screen.getByRole('link', { name: 'Back to the lobby' });
    expect(link).toHaveAttribute('href', '/');
    expect(link.textContent).toContain('Lobby');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('goes to the lobby when it is clicked, and says where it goes', () => {
    inRoom(<LobbyLink />);

    expect(link()).toHaveAttribute('title', 'Leave this room and go back to the lobby');
    fireEvent.click(link());

    expect(screen.getByTestId('path').textContent).toBe('/');
  });

  it('is the same control in the dark tone the mobile header needs', () => {
    inRoom(<LobbyLink tone="dark" />);

    expect(link()).toHaveAttribute('href', '/');
  });

  function link() {
    return screen.getByRole('link', { name: 'Back to the lobby' });
  }
});

describe('the desktop room', () => {
  it('makes the logo a link back to the lobby and puts the word beside it', () => {
    inRoom(<Interface />);

    // The logo is the link: it is what every other screen in this app means by home.
    const logo = screen.getByRole('link', { name: /VIEWPOINT ARENA/ });
    expect(logo).toHaveAttribute('href', '/');
    // And a link nobody knows is a link is not a control anybody finds twice.
    expect(screen.getByRole('link', { name: 'Back to the lobby' })).toBeInTheDocument();
  });

  it('leaves the room rather than stepping back through the history', () => {
    inRoom(<Interface />);

    fireEvent.click(screen.getByRole('link', { name: 'Back to the lobby' }));

    expect(screen.getByTestId('path').textContent).toBe('/');
  });

  it('ends no meeting and records none on the way out', () => {
    // The Power button is what ends a meeting; this is not it. Asserted as an absence
    // in the room's own chrome rather than as a socket message, because what has to be
    // true is that leaving does not do the thing the room does when a meeting is over.
    inRoom(<Interface />);

    expect(screen.queryByTitle('End meeting')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Back to the lobby' }));
    expect(screen.getByTestId('path').textContent).toBe('/');
  });
});

describe('the mobile room', () => {
  it('has the same control in its own header', () => {
    inRoom(<MobileRoomView roomId="room-1" userName="Alex Chen" />);

    const logo = screen.getByRole('link', { name: /Viewpoint Arena/ });
    expect(logo).toHaveAttribute('href', '/');

    const lobby = screen.getByRole('link', { name: 'Back to the lobby' });
    fireEvent.click(lobby);
    expect(screen.getByTestId('path').textContent).toBe('/');
  });
});

// ─── The corner this control sits in (batch BQ) ───────────────────────────────
//
// Naming a review is only half of the user's complaint: a name nobody can see during
// the meeting is a name that exists in a database. So the name is shown here, in the
// block the logo and the Lobby link are in — the corner every other screen in this app
// uses to say what it is looking at — and it is shown to everybody in the room, not only
// to whoever may edit the review.

describe('the desktop room — which design review it is holding', () => {
  const VARIANT: ReviewLine = {
    id: 'line-a', reviewId: 'room-1', kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parentSessionId: 'sess-3', parentLineId: 'line-main', mergedIntoLineId: null, dropReason: null,
    status: 'active', createdBy: null, createdByName: 'Robin',
    createdAt: '2026-09-20T09:00:00.000Z', closedAt: null,
  };

  beforeEach(() => {
    useActiveReviewStore.setState({ config: createReviewDraft('room-1', 'Door hinge, rev C') });
    useStore.setState({ activeLine: null });
  });

  afterEach(() => {
    useActiveReviewStore.setState({ config: null });
    useStore.setState({ activeLine: null });
  });

  it('names the review beside the way back to the lobby', () => {
    inRoom(<Interface />);

    const tag = screen.getByTestId('review-name-tag');
    expect(tag).toHaveTextContent('Door hinge, rev C');
    // In the SAME block, not somewhere else on the screen: the logo, the way out and the
    // name of what is being looked at are one thing. On the line UNDER the logo rather
    // than inside the h1 with it, because batch BQ2 made this whole block the first item
    // of the header row the top bar sits in — a name inside the h1 was a name the bar
    // covered.
    expect(tag.closest('header')).toBe(
      screen.getByRole('link', { name: 'Back to the lobby' }).closest('header'),
    );
    // And the stopwatch whose line it took is gone: a room that can say what it is
    // looking at has no use for a clock nobody in a meeting was racing.
    expect(screen.queryByText(/Design Review Sim/)).toBeNull();
    // Truncated on screen, whole in the tooltip.
    expect(tag).toHaveAttribute('title', 'Door hinge, rev C');
  });

  it('shares its row with the top bar, which is what stops the two overlapping', () => {
    inRoom(<Interface />);

    const row = screen.getByTestId('review-name-tag').closest('header')?.parentElement;
    expect(row).toBeTruthy();
    // ONE absolutely placed row, inset from the right by exactly what the canvas is
    // inset, with the name plate first and the bar taking what is left. The bar used to
    // be a second absolute block centred from `left-[300px]`, which is how it came to
    // cover the name plate and run under the side panel at 1600x900: it was centred on a
    // space it did not own, and nothing told it how wide the block beside it was.
    expect(row?.className).toContain('absolute');
    expect(row?.className).toContain('left-6');
    expect(row?.className).toMatch(/right-\[364px\]|right-\[72px\]|right-6/);
    expect(row?.querySelector('[data-testid="top-bar-box"]')).toBeTruthy();
  });

  it('says which review a variant\'s room belongs to', () => {
    useStore.setState({ activeLine: VARIANT });
    inRoom(<Interface />);

    const tag = screen.getByTestId('review-name-tag');
    expect(tag).toHaveTextContent('Door hinge, rev C · Variant A');
    // LineChip, on the same bar, already carries the variant's own name and its two
    // decisions; the corner says the thing the chip cannot, which review it is a variant
    // OF, because two reviews can each have a Variant A.
    expect(tag.textContent).not.toContain('Steel hinge pin');
  });

  it('shows no tag at all in a room holding no review', () => {
    useActiveReviewStore.setState({ config: null });
    inRoom(<Interface />);

    // An empty chip in the corner would look like a rendering bug rather than like a
    // review nobody named.
    expect(screen.queryByTestId('review-name-tag')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the lobby' })).toBeInTheDocument();
  });
});
