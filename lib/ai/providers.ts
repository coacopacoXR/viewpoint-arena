// The AI providers this app can be pointed at, described once (plan 14, BF).
//
// One typed description per provider, read by BOTH sides of the feature:
//
//   * lib/ai/router.ts (server) uses `jobs` to refuse a provider that cannot do
//     the job it was configured for, `secretField` to know which stored value is
//     the credential, and `defaultModel` to fill a blank model in;
//   * the admin console's AI section (browser) uses `label`, `fields`, `help` and
//     `models` to render the form — including which inputs are passwords and
//     which jobs each provider may be offered for.
//
// Describing the providers in one place is what stops the form and the router
// disagreeing: a provider added here appears in the right dropdowns, with the
// right fields, and is accepted by the router, with no second list to keep in
// step. Because the browser imports this file it must stay FREE of anything
// server-only: no node: builtins, no process.env, no default credential, no
// upstream URL that is not already public knowledge. The endpoints the router
// calls live in lib/ai/router.ts.
//
// `builtin` is first in every list on purpose. It is what a fresh install runs
// and what the admin screen offers by default: the bundled Whisper and Qwen on
// this server, with no account, no key and no egress.

/**
 * The three things an AI is asked to do here.
 *
 * Separate jobs rather than one "which AI" setting, because a company may
 * transcribe locally and summarise in the cloud, or the reverse: audio of an
 * engineering review is the most sensitive artefact in the building, while the
 * minutes are the one thing that has to read well.
 */
export type AiJob = 'transcription' | 'cards' | 'summary';

export const AI_JOBS: readonly AiJob[] = ['transcription', 'cards', 'summary'];

export const AI_JOB_LABELS: Record<AiJob, string> = {
  transcription: 'Transcription',
  cards: 'Cards (risks, actions, rationale)',
  summary: 'Meeting summary',
};

export type AiProviderId =
  | 'builtin'
  | 'openai'
  | 'anthropic'
  | 'azureOpenai'
  | 'gemini'
  | 'openaiCompatible'
  | 'webhook';

/**
 * How the admin form renders a field.
 *
 * `password` is the only kind whose value is never returned by the read API;
 * `model` is a text input with a datalist of suggestions (free text always
 * allowed, because a list of models is stale the week it is written);
 * `url` is validated as an absolute http(s) URL on both sides.
 */
export type AiFieldKind = 'text' | 'url' | 'password' | 'model';

export interface AiField {
  /** The key this value is stored under, and the name the router reads. */
  name: string;
  label: string;
  kind: AiFieldKind;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface AiProviderDescriptor {
  id: AiProviderId;
  label: string;
  /** The jobs this provider can do. A dropdown never offers it for another. */
  jobs: readonly AiJob[];
  fields: readonly AiField[];
  /**
   * The one field whose value is a credential, or null when the provider has
   * none. Stored encrypted (lib/ai/secretBox.ts), rendered as a password input,
   * and reported back to the screen as `{ set: true, last4 }` — never as the
   * value.
   */
  secretField: string | null;
  /** Model suggestions per job, newest-first. Free text is always allowed. */
  models: Readonly<Partial<Record<AiJob, readonly string[]>>>;
  /** The model used when the admin leaves the field blank, per job. */
  defaultModel: Readonly<Partial<Record<AiJob, string>>>;
  /** One or two sentences shown under the provider in the dropdown. */
  help?: string;
}

const API_KEY_FIELD: AiField = {
  name: 'apiKey',
  label: 'API key',
  kind: 'password',
  required: true,
  placeholder: 'sk-…',
  help: 'Stored encrypted on this server and never sent back to the browser. Leave blank when saving to keep the key already stored.',
};

const OPENAI_CHAT_MODELS = [
  'gpt-5-mini',
  'gpt-5',
  'gpt-4.1-mini',
  'gpt-4o-mini',
] as const;

const OPENAI_AUDIO_MODELS = [
  'gpt-4o-mini-transcribe',
  'whisper-1',
] as const;

const ANTHROPIC_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-1',
  'claude-haiku-4-5',
] as const;

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
] as const;

