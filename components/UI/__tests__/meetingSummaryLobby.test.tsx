// The way back to the lobby from the end-of-meeting board.
//
// docs/plan/15-sessions-and-variants.md batch BP. The Session Review Board is where a
// meeting lands when somebody presses End Session, and until this batch it offered two
// ways out: the tracker, and the room the meeting was held in. Neither is the lobby, so
// a person who had finished one design review and wanted the list of them had to edit the
// address bar — on the one screen in the app that everybody reaches at the end of every
// meeting.
//
// The button is six lines of JSX, so what is worth pinning is the two things a reader
// cannot see from it: that it goes to `/`, which is the lobby's route, and that it is a
// NAVIGATION and not a store action — the board's other button, "Return to Scene", calls
// endMeeting(false) and leaves the person in the room. Two buttons that look alike and do
// different kinds of thing is exactly the confusion worth a test.
//
// Rendered for real, inside a router, with a route standing at `/` to arrive at.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import MeetingSummary from '../MeetingSummary';
import { useStore } from '../../../store';

/** Where the board is: inside a room, at the end of a meeting. */
const ROOM = '/room/9f1c2b3a';

function renderBoard() {
  render(
    <MemoryRouter initialEntries={[ROOM]}>
      <Routes>
        <Route path="/" element={<div data-testid="lobby" />} />
        <Route path="*" element={<MeetingSummary />} />
      </Routes>
    </MemoryRouter>,
  );
}

let wasEnded: boolean;

beforeEach(() => {
  wasEnded = useStore.getState().isMeetingEnded;
  // The board only draws once the meeting has ended, which is the state End Session puts
  // the store in.
  useStore.setState({ isMeetingEnded: true });
});

afterEach(() => {
  useStore.setState({ isMeetingEnded: wasEnded });
  cleanup();
});

describe('the Session Review Board\'s way back', () => {
  it('offers a Lobby button beside the tracker and the room', () => {
    renderBoard();

    const lobby = screen.getByTestId('summary-lobby');
    expect(lobby.textContent).toContain('Lobby');
    // Still in the room: the board is on screen, and so are its two other ways out.
    expect(screen.getByText('Open Tracker →')).toBeTruthy();
    expect(screen.getByText('Return to Scene')).toBeTruthy();
    expect(screen.queryByTestId('lobby')).toBeNull();
  });

  it('goes to the lobby when pressed, and leaves the room behind', () => {
    renderBoard();

    fireEvent.click(screen.getByTestId('summary-lobby'));

    expect(screen.getByTestId('lobby')).toBeTruthy();
    expect(screen.queryByTestId('summary-lobby')).toBeNull();
    // A navigation, not a store action: the meeting stays ended, because walking out of
    // the board to the list of design reviews is not the same as returning to the scene.
    expect(useStore.getState().isMeetingEnded).toBe(true);
  });

  it('leaves "Return to Scene" doing what it always did', () => {
    renderBoard();

    fireEvent.click(screen.getByText('Return to Scene'));

    // endMeeting(false) puts the person back in the room, so the board goes away and the
    // meeting is no longer ended. The two buttons must not be confused with each other.
    expect(screen.queryByTestId('summary-lobby')).toBeNull();
    expect(useStore.getState().isMeetingEnded).toBe(false);
  });
});
