// ONE ROUTER ON THE SERVER — which AI does each job (plan 14, batch BF).
//
// Before this, "which AI" was three separate decisions made in three places:
// the browser picked a capture provider from public config, api/capture/extract.ts
// picked a cloud vendor from the same config, and nginx picked capture-service by
// routing audio around the api entirely. An organisation that wanted to
// transcribe locally and summarise in the cloud had no way to say so, and an
// organisation that wanted to switch vendors had to edit viewpoint.config.ts and
// redeploy.
//
// Now every AI call the app makes goes through `runJob`, which resolves the
// provider for THAT JOB in this order:
//
//   1. a row in app_settings written from the admin console's AI section;
//   2. the deployment's `capture` block in viewpoint.config.ts;
//   3. `builtin` — the Whisper and Qwen this stack ships with.
//
// and calls it. The browser keeps POSTing the same URLs it always did and never
// learns which provider answered: there is no provider name in a request, no key
// in a bundle, and nothing about the AI in the public config beyond the `mock`
// switch that turns real capture off for a demo.
//
// THE SECURITY HEADER OF api/capture/extract.ts APPLIES HERE IN FULL, and this
// module is where most of it is now enforced. A transcript is the meeting; a
// credential is a credential; an upstream response body can quote either. So:
//
//   * an AiJobError's `code` and `status` are the only parts of a failure that
//     reach a caller, and both come from a closed vocabulary;
//   * upstream text is logged as a bounded, whitespace-flattened excerpt and
//     never put in a thrown message, because a message is what an endpoint
//     tends to forward;
//   * a key is read from the settings store or from a named environment
//     variable, put in exactly one header, and is never logged, never
//     concatenated into a URL and never returned;
//   * model output for the cards job is validated with the same strict parser
//     the browser has always used, so no provider — including a webhook — can
//     put an invented component id or a priority-less card into the tracker.
//
// SERVER ONLY: this module reads secrets and calls upstream services. Nothing a
// browser imports (lib/ai/providers.ts) touches it.

import { loadConfig } from '../config/loadConfig.ts';
import { CAPTURE_AUTH_HEADER, CAPTURE_SHARED_SECRET_ENV } from '../health/probes.ts';
import {
  buildExtractionUserPrompt,
  EXTRACTION_SYSTEM_PROMPT,
} from '../connectors/capture/extractionPrompt.ts';
import {
  CaptureExtractionError,
  parseInsightCards,
} from '../connectors/capture/parseInsightCards.ts';
import type { CaptureParseFailureReason } from '../connectors/capture/parseInsightCards.ts';
import { applyResolvedDeadlines } from '../capture/resolveDeadline.ts';
import type { InsightCard } from '../../types.ts';
import type {
  ComponentTreeEntry,
  GroundedCaptureContext,
  SlideContext,
  TranscriptChunk,
} from '../connectors/capture/types.ts';
import { buildSummaryUserPrompt, SUMMARY_SYSTEM_PROMPT } from './summaryPrompt.ts';
import {
  aiSettingKey,
  modelForJob,
  parseAiJobSetting,
  providerById,
  providerCanDoJob,
  requiresSecret,
  type AiJob,
  type AiJobSetting,
  type AiProviderId,
  type AiSettingSource,
} from './providers.ts';
import { openSettingSecret, readSetting, type SettingsStoreOptions } from './settingsStore.ts';
import {
  buildWebhookCardsRequest,
  buildWebhookSummaryRequest,
  parseWebhookCardsResponse,
  parseWebhookSegmentsResponse,
  parseWebhookSummaryResponse,
  segmentsToTranscript,
  type WebhookSegment,
} from './webhookContract.ts';

type FetchFn = typeof globalThis.fetch;

/**
 * The ceiling on one model reply, for every provider that takes a token limit.
 *
 * Same value the browser-side Ollama provider uses
 * (lib/connectors/capture/ollamaDirect.ts) and capture-service uses
 * (capture_service/ollama.py). A reply that hits it is reported as
 * capture_output_truncated rather than parsed as broken JSON — a truncated
 * answer is a different failure with a different fix, and the difference is
 * visible to whoever is choosing a model. Pinned across all three by
 * capture-service/tests/test_typescript_parity.py.
 */
export const MAX_OUTPUT_TOKENS = 4096;

/** Bound on upstream text repeated into a SERVER LOG line. Never a response. */
const MAX_LOG_EXCERPT = 300;

/**
 * Bound on a thrown value repeated into a SERVER LOG line.
 *
 * Wider than the upstream bound because a stack trace is the useful part of an
 * unexpected error, and still finite because an error carrying a serialised
 * transcript is not a hypothetical.
 */
const MAX_ERROR_EXCERPT = 2000;

/** The multipart field name for audio. capture-service and the webhook agree. */
const AUDIO_FIELD = 'audio';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Used when an Azure OpenAI setting leaves api-version blank. */
const DEFAULT_AZURE_API_VERSION = '2024-10-01-preview';

/**
 * The closed vocabulary of failure codes.
 *
 * Reuses the codes api/capture/extract.ts and capture-service already emit, so
 * lib/connectors/capture/extractClient.ts's existing switch keeps translating
 * them into operator-facing prose. A provider-specific code would mean a
 * provider-specific client, which is what this module exists to remove.
 */
export type AiJobErrorCode =
  /** Nothing could be resolved, or a resolved provider is missing a credential. */
  | 'capture_not_configured'
  /** No TCP connection: refused, DNS failure, TLS failure, wrong host. */
  | 'capture_upstream_unreachable'
  /** The provider did not answer before the ceiling we were given. */
  | 'capture_upstream_timeout'
  /** The provider answered with an error status. */
  | 'capture_upstream_error'
  /** Something answered, but it was not the API we called. */
  | 'capture_endpoint_unavailable'
  /** The model ran out of output tokens before finishing. */
  | 'capture_output_truncated'
  /** The answer was not usable. `reason` carries the parser's classification. */
  | 'capture_parse_error'
  /** A transcription produced no speech. */
  | 'empty_transcript'
  /** The caller hung up. nginx's own code for that, so the two agree. */
  | 'request_closed';

/**
 * Every failure this router reports on purpose.
 *
 * `message` is transcript-free and upstream-free BY CONSTRUCTION: it names the
 * provider, the code and at most a short note this module wrote itself, so an
 * endpoint that logs it — or a future endpoint that forwards it — cannot leak a
 * meeting. Where upstream text genuinely helps an operator it goes to the server
 * log via logExcerpt, bounded and flattened, and stops there.
 */
export class AiJobError extends Error {
  readonly code: AiJobErrorCode | string;
  readonly status: number;
  readonly provider: AiProviderId;
  readonly reason: CaptureParseFailureReason | undefined;
  /**
   * Bounded, content-free extras an endpoint may put in its response body.
   *
   * Only ever numbers and enum strings from OUR OWN vocabulary — a byte ceiling,
   * a parse-failure reason, a card index — forwarded from capture-service so the
   * browser keeps the specific message it has always given for
   * `upload_too_large` or `capture_parse_error`. Never upstream prose, never a
   * transcript, never a body: see propagateBuiltinCode, the only thing that
   * fills this in.
   */
  readonly extras: Record<string, number | string>;

  constructor(
    code: AiJobErrorCode | string,
    status: number,
    provider: AiProviderId,
    detail?: {
      reason?: CaptureParseFailureReason;
      note?: string;
      extras?: Record<string, number | string>;
    },
  ) {
    super(`ai/${provider}: ${code}${detail?.note ? ` (${detail.note})` : ''}`);
    this.name = 'AiJobError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.reason = detail?.reason;
    this.extras = detail?.extras ?? {};
  }
}

