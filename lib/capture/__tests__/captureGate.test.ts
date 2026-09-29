// The gate that pauses capture while a design review is being edited.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH: "While Edit is on for anyone in
// the room, capture (live transcript and card extraction) is paused for the room,
// and resumes on Done."
//
// What is pinned here is the CONTRACT the two capture paths rely on, because they
// have nothing else in common: one asks from inside a React render (the per-speaker
// slicer, through lib/RecordingContext) and one asks from an async queue processor
// that has no render cycle at all (the extractor). A module with one writer and no
// opinion of its own is what lets both get the same answer.
//
// The pause being ROOM-wide rather than mine is the part that is easy to get
// wrong, and it is asserted here by name: the reason sentence names whoever has
// Edit on, who is usually not the person reading it.

import { describe, it, expect, afterEach } from 'vitest';
import {
  capturePausedBy,
  capturePauseReason,
  isCapturePaused,
  setCapturePausedBy,
} from '../captureGate';

describe('captureGate', () => {
  afterEach(() => {
    // The module holds one value for the whole process, so a test that leaves it
    // set would silently pause capture for every later test in the file.
    setCapturePausedBy(null);
  });

  it('starts unpaused, because nobody is editing when a room opens', () => {
    expect(isCapturePaused()).toBe(false);
    expect(capturePausedBy()).toBeNull();
  });

  it('is paused by a name, and says who', () => {
    setCapturePausedBy('Robin');

    expect(isCapturePaused()).toBe(true);
    expect(capturePausedBy()).toBe('Robin');
    expect(capturePauseReason()).toBe('Capture is paused while Robin edits the review.');
  });

  it('resumes on null, which is what Done produces', () => {
    setCapturePausedBy('Robin');
    setCapturePausedBy(null);

    expect(isCapturePaused()).toBe(false);
    expect(capturePausedBy()).toBeNull();
  });

  it('names whoever has Edit on, not the person reading the sentence', () => {
    // The pause is the room's, so a participant who never touched Edit is told
    // why THEIR microphone went quiet — which would be a mystery otherwise.
    setCapturePausedBy('Maria');
    expect(capturePauseReason()).toContain('Maria');
  });

  it('hands over from one editor to the next without an unpaused moment in between', () => {
    // A take-over is one EDITING_STATE after another. A gate that only ever
    // cleared on null would leave the room capturing between the two.
    setCapturePausedBy('Robin');
    setCapturePausedBy('Maria');

    expect(isCapturePaused()).toBe(true);
    expect(capturePausedBy()).toBe('Maria');
  });

  it('still reads as paused, with a generic sentence, when the editor has no name', () => {
    // An empty name is what the room server sends for a connection whose
    // participant entry it could not name. Pausing must not depend on having one.
    setCapturePausedBy('');

    // '' is falsy but it IS a value the writer set; the gate keys on null alone,
    // so the room stays paused and falls back to the nameless sentence.
    expect(isCapturePaused()).toBe(true);
    expect(capturePauseReason()).toBe('Capture is paused while the review is being edited.');
  });
});
