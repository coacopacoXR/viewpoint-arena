// RecordingContext — one recorder, two views, per-speaker live transcript.
//
// Batch W of the grounded-capture plan (section B: every participant records
// their own microphone). The recording controls lived inside PostMeetingSummary
// (ManagerPanel), which replaced the room sidebar — the person recording could
// not watch the LIVE TRANSCRIPT panel. The controls now live in the transcript
// tab AND in the Manager Workspace, both reading from a single RecordingProvider
// mounted in RoomPage.
//
// What this provider owns:
//   * the single useMeetingRecorder instance (host only, mixed stream, for
//     extraction — the final POST /capture);
//   * the useOwnMicTranscriber hook (every client, own mic, for the live
//     transcript);
//   * the useLiveTranscript hook that feeds the LIVE TRANSCRIPT panel;
//   * the LocalCaptureProvider used for both live chunks and the final
//     captureRecording() call;
//   * the elapsed timer, the summarise/retry flow, and the outcome state;
//   * the RECORDING_STATE broadcast (host presses Record → every client
//     starts its own mic slicer).
//
// What it exposes: { state, elapsedMs, outcome, summarising, start, stop,
// retry, liveLines, canRecord, recordingState, ownMicStatus, stopSharingMic }.
// Consumers are pure presentation.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useWebRTCContext } from './WebRTCContext';
import { usePresence } from './PresenceContext';
import { useStore, sceneComponents } from '../store';
import { useActiveReviewStore } from './activeReviewStore';
import { useConnectorConfig } from './config/ConfigContext';
import { useMeetingRecorder } from './useMeetingRecorder';
import { useLiveTranscript } from './useLiveTranscript';
import { useOwnMicTranscriber, type OwnMicStatus } from './useOwnMicTranscriber';
import {
  subscribeRecordingState,
  broadcastRecordingState,
  broadcastTranscriptKeep,
  type RecordingStatePayload,
} from './usePartyPresence';
import { usePointingTimeline } from './usePointingTimeline';
import { usePointingTimelineStore } from './pointingTimelineStore';
import { LocalCaptureProvider, meetingSlideContext } from './connectors/capture/local';
import {
  capturePauseReason,
  capturePauseReasonFor,
  isCapturePaused,
  setCapturePausedBy,
} from './capture/captureGate';
import { buildTranscript } from './capture/transcript';
import {
  downloadTranscript,
  formatTranscriptDate,
  transcriptFilename,
  transcriptToText,
} from './capture/transcriptText';
import { attendeeNames } from './identity';
import type { ChatMessage } from '../types';
import type { GroundedCaptureContext } from './connectors/capture/types';

export type SummaryOutcome = { added: number } | { message: string };

/**
 * The recording that just stopped, for as long as its panel is up.
 *
 * `startedAt` is kept rather than re-read from the room's recording state because
 * that state moves on — the next recording overwrites it — and the transcript this
 * panel offers is the one whose live lines are stamped with THIS start. It is also
 * what makes the panel survive a second recording being started and stopped, which
 * is why starting one dismisses it instead.
 */
export interface RecordingStopped {
  startedAt: number;
  /** How long it ran, for the panel's heading ("Recording stopped · 12:34"). */
  elapsedMs: number;
}

/** Why nothing may be sent or stored right now, in the words the button shows. */
export const PRIVACY_BLOCK_REASON =
  'Privacy mode is on: what was said in this room is not sent or stored anywhere.';

