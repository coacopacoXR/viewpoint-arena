// RecordingContext — one recorder, two views, per-speaker live transcript.
//
// The critical invariant: useMeetingRecorder is instantiated EXACTLY ONCE even
// when both the sidebar ConversationPanel and the Manager Workspace render
// their RecordingControls. Two instances would record and upload twice.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { RecordingProvider, useRecordingContext } from '../RecordingContext';

// Mock the hooks the provider calls internally.
const mockUseMeetingRecorder = vi.fn().mockReturnValue({
  state: 'idle',
  start: vi.fn(),
  stop: vi.fn(),
});
vi.mock('../useMeetingRecorder', () => ({
  useMeetingRecorder: (...args: unknown[]) => mockUseMeetingRecorder(...args),
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
  usePresence: () => ({ localUserId: 'host-1', remoteParticipantList: [] }),
}));

vi.mock('../config/ConfigContext', () => ({
  useConnectorConfig: () => ({ capture: 'local' }),
}));

vi.mock('../usePartyPresence', () => ({
  subscribeRecordingState: (listener: (s: unknown) => void) => {
    listener(null);
    return () => {};
  },
  broadcastRecordingState: vi.fn(),
  broadcastTranscriptKeep: vi.fn(),
}));

vi.mock('../../store', () => ({
  useStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = { sessionHostId: 'host-1', addInsightCard: vi.fn(), chatHistory: [] };
    return selector(state);
  },
}));

vi.mock('../activeReviewStore', () => ({
  useActiveReviewStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = { config: null, agendaIdx: 0 };
    return selector(state);
  },
}));

vi.mock('../connectors/capture/local', () => {
  class FakeLocalCaptureProvider {
    captureRecording = vi.fn();
    transcribeChunk = vi.fn();
  }
  return {
    LocalCaptureProvider: FakeLocalCaptureProvider,
    meetingSlideContext: vi.fn(),
  };
});

// A consumer that reads the context — proves the provider is mounted.
const Consumer: React.FC<{ label: string }> = ({ label }) => {
  const ctx = useRecordingContext();
  return <span data-testid={label}>{ctx ? ctx.state : 'null'}</span>;
};

describe('RecordingProvider', () => {
  afterEach(() => {
    cleanup();
    mockUseMeetingRecorder.mockClear();
  });

  it('creates exactly one recorder when two consumers render inside one provider', () => {
    render(
      <RecordingProvider>
        <Consumer label="sidebar" />
        <Consumer label="workspace" />
      </RecordingProvider>,
    );

    expect(mockUseMeetingRecorder).toHaveBeenCalledTimes(1);
  });

  it('exposes the recorder state to every consumer', () => {
    render(
      <RecordingProvider>
        <Consumer label="a" />
        <Consumer label="b" />
      </RecordingProvider>,
    );

    // Both consumers see the same state from the single provider.
    expect(document.querySelector('[data-testid="a"]')?.textContent).toBe('idle');
    expect(document.querySelector('[data-testid="b"]')?.textContent).toBe('idle');
  });

  it('returns null from useRecordingContext when no provider is mounted', () => {
    const { container } = render(<Consumer label="orphan" />);
    expect(container.querySelector('[data-testid="orphan"]')?.textContent).toBe('null');
  });
});
