// LocalCaptureProvider — browser-safe RecordingCaptureProvider for the
// self-hosted capture-service (T4.4).
//
// Holds no credential and cannot be given one: there is no token option, and
// nothing in this file reads process.env or import.meta.env. The recording goes
// to our own same-origin endpoint (/api/capture/local), and it is THAT layer
// which attaches the shared secret capture-service requires:
//
//   self-hosted   deploy/nginx/app.conf proxies /api/capture/local to
//                 capture-service:8080/capture and sets the header from the
//                 container's own environment, substituted at start-up rather
//                 than baked into the image;
//   Vercel        api/capture/local.ts forwards the multipart body and adds the
//                 same header from server-side process.env.
//
// The browser therefore never learns the secret and never needs a route to the
// service — which matters because capture-service publishes no port at all (see
// the block comment at the top of docker-compose.yml). This is the rule
// extractClient.ts already follows for the cloud providers, from
// docs/plan/02-connector-adapters.md §2: "never call these directly from the
// browser with a key".

import type { InsightCard } from '../../../types';
import type { GroundedCaptureContext, RecordingCaptureProvider, SlideContext } from './types';
import { validateExtractionPayload } from './parseInsightCards';

/**
 * Same-origin relative endpoint, exactly like extractClient's EXTRACT_ENDPOINT.
 * Relative on purpose: an absolute URL here would either name a deployment or
 * invite a secret to be configured client-side.
 */
export const LOCAL_CAPTURE_ENDPOINT = '/api/capture/local';

/**
 * The live-transcript endpoint. Same proxy pattern as LOCAL_CAPTURE_ENDPOINT:
 * same-origin, secret added by the proxy layer, browser holds no credential.
 */
export const TRANSCRIBE_CHUNK_ENDPOINT = '/api/capture/transcribe';

/**
 * The only shape of upstream error code that is safe to repeat to a user.
 *
 * capture-service's own codes are `[a-z_]+` by construction
 * (capture_service/errors.py), and api/capture/local.ts re-validates against
 * the same pattern before forwarding. Anything else — an HTML page from an SPA
 * fallback, a proxy's prose, a stack trace — is dropped rather than echoed,
 * because that text can quote the request and therefore the meeting.
 */
const SAFE_UPSTREAM_CODE = /^[a-z_]{1,64}$/;

/**
 * Filename extensions per container format. capture-service hands the upload to
 * ffmpeg, which sniffs the real format, so the extension only has to be honest
 * enough not to mislead an operator reading a log line.
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/**
 * The upload filename for a recorded Blob.
 *
 * Never derived from user-supplied text: capture-service already refuses a
 * suffix that is not `\.[a-z0-9]{1,8}` (`_safe_suffix` in main.py), and sending
 * a clean name means the two sides agree instead of the service silently
 * dropping the extension.
 */
export function recordingFilename(mimeType: string): string {
  const container = mimeType.split(';')[0].trim().toLowerCase();
  return `meeting.${EXTENSION_BY_MIME[container] ?? 'webm'}`;
}

/**
 * The multipart body capture-service's POST /capture expects.
 *
 * `audio` is the file; the other four are optional form fields
 * (`agendaIdx`, `slideTitle`, `hoveredPartName`, `laserTargetPartName`). The two
 * part names are appended ONLY when defined — sending the string "undefined"
 * would put it in the extraction prompt, and sending an empty string would make
 * the service treat it as absent anyway (`_blank_to_none`).
 *
 * The three grounded-capture fields (`componentTree`, `pointingSegments`,
 * `transcriptHint`) are JSON-serialised into the form as strings. They are
 * only appended when supplied and non-empty.
 *
 * No Content-Type is set by the caller: the browser owns the multipart boundary
 * and picks it when FormData is the body.
 */
