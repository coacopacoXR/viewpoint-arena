// The room's recording state, held where any reader can reach it.
//
// Split out of lib/usePartyPresence.ts (docs/plan/15-sessions-and-variants.md
// batch BM) for one reason: store.ts's endMeeting has to know WHEN the recording
// started, because that is the key the live transcript lines in chatHistory carry
// (`live-<startedAt>-…`) and so the only way to pick this meeting's transcript out
// of a room that recorded twice. lib/usePartyPresence imports the store, so a
// store → usePartyPresence read would be a cycle that also drags partysocket into
// every test that imports store.ts. The ref has no dependencies of its own, so it
// lives here and both sides import it.
//
// The writers are unchanged and are still both in usePartyPresence —
// broadcastRecordingState (the browser that pressed Start or Stop) and the
// RECORDING_STATE handler (every other browser in the room) — and so is
// subscribeRecordingState, which notifies React. This module only holds the value.

export interface RecordingStatePayload {
  recording: boolean;
  startedAt: number;
  byUserId: string;
  byName: string;
}

export const recordingStateRef: { current: RecordingStatePayload | null } = { current: null };

/**
 * The room's recording state, or null when it has never recorded.
 *
 * `startedAt` survives the recording stopping — the browser that stops it
 * broadcasts `{ recording: false, startedAt }` — which is what makes it still the
 * right key at meeting-end, when the transcript has to be selected but the
 * recording is over.
 */
export function getRecordingState(): RecordingStatePayload | null {
  return recordingStateRef.current;
}
