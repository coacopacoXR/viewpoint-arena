// RecordingIndicator — persistent banner shown to every participant while
// the room is recording. Tests that it renders for all participants, names
// who started the recording, and its "stop sharing my mic" button stops
// only that client's uploads.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RecordingIndicator from '../RecordingIndicator';
import { useRecordingContext } from '../../../lib/RecordingContext';
import type { RecordingContextValue } from '../../../lib/RecordingContext';

vi.mock('../../../lib/RecordingContext', () => ({
  useRecordingContext: vi.fn(),
}));

const mockUseRecordingContext = vi.mocked(useRecordingContext);

function makeCtx(overrides: Partial<RecordingContextValue> = {}): RecordingContextValue {
  return {
    state: 'idle',
    elapsedMs: 0,
    outcome: null,
    summarising: false,
    start: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    liveLines: [],
    canRecord: true,
    recordingState: null,
    ownMicStatus: 'idle',
    stopSharingMic: vi.fn(),
    // The stopped recording's three choices (batch BU). Null and false: this file is
    // about the indicator, and a panel that is not up is the state it renders in.
    stopped: null,
    dismissStopped: vi.fn(),
    generateCards: vi.fn(),
    keepTranscript: false,
    toggleKeepTranscript: vi.fn(),
    includePointing: false,
    setIncludePointing: vi.fn(),
    downloadStoppedTranscript: vi.fn(),
    captureBlockReason: null,
    ...overrides,
  };
}

describe('RecordingIndicator', () => {
  beforeEach(() => {
    mockUseRecordingContext.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there is no RecordingContext', () => {
    mockUseRecordingContext.mockReturnValue(null);
    const { container } = render(<RecordingIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when recording is not active', () => {
    mockUseRecordingContext.mockReturnValue(makeCtx({ recordingState: null }));
    const { container } = render(<RecordingIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('renders a persistent indicator naming who started the recording', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({
        recordingState: {
          recording: true,
          startedAt: Date.now() - 30000,
          byUserId: 'host-1',
          byName: 'Alice',
        },
        ownMicStatus: 'recording',
        elapsedMs: 30000,
      }),
    );
    render(<RecordingIndicator />);
    expect(screen.getByText(/recording 00:30/i)).toBeInTheDocument();
    expect(screen.getByText(/started by Alice/i)).toBeInTheDocument();
  });

  it('shows the "stop sharing my mic" button when own mic is recording', () => {
    const stopSharingMic = vi.fn();
    mockUseRecordingContext.mockReturnValue(
      makeCtx({
        recordingState: {
          recording: true,
          startedAt: Date.now(),
          byUserId: 'host-1',
          byName: 'Alice',
        },
        ownMicStatus: 'recording',
        stopSharingMic,
      }),
    );
    render(<RecordingIndicator />);
    const btn = screen.getByRole('button', { name: /stop sharing my mic/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(stopSharingMic).toHaveBeenCalledTimes(1);
  });

  it('does NOT show the stop button when the mic is muted or blocked', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({
        recordingState: {
          recording: true,
          startedAt: Date.now(),
          byUserId: 'host-1',
          byName: 'Alice',
        },
        ownMicStatus: 'muted',
      }),
    );
    render(<RecordingIndicator />);
    expect(screen.queryByRole('button', { name: /stop sharing my mic/i })).toBeNull();
    expect(screen.getByText(/you are muted/i)).toBeInTheDocument();
  });

  it('shows "mic unavailable" when the mic is blocked', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({
        recordingState: {
          recording: true,
          startedAt: Date.now(),
          byUserId: 'host-1',
          byName: 'Alice',
        },
        ownMicStatus: 'blocked',
      }),
    );
    render(<RecordingIndicator />);
    expect(screen.getByText(/mic unavailable/i)).toBeInTheDocument();
  });
});
