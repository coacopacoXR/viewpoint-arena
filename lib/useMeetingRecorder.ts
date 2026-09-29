// useMeetingRecorder — record a meeting's audio in the browser (T4.4).
//
// Batch mode only, and that is a design constraint rather than a limitation:
// capture-service's POST /capture takes a complete recording and returns
// InsightCards (docs/local-capture-plan.md's "strong suggestion for the first
// iteration"). There is no live partial transcript here; streaming is T4.7.
//
// What this hook owns:
//   * mixing the local microphone and every remote participant into ONE track,
//     so a meeting with five speakers produces one upload and one transcript
//     with all five voices in it;
//   * picking a container/codec pair the browser can actually encode;
//   * handing back a Blob on stop(), and nothing else. Uploading, the
//     SlideContext and the store write belong to the caller.
//
// What it deliberately does NOT own: the WebRTC tracks. Recording is a passive
// observer of streams it does not create, so stopping a recording must never
// mute or end anybody's call.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO_CONSTRAINTS } from './useWebRTC';

export type RecorderState = 'idle' | 'recording' | 'unsupported';

/**
 * Chunks arrive every second instead of once at the end, so a two-hour meeting
 * does not accumulate as a single unbounded encoder buffer.
 */
const RECORDER_TIMESLICE_MS = 1000;

/**
 * How often the live-chunk recorder stops and restarts to hand a decodable
 * slice to the transcriber. Eight seconds is the compromise: short enough that
 * the panel is ~10–15 s behind (8 s recording + a few seconds to transcribe),
 * long enough that each slice carries enough audio for Whisper to produce
 * something meaningful. A word can be split across a boundary — documented in
 * useLiveTranscript, which joins consecutive chunks with a space.
 */
export const LIVE_CHUNK_MS = 8000;

/**
 * Below this size a live-chunk Blob is silently dropped: a sub-second slice
 * has no useful speech and would burn a transcribe round-trip for silence.
 */
const LIVE_CHUNK_MIN_BYTES = 512;

/** The fallback container when MediaRecorder reports no mimeType of its own. */
const DEFAULT_RECORDING_MIME = 'audio/webm';

// ─── Pure helpers (each testable with fakes, no DOM audio required) ─────────

/**
 * The environment feature-detect reads. Structural on purpose: a test passes
 * `{ MediaRecorder: class {}, AudioContext: class {} }` and jsdom, which has
 * neither, exercises the 'unsupported' path for free.
 */
export interface RecordingEnvironment {
  MediaRecorder?: unknown;
  AudioContext?: unknown;
}

/**
 * Can this browser record and mix audio at all?
 *
 * AudioContext is checked alongside MediaRecorder because mixing is not
 * optional here: a MediaRecorder pointed at the microphone alone would capture
 * the host and nobody else, which for a design review is most of the content
 * missing. A browser with one and not the other is reported as unsupported
 * rather than silently recording half the meeting.
 */
export function isRecordingSupported(
  env: RecordingEnvironment = globalThis,
): boolean {
  return (
    typeof env.MediaRecorder === 'function' &&
    typeof env.AudioContext === 'function'
  );
}

/**
 * Preferred containers, best first. Opus in WebM is what every Chromium and
 * Firefox ships; the OGG pair is the older Firefox fallback; and when a browser
 * supports none of them MediaRecorder is constructed with no mimeType and picks
 * its own default, which is still a recording.
 */
export const RECORDING_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

/** The first candidate the browser can encode, or undefined for its default. */
export function selectRecordingMimeType(
  isSupported: (mimeType: string) => boolean,
): string | undefined {
  return RECORDING_MIME_CANDIDATES.find((candidate) => isSupported(candidate));
}

/** The slice of AudioContext the mixer uses, so a fake can satisfy it. */
export type MixingAudioContext = Pick<
  AudioContext,
  'createMediaStreamSource' | 'createMediaStreamDestination' | 'close'
>;

export interface MixingGraph {
  /**
   * Adds every audio track of `stream` to the mix. Idempotent per stream, so a
   * caller can re-attach on every render; video tracks are ignored because a
   * MediaStreamAudioSourceNode only ever reads the audio ones.
   */
  attach(stream: MediaStream): void;
  /** The single mixed stream, which is what the MediaRecorder is given. */
  readonly output: MediaStream;
  /** Disconnects every node and closes the AudioContext. Safe to call twice. */
  dispose(): void;
}

/**
 * N streams in, one stream out.
 *
 * One AudioContext and one MediaStreamAudioDestinationNode for the whole
 * recording: a second context would mean a second clock, and mixing two clocks
 * is how recordings drift out of sync over an hour-long meeting.
 */
