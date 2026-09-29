// @vitest-environment jsdom
//
// Opening a line of a design review — lib/reviews/openLine.ts.
//
// docs/plan/15-sessions-and-variants.md batch BX, and the first thing the user
// reported: "it is not possible to open variants from the lobby". The address every
// "open a line" built was already correct; what was missing was the two things
// pages/RoomPage.tsx's entry guard admits an arrival by — router state carrying
// `fromLobby`, and `sessionStorage.vp_enteredRoom` naming the review — so the room
// sent the person straight back to the lobby and the button looked broken.
//
// What is pinned here is therefore the guard, not the address: a helper that
// navigates to the right place and is still bounced is the bug this file exists to
// keep fixed. The third case matters as much as the first two, because it is the one
// that would otherwise be found in production by somebody who has never typed a name:
// a browser with no stored identity must be sent to the lobby to be asked for one,
// and the lobby must be told WHICH LINE to enter afterwards.

import { beforeEach, describe, expect, it } from 'vitest';
import type { NavigateFunction, NavigateOptions, To } from 'react-router-dom';
import { ENTERED_ROOM_KEY, joinLineIdOf, openLine, roomHref } from '../openLine';
import { roomPath } from '../lines';

const REVIEW = 'review-1';
const LINE_A = 'line-a';

/** One navigation openLine made. */
interface NavCall {
  to: To | number;
  options?: NavigateOptions;
}

/**
 * The one function openLine talks to.
 *
 * A recorder rather than a `vi.fn()`: `NavigateFunction` is an overloaded interface, and
 * the generic mock vitest answers for a bare `vi.fn()` is not assignable to it. A real
 * function with the two overloads' union as its parameter list is, and it records the
 * same thing.
 */
function navigate(): { fn: NavigateFunction; calls: NavCall[] } {
  const calls: NavCall[] = [];
  const fn: NavigateFunction = (to: To | number, options?: NavigateOptions) => {
    calls.push({ to, options });
  };
  return { fn, calls };
}

function lastCall(go: { calls: NavCall[] }): { to: To | number; state: unknown; replace: boolean } {
  expect(go.calls).toHaveLength(1);
  const call = go.calls[0];
  if (!call) throw new Error('navigate was not called');
  return {
    to: call.to,
    state: call.options?.state ?? null,
    replace: call.options?.replace === true,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('roomHref', () => {
  it('leaves the main line’s address with no parameter on it', () => {
    expect(roomHref(REVIEW, null)).toBe(`/room/${REVIEW}`);
    expect(roomHref(REVIEW, '')).toBe(`/room/${REVIEW}`);
  });

  it('puts a variant in the query, where the room reads it from', () => {
    expect(roomHref(REVIEW, LINE_A)).toBe(roomPath(REVIEW, LINE_A));
  });

  it('appends edit=1 as a second parameter, not a second question mark', () => {
    // "?line=x?edit=1" is what string concatenation produced, and a room parsing it
    // reads the line id as "x?edit=1" — a line nobody can resolve, which quietly means
    // the main line. The address is the only thing that says which line was asked for.
    expect(roomHref(REVIEW, LINE_A, true)).toBe(`${roomPath(REVIEW, LINE_A)}&edit=1`);
    expect(roomHref(REVIEW, null, true)).toBe(`/room/${REVIEW}?edit=1`);
  });
});

describe('openLine', () => {
  it('marks the review as entered and navigates with the lobby’s own state', () => {
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
    const go = navigate();

    openLine(go.fn, REVIEW, LINE_A);

    const call = lastCall(go);
    expect(call.to).toBe(roomPath(REVIEW, LINE_A));
    // Both halves of the entry guard, and they are what makes the room keep the
    // person rather than bounce them: the state admits this arrival, and the mark
    // admits every later one — including a reload of the variant's room, where the
    // state is gone because the browser has nothing left to carry it in.
    expect(call.state).toEqual({ fromLobby: true });
    expect(sessionStorage.getItem(ENTERED_ROOM_KEY)).toBe(REVIEW);
  });

  it('opens the main line when no line is named', () => {
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
    const go = navigate();

    openLine(go.fn, REVIEW, null);

    expect(lastCall(go).to).toBe(`/room/${REVIEW}`);
  });

  it('replaces the history entry when asked, and pushes one when not', () => {
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));

    const pushed = navigate();
    openLine(pushed.fn, REVIEW, LINE_A);
    expect(lastCall(pushed).replace).toBe(false);

    const replaced = navigate();
    openLine(replaced.fn, REVIEW, LINE_A, { replace: true });
    expect(lastCall(replaced).replace).toBe(true);
  });

  it('does nothing at all without a review to open', () => {
    const go = navigate();
    openLine(go.fn, null, LINE_A);
    openLine(go.fn, '', LINE_A);
    expect(go.calls).toHaveLength(0);
    expect(sessionStorage.getItem(ENTERED_ROOM_KEY)).toBeNull();
  });

  it('routes a nameless browser to the lobby, and tells the lobby which line to enter', () => {
    // Nobody enters a room nameless — that rule is the lobby's and it is a good one,
    // because the name is what ends up on every card and in every attendee list. So
    // this is the one arrival openLine does not make itself: it hands the review AND
    // the line to the lobby, which asks for the name and enters the line afterwards.
    // Losing the line here would land the person on the main line and they would have
    // to find their way back to the variant they clicked on.
    const go = navigate();

    openLine(go.fn, REVIEW, LINE_A);

    const call = lastCall(go);
    expect(call.to).toBe('/');
    expect(call.state).toEqual({ joinRoomId: REVIEW, joinLineId: LINE_A });
    // And it has NOT marked the room as entered: the person has not entered it, and a
    // mark written here would let the room admit an arrival the lobby never made.
    expect(sessionStorage.getItem(ENTERED_ROOM_KEY)).toBeNull();
  });

  it('reads a stored identity that has a colour but no name as no identity', () => {
    // Signing out clears the name and keeps the colour (lib/identity), so the record is
    // there and getIdentity() still answers nothing — which is the case that must go to
    // the lobby, because a room with no name in it is a room whose cards have no author.
    localStorage.setItem('vp_user', JSON.stringify({ color: '#000' }));
    const go = navigate();

    openLine(go.fn, REVIEW, LINE_A);

    expect(lastCall(go).to).toBe('/');
  });
});

describe('joinLineIdOf', () => {
  it('reads the line a bounce to the lobby asked it to enter', () => {
    expect(joinLineIdOf({ joinRoomId: REVIEW, joinLineId: LINE_A })).toBe(LINE_A);
    expect(joinLineIdOf({ joinRoomId: REVIEW, joinLineId: null })).toBeNull();
    expect(joinLineIdOf({ joinRoomId: REVIEW })).toBeNull();
    expect(joinLineIdOf({ joinLineId: '   ' })).toBeNull();
    expect(joinLineIdOf(null)).toBeNull();
    expect(joinLineIdOf('not state')).toBeNull();
  });
});