export interface RecordingContextValue {
  state: 'idle' | 'recording' | 'unsupported';
  elapsedMs: number;
  outcome: SummaryOutcome | null;
  summarising: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Send the kept recording for card extraction.
   *
   * The same act the error row's Retry performs, and the same function behind it: a
   * retry is "generate the cards from that recording again", which is all the stop
   * panel's Generate cards is. Two names because the two buttons appear in two
   * situations and say different things about the same recording.
   */
  retry(): Promise<void>;
  liveLines: ChatMessage[];
  canRecord: boolean;
  /** The room's recording state (who started it, when). Null when idle. */
  recordingState: RecordingStatePayload | null;
  /** Why this client is or is not uploading its own mic. */
  ownMicStatus: OwnMicStatus;
  /** Stop sharing this client's mic. Does NOT stop the room recording. */
  stopSharingMic(): void;
  // ─── The stopped recording's three choices (batch BU) ───────────────────────
  /** The recording that just stopped, or null while none is waiting for a choice. */
  stopped: RecordingStopped | null;
  /** Dismiss the panel. The audio is kept; Retry still works from the error row. */
  dismissStopped(): void;
  /** Choice 1: extract cards from the kept recording. */
  generateCards(): Promise<void>;
  /** Choice 2: whether the transcript is stored on this meeting's session row. */
  keepTranscript: boolean;
  toggleKeepTranscript(): void;
  /** "…and where people were pointing at" — part of choice 2 and of choice 3. */
  includePointing: boolean;
  setIncludePointing(include: boolean): void;
  /** Choice 3: the transcript as a .txt on this machine. False when there is no DOM to save into. */
  downloadStoppedTranscript(): boolean;
  /** Why Generate cards and Save are both disabled, or null when neither is. */
  captureBlockReason: string | null;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function useRecordingContext(): RecordingContextValue | null {
  return useContext(RecordingContext);
}

/** Read the local user's display name from localStorage (same source as usePartyPresence). */
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

export const RecordingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { localStream, remoteStreams, isMicOn } = useWebRTCContext();
  const { localUserId, broadcastInsightCard, remoteParticipantList } = usePresence();
  const sessionHostId = useStore((s) => s.sessionHostId);
  const addInsightCard = useStore((s) => s.addInsightCard);
  const reviewConfig = useActiveReviewStore((s) => s.config);
  const agendaIdx = useActiveReviewStore((s) => s.agendaIdx);
  const captureProvider = useConnectorConfig().capture;
  const chatHistory = useStore((s) => s.chatHistory);
  const activeModelType = useStore((s) => s.activeModelType);
  const importedSceneTree = useStore((s) => s.importedSceneTree);
  const isPrivacyMode = useStore((s) => s.isPrivacyMode);

  // Sample the local user's pointing target at 2 Hz while recording.
  usePointingTimeline(localUserId);

  const isHost = sessionHostId === localUserId || sessionHostId === null;
  // Recording is offered unless the deployment asked for the MOCK capture
  // provider, and that is the only provider check left in the browser.
  //
  // It used to be `captureProvider === 'local'`: recording was shown only when
  // the config named capture-service, because that was the only backend that
  // could take a whole recording. Plan 14 batch BF moved the choice server-side
  // (lib/ai/router.ts), so a deployment on OpenAI, on an Azure resource, on a
  // company gateway or on its own webhook can all transcribe a recording now —
  // and a browser that still gated the UI on one config value would hide a
  // working feature from every one of them. Which AI answers is not this
  // component's business, and it no longer asks.
  // AND NOT ON A LINE NOBODY IS EXPLORING ANY MORE (docs/plan/15 batch BX). A dropped
  // variant's address keeps working, because a dropped variant is kept for the record
  // and the person who follows a three-week-old link should see it rather than be
  // bounced — but it is a record and not a meeting. A recording made in it would write
  // a tracker_sessions row onto a line the map draws greyed, number a session on a line
  // whose cards have already been closed with a reason, and put the resulting cards on
  // a line nobody will ever meet on again. The room server refuses its scene changes and
  // refuses to hand out its Edit lock for the same reason; this is the third door.
  const lineDropped = useStore((s) => s.activeLine?.status === 'dropped');
  const canRecord = isHost && captureProvider !== 'mock' && !lineDropped;

  const provider = useMemo(() => new LocalCaptureProvider(), []);

  // Subscribe to the room's recording state (broadcast by the host).
  const [recordingState, setRecordingState] = useState<RecordingStatePayload | null>(null);
  useEffect(() => {
    return subscribeRecordingState(setRecordingState);
  }, []);

  const isRecording = recordingState?.recording === true;
  const recordingStartMs = isRecording ? recordingState!.startedAt : 0;
  const [shownRecordingStart, setShownRecordingStart] = useState(0);

  // ─── Capture pauses while ANYBODY has the review's Edit on ─────────────────
  // Batch BH. Not "while I am editing": the curation conversation is the whole
  // room's, so a participant's microphone would still be transcribing "no, put
  // that slide after the pin" while the editor's own is quiet.
  const reviewEditing = useStore((s) => s.reviewEditing);
  const capturePaused = reviewEditing !== null;
  useEffect(() => {
    // The one writer of the gate, and it is here rather than in the component that
    // turns Edit on, because the pause has to happen on EVERY client — including
    // the ones that will never see the amber strip.
    setCapturePausedBy(reviewEditing ? (reviewEditing.name || 'somebody') : null);
  }, [reviewEditing]);

