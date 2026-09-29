// Browser-safe client for POST /api/capture/extract.
//
// Both cloud capture providers (openai.ts, anthropic.ts) go through here, so
// the guarantee that matters is stated once, in one place:
//
//   NO CREDENTIAL EXISTS IN THIS MODULE OR IN ANY CALL TO IT.
//
// There is no key option, no Authorization header, no process.env and no
// import.meta.env read. The browser posts a transcript to our own serverless
// function; that function holds whatever credential the deployment configured,
// server-side. This is the rule in docs/plan/02-connector-adapters.md §2 —
// "never call these directly from the browser with a key".
//
// NOR IS THERE A PROVIDER NAME, and that is new (plan 14, batch BF). This client
// used to send `provider: 'openai'` and the endpoint used to dispatch on it. It
// does not now: lib/ai/router.ts resolves the AI for the cards job from a setting
// an administrator chose, from viewpoint.config.ts, or from the built-in stack.
// A browser that named the provider would be a second place the decision is made,
// and the two would eventually disagree — so the request carries the transcript
// and the context and nothing about the AI. That is also why the error messages
// below say "capture/extract" instead of naming a vendor: this module does not
// know which one answered, and must not pretend to.

import type { InsightCard } from '../../../types';
import type { SlideContext, TranscriptChunk } from './types';
import type { CaptureParseFailureReason } from './parseInsightCards';
import { validateExtractionPayload } from './parseInsightCards';

export const EXTRACT_ENDPOINT = '/api/capture/extract';

/** The label every message here carries. Not a vendor: see the header. */
const WHERE = 'capture/extract';

type FetchFn = typeof globalThis.fetch;

export interface ExtractClientOptions {
  /** Override for tests, or a deployment that mounts the function elsewhere. */
  endpoint?: string;
  fetchFn?: FetchFn;
}

/**
 * A failed extraction request.
 *
 * `code` is the server's error code verbatim, or one of the three client-side
 * codes ('network', 'endpoint_unavailable', 'unknown'). `reason` is set only
 * when the failure was the model's output being unparseable, and carries the
 * same enum the server-side parser produced.
 */
export class CaptureEndpointError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly reason: CaptureParseFailureReason | null;

  constructor(code: string, message: string, status: number | null = null, reason: CaptureParseFailureReason | null = null) {
    super(message);
    this.name = 'CaptureEndpointError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export async function extractInsightsViaEndpoint(
  transcript: TranscriptChunk[],
  context: SlideContext,
  options: ExtractClientOptions = {},
): Promise<InsightCard[]> {
  const endpoint = options.endpoint ?? EXTRACT_ENDPOINT;
  const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, context }),
    });
  } catch {
    // Fetch's own message is dropped: it embeds the URL, and a caller may have
    // pointed `endpoint` somewhere it should not have.
    throw new CaptureEndpointError(
      'network',
      `${WHERE}: could not reach ${endpoint}. The serverless function is not ` +
        `answering — check that the deployment includes api/capture/extract.ts ` +
        `and that the network allows the request.`,
    );
  }

  if (!response.ok) {
    throw await toEndpointError(endpoint, response);
  }

  // A 200 that is not our function: an SPA fallback or a misrouted proxy
  // answers 200 text/html for any unknown /api path (this is exactly what
  // `vite preview` does). Reading it as JSON would throw a SyntaxError with no
  // context, so say what actually happened.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new CaptureEndpointError(
      'endpoint_unavailable',
      `${WHERE}: ${endpoint} answered ${response.status} ` +
        `${contentType || 'with no content type'} instead of JSON. The ` +
        `serverless function is not running — under \`vite preview\` and any ` +
        `other static host, api/* is not executed and the SPA fallback ` +
        `returns index.html.`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CaptureEndpointError(
      'endpoint_unavailable',
      `${WHERE}: ${endpoint} returned a body that was not valid JSON.`,
      response.status,
    );
  }

  // The endpoint has already parsed and validated the model output, but its
  // response still crosses a network and a proxy: re-validating means a
  // half-built card cannot reach the UI even if the server changes shape. It
  // also means a provider this client has never heard of — a webhook, an
  // enterprise gateway — cannot produce a card the app would not have accepted
  // from OpenAI.
  return validateExtractionPayload(payload, {
    defaultAgentId: transcript[0]?.speakerId,
  });
}