/**
 * Write a bounded, flattened, REDACTED excerpt of upstream text to the server log.
 *
 * Bounded and flattened so a 200 kB answer cannot bury the log and a value
 * containing newlines cannot forge extra log lines. Redacted because an upstream
 * body is not ours to trust with our own secrets: OpenAI's 401 for a bad key is
 * `Incorrect API key provided: sk-…`, i.e. the vendor echoes the credential back,
 * and a rotated key would otherwise land verbatim in this container's log. The old
 * api/capture/extract.ts had a `redact()` helper for exactly this; it came with the
 * rest of the upstream code when batch BF moved it here.
 *
 * Server log only. Nothing in this function's output may reach a response body.
 */
function logExcerpt(
  where: string,
  text: string,
  secrets: Array<string | null | undefined> = [],
): void {
  let redacted = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    // split/join, not replace(): a key can contain regex metacharacters, and
    // String.replace with a string pattern only takes the first occurrence.
    if (value) redacted = redacted.split(value).join('<redacted>');
  }
  const flat = redacted.split(/\s+/).join(' ');
  const bounded = flat.length <= MAX_LOG_EXCERPT ? flat : `${flat.slice(0, MAX_LOG_EXCERPT)}…`;
  console.error(`[ai-router] ${where}: ${bounded}`);
}

/**
 * Every credential this request could have put in front of an upstream, so
 * logExcerpt can strike it from anything that comes back.
 *
 * The provider's own secret plus capture-service's shared secret: a builtin call
 * carries the latter, a cloud call the former, and a deployment can switch between
 * them per job — so both are always on the list rather than one being chosen by
 * which provider happens to be resolved.
 */
function redactionList(job: ResolvedJob, options: AiRouterOptions): string[] {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  return [job.secret, env[CAPTURE_SHARED_SECRET_ENV]];
}

/**
 * A bounded rendering of a thrown value, for the log lines that report OUR bugs.
 *
 * Bounded but NOT flattened: a stack trace is the useful part of an unexpected
 * error and flattening it would make it unreadable. The bound is what stops a
 * thrown value carrying a whole transcript — an upstream client that throws
 * `new Error(JSON.stringify(payload))` is not a hypothetical.
 */
function boundedError(err: unknown): string {
  const text = String(err);
  return text.length <= MAX_ERROR_EXCERPT ? text : `${text.slice(0, MAX_ERROR_EXCERPT)}…`;
}

// ─── Inputs and results ─────────────────────────────────────────────────────

export interface TranscriptionInput {
  /** The audio to transcribe. A Blob, so a browser upload and a Buffer both work. */
  audio: Blob;
  /** Filename for the multipart part. The extension only ever hints at a container. */
  filename?: string;
  contentType?: string;
  /** The caller's abort signal: a live chunk a client gave up on stops here. */
  signal?: AbortSignal;
}

export interface CardsInput {
  transcript: TranscriptChunk[];
  context: SlideContext;
  grounded?: GroundedCaptureContext;
  signal?: AbortSignal;
}

export interface SummaryInput {
  transcript: TranscriptChunk[];
  cards: InsightCard[];
  /** The review's own name, when it has one. */
  title?: string;
  signal?: AbortSignal;
}

export type AiJobInput = TranscriptionInput | CardsInput | SummaryInput;

export type AiJobResult =
  | { job: 'transcription'; transcript: TranscriptChunk[] }
  | { job: 'cards'; cards: InsightCard[] }
  | { job: 'summary'; summary: string };

export interface AiRouterOptions {
  /** Test seam, and how the endpoints keep working under vitest. */
  fetchFn?: FetchFn;
  env?: Record<string, string | undefined>;
  /**
   * Skip resolution and use exactly this. How POST /api/admin/ai/test runs a
   * real request against values the admin has not saved yet.
   */
  resolved?: ResolvedJob;
  /** Passed through to the settings store. Test seam. */
  settings?: SettingsStoreOptions;
  /**
   * A ceiling on the upstream call, in milliseconds. Absent means no ceiling of
   * our own beyond the caller's signal — which is the behaviour the capture
   * endpoints have always had, and adding one silently would turn a slow 7B
   * model on CPU into a timeout nobody asked for.
   */
  timeoutMs?: number;
  /**
   * Set by runJob from the input's own signal, so every provider call honours a
   * client hang-up without each of them threading it by hand. Callers do not set
   * it; a test may.
   */
  signal?: AbortSignal;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/** What the router decided, and why. */
export interface ResolvedJob {
  job: AiJob;
  provider: AiProviderId;
  source: AiSettingSource;
  /** Non-secret field values. Never contains a credential. */
  fields: Record<string, string>;
  /**
   * The credential in the clear, or null.
   *
   * This field is the reason ResolvedJob must never be serialised: it is the one
   * place in the app where a stored API key exists as a plain string outside the
   * header being built around it. describeResolution exists to give callers
   * something safe to send to a browser instead.
   */
  secret: string | null;
  model: string | null;
}

/** The safe half of a resolution: everything an admin screen may be shown. */
export interface ResolvedJobDescription {
  job: AiJob;
  provider: AiProviderId;
  source: AiSettingSource;
  model: string | null;
  /** True when the provider wants a credential and none is stored. */
  missingSecret: boolean;
}

export function describeResolution(resolved: ResolvedJob): ResolvedJobDescription {
  // `requiresSecret`, not "has a secret field": an openai-compatible gateway on a
  // trusted network and a webhook that authenticates by address are both complete
  // without a credential, and reporting them as missing one would send an
  // administrator to fix something that is not broken.
  return {
    job: resolved.job,
    provider: resolved.provider,
    source: resolved.source,
    model: resolved.model,
    missingSecret: requiresSecret(resolved.provider) && (resolved.secret ?? '').trim() === '',
  };
}

function builtinResolution(job: AiJob, source: AiSettingSource): ResolvedJob {
  return { job, provider: 'builtin', source, fields: {}, secret: null, model: null };
}

/**
 * Resolve the provider for one job.
 *
 * Never throws. A settings store that is down, a config that will not load and a
 * stored row an older version wrote all resolve to the next source down, ending
 * at `builtin`. That is the guarantee a deployment which has never opened the AI
 * section relies on: it behaves exactly as it did before this table existed.
 */
export async function resolveJob(
  job: AiJob,
  options: AiRouterOptions = {},
): Promise<ResolvedJob> {
  if (options.resolved && options.resolved.job === job) return options.resolved;

  const env = options.env ?? (process.env as Record<string, string | undefined>);

  // 1. What an admin saved.
  //
  // Wrapped, because resolveJob's contract is that it NEVER throws: the store
  // resolves to null on its own for the ordinary failures (no row, no token, no
  // database), but a rejection from somewhere unexpected must cost an installation
  // its saved preference and not its capture.
  const key = aiSettingKey(job);
  const storeOptions = options.settings ?? {};
  let stored: Awaited<ReturnType<typeof readSetting>> = null;
  let parsed: AiJobSetting | null = null;
  try {
    stored = await readSetting(key, storeOptions);
    if (stored !== null) parsed = parseAiJobSetting(job, stored.value);
  } catch (err) {
    console.error(
      `[ai-router] reading the setting for ${key} failed; falling back: ${boundedError(err)}`,
    );
  }

  if (stored !== null && parsed !== null) {
    // Only ask for the plaintext when the provider actually has a secret field: a
    // builtin row has none, and a failed decryption there would log a line about a
    // key that was never stored.
    const wantsSecret = providerById(parsed.provider)?.secretField !== null;
    let secret: string | null = null;
    if (wantsSecret) {
      try {
        secret = await openSettingSecret(key, storeOptions);
      } catch (err) {
        console.error(
          `[ai-router] opening the secret for ${key} failed; treating it as absent: ${boundedError(err)}`,
        );
      }
    }
    return {
      job,
      provider: parsed.provider,
      source: 'settings',
      fields: parsed.fields,
      secret,
      model: modelForJob(job, parsed),
    };
  }
  if (stored !== null) {
    // A row we cannot understand. Falling through is the difference between "the
    // admin's choice was ignored" and "capture stopped working"; the log line is
    // what tells an operator which happened.
    console.error(`[ai-router] the stored setting for ${key} could not be used; falling back`);
  }

  // 2. What the deployment's config says.
  const fromConfig = await configResolution(job, env);
  if (fromConfig !== null) return fromConfig;

  // 3. The stack's own models.
  return builtinResolution(job, 'default');
}

/**
 * The config's `capture` block read as a per-job provider.
 *
 * `mock` deliberately maps to nothing and falls through to `builtin`: it says
 * "this deployment runs no real capture", which is a statement about the
 * browser's simulation path, not about which model a server-side call should
 * use. A mock install never calls these endpoints, and if something does call
 * one, the built-in stack is a saner answer than a 503.
 */
async function configResolution(
  job: AiJob,
  env: Record<string, string | undefined>,
): Promise<ResolvedJob | null> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return null;
  }
  const capture = config.capture;

  if (capture.provider === 'local') return builtinResolution(job, 'config');

  if (capture.provider === 'openai' || capture.provider === 'anthropic') {
    // A provider that cannot do THIS job falls through to the built-in stack
    // rather than resolving and then refusing at call time: `capture.provider:
    // 'anthropic'` says nothing about transcription, because Anthropic has no
    // audio API, and an install that never opened the AI section must still
    // transcribe.
    if (!providerCanDoJob(capture.provider, job)) return null;
    const setting: AiJobSetting = {
      provider: capture.provider,
      fields: capture.model ? { model: capture.model } : {},
    };
    // The key comes from the named variable, exactly as api/capture/extract.ts has
    // always read it. No default credential here.
    const secret = env[capture.apiKeyEnv] ?? null;
    if (secret === null || secret.trim() === '') {
      // The variable NAME is logged and the value never is. A name is not a
      // secret — it is in viewpoint.config.ts, which install.sh writes and which
      // an operator is expected to read — and without it the only thing an
      // operator sees is `capture_not_configured`, which does not say which of the
      // deployment's six environment variables to go and set. This is a server
      // log line: it must not become part of an error message, because a response
      // body has no business naming a deployment's variable layout.
      console.error(
        `[ai-router] capture.apiKeyEnv names ${capture.apiKeyEnv}, which is not set; ` +
          `the ${job} job cannot use ${capture.provider} from the config`,
      );
    }
    return {
      job,
      provider: capture.provider,
      source: 'config',
      fields: setting.fields,
      secret,
      model: capture.model || modelForJob(job, setting),
    };
  }

  if (capture.provider === 'ollamaDirect') {
    // Ollama speaks the OpenAI chat API under /v1, so the compatible provider
    // reaches it with no key. It cannot transcribe audio, so that job falls
    // through to the built-in Whisper — which is what this config always meant,
    // since before batch BF the only transcription an ollamaDirect deployment had
    // was capture-service's.
    if (job === 'transcription') return null;
    return {
      job,
      provider: 'openaiCompatible',
      source: 'config',
      fields: { baseUrl: appendOnce(capture.baseUrl, '/v1'), model: capture.model },
      secret: null,
      model: capture.model || null,
    };
  }

  return null;
}

