// Capture pauses while ANYBODY has the review's Edit on — the wiring, not the gate.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. lib/capture/captureGate.test.ts
// pins the gate's own contract; this pins that the room actually drives it and
// that BOTH capture paths obey it, which is the part that can silently rot:
//
//   the live transcript  useOwnMicTranscriber is handed `recording: false`, so the
//                        per-speaker slicer stops and produces no chunk at all.
//                        Stopping the slicer rather than dropping its output is
//                        what "paused" has to mean for a microphone still open —
//                        the minutes are not recorded-then-discarded either.
//   the extractor        summarise() returns before any audio leaves the browser,
//                        and says why instead of producing cards about the
//                        curation conversation.
//
// And the pause is the ROOM's: it is driven by store.reviewEditing, which the room
// server's EDITING_STATE writes on every client, so a participant who never
// touched Edit is paused too. That is the case worth a test of its own, because
// "pause my own capture while I edit" is the obvious wrong reading.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { isCapturePaused, capturePausedBy } from '../capture/captureGate';
import type { SummaryOutcome } from '../RecordingContext';

// ─── Fakes ──────────────────────────────────────────────────────────────────
// Hoisted so the vi.mock factories below can close over them. The store state is
// a mutable holder because a test flips `reviewEditing` mid-mount, which is what
// an EDITING_STATE arriving from the room server does.

interface FakeStoreState {
  sessionHostId: string | null;
  reviewEditing: { userId: string; name: string } | null;
  /** The line this room is on, which is what says whether it is still being explored. */
  activeLine: { kind: string; status: string } | null;
  chatHistory: unknown[];
  activeModelType: string;
  importedSceneTree: null;
  isPrivacyMode: boolean;
  addInsightCard: () => void;
}

const fakes = vi.hoisted(() => ({
  store: {
    current: {
      sessionHostId: 'host-1',
      reviewEditing: null,
      activeLine: null,
      chatHistory: [],
      activeModelType: 'headphones',
      importedSceneTree: null,
      isPrivacyMode: false,
      addInsightCard: () => {},
    } as {
      sessionHostId: string | null;
      reviewEditing: { userId: string; name: string } | null;
      activeLine: { kind: string; status: string } | null;
      chatHistory: unknown[];
      activeModelType: string;
      importedSceneTree: null;
      isPrivacyMode: boolean;
      addInsightCard: () => void;
    },
  },
  recorderStop: vi.fn(),
  micArgs: { current: [] as boolean[] },
  captureRecording: vi.fn(),
  transcribeChunk: vi.fn(),
}));

const { RecordingProvider, useRecordingContext } = await import('../RecordingContext');

vi.mock('../useMeetingRecorder', () => ({
  useMeetingRecorder: () => ({ state: 'recording', start: vi.fn(), stop: fakes.recorderStop }),
}));

vi.mock('../useLiveTranscript', () => ({
  useLiveTranscript: () => ({ onLiveChunk: vi.fn(), finish: vi.fn() }),
}));

// The live-transcript half of the pause is an ARGUMENT, so every call is recorded.
vi.mock('../useOwnMicTranscriber', () => ({
  useOwnMicTranscriber: (props: { recording: boolean }) => {
    fakes.micArgs.current.push(props.recording);
    return { status: 'idle', stopSharing: vi.fn() };
  },
}));

vi.mock('../WebRTCContext', () => ({
  useWebRTCContext: () => ({ localStream: null, remoteStreams: new Map(), isMicOn: true }),
}));

vi.mock('../PresenceContext', () => ({
  usePresence: () => ({ localUserId: 'host-1', broadcastInsightCard: vi.fn(), remoteParticipantList: [] }),
}));

vi.mock('../config/ConfigContext', () => ({
  useConnectorConfig: () => ({ capture: 'local' }),
}));

// The room IS recording throughout: the call keeps running while Edit is on, and
// that is exactly why the pause has to be a separate fact.
vi.mock('../usePartyPresence', () => ({
  subscribeRecordingState: (listener: (s: unknown) => void) => {
    listener({ recording: true, startedAt: 1000, byUserId: 'host-1', byName: 'Alice' });
    return () => {};
  },
  broadcastRecordingState: vi.fn(),
  broadcastTranscriptKeep: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: FakeStoreState) => unknown) => selector(fakes.store.current),
  // summarise() builds its grounded context from the room's parts; none is the
  // honest answer for a room with nothing loaded, and since batch BI it is the
  // answer the store's own helper gives rather than one this file has to build out
  // of a tree and a flattener.
  sceneComponents: () => [],
}));

