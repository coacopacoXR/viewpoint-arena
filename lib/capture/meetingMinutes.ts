// The minutes of a meeting, asked for once, after it ended.
//
// docs/plan/15-sessions-and-variants.md batch BM. api/capture/summary.ts (plan 14,
// batch BF) has turned a transcript and its cards into markdown since it was
// written and nothing in the app ever called it, so the session map's panel had a
// slot for a summary that could not be filled and said "No summary was stored for
// this session" for every meeting ever held. This is the caller: one request per
// meeting, made by the one browser that recorded it, after the session row exists,
// and the answer is written onto that row.
//
// WHY IT IS ONE BROWSER: store.ts's endMeeting only flushes for the person who
// pressed End (see meetingEndedRemotely). Three people in a room would otherwise
// ask for the same minutes three times — three AI jobs on the same transcript, and
// three writes to a row only one of which should exist.
//
// WHY IT NEVER BLOCKS: the request is one whole-meeting AI job, which is seconds of
// work and can fail. Neither the meeting ending nor the tracker write — the record
// — may wait on prose. A failure leaves `summary` NULL and the panel says so.
//
// ── SECURITY ──────────────────────────────────────────────────────────────────
// The body of this request is what a company's engineers said about a design that
// has not shipped, which is why api/capture/summary.ts's header allows a failure to
// carry a code from lib/ai/router.ts's vocabulary and nothing else. The same rule
// applies to what is LOGGED here: `console.warn` gets the code, never the
// transcript, never a card and never the model's answer. The answer itself is
// written to the meeting's own row and rendered as text, which is the point of the
// request, and goes nowhere else.

import { supabase } from '../supabase';
import type { ChatMessage, InsightCard } from '../../types';
import type { TranscriptChunk } from '../connectors/capture/types';
import { isCapturePaused } from './captureGate';
import { getRecordingState } from '../recordingState';

export const SUMMARY_ENDPOINT = '/api/capture/summary';

// The endpoint's own caps (api/capture/summary.ts), mirrored rather than imported:
// that file is a serverless function and this is browser code, and importing across
// the boundary would pull the AI router into the bundle. Overshooting one of them
// is a 413 with a code, so these only ever save a round trip.
const MAX_TITLE_CHARS = 200;
const MAX_CARDS = 500;

type FetchFn = typeof globalThis.fetch;

/** Either the minutes, or the code that says why there are none. Never both. */
type SummaryAnswer = { summary: string } | { code: string };

/**
 * This recording's live transcript, in the shape the summary endpoint takes.
 *
 * The SAME selection lib/RecordingContext.tsx makes for its `transcriptHint` —
 * the lines stamped `live-<startedAt>-…`, with an offset and a server-stamped
 * speaker — so the minutes are written from the transcript the extractor saw and
 * not from a wider or narrower one. `recordingStart <= 0` answers nothing, which
 * is RecordingContext's own first condition: a room that never recorded has chat
 * messages and no transcript, and its minutes come from its cards alone.
 *
 * `speakerId` carries the speaker's NAME when the line has one. The endpoint
 * validates it as a non-empty string and lib/ai/summaryPrompt.ts prints it as the
 * speaker's label, and minutes that attribute a decision to "user-8f3a" are minutes
 * nobody can act on. The filter still requires the server-stamped `speakerId`, so
 * the attribution is one the room server wrote and not one a client invented.
 *
 * `startMs` and `endMs` are the line's own offset: the live transcript has a start
 * per line and no duration, and a zero-length chunk still puts the line in the
 * right place in the meeting.
 */
export function liveTranscriptChunks(
  chatHistory: readonly ChatMessage[],
  recordingStart: number,
): TranscriptChunk[] {
  if (!(recordingStart > 0)) return [];
  const prefix = `live-${recordingStart}-`;
  const chunks: TranscriptChunk[] = [];
  for (const message of chatHistory) {
    if (!message.id.startsWith(prefix)) continue;
    if (typeof message.offsetMs !== 'number' || !message.speakerId) continue;
    const text = (message.text ?? '').trim();
    if (text === '') continue;
    const offsetMs = Math.max(0, Math.round(message.offsetMs));
    chunks.push({
      speakerId: (message.speakerName ?? '').trim() || message.speakerId,
      text,
      startMs: offsetMs,
      endMs: offsetMs,
    });
  }
  return chunks;
}

/**
 * Post the meeting to the summary endpoint. Answers a code rather than throwing,
 * because the only thing a caller may do with a failure is log the code.
 *
 * The content-type check is the one lib/reviews/linesClient.ts and the other
 * capture clients make: under `vite preview` — which is what the Playwright suite
 * serves — every `/api/*` route answers 200 with index.html, and reading that as
 * JSON throws a SyntaxError with nothing in it that points at the real cause.
 */
async function requestSummary(
  body: { transcript: TranscriptChunk[]; cards: SummaryCard[]; title?: string },
  fetchFn?: FetchFn,
): Promise<SummaryAnswer> {
  const doFetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await doFetch(SUMMARY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch's own message is dropped: it embeds the URL and the request body.
    return { code: 'network' };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return { code: 'endpoint_unavailable' };

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = payload?.error;
    return { code: typeof code === 'string' && code !== '' ? code : `http_${response.status}` };
  }

  const summary = typeof payload?.summary === 'string' ? payload.summary.trim() : '';
  // A 200 with nothing in it is not minutes. Leaving the row NULL says "no summary
  // was stored" honestly; writing an empty string would say "a summary was stored
  // and it was blank".
  if (summary === '') return { code: 'empty_summary' };
  return { summary };
}