/**
 * HEAD probe: is the extraction endpoint deployed and unlocked?
 *
 * It cannot say which AI is behind it, and no longer pretends to: the answer to
 * "is capture configured" lives in the admin console's AI section, which is the
 * only place that can see the setting. This probe is what lets a UI say "capture
 * is unavailable here" instead of failing an extraction the user waited for.
 */
export async function probeExtractEndpoint(
  options: ExtractClientOptions = {},
): Promise<boolean> {
  const endpoint = options.endpoint ?? EXTRACT_ENDPOINT;
  const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await doFetch(endpoint, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

// ─── Error translation ──────────────────────────────────────────────────────

async function toEndpointError(
  endpoint: string,
  response: Response,
): Promise<CaptureEndpointError> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    reason?: CaptureParseFailureReason;
  } | null;
  const code = body?.error ?? 'unknown';

  switch (code) {
    case 'capture_not_configured':
      // Points at the admin console and the config file, not at a variable name
      // or a vendor: which key the deployment holds is deployment internals, and
      // the browser is not told. The server log names the missing piece.
      return new CaptureEndpointError(
        code,
        `${WHERE}: the server has no usable AI configured for this job. It is ` +
          `configured server-side only — choose one in the admin console's AI ` +
          `section, or check the capture section of viewpoint.config.ts and the ` +
          `deployment's secret store. No key is ever sent to the browser, so ` +
          `there is nothing to fix client-side.`,
        response.status,
      );
    case 'capture_upstream_error':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the AI provider rejected the extraction request. The ` +
          `upstream response is not forwarded to the browser — check the server ` +
          `log for the status and detail.`,
        response.status,
      );
    case 'capture_upstream_unreachable':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the server could not reach the AI provider it is configured ` +
          `to use.`,
        response.status,
      );
    case 'capture_upstream_timeout':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the AI provider did not answer in time. A small model on CPU ` +
          `takes seconds per extraction and much longer while it cold-loads; ` +
          `retry, or choose a faster provider in the admin console's AI section.`,
        response.status,
      );
    case 'capture_endpoint_unavailable':
      return new CaptureEndpointError(
        code,
        `${WHERE}: something answered the server's request that was not the AI ` +
          `API it called — usually a base URL pointing at a proxy, a gateway's ` +
          `error page or the wrong port. Check the provider's URL in the admin ` +
          `console's AI section.`,
        response.status,
      );
    case 'capture_output_truncated':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the model ran out of output tokens before finishing the ` +
          `JSON. Shorten the transcript window, or choose a model with a larger ` +
          `context window.`,
        response.status,
      );
    case 'capture_parse_error':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the model did not return usable InsightCard JSON ` +
          `(${body?.reason ?? 'unknown reason'}). The raw model output is not ` +
          `forwarded because it quotes the transcript.`,
        response.status,
        body?.reason ?? null,
      );
    case 'transcript_too_large':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the transcript window exceeds the server's size limit. ` +
          `Extract over a shorter window.`,
        response.status,
      );
    case 'empty_transcript':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the transcript window was empty — there was nothing to ` +
          `extract from.`,
        response.status,
      );
    case 'request_closed':
      // The client hung up. Nothing to fix and nobody to tell: the tab that
      // would have shown the message is the one that left.
      return new CaptureEndpointError(
        code,
        `${WHERE}: the request was cancelled before the extraction finished.`,
        response.status,
      );
    case 'invalid_transcript':
    case 'invalid_context':
    case 'invalid_provider':
    case 'invalid_body':
      return new CaptureEndpointError(
        code,
        `${WHERE}: the server rejected the request payload (${code}). This is ` +
          `a client bug, not a model failure.`,
        response.status,
      );
    default:
      return new CaptureEndpointError(
        code,
        `${WHERE}: ${endpoint} returned ${response.status} (${code}).`,
        response.status,
      );
  }
}