export const AI_PROVIDERS: readonly AiProviderDescriptor[] = [
  {
    id: 'builtin',
    label: 'Built-in (this server)',
    jobs: ['transcription', 'cards', 'summary'],
    fields: [],
    secretField: null,
    models: {},
    defaultModel: {},
    help: 'The bundled Whisper and Qwen running in this installation. No account, no key, and nothing leaves the machine. The default.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    jobs: ['transcription', 'cards', 'summary'],
    fields: [API_KEY_FIELD, { name: 'model', label: 'Model', kind: 'model', required: false }],
    secretField: 'apiKey',
    models: { transcription: OPENAI_AUDIO_MODELS, cards: OPENAI_CHAT_MODELS, summary: OPENAI_CHAT_MODELS },
    defaultModel: { transcription: 'gpt-4o-mini-transcribe', cards: 'gpt-4o-mini', summary: 'gpt-4o-mini' },
    help: 'Audio models for transcription, chat models for cards and summary — each job has its own setting, so pick the model that fits the job.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    // No transcription: the Messages API takes text and images, not audio.
    jobs: ['cards', 'summary'],
    fields: [API_KEY_FIELD, { name: 'model', label: 'Model', kind: 'model', required: false }],
    secretField: 'apiKey',
    models: { cards: ANTHROPIC_MODELS, summary: ANTHROPIC_MODELS },
    defaultModel: { cards: 'claude-sonnet-4-5', summary: 'claude-sonnet-4-5' },
  },
  {
    id: 'azureOpenai',
    label: 'Azure OpenAI',
    jobs: ['transcription', 'cards', 'summary'],
    fields: [
      {
        name: 'endpoint',
        label: 'Resource endpoint',
        kind: 'url',
        required: true,
        placeholder: 'https://contoso.openai.azure.com',
        help: 'The resource root, with no path. The deployment name below is what selects the model.',
      },
      { ...API_KEY_FIELD, label: 'Key', placeholder: 'One of the resource\u2019s two keys' },
      {
        name: 'deployment',
        label: 'Deployment name',
        kind: 'text',
        required: true,
        placeholder: 'gpt-4o-mini',
        help: 'The name you gave the deployment in Azure AI Foundry, not the underlying model name.',
      },
      {
        name: 'apiVersion',
        label: 'API version',
        kind: 'text',
        required: false,
        placeholder: '2024-10-01-preview',
        help: 'Leave blank for the version this app was tested against.',
      },
    ],
    secretField: 'apiKey',
    models: {},
    defaultModel: {},
    help: 'Azure addresses a model by deployment name, so there is no model list here: type the deployment you created.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    // No transcription: this app sends whole recordings, and the Gemini file
    // API needs an upload step and a project id that a single key field cannot
    // carry. A deployment that wants Gemini transcription can use the
    // OpenAI-compatible provider against its own gateway, or a webhook.
    jobs: ['cards', 'summary'],
    fields: [API_KEY_FIELD, { name: 'model', label: 'Model', kind: 'model', required: false }],
    secretField: 'apiKey',
    models: { cards: GEMINI_MODELS, summary: GEMINI_MODELS },
    defaultModel: { cards: 'gemini-2.5-flash', summary: 'gemini-2.5-flash' },
  },
  {
    id: 'openaiCompatible',
    label: 'OpenAI-compatible endpoint',
    jobs: ['transcription', 'cards', 'summary'],
    fields: [
      {
        name: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        required: true,
        placeholder: 'https://gateway.acme.com/v1',
        help: 'The root that /chat/completions and /audio/transcriptions hang off. Include the /v1 when the server expects it.',
      },
      { ...API_KEY_FIELD, required: false, help: 'Optional — leave blank for a server on your own network that authenticates by address.' },
      { name: 'model', label: 'Model', kind: 'model', required: true, placeholder: 'qwen2.5:7b' },
    ],
    secretField: 'apiKey',
    models: {},
    defaultModel: {},
    help: 'Base URL, key and model name — which covers vLLM, LM Studio, LiteLLM, Mistral, Groq, Together, Azure AI Foundry\u2019s OpenAI-compatible route and most enterprise AI gateways. If your server speaks the OpenAI API, it works here.',
  },
  {
    id: 'webhook',
    label: 'Your own service',
    jobs: ['transcription', 'cards', 'summary'],
    fields: [
      {
        name: 'url',
        label: 'URL',
        kind: 'url',
        required: true,
        placeholder: 'https://ai.acme.com/viewpoint',
        help: 'Receives our JSON and answers with ours. The contract, with request and response examples, is in api/ai/WEBHOOK.md.',
      },
      {
        name: 'headerName',
        label: 'Header name',
        kind: 'text',
        required: false,
        placeholder: 'X-Api-Key',
        help: 'Optional. Sent with the value below on every request.',
      },
      {
        name: 'headerValue',
        label: 'Header value',
        kind: 'password',
        required: false,
        help: 'Optional, and stored encrypted. Leave blank when saving to keep the value already stored.',
      },
    ],
    secretField: 'headerValue',
    models: {},
    defaultModel: {},
    help: 'For an enterprise that already runs its own AI: we post the transcript and context, you post back cards, minutes or segments. Whatever model sits behind your URL is your business, not ours.',
  },
];

