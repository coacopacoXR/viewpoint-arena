// OllamaDirectCaptureProvider — browser → Ollama, LAN-only (T4.6).
//
// The whole point of this mode is that NOTHING leaves the network: there is no
// server-side proxy and therefore no API key anywhere in this file. That is
// also why it is the mode users will misconfigure most — the browser is
// talking straight to a service on another machine, so base URL, network
// binding, CORS and mixed content all have to be right, and a browser reports
// every one of those failures identically ("Failed to fetch").
//
// Every failure path below therefore says what to CHECK, not just what
// happened. Do not shorten these messages: they are the diagnostics.
//
// Per docs/plan/02-connector-adapters.md §2 this provider is
// "Browser → Ollama directly, LAN-only, no transcription
// (bring-your-own-transcript or text-only mode)".

import type { InsightCard } from '../../../types';
import type { PublicConfig } from '../../config/publicConfig.ts';
import type {
  SlideContext,
  TranscriptCaptureProvider,
  TranscriptChunk,
} from './types';
import {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
} from './extractionPrompt';
import { parseInsightCards } from './parseInsightCards';
import EXTRACTION_JSON_SCHEMA from './extractionSchema.json';
import { CaptureEndpointError } from './extractClient';
import type { HealthCheckResult } from '../../health/types';
import { HEALTH_DETAILS } from '../../health/details';

type FetchFn = typeof globalThis.fetch;

/**
 * Same ceiling as capture-service (DEFAULT_TIMEOUT_SECONDS, parity-tested):
 * the same model on the same hardware. qwen2.5:7b took ~20 s fully on a GPU
 * and over 120 s on a 6 GB laptop GPU that could hold only part of it.
 */
const DEFAULT_TIMEOUT_MS = 600_000;
/**
 * A health poll gets seconds, not the extraction budget. Listing models is a
 * local metadata read even while a model is cold-loading, so anything slower
 * than this means the host is not answering.
 */
const HEALTH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_TOKENS = 4096;
/** Ollama's error bodies are short; cap what gets repeated to the user. */
const MAX_BODY_EXCERPT = 300;

