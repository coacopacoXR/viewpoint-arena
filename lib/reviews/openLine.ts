// Opening a line of a design review, from anywhere in the app.
//
// docs/plan/15-sessions-and-variants.md batch BX, and it exists because of a bug the
// user found by pressing a button: "it is not possible to open variants from the
// lobby". The lobby's Lines list and the session map's line panel both linked to
// `roomPath(reviewId, lineId)` — the right address — and the room still sent the
// person straight back to the lobby, because pages/RoomPage.tsx's entry guard admits
// an arrival in exactly two ways and a plain <Link> is neither:
//
//   * router state carrying `fromLobby: true`, which pages/LobbyPage.tsx's
//     `enterRoom` sets; or
//   * `sessionStorage.vp_enteredRoom` already naming this review, which the same
//     function writes and which is what lets a RELOAD of a room back in.
//
// So every "open a line" that was not the lobby's own button bounced. One helper, and
// every surface uses it: the guard is a fact about how a room is entered and not about
// which button was pressed, and a second copy of it is a second way to get it wrong.
//
// WHAT IT DOES ABOUT THE NAME. Nobody enters a room nameless — that rule is the
// lobby's and it is a good one, because the name is what ends up on every card and in
// every attendee list. A browser that has no stored identity yet therefore is not
// taken to the room at all: it is taken to the lobby with the review AND the line in
// the router state, and the lobby asks for the name and enters the line itself. Every
// other case goes straight in, having first written the same mark `enterRoom` writes.

import type { NavigateFunction } from 'react-router-dom';
import { getIdentity } from '../identity';
import { LINE_QUERY_PARAM, roomPath } from './lines';

/**
 * The sessionStorage key the room's entry guard reads.
 *
 * Exported rather than spelled a fourth time: pages/RoomPage.tsx, pages/LobbyPage.tsx
 * and components/auth/IdentityGate.tsx all write it, and a key that is a literal in
// four files is a key that will be a literal in five.
 */
export const ENTERED_ROOM_KEY = 'vp_enteredRoom';

export interface OpenLineOptions {
  /**
   * Open with Edit already on. The lobby's "New design review" is the only caller:
   * the person who just created a review is the one about to put a model in it.
   */
  edit?: boolean;
  /** Replace the history entry rather than pushing one. */
  replace?: boolean;
}

/**
 * The address of a line's room, with `edit=1` appended the way a query is appended.
 *
 * Built here rather than by string concatenation at the call site because
 * `roomPath` may already have put `?line=` in it, and a second `?` produces an
 * address whose `line` parameter reads as "<id>?edit=1" — a line nobody can resolve,
// which silently means the main line.
 */
export function roomHref(reviewId: string, lineId: string | null, edit = false): string {
  const path = roomPath(reviewId, lineId);
  if (!edit || !path) return path;
  return path.includes('?') ? `${path}&edit=1` : `${path}?edit=1`;
}

/**
 * Record that this browser entered this review deliberately.
 *
 * Swallowed rather than thrown: sessionStorage is full in some private modes and
 * absent in others, and a room that cannot be reloaded into is a smaller problem than
 * a navigation that never happens. The router state below still admits the arrival.
 */
export function markRoomEntered(reviewId: string): void {
  if (!reviewId) return;
  try {
    sessionStorage.setItem(ENTERED_ROOM_KEY, reviewId);
  } catch {
    // Nothing to do. `state: { fromLobby: true }` carries this arrival in on its own.
  }
}

/**
 * Open one line of one design review in its room.
 *
 * `lineId` null is the main line, whose address deliberately carries no parameter —
 * see lib/reviews/lines.roomPath. Every "open a line" in the app goes through here:
 * the lobby's Lines list, the session map's line panel (in the room, in the lobby and
 * in the tracker), the room's own chip menu and its Variant menu, and the panel that
 * has just started a variant and wants to stand in it.
 *
 * The lobby does NOT: it has a form to submit first and calls its own `enterRoom`,
 * which writes this browser's name as well as the mark below. That is the one place
 * the two differ, and it is why `openLine` refuses to invent a name and sends a
 * nameless browser to the lobby instead.
 */
export function openLine(
  navigate: NavigateFunction,
  reviewId: string | null | undefined,
  lineId: string | null | undefined,
  options: OpenLineOptions = {},
): void {
  if (!reviewId) return;
  const wanted = typeof lineId === 'string' && lineId.trim() !== '' ? lineId.trim() : null;
  const replace = options.replace === true;

  // No name yet, so no meeting to be in. The lobby asks, and enters the SAME line
  // afterwards — `joinLineId` is what carries it there, because a bounce that lost
  // the variant would land the person on the main line and they would have to find
  // their way back.
  if (!getIdentity()) {
    navigate('/', { state: { joinRoomId: reviewId, joinLineId: wanted }, replace });
    return;
  }

  markRoomEntered(reviewId);
  navigate(roomHref(reviewId, wanted, options.edit === true), {
    state: { fromLobby: true },
    replace,
  });
}

/** The line a bounce to the lobby asked it to enter, or null. See openLine. */
export function joinLineIdOf(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)['joinLineId'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The `line` parameter of an address, for a caller that has the path and not the search. */
export function lineIdOfHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const query = href.indexOf('?');
  if (query < 0) return null;
  try {
    const value = new URLSearchParams(href.slice(query + 1)).get(LINE_QUERY_PARAM);
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}
