// The webhook contract — "your own service" as an AI provider (plan 14, BF).
//
// An enterprise that already runs its own AI should not have to make it pretend
// to be OpenAI. So there is a third shape: we POST our JSON, it answers with
// ours. This module is the whole contract — the request bodies we send, the
// response bodies we accept, and the validation that turns "their server said
// something" into either a usable value or a content-free reason.
//
// api/ai/WEBHOOK.md is the same contract written for the team implementing the
// other end, with request and response examples. Keep the two together: that
// file is documentation of THIS module, not a second source of truth.
//
// THREE RULES, all of them about what a response may carry:
//
//   1. Cards are validated with `validateExtractionPayload` — the same strict
//      parser the cloud path and the browser both use, which rejects unknown
//      keys, a missing priority and a component id that was invented. A webhook
//      gets no laxer schema than OpenAI does, because the cards land in the same
//      tracker either way.
//   2. A response body is NEVER echoed. Not in an error, not in a log. It is
//      model output over a transcript, which is the meeting; the reason a
//      failure reports is an enum from our own vocabulary.
//   3. Segments are numbers and a string, nothing else. A webhook that answers
//      transcription with speaker names, sentiment or a confidence map gets
//      those fields dropped rather than an error, because the app has nowhere to
//      put them and refusing the transcript over a field it would ignore is the
//      worse failure.

import type { InsightCard } from '../../types';
import type {
  ComponentTreeEntry,
  SlideContext,
  TranscriptChunk,
} from '../connectors/capture/types';
import {
  CaptureExtractionError,
  validateExtractionPayload,
} from '../connectors/capture/parseInsightCards';

/** The multipart field name the transcription request uses. */
export const WEBHOOK_AUDIO_FIELD = 'audio';

/**
 * The `job` discriminator we send.
 *
 * One URL can serve all three jobs — the field tells the receiving service which
 * of the three shapes arrived — and a service that only implements cards can
 * answer the other two with a 501 and be configured for cards alone here.
 */
export type WebhookJob = 'transcription' | 'cards' | 'summary';

// ─── Requests ───────────────────────────────────────────────────────────────

/**
 * The spatial context a cards request carries.
 *
 * Both fields optional: a webhook that ignores the 3D context still gets a
 * well-formed request, and one that uses it can attribute a card to the part
 * that was on screen. `components` is the flattened model tree, and its `id`s
 * are the only values a card's `componentReference` may take.
 */
export interface WebhookCardsContext {
  slide?: SlideContext;
  components?: ComponentTreeEntry[];
}

export interface WebhookCardsRequest {
  job: 'cards';
  transcript: TranscriptChunk[];
  context: WebhookCardsContext;
}

export interface WebhookSummaryRequest {
  job: 'summary';
  transcript: TranscriptChunk[];
  /** The cards the app already extracted, so a summary can be consistent with them. */
  cards: InsightCard[];
  /** The review's own name, when it has one. Optional. */
  title?: string;
}

export function buildWebhookCardsRequest(
  transcript: TranscriptChunk[],
  context: WebhookCardsContext,
): WebhookCardsRequest {
  const built: WebhookCardsRequest = { job: 'cards', transcript, context: {} };
  if (context.slide) built.context.slide = context.slide;
  // An empty component list is omitted rather than sent as []: "there is no
  // model tree" and "here is an empty tree" should not be two cases for the
  // receiving service to distinguish.
  if (context.components && context.components.length > 0) {
    built.context.components = context.components;
  }
  return built;
}

export function buildWebhookSummaryRequest(
  transcript: TranscriptChunk[],
  cards: InsightCard[],
  title?: string,
): WebhookSummaryRequest {
  const request: WebhookSummaryRequest = { job: 'summary', transcript, cards };
  const trimmed = title?.trim();
  if (trimmed) request.title = trimmed;
  return request;
}

// ─── Responses ──────────────────────────────────────────────────────────────

/**
 * One recognised span of audio.
 *
 * `start` and `end` are SECONDS from the start of the recording, as floats —
 * the unit every transcription API the app can be pointed at already uses
 * (OpenAI's verbose_json, WhisperX, faster-whisper). The app converts to its own
 * milliseconds internally; a webhook never has to know that.
 */
export interface WebhookSegment {
  start: number;
  end: number;
  text: string;
}

/**
 * Why a response was refused, from our own closed vocabulary.
 *
 * Deliberately NOT the receiving service's error text: that text can quote the
 * request, which contains the transcript. These reasons are safe to put in a
 * server log and safe to name in an admin screen's "Test connection" result.
 */
export type WebhookFailureReason =
  /** Not JSON, or JSON that was not an object. */
  | 'not_json'
  /** The `cards` envelope was missing or wrongly shaped. */
  | 'bad_cards'
  /** A card failed the strict parser (its own reason is carried separately). */
  | 'invalid_card'
  /** `summary` was missing or not a string. */
  | 'bad_summary'
  /** `segments` was missing, or a segment was not a number/string triple. */
  | 'bad_segments';