export function createMixingGraph(
  context: MixingAudioContext,
  initial: Iterable<MediaStream> = [],
): MixingGraph {
  const destination = context.createMediaStreamDestination();
  const nodes = new Map<MediaStream, MediaStreamAudioSourceNode>();

  function attach(stream: MediaStream): void {
    if (nodes.has(stream)) return;
    const node = context.createMediaStreamSource(stream);
    node.connect(destination);
    nodes.set(stream, node);
  }

  for (const stream of initial) attach(stream);

  return {
    attach,
    get output(): MediaStream {
      return destination.stream;
    },
    dispose(): void {
      for (const node of nodes.values()) node.disconnect();
      nodes.clear();
      // Closing twice rejects; a dispose from stop() followed by one from the
      // unmount cleanup must not surface as an unhandled rejection.
      context.close().catch(() => undefined);
    },
  };
}

/**
 * Concatenates the recorder's chunks into the single upload Blob.
 *
 * The type is the one the recorder was constructed with, not a guess from the
 * first chunk: capture-service hands the file to ffmpeg, which sniffs the real
 * format, so this only has to be honest enough not to mislead an operator.
 */
export function assembleRecording(
  chunks: BlobPart[],
  mimeType: string | undefined,
): Blob {
  return new Blob(chunks, { type: mimeType ?? DEFAULT_RECORDING_MIME });
}

// ─── The hook ───────────────────────────────────────────────────────────────

export interface UseMeetingRecorderOptions {
  /** The local participant's stream, or null before the mic is granted. */
  localStream: MediaStream | null;
  /** Every remote participant, keyed by user id. */
  remoteStreams: Map<string, MediaStream>;
  /**
   * Optional callback for the live-transcript path (T4.7). When given, a
   * SECOND MediaRecorder runs alongside the main one on the SAME mixed stream:
   * it stops and restarts every LIVE_CHUNK_MS, handing a decodable Blob to the
   * caller. The main recorder is untouched, so the final capture still gets
   * one continuous recording. The offsetMs is the wall-clock position of the
   * chunk's start within the overall recording.
   *
   * A word can be split across a chunk boundary — the caller is expected to
   * join consecutive chunk texts with a space.
   */
  onLiveChunk?: (blob: Blob, offsetMs: number) => void;
}

export interface UseMeetingRecorderReturn {
  readonly state: RecorderState;
  /**
   * Begins recording. No-op when unsupported or already recording.
   *
   * Rejects with a readable message when there is no microphone to record: the
   * call provides none and the browser refused (or has no) microphone.
   */
  start(): Promise<void>;
  /**
   * Stops recording and resolves with the whole recording as one Blob.
   * Rejects only when nothing was in progress — the caller keeps the Blob on a
   * failed UPLOAD, so a summary can be retried without re-running the meeting.
   */
  stop(): Promise<Blob>;
}

/** True when the stream carries at least one audio track that is still live. */
export function hasLiveAudio(stream: MediaStream | null): stream is MediaStream {
  // `enabled` matters as much as `readyState`. A muted track is still "live":
  // it just carries silence. Since the mic starts muted (the call opens on
  // room entry), treating a muted track as usable made the recorder mix
  // silence instead of falling back to its own mic — Whisper's VAD then
  // correctly dropped every clip and no transcript line ever appeared. Muting
  // must mean muting, not "record me anyway", so this returns false and the
  // caller tells the user to unmute.
  return (
    stream !== null &&
    stream.getAudioTracks().some((track) => track.readyState !== 'ended' && track.enabled)
  );
}

/** The message shown when there is nothing to record from. */
export const NO_MICROPHONE_MESSAGE =
  'No microphone available. Allow microphone access in the browser, or join the call with your microphone on, then try again.';

/**
 * Shown when the room's microphone exists but is muted. Recording from it
 * anyway would betray the mute button, and opening a SECOND microphone behind
 * the user's back (which the in-person fallback below would otherwise do) is
 * worse: it records someone who believes they are muted.
 */
export const MUTED_MICROPHONE_MESSAGE =
  'Your microphone is muted. Unmute it to be recorded.';