export function buildCaptureForm(
  audio: Blob,
  context: SlideContext,
  grounded?: GroundedCaptureContext,
): FormData {
  const form = new FormData();
  form.append('audio', audio, recordingFilename(audio.type));
  form.append('agendaIdx', String(context.agendaIdx));
  form.append('slideTitle', context.slideTitle);
  if (context.hoveredPartName !== undefined) {
    form.append('hoveredPartName', context.hoveredPartName);
  }
  if (context.laserTargetPartName !== undefined) {
    form.append('laserTargetPartName', context.laserTargetPartName);
  }
  if (grounded?.componentTree && grounded.componentTree.length > 0) {
    form.append('componentTree', JSON.stringify(grounded.componentTree));
  }
  if (grounded?.pointingSegments && grounded.pointingSegments.length > 0) {
    form.append('pointingSegments', JSON.stringify(grounded.pointingSegments));
  }
  if (grounded?.transcriptHint && grounded.transcriptHint.length > 0) {
    form.append('transcriptHint', JSON.stringify(grounded.transcriptHint));
  }
  return form;
}

/**
 * A failed recording capture.
 *
 * `code` is the upstream code when it was safe to repeat, otherwise one of the
 * client-side codes ('network', 'aborted', 'endpoint_unavailable',
 * 'upstream_error'). `message` is always safe to render: it names the status and
 * a validated code, and never any other response text.
 */
export class LocalCaptureError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = 'LocalCaptureError';
    this.code = code;
    this.status = status;
  }
}

export interface LocalCaptureOptions {
  /** Override for tests, or a deployment that mounts the proxy elsewhere. */
  endpoint?: string;
  /** Override for the live-transcribe endpoint (defaults to /api/capture/transcribe). */
  transcribeEndpoint?: string;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * The batch, post-meeting capture provider: record in the browser, upload the
 * whole recording at the end, get InsightCards back.
 *
 * Deliberately has NO healthCheck. "Is capture-service up?" is a question only
 * a server can answer — the service sits on an internal compose network with no
 * published port — and GET /api/health already asks it: lib/health/probes.ts's
 * probeCaptureService runs server-side, with the secret, and reports the result
 * per connector. A browser-side probe would either be a lie or would need a
 * route to a service that must not have one.
 */
export class LocalCaptureProvider implements RecordingCaptureProvider {
  private readonly _options: LocalCaptureOptions;

  constructor(options: LocalCaptureOptions = {}) {
    this._options = options;
  }