/** Append a path suffix unless the base already ends with it. */
function appendOnce(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

// ─── The entry point ────────────────────────────────────────────────────────

/**
 * Run one job with whichever provider the deployment resolved for it.
 *
 * @throws AiJobError for every failure mode, with a code from the vocabulary
 *         above. Throws nothing else: a parse failure from the strict card
 *         parser is converted, because its message quotes model output and an
 *         endpoint must not be one careless `err.message` away from sending that
 *         to a browser.
 */
export async function runJob(
  job: AiJob,
  input: AiJobInput,
  options: AiRouterOptions = {},
): Promise<AiJobResult> {
  // The caller's signal travels in the options rather than as a parameter on
  // every provider function: twelve call sites threading one AbortSignal is
  // twelve places to forget it, and a forgotten one keeps a cloud call running
  // for a client that hung up.
  const withSignal: AiRouterOptions =
    'signal' in input && input.signal
      ? { ...options, signal: input.signal }
      : options;
  const resolved = await resolveJob(job, withSignal);

  switch (job) {
    case 'transcription':
      return {
        job,
        transcript: await transcribe(resolved, input as TranscriptionInput, withSignal),
      };
    case 'cards':
      return {
        job,
        cards: await extractCards(resolved, input as CardsInput, withSignal),
      };
    case 'summary':
      return {
        job,
        summary: await summarize(resolved, input as SummaryInput, withSignal),
      };
  }
}

// ─── Transcription ──────────────────────────────────────────────────────────

async function transcribe(
  job: ResolvedJob,
  input: TranscriptionInput,
  options: AiRouterOptions,
): Promise<TranscriptChunk[]> {
  switch (job.provider) {
    case 'builtin':
      return builtinTranscribe(job, input, options);
    case 'openai':
      return segmentsToTranscript(
        await openAiTranscribe(job, input, options, OPENAI_BASE_URL, {
          Authorization: `Bearer ${requireSecret(job)}`,
        }),
      );
    case 'azureOpenai':
      return segmentsToTranscript(await azureTranscribe(job, input, options));
    case 'openaiCompatible':
      return segmentsToTranscript(
        await openAiTranscribe(
          job,
          input,
          options,
          requireHttpUrl(job, 'baseUrl'),
          job.secret ? { Authorization: `Bearer ${job.secret}` } : {},
        ),
      );
    case 'webhook':
      return segmentsToTranscript(await webhookTranscribe(job, input, options));
    // anthropic and gemini cannot do this job. parseAiJobSetting refuses the
    // combination and so does the dropdown, so reaching this branch means a row
    // was written by hand; failing closed beats guessing a provider.
    default:
      throw new AiJobError('capture_not_configured', 503, job.provider, {
        note: 'this provider cannot transcribe audio',
      });
  }
}

/**
 * POST the audio to capture-service's /transcribe.
 *
 * The shared secret is added HERE, from this container's own environment, exactly
 * as api/capture/local.ts used to add it and as deploy/nginx/app.conf still adds
 * it for the paths that bypass the api. The browser posts to a same-origin URL
 * and never learns it, which is the only reason capture-service can keep
 * publishing no port at all.
 */
async function builtinTranscribe(
  job: ResolvedJob,
  input: TranscriptionInput,
  options: AiRouterOptions,
): Promise<TranscriptChunk[]> {
  const base = await builtinBaseUrl(options);
  const payload = await postForm(
    options,
    job,
    `${base}/transcribe`,
    audioForm(input),
    builtinHeaders(options),
    true,
  );
  const transcript = parseBuiltinTranscript(payload, job);
  if (transcript.length === 0) {
    throw new AiJobError('empty_transcript', 422, job.provider, {
      note: 'nothing speech-like was found in the recording',
    });
  }
  return transcript;
}

function audioForm(input: TranscriptionInput, fieldName: string = AUDIO_FIELD): FormData {
  const form = new FormData();
  form.append(fieldName, input.audio, input.filename ?? 'audio.webm');
  return form;
}

function parseBuiltinTranscript(payload: unknown, job: ResolvedJob): TranscriptChunk[] {
  if (!isRecord(payload) || !Array.isArray(payload.transcript)) {
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider, {
      note: 'the transcription answer had no transcript array',
    });
  }
  const chunks: TranscriptChunk[] = [];
  for (const entry of payload.transcript) {
    if (!isRecord(entry)) continue;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    // A silent stretch produces no speech; skipping it is not data loss, and
    // keeping an empty chunk would put a blank line in the live transcript panel.
    if (text === '') continue;
    chunks.push({
      speakerId: typeof entry.speakerId === 'string' ? entry.speakerId : 'speaker-1',
      text,
      startMs: toInt(entry.startMs),
      endMs: toInt(entry.endMs),
    });
  }
  return chunks;
}