export function useMeetingRecorder({
  localStream,
  remoteStreams,
  onLiveChunk,
}: UseMeetingRecorderOptions): UseMeetingRecorderReturn {
  // Lazy initialiser: the feature-detect reads globals once, and jsdom (where
  // neither exists) gets 'unsupported' without a render-loop flip.
  const [state, setState] = useState<RecorderState>(() =>
    isRecordingSupported() ? 'idle' : 'unsupported',
  );

  const graphRef = useRef<MixingGraph | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const mimeTypeRef = useRef<string | undefined>(undefined);
  const finishRef = useRef<((blob: Blob) => void) | null>(null);
  const startingRef = useRef(false);
  // A microphone stream THIS hook opened because the call provided none. Unlike
  // the WebRTC streams, it belongs to the recorder, so the recorder stops it.
  const ownMicRef = useRef<MediaStream | null>(null);

  // Live-chunk recorder (T4.7). A SECOND MediaRecorder on the same mixed stream
  // that is stopped and restarted every LIVE_CHUNK_MS. Each stop yields a
  // standalone, decodable file (a timeslice fragment of one long recording is
  // NOT decodable on its own: only the first fragment has the container header,
  // so `start(timeslice)` is deliberately NOT used here).
  const liveRecorderRef = useRef<MediaRecorder | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveOffsetRef = useRef(0);
  const liveStartedAtRef = useRef(0);
  const onLiveChunkRef = useRef(onLiveChunk);
  onLiveChunkRef.current = onLiveChunk;

  // Refs rather than closure values so start() and stop() stay stable: a
  // participant who joins mid-recording is picked up by the attach effect below,
  // not by rebuilding the recorder (which would lose everything already mixed).
  const localStreamRef = useRef(localStream);
  const remoteStreamsRef = useRef(remoteStreams);

  useEffect(() => {
    localStreamRef.current = localStream;
    remoteStreamsRef.current = remoteStreams;

    const graph = graphRef.current;
    if (graph === null) return;
    // useWebRTC replaces the Map (not its streams) whenever a peer joins, so
    // this re-runs and attach() is idempotent for the ones already mixed in.
    // The call's local stream is skipped while the recorder has its own mic
    // open: both are the same physical microphone, and mixing it twice would
    // double every word the host says and garble the transcript.
    if (hasLiveAudio(localStream) && ownMicRef.current === null) graph.attach(localStream);
    for (const stream of remoteStreams.values()) graph.attach(stream);
  }, [localStream, remoteStreams]);

  // Unmount cleanup. Stops the recorder and tears the graph down. It stops the
  // recorder's OWN microphone, and pointedly nothing else: the WebRTC streams
  // belong to useWebRTC, and navigating away must not end the call.
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      const graph = graphRef.current;
      recorderRef.current = null;
      graphRef.current = null;
      finishRef.current = null;
      chunksRef.current = [];
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        // stop() on an inactive recorder throws InvalidStateError.
        if (recorder.state !== 'inactive') recorder.stop();
      }
      // Also stop the live-chunk recorder if one is running.
      if (liveRecorderRef.current !== null) {
        if (liveTimerRef.current !== null) {
          clearTimeout(liveTimerRef.current);
          liveTimerRef.current = null;
        }
        const live = liveRecorderRef.current;
        liveRecorderRef.current = null;
        live.ondataavailable = null;
        live.onstop = null;
        if (live.state !== 'inactive') live.stop();
      }
      graph?.dispose();
      ownMicRef.current?.getTracks().forEach((track) => track.stop());
      ownMicRef.current = null;
    };
  }, []);

  // Reads and clears the pending chunks. A stable callback over refs, so
  // start() and stop() can depend on it without being re-created per render.
  const takeBlob = useCallback((): Blob => {
    const blob = assembleRecording(chunksRef.current, mimeTypeRef.current);
    chunksRef.current = [];
    return blob;
  }, []);

  const releaseOwnMic = useCallback(() => {
    ownMicRef.current?.getTracks().forEach((track) => track.stop());
    ownMicRef.current = null;
  }, []);

  // Starts a fresh MediaRecorder slice on the mixed stream. Each slice is a
  // standalone, decodable file (a fresh recorder, not a timeslice of one long
  // recording — only the first fragment of a timesliced recording has the
  // container header). When the slice's timer fires, the recorder is stopped,
  // its blob handed to onLiveChunk, and a new slice is started.
  const startLiveSlice = useCallback(
    (mixedStream: MediaStream, mimeType: string | undefined) => {
      const recorder = mimeType === undefined
        ? new MediaRecorder(mixedStream)
        : new MediaRecorder(mixedStream, { mimeType });

      let sliceData: Blob | null = null;
      const sliceOffset = liveOffsetRef.current;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) sliceData = event.data;
      };
      recorder.onstop = () => {
        // Flush the slice to the caller.
        if (sliceData !== null && sliceData.size >= LIVE_CHUNK_MIN_BYTES) {
          onLiveChunkRef.current?.(sliceData, sliceOffset);
        }
        // Advance the offset by the wall-clock duration of this slice.
        liveOffsetRef.current = sliceOffset + (Date.now() - liveStartedAtRef.current);
        liveStartedAtRef.current = Date.now();
        // Start the next slice if the live recorder is still active.
        if (liveRecorderRef.current === recorder) {
          startLiveSlice(mixedStream, mimeType);
        }
      };

      liveRecorderRef.current = recorder;
      recorder.start();

      // Schedule the boundary.
      if (liveTimerRef.current !== null) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        const r = liveRecorderRef.current;
        if (r !== null && r.state !== 'inactive') {
          try { r.stop(); } catch { /* already inactive */ }
        }
      }, LIVE_CHUNK_MS);
    },
    [],
  );

  const start = useCallback(async (): Promise<void> => {
    if (!isRecordingSupported()) return;
    // Never restarts a recording already in flight: that would discard the
    // meeting so far. The UI only offers start() while idle.
    if (recorderRef.current !== null || startingRef.current) return;
    startingRef.current = true;

    try {
      const streams: MediaStream[] = [];
      if (hasLiveAudio(localStreamRef.current)) {
        streams.push(localStreamRef.current);
      } else if (
        (localStreamRef.current as MediaStream | null)?.getAudioTracks()
          .some((t) => t.readyState !== 'ended') === true
      ) {
        // A microphone is open for the call but muted — do not quietly open a
        // second one; tell the user.
        throw new Error(MUTED_MICROPHONE_MESSAGE);
      } else {
        // The host has not joined the call's audio — typical for an in-person
        // review run from one laptop. Without this the mixer had no input and
        // MediaRecorder produced a 0-byte recording (found in a live test).
        if (!navigator.mediaDevices?.getUserMedia) throw new Error(NO_MICROPHONE_MESSAGE);
        try {
          ownMicRef.current = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        } catch {
          throw new Error(NO_MICROPHONE_MESSAGE);
        }
        streams.push(ownMicRef.current);
      }
      streams.push(...remoteStreamsRef.current.values());

      const graph = createMixingGraph(new AudioContext(), streams);
      const mimeType = selectRecordingMimeType((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder =
        mimeType === undefined
          ? new MediaRecorder(graph.output)
          : new MediaRecorder(graph.output, { mimeType });

      chunksRef.current = [];
      mimeTypeRef.current = mimeType;

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        // Only hand the chunks over when stop() is waiting for them. If the
        // browser stopped the recorder on its own, they stay put and stop()
        // collects them; taking them here used to throw the meeting away.
        const finish = finishRef.current;
        if (finish === null) return;
        finishRef.current = null;
        finish(takeBlob());
      };

      graphRef.current = graph;
      recorderRef.current = recorder;
      recorder.start(RECORDER_TIMESLICE_MS);
      setState('recording');

      // Start the live-chunk recorder alongside the main one when the caller
      // wants a live transcript. Same mixed stream, independent recorder,
      // fresh slices so each one is decodable on its own.
      if (onLiveChunkRef.current) {
        liveOffsetRef.current = 0;
        liveStartedAtRef.current = Date.now();
        startLiveSlice(graph.output, mimeType);
      }
    } catch (err) {
      releaseOwnMic();
      throw err;
    } finally {
      startingRef.current = false;
    }
  }, [takeBlob, releaseOwnMic, startLiveSlice]);

  const stop = useCallback(async (): Promise<Blob> => {
    const recorder = recorderRef.current;
    const graph = graphRef.current;
    if (recorder === null || graph === null) {
      throw new Error(
        'useMeetingRecorder: stop() was called with no recording in progress.',
      );
    }
    recorderRef.current = null;
    graphRef.current = null;
    setState('idle');

    // Stop the live-chunk recorder first. The final partial slice is flushed
    // by the stop() call (ondataavailable fires synchronously before onstop),
    // and the onstop handler calls onLiveChunk for it. We then detach so the
    // auto-restart in startLiveSlice does not kick in.
    if (liveRecorderRef.current !== null) {
      const live = liveRecorderRef.current;
      if (liveTimerRef.current !== null) {
        clearTimeout(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      liveRecorderRef.current = null;
      // onstop will fire synchronously during stop(); it sees
      // liveRecorderRef.current === null and does NOT restart.
      if (live.state !== 'inactive') {
        try { live.stop(); } catch { /* already inactive */ }
      }
      live.onstop = null;
      live.ondataavailable = null;
    }

    const blob = await new Promise<Blob>((resolveBlob) => {
      if (recorder.state === 'inactive') {
        // Already flushed (or never started): resolving from the pending chunks
        // keeps the caller's await from hanging forever.
        resolveBlob(takeBlob());
        return;
      }
      finishRef.current = resolveBlob;
      recorder.stop();
    });

    // Disposed AFTER the recorder has produced its final chunk: closing the
    // AudioContext first would cut the tail off the meeting.
    graph.dispose();
    releaseOwnMic();
    return blob;
  }, [takeBlob, releaseOwnMic]);

  return { state, start, stop };
}