  // React to recording start/stop: update shownRecordingStart for the
  // liveLines filter, and reset when recording stops.
  useEffect(() => {
    if (isRecording && recordingStartMs > 0) {
      setShownRecordingStart(recordingStartMs);
    } else if (!isRecording) {
      setShownRecordingStart(0);
    }
  }, [isRecording, recordingStartMs]);

  const localName = useMemo(() => getLocalUserName(), []);

  const liveLines = useMemo(
    () =>
      shownRecordingStart > 0
        ? chatHistory
            .filter((m) => m.id.startsWith(`live-${shownRecordingStart}-`))
            .slice(-4)
        : [],
    [chatHistory, shownRecordingStart],
  );

  const { onLiveChunk, finish: finishLiveTranscript } = useLiveTranscript({
    provider,
    recordingStartMs,
    speakerId: localUserId,
    speakerName: localName,
  });

  // Per-client own-mic slicer. Runs on every client (host included) while
  // the room is recording. Feeds useLiveTranscript's onLiveChunk.
  //
  // `recording` is the gate for the live transcript: false stops the slicer, so no
  // chunk is produced, so nothing is transcribed and nothing is broadcast. Turning
  // the slicer off rather than dropping its output means the paused minutes are not
  // recorded-then-discarded either, which is what "capture is paused" has to mean
  // for a microphone that is still open.
  const { status: ownMicStatus, stopSharing: stopSharingMic } = useOwnMicTranscriber({
    recording: isRecording && !capturePaused,
    startedAtMs: recordingStartMs,
    localStream,
    isMicOn,
    onLiveChunk,
  });

  // Host-only mixed recorder for extraction. No onLiveChunk — the live
  // transcript comes from the per-speaker path now.
  const { state, start, stop } = useMeetingRecorder({
    localStream,
    remoteStreams,
  });

  const [summarising, setSummarising] = useState(false);
  const [outcome, setOutcome] = useState<SummaryOutcome | null>(null);
  const [recording, setRecording] = useState<Blob | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  // ─── The stopped recording, and the three things that can be done with it ─────
  // Batch BU. Stopping used to be one act with one consequence — the audio went
  // straight off for card extraction — and a person who only wanted the transcript
  // had no way to say so. `stopped` is what the panel is drawn from, and it is this
  // provider's state rather than the panel's because the provider is mounted once in
  // RoomPage while RecordingControls is rendered twice (the LIVE TRANSCRIPT tab and
  // the Manager Workspace): the two copies have to show the same pressed toggle.
  const [stopped, setStopped] = useState<RecordingStopped | null>(null);
  const [keepTranscript, setKeepTranscript] = useState(false);
  const [pointingIncluded, setPointingIncluded] = useState(false);

  // Why Generate cards and Save transcript are both disabled, in the words the
  // button shows. Computed from the values this render already has rather than from
  // the capture gate's module state, which an effect below writes and so still holds
  // the previous render's answer on the render where Edit turned on.
  const captureBlockReason = isPrivacyMode
    ? PRIVACY_BLOCK_REASON
    : reviewEditing
      ? capturePauseReasonFor(reviewEditing.name || null)
      : null;

  /** Who was in the room, for the transcript's heading. */
  const attendees = useMemo(
    () => attendeeNames(localName, remoteParticipantList ?? []),
    [localName, remoteParticipantList],
  );

  /** The review's name, for the transcript's heading and filename. */
  const transcriptTitle = reviewConfig?.title ?? null;