/**
 * The OpenAI-shaped transcription call, used for OpenAI itself and for any
 * OpenAI-compatible server that exposes /audio/transcriptions.
 *
 * Asks for verbose_json so the answer carries per-segment timings. A server that
 * ignores that and answers `{ text }` still works: one segment spanning nothing,
 * which is all a plain transcription answer can honestly claim.
 */
async function openAiTranscribe(
  job: ResolvedJob,
  input: TranscriptionInput,
  options: AiRouterOptions,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<WebhookSegment[]> {
  const model = requireModel(job);
  const form = audioForm(input, 'file');
  // OpenAI's own field name is `file`, not `audio`.
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  const payload = await postForm(
    options,
    job,
    `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
    form,
    headers,
  );
  return segmentsFromOpenAiAnswer(payload, job);
}

/** One reading of the OpenAI/Azure answer shape, so both agree by construction. */
function segmentsFromOpenAiAnswer(payload: unknown, job: ResolvedJob): WebhookSegment[] {
  if (!isRecord(payload)) {
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider);
  }
  if (Array.isArray(payload.segments)) {
    const parsed = parseWebhookSegmentsResponse(payload);
    if (parsed.value === null) {
      throw new AiJobError('capture_parse_error', 422, job.provider, {
        note: `the transcription answer was not usable (${parsed.reason ?? 'bad_segments'})`,
      });
    }
    return parsed.value;
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text === '') return [];
  return [{ start: 0, end: 0, text }];
}

async function azureTranscribe(
  job: ResolvedJob,
  input: TranscriptionInput,
  options: AiRouterOptions,
): Promise<WebhookSegment[]> {
  const url =
    `${azureRoot(job)}/openai/deployments/${encodeURIComponent(requireField(job, 'deployment'))}` +
    `/audio/transcriptions?api-version=${encodeURIComponent(azureApiVersion(job))}`;

  const form = audioForm(input, 'file');
  form.append('response_format', 'verbose_json');

  const payload = await postForm(options, job, url, form, {
    // Azure authenticates with `api-key`, not a bearer token.
    'api-key': requireSecret(job),
  });
  return segmentsFromOpenAiAnswer(payload, job);
}

async function webhookTranscribe(
  job: ResolvedJob,
  input: TranscriptionInput,
  options: AiRouterOptions,
): Promise<WebhookSegment[]> {
  const payload = await postForm(
    options,
    job,
    requireHttpUrl(job, 'url'),
    audioForm(input),
    webhookHeaders(job),
  );
  const parsed = parseWebhookSegmentsResponse(payload);
  if (parsed.value === null) {
    throw new AiJobError('capture_parse_error', 422, job.provider, {
      note: `the webhook's transcription answer was not usable (${parsed.reason ?? 'bad_segments'})`,
    });
  }
  return parsed.value;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

async function extractCards(
  job: ResolvedJob,
  input: CardsInput,
  options: AiRouterOptions,
): Promise<InsightCard[]> {
  const defaultAgentId = input.transcript[0]?.speakerId || undefined;
  const components = input.grounded?.componentTree;

  switch (job.provider) {
    // The built-in stack builds its own prompt: capture-service holds a
    // byte-identical copy of the TypeScript one, and sending our rendered text
    // to it would mean two prompts in one request.
    case 'builtin':
      return builtinCards(job, input, options);
    case 'openai':
      return parseCardsFromText(
        job,
        await openAiChat(job, options, OPENAI_BASE_URL, cardsPrompt(input), true, {
          Authorization: `Bearer ${requireSecret(job)}`,
        }),
        defaultAgentId,
        components,
      );
    case 'anthropic':
      return parseCardsFromText(
        job,
        await anthropicMessages(job, options, cardsPrompt(input), true),
        defaultAgentId,
        components,
      );
    case 'azureOpenai':
      return parseCardsFromText(
        job,
        await azureChat(job, options, cardsPrompt(input), true),
        defaultAgentId,
        components,
      );
    case 'gemini':
      return parseCardsFromText(
        job,
        await geminiGenerate(job, options, cardsPrompt(input), true),
        defaultAgentId,
        components,
      );
    case 'openaiCompatible':
      return parseCardsFromText(
        job,
        await openAiChat(
          job,
          options,
          requireHttpUrl(job, 'baseUrl'),
          cardsPrompt(input),
          true,
          job.secret ? { Authorization: `Bearer ${job.secret}` } : {},
        ),
        defaultAgentId,
        components,
      );
    case 'webhook':
      return webhookCards(job, input, options, defaultAgentId, components);
    default:
      throw new AiJobError('capture_not_configured', 503, job.provider);
  }
}

function cardsPrompt(input: CardsInput): string {
  const grounded = input.grounded;
  // `today` is left to the builder's own clock on purpose: the prompt renders
  // today's date plus a fortnight of weekday names so a small model can resolve
  // "by Friday" by lookup instead of arithmetic, and a stale date injected here
  // would silently break that.
  //
  // The grounded fields are MAPPED, not passed through, and the mapping is the
  // whole reason this function exists. `buildExtractionUserPrompt`'s fourth
  // parameter spells the component list `components`; the wire type
  // `GroundedCaptureContext` spells it `componentTree`. That parameter is
  // all-optional, so TypeScript happily accepts a `GroundedCaptureContext` and
  // `grounded.components` is then undefined at runtime — the model would be told
  // that `componentReference` MUST come from a list it was never shown, guess an
  // id, and have the card rejected by checkComponents. Every cloud extraction
  // with a model loaded would have failed, and nothing in the types would have
  // said why.
  return buildExtractionUserPrompt(
    input.transcript,
    input.context,
    undefined,
    grounded === undefined
      ? undefined
      : {
          components: grounded.componentTree,
          pointingSegments: grounded.pointingSegments,
          transcriptHint: grounded.transcriptHint,
        },
  );
}

/**
 * POST the transcript to capture-service's /extract.
 *
 * The grounded context travels as JSON in the body rather than as the string form
 * fields /capture takes, because this is a JSON request: there is no multipart
 * boundary to hide behind and no reason to make the receiving service parse the
 * same value twice.
 */
async function builtinCards(
  job: ResolvedJob,
  input: CardsInput,
  options: AiRouterOptions,
): Promise<InsightCard[]> {
  const base = await builtinBaseUrl(options);
  const body: Record<string, unknown> = {
    transcript: input.transcript,
    context: input.context,
  };
  const grounded = input.grounded;
  if (grounded?.componentTree && grounded.componentTree.length > 0) {
    body.componentTree = grounded.componentTree;
  }
  if (grounded?.pointingSegments && grounded.pointingSegments.length > 0) {
    body.pointingSegments = grounded.pointingSegments;
  }
  if (grounded?.transcriptHint && grounded.transcriptHint.length > 0) {
    body.transcriptHint = grounded.transcriptHint;
  }

  const payload = await postJson(
    options,
    job,
    `${base}/extract`,
    body,
    builtinHeaders(options),
    true,
  );
  // capture-service already parsed and validated the model output, but the
  // response crossed a network and a proxy: re-validating with the same strict
  // rules means a half-built card cannot reach the tracker even if a layer in
  // between changes shape. This is exactly what the browser's
  // LocalCaptureProvider has always done to this same body.
  return parseCardsFromPayload(
    job,
    payload,
    input.transcript[0]?.speakerId || undefined,
    grounded?.componentTree,
  );
}

