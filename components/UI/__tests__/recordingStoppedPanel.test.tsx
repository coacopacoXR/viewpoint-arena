// RecordingStoppedPanel — the three things that can be done with a stopped recording.
//
// docs/plan/15-sessions-and-variants.md batch BU. Pure presentation over
// RecordingContext, tested the way RecordingControls.test.tsx tests its neighbour:
// the context is mocked and what is pinned is that each of the three choices is
// offered, that each one calls the function behind it, that the two which send or
// store something are disabled WITH A REASON when the room has paused capture or
// turned privacy on, and that the panel is not there for anybody but the person who
// can record.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import RecordingStoppedPanel from '../RecordingStoppedPanel';
import { useRecordingContext } from '../../../lib/RecordingContext';
import type { RecordingContextValue } from '../../../lib/RecordingContext';

vi.mock('../../../lib/RecordingContext', () => ({
  useRecordingContext: vi.fn(),
}));

const mockUseRecordingContext = vi.mocked(useRecordingContext);

const STOPPED = { startedAt: 1_700_000_000_000, elapsedMs: 754_000 };

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
    stopped: STOPPED,
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

function panel(overrides: Partial<RecordingContextValue> = {}) {
  const ctx = makeCtx(overrides);
  mockUseRecordingContext.mockReturnValue(ctx);
  render(<RecordingStoppedPanel />);
  return ctx;
}

describe('RecordingStoppedPanel', () => {
  beforeEach(() => mockUseRecordingContext.mockReset());
  afterEach(cleanup);

  it('is not there until a recording has stopped', () => {
    const { container } = render(<RecordingStoppedPanel />);
    expect(container.innerHTML).toBe('');

    mockUseRecordingContext.mockReturnValue(makeCtx({ stopped: null }));
    const { container: idle } = render(<RecordingStoppedPanel />);
    expect(idle.innerHTML).toBe('');
  });

  it('is not there for somebody who could not have recorded the meeting', () => {
    // The panel is about one browser's audio. A participant who sees the room's
    // "recording off" must not be offered choices about a file they do not hold.
    mockUseRecordingContext.mockReturnValue(makeCtx({ canRecord: false }));
    const { container } = render(<RecordingStoppedPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('says how long the recording ran', () => {
    panel();
    expect(screen.getByText('Recording stopped · 12:34')).toBeInTheDocument();
  });

  it('offers all three choices, and none of them is the other', () => {
    panel();
    expect(screen.getByRole('button', { name: /generate cards/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save transcript with this meeting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download \.txt/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /include what people pointed at/i })).toBeInTheDocument();
  });

  it('generates cards', () => {
    const ctx = panel();
    fireEvent.click(screen.getByRole('button', { name: /generate cards/i }));
    expect(ctx.generateCards).toHaveBeenCalledTimes(1);
  });

  it('saves the transcript with the meeting, and takes it back again', () => {
    const ctx = panel();
    fireEvent.click(screen.getByRole('button', { name: /save transcript with this meeting/i }));
    expect(ctx.toggleKeepTranscript).toHaveBeenCalledTimes(1);

    cleanup();
    const pressed = panel({ keepTranscript: true });
    expect(
      screen.getByRole('button', { name: /transcript will be saved with this meeting/i }),
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(pressed.toggleKeepTranscript).toHaveBeenCalledTimes(1);
  });

  it('downloads the .txt, with the pointing only when the box is ticked', () => {
    const ctx = panel();
    expect(screen.getByRole('checkbox', { name: /include what people pointed at/i })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: /download \.txt/i }));
    expect(ctx.downloadStoppedTranscript).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox', { name: /include what people pointed at/i }));
    expect(ctx.setIncludePointing).toHaveBeenCalledWith(true);
  });

  it('shows the pointing box as ticked once it is', () => {
    panel({ includePointing: true });
    expect(screen.getByRole('checkbox', { name: /include what people pointed at/i })).toBeChecked();
  });

  it('dismisses itself', () => {
    const ctx = panel();
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(ctx.dismissStopped).toHaveBeenCalledTimes(1);
  });

  it('disables the two choices that send or store something, and says why', () => {
    panel({ captureBlockReason: 'Capture is paused while Robin edits the review.' });

    expect(screen.getByRole('button', { name: /generate cards/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /save transcript with this meeting/i })).toBeDisabled();
    expect(screen.getByText('Capture is paused while Robin edits the review.')).toBeInTheDocument();

    // The file on this machine is neither: it is the person who recorded the meeting
    // keeping what they can already read on their own screen.
    expect(screen.getByRole('button', { name: /download \.txt/i })).not.toBeDisabled();
  });

  it('still lets a transcript that is already being saved be taken back while capture is paused', () => {
    // A disabled Undo is a choice nobody can retract, and the pause is not a reason
    // to keep storing something the room has just said it does not want stored.
    panel({
      keepTranscript: true,
      captureBlockReason: 'Capture is paused while Robin edits the review.',
    });
    expect(screen.getByRole('button', { name: /undo/i })).not.toBeDisabled();
  });

  it('says it is generating, rather than looking as though the click did nothing', () => {
    panel({ summarising: true });
    expect(screen.getByRole('button', { name: /generating cards/i })).toBeDisabled();
  });
});
