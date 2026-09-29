// "Save the transcript with this meeting" — the choice, held where the browser
// that records the meeting can read it.
//
// docs/plan/15-sessions-and-variants.md batch BU. The person who stops a recording
// is not necessarily the person who ends the meeting: one meeting is recorded once,
// by the browser whose person pressed End (store.ts's endMeeting, and see
// meetingEndedRemotely for why the others do not write). So the choice cannot live
// in the React state of the panel that offered it — the panel is on the recorder's
// screen and the write happens on somebody else's.
//
// It travels as a room message instead. TRANSCRIPT_KEEP is sent by whoever presses
// the button, kept in the room server's memory for the room, relayed to every
// client, and sent to a client that joins later — so whichever browser ends up
// recording the meeting already holds the latest answer when it does.
//
// This module holds the value and nothing else, for the reason
// lib/recordingState.ts gives for itself: store.ts reads it inside endMeeting, and
// lib/usePartyPresence imports the store, so a store → usePartyPresence read would
// be a cycle that also drags partysocket into every test that imports store.ts.

export interface TranscriptKeepPayload {
  /** Whether the meeting's transcript is to be stored on its session row. */
  keep: boolean;
  /** Whether "where people were pointing at" is part of it. */
  includePointing: boolean;
  /** Who chose it, for the room's audit trail. Not trusted for anything. */
  byName: string;
}

export const transcriptKeepRef: { current: TranscriptKeepPayload | null } = { current: null };

/**
 * The room's latest answer, or null when nobody has pressed the button.
 *
 * Null and `{ keep: false }` are the same decision and are both "do not store it",
 * which is what makes the default safe: a client that missed the message, a room
 * server that restarted, and a meeting nobody thought about all record the meeting
 * exactly as they did before this batch.
 */
export function getTranscriptKeep(): TranscriptKeepPayload | null {
  return transcriptKeepRef.current;
}

/** Write the value. Both writers are in lib/usePartyPresence: the broadcast and the relayed message. */
export function setTranscriptKeep(payload: TranscriptKeepPayload | null): void {
  transcriptKeepRef.current = payload;
}
