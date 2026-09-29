// Tests for useMeetingRecorder (T4.4) — the browser recording half.
//
// jsdom has neither MediaRecorder nor an AudioContext, so everything here runs
// against fakes: the pure helpers take their environment as an argument, and the
// hook is exercised with both globals stubbed. That is the point of keeping the
// mixing and the mime selection out of the hook body.
//
// What is pinned:
//   * 'unsupported' is reported when either global is missing — a MediaRecorder
//     with no AudioContext would record the host and nobody else;
//   * the recorder is pointed at the MIXED stream, not at the microphone;
//   * a participant who joins mid-recording is mixed in, and the recorder is not
//     rebuilt (which would discard the meeting so far);
//   * stopping closes the graph, and nothing here ever stops a WebRTC track.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  NO_MICROPHONE_MESSAGE,
  RECORDING_MIME_CANDIDATES,
  LIVE_CHUNK_MS,
  assembleRecording,
  createMixingGraph,
  isRecordingSupported,
  selectRecordingMimeType,
  useMeetingRecorder,
  type MixingAudioContext,
  MUTED_MICROPHONE_MESSAGE,
} from '../useMeetingRecorder';
import { AUDIO_CONSTRAINTS } from '../useWebRTC';

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeNode {
  readonly stream: MediaStream;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface FakeContextState {
  sources: FakeNode[];
  destination: FakeNode;
  closeCalls: number;
  closeRejectsWith: Error | null;
}

function fakeStream(label: string): MediaStream {
  // Identity is all the mixer uses a stream for: it is the Map key, and it is
  // what gets handed to createMediaStreamSource.
  // A live audio track too, so the recorder treats it as a usable microphone
  // and does not open its own.
  const track = { kind: 'audio', readyState: 'live', enabled: true, stop: vi.fn() };
  return { label, getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

function fakeNode(stream: MediaStream): FakeNode {
  return { stream, connect: vi.fn(), disconnect: vi.fn() };
}

function installFakeAudioContext() {
  const state: FakeContextState = {
    sources: [],
    destination: fakeNode(fakeStream('mixed-output')),
    closeCalls: 0,
    closeRejectsWith: null,
  };

  class FakeAudioContext {
    createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
      const node = fakeNode(stream);
      state.sources.push(node);
      return node as unknown as MediaStreamAudioSourceNode;
    }
    createMediaStreamDestination(): MediaStreamAudioDestinationNode {
      return state.destination as unknown as MediaStreamAudioDestinationNode;
    }
    close(): Promise<void> {
      state.closeCalls += 1;
      return state.closeRejectsWith === null
        ? Promise.resolve()
        : Promise.reject(state.closeRejectsWith);
    }
  }

  return { FakeAudioContext, state };
}

function installedRecorderFakes() {
  const instances: FakeMediaRecorder[] = [];

  class FakeMediaRecorder {
    static isTypeSupported = (mimeType: string): boolean =>
      mimeType === 'audio/webm;codecs=opus';

    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    readonly stream: MediaStream;
    readonly options: MediaRecorderOptions | undefined;
    startCalls: number[] = [];

    constructor(stream: MediaStream, options?: MediaRecorderOptions) {
      this.stream = stream;
      this.options = options;
      instances.push(this);
    }

    start(timeslice?: number): void {
      this.state = 'recording';
      this.startCalls.push(timeslice ?? -1);
    }

    /** Flushes synchronously, which is what lets stop() be awaited in a test. */
    stop(): void {
      if (this.state === 'inactive') throw new Error('InvalidStateError');
      this.state = 'inactive';
      // Large enough to pass LIVE_CHUNK_MIN_BYTES (512) in the live-chunk path.
      this.ondataavailable?.({
        data: new Blob([new Uint8Array(1024)], { type: 'audio/webm' }),
      });
      this.onstop?.();
    }
  }

  return { FakeMediaRecorder, instances };
}

// ─── isRecordingSupported ───────────────────────────────────────────────────

describe('isRecordingSupported', () => {
  it('is true only when BOTH MediaRecorder and AudioContext exist', () => {
    class Present {}
    expect(isRecordingSupported({ MediaRecorder: Present, AudioContext: Present })).toBe(
      true,
    );
  });

  it('is false when AudioContext is missing', () => {
    // A MediaRecorder on its own can only record one stream. Pointed at the
    // microphone that is the host and none of the remote participants — most of
    // a design review missing, silently. Better to say "unsupported".
    class Present {}
    expect(isRecordingSupported({ MediaRecorder: Present })).toBe(false);
    expect(isRecordingSupported({ MediaRecorder: Present, AudioContext: undefined })).toBe(
      false,
    );
  });

  it('is false when MediaRecorder is missing', () => {
    class Present {}
    expect(isRecordingSupported({ AudioContext: Present })).toBe(false);
  });

  it('is false for an empty environment, which is what jsdom provides', () => {
    expect(isRecordingSupported({})).toBe(false);
    expect(isRecordingSupported()).toBe(false);
  });

  it('is false when the globals exist but are not constructors', () => {
    expect(isRecordingSupported({ MediaRecorder: {}, AudioContext: 'nope' })).toBe(
      false,
    );
  });
});

// ─── selectRecordingMimeType ────────────────────────────────────────────────

describe('selectRecordingMimeType', () => {
  it('pins the candidate list, best first', () => {
    expect([...RECORDING_MIME_CANDIDATES]).toEqual([
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ]);
  });

  it('takes the first candidate the browser can encode', () => {
    expect(selectRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('falls through to plain WebM when the Opus variant is refused', () => {
    expect(selectRecordingMimeType((t) => t === 'audio/webm')).toBe('audio/webm');
  });

  it('falls through to OGG/Opus for an older Firefox', () => {
    expect(selectRecordingMimeType((t) => t === 'audio/ogg;codecs=opus')).toBe(
      'audio/ogg;codecs=opus',
    );
  });

  it('returns undefined when nothing is supported, so MediaRecorder picks its own default', () => {
    const seen: string[] = [];
    const result = selectRecordingMimeType((t) => {
      seen.push(t);
      return false;
    });
    expect(result).toBeUndefined();
    // Every candidate was offered, in order, before giving up.
    expect(seen).toEqual([...RECORDING_MIME_CANDIDATES]);
  });
});

// ─── assembleRecording ──────────────────────────────────────────────────────

describe('assembleRecording', () => {
  it('concatenates every chunk into one Blob', () => {
    const blob = assembleRecording(['aa', 'bbb', 'c'], 'audio/webm');
    expect(blob.size).toBe(6);
    expect(blob.type).toBe('audio/webm');
  });

  it('labels the Blob with the container the recorder actually used', () => {
    expect(assembleRecording(['a'], 'audio/ogg;codecs=opus').type).toBe(
      'audio/ogg;codecs=opus',
    );
  });

  it('falls back to a WebM label when the recorder reported none', () => {
    expect(assembleRecording(['a'], undefined).type).toBe('audio/webm');
  });
});

// ─── createMixingGraph ──────────────────────────────────────────────────────

describe('createMixingGraph', () => {
  it('routes every stream into one shared destination', () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const local = fakeStream('local');
    const remote = fakeStream('remote');

    const graph = createMixingGraph(
      new FakeAudioContext() as unknown as MixingAudioContext,
      [local, remote],
    );

    expect(state.sources).toHaveLength(2);
    expect(state.sources.map((s) => s.stream)).toEqual([local, remote]);
    for (const source of state.sources) {
      expect(source.connect).toHaveBeenCalledWith(state.destination);
    }
    // One mixed output, which is what the MediaRecorder is pointed at.
    expect(graph.output).toBe(state.destination.stream);
  });

  it('starts with no sources when handed no streams', () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    createMixingGraph(new FakeAudioContext() as unknown as MixingAudioContext);
    expect(state.sources).toHaveLength(0);
  });

  it('attach is idempotent, so a caller can re-attach on every render', () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const stream = fakeStream('remote');
    const graph = createMixingGraph(
      new FakeAudioContext() as unknown as MixingAudioContext,
    );

    graph.attach(stream);
    graph.attach(stream);
    graph.attach(stream);

    expect(state.sources).toHaveLength(1);
  });

  it('mixes whole streams and never touches their tracks', () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const getAudioTracks = vi.fn();
    const getVideoTracks = vi.fn();
    const stream = { getAudioTracks, getVideoTracks } as unknown as MediaStream;

    const graph = createMixingGraph(
      new FakeAudioContext() as unknown as MixingAudioContext,
    );
    graph.attach(stream);

    // A MediaStreamAudioSourceNode only ever reads the audio tracks, so
    // "video tracks ignored" needs no filtering here — and filtering by hand
    // would drop tracks added after the fact.
    expect(getAudioTracks).not.toHaveBeenCalled();
    expect(getVideoTracks).not.toHaveBeenCalled();
  });

  it('dispose disconnects every node and closes the context', () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const graph = createMixingGraph(
      new FakeAudioContext() as unknown as MixingAudioContext,
      [fakeStream('a'), fakeStream('b')],
    );

    graph.dispose();

    expect(state.sources).toHaveLength(2);
    for (const source of state.sources) {
      expect(source.disconnect).toHaveBeenCalledTimes(1);
    }
    expect(state.closeCalls).toBe(1);
  });

  it('dispose is safe to call twice', () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const graph = createMixingGraph(
      new FakeAudioContext() as unknown as MixingAudioContext,
      [fakeStream('a')],
    );

    graph.dispose();
    graph.dispose();

    // The node list is the CONTEXT's record of what it built; the graph forgets
    // its own nodes on the first dispose, so the second has nothing to
    // disconnect and does not disconnect the same node twice.
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(state.closeCalls).toBe(2);
  });

  it('swallows a rejection from closing an already-closed context', async () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    state.closeRejectsWith = new Error('already closed');
    const graph = createMixingGraph(
      new FakeAudioContext() as unknown as MixingAudioContext,
    );

    // A double dispose is the normal path (stop(), then the unmount cleanup), so
    // it must not surface as an unhandled rejection.
    expect(() => graph.dispose()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});

// ─── The hook ───────────────────────────────────────────────────────────────

describe('useMeetingRecorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderRecorder(localStream: MediaStream | null, remoteStreams: Map<string, MediaStream>) {
    return renderHook(
      ({ local, remote }: { local: MediaStream | null; remote: Map<string, MediaStream> }) =>
        useMeetingRecorder({ localStream: local, remoteStreams: remote }),
      { initialProps: { local: localStream, remote: remoteStreams } },
    );
  }

  it("reports 'unsupported' when the browser cannot record", () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.stubGlobal('AudioContext', undefined);

    const { result } = renderRecorder(null, new Map());

    expect(result.current.state).toBe('unsupported');
  });

  it('start() does nothing when unsupported, so no half-recording is promised', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.stubGlobal('AudioContext', undefined);

    const { result } = renderRecorder(null, new Map());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('unsupported');
  });

  it('stop() rejects when nothing was recording rather than hanging', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    vi.stubGlobal('AudioContext', undefined);

    const { result } = renderRecorder(null, new Map());

    await expect(result.current.stop()).rejects.toThrow(
      /no recording in progress/,
    );
  });

  it('records the MIXED stream and hands back one Blob on stop', async () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const local = fakeStream('local');
    const remote = fakeStream('remote');
    const { result } = renderRecorder(local, new Map([['peer-1', remote]]));

    expect(result.current.state).toBe('idle');

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toBe('recording');
    expect(instances).toHaveLength(1);
    // The whole point of the mixer: the recorder sees one stream containing
    // everybody, not the microphone alone.
    expect(instances[0].stream).toBe(state.destination.stream);
    expect(instances[0].options?.mimeType).toBe('audio/webm;codecs=opus');
    expect(state.sources.map((s) => s.stream)).toEqual([local, remote]);
    // Chunked rather than one buffer at the end.
    expect(instances[0].startCalls[0]).toBeGreaterThan(0);

    let blob: Blob | undefined;
    await act(async () => {
      blob = await result.current.stop();
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('audio/webm;codecs=opus');
    expect(blob?.size).toBeGreaterThan(0);
    expect(result.current.state).toBe('idle');
    // The graph is torn down, and the context closed with it.
    expect(state.closeCalls).toBe(1);
    for (const source of state.sources) {
      expect(source.disconnect).toHaveBeenCalledTimes(1);
    }
  });

  it('mixes in a participant who joins after recording started', async () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const local = fakeStream('local');
    const latecomer = fakeStream('latecomer');
    const { result, rerender } = renderRecorder(local, new Map());

    await act(async () => {
      await result.current.start();
    });
    expect(state.sources).toHaveLength(1);

    // useWebRTC replaces the Map (not its streams) when a peer joins.
    rerender({ local, remote: new Map([['peer-2', latecomer]]) });

    expect(state.sources.map((s) => s.stream)).toEqual([local, latecomer]);
    // Crucially, the recorder was NOT rebuilt: everything already recorded
    // would have been thrown away.
    expect(instances).toHaveLength(1);
    expect(result.current.state).toBe('recording');
  });

  it('never stops the WebRTC tracks it was given', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const stopTrack = vi.fn();
    const local = {
      getAudioTracks: () => [{ kind: 'audio', readyState: 'live', enabled: true, stop: stopTrack }],
    } as unknown as MediaStream;
    const { result, unmount } = renderRecorder(local, new Map());

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.stop();
    });
    unmount();

    // These streams belong to useWebRTC. Navigating away from the manager panel
    // or ending a summary must not mute anybody or end the call.
    expect(stopTrack).not.toHaveBeenCalled();
  });

  it('tears the recorder down on unmount while recording', async () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const { result, unmount } = renderRecorder(fakeStream('local'), new Map());

    await act(async () => {
      await result.current.start();
    });
    expect(instances[0].state).toBe('recording');

    unmount();

    expect(instances[0].state).toBe('inactive');
    expect(state.closeCalls).toBe(1);
  });

  it('returns stable start and stop callbacks', () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const local = fakeStream('local');
    const { result, rerender } = renderRecorder(local, new Map());
    const firstStart = result.current.start;
    const firstStop = result.current.stop;

    rerender({ local, remote: new Map([['peer-1', fakeStream('remote')]]) });

    expect(result.current.start).toBe(firstStart);
    expect(result.current.stop).toBe(firstStop);
  });

  // ── No call audio: the recorder opens (and owns) its own microphone ──────
  // A live test found a 0-byte recording: the host had not joined the call's
  // audio, so the mixer had no input at all.

  function stubMediaDevices(getUserMedia: () => Promise<MediaStream>) {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(getUserMedia) },
      configurable: true,
    });
    return (navigator.mediaDevices as unknown as { getUserMedia: ReturnType<typeof vi.fn> })
      .getUserMedia;
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('opens its own microphone when the call provides no audio, and stops it after', async () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const ownMic = fakeStream('own-mic');
    const getUserMedia = stubMediaDevices(async () => ownMic);

    const { result } = renderRecorder(null, new Map());
    await act(async () => {
      await result.current.start();
    });

    expect(getUserMedia).toHaveBeenCalledWith({ audio: AUDIO_CONSTRAINTS });
    expect(state.sources.map((s) => s.stream)).toEqual([ownMic]);

    await act(async () => {
      await result.current.stop();
    });
    // Its own stream, so it is released: the browser's mic indicator goes off.
    expect(ownMic.getAudioTracks()[0].stop).toHaveBeenCalled();
  });

  it('rejects with a readable message when no microphone is available', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    stubMediaDevices(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });

    const { result } = renderRecorder(null, new Map());
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow(NO_MICROPHONE_MESSAGE);
    });

    // Nothing half-started: no recorder, still idle, so the user can retry.
    expect(instances).toHaveLength(0);
    expect(result.current.state).toBe('idle');
  });

  it('does not mix the call mic in as well while its own mic is open', async () => {
    const { FakeAudioContext, state } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const ownMic = fakeStream('own-mic');
    stubMediaDevices(async () => ownMic);

    const { result, rerender } = renderRecorder(null, new Map());
    await act(async () => {
      await result.current.start();
    });
    // The host joins the call mid-recording: same physical microphone.
    rerender({ local: fakeStream('call-mic'), remote: new Map() });

    expect(state.sources.map((s) => s.stream)).toEqual([ownMic]);
  });

  it('keeps the audio when the browser stops the recorder on its own', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const { result } = renderRecorder(fakeStream('local'), new Map());
    await act(async () => {
      await result.current.start();
    });
    // e.g. every input track ended: the recorder flushes and stops by itself.
    act(() => {
      instances[0].stop();
    });

    let blob: Blob | undefined;
    await act(async () => {
      blob = await result.current.stop();
    });
    expect(blob?.size).toBeGreaterThan(0);
  });

  // ── Live chunks (T4.7) ──────────────────────────────────────────────────

  it('starts a second MediaRecorder for live chunks when onLiveChunk is given', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.useFakeTimers();

    const onLiveChunk = vi.fn();
    const local = fakeStream('local');

    const { result } = renderHook(
      () => useMeetingRecorder({ localStream: local, remoteStreams: new Map(), onLiveChunk }),
    );

    await act(async () => {
      await result.current.start();
    });

    // Two recorders: the main one (timesliced) and the live-chunk one.
    expect(instances).toHaveLength(2);
    // The live recorder is the second one and is NOT timesliced (it uses
    // stop/restart, not start(timeslice)).
    expect(instances[1].startCalls[0]).toBe(-1);

    await act(async () => {
      await result.current.stop();
    });

    vi.useRealTimers();
  });

  it('fires onLiveChunk at each LIVE_CHUNK_MS boundary with a fresh recorder', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.useFakeTimers();

    const onLiveChunk = vi.fn();
    const local = fakeStream('local');

    const { result } = renderHook(
      () => useMeetingRecorder({ localStream: local, remoteStreams: new Map(), onLiveChunk }),
    );

    await act(async () => {
      await result.current.start();
    });

    // instances[0] = main recorder, instances[1] = first live slice
    expect(instances).toHaveLength(2);
    const firstLiveRecorder = instances[1];

    // Advance to the first boundary.
    await act(async () => {
      vi.advanceTimersByTime(LIVE_CHUNK_MS);
    });

    // The first live recorder was stopped (flushed its blob), and a new one
    // was started for the next slice.
    expect(firstLiveRecorder.state).toBe('inactive');
    expect(onLiveChunk).toHaveBeenCalledTimes(1);
    expect(onLiveChunk.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(typeof onLiveChunk.mock.calls[0][1]).toBe('number');
    // A third recorder was created for the next slice.
    expect(instances).toHaveLength(3);

    await act(async () => {
      await result.current.stop();
    });

    vi.useRealTimers();
  });

  it('flushes the final partial chunk on stop', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.useFakeTimers();

    const onLiveChunk = vi.fn();
    const local = fakeStream('local');

    const { result } = renderHook(
      () => useMeetingRecorder({ localStream: local, remoteStreams: new Map(), onLiveChunk }),
    );

    await act(async () => {
      await result.current.start();
    });

    // Stop before any boundary fires — the partial chunk should still flush.
    await act(async () => {
      await result.current.stop();
    });

    // The live recorder was stopped, producing one final chunk.
    expect(onLiveChunk).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('does not start a live recorder when onLiveChunk is not given', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder, instances } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);

    const local = fakeStream('local');
    const { result } = renderRecorder(local, new Map());

    await act(async () => {
      await result.current.start();
    });

    // Only the main recorder — no live-chunk recorder.
    expect(instances).toHaveLength(1);

    await act(async () => {
      await result.current.stop();
    });
  });

  it('the main recording blob is unaffected by the live recorder', async () => {
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.useFakeTimers();

    const onLiveChunk = vi.fn();
    const local = fakeStream('local');

    const { result } = renderHook(
      () => useMeetingRecorder({ localStream: local, remoteStreams: new Map(), onLiveChunk }),
    );

    await act(async () => {
      await result.current.start();
    });

    let blob: Blob | undefined;
    await act(async () => {
      blob = await result.current.stop();
    });

    // The main recording is still a valid blob — the live recorder runs on
    // the same mixed stream but collects its own chunks separately.
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.size).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});

describe('a muted microphone', () => {
  it('is refused rather than silently recorded from a second mic', async () => {
    // Reported 2026-09-23: the call mic now starts muted, and the in-person
    // fallback opened ANOTHER mic behind the user's back, so someone who
    // believed they were muted was recorded anyway.
    const { FakeAudioContext } = installFakeAudioContext();
    const { FakeMediaRecorder } = installedRecorderFakes();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const muted = {
      getAudioTracks: () => [{ kind: 'audio', readyState: 'live', enabled: false, stop: vi.fn() }],
      getTracks: () => [{ kind: 'audio', readyState: 'live', enabled: false, stop: vi.fn() }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn();
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    const { result } = renderHook(() =>
      useMeetingRecorder({ localStream: muted, remoteStreams: new Map() }),
    );

    await expect(act(() => result.current.start())).rejects.toThrow(MUTED_MICROPHONE_MESSAGE);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