vi.mock('../activeReviewStore', () => ({
  useActiveReviewStore: (selector: (s: { config: null; agendaIdx: number }) => unknown) =>
    selector({ config: null, agendaIdx: 0 }),
}));

vi.mock('../connectors/capture/local', () => {
  class FakeLocalCaptureProvider {
    captureRecording = fakes.captureRecording;
    transcribeChunk = fakes.transcribeChunk;
  }
  return { LocalCaptureProvider: FakeLocalCaptureProvider, meetingSlideContext: vi.fn() };
});

// ─── Mounting ───────────────────────────────────────────────────────────────

interface RecordingApi {
  state: string;
  outcome: SummaryOutcome | null;
  summarising: boolean;
  /** Whether the room offers Record at all — the gate a dropped line closes. */
  canRecord: boolean;
  stop(): Promise<void>;
  generateCards(): Promise<void>;
  retry(): Promise<void>;
}

let ctx: RecordingApi | null = null;

const Probe: React.FC = () => {
  ctx = useRecordingContext() as RecordingApi | null;
  return <span data-testid="state">{ctx?.state ?? 'null'}</span>;
};

// A FRESH element every time. React bails out of re-rendering a subtree handed
// the identical element reference, which is exactly the re-render setEditing needs.
function tree() {
  return (
    <RecordingProvider>
      <Probe />
    </RecordingProvider>
  );
}

let mounted: ReturnType<typeof render> | null = null;

/** Mount, and give `editing()` a way to re-render against new store state. */
function mountProvider() {
  mounted = render(tree());
  return mounted;
}

/**
 * Change who has Edit on, the way an EDITING_STATE from the room server does.
 *
 * The store mock is a selector over a plain object rather than a real zustand
 * store, so nothing subscribes: the re-render that makes the provider read the
 * new value is forced from here.
 */
async function setEditing(editing: { userId: string; name: string } | null) {
  fakes.store.current = { ...fakes.store.current, reviewEditing: editing };
  await act(async () => {
    mounted?.rerender(tree());
  });
}

function lastSlicerRecording(): boolean | undefined {
  const args = fakes.micArgs.current;
  return args.length === 0 ? undefined : args[args.length - 1];
}

/**
 * Change the line this room is on, the way pages/RoomPage does when it resolves one.
 *
 * A separate helper from `setEditing` and not a parameter on it, because the two facts
 * are unrelated and a test that had to set both to change one would not be saying which
 * one it was about.
 */
async function setLine(activeLine: FakeStoreState['activeLine']) {
  fakes.store.current = { ...fakes.store.current, activeLine };
  await act(async () => {
    mounted?.rerender(tree());
  });
}

describe('RecordingContext — no capture on a line nobody is exploring', () => {
  // docs/plan/15-sessions-and-variants.md batch BX. A dropped variant's address keeps
  // working, because it is kept for the record and the person who follows an old link
  // should see it rather than be bounced — but it is a record and not a meeting, and the
  // third door into it is the one this file can see. The other two are the room server's:
  // it refuses scene changes and refuses to hand out the Edit lock on a dropped line's
  // room, and those are the ones that cannot be lifted with devtools.

  beforeEach(() => {
    fakes.store.current = { ...fakes.store.current, activeLine: null, reviewEditing: null };
  });

  afterEach(() => {
    cleanup();
    mounted = null;
  });

  it('does not offer Record in a room on a dropped line', async () => {
    mountProvider();
    expect(ctx?.canRecord).toBe(true);

    await setLine({ kind: 'variant', status: 'dropped' });

    // The host, on a deployment that can capture, in a room that is recording: every
    // other reason to refuse is absent, so what closed the gate is the line.
    expect(ctx?.canRecord).toBe(false);
  });

  it('offers Record on a line still being explored, and on one that was merged', async () => {
    // A merged line is a record too, but it is a record of an answer the review TOOK,
    // and the room it belongs to is the target's. Only a dropped line's own room is a
    // room with nothing left to say in it.
    mountProvider();

    await setLine({ kind: 'variant', status: 'active' });
    expect(ctx?.canRecord).toBe(true);

    await setLine({ kind: 'main', status: 'active' });
    expect(ctx?.canRecord).toBe(true);
  });
});