async function webhookCards(
  job: ResolvedJob,
  input: CardsInput,
  options: AiRouterOptions,
  defaultAgentId: string | undefined,
  components: ComponentTreeEntry[] | undefined,
): Promise<InsightCard[]> {
  const payload = await postJson(
    options,
    job,
    requireHttpUrl(job, 'url'),
    buildWebhookCardsRequest(input.transcript, {
      slide: input.context,
      components: input.grounded?.componentTree,
    }),
    webhookHeaders(job),
  );
  return parseCardsFromPayload(job, payload, defaultAgentId, components);
}

/**
 * Validate a card list from ANY provider, then check it against the model tree.
 *
 * `components` is checked here rather than left to the parser so an invented
 * component id is refused for every provider alike: a card pointing at a part that
 * is not in the model sends a reviewer hunting for geometry that does not exist,
 * and "the cloud parser catches it" was never true of the local path.
 */
function checkComponents(
  job: ResolvedJob,
  cards: InsightCard[],
  components: ComponentTreeEntry[] | undefined,
): InsightCard[] {
  if (components && components.length > 0) {
    const ids = new Set(components.map((c) => c.id));
    const invented = cards.some(
      (card) => card.details.componentReference !== undefined && !ids.has(card.details.componentReference),
    );
    if (invented) {
      throw new AiJobError('capture_parse_error', 422, job.provider, {
        reason: 'invalid_card',
        note: 'a card named a component that is not in the model',
      });
    }
  }
  return cards;
}

/**
 * The two passes every provider's cards go through on their way out of the
 * router, so that no provider — cloud, built-in or webhook — is exempt from
 * either.
 *
 * The second pass is the deadline (docs/plan/14 batch BG). The extraction asks
 * for the spoken words as well as a date, and lib/capture/resolveDeadline turns
 * "by Friday" into a date in code, because the built-in 7B model gets that
 * arithmetic wrong even with a fortnight of weekday names in its prompt to look
 * it up in. Applied HERE rather than in each provider or in the browser, because
 * this is the one place all five cards paths meet: a resolution that lived in a
 * provider would leave the other four answering with the wrong date, and one
 * that lived in the browser would leave the api's own response — which the
 * capture-service and webhook clients read — wrong.
 */
function finishCards(
  job: ResolvedJob,
  cards: InsightCard[],
  components: ComponentTreeEntry[] | undefined,
): InsightCard[] {
  return applyResolvedDeadlines(checkComponents(job, cards, components));
}

/**
 * The cards job for a provider that answers with MODEL TEXT: OpenAI, Anthropic,
 * Azure, Gemini and anything OpenAI-compatible.
 *
 * `parseInsightCards` is the text-level entry point — it unwraps a markdown fence,
 * classifies prose as prose and truncated JSON as truncated, and only then
 * validates the envelope. That classification is what an operator gets back as
 * `reason`, and it is why a fence from Anthropic (which has no JSON mode) parses
 * instead of failing.
 */
function parseCardsFromText(
  job: ResolvedJob,
  raw: string,
  defaultAgentId: string | undefined,
  components: ComponentTreeEntry[] | undefined,
): InsightCard[] {
  try {
    return finishCards(job, parseInsightCards(raw, { defaultAgentId }), components);
  } catch (err) {
    if (err instanceof AiJobError) throw err;
    if (err instanceof CaptureExtractionError) {
      // Only the enum survives. The parser's message quotes the payload it
      // rejected, which quotes the meeting.
      throw new AiJobError('capture_parse_error', 422, job.provider, { reason: err.reason });
    }
    throw asAiJobError(err, job.provider);
  }
}

/**
 * The cards job for a provider that answers with a STRUCTURED payload: the
 * built-in stack and a webhook. Both return `{ cards: [...] }` rather than model
 * text, so the envelope-level validator is the right one — and it is the same one
 * the browser has always applied to a capture-service response.
 */
function parseCardsFromPayload(
  job: ResolvedJob,
  payload: unknown,
  defaultAgentId: string | undefined,
  components: ComponentTreeEntry[] | undefined,
): InsightCard[] {
  const parsed = parseWebhookCardsResponse(payload, { defaultAgentId });
  if (parsed.value === null) {
    throw new AiJobError('capture_parse_error', 422, job.provider, {
      reason: parsed.detail as CaptureParseFailureReason | undefined,
      note: parsed.reason ?? 'invalid_card',
    });
  }
  return finishCards(job, parsed.value, components);
}

// ─── Summary ────────────────────────────────────────────────────────────────

async function summarize(
  job: ResolvedJob,
  input: SummaryInput,
  options: AiRouterOptions,
): Promise<string> {
  const prompt = buildSummaryUserPrompt(input.transcript, input.cards, input.title);

  switch (job.provider) {
    case 'builtin':
      return builtinSummarize(job, input, options);
    case 'openai':
      return requireSummaryText(
        job,
        await openAiChat(job, options, OPENAI_BASE_URL, prompt, false, {
          Authorization: `Bearer ${requireSecret(job)}`,
        }, SUMMARY_SYSTEM_PROMPT),
      );
    case 'anthropic':
      return requireSummaryText(
        job,
        await anthropicMessages(job, options, prompt, false, SUMMARY_SYSTEM_PROMPT),
      );
    case 'azureOpenai':
      return requireSummaryText(
        job,
        await azureChat(job, options, prompt, false, SUMMARY_SYSTEM_PROMPT),
      );
    case 'gemini':
      return requireSummaryText(
        job,
        await geminiGenerate(job, options, prompt, false, SUMMARY_SYSTEM_PROMPT),
      );
    case 'openaiCompatible':
      return requireSummaryText(
        job,
        await openAiChat(
          job,
          options,
          requireHttpUrl(job, 'baseUrl'),
          prompt,
          false,
          job.secret ? { Authorization: `Bearer ${job.secret}` } : {},
          SUMMARY_SYSTEM_PROMPT,
        ),
      );
    case 'webhook':
      return webhookSummarize(job, input, options);
    default:
      throw new AiJobError('capture_not_configured', 503, job.provider);
  }
}

async function builtinSummarize(
  job: ResolvedJob,
  input: SummaryInput,
  options: AiRouterOptions,
): Promise<string> {
  const base = await builtinBaseUrl(options);
  const body: Record<string, unknown> = {
    transcript: input.transcript,
    cards: input.cards,
  };
  const title = input.title?.trim();
  if (title) body.title = title;

  const payload = await postJson(
    options,
    job,
    `${base}/summarize`,
    body,
    builtinHeaders(options),
    true,
  );
  return requireSummary(job, payload);
}

async function webhookSummarize(
  job: ResolvedJob,
  input: SummaryInput,
  options: AiRouterOptions,
): Promise<string> {
  const payload = await postJson(
    options,
    job,
    requireHttpUrl(job, 'url'),
    buildWebhookSummaryRequest(input.transcript, input.cards, input.title),
    webhookHeaders(job),
  );
  return requireSummary(job, payload);
}