  useEffect(() => {
    if (state !== 'recording') return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  const summarise = useCallback(async (audio: Blob): Promise<void> => {
    // Privacy mode is a promise the room made that what is said in it does not
    // leave it, and pressing Generate cards is not a reason to break it — the audio
    // would go to whichever provider answers, with the transcript of a design
    // review that has not shipped in it. Checked here rather than on the button
    // alone because Retry reaches the same function, and because lib/capture/
    // meetingMinutes refuses on the same ground: two paths out of one room, one
    // rule about both.
    if (isPrivacyMode) {
      setOutcome({ message: PRIVACY_BLOCK_REASON });
      return;
    }
    // The extractor refuses to send while the review is being edited. Checked
    // here rather than left to the caller, because this is the one place audio
    // leaves the browser for card extraction and a gate anywhere else would be a
    // gate a future caller could walk past. The recording itself is kept — the
    // person who stopped it still gets their audio — but it is not sent to be
    // read, and they are told why instead of getting cards about the curation.
    if (isCapturePaused()) {
      setOutcome({ message: capturePauseReason() });
      return;
    }
    setSummarising(true);
    setOutcome(null);
    try {
      // Build the grounded context: component tree, pointing segments, and
      // the speaker-labelled live transcript. All three are optional — when
      // nothing is available the capture is exactly what it was before D.
      //
      // sceneComponents rather than flatten(getCurrentSceneTree(...)): a room with
      // no model in it has no parts to ground on, and that is decided in one place
      // rather than at each of the two readers (batch BI).
      const components = sceneComponents(activeModelType, importedSceneTree);

      const allSegments = usePointingTimelineStore.getState().segments;
      const pointingSegments = allSegments.map((seg) => ({
        userId: seg.userId,
        userName: seg.userName,
        partId: seg.partId,
        partName: seg.partName,
        fromMs: seg.fromMs,
        toMs: seg.toMs,
      }));

      const recordingStart = recordingState?.startedAt ?? 0;
      const transcriptHint = chatHistory
        .filter(
          (m) =>
            recordingStart > 0 &&
            m.id.startsWith(`live-${recordingStart}-`) &&
            typeof m.offsetMs === 'number' &&
            m.speakerId,
        )
        .map((m) => ({
          speaker: m.speakerName ?? m.speakerId ?? 'Unknown',
          text: m.text,
          offsetMs: m.offsetMs!,
        }));

      const grounded: GroundedCaptureContext = {
        componentTree: components,
        pointingSegments,
        transcriptHint,
      };

      const cards = await provider.captureRecording(
        audio,
        meetingSlideContext(reviewConfig, agendaIdx),
        { grounded },
      );
      for (const card of cards) {
        addInsightCard(card);
        // Send it to the room. Without this the cards from a real recording
        // existed only on the machine that recorded — the simulated agents
        // broadcast theirs, the real capture path never did (reported
        // 2026-09-23). Same message the simulation uses, so receivers need
        // no new handling.
        broadcastInsightCard(card);
      }
      setOutcome({ added: cards.length });
    } catch (err) {
      setOutcome({
        message: err instanceof Error ? err.message : 'The summary request failed.',
      });
    } finally {
      setSummarising(false);
    }
  }, [provider, reviewConfig, agendaIdx, addInsightCard, broadcastInsightCard, activeModelType, importedSceneTree, recordingState, chatHistory, isPrivacyMode]);

  const handleStart = useCallback(async (): Promise<void> => {
    setOutcome(null);
    // A new recording supersedes the one the panel is offering choices about, and
    // with it the choice already made: the transcript is selected by the recording's
    // own startedAt, so a "save it" pressed for the first recording would otherwise
    // be carried out on the second one's lines at meeting-end. Told to the room for
    // the same reason — whichever browser records the meeting must not act on a
    // choice about a recording that is no longer the latest.
    setStopped(null);
    setKeepTranscript(false);
    setPointingIncluded(false);
    broadcastTranscriptKeep({ keep: false, includePointing: false, byName: localName });
    const startedAt = Date.now();
    // Broadcast RECORDING_STATE first so every client (including self) starts
    // its own mic slicer in sync.
    broadcastRecordingState({
      recording: true,
      startedAt,
      byUserId: localUserId,
      byName: localName,
    });
    try {
      await start();
    } catch (err) {
      // Roll back the broadcast so clients stop their slicers.
      broadcastRecordingState({
        recording: false,
        startedAt: 0,
        byUserId: localUserId,
        byName: localName,
      });
      setOutcome({
        message: err instanceof Error ? err.message : 'Recording could not be started.',
      });
    }
  }, [start, localUserId, localName]);

  /**
   * Stop the recording and put its three choices on the screen.
   *
   * It does NOT extract cards, which is what it did before batch BU: "Stop &
   * summarise" made the decision for the person pressing it, and the decision is
   * worth more than the shortcut — an hour of design review sent to a model is a
   * cost, a transcript saved onto the review's session row is a record other people
   * will read, and a .txt on somebody's disk is neither. So stopping now stops,
   * keeps the audio in memory exactly as it did, and offers.
   *
   * `startedAt` is broadcast with the recording that just ran rather than as 0, and
   * that is a fix as much as a change: lib/recordingState.ts has always documented
   * that the start survives the stop, because it is the key this meeting's live lines
   * carry (`live-<startedAt>-…`) and the only way to pick them out of a room that
   * recorded twice. store.ts's endMeeting reads it — for the minutes, and now for the
   * transcript — and it read 0 for every meeting that was stopped before it ended.
   */
  const handleStop = useCallback(async (): Promise<void> => {
    const startedAt = recordingState?.startedAt ?? 0;
    const ranFor = elapsedMs;
    try {
      const audio = await stop();
      finishLiveTranscript();
      setRecording(audio);
      broadcastRecordingState({
        recording: false,
        startedAt,
        byUserId: localUserId,
        byName: localName,
      });
      setStopped({ startedAt, elapsedMs: ranFor });
    } catch (err) {
      finishLiveTranscript();
      broadcastRecordingState({
        recording: false,
        startedAt: 0,
        byUserId: localUserId,
        byName: localName,
      });
      setOutcome({
        message: err instanceof Error ? err.message : 'Recording could not be stopped.',
      });
    }
  }, [stop, finishLiveTranscript, localUserId, localName, recordingState, elapsedMs]);

  const handleRetry = useCallback(async (): Promise<void> => {
    if (recording !== null) {
      await summarise(recording);
    }
  }, [recording, summarise]);

  /**
   * Choice 2: store this meeting's transcript on its session row, or stop storing it.
   *
   * Sent to the room rather than kept here, because the browser that writes the row
   * is the one whose person ends the meeting and that is usually somebody else
   * (store.ts's endMeeting; one meeting is recorded once). The room server keeps the
   * latest answer and hands it to a client that arrives later, so the choice outlives
   * a reload of this page and a host change.
   */
  const handleToggleKeep = useCallback(() => {
    const next = !keepTranscript;
    setKeepTranscript(next);
    broadcastTranscriptKeep({ keep: next, includePointing: pointingIncluded, byName: localName });
  }, [keepTranscript, pointingIncluded, localName]);

  /**
   * "…and where people were pointing at". One checkbox for both of the choices that
   * can carry it, because they are the same question about the same meeting and two
   * checkboxes would be two answers that could disagree — a .txt with the pointing in
   * it and a stored transcript without. Re-sent to the room whenever the transcript is
   * being kept, since what gets stored is decided at meeting-end and not now.
   */
  const handleSetIncludePointing = useCallback((include: boolean) => {
    setPointingIncluded(include);
    if (keepTranscript) {
      broadcastTranscriptKeep({ keep: true, includePointing: include, byName: localName });
    }
  }, [keepTranscript, localName]);

  /**
   * Choice 3: the transcript as a .txt on this machine.
   *
   * Built at click time from the room's own two sources — the live lines in
   * chatHistory and the pointing timeline — rather than held in state, so a line that
   * arrived between Stop and the click is in the file. Nothing leaves the browser and
   * no gate applies: this is the person who recorded the meeting saving what they can
   * already read on their own screen.
   */
  const handleDownloadTranscript = useCallback((): boolean => {
    if (stopped === null) return false;
    const date = formatTranscriptDate(new Date());
    const rows = buildTranscript({
      chatHistory,
      recordingStart: stopped.startedAt,
      segments: usePointingTimelineStore.getState().segments,
      includePointing: pointingIncluded,
    });
    return downloadTranscript(
      transcriptToText(rows, {
        includePointing: pointingIncluded,
        title: transcriptTitle,
        date,
        attendees,
      }),
      transcriptFilename(transcriptTitle, date),
    );
  }, [stopped, chatHistory, pointingIncluded, transcriptTitle, attendees]);

  const dismissStopped = useCallback(() => setStopped(null), []);

  const value = useMemo<RecordingContextValue>(
    () => ({
      state,
      elapsedMs,
      outcome,
      summarising,
      start: handleStart,
      stop: handleStop,
      retry: handleRetry,
      liveLines,
      canRecord,
      recordingState,
      ownMicStatus,
      stopSharingMic,
      stopped,
      dismissStopped,
      generateCards: handleRetry,
      keepTranscript,
      toggleKeepTranscript: handleToggleKeep,
      includePointing: pointingIncluded,
      setIncludePointing: handleSetIncludePointing,
      downloadStoppedTranscript: handleDownloadTranscript,
      captureBlockReason,
    }),
    [state, elapsedMs, outcome, summarising, handleStart, handleStop, handleRetry, liveLines, canRecord, recordingState, ownMicStatus, stopSharingMic, stopped, dismissStopped, keepTranscript, handleToggleKeep, pointingIncluded, handleSetIncludePointing, handleDownloadTranscript, captureBlockReason],
  );

  return (
    <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>
  );
};