describe('RecordingContext — capture pauses while the review is edited', () => {
  beforeEach(() => {
    fakes.store.current = { ...fakes.store.current, reviewEditing: null, activeLine: null, isPrivacyMode: false };
    fakes.micArgs.current = [];
    fakes.recorderStop.mockReset().mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
    // An array, because that is what the provider's `captureRecording` answers: the
    // cards themselves, not a document with them in it.
    fakes.captureRecording.mockReset().mockResolvedValue([]);
    fakes.transcribeChunk.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    mounted = null;
  });

  it('drives the gate from the room’s editing state, and releases it on Done', async () => {
    mountProvider();

    expect(isCapturePaused()).toBe(false);

    await setEditing({ userId: 'editor-1', name: 'Robin' });
    expect(isCapturePaused()).toBe(true);
    expect(capturePausedBy()).toBe('Robin');

    await setEditing(null);
    expect(isCapturePaused()).toBe(false);
    expect(capturePausedBy()).toBeNull();
  });

  it('pauses for somebody who is NOT the person editing — the pause is the room’s', async () => {
    // This client is 'host-1'; the person with Edit on is somebody else. Their
    // microphone would otherwise still be transcribing "no, put that slide after
    // the pin" while the editor's own is quiet.
    mountProvider();
    await setEditing({ userId: 'somebody-else', name: 'Maria' });

    expect(isCapturePaused()).toBe(true);
    expect(capturePausedBy()).toBe('Maria');
  });

  it('stops the per-speaker slicer while the room is still recording', async () => {
    mountProvider();

    // Recording, and not paused: the slicer runs.
    expect(lastSlicerRecording()).toBe(true);

    await setEditing({ userId: 'editor-1', name: 'Robin' });

    // Still recording — the call keeps running — but the slicer is told to stop.
    expect(lastSlicerRecording()).toBe(false);
  });

  it('refuses to send the recording for card extraction, and says whose edit is the reason', async () => {
    mountProvider();
    await setEditing({ userId: 'editor-1', name: 'Robin' });

    // Stopping still works, and the person still gets their audio: it is the
    // SENDING that is refused. Since batch BU stopping does not send anything at all
    // — the extraction is the stop panel's "Generate cards" — so that is the act
    // under test here.
    //
    // Two acts, not one: Stop keeps the audio in state and Generate cards reads it,
    // so the second click has to be a second render, which is what two clicks in the
    // room are. Inside one act() the callback still closes over a recording of null.
    await act(async () => {
      await ctx?.stop();
    });
    await act(async () => {
      await ctx?.generateCards();
    });

    expect(fakes.captureRecording).not.toHaveBeenCalled();
    expect(ctx?.outcome).toEqual({ message: 'Capture is paused while Robin edits the review.' });
    expect(ctx?.summarising).toBe(false);
  });

  it('sends the recording once Edit is off, so the pause resumes rather than ends the capture', async () => {
    mountProvider();
    await setEditing({ userId: 'editor-1', name: 'Robin' });
    await act(async () => {
      await ctx?.stop();
    });
    await act(async () => {
      await ctx?.generateCards();
    });
    expect(fakes.captureRecording).not.toHaveBeenCalled();

    await setEditing(null);
    await act(async () => {
      await ctx?.retry();
    });

    // The audio was kept, and now it is read.
    expect(fakes.captureRecording).toHaveBeenCalledTimes(1);
  });

  it('captures as usual when nobody is editing — a meeting must not have changed', async () => {
    mountProvider();

    await act(async () => {
      await ctx?.stop();
    });
    // Stop alone must not extract: that is the whole of batch BU's change, and the
    // pause is one of the two gates on the extraction that follows it.
    expect(fakes.captureRecording).not.toHaveBeenCalled();

    await act(async () => {
      await ctx?.generateCards();
    });

    expect(isCapturePaused()).toBe(false);
    expect(fakes.captureRecording).toHaveBeenCalledTimes(1);
    expect(ctx?.outcome).not.toEqual({ message: 'Capture is paused while Robin edits the review.' });
  });
});
