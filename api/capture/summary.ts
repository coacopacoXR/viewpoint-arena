import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { InsightCard } from '../../types.ts';
import type { TranscriptChunk } from '../../lib/connectors/capture/types.ts';
import { validateExtractionPayload } from '../../lib/connectors/capture/parseInsightCards.ts';
import { runJob } from '../../lib/ai/router.ts';
import {
  enforceCaptureAccess,
  parseTranscriptChunk,
  sendJobError,
} from './_request.ts';

/**
 * POST /api/capture/summary — a transcript and its cards in, meeting minutes out.
 *
 * The third AI job (plan 14, batch BF). Before this endpoint existed there was no
 * summary at all: components/UI/MeetingSummary.tsx builds its four views by
 * FILTERING cards and chat messages, and RecordingContext's "summarise" step is
 * really an extraction that adds cards to the tracker. Nothing ever wrote the
 * minutes of a meeting, which is the one artefact a person who was not in the room
 * actually wants.
 *
 * The answer is markdown and is returned as `{ summary }`. It is not stored and
 * not broadcast: whoever asked for it renders it. That keeps a meeting's minutes
 * out of the room socket, which is the same reasoning that keeps a recording off
 * it.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * The same four rules api/capture/extract.ts's header states, and for the same
 * reason: the request body is what a company's engineers said about a design that
 * has not shipped. A failure is a code from lib/ai/router.ts's vocabulary and
 * nothing else. The markdown this endpoint returns IS model output, and that is
 * the point of the endpoint — but it goes to the caller that supplied the
 * transcript, in a 200, and never into an error body or a log line.
 */

// ── Budget ──────────────────────────────────────────────────────────────────
//
// Wider than the extraction budget on purpose. Extraction runs on a WINDOW of a
// meeting and has to stay inside a small model's context; a summary runs once, on
// the whole meeting, and a provider chosen for the summary job is chosen knowing
// that. Still bounded, because an unbounded prompt is an unbounded bill and an
// unbounded wait.

/** Hard cap on transcript chunks in one summary. */
const MAX_CHUNKS = 4000;

/** Hard cap on total transcript characters. */
const MAX_TRANSCRIPT_CHARS = 400_000;

/**
 * Hard cap on cards.
 *
 * A meeting that produced more insights than this has bigger problems than its
 * minutes, and the prompt would spend its whole budget listing them.
 */
const MAX_CARDS = 500;

/** Hard cap on the review's own name. A title, not a document. */
const MAX_TITLE_CHARS = 200;

/** Hard cap on the markdown we hand back. Guards a runaway model, not a normal one. */
const MAX_SUMMARY_CHARS = 40_000;

interface SummaryRequestBody {
  transcript?: unknown;
  cards?: unknown;
  title?: unknown;
  /** Accepted and ignored, as in extract.ts: the server picks the provider. */
  provider?: unknown;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!enforceCaptureAccess(req, res)) return;

  const body = (req.body ?? {}) as SummaryRequestBody;

  // ── Transcript: optional, but bounded when present ─────────────────────────
  //
  // A summary can be written from cards alone, which is what makes this endpoint
  // usable for a curated review that was never recorded. An absent transcript is
  // therefore valid; a malformed one is not.
  const transcript: TranscriptChunk[] = [];
  if (body.transcript !== undefined && body.transcript !== null) {
    if (!Array.isArray(body.transcript)) {
      res.status(400).json({ error: 'invalid_body', fields: ['transcript'] });
      return;
    }
    if (body.transcript.length > MAX_CHUNKS) {
      res.status(413).json({ error: 'transcript_too_large', maxChunks: MAX_CHUNKS });
      return;
    }
    for (const raw of body.transcript) {
      const chunk = parseTranscriptChunk(raw);
      if (chunk === null) {
        res.status(400).json({ error: 'invalid_body', fields: ['transcript'] });
        return;
      }
      transcript.push(chunk);
    }
    const totalChars = transcript.reduce((sum, c) => sum + c.text.length, 0);
    if (totalChars > MAX_TRANSCRIPT_CHARS) {
      res.status(413).json({
        error: 'transcript_too_large',
        maxChars: MAX_TRANSCRIPT_CHARS,
      });
      return;
    }
  }

  // ── Cards ──────────────────────────────────────────────────────────────────
  //
  // Validated with the SAME strict parser the extraction path uses, because these
  // cards came from a browser and are about to be pasted into a prompt. A card
  // with an invented componentReference or a priority nobody chose would otherwise
  // be laundered through the summary into prose that reads as if the meeting said
  // it. The parser's message quotes the payload, so only its `reason` survives —
  // sendJobError sees to that.
  let cards: InsightCard[] = [];
  if (body.cards !== undefined && body.cards !== null) {
    if (!Array.isArray(body.cards)) {
      res.status(400).json({ error: 'invalid_body', fields: ['cards'] });
      return;
    }
    if (body.cards.length > MAX_CARDS) {
      res.status(413).json({ error: 'invalid_body', fields: ['cards'], maxCards: MAX_CARDS });
      return;
    }
    try {
      cards = validateExtractionPayload({ cards: body.cards });
    } catch (err) {
      sendJobError(res, err, 'summary');
      return;
    }
  }

  if (transcript.length === 0 && cards.length === 0) {
    // Nothing to summarise. A 400 rather than an empty document: an operator who
    // wired this up wrong should see that, not a blank panel.
    res.status(400).json({ error: 'empty_summary_input' });
    return;
  }

  // ── Title ──────────────────────────────────────────────────────────────────
  let title: string | undefined;
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string' || body.title.length > MAX_TITLE_CHARS) {
      res.status(400).json({ error: 'invalid_body', fields: ['title'] });
      return;
    }
    const trimmed = body.title.trim();
    if (trimmed !== '') title = trimmed;
  }

  try {
    const result = await runJob('summary', {
      transcript,
      cards,
      title,
      signal: requestSignal(req),
    });
    if (result.job !== 'summary') {
      res.status(502).json({ error: 'capture_upstream_error' });
      return;
    }
    // A provider that ignores its own token ceiling could answer with a novel.
    // Truncating silently would be worse than refusing, so this is a 502 with a
    // code: the meeting is intact and the request can be repeated.
    if (result.summary.length > MAX_SUMMARY_CHARS) {
      console.error(`[capture] summary: the answer exceeded ${MAX_SUMMARY_CHARS} characters`);
      res.status(502).json({ error: 'capture_output_truncated' });
      return;
    }
    res.status(200).json({ summary: result.summary });
  } catch (err) {
    sendJobError(res, err, 'summary');
  }
}

function requestSignal(req: VercelRequest): AbortSignal | undefined {
  const candidate = (req as unknown as { signal?: unknown }).signal;
  return candidate instanceof AbortSignal ? candidate : undefined;
}

export default handler;