function requireSummary(job: ResolvedJob, payload: unknown): string {
  const parsed = parseWebhookSummaryResponse(payload);
  if (parsed.value === null) {
    throw new AiJobError('capture_parse_error', 422, job.provider, {
      note: `the summary answer was not usable (${parsed.reason ?? 'bad_summary'})`,
    });
  }
  return parsed.value;
}

/**
 * The summary answer from a provider that replies with MODEL TEXT.
 *
 * Distinct from requireSummary, and the distinction is the whole difference
 * between the two families of provider: the built-in stack and a webhook answer
 * with a `{ summary }` envelope they built themselves, while OpenAI, Anthropic,
 * Azure, Gemini and anything OpenAI-compatible answer with the markdown the model
 * wrote. Handing that markdown to the envelope parser would report every cloud
 * summary as malformed, which is the kind of bug that reads as "the AI is broken"
 * rather than "the router is".
 *
 * An empty answer is still a failure: "it worked and said nothing" has to be
 * distinguishable from "it worked", or Test connection cannot do its job.
 */
function requireSummaryText(job: ResolvedJob, text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new AiJobError('capture_parse_error', 422, job.provider, {
      reason: 'prose',
      note: 'the model answered with no text',
    });
  }
  return trimmed;
}

// ─── The cloud calls ────────────────────────────────────────────────────────

/**
 * The OpenAI chat call, used for OpenAI and for every OpenAI-compatible server.
 *
 * `json` asks for `{ type: 'json_object' }`, which is how the cards job stops a
 * model from wrapping its answer in a markdown fence. The summary job must NOT
 * ask for it: its answer is markdown, and a JSON-mode model will either fence it
 * or escape it into unreadability.
 */
async function openAiChat(
  job: ResolvedJob,
  options: AiRouterOptions,
  baseUrl: string,
  userPrompt: string,
  json: boolean,
  headers: Record<string, string>,
  system: string = EXTRACTION_SYSTEM_PROMPT,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: requireModel(job),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
  };
  if (json) body.response_format = { type: 'json_object' };

  const payload = await postJson(
    options,
    job,
    `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    body,
    headers,
  );
  return openAiText(payload, job);
}

/**
 * The text of an OpenAI-shaped chat answer.
 *
 * `finish_reason: 'length'` is checked BEFORE the text is read: a truncated reply
 * is a different failure with a different fix (a longer ceiling, a shorter
 * meeting), and reporting it as unparseable JSON sends an operator looking at the
 * model instead of at the length.
 */
function openAiText(payload: unknown, job: ResolvedJob): string {
  if (!isRecord(payload)) {
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider);
  }
  const choices = payload.choices;
  const first = Array.isArray(choices) && choices.length > 0 ? choices[0] : null;
  if (!isRecord(first)) {
    throw wrongEnvelope(job, 'the chat answer had no choices[0]');
  }
  if (first.finish_reason === 'length') {
    throw new AiJobError('capture_output_truncated', 422, job.provider);
  }
  const message = first.message;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== 'string') {
    throw wrongEnvelope(job, 'the chat answer had no message.content string');
  }
  return content;
}

/**
 * The Anthropic Messages call.
 *
 * Anthropic has no JSON mode, so the cards job leans on the prompt's "single raw
 * JSON object" rule and the parser's fence unwrapping — exactly how the
 * browser-side Anthropic provider has always worked, and why the parser unwraps
 * fences at all.
 */
async function anthropicMessages(
  job: ResolvedJob,
  options: AiRouterOptions,
  userPrompt: string,
  _json: boolean,
  system: string = EXTRACTION_SYSTEM_PROMPT,
): Promise<string> {
  const payload = await postJson(
    options,
    job,
    `${ANTHROPIC_BASE_URL}/messages`,
    {
      model: requireModel(job),
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      'x-api-key': requireSecret(job),
      'anthropic-version': ANTHROPIC_VERSION,
    },
  );

  if (!isRecord(payload)) {
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider);
  }
  if (payload.stop_reason === 'max_tokens') {
    throw new AiJobError('capture_output_truncated', 422, job.provider);
  }
  const content = payload.content;
  if (!Array.isArray(content)) {
    throw wrongEnvelope(job, 'the answer had no content array');
  }
  const text = content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
  if (text.trim() === '') {
    throw new AiJobError('capture_parse_error', 422, job.provider, {
      reason: 'prose',
      note: 'the answer carried no text block',
    });
  }
  return text;
}

async function azureChat(
  job: ResolvedJob,
  options: AiRouterOptions,
  userPrompt: string,
  json: boolean,
  system: string = EXTRACTION_SYSTEM_PROMPT,
): Promise<string> {
  const url =
    `${azureRoot(job)}/openai/deployments/${encodeURIComponent(requireField(job, 'deployment'))}` +
    `/chat/completions?api-version=${encodeURIComponent(azureApiVersion(job))}`;

  // Azure addresses a model by DEPLOYMENT name, so there is no `model` in the
  // body: the path carries it. Sending one anyway makes some api-versions reject
  // the request outright.
  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
  };
  if (json) body.response_format = { type: 'json_object' };

  const payload = await postJson(options, job, url, body, { 'api-key': requireSecret(job) });
  return openAiText(payload, job);
}

function azureRoot(job: ResolvedJob): string {
  return requireHttpUrl(job, 'endpoint').replace(/\/+$/, '');
}

function azureApiVersion(job: ResolvedJob): string {
  return job.fields.apiVersion?.trim() || DEFAULT_AZURE_API_VERSION;
}

async function geminiGenerate(
  job: ResolvedJob,
  options: AiRouterOptions,
  userPrompt: string,
  json: boolean,
  system: string = EXTRACTION_SYSTEM_PROMPT,
): Promise<string> {
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
  if (json) generationConfig.responseMimeType = 'application/json';

  const payload = await postJson(
    options,
    job,
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(requireModel(job))}:generateContent`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig,
    },
    {
      // The key goes in a header, not in a query string. Gemini accepts both, and
      // a key in a URL is a key in every access log, proxy log and error message
      // between here and Google.
      'x-goog-api-key': requireSecret(job),
    },
  );

  if (!isRecord(payload)) {
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider);
  }
  const candidates = payload.candidates;
  const first = Array.isArray(candidates) && candidates.length > 0 ? candidates[0] : null;
  if (!isRecord(first)) {
    throw wrongEnvelope(job, 'the answer had no candidates[0]');
  }
  if (first.finishReason === 'MAX_TOKENS') {
    throw new AiJobError('capture_output_truncated', 422, job.provider);
  }
  const content = first.content;
  const parts = isRecord(content) ? content.parts : undefined;
  if (!Array.isArray(parts)) {
    throw wrongEnvelope(job, 'the answer had no content.parts array');
  }
  const text = parts
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
  if (text.trim() === '') {
    throw new AiJobError('capture_parse_error', 422, job.provider, {
      reason: 'prose',
      note: 'the answer carried no text part',
    });
  }
  return text;
}

function wrongEnvelope(job: ResolvedJob, note: string): AiJobError {
  return new AiJobError('capture_parse_error', 422, job.provider, {
    reason: 'wrong_envelope',
    note,
  });
}

// ─── Transport ──────────────────────────────────────────────────────────────

interface UpstreamAnswer {
  status: number;
  contentType: string;
  text: string;
}

/**
 * Send one request and translate every way it can fail.
 *
 * This is the single place an upstream's status, headers and body are looked at,
 * which is what makes the no-leak rule enforceable rather than a matter of each
 * provider remembering it.
 */