  async captureRecording(
    audio: Blob,
    context: SlideContext,
    options: { signal?: AbortSignal; grounded?: GroundedCaptureContext } = {},
  ): Promise<InsightCard[]> {
    const endpoint = this._options.endpoint ?? LOCAL_CAPTURE_ENDPOINT;
    const doFetch = this._options.fetchFn ?? globalThis.fetch.bind(globalThis);

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        body: buildCaptureForm(audio, context, options.grounded),
        signal: options.signal,
      });
    } catch {
      // fetch's own message is dropped: it embeds the URL, and an operator may
      // have pointed `endpoint` somewhere that should not appear in the UI.
      if (options.signal?.aborted) {
        throw new LocalCaptureError(
          'aborted',
          `capture/local: the upload to ${endpoint} was cancelled before it ` +
            `finished. The recording is still held by the caller, so the same ` +
            `Blob can be sent again.`,
        );
      }
      throw new LocalCaptureError(
        'network',
        `capture/local: could not reach ${endpoint}. In the self-hosted stack ` +
          `that path is served by the app container's nginx and forwarded to ` +
          `capture-service; on Vercel it is api/capture/local.ts. Check that ` +
          `the deployment you are running actually serves it — under \`vite ` +
          `preview\` and any other static host, api/* is not executed.`,
      );
    }

    if (!response.ok) {
      throw await toLocalCaptureError(endpoint, response);
    }

    // A 200 that is not the proxy: an SPA fallback or a misrouted nginx answers
    // 200 text/html for any unknown /api path (this is exactly what
    // `vite preview` does). Reading it as JSON would throw a SyntaxError with no
    // context, so say what actually happened instead.
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new LocalCaptureError(
        'endpoint_unavailable',
        `capture/local: ${endpoint} answered ${response.status} ` +
          `${contentType || 'with no content type'} instead of JSON. The ` +
          `capture proxy is not running on this deployment — under \`vite ` +
          `preview\` and any other static host, api/* is not executed and the ` +
          `SPA fallback returns index.html.`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LocalCaptureError(
        'endpoint_unavailable',
        `capture/local: ${endpoint} returned a body that was not valid JSON.`,
        response.status,
      );
    }

    // capture-service already parsed and validated the model output, but its
    // response still crossed a proxy: re-validating with the same strict rules
    // means a half-built card cannot reach the tracker even if a layer in
    // between changes shape. Throws CaptureExtractionError, whose `reason` is an
    // enum and whose message quotes only the payload, never a credential.
    return validateExtractionPayload(payload);
  }

  /**
   * Transcribe a short audio slice for the live-transcript path (T4.7).
   *
   * POSTs multipart `audio` to /api/capture/transcribe (capture-service's
   * POST /transcribe) and returns the chunks' texts joined with a space.
   * Strict response validation: anything that is not `{ transcript: [{ text: string, ... }] }`
   * is an error, because a malformed response would render as gibberish in the
   * live panel.
   */
  async transcribeChunk(
    audio: Blob,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const endpoint = this._options.transcribeEndpoint ?? TRANSCRIBE_CHUNK_ENDPOINT;
    const doFetch = this._options.fetchFn ?? globalThis.fetch.bind(globalThis);

    const form = new FormData();
    form.append('audio', audio, recordingFilename(audio.type));

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        body: form,
        signal: options.signal,
      });
    } catch {
      if (options.signal?.aborted) {
        throw new LocalCaptureError('aborted', 'transcribe chunk cancelled');
      }
      throw new LocalCaptureError('network', 'transcribe chunk: network error');
    }

    if (!response.ok) {
      throw await toLocalCaptureError(endpoint, response);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new LocalCaptureError(
        'endpoint_unavailable',
        `transcribe chunk: ${endpoint} answered ${response.status} ` +
          `${contentType || 'with no content type'} instead of JSON.`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LocalCaptureError(
        'endpoint_unavailable',
        'transcribe chunk: response body was not valid JSON.',
        response.status,
      );
    }

    // Strict validation: the wire shape is `{ transcript: [{ speakerId, text, startMs, endMs }] }`
    // (camelCase via WireModel in capture-service). Only `text` is read here.
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !Array.isArray((payload as Record<string, unknown>).transcript)
    ) {
      throw new LocalCaptureError(
        'upstream_error',
        'transcribe chunk: response did not contain a transcript array.',
        response.status,
      );
    }
    const transcript = (payload as Record<string, unknown>).transcript as unknown[];
    const texts: string[] = [];
    for (const chunk of transcript) {
      if (typeof chunk !== 'object' || chunk === null) {
        throw new LocalCaptureError(
          'upstream_error',
          'transcribe chunk: transcript entry was not an object.',
          response.status,
        );
      }
      const text = (chunk as Record<string, unknown>).text;
      if (typeof text !== 'string') {
        throw new LocalCaptureError(
          'upstream_error',
          'transcribe chunk: transcript entry had no string text.',
          response.status,
        );
      }
      const trimmed = text.trim();
      if (trimmed) texts.push(trimmed);
    }
    return texts.join(' ');
  }
}

/**
 * The SlideContext for a whole-meeting recording.
 *
 * Batch mode has ONE context for the entire upload — capture-service's POST
 * /capture takes a single agendaIdx/slideTitle pair, because a post-meeting
 * summary has no per-utterance spatial history. So: the slide the host was on,
 * or the review title when there is no agenda, or a generic label when there is
 * not even a review config. Structural parameter on purpose — this must not
 * depend on the review store's shape to stay testable.
 */
export function meetingSlideContext(
  review: { title?: string; agenda?: Array<{ title?: string }> } | null,
  agendaIdx: number,
): SlideContext {
  const agenda = review?.agenda ?? [];
  const clamped =
    agenda.length === 0
      ? 0
      : Math.max(0, Math.min(agendaIdx, agenda.length - 1));
  const slideTitle =
    agenda[clamped]?.title?.trim() ||
    review?.title?.trim() ||
    'Design review';
  return { agendaIdx: clamped, slideTitle };
}

// ─── Error translation ──────────────────────────────────────────────────────

