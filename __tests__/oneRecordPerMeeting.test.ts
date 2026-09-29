// One meeting is one record, written by the one browser whose person pressed End.
//
// docs/plan/15-sessions-and-variants.md batch BM. Cards are broadcast to every
// browser in a room, so every browser holds the same insightCards — and
// store.endMeeting flushed whenever it was called with `ended: true`. Every other
// browser received MEETING_END in lib/usePartyPresence.ts and called endMeeting(true)
// too, so a meeting with three people in it wrote three tracker_sessions rows (S1,
// S2 and S3 on the line) and every card three times.
//
// The fix is a second action: `meetingEndedRemotely()` makes the same on-screen
// change and writes nothing. What is pinned here is both halves — that the receiver
// still ends the meeting on screen, and that it does not record it — plus the two
// things the recording browser now passes down: the names of who attended, and the
// request for the minutes that follows the session row.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const flushSessionToTracker = vi.fn();
vi.mock('../lib/trackerBridge', () => ({
  flushSessionToTracker: (...args: unknown[]) => flushSessionToTracker(...args),
}));

const writeMeetingMinutes = vi.fn();
vi.mock('../lib/capture/meetingMinutes', () => ({
  writeMeetingMinutes: (...args: unknown[]) => writeMeetingMinutes(...args),
}));

import { useStore } from '../store';

const REPO_ROOT = join(__dirname, '..');

/** The stub card a meeting needs for the flush to have something to write. */
const CARDS = [{ id: 'ic-1', type: 'RISK', title: 'Hinge pin wears' }] as never;

const NAMES = ['Olga Owner', 'Ben Editor'];

/** Let the fire-and-forget `.then` behind endMeeting run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function flushedRow(index = 0): Record<string, unknown> {
  return flushSessionToTracker.mock.calls[index][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  flushSessionToTracker.mockResolvedValue('sess-1');
  useStore.setState({
    isMeetingEnded: false,
    isPlaying: true,
    insightCards: CARDS,
    chatHistory: [],
    isPrivacyMode: false,
  });
});

describe('the browser whose person pressed End', () => {
  it('records the meeting, once', async () => {
    useStore.getState().endMeeting(true, 2, NAMES);

    expect(flushSessionToTracker).toHaveBeenCalledTimes(1);
    expect(flushedRow()).toMatchObject({ participantCount: 2, attendeeNames: NAMES });
    expect(useStore.getState().isMeetingEnded).toBe(true);
  });

  it('passes the names down beside the head count, which stays as it was', async () => {
    useStore.getState().endMeeting(true, 3, ['Olga Owner', 'Ben Editor', 'Maria Guest']);

    expect(flushedRow()).toMatchObject({
      participantCount: 3,
      attendeeNames: ['Olga Owner', 'Ben Editor', 'Maria Guest'],
    });
  });

  it('asks for the minutes after the session row exists, and not before', async () => {
    let resolved = false;
    flushSessionToTracker.mockImplementation(async () => {
      resolved = true;
      return 'sess-9';
    });

    useStore.getState().endMeeting(true, 2, NAMES);
    expect(writeMeetingMinutes).not.toHaveBeenCalled();

    await settle();
    expect(resolved).toBe(true);
    expect(writeMeetingMinutes).toHaveBeenCalledTimes(1);
    // The row the minutes go on is the one the flush just wrote.
    expect(writeMeetingMinutes.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-9' });
  });

  it('writes no minutes when the flush wrote no session', async () => {
    // A meeting with no cards produces no row, and there is nowhere to put minutes.
    flushSessionToTracker.mockResolvedValue(null);

    useStore.getState().endMeeting(true, 2, NAMES);
    await settle();

    expect(writeMeetingMinutes).not.toHaveBeenCalled();
  });

  it('hands the minutes the room it is summarising', async () => {
    useStore.setState({ isPrivacyMode: true });

    useStore.getState().endMeeting(true, 2, NAMES);
    await settle();

    expect(writeMeetingMinutes.mock.calls[0][0]).toMatchObject({
      privacyMode: true,
      cards: CARDS,
      chatHistory: [],
    });
  });
});

describe('every other browser in the room', () => {
  it('ends the meeting on screen exactly as it did before', () => {
    useStore.getState().meetingEndedRemotely();

    expect(useStore.getState().isMeetingEnded).toBe(true);
    expect(useStore.getState().isPlaying).toBe(false);
  });

  it('records nothing: no session row, no cards, no minutes', async () => {
    useStore.getState().meetingEndedRemotely();
    await settle();

    expect(flushSessionToTracker).not.toHaveBeenCalled();
    expect(writeMeetingMinutes).not.toHaveBeenCalled();
  });

  it('still stops the simulation transport, which is what the screen shows', () => {
    useStore.setState({ isPlaying: true });

    useStore.getState().meetingEndedRemotely();

    expect(useStore.getState().isPlaying).toBe(false);
  });
});

describe('MEETING_END in lib/usePartyPresence.ts', () => {
  // Pinned as text, the way deploy/__tests__/reviewLinesSchema.test.ts pins the
  // schema: the handler is two lines inside a socket effect that no unit test can
  // reach without a PartySocket fake, and the regression it guards against — a
  // receiver calling endMeeting(true) again — is one word.
  const source = readFileSync(join(REPO_ROOT, 'lib/usePartyPresence.ts'), 'utf8');
  const start = source.indexOf("msg.type === 'MEETING_END'");
  const branch = source.slice(start, source.indexOf('} else if', start));

  it('ends the meeting through the action that records nothing', () => {
    expect(start).toBeGreaterThan(0);
    expect(branch).toContain('meetingEndedRemotely()');
    expect(branch).not.toContain('endMeeting(');
    expect(branch).not.toContain('flushSessionToTracker');
  });
});
