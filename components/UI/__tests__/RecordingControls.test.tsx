// RecordingControls — pure presentation over RecordingContext.
//
// The component renders nothing when the viewer is not the host or the
// deployment is not on capture.provider 'local' (canRecord === false).
// When canRecord is true it shows the start button (idle), the recording
// indicator + stop button (recording), the summarising indicator, the
// outcome line, and the Retry button on error.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RecordingControls from '../RecordingControls';
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
    // The stopped recording's three choices (batch BU), off by default: this file is
    // about the control row, and RecordingStoppedPanel has its own.
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

describe('RecordingControls', () => {
  beforeEach(() => {
    mockUseRecordingContext.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there is no RecordingContext (non-host or no provider)', () => {
    mockUseRecordingContext.mockReturnValue(null);
    const { container } = render(<RecordingControls />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when canRecord is false', () => {
    mockUseRecordingContext.mockReturnValue(makeCtx({ canRecord: false }));
    const { container } = render(<RecordingControls />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the Start button when idle', () => {
    mockUseRecordingContext.mockReturnValue(makeCtx({ state: 'idle' }));
    render(<RecordingControls />);
    expect(screen.getByRole('button', { name: /start recording/i })).toBeInTheDocument();
    expect(screen.queryByText(/recording \d\d:\d\d/i)).toBeNull();
  });

  it('shows the recording indicator and Stop button while recording', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({ state: 'recording', elapsedMs: 65000 }),
    );
    render(<RecordingControls />);
    expect(screen.getByText(/recording 01:05/i)).toBeInTheDocument();
    // "Stop", and not the "Stop & summarise" it was before batch BU: stopping no
    // longer sends the audio anywhere, so a button that says it does is a lie about
    // the one thing the person pressing it is deciding.
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /summarise/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /start recording/i })).toBeNull();
  });

  it('shows the unsupported message when the browser cannot record', () => {
    mockUseRecordingContext.mockReturnValue(makeCtx({ state: 'unsupported' }));
    render(<RecordingControls />);
    expect(screen.getByText('This browser cannot record audio.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start recording/i })).toBeNull();
  });

  it('calls start when the Start button is clicked', () => {
    const start = vi.fn();
    mockUseRecordingContext.mockReturnValue(makeCtx({ state: 'idle', start }));
    render(<RecordingControls />);
    fireEvent.click(screen.getByRole('button', { name: /start recording/i }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('calls stop when the Stop button is clicked', () => {
    const stop = vi.fn();
    mockUseRecordingContext.mockReturnValue(
      makeCtx({ state: 'recording', elapsedMs: 0, stop }),
    );
    render(<RecordingControls />);
    fireEvent.click(screen.getByRole('button', { name: /^stop$/i }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('shows "Summarising…" while summarising', () => {
    mockUseRecordingContext.mockReturnValue(makeCtx({ summarising: true }));
    render(<RecordingControls />);
    expect(screen.getByText(/summarising/i)).toBeInTheDocument();
  });

  it('shows the success outcome with the correct count', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({ outcome: { added: 3 } }),
    );
    render(<RecordingControls />);
    expect(screen.getByText('3 insights added')).toBeInTheDocument();
  });

  it('shows the singular "insight" when exactly one was added', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({ outcome: { added: 1 } }),
    );
    render(<RecordingControls />);
    expect(screen.getByText('1 insight added')).toBeInTheDocument();
  });

  it('shows the error outcome and a Retry button', () => {
    const retry = vi.fn();
    mockUseRecordingContext.mockReturnValue(
      makeCtx({ outcome: { message: 'Upload failed' }, retry }),
    );
    render(<RecordingControls />);
    expect(screen.getByText('Upload failed')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('disables Start while summarising', () => {
    mockUseRecordingContext.mockReturnValue(
      makeCtx({ state: 'idle', summarising: true }),
    );
    render(<RecordingControls />);
    expect(screen.getByRole('button', { name: /start recording/i })).toBeDisabled();
  });
});