export interface MeetingMinutesRequest {
  /** The tracker_sessions row the minutes belong on. */
  sessionId: string;
  /** The room's chat history, from which the live transcript is selected. */
  chatHistory: readonly ChatMessage[];
  /** The cards this meeting produced — the store's own, already validated. */
  cards: readonly InsightCard[];
  /** The design review's name, for the minutes' heading. */
  title?: string | null;
  /** Whether the room is in privacy mode. */
  privacyMode?: boolean;
  /** Overrides the room's recording state. Tests, and nothing else. */
  recordingStart?: number;
  /** Override for tests, or a deployment that mounts the function elsewhere. */
  fetchFn?: FetchFn;
}

/**
 * A card as api/capture/summary.ts will accept it.
 *
 * That endpoint validates cards with the extraction parser, which requires a
 * non-empty description and a non-empty agentId when one is present. A card made
 * with + Card has an empty agentId and often no description, and one such card
 * made the whole request fail (found live, batch BM), so the meeting got no
 * minutes. The title stands in for a missing description, and a blank agentId is
 * left out, which the parser answers with its own default.
 */
export type SummaryCard = Omit<InsightCard, 'agentId'> & { agentId?: string };

export function cardForSummary(card: InsightCard): SummaryCard {
  const description = card.description.trim() === '' ? card.title : card.description;
  const { agentId, ...rest } = card;
  return agentId.trim() === '' ? { ...rest, description } : { ...card, description };
}

const CARD_SECTIONS: readonly { type: InsightCard['type']; heading: string }[] = [
  { type: 'RISK', heading: 'Risks raised' },
  { type: 'RATIONALE', heading: 'Decisions and rationale' },
  { type: 'ACTION', heading: 'Actions' },
];

/**
 * The minutes of a meeting that was not recorded: its cards, by section, in the
 * words they were written in. Only what a card says — owner and date appear when
 * the card has them and are never supplied.
 */
export function minutesFromCards(cards: readonly InsightCard[]): string {
  const parts: string[] = ['No transcript was recorded; these minutes list the cards the meeting raised.'];
  for (const { type, heading } of CARD_SECTIONS) {
    const ofType = cards.filter((card) => card.type === type);
    if (ofType.length === 0) continue;
    const lines = ofType.map((card) => {
      const description = card.description.trim();
      const extras = [
        card.details.priority,
        card.details.assignee?.trim() || null,
        card.details.dueDate?.trim() ? `by ${card.details.dueDate.trim()}` : null,
      ].filter((x): x is string => typeof x === 'string' && x !== '');
      const box = type === 'ACTION' ? '[ ] ' : '';
      const body = description !== '' && description !== card.title ? `${card.title}: ${description}` : card.title;
      return `- ${box}${body}${extras.length > 0 ? ` (${extras.join('; ')})` : ''}`;
    });
    parts.push(`## ${heading}\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * Ask for this meeting's minutes and store them on its session row.
 *
 * Never throws and never rejects: it runs in the background behind a meeting that
 * has already ended, and the person who pressed End is not there to be told
 * anything. The answer is the markdown that was stored, or null when nothing was —
 * skipped, refused, or failed — which is exactly what the session panel shows as
 * "No summary was stored for this session."
 *
 * NOTHING IS SENT when the meeting has neither a transcript nor a card (there is
 * nothing to summarise and the endpoint answers 400 `empty_summary_input`), when
 * the room is in privacy mode, or when capture is paused.
 *
 * Privacy mode is checked here rather than left to the caller because it is a
 * promise the room made that what is said in it does not leave it, and a meeting
 * ending is not a reason to break it — the request would otherwise go out from a
 * store action with nobody looking at it. Capture is paused for the reason
 * lib/capture/captureGate.ts gives: while somebody is curating the review, the
 * conversation is about the curation, and minutes of that are minutes of the wrong
 * meeting.
 */
export async function writeMeetingMinutes(opts: MeetingMinutesRequest): Promise<string | null> {
  const { sessionId } = opts;
  if (!sessionId) return null;
  if (opts.privacyMode === true) return null;
  if (isCapturePaused()) return null;

  const recordingStart = opts.recordingStart ?? getRecordingState()?.startedAt ?? 0;
  const transcript = liveTranscriptChunks(opts.chatHistory, recordingStart);
  const cards = opts.cards.slice(0, MAX_CARDS).map(cardForSummary);
  if (transcript.length === 0 && cards.length === 0) return null;

  // No transcript: the minutes are the cards, written out here, and no model is
  // asked. Found live (batch BM): given one card and nothing said, the built-in
  // 7B model wrote two decisions, a deadline and two people ("John", "Sarah")
  // that were never in the meeting. A list of what was raised cannot invent.
  let answer: { summary: string } | { code: string };
  if (transcript.length === 0) {
    answer = { summary: minutesFromCards(opts.cards.slice(0, MAX_CARDS)) };
  } else {
    const title = (opts.title ?? '').trim().slice(0, MAX_TITLE_CHARS);
    answer = await requestSummary(
      { transcript, cards, ...(title === '' ? {} : { title }) },
      opts.fetchFn,
    );
  }
  if ('code' in answer) {
    // The code and nothing else. See the security header.
    console.warn(`[minutes] the summary request failed: ${answer.code}`);
    return null;
  }

  try {
    const { error } = await supabase
      .from('tracker_sessions')
      .update({ summary: answer.summary })
      .eq('id', sessionId);
    if (error) {
      // 42703 on an install whose database has not had docs/supabase-schema.sql
      // re-applied since this batch: the minutes exist and there is nowhere to put
      // them. The meeting is still recorded, which is the part that matters.
      console.warn(`[minutes] the summary was not stored: ${error.code || error.message}`);
      return null;
    }
    return answer.summary;
  } catch {
    console.warn('[minutes] the summary was not stored: database_unreachable');
    return null;
  }
}
