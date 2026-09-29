// usePointingTimeline — samples the local user's deictic target at 2 Hz while
// the room is recording, coalesces consecutive same-part samples into segments,
// drops segments shorter than 400 ms, and broadcasts finished segments as
// POINTING_SEGMENT. Also receives remote segments and stores them in the
// room-wide pointing timeline store.
//
// Nothing happens while recording is false: no sampling, no broadcasts, no
// memory growth. Starting a new recording clears the previous segments.

import { useEffect, useRef } from 'react';
import { subscribeRecordingState, broadcastPointingSegment, type RecordingStatePayload } from './usePartyPresence';
import { remoteLaserPartNames, remoteLaserTargets } from './laserTargetRef';
import { pointingSourceRef } from './pointingSourceRef';
import { usePointingTimelineStore, type PointingSegment, type PointingSegmentSource } from './pointingTimelineStore';

const SAMPLE_INTERVAL_MS = 500; // 2 Hz
const MIN_SEGMENT_MS = 400;

function getLocalUserName(): string {
  try {
    const stored = localStorage.getItem('vp_user');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.name) return parsed.name;
    }
  } catch { /* ignore */ }
  return 'Guest';
}

interface PendingSegment {
  userId: string;
  userName: string;
  partId: string;
  partName: string;
  source: PointingSegmentSource;
  fromMs: number;
}

export function usePointingTimeline(localUserId: string): void {
  const recordingRef = useRef<RecordingStatePayload | null>(null);
  const pendingRef = useRef<PendingSegment | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const localUserIdRef = useRef(localUserId);
  localUserIdRef.current = localUserId;

  useEffect(() => {
    const unsub = subscribeRecordingState((state) => {
      const wasRecording = recordingRef.current?.recording === true;
      const isRecording = state?.recording === true;

      recordingRef.current = state;

      if (isRecording && !wasRecording) {
        // New recording started — clear previous segments and start sampling.
        usePointingTimelineStore.getState().clear();
        pendingRef.current = null;
        startSampling();
      } else if (!isRecording && wasRecording) {
        // Recording stopped — flush any pending segment and stop sampling.
        stopSampling();
        flushPending();
      }
    });

    return () => {
      unsub();
      stopSampling();
      pendingRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startSampling() {
    if (intervalRef.current !== null) return;
    intervalRef.current = setInterval(sample, SAMPLE_INTERVAL_MS);
  }

  function stopSampling() {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  function sample() {
    const rec = recordingRef.current;
    if (!rec?.recording) return;

    const partName = remoteLaserPartNames.get(localUserIdRef.current) ?? null;
    const partId = remoteLaserTargets.get(localUserIdRef.current) ?? null;
    const source = pointingSourceRef.current;

    if (!partName || !partId || !source) {
      // Not pointing at anything — close any pending segment.
      closePending();
      return;
    }

    const nowMs = Date.now() - rec.startedAt;
    const pending = pendingRef.current;

    if (pending && pending.partId === partId && pending.source === source) {
      // Same part, same source — the pending segment continues (no update needed,
      // toMs is computed when closing).
      return;
    }

    // Different part or source — close the old segment and start a new one.
    closePending();
    pendingRef.current = {
      userId: localUserIdRef.current,
      userName: getLocalUserName(),
      partId,
      partName,
      source,
      fromMs: nowMs,
    };
  }

  function closePending() {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;

    const rec = recordingRef.current;
    if (!rec?.recording) return;

    const toMs = Date.now() - rec.startedAt;
    if (toMs - pending.fromMs < MIN_SEGMENT_MS) return;

    const seg: PointingSegment = { ...pending, toMs };
    usePointingTimelineStore.getState().addSegment(seg);
    broadcastPointingSegment(seg);
  }

  function flushPending() {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;

    const rec = recordingRef.current;
    const toMs = rec?.recording ? Date.now() - rec.startedAt : pending.fromMs;
    if (toMs - pending.fromMs < MIN_SEGMENT_MS) return;

    const seg: PointingSegment = { ...pending, toMs };
    usePointingTimelineStore.getState().addSegment(seg);
    broadcastPointingSegment(seg);
  }
}
