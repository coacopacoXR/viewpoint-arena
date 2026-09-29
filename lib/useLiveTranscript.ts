// useLiveTranscript — queue + backpressure for the live-transcript path (T4.7).
//
// Receives audio Blobs from useMeetingRecorder's onLiveChunk callback, sends
// each one to capture-service's POST /transcribe via LocalCaptureProvider, and
// turns the resulting text into ChatMessages in the store.
//
// Three things this hook is careful about:
//   * ORDER. Chunks are sent strictly one at a time, in order. A chunk that
//     arrives while another is in flight waits in a queue. The live panel
//     reads top-to-bottom as the meeting progressed; out-of-order text would
//     be worse than no text at all.
//   * BACKPRESSURE. If more than 3 chunks are waiting (the transcriber is too
//     slow to keep up), the OLDEST waiting ones are dropped and a gap line is
//     added so the panel is honest about what it missed.
//   * FAILURE CUTOFF. After 3 consecutive transcription failures, one line
//     "(live transcript unavailable: <reason>)" is shown and sending stops
//     until the next recording. The final batch capture must work regardless.

import { useCallback, useRef } from 'react';
import type { LocalCaptureProvider } from './connectors/capture/local';
import type { ChatMessage } from '../types';
import { useStore } from '../store';
import { broadcastTranscriptLine } from './usePartyPresence';

/**
 * Whisper hallucinations for silent or near-silent audio. Case-insensitive,
 * whole-text match only — a chunk whose ENTIRE text is one of these is dropped
 * before it reaches the panel. This is a small, known set; new entries are
 * added as they are observed in production.
 */
const SILENCE_HALLUCINATIONS = new Set([
  'thank you.',
  'thanks for watching!',
  'you',
  'thank you',
  'thanks for watching',
  '.',
  'please subscribe.',
  'subscribe',
  '',
]);

/**
 * Maximum number of chunks allowed to be waiting (in the queue + the one
 * currently being transcribed). Beyond this, the oldest waiting chunks are
 * dropped with a gap line.
 */
const MAX_PENDING = 3;

/**
 * After this many consecutive transcription failures, the live transcript is
 * marked unavailable and no more chunks are sent until the next recording.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface UseLiveTranscriptOptions {
  /** The provider used to call transcribeChunk. Stable reference. */
  provider: LocalCaptureProvider;
  /** The recording start timestamp, used to build unique message IDs. */
  recordingStartMs: number;
  /**
   * The userId of the participant whose mic is being transcribed. Stamped on
   * every outgoing line and overwritten server-side (room.server.ts) so
   * nobody can forge a line as somebody else.
   */
  speakerId?: string;
  /**
   * The display name of the speaker. Shown in the transcript panel when no
   * agent matches the agentId.
   */
  speakerName?: string;
}

export interface UseLiveTranscriptReturn {
  /** Pass this to useMeetingRecorder's onLiveChunk option. */
  onLiveChunk: (blob: Blob, offsetMs: number) => void;
  /** Call when the recording stops to cancel any in-flight work. */
  finish(): void;
}

export function isSilenceHallucination(text: string): boolean {
  return SILENCE_HALLUCINATIONS.has(text.trim().toLowerCase());
}

export function useLiveTranscript({
  provider,
  recordingStartMs,
  speakerId,
  speakerName,
}: UseLiveTranscriptOptions): UseLiveTranscriptReturn {
  const seqRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);
  const stoppedRef = useRef(false);
  const processingRef = useRef(false);
  const queueRef = useRef<Array<{ blob: Blob; offsetMs: number }>>([]);
  const droppedMsRef = useRef(0);

  // Refs for speaker attribution so addLine stays stable across renders.
  const speakerIdRef = useRef(speakerId);
  speakerIdRef.current = speakerId;
  const speakerNameRef = useRef(speakerName);
  speakerNameRef.current = speakerName;

  const addLine = useCallback((text: string, offsetMs?: number) => {
    const { addChatMessage } = useStore.getState();
    const seq = seqRef.current;
    seqRef.current += 1;
    const msg: ChatMessage = {
      id: `live-${recordingStartMs}-${seq}`,
      agentId: 'live-transcript',
      text,
      timestamp: Date.now(),
      speakerName: speakerNameRef.current ?? 'Meeting',
      speakerId: speakerIdRef.current,
      offsetMs,
    };
    addChatMessage(msg);
    // Broadcast to the room so every participant sees the line.
    broadcastTranscriptLine(msg);
  }, [recordingStartMs]);

  const processQueue = useCallback(async () => {
    if (processingRef.current || stoppedRef.current) return;
    processingRef.current = true;

    while (queueRef.current.length > 0 && !stoppedRef.current) {
      const item = queueRef.current.shift()!;

      // Backpressure: if the queue was over the limit before this dequeue,
      // the excess was already dropped when enqueued. Nothing to do here.

      try {
        const text = await provider.transcribeChunk(item.blob);
        if (stoppedRef.current) break;

        const trimmed = text.trim();
        if (!trimmed || isSilenceHallucination(trimmed)) {
          // Silence or empty: no line added, but counts as a success (the
          // transcriber worked, it just had nothing to say).
          consecutiveFailuresRef.current = 0;
          continue;
        }

        consecutiveFailuresRef.current = 0;

        // If chunks were dropped while this one was in flight, add a gap line.
        if (droppedMsRef.current > 0) {
          const skippedSecs = Math.round(droppedMsRef.current / 1000);
          addLine(`(transcript skipped ~${skippedSecs} s: the transcriber is behind)`);
          droppedMsRef.current = 0;
        }

        addLine(trimmed, item.offsetMs);
      } catch (err) {
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          const reason = err instanceof Error ? err.message : 'transcription error';
          // Truncate for the panel — the full message can be long.
          const short = reason.length > 80 ? reason.slice(0, 77) + '...' : reason;
          addLine(`(live transcript unavailable: ${short})`);
          stoppedRef.current = true;
          break;
        }
        // A single failure: the chunk is lost, but we keep trying.
      }
    }

    processingRef.current = false;
  }, [provider, addLine]);

  const onLiveChunk = useCallback(
    (blob: Blob, offsetMs: number) => {
      if (stoppedRef.current) return;

      // Enqueue. If the queue + the one being processed exceeds MAX_PENDING,
      // drop the oldest waiting ones.
      queueRef.current.push({ blob, offsetMs });

      const totalPending = queueRef.current.length + (processingRef.current ? 1 : 0);
      if (totalPending > MAX_PENDING) {
        const toDrop = totalPending - MAX_PENDING;
        const dropped = queueRef.current.splice(0, toDrop);
        // Track the duration of dropped audio for the gap line.
        if (dropped.length > 0) {
          const firstOffset = dropped[0].offsetMs;
          const lastDropped = dropped[dropped.length - 1];
          // The next chunk's offset minus the first dropped offset ≈ dropped duration.
          // We approximate with the chunk spacing (LIVE_CHUNK_MS = 8000).
          droppedMsRef.current += (lastDropped.offsetMs - firstOffset) + 8000;
        }
      }

      // Kick off processing if not already running.
      void processQueue();
    },
    [processQueue],
  );

  const finish = useCallback(() => {
    stoppedRef.current = true;
    queueRef.current = [];
  }, []);

  return { onLiveChunk, finish };
}
