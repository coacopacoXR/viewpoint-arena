// The recording this browser still holds, as an address a card can play a span from.
//
// Task 09b. lib/RecordingContext keeps the stopped recording's Blob in state so Retry can
// send it again, and dismissing the stop panel deliberately keeps it ("The audio is kept").
// A decision card's "Linked components" row can therefore offer the span it was read from —
// but it needs a URL, not a Blob, and it cannot get one from the context:
//
//   * the row is mounted per card in the Capture deck and once in the detail modal, and
//     that modal is opened from four places, three of which (the boardroom, the manager
//     workspace, the meeting summary) have no RecordingProvider above them, so a context
//     read there answers null and the ▶ would never appear;
//   * the context's value is one object rebuilt whenever anything about the recording
//     moves, and a per-card subscriber to it re-renders every card in the deck on each of
//     the elapsed timer's ticks.
//
// So it is a leaf store of its own, in the shape lib/pointingTimelineStore already has:
// one writer (RecordingContext, which owns the Blob and therefore owns the object URL's
// lifetime) and any number of readers, each subscribing to the one field it draws.
//
// Nothing here stores audio. The URL is revoked when the provider replaces or loses the
// Blob, and a reload of the page loses both — see the task report.

import { create } from 'zustand';

export interface KeptRecording {
  /**
   * RECORDING_STATE.startedAt of the recording this is. The key its live transcript lines
   * carry (`live-<startedAt>-…`), and so the only way to tell whether a card's spans are
   * spans of THIS recording rather than of an earlier one in the same room.
   */
  startedAt: number;
  /** An object URL for the recording, created and revoked by lib/RecordingContext. */
  url: string;
}

interface KeptRecordingState {
  recording: KeptRecording | null;
  setKeptRecording: (recording: KeptRecording | null) => void;
}

export const useKeptRecordingStore = create<KeptRecordingState>()((set) => ({
  recording: null,
  setKeptRecording: (recording) => set({ recording }),
}));
