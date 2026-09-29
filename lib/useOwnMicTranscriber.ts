// useOwnMicTranscriber — per-client 8 s slice recorder on the local mic.
//
// Section B of the grounded-capture plan: every participant records its own
// microphone and labels the lines with its own user name. This hook owns the
// slice loop for ONE client's mic. It is started and stopped by the
// RECORDING_STATE broadcast (the host presses Record; every client reacts).
//
// What it owns:
//   * running a MediaRecorder on the local mic stream alone (not the mixed
//     stream — that is the host's fallback for extraction);
//   * stopping and restarting every LIVE_CHUNK_MS to hand a decodable slice
//     to the transcriber;
//   * pausing when the user mutes (isMicOn === false) and resuming on unmute;
//   * falling back to opening its own mic when the call provided none.
//
// What it deliberately does NOT own: the transcript queue, the store write,
// the broadcast. Those belong to useLiveTranscript and RecordingContext.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO_CONSTRAINTS } from './useWebRTC';
import { LIVE_CHUNK_MS, selectRecordingMimeType } from './useMeetingRecorder';

/** Why this client is not uploading audio right now. */
export type OwnMicStatus =
  | 'idle'
  | 'recording'
  | 'muted'
  | 'blocked';

/** Below this size a slice Blob is silently dropped (sub-second, no speech). */
const LIVE_CHUNK_MIN_BYTES = 512;

export interface UseOwnMicTranscriberOptions {
  /** True while the room is recording (from RECORDING_STATE). */
  recording: boolean;
  /** The recording start timestamp (from RECORDING_STATE.startedAt). */
  startedAtMs: number;
  /** The local participant's mic stream from useWebRTC, or null. */
  localStream: MediaStream | null;
  /** Whether the local mic is enabled (not muted). */
  isMicOn: boolean;
  /** Called with each 8 s slice. Same contract as useMeetingRecorder's. */
  onLiveChunk: (blob: Blob, offsetMs: number) => void;
}

export interface UseOwnMicTranscriberReturn {
  /** Why this client is or is not uploading. */
  status: OwnMicStatus;
  /**
   * Stop sharing the mic for this client only. Does NOT stop the room
   * recording — the host's mixed recording and every other client continue.
   * Sets a local flag that suppresses slicing until the client leaves or
   * the recording stops.
   */
  stopSharing(): void;
}

export function useOwnMicTranscriber({
  recording,
  startedAtMs,
  localStream,
  isMicOn,
  onLiveChunk,
}: UseOwnMicTranscriberOptions): UseOwnMicTranscriberReturn {
  const [status, setStatus] = useState<OwnMicStatus>('idle');
  const [stoppedSharing, setStoppedSharing] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownMicRef = useRef<MediaStream | null>(null);
  const onLiveChunkRef = useRef(onLiveChunk);
  onLiveChunkRef.current = onLiveChunk;

  // Track the wall-clock start of the current slice so offsetMs advances
  // correctly across slice boundaries.
  const sliceStartedAtRef = useRef(0);

  const releaseOwnMic = useCallback(() => {
    ownMicRef.current?.getTracks().forEach((t) => t.stop());
    ownMicRef.current = null;
  }, []);

  const stopSlicing = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec !== null) {
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== 'inactive') {
        try { rec.stop(); } catch { /* already inactive */ }
      }
    }
  }, []);

  // Resolve the mic stream to record: prefer the call's localStream, fall
  // back to opening one with AUDIO_CONSTRAINTS.
  const resolveMicStream = useCallback(async (): Promise<MediaStream | null> => {
    if (localStream && localStream.getAudioTracks().some((t) => t.readyState !== 'ended')) {
      return localStream;
    }
    if (!navigator.mediaDevices?.getUserMedia) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      ownMicRef.current = stream;
      return stream;
    } catch {
      return null;
    }
  }, [localStream]);

  // The slice loop: start a fresh MediaRecorder, stop after LIVE_CHUNK_MS,
  // hand the blob to onLiveChunk, and restart.
  const startSlice = useCallback((stream: MediaStream, mimeType: string | undefined) => {
    const rec = mimeType === undefined
      ? new MediaRecorder(stream)
      : new MediaRecorder(stream, { mimeType });

    let sliceData: Blob | null = null;
    const sliceOffset = Date.now() - startedAtMs;
    sliceStartedAtRef.current = Date.now();

    rec.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) sliceData = event.data;
    };
    rec.onstop = () => {
      if (sliceData !== null && sliceData.size >= LIVE_CHUNK_MIN_BYTES) {
        onLiveChunkRef.current?.(sliceData, sliceOffset);
      }
      if (recorderRef.current === rec) {
        startSlice(stream, mimeType);
      }
    };

    recorderRef.current = rec;
    rec.start();

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const r = recorderRef.current;
      if (r !== null && r.state !== 'inactive') {
        try { r.stop(); } catch { /* already inactive */ }
      }
    }, LIVE_CHUNK_MS);
  }, [startedAtMs]);

  // React to recording / mute / stream changes.
  useEffect(() => {
    let cancelled = false;

    async function react() {
      // Always tear down first — a clean slate for every transition.
      stopSlicing();
      releaseOwnMic();

      if (!recording || stoppedSharing) {
        setStatus('idle');
        return;
      }
      if (!isMicOn) {
        setStatus('muted');
        return;
      }

      const stream = await resolveMicStream();
      if (cancelled) {
        // The effect re-ran while we were awaiting getUserMedia; the next
        // invocation will clean up.
        return;
      }
      if (stream === null) {
        setStatus('blocked');
        return;
      }

      const mimeType = selectRecordingMimeType((c) => MediaRecorder.isTypeSupported(c));
      setStatus('recording');
      startSlice(stream, mimeType);
    }

    void react();

    return () => {
      cancelled = true;
      stopSlicing();
      releaseOwnMic();
    };
  }, [recording, isMicOn, localStream, stoppedSharing, stopSlicing, releaseOwnMic, resolveMicStream, startSlice]);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      stopSlicing();
      releaseOwnMic();
    };
  }, [stopSlicing, releaseOwnMic]);

  const stopSharing = useCallback(() => {
    setStoppedSharing(true);
  }, []);

  // Reset the stopped-sharing flag when the recording ends, so a new
  // recording starts fresh.
  useEffect(() => {
    if (!recording) setStoppedSharing(false);
  }, [recording]);

  return { status, stopSharing };
}
