// Whether THIS browser has edited the review it is holding, and not yet saved it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH3. The room used to write its
// review to the database whenever the copy it was holding changed — and that copy
// also changes when a REVIEW_CONFIG arrives from somebody else, when the room
// seeds itself from the lobby's handover draft, and when the row is read back on
// entry. None of those is this browser's work, and writing them is how a view one
// person saved was overwritten by an empty review another person's browser still
// had lying around: the second browser was the host, so it was listening, and it
// saved what it had just been handed.
//
// So an edit raises a mark, and pages/RoomPage.tsx saves on that mark and on
// nothing else. A mark rather than a timestamp or a row version: the room allows
// one editor at a time (batch BH), so "did I just change this?" is the whole of
// the question, and last-writer-wins is the whole of the conflict policy.

let editedHere = false;

/**
 * This browser changed the review.
 *
 * Called by every action in lib/activeReviewStore that produces a draft — the
 * curation tabs' writes, the amber strip's "Save this view", the Review popup's
 * renames, a pin committed as a comment, the manager's slide follow-ups — and by
 * nothing else. In particular not by `setConfig`, which is how a copy from the
 * room server, from the database or from the lobby arrives.
 */
export function markLocalEdit(): void {
  editedHere = true;
}

/**
 * Whether this browser changed the review since the mark was last taken — and, if
 * it did, take it, so that one edit produces one save.
 */
export function consumeLocalEdit(): boolean {
  const edited = editedHere;
  editedHere = false;
  return edited;
}

/**
 * Drop the mark without saving anything.
 *
 * Two callers. One adopts a copy of the review that came from elsewhere, where a
 * mark left over from a change no writer was listening for must not licence the
 * next change to be written as this browser's own. The other is an edit that
 * found nothing to change, which is not an edit.
 */
export function forgetLocalEdit(): void {
  editedHere = false;
}