async function toLocalCaptureError(
  endpoint: string,
  response: Response,
): Promise<LocalCaptureError> {
  // The body is read ONLY to look for a code that passes SAFE_UPSTREAM_CODE.
  // Nothing else in it is ever repeated: capture-service's error bodies are
  // code-only by contract, but a proxy, an SPA fallback or a captive portal can
  // return anything, including HTML that quotes the request.
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    error?: unknown;
  } | null;
  // capture-service reports its code as `error`; api/capture/local.ts does too.
  // `code` is accepted as well so a future body that names it directly works.
  const raw =
    typeof body?.code === 'string'
      ? body.code
      : typeof body?.error === 'string'
        ? body.error
        : '';
  const code = SAFE_UPSTREAM_CODE.test(raw) ? raw : null;

  const where = `capture/local: ${endpoint} returned ${response.status}` +
    (code === null ? '' : ` (${code})`);

  // The self-hosted front proxy rate-limits capture per client
  // (deploy/nginx/proxy.conf). Its 429 body is nginx HTML, so there is no code.
  if (response.status === 429) {
    return new LocalCaptureError(
      'rate_limited',
      `${where}: too many capture requests from this address in the last ` +
        `minute. Wait a moment and press Retry — the recording is kept.`,
      response.status,
    );
  }

  switch (code) {
    // Both spellings, on purpose. `capture_not_configured` is what the server-side
    // AI router emits (lib/ai/router.ts) when no provider could be resolved for the
    // job — no CAPTURE_SERVICE_URL, no capture.serviceUrl, or a cloud provider with
    // no stored key. `not_configured` is the older code from when
    // api/capture/local.ts resolved the address itself, and it is kept because a
    // rolling deploy can pair this bundle with a server that still says it. Only
    // one of the two can ever arrive; rendering neither would leave the operator
    // with a bare code string and no idea which file to open.
    case 'not_configured':
    case 'capture_not_configured':
      return new LocalCaptureError(
        code,
        `${where}. This deployment has no AI configured for this job. Choose one ` +
          `in the admin console's AI section, or set capture.provider and (for the ` +
          `built-in stack) capture.serviceUrl in viewpoint.config.ts and restart. ` +
          `No secret is sent to the browser, so there is nothing to fix ` +
          `client-side.`,
        response.status,
      );
    case 'upload_too_large':
      return new LocalCaptureError(
        code,
        `${where}: the recording exceeds capture-service's upload ceiling ` +
          `(CAPTURE_MAX_UPLOAD_BYTES, 200 MiB by default). A shorter meeting or ` +
          `a lower bitrate is the fix.`,
        response.status,
      );
    case 'empty_upload':
      return new LocalCaptureError(
        code,
        `${where}: the recording contained no audio bytes. The microphone may ` +
          `have been muted or unavailable for the whole meeting.`,
        response.status,
      );
    case 'empty_transcript':
      return new LocalCaptureError(
        code,
        `${where}: nothing speech-like was found in the recording, so there was ` +
          `no transcript to extract insights from.`,
        response.status,
      );
    case 'transcriber_unavailable':
    case 'transcription_failed':
      return new LocalCaptureError(
        code,
        `${where}: transcription failed inside capture-service (${code}). The ` +
          `service log has the detail; the recording itself is untouched and can ` +
          `be sent again.`,
        response.status,
      );
    case 'capture_upstream_unreachable':
    case 'capture_upstream_timeout':
    case 'capture_endpoint_unavailable':
    case 'capture_model_not_found':
      return new LocalCaptureError(
        code,
        `${where}: capture-service could not complete the extraction with its ` +
          `local model (${code}). The recording is still held by the caller and ` +
          `can be sent again once the model is reachable.`,
        response.status,
      );
    case 'capture_parse_error':
    case 'capture_output_truncated':
      return new LocalCaptureError(
        code,
        `${where}: the model's answer was not usable InsightCard JSON ` +
          `(${code}). Its raw output is not forwarded, because it quotes the ` +
          `transcript of the meeting. Retry — a second run often parses.`,
        response.status,
      );
    default:
      return new LocalCaptureError(
        code ?? 'upstream_error',
        `${where}. The upstream response body is not forwarded: it can quote ` +
          `the request, which contains the meeting recording. Check the ` +
          `capture-service log for the detail.`,
        response.status,
      );
  }
}
