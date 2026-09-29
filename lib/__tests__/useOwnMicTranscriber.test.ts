// Tests for useOwnMicTranscriber — the per-client 8 s slice recorder.
//
// jsdom has neither MediaRecorder nor getUserMedia, so everything here runs
// against stubs. The hook's contract:
//   * recording=true + isMicOn=true + stream available → status='recording',
//     slices are produced;
//   * isMicOn=false → status='muted', no slices;
//   * no stream + getUserMedia fails → status='blocked', no slices;
//   * unmuting resumes;
//   * stopSharing() suppresses uploads without stopping the room recording;
//   * recording=false tears everything down.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOwnMicTranscriber } from '../useOwnMicTranscriber';

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeStream(label: string): MediaStream {
  const track = { kind: 'audio', readyState: 'live', stop: vi.fn() };
  return {
    label,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

interface FakeRecorderState {
  instances: FakeMediaRecorder[];
}

class FakeMediaRecorder {
  static isTypeSupported = (mimeType: string): boolean =>
    mimeType === 'audio/webm;codecs=opus';

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly stream: MediaStream;

  constructor(stream: MediaStream) {
    this.stream = stream;
    (FakeMediaRecorder as unknown as FakeRecorderState).instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(1024)], { type: 'audio/webm' }),
    });
    this.onstop?.();
  }
}

function installFakes() {
  const state: FakeRecorderState = { instances: [] };
  (FakeMediaRecorder as unknown as FakeRecorderState).instances = state.instances;
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  return state;
}

function flushTimers(ms = 9000) {
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('useOwnMicTranscriber', () => {
  it('starts slicing when recording, mic on, and stream available', async () => {
    const fakes = installFakes();
    const stream = fakeStream('local');
    const onLiveChunk = vi.fn();

    const { result } = renderHook(() =>
      useOwnMicTranscriber({
        recording: true,
        startedAtMs: Date.now(),
        localStream: stream,
        isMicOn: true,
        onLiveChunk,
      }),
    );

    // Let the async effect settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('recording');
    expect(fakes.instances.length).toBeGreaterThanOrEqual(1);
  });

  it('reports muted when isMicOn is false', async () => {
    installFakes();
    const stream = fakeStream('local');
    const onLiveChunk = vi.fn();

    const { result } = renderHook(() =>
      useOwnMicTranscriber({
        recording: true,
        startedAtMs: Date.now(),
        localStream: stream,
        isMicOn: false,
        onLiveChunk,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('muted');
    expect(onLiveChunk).not.toHaveBeenCalled();
  });

  it('reports blocked when no stream and getUserMedia fails', async () => {
    installFakes();
    const onLiveChunk = vi.fn();
    // jsdom has no navigator.mediaDevices; stub it with a rejecting getUserMedia.
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    const { result } = renderHook(() =>
      useOwnMicTranscriber({
        recording: true,
        startedAtMs: Date.now(),
        localStream: null,
        isMicOn: true,
        onLiveChunk,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('blocked');
    expect(onLiveChunk).not.toHaveBeenCalled();
  });

  it('stopSharing stops uploads and resets when recording ends', async () => {
    installFakes();
    const stream = fakeStream('local');
    const onLiveChunk = vi.fn();

    const { result, rerender } = renderHook(
      (props) => useOwnMicTranscriber(props),
      {
        initialProps: {
          recording: true,
          startedAtMs: Date.now(),
          localStream: stream,
          isMicOn: true,
          onLiveChunk,
        },
      },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('recording');

    act(() => {
      result.current.stopSharing();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('idle');

    // Recording ends → stopped-sharing flag resets.
    rerender({
      recording: false,
      startedAtMs: 0,
      localStream: stream,
      isMicOn: true,
      onLiveChunk,
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('idle');
  });

  it('produces a slice after LIVE_CHUNK_MS', async () => {
    const fakes = installFakes();
    const stream = fakeStream('local');
    const onLiveChunk = vi.fn();
    const startedAt = Date.now();

    const { result } = renderHook(() =>
      useOwnMicTranscriber({
        recording: true,
        startedAtMs: startedAt,
        localStream: stream,
        isMicOn: true,
        onLiveChunk,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe('recording');
    expect(fakes.instances.length).toBe(1);

    // Advance past the 8 s slice boundary.
    await act(async () => {
      flushTimers(8500);
    });

    // The fake recorder's stop() calls ondataavailable + onstop synchronously,
    // which triggers onLiveChunk.
    expect(onLiveChunk).toHaveBeenCalled();
  });
});