export function providerById(id: AiProviderId): AiProviderDescriptor | null {
  return AI_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** The providers a dropdown may offer for one job, in the order they are listed. */
export function providersForJob(job: AiJob): AiProviderDescriptor[] {
  return AI_PROVIDERS.filter((p) => p.jobs.includes(job));
}

export function providerCanDoJob(id: AiProviderId, job: AiJob): boolean {
  return providerById(id)?.jobs.includes(job) ?? false;
}

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === 'string' && AI_PROVIDERS.some((p) => p.id === value);
}

/**
 * Whether a provider's credential is REQUIRED rather than merely supported.
 *
 * The distinction is not cosmetic and it is not derivable from `secretField`:
 * `openaiCompatible` and `webhook` both have a secret field and both work without
 * one, because vLLM on a trusted network and an internal gateway that
 * authenticates by address are the main reason those two providers exist. Only a
 * provider whose secret field is marked required can be reported as misconfigured
 * for having none — reporting the others would tell an administrator to fix
 * something that is not broken.
 */
export function requiresSecret(id: AiProviderId): boolean {
  const provider = providerById(id);
  if (provider === null || provider.secretField === null) return false;
  return provider.fields.some((f) => f.name === provider.secretField && f.required);
}

/**
 * Whether a value is an absolute http(s) URL.
 *
 * Exported because both sides need the same answer: the admin form validates
 * before it enables Save, and parseAiJobSetting validates before it accepts a
 * setting. Two spellings of this rule is how a form accepts a URL the router then
 * refuses, which reads to an administrator as "Save did nothing".
 *
 * Relative URLs are refused even though `fetch` would resolve them against this
 * server: a webhook pointing at our own origin is a request loop, and a `file:` or
 * `data:` URL from a container is not a hypothetical.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

// ─── The stored setting ─────────────────────────────────────────────────────
//
// One row of app_settings per job: the key is `ai.<job>`, `value` holds the
// shape below and `secret` holds the encrypted credential. The shape is
// deliberately tiny — a provider id and a flat bag of strings — so a setting
// written by an older version of this app still parses, and so nothing in the
// row needs a migration when a provider grows a field.

export const AI_SETTING_KEY_PREFIX = 'ai.';

export function aiSettingKey(job: AiJob): string {
  return `${AI_SETTING_KEY_PREFIX}${job}`;
}

export interface AiJobSetting {
  provider: AiProviderId;
  /** Non-secret field values only. The credential lives in the secret column. */
  fields: Record<string, string>;
}