async function send(
  options: AiRouterOptions,
  job: ResolvedJob,
  url: string,
  init: RequestInit,
  propagateBuiltinCodes = false,
): Promise<UpstreamAnswer> {
  const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const where = pathOf(url);
  const caller = options.signal;
  const timeoutMs = options.timeoutMs;

  if (caller?.aborted) {
    // The client hung up before we started. Reporting an upstream failure here
    // would put a 502 in the log for a meeting nobody was waiting for.
    throw new AiJobError('request_closed', 499, job.provider, { note: where });
  }

  // One controller for both reasons to stop, so a caller's hang-up and our own
  // ceiling cannot race into two different aborts.
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  caller?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: controller.signal });
  } catch {
    // fetch's own message is dropped: it embeds the URL, which can carry a
    // deployment's internal hostname, a gateway path or a query string.
    if (caller?.aborted) {
      throw new AiJobError('request_closed', 499, job.provider, { note: where });
    }
    if (controller.signal.aborted && timeoutMs !== undefined) {
      throw new AiJobError('capture_upstream_timeout', 504, job.provider, { note: where });
    }
    throw new AiJobError('capture_upstream_unreachable', 502, job.provider, { note: where });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    caller?.removeEventListener('abort', onCallerAbort);
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    // An unreadable body is just no body: the status still decides the outcome.
  }

  if (!response.ok) {
    logExcerpt(`${job.provider} ${where} returned ${response.status}`, text, redactionList(job, options));
    // The built-in stack is OUR OWN service and speaks the browser's error
    // vocabulary already. Forwarding its code — rather than flattening every
    // failure into capture_upstream_error — is what keeps "the recording is
    // larger than the ceiling" and "the model is not pulled" distinguishable in
    // the UI, exactly as they were while nginx proxied straight to it.
    if (propagateBuiltinCodes) {
      const forwarded = builtinCodeFrom(text, response.status, job);
      if (forwarded !== null) throw forwarded;
    }
    // Always 502 for anything else, whatever the upstream said. Forwarding its
    // status would let a provider's 401 arrive at the browser as ours, where the
    // access layer reads it as "this person is not signed in" and sends them to a
    // door they were already through.
    throw new AiJobError('capture_upstream_error', 502, job.provider, {
      note: `${where} returned ${response.status}`,
    });
  }

  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text };
}

/** The shape capture-service's own errors.py guarantees: `[a-z_]+`, no content. */
const SAFE_UPSTREAM_CODE = /^[a-z_]{1,64}$/;

/**
 * The codes worth forwarding from the built-in stack.
 *
 * An allowlist rather than "anything matching the pattern": a code the browser has
 * no case for would render as a bare string, and a code an upstream invented
 * would render as a sentence we did not write. Every name here has a `case` in
 * lib/connectors/capture/extractClient.ts or local.ts.
 */
const BUILTIN_CODES: ReadonlySet<string> = new Set([
  'upload_too_large',
  'empty_upload',
  'empty_transcript',
  'transcriber_unavailable',
  'transcription_failed',
  'transcript_too_large',
  'capture_upstream_unreachable',
  'capture_upstream_timeout',
  'capture_endpoint_unavailable',
  'capture_model_not_found',
  'capture_upstream_error',
  'capture_parse_error',
  'capture_output_truncated',
]);

/** Numeric extras that are safe to forward: a ceiling and an index, never text. */
const BUILTIN_NUMBER_EXTRAS = ['maxUploadBytes', 'cardIndex'] as const;

const PARSE_REASONS: ReadonlySet<string> = new Set([
  'markdown_fenced',
  'prose',
  'truncated_json',
  'malformed_json',
  'wrong_envelope',
  'extra_fields',
  'invalid_card',
]);

/**
 * Read capture-service's own error body and re-raise it as ours.
 *
 * The status travels unchanged, which is what nginx did when it proxied
 * /api/capture/local straight to the service: a 413 stays a 413 and a 422 stays a
 * 422. The body is read ONLY for a code on the allowlist plus a number or an enum
 * — never for its prose, because capture-service's own contract is that the
 * message stays in its log.
 */
function builtinCodeFrom(text: string, status: number, job: ResolvedJob): AiJobError | null {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;

  const code = body.error;
  if (typeof code !== 'string' || !SAFE_UPSTREAM_CODE.test(code) || !BUILTIN_CODES.has(code)) {
    return null;
  }

  const extras: Record<string, number | string> = {};
  for (const name of BUILTIN_NUMBER_EXTRAS) {
    const value = body[name];
    if (typeof value === 'number' && Number.isFinite(value)) extras[name] = value;
  }
  const reason =
    typeof body.reason === 'string' && PARSE_REASONS.has(body.reason)
      ? (body.reason as CaptureParseFailureReason)
      : undefined;

  return new AiJobError(code, status, job.provider, {
    reason,
    extras,
    note: `the built-in stack reported ${code}`,
  });
}

async function postJson(
  options: AiRouterOptions,
  job: ResolvedJob,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  propagateBuiltinCodes = false,
): Promise<unknown> {
  const answer = await send(
    options,
    job,
    url,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    propagateBuiltinCodes,
  );
  return decodeJson(answer, job, pathOf(url), redactionList(job, options));
}

async function postForm(
  options: AiRouterOptions,
  job: ResolvedJob,
  url: string,
  form: FormData,
  headers: Record<string, string>,
  propagateBuiltinCodes = false,
): Promise<unknown> {
  // No Content-Type: the runtime owns the multipart boundary and picks it when
  // FormData is the body. Setting one here is how an upload silently arrives
  // unparseable.
  const answer = await send(
    options,
    job,
    url,
    {
      method: 'POST',
      headers: { Accept: 'application/json', ...headers },
      body: form,
    },
    propagateBuiltinCodes,
  );
  return decodeJson(answer, job, pathOf(url), redactionList(job, options));
}

/**
 * A 200 that is not JSON is the classic misconfiguration: a proxy, an SPA
 * fallback or the wrong port answers 200 text/html for any path. Named here
 * rather than surfaced as a JSON decode error, because "something else is
 * answering on that address" is a different fix from "the model said something
 * odd".
 */
function decodeJson(
  answer: UpstreamAnswer,
  job: ResolvedJob,
  where: string,
  secrets: string[],
): unknown {
  if (!answer.contentType.includes('application/json')) {
    // The content type is logged when there is one and the body when there is not:
    // a proxy's HTML error page is the diagnostic, and it is redacted like
    // everything else that comes back from an upstream.
    logExcerpt(
      `${job.provider} ${where} answered ${answer.status}`,
      answer.contentType || answer.text,
      secrets,
    );
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider, {
      note: `${where} answered ${answer.status} with ${answer.contentType || 'no content type'}`,
    });
  }
  try {
    return JSON.parse(answer.text) as unknown;
  } catch {
    throw new AiJobError('capture_endpoint_unavailable', 502, job.provider, {
      note: `${where} returned a body that was not valid JSON`,
    });
  }
}

/** The path only, for log lines and error notes — never a query string. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(url)';
  }
}

// ─── Field access ───────────────────────────────────────────────────────────

function requireField(job: ResolvedJob, name: string): string {
  const value = job.fields[name]?.trim();
  if (!value) {
    throw new AiJobError('capture_not_configured', 503, job.provider, {
      note: `the ${name} field is not set`,
    });
  }
  return value;
}

/**
 * A field that must be an absolute http(s) URL.
 *
 * Checked here rather than trusted from the form: a stored setting can have been
 * written by an older version of the app, by a script, or by an operator with a
 * SQL client, and `fetch('file:///etc/passwd')` from a container is not a
 * hypothetical. Relative and non-http schemes are refused outright.
 */