/**
 * The outcome of validating a response.
 *
 * A flat shape with a nullable `value` rather than an `{ ok: true } | { ok: false }`
 * union, and that is not a stylistic preference: this project compiles WITHOUT
 * `strict`, and a boolean-literal discriminant on a generic alias does not narrow
 * there. Callers would have to cast, and a cast in the one module whose job is
 * refusing untrusted bytes is exactly the wrong place for one.
 *
 * `value === null` means refused, and `reason` says why.
 */
export interface WebhookParseResult<T> {
  value: T | null;
  reason: WebhookFailureReason | null;
  /** The strict parser's own classification, when the refusal came from it. */
  detail?: string;
}

function accepted<T>(value: T): WebhookParseResult<T> {
  return { value, reason: null };
}

function refused<T>(
  reason: WebhookFailureReason,
  detail?: string,
): WebhookParseResult<T> {
  return { value: null, reason, detail };
}

/**
 * Validate a cards response.
 *
 * Delegates to the same strict parser the cloud path uses, so a webhook cannot
 * sneak a card into the tracker that OpenAI would not have been allowed to
 * produce. `defaultAgentId` is the first speaker in the window, exactly as
 * api/capture/extract.ts passes it.
 */
export function parseWebhookCardsResponse(
  payload: unknown,
  options: { defaultAgentId?: string } = {},
): WebhookParseResult<InsightCard[]> {
  if (!isRecord(payload)) return refused('not_json');
  try {
    return accepted(validateExtractionPayload(payload, options));
  } catch (err) {
    // The parser's message quotes the payload, which quotes the transcript. Only
    // its `reason` enum is carried out, and only as far as a log line.
    const reason = err instanceof CaptureExtractionError ? err.reason : undefined;
    // A wrong envelope is the receiving service's shape mistake; anything else is
    // a card that failed validation. The distinction matters to whoever is
    // debugging their own endpoint. An unexpected throw has no reason at all and
    // is reported as a bad envelope rather than propagated: an unhandled
    // exception would surface as a 500 whose stack quotes the response.
    return refused(
      reason === undefined || reason === 'wrong_envelope' || reason === 'extra_fields'
        ? 'bad_cards'
        : 'invalid_card',
      reason,
    );
  }
}

/** Validate a summary response: `{ summary: "<markdown>" }`. */
export function parseWebhookSummaryResponse(payload: unknown): WebhookParseResult<string> {
  if (!isRecord(payload)) return refused('not_json');
  const summary = payload.summary;
  if (typeof summary !== 'string') return refused('bad_summary');
  const trimmed = summary.trim();
  // An empty answer is a failure, not a summary: the admin's "Test connection"
  // has to be able to tell "it worked and said nothing" from "it worked".
  if (trimmed === '') return refused('bad_summary');
  return accepted(trimmed);
}

/**
 * Validate a transcription response: `{ segments: [{ start, end, text }] }`.
 *
 * A segment whose `end` precedes its `start` is corrected rather than refused — a
 * zero-length or inverted span is a rounding artefact in most ASR stacks, and
 * dropping the words to make a point about arithmetic would lose transcript.
 */
export function parseWebhookSegmentsResponse(
  payload: unknown,
): WebhookParseResult<WebhookSegment[]> {
  if (!isRecord(payload)) return refused('not_json');
  const raw = payload.segments;
  if (!Array.isArray(raw)) return refused('bad_segments');

  const segments: WebhookSegment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return refused('bad_segments');
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    const start = toFiniteNumber(entry.start);
    const end = toFiniteNumber(entry.end);
    // A silent stretch of a meeting produces no segments at all in most stacks,
    // and some produce one with empty text. Neither is an error and neither is
    // worth a line of transcript.
    if (text === '') continue;
    if (start === null || end === null) return refused('bad_segments');
    segments.push({ start, end: Math.max(end, start), text });
  }
  return accepted(segments);
}

/**
 * Segments to the app's own transcript shape.
 *
 * One speaker id for the whole recording, because that is all a transcription
 * API gives us: diarization is a separate capability and nothing downstream
 * pretends otherwise. The id matches capture-service's DEFAULT_SPEAKER_ID so a
 * meeting transcribed by the built-in stack and one transcribed by a webhook
 * attribute their cards identically.
 */
export const WEBHOOK_DEFAULT_SPEAKER_ID = 'speaker-1';

export function segmentsToTranscript(segments: WebhookSegment[]): TranscriptChunk[] {
  return segments.map((segment) => ({
    speakerId: WEBHOOK_DEFAULT_SPEAKER_ID,
    text: segment.text,
    startMs: Math.max(0, Math.round(segment.start * 1000)),
    endMs: Math.max(0, Math.round(segment.end * 1000)),
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  // A string number is accepted because plenty of gateways serialise floats as
  // strings, and refusing a perfectly good transcript over JSON quoting is the
  // worse failure.
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
