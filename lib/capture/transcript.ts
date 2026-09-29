// The transcript a meeting leaves behind, built once and stored as rows.
//
// docs/plan/15-sessions-and-variants.md batch BU. Two callers need the same array
// — the person who stopped the recording (a .txt now) and the browser that records
// the meeting (tracker_sessions.transcript, so the session map can offer the same
// .txt weeks later) — and both need it built the same way, from the same two
// sources: this recording's live transcript lines in the store's chatHistory, and
// the room's pointing timeline. So it is one function.
//
// THE SOURCES ARE ALREADY THE ROOM'S, not this browser's. Live lines reach every
// client through TRANSCRIPT_LINE and pointing segments through POINTING_SEGMENT, so
// the browser that happens to RECORD the meeting holds the same transcript as the
// one that recorded the audio. That is what makes it safe for the choice to be made
// by one person and carried out by another — see lib/transcriptKeep.ts.
//
// THE CAP IS A PROMISE ABOUT THE ROW, not about the meeting: 20 000 entries and
// 2 MB of JSON, because tracker_sessions.transcript is a jsonb column that the
// session map's panel and the lobby's preview both read, and a column that can grow
// without bound is a table that eventually cannot be listed. A transcript that hits
// it keeps its first part and says so.

import { liveTranscriptChunks } from './meetingMinutes';
import type { PointingSegment } from '../pointingTimelineStore';
import type { ChatMessage } from '../../types';
import type { TranscriptLine, TranscriptPointing, TranscriptRow } from './transcriptText';

/** Entries in one stored transcript. */
export const MAX_TRANSCRIPT_ENTRIES = 20000;

/** Bytes of JSON in one stored transcript, measured as the array serialises. */
export const MAX_TRANSCRIPT_BYTES = 2_000_000;

/**
 * How far apart two pointing spans may be and still count as one.
 *
 * The timeline is sampled at 2 Hz (lib/usePointingTimeline), so a laser that leaves
 * a part and comes back inside three samples is a hand that moved, not a second
 * decision to point at the same part. Merging those is what keeps eleven seconds of
 * "look at the hinge pin" one line in the .txt instead of twenty-two.
 */
const POINTING_MERGE_GAP_MS = 1500;

const TRUNCATION_MARKER = '{"truncated":true}';

/**
 * The marker is one of the entries the cap allows, so the lines stop one short of
 * it: the promise is "20 000 entries in the column", and an array of 20 000 lines
 * with a marker after them is 20 001.
 */
const MARKER_ROWS = 1;

export interface BuildTranscriptOptions {
  /** The room's chat history, from which this recording's live lines are selected. */
  chatHistory: readonly ChatMessage[];
  /** RECORDING_STATE.startedAt — the key the live lines carry. 0 selects nothing. */
  recordingStart: number;
  /** The room's pointing timeline. Read only when `includePointing`. */
  segments?: readonly PointingSegment[];
  /** Whether "where people were pointing at" was asked for. Off by default. */
  includePointing?: boolean;
}

/**
 * One span per person per part, in time order, consecutive spans merged.
 *
 * A span keeps the LAST name the room called its part, for the reason
 * store.ts's pointedAtPartNames gives: a part renamed by a second model importing
 * over the first is recorded as the room last called it. Segments with no part name
 * or no person on them are dropped — there is nothing to print, and a line reading
 * "(pointing at: )" is a line that looks like a bug.
 */
export function mergedPointing(segments: readonly PointingSegment[]): TranscriptPointing[] {
  const ordered = [...segments].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
  const spans: TranscriptPointing[] = [];
  // The most recent span per person and part, which is the one "consecutive" is
  // judged against: the list is in time order, so anything earlier is not adjacent.
  const latest = new Map<string, TranscriptPointing>();

  for (const segment of ordered) {
    const partName = (segment.partName ?? '').trim();
    const speaker = (segment.userName ?? '').trim();
    if (partName === '' || speaker === '') continue;
    const untilMs = Math.max(segment.toMs, segment.fromMs);
    const key = `${segment.userId}|${segment.partId}`;
    const previous = latest.get(key);
    if (previous && segment.fromMs - previous.untilMs <= POINTING_MERGE_GAP_MS) {
      previous.untilMs = Math.max(previous.untilMs, untilMs);
      previous.pointing = partName;
      continue;
    }
    const span: TranscriptPointing = { t: segment.fromMs, speaker, pointing: partName, untilMs };
    latest.set(key, span);
    spans.push(span);
  }
  return spans;
}

/**
 * This meeting's transcript, capped, in the order it happened.
 *
 * Speech is selected by the SAME rule the minutes and the extractor use
 * (lib/capture/meetingMinutes.liveTranscriptChunks), so the .txt a person downloads
 * is the transcript the cards were read from and not a wider or narrower one. That
 * rule answers nothing when `recordingStart` is 0 — a room that never recorded has
 * chat messages and no transcript.
 *
 * Speech sorts before pointing at the same millisecond, which is what puts
 * "(Olga pointing at: Hinge pin…)" under the line it belongs to rather than above
 * it. Array.prototype.sort is stable, so rows that compare equal keep the order
 * they were built in.
 */
export function buildTranscript(options: BuildTranscriptOptions): TranscriptRow[] {
  const lines: TranscriptLine[] = [];
  for (const chunk of liveTranscriptChunks(options.chatHistory, options.recordingStart)) {
    lines.push({ t: chunk.startMs, speaker: chunk.speakerId, text: chunk.text });
  }
  if (options.includePointing === true) {
    lines.push(...mergedPointing(options.segments ?? []));
  }
  lines.sort((a, b) => a.t - b.t || rankOf(a) - rankOf(b));
  return capped(lines);
}

function rankOf(line: TranscriptLine): number {
  return 'text' in line ? 0 : 1;
}

/**
 * The first part of a transcript that fits the cap, plus the marker that says it
 * was cut.
 *
 * Measured as the array would serialise — brackets and commas included — rather
 * than re-stringifying the whole array per entry, because the array this is asked
 * about can be twenty thousand entries long and an O(n²) measurement of it runs at
 * exactly the moment a meeting ends. The marker's own bytes are reserved up front,
 * so a transcript at the cap still says it was truncated instead of pushing the
 * marker over it.
 */
function capped(lines: readonly TranscriptLine[]): TranscriptRow[] {
  const encoder = new TextEncoder();
  const markerCost = encoder.encode(TRUNCATION_MARKER).length + 1;
  const kept: TranscriptRow[] = [];
  // The two bytes of the empty array's brackets; each entry then adds its own JSON
  // plus the comma before it.
  let bytes = 2;
  let truncated = false;

  for (const line of lines) {
    const cost = encoder.encode(JSON.stringify(line)).length + (kept.length > 0 ? 1 : 0);
    if (
      kept.length >= MAX_TRANSCRIPT_ENTRIES - MARKER_ROWS ||
      bytes + cost + markerCost > MAX_TRANSCRIPT_BYTES
    ) {
      truncated = true;
      break;
    }
    kept.push(line);
    bytes += cost;
  }

  if (truncated) kept.push({ truncated: true });
  return kept;
}
