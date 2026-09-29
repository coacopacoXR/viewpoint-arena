// What the lobby's "Room code or link" box accepts.
//
// docs/plan/15-sessions-and-variants.md batch BO. The box used to take a bare room id
// and nothing else, which meant the one thing everybody actually has — the link
// somebody pasted into Teams — had to be unpicked by hand before it could be used.
// A link is the review's address, the address already names the room and (since batch
// BK) the line of the review the meeting is on, so all three spellings have to work:
//
//   abc123                              a bare id
//   /room/abc123                        the path this app serves
//   https://x/room/abc123?line=<id>     the whole link, variant and all
//
// The LINE matters and is not decoration: dropping it would put somebody who was
// invited to Variant A into the main line's room, which is a different meeting
// looking at a different model. It is carried through to the address the lobby
// navigates to, which is lib/reviews/lines.roomPath's job and not this one's.
//
// Pure and dependency-free so a test can hand it strings and nothing else.

import { lineIdFromSearch } from '../reviews/lines';

/** A room to enter, and the line of its review to enter it on. */
export interface JoinTarget {
  roomId: string;
  /** Null for the main line, which is every address that predates lines. */
  lineId: string | null;
}

/** The `/room/<id>` part of an address, with or without a host in front of it. */
const ROOM_PATH = /\/room\/([^/?#\s]+)/;

/** The query of a pasted address, if it has one, as `lineIdFromSearch` wants it. */
function queryOf(rest: string): string {
  const at = rest.indexOf('?');
  return at >= 0 ? rest.slice(at) : '';
}

/**
 * Read a room out of whatever was typed or pasted.
 *
 * Null when there is nothing to enter: an empty box, a stray slash, a URL with no
 * room in it. Answering null rather than guessing is the point — the lobby then says
 * "Enter a room code or link." instead of opening a room called `https:`.
 */
export function parseJoinTarget(raw: string): JoinTarget | null {
  const text = raw.trim();
  if (text === '') return null;

  const room = ROOM_PATH.exec(text);
  if (room) {
    const roomId = room[1];
    if (roomId === '') return null;
    return { roomId, lineId: lineIdFromSearch(queryOf(text.slice(room.index + room[0].length))) };
  }

  // No `/room/` anywhere in it, so it is a bare id — possibly with a query somebody
  // copied along with it. A slash here means a URL this code does not recognise
  // (another page of the app, somebody else's server) and is refused rather than
  // entered as a room id that will never resolve.
  if (text.includes('/')) return null;
  const [head = '', ...tail] = text.split('?');
  const roomId = head.split('#')[0].trim();
  if (roomId === '' || /\s/.test(roomId)) return null;
  return { roomId, lineId: lineIdFromSearch(tail.length > 0 ? `?${tail.join('?')}` : '') };
}
