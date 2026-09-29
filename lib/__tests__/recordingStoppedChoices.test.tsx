// Stopping a recording is a choice now, not a consequence.
//
// docs/plan/15-sessions-and-variants.md batch BU. What is pinned here is the
// provider behind the stop panel, through the real RecordingProvider rather than a
// mock of it, because the three choices are three different kinds of act and the
// interesting part is what each one does NOT do:
//
//   Stop            stops, keeps the audio, and sends nothing anywhere. It used to
//                   call summarise(audio) itself, which meant the person pressing it
//                   had bought an AI job on an hour of design review whether they
//                   wanted cards or not.
//   Generate cards  the old behaviour, and only that — with both of its gates.
//   Save transcript a TRANSCRIPT_KEEP to the room, because the browser that writes
//                   the meeting's row is the one whose person ends the meeting.
//   Download .txt   a file on this machine, and nothing leaves the browser.
//
// Plus the two moments the panel goes away: the × and a new recording, which also
// withdraws a "save it" that was about the recording before it.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { ChatMessage } from '../../types';
import type { RecordingStopped, SummaryOutcome } from '../RecordingContext';
import { setCapturePausedBy } from '../capture/captureGate';

const START = 1_700_000_000_000;

const fakes = vi.hoisted(() => ({
  store: {
    current: {
      sessionHostId: 'host-1',
      reviewEditing: null as { userId: string; name: string } | null,
      chatHistory: [] as ChatMessage[],
      activeModelType: 'headphones',
      importedSceneTree: null,
      isPrivacyMode: false,
      addInsightCard: () => {},
    },
  },
  recorderStop: vi.fn(),
  captureRecording: vi.fn(),
  transcribeChunk: vi.fn(),
  broadcastRecordingState: vi.fn(),
  broadcastTranscriptKeep: vi.fn(),
  downloadTranscript: vi.fn((_text: string, _filename: string) => true),
}));

const { RecordingProvider, useRecordingContext, PRIVACY_BLOCK_REASON } = await import(
  '../RecordingContext'
);

vi.mock('../useMeetingRecorder', () => ({
  useMeetingRecorder: () => ({ state: 'recording', start: vi.fn(), stop: fakes.recorderStop }),
}));

vi.mock('../useLiveTranscript', () => ({
  useLiveTranscript: () => ({ onLiveChunk: vi.fn(), finish: vi.fn() }),
}));

vi.mock('../useOwnMicTranscriber', () => ({
  useOwnMicTranscriber: () => ({ status: 'idle', stopSharing: vi.fn() }),
}));

vi.mock('../WebRTCContext', () => ({
  useWebRTCContext: () => ({ localStream: null, remoteStreams: new Map(), isMicOn: true }),
}));

vi.mock('../PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'host-1',
    broadcastInsightCard: vi.fn(),
    remoteParticipantList: [{ userId: 'u-ben', name: 'Ben Guest' }],
  }),
}));

vi.mock('../config/ConfigContext', () => ({
  useConnectorConfig: () => ({ capture: 'local' }),
}));

// The room IS recording when the provider mounts, which is the state Stop is
// pressed from, and RECORDING_STATE carries the start the live lines are keyed by.
vi.mock('../usePartyPresence', () => ({
  subscribeRecordingState: (listener: (s: unknown) => void) => {
    listener({ recording: true, startedAt: START, byUserId: 'host-1', byName: 'Olga Owner' });
    return () => {};
  },
  broadcastRecordingState: (...args: unknown[]) => fakes.broadcastRecordingState(...args),
  broadcastTranscriptKeep: (...args: unknown[]) => fakes.broadcastTranscriptKeep(...args),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: typeof fakes.store.current) => unknown) => selector(fakes.store.current),
  sceneComponents: () => [],
}));

vi.mock('../activeReviewStore', () => ({
  useActiveReviewStore: (
    selector: (s: { config: { title: string } | null; agendaIdx: number }) => unknown,
  ) => selector({ config: { title: 'Door hinge, rev C' }, agendaIdx: 0 }),
}));

vi.mock('../connectors/capture/local', () => {
  class FakeLocalCaptureProvider {
    captureRecording = fakes.captureRecording;
    transcribeChunk = fakes.transcribeChunk;
  }
  return { LocalCaptureProvider: FakeLocalCaptureProvider, meetingSlideContext: vi.fn() };
});

// Only the download is faked: the text is built by the real
// lib/capture/transcriptText, so what this file asserts about choice 3 is the file
// the person gets and not a stub of it.
vi.mock('../capture/transcriptText', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../capture/transcriptText')>();
  return {
    ...actual,
    downloadTranscript: (text: string, filename: string) =>
      fakes.downloadTranscript(text, filename),
  };
});

