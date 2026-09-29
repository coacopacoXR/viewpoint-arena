// The design review a PartyKit room belongs to.
//
// A variant's meeting is held in its own PartyKit room, `<reviewId>~<letter>`
// (lib/reviews/lines.ts partyRoomName), so that it has its own presence, audio and
// scene. Everything that asks WHO may do what in that room — the room server's
// roster read (party/reviewRoles.ts) and the client's own role in
// lib/usePartyPresence — must ask about the REVIEW, not about the room name. Found
// live (batch BQ2): both used the room name, so in a variant room the review's
// owner was judged a participant and nobody could change or seed the models.
//
// No imports: the room server bundles this file too.

/** `abc~A` → `abc`; a main-line room name is already the review id. */
export function reviewIdOfPartyRoom(roomName: string): string {
  const cut = roomName.indexOf('~');
  return cut === -1 ? roomName : roomName.slice(0, cut);
}
