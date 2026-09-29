import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { TranscriptChunk } from '../../lib/connectors/capture/types.ts';
import { describeResolution, resolveJob, runJob } from '../../lib/ai/router.ts';
import {
  enforceCaptureAccess,
  parseGrounded,
  parseSlideContext,
  parseTranscriptChunk,
  sendJobError,
} from './_request.ts';

/**
 * POST /api/capture/extract — a transcript in, InsightCards out.
 *
 * This endpoint used to hold the cloud half of the capture contract: it picked
 * OpenAI or Anthropic from the request body, put the key from its own environment
 * in the header, and refused to echo a byte of anything back. It now holds only
 * the third of those. Which AI answers is decided by lib/ai/router.ts, from a
 * per-job setting an administrator chose, from viewpoint.config.ts, or from the
 * built-in stack — and the browser no longer says which it wanted, because it no
 * longer needs to know.
 *
 * Everything else about the contract is unchanged: the request shape, the
 * `{ cards }` response the browser re-validates with the same strict parser, the
 * transcript budget, and the error vocabulary.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * THE TRANSCRIPT IS PROPRIETARY AND THIS ENDPOINT IS ON THE INTERNET.
 * A request body carries what a company's engineers said about a design that
 * has not shipped. The rules below are the whole reason this file is short.
 *
 * 1. NEVER ECHO THE TRANSCRIPT BACK. Not in an error, not in a log line, not in
 *    a debug field. A failure is reported as a code and, for a parse failure, the
 *    parser's `reason` enum — both from a closed vocabulary in lib/ai/router.ts.
 * 2. NEVER FORWARD MODEL OUTPUT. The strict parser's messages quote the payload
 *    they rejected; that quoting stays inside the parser and its log line, and
 *    only its reason is returned.
 * 3. NO CREDENTIAL HERE OR IN ANY RESPONSE. The key a cloud provider needs is
 *    read by the router from the encrypted settings store or from a named
 *    environment variable, and goes into one header. Nothing on any code path can
 *    name it, and there is no default.
 * 4. REFUSE WHAT YOU DO NOT UNDERSTAND. Unknown fields, malformed chunks, a
 *    malformed component list: 400. Silently dropping a component list is how a
 *    model starts inventing component ids that do not exist in anyone's CAD tree.
 */

// ── Transcript budget ───────────────────────────────────────────────────────
//
// These two numbers are the contract with capture-service: its
// MAX_TRANSCRIPT_CHUNKS and MAX_TRANSCRIPT_CHARS are pinned against them by
// capture-service/tests/test_typescript_parity.py, so a recording that is too
// long for one path is too long for both and an operator learns one limit.
// Change them here first, then in capture_service/transcribe.py.

/** Hard cap on chunks in one extraction window. */
const MAX_CHUNKS = 2000;

/** Hard cap on total transcript characters sent to a model in one call. */
const MAX_TRANSCRIPT_CHARS = 200_000;

interface ExtractRequestBody {
  transcript?: unknown;
  context?: unknown;
  /**
   * The optional grounded-capture context (batch D of
   * docs/local-capture-plan.md).
   *
   * The cloud path used to DROP these three fields — only the local path
   * forwarded them — which meant the component list, the pointing timeline and
   * the live speaker-labelled transcript were collected by the browser, sent over
   * the wire, and thrown away. They now reach whichever provider the router chose,
   * because a webhook or an openai-compatible gateway is at least as able to use
   * them as our own service is.
   */
  grounded?: unknown;
  /**
   * Accepted and IGNORED.
   *
   * Older browser bundles name the provider they want. The server decides now, so
   * the field is tolerated rather than refused — a stale tab open across a deploy
   * should keep working, not start 400ing — and has no effect on anything.
   */
  provider?: unknown;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  // HEAD is the probe lib/connectors/capture/extractClient.ts's
  // probeExtractEndpoint uses, so a UI can say "capture is not available here"
  // instead of failing an extraction the user waited for. It answers from the
  // RESOLUTION alone and makes no upstream call: a health poll that spent money
  // on a model call would be a health poll nobody could afford to run.
  if (req.method === 'HEAD') {
    if (!enforceCaptureAccess(req, res)) return;
    const resolved = describeResolution(await resolveJob('cards'));
    if (resolved.missingSecret) {
      res.status(503).json({ error: 'capture_not_configured' });
      return;
    }
    res.status(200).json({});
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Front-door password when the deployment has one. Runs before any transcript
  // is read: a request from someone who has not been admitted does not get as far
  // as a validation error that could describe what they sent.
  if (!enforceCaptureAccess(req, res)) return;

  const body = (req.body ?? {}) as ExtractRequestBody;

  // ── Validate the transcript ────────────────────────────────────────────────
  if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
    res.status(400).json({ error: 'empty_transcript' });
    return;
  }
  if (body.transcript.length > MAX_CHUNKS) {
    res.status(413).json({ error: 'transcript_too_large', maxChunks: MAX_CHUNKS });
    return;
  }

  const transcript: TranscriptChunk[] = [];
  for (const raw of body.transcript) {
    const chunk = parseTranscriptChunk(raw);
    if (chunk === null) {
      // The field NAMES that failed, never their values: a value here is
      // transcript.
      res.status(400).json({ error: 'invalid_body', fields: ['transcript'] });
      return;
    }
    transcript.push(chunk);
  }

  // Enforce the character budget AFTER shape validation, so a malformed chunk
  // can't hide behind a too-large body.
  const totalChars = transcript.reduce((sum, c) => sum + c.text.length, 0);
  if (totalChars > MAX_TRANSCRIPT_CHARS) {
    res.status(413).json({
      error: 'transcript_too_large',
      maxChars: MAX_TRANSCRIPT_CHARS,
    });
    return;
  }

  // ── Validate the spatial context ───────────────────────────────────────────
  const context = parseSlideContext(body.context);
  if (context === null) {
    res.status(400).json({ error: 'invalid_body', fields: ['context'] });
    return;
  }

  // ── Validate the grounded context (optional) ───────────────────────────────
  const grounded = parseGrounded(body.grounded);
  if (grounded === null) {
    res.status(400).json({ error: 'invalid_body', fields: ['grounded'] });
    return;
  }

  try {
    // The router resolves the provider for this job and calls it. Every failure
    // it can report is an AiJobError carrying a code and a status and nothing
    // else, which is what makes sendJobError safe to hand the whole try block.
    const result = await runJob('cards', {
      transcript,
      context,
      grounded,
      signal: requestSignal(req),
    });
    if (result.job !== 'cards') {
      // Unreachable: runJob answers the job it was asked for. Guarded rather than
      // cast, because a cast here would be the one place a future refactor could
      // quietly send the wrong shape to the browser.
      res.status(502).json({ error: 'capture_upstream_error' });
      return;
    }
    res.status(200).json({ cards: result.cards });
  } catch (err) {
    sendJobError(res, err, 'extract');
  }
}

/**
 * The caller's abort signal, when the runtime exposes one.
 *
 * Vercel's Node runtime attaches `signal` to the request; plain Node does not,
 * and neither does the test double. Optional on purpose: a deployment without one
 * simply loses the ability to stop an in-flight cloud call when the client hangs
 * up, which is what happened before this existed too.
 */
function requestSignal(req: VercelRequest): AbortSignal | undefined {
  const candidate = (req as unknown as { signal?: unknown }).signal;
  return candidate instanceof AbortSignal ? candidate : undefined;
}

export default handler;