interface Probe {
  stopped: RecordingStopped | null;
  outcome: SummaryOutcome | null;
  summarising: boolean;
  keepTranscript: boolean;
  includePointing: boolean;
  captureBlockReason: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  generateCards(): Promise<void>;
  retry(): Promise<void>;
  toggleKeepTranscript(): void;
  setIncludePointing(include: boolean): void;
  downloadStoppedTranscript(): boolean;
  dismissStopped(): void;
}

let ctx: Probe | null = null;

const Consumer: React.FC = () => {
  ctx = useRecordingContext() as Probe | null;
  return <span data-testid="stopped">{ctx?.stopped ? 'stopped' : 'none'}</span>;
};

function tree() {
  return (
    <RecordingProvider>
      <Consumer />
    </RecordingProvider>
  );
}

let mounted: ReturnType<typeof render> | null = null;

/** Mount, and give the store-changing helpers a way to re-render against new state. */
function mount() {
  mounted = render(tree());
  return mounted;
}

async function setStore(patch: Partial<typeof fakes.store.current>) {
  fakes.store.current = { ...fakes.store.current, ...patch };
  await act(async () => {
    mounted?.rerender(tree());
  });
}

/** One live line from this recording, in the shape lib/useLiveTranscript broadcasts. */
const LIVE_LINES: ChatMessage[] = [
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

describe('a stopped recording', () => {
  beforeEach(() => {
    localStorage.setItem('vp_user', JSON.stringify({ name: 'Olga Owner', color: '#10b981' }));
    fakes.store.current = {
      ...fakes.store.current,
      reviewEditing: null,
      isPrivacyMode: false,
      chatHistory: LIVE_LINES,
    };
    fakes.recorderStop.mockReset().mockResolvedValue(new Blob(['audio'], { type: 'audio/webm' }));
    fakes.captureRecording.mockReset().mockResolvedValue([]);
    fakes.broadcastRecordingState.mockClear();
    fakes.broadcastTranscriptKeep.mockClear();
    fakes.downloadTranscript.mockClear().mockReturnValue(true);
    setCapturePausedBy(null);
  });

  afterEach(() => {
    cleanup();
    mounted = null;
  });

  it('does NOT extract cards — stopping only stops', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });

    expect(fakes.captureRecording).not.toHaveBeenCalled();
    expect(ctx?.summarising).toBe(false);
    expect(ctx?.outcome).toBeNull();
    expect(ctx?.stopped).not.toBeNull();
  });

  it('keeps the recording’s start in the room’s state, so the transcript can still be selected', async () => {
    // lib/recordingState.ts has always documented that startedAt survives the stop —
    // it is the key this meeting's live lines carry — and store.ts's endMeeting reads
    // it there for both the minutes and the transcript.
    mount();
    await act(async () => {
      await ctx?.stop();
    });

    expect(fakes.broadcastRecordingState).toHaveBeenLastCalledWith({
      recording: false,
      startedAt: START,
      byUserId: 'host-1',
      byName: 'Olga Owner',
    });
  });

  it('generates the cards when that is the choice made', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });
    expect(fakes.captureRecording).not.toHaveBeenCalled();

    await act(async () => {
      await ctx?.generateCards();
    });
    expect(fakes.captureRecording).toHaveBeenCalledTimes(1);
    expect(ctx?.outcome).toEqual({ added: 0 });
  });

  it('refuses to generate cards while the review is being edited, and says whose edit it is', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });

    await setStore({ reviewEditing: { userId: 'editor-1', name: 'Robin' } });
    expect(ctx?.captureBlockReason).toBe('Capture is paused while Robin edits the review.');

    await act(async () => {
      await ctx?.generateCards();
    });
    expect(fakes.captureRecording).not.toHaveBeenCalled();
    expect(ctx?.outcome).toEqual({ message: 'Capture is paused while Robin edits the review.' });
  });

  it('refuses to generate cards in privacy mode, because the room said nothing leaves it', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });

    await setStore({ isPrivacyMode: true });
    expect(ctx?.captureBlockReason).toBe(PRIVACY_BLOCK_REASON);

    await act(async () => {
      await ctx?.generateCards();
    });
    expect(fakes.captureRecording).not.toHaveBeenCalled();
    expect(ctx?.outcome).toEqual({ message: PRIVACY_BLOCK_REASON });
  });

  it('still offers Retry after a refused extraction, and the audio is still there', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });
    await setStore({ reviewEditing: { userId: 'editor-1', name: 'Robin' } });
    await act(async () => {
      await ctx?.retry();
    });
    expect(fakes.captureRecording).not.toHaveBeenCalled();

    await setStore({ reviewEditing: null });
    await act(async () => {
      await ctx?.retry();
    });
    expect(fakes.captureRecording).toHaveBeenCalledTimes(1);
  });

  it('downloads the transcript as a .txt, headed with the review, the day and who was there', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });
    await act(async () => {
      ctx?.downloadStoppedTranscript();
    });

    expect(fakes.downloadTranscript).toHaveBeenCalledTimes(1);
    const [text, filename] = fakes.downloadTranscript.mock.calls[0] as [string, string];
    expect(text).toContain('Door hinge, rev C');
    expect(text).toContain('Attendees: Olga Owner, Ben Guest');
    expect(text).toContain("[00:00:04] Olga Owner: Let's look at the hinge pin.");
    expect(text).toContain('[00:00:15] Ben Guest: It wears after a thousand cycles.');
    expect(text).not.toContain('pointing at');
    expect(filename).toMatch(/^Door hinge, rev C — .* transcript\.txt$/);
  });

  it('puts where people were pointing at in the file only when asked', async () => {
    const { usePointingTimelineStore } = await import('../pointingTimelineStore');
    mount();
    await act(async () => {
      await ctx?.stop();
    });
    // Put there after the provider has mounted, because lib/usePointingTimeline
    // clears the timeline when a recording starts — which is the same fact that
    // stops a second recording inheriting the first one's pointing.
    usePointingTimelineStore.setState({
      segments: [
        {
          userId: 'host-1',
          userName: 'Olga Owner',
          partId: 'p-hinge',
          partName: 'Hinge pin',
          source: 'laser',
          fromMs: 7000,
          toMs: 12000,
        },
      ],
    });
    await act(async () => {
      ctx?.setIncludePointing(true);
    });
    await act(async () => {
      ctx?.downloadStoppedTranscript();
    });

    const [text] = fakes.downloadTranscript.mock.calls[0] as [string, string];
    expect(text).toContain('[00:00:07]   (Olga Owner pointing at: Hinge pin, 00:00:07–00:00:12)');

    usePointingTimelineStore.setState({ segments: [] });
  });

  it('tells the room to save the transcript with the meeting, and tells it again to stop', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });

    await act(async () => {
      ctx?.toggleKeepTranscript();
    });
    expect(ctx?.keepTranscript).toBe(true);
    expect(fakes.broadcastTranscriptKeep).toHaveBeenLastCalledWith({
      keep: true,
      includePointing: false,
      byName: 'Olga Owner',
    });

    await act(async () => {
      ctx?.toggleKeepTranscript();
    });
    expect(ctx?.keepTranscript).toBe(false);
    expect(fakes.broadcastTranscriptKeep).toHaveBeenLastCalledWith({
      keep: false,
      includePointing: false,
      byName: 'Olga Owner',
    });
  });

  it('re-sends the pointing choice while the transcript is being kept, and not before', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });

    // Nothing is being stored yet, so ticking the box is a local choice about the
    // .txt and there is nothing for the room to hear.
    fakes.broadcastTranscriptKeep.mockClear();
    await act(async () => {
      ctx?.setIncludePointing(true);
    });
    expect(fakes.broadcastTranscriptKeep).not.toHaveBeenCalled();

    // What gets stored is decided at meeting-end, which may be an hour away and in
    // another browser, so the room has to be told.
    await act(async () => {
      ctx?.toggleKeepTranscript();
    });
    expect(fakes.broadcastTranscriptKeep).toHaveBeenLastCalledWith({
      keep: true,
      includePointing: true,
      byName: 'Olga Owner',
    });
  });

  it('withdraws the choice when a new recording starts, because the transcript is the new one’s', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });
    await act(async () => {
      ctx?.toggleKeepTranscript();
    });
    expect(ctx?.keepTranscript).toBe(true);

    fakes.broadcastTranscriptKeep.mockClear();
    await act(async () => {
      await ctx?.start();
    });

    expect(ctx?.stopped).toBeNull();
    expect(ctx?.keepTranscript).toBe(false);
    expect(ctx?.includePointing).toBe(false);
    expect(fakes.broadcastTranscriptKeep).toHaveBeenCalledWith({
      keep: false,
      includePointing: false,
      byName: 'Olga Owner',
    });
  });

  it('goes away on the ×, and keeps the recording so the error row’s Retry still works', async () => {
    mount();
    await act(async () => {
      await ctx?.stop();
    });
    await act(async () => {
      ctx?.dismissStopped();
    });
    expect(ctx?.stopped).toBeNull();

    await act(async () => {
      await ctx?.retry();
    });
    expect(fakes.captureRecording).toHaveBeenCalledTimes(1);
  });

  it('answers no download when there is no stopped recording to download', () => {
    mount();
    expect(ctx?.downloadStoppedTranscript()).toBe(false);
    expect(fakes.downloadTranscript).not.toHaveBeenCalled();
  });
});