export interface OllamaDirectOptions {
  /**
   * Root URL of the Ollama instance, e.g. `http://ollama.internal:11434`.
   * REQUIRED — there is deliberately no localhost default, because a wrong
   * silent default is how a review transcript ends up being POSTed to
   * whatever else is listening on the developer's own machine.
   */
  baseUrl: string;
  /** Model to extract with, e.g. `deepseek-r1:7b`. Must be pulled on the server. */
  model: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export class OllamaDirectCaptureProvider implements TranscriptCaptureProvider {
  private readonly _baseUrl: string;
  private readonly _model: string;
  private readonly _fetch: FetchFn;
  private readonly _timeoutMs: number;

  constructor(options: OllamaDirectOptions) {
    this._baseUrl = normalizeBaseUrl(options.baseUrl);
    if (typeof options.model !== 'string' || options.model.trim().length === 0) {
      throw new Error(
        'capture/ollamaDirect: a model name is required (capture.model in ' +
          'viewpoint.config.ts, e.g. "deepseek-r1:7b"). Run `ollama list` on ' +
          'the server to see what is installed.',
      );
    }
    this._model = options.model.trim();
    this._fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Builds the provider from the redacted public config, which is the only
   * sanctioned source of the base URL. `capture.baseUrl` reaches the browser
   * through the allowlist in lib/config/redact.ts — it is a LAN address, not a
   * credential, and this mode has no credential.
   */
  static fromPublicConfig(
    config: PublicConfig,
    overrides: Pick<OllamaDirectOptions, 'fetchFn' | 'timeoutMs'> = {},
  ): OllamaDirectCaptureProvider {
    const capture = config?.capture;
    if (capture?.provider !== 'ollamaDirect') {
      throw new Error(
        `capture/ollamaDirect: the deployment's configured capture provider ` +
          `is "${capture?.provider ?? 'unknown'}", not "ollamaDirect". Either ` +
          `set capture.provider to 'ollamaDirect' in viewpoint.config.ts or ` +
          `construct the provider that matches the config.`,
      );
    }
    if (typeof capture.baseUrl !== 'string' || capture.baseUrl.length === 0) {
      throw new Error(
        'capture/ollamaDirect: the public config carried no capture.baseUrl. ' +
          'Set capture.baseUrl in viewpoint.config.ts (e.g. ' +
          '"http://ollama.internal:11434") — the browser cannot guess where ' +
          'the Ollama instance lives, and this provider refuses to default to ' +
          'localhost.',
      );
    }
    if (typeof capture.model !== 'string' || capture.model.length === 0) {
      throw new Error(
        'capture/ollamaDirect: the public config carried no capture.model. ' +
          'Set capture.model in viewpoint.config.ts (e.g. "deepseek-r1:7b").',
      );
    }
    return new OllamaDirectCaptureProvider({
      baseUrl: capture.baseUrl,
      model: capture.model,
      ...overrides,
    });
  }

  async extractInsights(
    transcript: TranscriptChunk[],
    context: SlideContext,
  ): Promise<InsightCard[]> {
    const url = `${this._baseUrl}/api/chat`;
    const payload = {
      model: this._model,
      // Non-negotiable: a streaming reply would have to be reassembled before
      // it could be parsed, and there is nothing to stream to here.
      stream: false,
      // Ollama's structured-output mode with the exact card schema, not just
      // "some JSON": a live run with plain 'json' got the details fields
      // flattened onto the card, and the strict parser rightly refused the lot.
      // parseInsightCards is still the authority on the shape.
      format: EXTRACTION_JSON_SCHEMA,
      options: { temperature: 0, num_predict: MAX_OUTPUT_TOKENS },
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildExtractionUserPrompt(transcript, context),
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);

    let response: Response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      // Checked BEFORE the generic branch: an abort surfaces as the same
      // TypeError/DOMException as every other failure.
      if (controller.signal.aborted) {
        throw new CaptureEndpointError(
          'timeout',
          `capture/ollamaDirect: Ollama did not answer ${url} within ` +
            `${Math.round(this._timeoutMs / 1000)}s. A 7B model on CPU takes ` +
            `5-10s per extraction and much longer while a model is cold-` +
            `loading into RAM; a 13B+ model wants a GPU. Either raise ` +
            `timeoutMs, use a smaller model, or check \`ollama ps\` on the ` +
            `server.`,
          null,
        );
      }
      throw new CaptureEndpointError(
        'network',
        `capture/ollamaDirect: the browser could not reach Ollama at ${url}. ` +
          `The browser reports all of the following identically, so check ` +
          `them in this order:\n` +
          `  1. Is Ollama running there? (\`ollama serve\` on the host, then ` +
          `\`curl ${this._baseUrl}/api/tags\` from another machine).\n` +
          `  2. Is capture.baseUrl right? It must be the Ollama ROOT ` +
          `(scheme + host + port, e.g. http://ollama.internal:11434) and must ` +
          `be reachable FROM THE BROWSER'S machine, not from the app server.\n` +
          `  3. Is Ollama bound to the LAN? By default it listens on ` +
          `127.0.0.1 only — set OLLAMA_HOST=0.0.0.0 on the Ollama host.\n` +
          `  4. Is CORS allowed? This is a cross-origin browser request, so ` +
          `Ollama must permit the app's origin: set OLLAMA_ORIGINS to the ` +
          `app's URL (or OLLAMA_ORIGIN_ALLOW_ALL=1 on a trusted LAN).\n` +
          `  5. Mixed content? An app served over https CANNOT call ` +
          `http://…:11434 — browsers block it. Serve the app over http on the ` +
          `LAN, or put Ollama behind TLS.`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.toUpstreamError(url, response);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new CaptureEndpointError(
        'endpoint_unavailable',
        `capture/ollamaDirect: ${url} answered ${response.status} with ` +
          `${contentType || 'no content type'} instead of JSON. Something ` +
          `other than Ollama is answering on that address — a proxy, an SPA ` +
          `fallback, or the wrong port. capture.baseUrl must point at the ` +
          `Ollama API root.`,
        response.status,
      );
    }

    const data = (await response.json().catch(() => null)) as {
      message?: { content?: unknown };
      done_reason?: string;
      error?: unknown;
    } | null;

    if (!data) {
      throw new CaptureEndpointError(
        'endpoint_unavailable',
        `capture/ollamaDirect: ${url} returned a body that was not valid JSON.`,
        response.status,
      );
    }

    if (data.done_reason === 'length') {
      throw new CaptureEndpointError(
        'capture_output_truncated',
        `capture/ollamaDirect: "${this._model}" ran out of output tokens ` +
          `before finishing the JSON. Shorten the transcript window or use a ` +
          `model with a larger context.`,
        response.status,
      );
    }

    const text = data.message?.content;
    if (typeof text !== 'string') {
      throw new CaptureEndpointError(
        'ollama_error',
        `capture/ollamaDirect: Ollama answered without a message.content ` +
          `string${typeof data.error === 'string' ? `: ${excerpt(data.error)}` : ''}. ` +
          `Check \`ollama ps\` and the server log.`,
        response.status,
      );
    }

    // Throws CaptureExtractionError (with a `reason`) on any malformed output.
    // Unlike the cloud path this parse happens in the browser, so the error
    // message may quote the model output — the transcript is already here.
    return parseInsightCards(text, {
      defaultAgentId: transcript[0]?.speakerId,
    });
  }

  /**
   * Is the Ollama host answering, and is the configured model pulled on it?
   *
   * `GET /api/tags` is Ollama's unauthenticated model list, so this checks the
   * two things that actually go wrong in this mode — the host is unreachable
   * from the browser (binding, CORS, mixed content: the five causes
   * extractInsights spells out), and the host is fine but nobody ran
   * `ollama pull`. It never sends a prompt, so it costs no inference.
   *
   * The model comparison accepts a bare name against a tagged list entry:
   * Ollama reports `deepseek-r1:7b` for a pulled tag but also answers for
   * `deepseek-r1`, which it resolves to `:latest`. Treating those as different
   * models would report a working deployment as broken.
   *
   * The detail is a fixed phrase and never the URL, the model name or Ollama's
   * reply: the base URL is a LAN address (not a credential, and already public
   * via capture.baseUrl), but a health response is not the place to repeat it,
   * and an upstream body is never safe to forward.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const controller = new AbortController();
    // A health poll must not inherit the 600s extraction budget: a hung model
    // host would otherwise hold the whole /api/health response open.
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this._fetch(`${this._baseUrl}/api/tags`, {
        signal: controller.signal,
      });
    } catch {
      return {
        ok: false,
        detail: controller.signal.aborted
          ? HEALTH_DETAILS.timedOut
          : HEALTH_DETAILS.unreachable,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return { ok: false, detail: HEALTH_DETAILS.upstreamError };
    }

    const body = (await response.json().catch(() => null)) as {
      models?: Array<{ name?: unknown }>;
    } | null;
    const names = (body?.models ?? [])
      .map((m) => m?.name)
      .filter((n): n is string => typeof n === 'string');

    if (names.length === 0) {
      // An empty list means this is Ollama (the shape parsed) with nothing
      // pulled, which is a different fix from "that URL is not Ollama".
      return { ok: false, detail: HEALTH_DETAILS.modelMissing };
    }
    if (!names.some((name) => sameModel(name, this._model))) {
      return { ok: false, detail: HEALTH_DETAILS.modelMissing };
    }
    return { ok: true, detail: HEALTH_DETAILS.modelAvailable };
  }

  /**
   * Ollama reports a missing model as an HTTP 404 with a JSON error body, so
   * the 404 branch has to look at the body to tell "model not pulled" from
   * "that URL is not Ollama at all". Both are common; they have different fixes.
   */
  private async toUpstreamError(
    url: string,
    response: Response,
  ): Promise<CaptureEndpointError> {
    const bodyText = await response.text().catch(() => '');
    let bodyError: unknown;
    try {
      bodyError = (JSON.parse(bodyText) as { error?: unknown }).error;
    } catch {
      bodyError = undefined;
    }
    const detail =
      typeof bodyError === 'string' ? bodyError : excerpt(bodyText);

    if (typeof bodyError === 'string' && bodyError.includes('not found')) {
      return new CaptureEndpointError(
        'ollama_model_not_found',
        `capture/ollamaDirect: ${detail}. Pull it on the Ollama host with ` +
          `\`ollama pull ${this._model}\`, or point capture.model at an ` +
          `installed model (\`ollama list\`).`,
        response.status,
      );
    }

    if (response.status === 404) {
      return new CaptureEndpointError(
        'endpoint_unavailable',
        `capture/ollamaDirect: ${url} returned 404. That address is serving ` +
          `something that is not the Ollama API — capture.baseUrl should be ` +
          `the Ollama root (e.g. http://ollama.internal:11434), with no path.`,
        response.status,
      );
    }

    return new CaptureEndpointError(
      'ollama_error',
      `capture/ollamaDirect: Ollama returned ${response.status} for ${url}` +
        (detail ? `: ${detail}` : '') +
        `. The Ollama server log on that host has the detail.`,
      response.status,
    );
  }
}

/**
 * Validates the configured base URL. Rejects a relative URL, a bare host and a
 * URL with a path, because each of those produces a request that silently goes
 * somewhere the operator did not intend.
 */
function normalizeBaseUrl(baseUrl: string): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error(
      'capture/ollamaDirect: baseUrl is required. Set capture.baseUrl in ' +
        'viewpoint.config.ts (e.g. "http://ollama.internal:11434"). This ' +
        'provider refuses to default to localhost: a silent default would ' +
        'POST the review transcript to whatever is listening on the ' +
        "developer's own machine.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new Error(
      `capture/ollamaDirect: baseUrl "${baseUrl}" is not an absolute URL. ` +
        `It needs a scheme, host and port, e.g. http://ollama.internal:11434.`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `capture/ollamaDirect: baseUrl "${baseUrl}" must use http or https, ` +
        `got "${parsed.protocol}".`,
    );
  }

  // Anything beyond "/" means the operator pasted a path (…/api, …/v1) or a
  // proxied prefix. /api/chat is appended to the ROOT.
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(
      `capture/ollamaDirect: baseUrl "${baseUrl}" must be the Ollama root ` +
        `with no path — the provider appends /api/chat itself. Use ` +
        `"${parsed.origin}".`,
    );
  }

  return parsed.origin;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_BODY_EXCERPT) return flat;
  return `${flat.slice(0, MAX_BODY_EXCERPT)}…`;
}

/**
 * Compare a model name from Ollama's tag list against the configured one.
 *
 * An untagged name means Ollama's `:latest`, on both sides, so `deepseek-r1`
 * and `deepseek-r1:latest` are the same model. Comparing the strings directly
 * would report a working deployment as missing its model.
 */
function sameModel(listed: string, configured: string): boolean {
  if (listed === configured) return true;
  const [listedName, listedTag] = listed.split(':');
  const [configuredName, configuredTag] = configured.split(':');
  if (listedName !== configuredName) return false;
  return (listedTag ?? 'latest') === (configuredTag ?? 'latest');
}