/**
 * Parse a stored (or submitted) setting.
 *
 * Strict, and returns null rather than throwing: this reads a database row that
 * an older version of the app, or an operator with a SQL client, may have
 * written, and a setting the router cannot understand must degrade to the
 * configured default rather than take capture down. Unknown providers and
 * providers that cannot do the job are both refused here, which is what makes
 * the router's own dispatch total.
 */
export function parseAiJobSetting(job: AiJob, value: unknown): AiJobSetting | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isAiProviderId(record.provider)) return null;
  if (!providerCanDoJob(record.provider, job)) return null;

  const provider = providerById(record.provider);
  if (provider === null) return null;

  const fields: Record<string, string> = {};
  const raw = record.fields;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    return null;
  }
  const source = (raw ?? {}) as Record<string, unknown>;
  for (const field of provider.fields) {
    // The secret field is never read out of `fields`: it belongs in the secret
    // column. A row that smuggles it in here is treated as not having one,
    // which is the safe reading — the value would otherwise be returned to the
    // admin screen by a code path that believes it only holds non-secrets.
    if (field.name === provider.secretField) continue;
    const entry = source[field.name];
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    // A URL field is checked HERE rather than left to the router's call site, so
    // the admin console can refuse `http//typo` at Save instead of storing a
    // setting that fails during a meeting. It also means a row written by an
    // older version, by a script or by an operator with a SQL client cannot point
    // the router at `file:///etc/passwd`.
    if (field.kind === 'url' && !isAbsoluteHttpUrl(value)) return null;
    fields[field.name] = value;
  }

  const missing = provider.fields.some(
    (f) =>
      f.required &&
      f.name !== provider.secretField &&
      (fields[f.name] ?? '').trim() === '',
  );
  if (missing) return null;

  return { provider: record.provider, fields };
}

/**
 * The model a job should ask for: the admin's value when they typed one,
 * otherwise the provider's default for that job, otherwise null (a provider
 * with no model field, like `builtin` or `webhook`).
 */
export function modelForJob(
  job: AiJob,
  setting: AiJobSetting,
): string | null {
  const provider = providerById(setting.provider);
  if (provider === null) return null;
  if (!provider.fields.some((f) => f.name === 'model' && f.kind === 'model')) return null;
  const typed = setting.fields.model?.trim();
  if (typed) return typed;
  return provider.defaultModel[job] ?? null;
}

// ─── The admin screen's "in use now" line ───────────────────────────────────

/** Where the setting the router will actually use came from. */
export type AiSettingSource = 'settings' | 'config' | 'default';

export const AI_SOURCE_LABELS: Record<AiSettingSource, string> = {
  settings: 'set here',
  config: 'viewpoint.config.ts',
  default: 'default',
};

/**
 * One line under a job's card: what is running, and who decided it.
 *
 * Names the provider and the model, never a key, an endpoint or an env var
 * name — this string is rendered in a browser, and which host an org's AI
 * gateway lives on is deployment internals the same way db.probeUrl is.
 */
export function describeInUse(
  job: AiJob,
  providerId: AiProviderId,
  model: string | null,
  source: AiSettingSource,
): string {
  const provider = providerById(providerId);
  const label = provider?.label ?? providerId;
  const what = providerId === 'builtin' ? BUILTIN_DESCRIPTION : label;
  const withModel = model ? `${what} ${model}` : what;
  return `${withModel} · ${AI_SOURCE_LABELS[source]}`;
}

/**
 * What "built-in" means, in the words the screen shows.
 *
 * Names the models the bundled stack actually runs (CAPTURE_WHISPER_MODEL and
 * CAPTURE_OLLAMA_MODEL in docker-compose.yml default to base.en and qwen2.5:7b)
 * so an operator can tell this apart from a cloud provider at a glance.
 */
export const BUILTIN_DESCRIPTION = 'Built-in Whisper and Qwen on this server';
