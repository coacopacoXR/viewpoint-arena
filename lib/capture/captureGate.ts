// Whether the room may capture right now, and who is the reason it may not.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. "While Edit is on for anyone in
// the room, capture is paused." That is a rule about the ROOM, but the things it
// stops are two clientside paths with nothing else in common — the per-speaker live
// transcript and the mixed recording that becomes insight cards — and neither of
// them knows about the review's edit lock. So the rule lives here, as one question
// both of them ask, and both of them get the same answer.
//
// A module rather than a store selector because one of the two callers is not a
// component: capture runs from an async queue processor outside the React render
// cycle, and a hook would be unreachable there. The value is still driven from
// React — lib/RecordingContext writes it whenever the room server's EDITING_STATE
// changes — so there is one writer and the module holds no opinion of its own.
//
// WHY capture stops at all, since the call keeps running: the conversation while
// somebody is curating is about the review ("no, put that slide after the pin"),
// not about the design. Transcribing it puts curation chatter in the transcript,
// and extracting from it produces cards about the meeting that was not the
// meeting. Pausing loses a few minutes of that chatter and keeps the record about
// the design review.

let pausedBy: string | null = null;

/**
 * Set by the room, from EDITING_STATE. `name` is who has Edit on, or null when
 * nobody does — which is also "capture may run".
 */
export function setCapturePausedBy(name: string | null): void {
  pausedBy = name;
}

/** Whether capture is paused right now. */
export function isCapturePaused(): boolean {
  return pausedBy !== null;
}

/** Who is the reason capture is paused, or null when it is running. */
export function capturePausedBy(): string | null {
  return pausedBy;
}

/**
 * The sentence a capture path shows instead of doing its work.
 *
 * One place rather than two, so the transcript and the extractor cannot end up
 * telling the same person two different things about the same pause.
 */
export function capturePauseReason(): string {
  return capturePauseReasonFor(pausedBy);
}

/**
 * The same sentence for a name the caller already has.
 *
 * Split out because a component that DISABLES a button with the reason needs that
 * sentence on the render where the room's editing state changed, and the module's
 * own copy is written by an effect — so at that moment it still holds the previous
 * render's answer. Taking the name as an argument keeps the wording in one place and
 * the disabled button's reason true on the render it appears.
 */
export function capturePauseReasonFor(name: string | null): string {
  return name
    ? `Capture is paused while ${name} edits the review.`
    : 'Capture is paused while the review is being edited.';
}
