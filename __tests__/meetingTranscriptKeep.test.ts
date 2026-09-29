// The transcript is stored by the browser that RECORDS the meeting, and only when
// the meeting asked for it.
//
// docs/plan/15-sessions-and-variants.md batch BU. Two halves of one decision live in
// two different browsers: the person who stops the recording presses "Save transcript
// with this meeting", and the person who ends the meeting writes tracker_sessions —
// one meeting is recorded once (__tests__/oneRecordPerMeeting.test.ts). So store.ts's
// endMeeting reads the choice from lib/transcriptKeep, which the room server relayed,
// and builds the transcript out of ITS OWN chatHistory and pointing timeline. That is
// safe because both are the room's already: live lines arrive on every client through
// TRANSCRIPT_LINE and pointing segments through POINTING_SEGMENT.
//
// What is pinned here is the four ways the answer changes — chosen, not chosen,
// privacy mode, capture paused — and that a browser which did NOT end the meeting
// stores nothing however the room voted.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, InsightCard } from '../types';
import type { TranscriptRow } from '../lib/capture/transcriptText';

const flushSessionToTracker = vi.fn();
vi.mock('../lib/trackerBridge', () => ({
  flushSessionToTracker: (...args: unknown[]) => flushSessionToTracker(...args),
}));

const writeMeetingMinutes = vi.fn();
// Only the write is faked. `liveTranscriptChunks` stays the real one, because the
// selection of this recording's lines out of the room's chat history is exactly what
// this file is about — a stub of it would make every assertion below a tautology.
vi.mock('../lib/capture/meetingMinutes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/capture/meetingMinutes')>();
  return { ...actual, writeMeetingMinutes: (...args: unknown[]) => writeMeetingMinutes(...args) };
});

import { useStore } from '../store';
import { recordingStateRef } from '../lib/recordingState';
import { setTranscriptKeep } from '../lib/transcriptKeep';
import { setCapturePausedBy } from '../lib/capture/captureGate';
import { usePointingTimelineStore } from '../lib/pointingTimelineStore';

const START = 1_700_000_000_000;

/** Two live lines from THIS recording, and one from a recording that ended earlier. */
const CHAT: ChatMessage[] = [
  {
    id: 'live-999-0',
    agentId: 'live-transcript',
    text: 'Something said before this recording.',
    timestamp: 999,
    speakerName: 'Maria Guest',
    speakerId: 'u-maria',
    offsetMs: 1000,
  },
  {
    id: `live-${START}-0`,
    agentId: 'live-transcript',
    text: "Let's look at the hinge pin.",
    timestamp: START + 4000,
    speakerName: 'Olga Owner',
    speakerId: 'host-1',
    offsetMs: 4000,
  },
  {
    id: `live-${START}-1`,
    agentId: 'live-transcript',
    text: 'It wears after a thousand cycles.',
    timestamp: START + 15000,
    speakerName: 'Ben Guest',
    speakerId: 'u-ben',
    offsetMs: 15000,
  },
];

const SEGMENTS = [
  {
    userId: 'host-1',
    userName: 'Olga Owner',
    partId: 'p-hinge',
    partName: 'Hinge pin',
    source: 'laser' as const,
    fromMs: 7000,
    toMs: 12000,
  },
];

const CARD: InsightCard = {
  id: 'ic-1',
  type: 'RISK',
  agentId: '',
  title: 'Hinge pin wears',
  description: 'After a thousand cycles',
  timestamp: START,
  details: { priority: 'High', status: 'Open' },
};

/** Let the fire-and-forget `.then` behind endMeeting run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function flushed(): { transcript: TranscriptRow[] } {
  return flushSessionToTracker.mock.calls[0][0] as { transcript: TranscriptRow[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  flushSessionToTracker.mockResolvedValue('sess-1');
  writeMeetingMinutes.mockResolvedValue(null);
  recordingStateRef.current = { recording: false, startedAt: START, byUserId: 'host-1', byName: 'Olga Owner' };
  setTranscriptKeep(null);
  setCapturePausedBy(null);
  usePointingTimelineStore.setState({ segments: SEGMENTS });
  useStore.setState({
    isMeetingEnded: false,
    isPlaying: true,
    insightCards: [],
    chatHistory: CHAT,
    isPrivacyMode: false,
  });
});

describe('the browser whose person pressed End', () => {
  it('stores the transcript the meeting asked for, with where people were pointing at', () => {
    setTranscriptKeep({ keep: true, includePointing: true, byName: 'Olga Owner' });

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    expect(flushSessionToTracker).toHaveBeenCalledTimes(1);
    expect(flushed().transcript).toEqual([
      { t: 4000, speaker: 'Olga Owner', text: "Let's look at the hinge pin." },
      { t: 7000, speaker: 'Olga Owner', pointing: 'Hinge pin', untilMs: 12000 },
      { t: 15000, speaker: 'Ben Guest', text: 'It wears after a thousand cycles.' },
    ]);
  });

  it('stores what was said and no pointing when that was not asked for', () => {
    setTranscriptKeep({ keep: true, includePointing: false, byName: 'Olga Owner' });

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    const rows = flushed().transcript;
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => 'pointing' in row)).toBe(false);
  });

  it('selects this recording’s lines and not the ones from the recording before it', () => {
    setTranscriptKeep({ keep: true, includePointing: false, byName: 'Olga Owner' });

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    expect(flushed().transcript.some((row) => 'text' in row && row.text.includes('before this recording'))).toBe(false);
  });

  it('stores nothing when nobody asked — the default, and every meeting before this batch', () => {
    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    expect(flushed().transcript).toEqual([]);
  });

  it('stores nothing when the choice was taken back', () => {
    setTranscriptKeep({ keep: true, includePointing: true, byName: 'Olga Owner' });
    setTranscriptKeep({ keep: false, includePointing: false, byName: 'Olga Owner' });

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    expect(flushed().transcript).toEqual([]);
  });

  it('stores nothing in privacy mode, even though the button was pressed before it came on', () => {
    // The room promised that what is said in it does not leave it. A meeting ending
    // is not a reason to break that promise, and the check is here rather than only
    // on the button for exactly that reason — the two can be an hour apart.
    setTranscriptKeep({ keep: true, includePointing: true, byName: 'Olga Owner' });
    useStore.setState({ isPrivacyMode: true });

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    expect(flushed().transcript).toEqual([]);
  });

  it('stores nothing while capture is paused for somebody curating the review', () => {
    setTranscriptKeep({ keep: true, includePointing: true, byName: 'Olga Owner' });
    setCapturePausedBy('Robin');

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);

    expect(flushed().transcript).toEqual([]);
    setCapturePausedBy(null);
  });

  it('still records the meeting itself, whichever way the transcript went', async () => {
    useStore.setState({ insightCards: [CARD] });

    useStore.getState().endMeeting(true, 2, ['Olga Owner', 'Ben Guest']);
    await settle();

    expect(flushSessionToTracker).toHaveBeenCalledTimes(1);
    expect(useStore.getState().isMeetingEnded).toBe(true);
    expect(writeMeetingMinutes).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the meeting ended on somebody else’s screen', () => {
    // One meeting, one record: the choice to keep a transcript does not turn every
    // browser in the room into a writer of it.
    setTranscriptKeep({ keep: true, includePointing: true, byName: 'Olga Owner' });

    useStore.getState().meetingEndedRemotely();

    expect(flushSessionToTracker).not.toHaveBeenCalled();
    expect(useStore.getState().isMeetingEnded).toBe(true);
  });
});