function requireHttpUrl(job: ResolvedJob, name: string): string {
  const raw = requireField(job, name);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AiJobError('capture_not_configured', 503, job.provider, {
      note: `the ${name} field is not a valid URL`,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiJobError('capture_not_configured', 503, job.provider, {
      note: `the ${name} field must be an http or https URL`,
    });
  }
  return raw;
}

function requireModel(job: ResolvedJob): string {
  const model = job.model;
  if (!model) {
    throw new AiJobError('capture_not_configured', 503, job.provider, {
      note: 'no model is configured for this job',
    });
  }
  return model;
}

/**
 * The credential, or a refusal.
 *
 * A provider whose secretField is null never reaches here. One that has a secret
 * field but no stored value does, and the answer is a 503 naming the missing
 * field rather than an upstream 401 whose body would be logged.
 */
function requireSecret(job: ResolvedJob): string {
  if (job.secret && job.secret.trim() !== '') return job.secret.trim();
  const name = providerById(job.provider)?.secretField ?? 'credential';
  throw new AiJobError('capture_not_configured', 503, job.provider, {
    note: `no ${name} is stored for this job`,
  });
}

function webhookHeaders(job: ResolvedJob): Record<string, string> {
  const headers: Record<string, string> = {};
  const name = job.fields.headerName?.trim();
  // Both halves are required: a header name with no value would send an empty
  // credential, and a value with no name has nowhere to go.
  if (name && job.secret) headers[name] = job.secret;
  return headers;
}

// ─── The built-in stack's address ───────────────────────────────────────────

/**
 * Where capture-service is, as THIS container reaches it — reduced to an ORIGIN.
 *
 * CAPTURE_SERVICE_URL first, because it is the operator's explicit answer and the
 * one docker-compose sets for the api container; then capture.serviceUrl from the
 * config, which is where a `capture.provider: 'local'` deployment already names
 * it. Neither means the built-in stack is not part of this installation — a
 * configuration fact, not an outage, and reported as one.
 *
 * The reduction to origin + no query is not tidiness. capture-service mounts its
 * routes at the root, so a configured PATH would end up glued in front of
 * `/transcribe` and 404 (which this module would then report as an unreachable
 * upstream, sending an operator to look at the network). And a configured QUERY
 * STRING is exactly where a token lands — in the URL, then in this container's
 * outbound request log and in any access log in between. Discarding both is what
 * api/capture/_proxyShared.ts's buildUpstreamUrl did before batch BF deleted it;
 * install.sh accepts any absolute http(s) URL for this field, so the case is
 * reachable from the installer rather than hypothetical.
 */
export async function builtinBaseUrl(options: AiRouterOptions = {}): Promise<string> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const configured =
    env.CAPTURE_SERVICE_URL?.trim() || (await configServiceUrl()) || '';

  if (configured === '') {
    throw new AiJobError('capture_not_configured', 503, 'builtin', {
      note:
        'the built-in stack is not configured: set CAPTURE_SERVICE_URL, or ' +
        "capture.provider 'local' with capture.serviceUrl in viewpoint.config.ts",
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new AiJobError('capture_not_configured', 503, 'builtin', {
      note: 'the built-in stack address is not a valid URL',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiJobError('capture_not_configured', 503, 'builtin', {
      note: 'the built-in stack address must be an http or https URL',
    });
  }
  return parsed.origin;
}

async function configServiceUrl(): Promise<string | null> {
  try {
    const config = await loadConfig();
    if (config.capture.provider === 'local') return config.capture.serviceUrl;
  } catch {
    // A config that will not load is not a reason to invent an address.
  }
  return null;
}

/**
 * The shared-secret header capture-service expects, read from this container's
 * own environment.
 *
 * Same rule api/capture/local.ts and deploy/nginx/app.conf follow: the secret
 * comes from process.env, goes in exactly one header, and never reaches a
 * browser. An empty CAPTURE_SHARED_SECRET means capture-service has
 * authentication off — only safe because it publishes no port — and the header is
 * then omitted rather than sent empty.
 */
function builtinHeaders(options: AiRouterOptions): Record<string, string> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const secret = env[CAPTURE_SHARED_SECRET_ENV] ?? '';
  const headers: Record<string, string> = {};
  if (secret.trim() !== '') headers[CAPTURE_AUTH_HEADER] = secret;
  return headers;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * The error a caller should report when the router threw something unexpected.
 *
 * Every throw from this module is an AiJobError, or a CaptureExtractionError from
 * the strict parser it delegates to; anything else is a bug, and a bug's message
 * is the one thing here that might quote a transcript (a TypeError from deep
 * inside a provider's answer, say). Endpoints use this so that "we do not know
 * what happened" is what reaches the browser, with the detail in the server log.
 */
export function asAiJobError(err: unknown, provider: AiProviderId = 'builtin'): AiJobError {
  if (err instanceof AiJobError) return err;
  if (err instanceof CaptureExtractionError) {
    return new AiJobError('capture_parse_error', 422, provider, { reason: err.reason });
  }
  // Bounded, because this is the one log line in the module that renders a value
  // this repo did not construct: an upstream client that throws
  // `new Error(JSON.stringify(payload))` would otherwise put the meeting in the
  // log. Not flattened, because a stack trace is the useful part of a bug.
  console.error(
    `[ai-router] an unexpected failure was translated to a generic error: ${boundedError(err)}`,
  );
  return new AiJobError('capture_upstream_error', 502, provider, {
    note: 'the request could not be completed',
  });
}

/**
 * A submitted setting, validated for one job.
 *
 * Exported for POST /api/admin/ai. The admin screen sends the same shape the
 * store keeps, and refusing a provider that cannot do the job HERE — rather than
 * at the next capture — is what stops an operator saving "Anthropic for
 * transcription" and finding out during a meeting.
 */
export function validateSubmittedSetting(job: AiJob, value: unknown): AiJobSetting | null {
  return parseAiJobSetting(job, value);
}

// ─── What "Test connection" runs ────────────────────────────────────────────

/**
 * A two-line transcript, for the admin screen's Test connection.
 *
 * Real enough that a working provider answers it with a card, and small enough
 * that the test costs one short call. The words are this app's own domain — a
 * design review about a bracket — so a human reading the provider's log sees a
 * plausible request rather than "test test test".
 */
export const TEST_TRANSCRIPT: TranscriptChunk[] = [
  {
    speakerId: 'speaker-1',
    text: 'The bracket weld will crack before we reach the yield target.',
    startMs: 0,
    endMs: 4200,
  },
  {
    speakerId: 'speaker-2',
    text: 'Then we re-run the stress simulation on the revised bracket this week.',
    startMs: 4200,
    endMs: 8400,
  },
];

export const TEST_SLIDE_CONTEXT: SlideContext = {
  agendaIdx: 0,
  slideTitle: 'Connection test',
};

export const TEST_SUMMARY_TITLE = 'Connection test';

/**
 * A one-second silent WAV, generated rather than shipped.
 *
 * Test connection has to exercise the real transcription path, and a real
 * provider rejects an empty or truncated upload. 44 bytes of RIFF header plus
 * 16 kHz mono 16-bit silence is the smallest thing every ASR stack accepts as a
 * valid one-second recording — and generating it here means no binary fixture in
 * the repository and no chance of a test file drifting from what the code sends.
 */
export function silentWav(seconds = 1, sampleRate = 16000): Blob {
  const dataBytes = seconds * sampleRate * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);
  // The data chunk stays zeroed: silence.

  return new Blob([buffer], { type: 'audio/wav' });
}
