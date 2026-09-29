// @vitest-environment node
//
// Tests for lib/ai/router.ts — the one place that decides which AI does a job,
// and the one place that talks to any of them.
//
// Three things are under test, in that order of importance:
//
//   1. RESOLUTION. app_settings → viewpoint.config.ts → builtin, and a failure at
//      any rung falls through rather than throwing. A deployment that has never
//      opened the AI section has to behave exactly as it did before this existed.
//   2. THE REQUEST EACH PROVIDER GETS. URL, headers and body, with fetch stubbed.
//      A wrong header name is a silent 401 in production and nothing in a browser
//      can diagnose it, so the shapes are pinned here instead.
//   3. NO LEAKS. The transcript, the credential, the upstream body and the model's
//      output are the four things that must never appear in a failure. Every error
//      test asserts on `err.message`, because a message is what an endpoint is one
//      careless `err.message` away from forwarding.
//
// Nothing here touches the network: globalThis.fetch is never used, every call goes
// through the `fetchFn` option.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../config/loadConfig.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/loadConfig.ts')>()),
  loadConfig: vi.fn(),
}));

vi.mock('../settingsStore.ts', () => ({
  readSetting: vi.fn(),
  openSettingSecret: vi.fn(),
  probeSettingsStore: vi.fn(),
  writeSetting: vi.fn(),
  deleteSetting: vi.fn(),
  resolveSettingsServerUrl: vi.fn(),
}));

import { loadConfig } from '../../config/loadConfig.ts';
import { readSetting, openSettingSecret } from '../settingsStore.ts';
import type { ViewpointConfig } from '../../config/schema.ts';
import type { InsightCard } from '../../../types.ts';
import type { SlideContext, TranscriptChunk } from '../../connectors/capture/types.ts';
import { EXTRACTION_SYSTEM_PROMPT } from '../../connectors/capture/extractionPrompt.ts';
import { SUMMARY_SYSTEM_PROMPT } from '../../ai/summaryPrompt.ts';

/** Marker text: if this reaches an error message, the transcript leaked. */
const SENTINEL = 'SENTINEL-the-yield-blocker-nobody-may-echo';
/** Marker credential: if this reaches an error message, the key leaked. */
const FAKE_KEY = 'sk-FAKE-KEY-DO-NOT-LEAK-7f2a';
/** Marker upstream prose: if it reaches an error message, a body was forwarded. */
const UPSTREAM_MARKER = 'UPSTREAM-BODY-MARKER-do-not-echo';

const CAPTURE_SERVICE = 'http://capture-service:8080';

const TRANSCRIPT: TranscriptChunk[] = [
  { speakerId: 'speaker-1', text: SENTINEL, startMs: 0, endMs: 4200 },
  { speakerId: 'speaker-2', text: 'Then we re-run the simulation.', startMs: 4200, endMs: 8400 },
];

const CONTEXT: SlideContext = { agendaIdx: 2, slideTitle: 'Rear bracket' };

const COMPONENTS = [{ id: 'node-14', name: 'BRACKET_LH', path: 'FRAME/BRACKET_LH' }];

/** A card in the shape the extraction prompt asks for — no id, no timestamp. */
const VALID_CARD = {
  type: 'RISK',
  title: 'Bracket weld cracks under load',
  description: 'The reviewer said the weld will crack before the yield target.',
  agentId: 'speaker-1',
  details: { priority: 'High', impact: 'Warranty returns' },
};

function cardsBody(...cards: unknown[]): string {
  return JSON.stringify({ cards });
}

function configWith(capture: ViewpointConfig['capture']): ViewpointConfig {
  return {
    plm: { provider: 'none' },
    capture,
    turn: { provider: 'cloudflare', tokenIdEnv: 'T', apiTokenEnv: 'T' },
    db: { provider: 'supabase', urlEnv: 'U', anonKeyEnv: 'K' },
    notifications: [],
    modelImport: { provider: 'genericGltf' },
  } as ViewpointConfig;
}

// ─── The fetch double ───────────────────────────────────────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The JSON body, when one was sent. */
  json: Record<string, unknown> | null;
  /** The multipart body as a flat record; a file part becomes `file:<name>:<size>`. */
  form: Record<string, string> | null;
  signal: AbortSignal | undefined;
}

async function recordCall(url: string, init: RequestInit | undefined): Promise<RecordedCall> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers as HeadersInit).forEach((value, name) => {
    headers[name] = value;
  });

  let json: Record<string, unknown> | null = null;
  let form: Record<string, string> | null = null;
  const body = init?.body;
  if (typeof body === 'string') {
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      json = null;
    }
  } else if (body instanceof FormData) {
    form = {};
    for (const [name, value] of body.entries()) {
      form[name] =
        typeof value === 'string'
          ? value
          : `file:${value.name}:${(value as unknown as { size: number }).size}`;
    }
  }

  return { url, method: init?.method ?? 'GET', headers, json, form, signal: init?.signal };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fetch double that records every call and answers from a queue.
 *
 * `replies` is consumed in order so a test can drive the two-call local path
 * (transcribe, then extract) with one stub.
 */
function stubFetch(...replies: Array<Response | (() => Response)>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push(await recordCall(String(input), init));
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    const response = typeof reply === 'function' ? reply() : reply;
    if (response === undefined) throw new Error(`no reply stubbed for call ${index}`);
    return response;
  });
  return { calls, fetchFn: fetchFn as unknown as typeof globalThis.fetch, last: () => calls[calls.length - 1] };
}

/** An OpenAI-shaped chat answer. */
function openAiReply(content: string, finishReason = 'stop'): Response {
  return jsonResponse({ choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] });
}

/** An Anthropic-shaped answer. */
function anthropicReply(text: string, stopReason = 'end_turn'): Response {
  return jsonResponse({ content: [{ type: 'text', text }], stop_reason: stopReason });
}

/** A Gemini-shaped answer. */
function geminiReply(text: string, finishReason = 'STOP'): Response {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text }] }, finishReason }],
  });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BUILTIN_ENV = {
  CAPTURE_SERVICE_URL: CAPTURE_SERVICE,
  CAPTURE_SHARED_SECRET: 'capture-FAKE-shared-secret',
};

function resolved(job: 'transcription' | 'cards' | 'summary', provider: string, extra: Record<string, unknown> = {}) {
  return {
    job,
    provider,
    source: 'settings',
    fields: {},
    secret: null,
    model: null,
    ...extra,
  } as never;
}

describe('router — resolution order', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.mocked(loadConfig).mockReset();
    vi.mocked(readSetting).mockReset();
    vi.mocked(openSettingSecret).mockReset();
    vi.mocked(readSetting).mockResolvedValue(null);
    vi.mocked(openSettingSecret).mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  async function router() {
    return import('../router.ts');
  }

  it('uses a stored setting when there is one', async () => {
    vi.mocked(readSetting).mockResolvedValue({
      key: 'ai.cards',
      value: { provider: 'openai', fields: { model: 'gpt-4o-mini' } },
      secret: { set: true, last4: '7f2a', unreadable: false },
      updatedAt: '',
      updatedBy: 'admin-1',
    });
    vi.mocked(openSettingSecret).mockResolvedValue(FAKE_KEY);
    // A config that would resolve elsewhere: the stored row must win.
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'local', serviceUrl: CAPTURE_SERVICE }));

    const { resolveJob } = await router();
    const job = await resolveJob('cards');
    expect(job.provider).toBe('openai');
    expect(job.source).toBe('settings');
    expect(job.model).toBe('gpt-4o-mini');
    expect(job.secret).toBe(FAKE_KEY);
    // Only the credential-bearing half asks for a plaintext.
    expect(openSettingSecret).toHaveBeenCalledWith('ai.cards', {});
  });

  it('does not ask for a plaintext secret when the provider has no secret field', async () => {
    vi.mocked(readSetting).mockResolvedValue({
      key: 'ai.cards',
      value: { provider: 'builtin', fields: {} },
      secret: { set: false, last4: '', unreadable: false },
      updatedAt: '',
      updatedBy: '',
    });
    const { resolveJob } = await router();
    const job = await resolveJob('cards');
    expect(job.provider).toBe('builtin');
    expect(openSettingSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['is not an object', 'not-a-setting'],
    ['names an unknown provider', { provider: 'skynet', fields: {} }],
    ['is missing a required field', { provider: 'openaiCompatible', fields: {} }],
    ['has a required field that is not a string', { provider: 'webhook', fields: { url: 42 } }],
  ])('falls through to config when the stored row %s', async (_label, value) => {
    vi.mocked(readSetting).mockResolvedValue({
      key: 'ai.cards',
      value,
      secret: { set: false, last4: '', unreadable: false },
      updatedAt: '',
      updatedBy: '',
    });
    vi.mocked(loadConfig).mockResolvedValue(
      configWith({ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' }),
    );
    process.env.OPENAI_API_KEY = FAKE_KEY;

    const { resolveJob } = await router();
    const job = await resolveJob('cards');
    expect(job.provider).toBe('openai');
    expect(job.source).toBe('config');
    expect(job.model).toBe('gpt-4o-mini');
    expect(job.secret).toBe(FAKE_KEY);
  });

  it('falls through to config when the stored row names a provider that cannot do the job', async () => {
    // Every provider can do `cards`, so the capability check is only observable
    // on transcription — and it is the check that stops an administrator saving
    // "Anthropic for transcription" and finding out during a meeting.
    vi.mocked(readSetting).mockResolvedValue({
      key: 'ai.transcription',
      value: { provider: 'anthropic', fields: { model: 'claude-sonnet-4-5' } },
      secret: { set: true, last4: '7f2a', unreadable: false },
      updatedAt: '',
      updatedBy: 'admin-1',
    });
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'local', serviceUrl: CAPTURE_SERVICE }));

    const { resolveJob } = await router();
    const job = await resolveJob('transcription');
    expect(job.provider).toBe('builtin');
    expect(job.source).toBe('config');
    // And no plaintext was fetched for a setting that was refused.
    expect(openSettingSecret).not.toHaveBeenCalled();
  });

  it('falls through to builtin when neither the store nor the config has an answer', async () => {
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'mock' }));
    const { resolveJob } = await router();
    for (const job of ['transcription', 'cards', 'summary'] as const) {
      const resolvedJob = await resolveJob(job);
      expect(resolvedJob.provider).toBe('builtin');
      expect(resolvedJob.source).toBe('default');
      expect(resolvedJob.secret).toBeNull();
    }
  });

  it('maps capture.provider "local" to builtin, from config', async () => {
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'local', serviceUrl: CAPTURE_SERVICE }));
    const { resolveJob } = await router();
    const job = await resolveJob('transcription');
    expect(job.provider).toBe('builtin');
    expect(job.source).toBe('config');
  });

  it('gives a config anthropic deployment builtin transcription, because Anthropic has no audio API', async () => {
    vi.mocked(loadConfig).mockResolvedValue(
      configWith({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiKeyEnv: 'ANTHROPIC_API_KEY' }),
    );
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const { resolveJob } = await router();

    expect((await resolveJob('cards')).provider).toBe('anthropic');
    expect((await resolveJob('summary')).provider).toBe('anthropic');
    // The important one: resolving to anthropic here would produce a 503 at the
    // first live-transcript chunk, on a deployment that never asked for it.
    expect((await resolveJob('transcription')).provider).toBe('builtin');
  });

  it('maps ollamaDirect to the OpenAI-compatible provider under /v1, except for transcription', async () => {
    vi.mocked(loadConfig).mockResolvedValue(
      configWith({ provider: 'ollamaDirect', baseUrl: 'http://ollama.internal:11434', model: 'qwen2.5:7b' }),
    );
    const { resolveJob } = await router();

    const cards = await resolveJob('cards');
    expect(cards.provider).toBe('openaiCompatible');
    expect(cards.fields.baseUrl).toBe('http://ollama.internal:11434/v1');
    expect(cards.model).toBe('qwen2.5:7b');
    // Ollama has no credential and must not be given one.
    expect(cards.secret).toBeNull();

    expect((await resolveJob('transcription')).provider).toBe('builtin');
  });

  it('does not append /v1 twice when the config already ends with it', async () => {
    vi.mocked(loadConfig).mockResolvedValue(
      configWith({ provider: 'ollamaDirect', baseUrl: 'http://ollama.internal:11434/v1', model: 'qwen2.5:7b' }),
    );
    const { resolveJob } = await router();
    expect((await resolveJob('cards')).fields.baseUrl).toBe('http://ollama.internal:11434/v1');
  });

  it('resolves to builtin when the config will not load', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('Invalid viewpoint config'));
    const { resolveJob } = await router();
    const job = await resolveJob('cards');
    expect(job.provider).toBe('builtin');
    expect(job.source).toBe('default');
  });

  it('resolves to builtin when the settings store is unreachable', async () => {
    vi.mocked(readSetting).mockRejectedValue(new Error('network'));
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'mock' }));
    const { resolveJob } = await router();
    // resolveJob must never throw: a database outage has to cost an installation
    // its saved preference, not its capture.
    expect((await resolveJob('cards')).provider).toBe('builtin');
  });

  it('uses an explicit resolution when one is given, and reads nothing else', async () => {
    const { resolveJob } = await router();
    const job = await resolveJob('cards', {
      resolved: resolved('cards', 'webhook', { fields: { url: 'https://ai.internal/vp' } }),
    });
    expect(job.provider).toBe('webhook');
    expect(readSetting).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('describes a resolution without carrying the credential', async () => {
    const { describeResolution } = await router();
    const description = describeResolution(
      resolved('cards', 'openai', { secret: FAKE_KEY, model: 'gpt-4o-mini' }),
    );
    expect(description).toEqual({
      job: 'cards',
      provider: 'openai',
      source: 'settings',
      model: 'gpt-4o-mini',
      missingSecret: false,
    });
    expect(JSON.stringify(description)).not.toContain(FAKE_KEY);
  });

  it('reports a provider whose credential is missing, instead of letting it fail upstream', async () => {
    const { describeResolution } = await router();
    expect(
      describeResolution(resolved('cards', 'openai', { secret: null, model: 'gpt-4o-mini' })).missingSecret,
    ).toBe(true);
    // A provider with no secret field is never "missing" one.
    expect(describeResolution(resolved('cards', 'builtin')).missingSecret).toBe(false);
    expect(describeResolution(resolved('cards', 'webhook')).missingSecret).toBe(false);
  });
});

describe('router — what each provider is sent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  async function router() {
    return import('../router.ts');
  }

  async function cards(provider: string, extra: Record<string, unknown>, fetchFn: typeof globalThis.fetch) {
    const { runJob } = await router();
    return runJob(
      'cards',
      { transcript: TRANSCRIPT, context: CONTEXT, grounded: { componentTree: COMPONENTS } },
      { resolved: resolved('cards', provider, extra), fetchFn, env: {} },
    );
  }

  // ─── OpenAI ───────────────────────────────────────────────────────────────

  it('sends OpenAI a chat completion with the key in one header and JSON mode on', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    const result = await cards('openai', { secret: FAKE_KEY, model: 'gpt-4o-mini' }, fetchStub.fetchFn);

    expect(result.job).toBe('cards');
    if (result.job !== 'cards') return;
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].details.priority).toBe('High');

    const call = fetchStub.last();
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.json).toMatchObject({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    });
    const messages = call.json?.messages as Array<Record<string, string>>;
    expect(messages[0]).toEqual({ role: 'system', content: EXTRACTION_SYSTEM_PROMPT });
    expect(messages[1].role).toBe('user');
    // The prompt is where the transcript belongs; the URL and headers are not.
    expect(messages[1].content).toContain(SENTINEL);
    expect(call.url).not.toContain(FAKE_KEY);
  });

  it('renders the component list into the cloud prompt, despite the wire type spelling it differently', async () => {
    // Regression guard. `buildExtractionUserPrompt`'s grounded parameter spells the
    // component list `components`; `GroundedCaptureContext` spells it
    // `componentTree`. The parameter is all-optional, so passing the wire object
    // straight through type-checks and then renders NOTHING at runtime — the model
    // is told componentReference must come from a list it was never shown, guesses,
    // and checkComponents rejects the card. Every cloud extraction with a model
    // loaded would fail, with no type error to explain it.
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    await cards('openai', { secret: FAKE_KEY, model: 'gpt-4o-mini' }, fetchStub.fetchFn);

    const messages = fetchStub.last().json?.messages as Array<Record<string, string>>;
    const userPrompt = messages[1].content;
    expect(userPrompt).toContain('Components in this model:');
    expect(userPrompt).toContain('node-14');
    expect(userPrompt).toContain('BRACKET_LH');
    expect(userPrompt).toContain('FRAME/BRACKET_LH');
  });

  it('renders the pointing timeline and the live transcript hint into the cloud prompt', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    const { runJob } = await router();
    await runJob(
      'cards',
      {
        transcript: TRANSCRIPT,
        context: CONTEXT,
        grounded: {
          componentTree: COMPONENTS,
          pointingSegments: [
            { userId: 'u1', userName: 'Ada', partId: 'node-14', partName: 'BRACKET_LH', fromMs: 0, toMs: 900 },
          ],
          transcriptHint: [{ speaker: 'Ada', text: 'over the bracket', offsetMs: 100 }],
        },
      },
      {
        resolved: resolved('cards', 'openai', { secret: FAKE_KEY, model: 'gpt-4o-mini' }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    const messages = fetchStub.last().json?.messages as Array<Record<string, string>>;
    expect(messages[1].content).toContain('Ada');
    expect(messages[1].content).toContain('over the bracket');
  });

  it('asks OpenAI for markdown, not JSON, when the job is a summary', async () => {
    const fetchStub = stubFetch(openAiReply('## What was reviewed\n\nThe rear bracket.'));
    const { runJob } = await router();
    const result = await runJob(
      'summary',
      { transcript: TRANSCRIPT, cards: [], title: 'Rear bracket review' },
      {
        resolved: resolved('summary', 'openai', { secret: FAKE_KEY, model: 'gpt-4o-mini' }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );

    expect(result.job === 'summary' && result.summary).toContain('## What was reviewed');
    const call = fetchStub.last();
    // JSON mode would fence or escape the markdown into unreadability.
    expect(call.json?.response_format).toBeUndefined();
    const messages = call.json?.messages as Array<Record<string, string>>;
    expect(messages[0].content).toBe(SUMMARY_SYSTEM_PROMPT);
  });

  it('sends OpenAI transcription as multipart `file` with verbose_json', async () => {
    const fetchStub = stubFetch(
      jsonResponse({ segments: [{ start: 0, end: 4.2, text: 'The bracket weld will crack.' }] }),
    );
    const { runJob, silentWav } = await router();
    const result = await runJob(
      'transcription',
      { audio: silentWav(), filename: 'chunk.webm', contentType: 'audio/webm' },
      {
        resolved: resolved('transcription', 'openai', { secret: FAKE_KEY, model: 'whisper-1' }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );

    const call = fetchStub.last();
    expect(call.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    // OpenAI's field name is `file`, not `audio` — the one place the two differ.
    expect(call.form?.file).toMatch(/^file:chunk\.webm:\d+$/);
    expect(call.form?.model).toBe('whisper-1');
    expect(call.form?.response_format).toBe('verbose_json');
    expect(call.form?.audio).toBeUndefined();

    if (result.job !== 'transcription') throw new Error('wrong job');
    // Seconds on the wire become the app's own milliseconds, with one speaker
    // label: a transcription API gives us no diarization and we invent none.
    expect(result.transcript).toEqual([
      { speakerId: 'speaker-1', text: 'The bracket weld will crack.', startMs: 0, endMs: 4200 },
    ]);
  });

  it('accepts a plain { text } transcription answer from a server that ignores verbose_json', async () => {
    const fetchStub = stubFetch(jsonResponse({ text: 'The whole recording in one line.' }));
    const { runJob, silentWav } = await router();
    const result = await runJob(
      'transcription',
      { audio: silentWav() },
      {
        resolved: resolved('transcription', 'openai', { secret: FAKE_KEY, model: 'whisper-1' }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    if (result.job !== 'transcription') throw new Error('wrong job');
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0].text).toBe('The whole recording in one line.');
  });

  // ─── Anthropic ────────────────────────────────────────────────────────────

  it('sends Anthropic the Messages API with x-api-key and no JSON mode', async () => {
    const fetchStub = stubFetch(anthropicReply(cardsBody(VALID_CARD)));
    await cards('anthropic', { secret: FAKE_KEY, model: 'claude-sonnet-4-5' }, fetchStub.fetchFn);

    const call = fetchStub.last();
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe(FAKE_KEY);
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    // Anthropic has no JSON mode; the parser unwraps a fence instead.
    expect(call.json?.response_format).toBeUndefined();
    expect(call.json).toMatchObject({ model: 'claude-sonnet-4-5', max_tokens: 4096, temperature: 0 });
    expect(call.json?.system).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('concatenates Anthropic text blocks split across content entries', async () => {
    const fetchStub = stubFetch(
      jsonResponse({
        content: [
          { type: 'text', text: '{"cards": [' },
          { type: 'text', text: `${JSON.stringify(VALID_CARD)}]}` },
        ],
        stop_reason: 'end_turn',
      }),
    );
    const result = await cards('anthropic', { secret: FAKE_KEY, model: 'claude-sonnet-4-5' }, fetchStub.fetchFn);
    if (result.job !== 'cards') throw new Error('wrong job');
    expect(result.cards).toHaveLength(1);
  });

  it('unwraps a markdown fence from a provider with no JSON mode', async () => {
    const fetchStub = stubFetch(anthropicReply('```json\n' + cardsBody(VALID_CARD) + '\n```'));
    const result = await cards('anthropic', { secret: FAKE_KEY, model: 'claude-sonnet-4-5' }, fetchStub.fetchFn);
    if (result.job !== 'cards') throw new Error('wrong job');
    expect(result.cards).toHaveLength(1);
  });

  // ─── Azure OpenAI ─────────────────────────────────────────────────────────

  it('addresses Azure by deployment name in the path, with api-key and no model in the body', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    await cards(
      'azureOpenai',
      {
        secret: FAKE_KEY,
        fields: {
          endpoint: 'https://contoso.openai.azure.com',
          deployment: 'gpt-4o-mini',
          apiVersion: '2024-10-01-preview',
        },
      },
      fetchStub.fetchFn,
    );

    const call = fetchStub.last();
    expect(call.url).toBe(
      'https://contoso.openai.azure.com/openai/deployments/gpt-4o-mini/chat/completions' +
        '?api-version=2024-10-01-preview',
    );
    expect(call.headers['api-key']).toBe(FAKE_KEY);
    expect(call.headers.authorization).toBeUndefined();
    // Sending a `model` beside a deployment makes some api-versions reject the
    // request outright.
    expect(call.json?.model).toBeUndefined();
  });

  it('defaults the Azure api-version when the setting leaves it blank', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    await cards(
      'azureOpenai',
      {
        secret: FAKE_KEY,
        fields: { endpoint: 'https://contoso.openai.azure.com/', deployment: 'gpt-4o-mini' },
      },
      fetchStub.fetchFn,
    );
    expect(fetchStub.last().url).toContain('api-version=2024-10-01-preview');
    // A trailing slash on the resource root must not produce a double slash.
    expect(fetchStub.last().url).not.toContain('.com//openai');
  });

  // ─── Gemini ───────────────────────────────────────────────────────────────

  it('sends Gemini the key in a header, never in the query string', async () => {
    const fetchStub = stubFetch(geminiReply(cardsBody(VALID_CARD)));
    await cards('gemini', { secret: FAKE_KEY, model: 'gemini-2.5-flash' }, fetchStub.fetchFn);

    const call = fetchStub.last();
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(call.headers['x-goog-api-key']).toBe(FAKE_KEY);
    // A key in a URL is a key in every access log and proxy log in between.
    expect(call.url).not.toContain(FAKE_KEY);
    expect(call.url).not.toContain('key=');
    const generationConfig = call.json?.generationConfig as Record<string, unknown>;
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(call.json?.systemInstruction).toEqual({ parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] });
  });

  it('does not ask Gemini for JSON when the job is a summary', async () => {
    const fetchStub = stubFetch(geminiReply('## Decisions\n\nNone.'));
    const { runJob } = await router();
    await runJob(
      'summary',
      { transcript: TRANSCRIPT, cards: [] },
      {
        resolved: resolved('summary', 'gemini', { secret: FAKE_KEY, model: 'gemini-2.5-flash' }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    const generationConfig = fetchStub.last().json?.generationConfig as Record<string, unknown>;
    expect(generationConfig.responseMimeType).toBeUndefined();
  });

  // ─── OpenAI-compatible ────────────────────────────────────────────────────

  it('posts an OpenAI-compatible gateway at baseUrl + /chat/completions with a bearer key', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    await cards(
      'openaiCompatible',
      { secret: FAKE_KEY, model: 'qwen2.5:7b', fields: { baseUrl: 'https://gateway.acme.com/v1', model: 'qwen2.5:7b' } },
      fetchStub.fetchFn,
    );
    const call = fetchStub.last();
    expect(call.url).toBe('https://gateway.acme.com/v1/chat/completions');
    expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.json?.model).toBe('qwen2.5:7b');
  });

  it('sends an OpenAI-compatible gateway NO auth header when it has no key', async () => {
    // vLLM and LM Studio on a trusted network authenticate by address. Refusing
    // to call them without a key would make the provider useless for its main use.
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    await cards(
      'openaiCompatible',
      { secret: null, model: 'qwen2.5:7b', fields: { baseUrl: 'http://vllm.internal:8000/v1', model: 'qwen2.5:7b' } },
      fetchStub.fetchFn,
    );
    const call = fetchStub.last();
    expect(call.headers.authorization).toBeUndefined();
    expect(call.url).toBe('http://vllm.internal:8000/v1/chat/completions');
  });

  it('refuses a non-http URL rather than letting fetch decide', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    const { AiJobError } = await router();
    await expect(
      cards('openaiCompatible', { fields: { baseUrl: 'file:///etc/passwd', model: 'x' }, model: 'x' }, fetchStub.fetchFn),
    ).rejects.toBeInstanceOf(AiJobError);
    // Nothing was sent anywhere: the refusal happens before the call.
    expect(fetchStub.calls).toHaveLength(0);
  });

  // ─── Webhook ──────────────────────────────────────────────────────────────

  it('posts the webhook the cards contract, with the operator\u2019s own header', async () => {
    const fetchStub = stubFetch(jsonResponse({ cards: [VALID_CARD] }));
    await cards(
      'webhook',
      {
        secret: 'hook-secret-FAKE',
        fields: { url: 'https://ai.acme.com/viewpoint', headerName: 'X-Api-Key' },
      },
      fetchStub.fetchFn,
    );

    const call = fetchStub.last();
    expect(call.url).toBe('https://ai.acme.com/viewpoint');
    expect(call.headers['x-api-key']).toBe('hook-secret-FAKE');
    expect(call.json).toMatchObject({ job: 'cards', context: { slide: CONTEXT, components: COMPONENTS } });
    expect(call.json?.transcript).toEqual(TRANSCRIPT);
  });

  it('omits an empty component list rather than sending []', async () => {
    const fetchStub = stubFetch(jsonResponse({ cards: [] }));
    const { runJob } = await router();
    await runJob(
      'cards',
      { transcript: TRANSCRIPT, context: CONTEXT },
      {
        resolved: resolved('cards', 'webhook', {
          secret: 'hook-secret-FAKE',
          fields: { url: 'https://ai.acme.com/viewpoint', headerName: 'X-Api-Key' },
        }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    const context = fetchStub.last().json?.context as Record<string, unknown>;
    expect(context.components).toBeUndefined();
    expect(context.slide).toEqual(CONTEXT);
  });

  it('posts the webhook the summary contract', async () => {
    const fetchStub = stubFetch(jsonResponse({ summary: '## Decisions\n\nUse the revised bracket.' }));
    const { runJob } = await router();
    const card = { ...VALID_CARD, id: 'card-1', timestamp: 1_700_000_000_000 } as InsightCard;
    const result = await runJob(
      'summary',
      { transcript: TRANSCRIPT, cards: [card], title: 'Rear bracket review' },
      {
        resolved: resolved('summary', 'webhook', {
          secret: 'hook-secret-FAKE',
          fields: { url: 'https://ai.acme.com/viewpoint' },
        }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    expect(result.job === 'summary' && result.summary).toContain('## Decisions');
    expect(fetchStub.last().json).toMatchObject({
      job: 'summary',
      transcript: TRANSCRIPT,
      title: 'Rear bracket review',
    });
    // No header name configured, so no header is invented.
    expect(fetchStub.last().headers['x-api-key']).toBeUndefined();
  });

  it('posts the webhook the transcription contract as multipart `audio`', async () => {
    const fetchStub = stubFetch(
      jsonResponse({ segments: [{ start: 0, end: 2, text: 'Hello.' }, { start: 2, end: 4, text: '' }] }),
    );
    const { runJob, silentWav } = await router();
    const result = await runJob(
      'transcription',
      { audio: silentWav(), filename: 'meeting.webm' },
      {
        resolved: resolved('transcription', 'webhook', { fields: { url: 'https://ai.acme.com/asr' } }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );

    const call = fetchStub.last();
    expect(call.url).toBe('https://ai.acme.com/asr');
    expect(call.form?.audio).toMatch(/^file:meeting\.webm:\d+$/);
    // A segment with no text is dropped, not an error: silence is a normal answer.
    if (result.job !== 'transcription') throw new Error('wrong job');
    expect(result.transcript).toHaveLength(1);
  });

  it('corrects an inverted segment span rather than losing the words', async () => {
    const fetchStub = stubFetch(jsonResponse({ segments: [{ start: 9, end: 2, text: 'Backwards.' }] }));
    const { runJob, silentWav } = await router();
    const result = await runJob(
      'transcription',
      { audio: silentWav() },
      {
        resolved: resolved('transcription', 'webhook', { fields: { url: 'https://ai.acme.com/asr' } }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    if (result.job !== 'transcription') throw new Error('wrong job');
    expect(result.transcript[0].startMs).toBe(9000);
    expect(result.transcript[0].endMs).toBe(9000);
  });

  it('accepts string numbers from a gateway that serialises floats as strings', async () => {
    const fetchStub = stubFetch(jsonResponse({ segments: [{ start: '1.5', end: '3.25', text: 'Quoted.' }] }));
    const { runJob, silentWav } = await router();
    const result = await runJob(
      'transcription',
      { audio: silentWav() },
      {
        resolved: resolved('transcription', 'webhook', { fields: { url: 'https://ai.acme.com/asr' } }),
        fetchFn: fetchStub.fetchFn,
        env: {},
      },
    );
    if (result.job !== 'transcription') throw new Error('wrong job');
    expect(result.transcript[0]).toMatchObject({ startMs: 1500, endMs: 3250 });
  });

  it.each([
    ['a bare array', [VALID_CARD]],
    ['a renamed envelope', { insights: [VALID_CARD] }],
    ['an envelope with a transport-metadata key', { cards: [VALID_CARD], took: 4.2 }],
    ['a card with an unknown field', { cards: [{ ...VALID_CARD, sentiment: 0.9 }] }],
    ['a card with no priority', { cards: [{ ...VALID_CARD, details: {} }] }],
    ['a card with an invented componentReference', {
      cards: [{ ...VALID_CARD, details: { ...VALID_CARD.details, componentReference: 'node-999' } }],
    }],
  ])('refuses a webhook cards response that is %s', async (_label, payload) => {
    // A webhook gets no laxer schema than OpenAI does, because the cards land in
    // the same tracker either way.
    const fetchStub = stubFetch(jsonResponse(payload));
    const { AiJobError } = await router();
    await expect(
      cards('webhook', { fields: { url: 'https://ai.acme.com/viewpoint' } }, fetchStub.fetchFn),
    ).rejects.toBeInstanceOf(AiJobError);
  });

  it('accepts a webhook card that references a component which IS in the model', async () => {
    const fetchStub = stubFetch(
      jsonResponse({
        cards: [{ ...VALID_CARD, details: { ...VALID_CARD.details, componentReference: 'node-14' } }],
      }),
    );
    const result = await cards('webhook', { fields: { url: 'https://ai.acme.com/vp' } }, fetchStub.fetchFn);
    if (result.job !== 'cards') throw new Error('wrong job');
    expect(result.cards[0].details.componentReference).toBe('node-14');
  });

  // ─── Deadlines: the words win over the date the model computed ────────────
  //
  // The built-in 7B model gets relative deadlines wrong even with today's date
  // and a fortnight of weekday names in the prompt to look them up in, so the
  // extraction also asks for the phrase verbatim and lib/capture/resolveDeadline
  // resolves it here — in the router, where all five providers meet.

  it('replaces a due date with the one the spoken phrase resolves to', async () => {
    const fetchStub = stubFetch(
      jsonResponse({
        cards: [
          {
            ...VALID_CARD,
            type: 'ACTION',
            details: {
              priority: 'High',
              // Wrong, and wrong the way the small model is wrong: a date it
              // computed rather than looked up.
              dueDate: '1999-01-01',
              dueDateText: 'tomorrow',
            },
          },
        ],
      }),
    );
    const result = await cards('webhook', { fields: { url: 'https://ai.acme.com/vp' } }, fetchStub.fetchFn);
    if (result.job !== 'cards') throw new Error('wrong job');

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(result.cards[0].details.dueDate).toBe(tomorrow);
    // The words survive on the card, so the tracker can show what was promised.
    expect(result.cards[0].details.dueDateText).toBe('tomorrow');
  });

  it('keeps the model’s due date for a phrase the resolver does not know', async () => {
    const fetchStub = stubFetch(
      jsonResponse({
        cards: [
          {
            ...VALID_CARD,
            type: 'ACTION',
            details: { priority: 'High', dueDate: '2026-10-01', dueDateText: 'before the freeze' },
          },
        ],
      }),
    );
    const result = await cards('webhook', { fields: { url: 'https://ai.acme.com/vp' } }, fetchStub.fetchFn);
    if (result.job !== 'cards') throw new Error('wrong job');
    expect(result.cards[0].details.dueDate).toBe('2026-10-01');
  });

  it('resolves a deadline for a model-text provider too, not only a structured one', async () => {
    // The webhook and the built-in stack answer with a payload; OpenAI, Anthropic,
    // Azure, Gemini and anything OpenAI-compatible answer with text. One pass, in
    // the router, is what makes the two behave the same.
    const fetchStub = stubFetch(
      openAiReply(
        cardsBody({
          ...VALID_CARD,
          type: 'ACTION',
          details: { priority: 'High', dueDateText: 'today' },
        }),
      ),
    );
    const result = await cards(
      'openai',
      { secret: FAKE_KEY, model: 'gpt-4o-mini' },
      fetchStub.fetchFn,
    );
    if (result.job !== 'cards') throw new Error('wrong job');
    expect(result.cards[0].details.dueDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it('refuses an empty summary string, because "it worked and said nothing" is not a summary', async () => {
    const fetchStub = stubFetch(jsonResponse({ summary: '   ' }));
    const { runJob, AiJobError } = await router();
    await expect(
      runJob(
        'summary',
        { transcript: TRANSCRIPT, cards: [] },
        {
          resolved: resolved('summary', 'webhook', { fields: { url: 'https://ai.acme.com/vp' } }),
          fetchFn: fetchStub.fetchFn,
          env: {},
        },
      ),
    ).rejects.toBeInstanceOf(AiJobError);
  });

  it('refuses a cloud summary whose model answered with no text', async () => {
    // A different code path from the webhook case above: the built-in stack and a
    // webhook answer with a `{ summary }` envelope, while OpenAI, Anthropic, Azure,
    // Gemini and anything OpenAI-compatible answer with the markdown itself. Both
    // have to refuse an empty answer, or "it worked and said nothing" is
    // indistinguishable from "it worked" and Test connection cannot do its job.
    const fetchStub = stubFetch(openAiReply('   '));
    const { runJob, AiJobError } = await router();
    await expect(
      runJob(
        'summary',
        { transcript: TRANSCRIPT, cards: [] },
        {
          resolved: resolved('summary', 'openai', { secret: FAKE_KEY, model: 'gpt-4o-mini' }),
          fetchFn: fetchStub.fetchFn,
          env: {},
        },
      ),
    ).rejects.toBeInstanceOf(AiJobError);
  });

  // ─── The built-in stack ───────────────────────────────────────────────────

  it('sends capture-service multipart audio plus the shared secret, from this container\u2019s env', async () => {
    const fetchStub = stubFetch(
      jsonResponse({
        transcript: [{ speakerId: 'speaker-1', text: 'Hello.', startMs: 0, endMs: 900 }],
      }),
    );
    const { runJob, silentWav } = await router();
    await runJob(
      'transcription',
      { audio: silentWav(), filename: 'meeting.webm' },
      { resolved: resolved('transcription', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
    );

    const call = fetchStub.last();
    expect(call.url).toBe(`${CAPTURE_SERVICE}/transcribe`);
    expect(call.headers['x-capture-token']).toBe(BUILTIN_ENV.CAPTURE_SHARED_SECRET);
    expect(call.form?.audio).toMatch(/^file:meeting\.webm:\d+$/);
  });

  it('omits the secret header when none is configured, rather than sending an empty one', async () => {
    const fetchStub = stubFetch(jsonResponse({ transcript: [] }));
    const { runJob, silentWav, AiJobError } = await router();
    // An empty transcript is a failure, so this rejects — but the call was made.
    await expect(
      runJob(
        'transcription',
        { audio: silentWav() },
        {
          resolved: resolved('transcription', 'builtin'),
          fetchFn: fetchStub.fetchFn,
          env: { CAPTURE_SERVICE_URL: CAPTURE_SERVICE, CAPTURE_SHARED_SECRET: '' },
        },
      ),
    ).rejects.toBeInstanceOf(AiJobError);
    expect(fetchStub.last().headers['x-capture-token']).toBeUndefined();
  });

  it('sends capture-service /extract the transcript, context and all three grounded fields', async () => {
    const fetchStub = stubFetch(jsonResponse({ cards: [VALID_CARD] }));
    const { runJob } = await router();
    const result = await runJob(
      'cards',
      {
        transcript: TRANSCRIPT,
        context: CONTEXT,
        grounded: {
          componentTree: COMPONENTS,
          pointingSegments: [
            { userId: 'u1', userName: 'Ada', partId: 'node-14', partName: 'BRACKET_LH', fromMs: 0, toMs: 900 },
          ],
          transcriptHint: [{ speaker: 'Ada', text: 'over the bracket', offsetMs: 100 }],
        },
      },
      { resolved: resolved('cards', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
    );

    const call = fetchStub.last();
    expect(call.url).toBe(`${CAPTURE_SERVICE}/extract`);
    expect(call.headers['x-capture-token']).toBe(BUILTIN_ENV.CAPTURE_SHARED_SECRET);
    expect(call.json).toMatchObject({ transcript: TRANSCRIPT, context: CONTEXT });
    expect(call.json?.componentTree).toEqual(COMPONENTS);
    expect(call.json?.transcriptHint).toEqual([{ speaker: 'Ada', text: 'over the bracket', offsetMs: 100 }]);
    if (result.job !== 'cards') throw new Error('wrong job');
    expect(result.cards).toHaveLength(1);
  });

  it('sends capture-service /summarize the transcript, the cards and the title', async () => {
    const fetchStub = stubFetch(jsonResponse({ summary: '## Actions\n\n- [ ] Re-run the simulation — Ada' }));
    const { runJob } = await router();
    const result = await runJob(
      'summary',
      { transcript: TRANSCRIPT, cards: [], title: '  Rear bracket review  ' },
      { resolved: resolved('summary', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
    );
    const call = fetchStub.last();
    expect(call.url).toBe(`${CAPTURE_SERVICE}/summarize`);
    expect(call.json?.title).toBe('Rear bracket review');
    expect(result.job === 'summary' && result.summary).toContain('## Actions');
  });

  it('reduces a configured address with a path or a query to its origin', async () => {
    // capture-service mounts its routes at the root, so a configured path would end
    // up glued in front of /transcribe and 404 — reported as an unreachable upstream,
    // which sends an operator to look at the network. And a configured QUERY STRING is
    // where a token lands: in the URL, then in this container's outbound log and in
    // every access log in between. install.sh accepts any absolute http(s) URL for
    // capture.serviceUrl, so both are reachable from the installer.
    vi.mocked(loadConfig).mockResolvedValue(
      configWith({
        provider: 'local',
        serviceUrl: 'http://capture.internal:8080/capture?token=SUPER-SECRET-TOKEN',
      }),
    );
    const fetchStub = stubFetch(jsonResponse({ cards: [VALID_CARD] }));
    const { runJob } = await router();
    await runJob(
      'cards',
      { transcript: TRANSCRIPT, context: CONTEXT },
      { resolved: resolved('cards', 'builtin'), fetchFn: fetchStub.fetchFn, env: {} },
    );
    expect(fetchStub.last().url).toBe('http://capture.internal:8080/extract');
    expect(fetchStub.last().url).not.toContain('SUPER-SECRET-TOKEN');
    expect(fetchStub.last().url).not.toContain('?');
  });

  it('refuses a built-in address that is not an http(s) URL', async () => {
    const fetchStub = stubFetch(jsonResponse({ cards: [] }));
    const { runJob, AiJobError } = await router();
    for (const serviceUrl of ['file:///etc/passwd', 'not a url']) {
      vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'local', serviceUrl }));
      await expect(
        runJob(
          'cards',
          { transcript: TRANSCRIPT, context: CONTEXT },
          { resolved: resolved('cards', 'builtin'), fetchFn: fetchStub.fetchFn, env: {} },
        ),
      ).rejects.toBeInstanceOf(AiJobError);
    }
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('finds capture-service through the config when CAPTURE_SERVICE_URL is unset', async () => {
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'local', serviceUrl: 'http://capture.internal:8080/' }));
    const fetchStub = stubFetch(jsonResponse({ cards: [VALID_CARD] }));
    const { runJob } = await router();
    await runJob(
      'cards',
      { transcript: TRANSCRIPT, context: CONTEXT },
      { resolved: resolved('cards', 'builtin'), fetchFn: fetchStub.fetchFn, env: {} },
    );
    // The trailing slash is trimmed rather than producing a double slash.
    expect(fetchStub.last().url).toBe('http://capture.internal:8080/extract');
  });

  it('reports the built-in stack as unconfigured rather than guessing an address', async () => {
    vi.mocked(loadConfig).mockResolvedValue(configWith({ provider: 'mock' }));
    const fetchStub = stubFetch(jsonResponse({ cards: [] }));
    const { runJob, AiJobError } = await router();
    await expect(
      runJob(
        'cards',
        { transcript: TRANSCRIPT, context: CONTEXT },
        { resolved: resolved('cards', 'builtin'), fetchFn: fetchStub.fetchFn, env: {} },
      ),
    ).rejects.toMatchObject({ name: 'AiJobError', code: 'capture_not_configured', status: 503 });
    expect(AiJobError).toBeTypeOf('function');
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe('router — failure mapping, with nothing leaked', () => {
  const originalEnv = process.env;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
  });

  async function router() {
    return import('../router.ts');
  }

  const OPENAI = { secret: FAKE_KEY, model: 'gpt-4o-mini' };

  async function failCards(fetchFn: typeof globalThis.fetch, provider = 'openai', extra: Record<string, unknown> = {}) {
    const { runJob, AiJobError } = await router();
    try {
      await runJob(
        'cards',
        { transcript: TRANSCRIPT, context: CONTEXT },
        { resolved: resolved('cards', provider, { ...OPENAI, ...extra }), fetchFn, env: {} },
      );
      throw new Error('the call should have failed');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      return err;
    }
  }

  /** The four things that must never appear in a failure. */
  function expectNoLeak(err: Error) {
    expect(err.message).not.toContain(SENTINEL);
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain(UPSTREAM_MARKER);
    expect(err.message).not.toContain('api.openai.com');
  }

  it('maps a non-2xx to capture_upstream_error at 502, whatever the provider said', async () => {
    const fetchStub = stubFetch(
      new Response(JSON.stringify({ error: { message: UPSTREAM_MARKER } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const err = await failCards(fetchStub.fetchFn);
    expect(err.code).toBe('capture_upstream_error');
    // A provider's 401 must not arrive as ours: the browser's access layer reads
    // our 401 as "not signed in" and sends the reviewer to a door.
    expect(err.status).toBe(502);
    expectNoLeak(err);
    // The detail IS logged, bounded, server-side — that is where an operator looks.
    expect(errorSpy.mock.calls.flat().join(' ')).toContain(UPSTREAM_MARKER);
  });

  it('maps a 200 that is not JSON to capture_endpoint_unavailable', async () => {
    // The classic misconfiguration: a proxy, an SPA fallback or the wrong port
    // answers 200 text/html for any path.
    const fetchStub = stubFetch(
      new Response(`<html>${UPSTREAM_MARKER}</html>`, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const err = await failCards(fetchStub.fetchFn);
    expect(err.code).toBe('capture_endpoint_unavailable');
    expect(err.status).toBe(502);
    expectNoLeak(err);
  });

  it('maps a 200 with an unparseable JSON body to capture_endpoint_unavailable', async () => {
    const fetchStub = stubFetch(
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const err = await failCards(fetchStub.fetchFn);
    expect(err.code).toBe('capture_endpoint_unavailable');
    expectNoLeak(err);
  });

  it('maps a network failure to capture_upstream_unreachable, without the URL', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.openai.com/v1/chat/completions ${UPSTREAM_MARKER}`);
    }) as unknown as typeof globalThis.fetch;
    const err = await failCards(fetchFn);
    expect(err.code).toBe('capture_upstream_unreachable');
    expect(err.status).toBe(502);
    // fetch's own message embeds the URL, which can carry a deployment's internal
    // hostname or a gateway path.
    expect(err.message).not.toContain('fetch failed');
    expectNoLeak(err);
  });

  it('maps finish_reason "length" to capture_output_truncated, checked before the text is read', async () => {
    const fetchStub = stubFetch(openAiReply('{"cards": [{"type": "RI', 'length'));
    const err = await failCards(fetchStub.fetchFn);
    // A truncated reply is a different failure with a different fix. Reporting it
    // as unparseable JSON sends an operator looking at the model, not the length.
    expect(err.code).toBe('capture_output_truncated');
    expect(err.status).toBe(422);
    expectNoLeak(err);
  });

  it('maps Anthropic stop_reason max_tokens to capture_output_truncated', async () => {
    const fetchStub = stubFetch(anthropicReply('{"cards": [', 'max_tokens'));
    const err = await failCards(fetchStub.fetchFn, 'anthropic');
    expect(err.code).toBe('capture_output_truncated');
    expectNoLeak(err);
  });

  it('maps Gemini MAX_TOKENS to capture_output_truncated', async () => {
    const fetchStub = stubFetch(geminiReply('{"cards": [', 'MAX_TOKENS'));
    const err = await failCards(fetchStub.fetchFn, 'gemini');
    expect(err.code).toBe('capture_output_truncated');
    expectNoLeak(err);
  });

  it.each([
    ['prose', 'I found three risks in this meeting.'],
    ['malformed_json', '{"cards": [}'],
    ['truncated_json', '{"cards": [{"type": "RI'],
    ['wrong_envelope', '{"insights": []}'],
  ])('maps unparseable model output to capture_parse_error with reason %s', async (reason, content) => {
    const fetchStub = stubFetch(openAiReply(content));
    const err = await failCards(fetchStub.fetchFn);
    expect(err.code).toBe('capture_parse_error');
    expect(err.status).toBe(422);
    // `reason` is an enum, and it is the ONLY part of a parse failure that may
    // cross the wire: the parser's own message quotes the payload, which quotes
    // the meeting.
    expect(err.reason).toBe(reason);
    expectNoLeak(err);
  });

  it('refuses a provider that needs a key and has none, naming the field and not a value', async () => {
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    const err = await failCards(fetchStub.fetchFn, 'openai', { secret: null });
    expect(err.code).toBe('capture_not_configured');
    expect(err.status).toBe(503);
    expect(err.message).toContain('apiKey');
    expect(fetchStub.calls).toHaveLength(0);
    expectNoLeak(err);
  });

  it('refuses a provider that cannot do the job, rather than guessing another one', async () => {
    const fetchStub = stubFetch(jsonResponse({ cards: [] }));
    const { runJob, AiJobError, silentWav } = await router();
    await expect(
      runJob(
        'transcription',
        { audio: silentWav() },
        { resolved: resolved('transcription', 'anthropic', { secret: FAKE_KEY }), fetchFn: fetchStub.fetchFn, env: {} },
      ),
    ).rejects.toBeInstanceOf(AiJobError);
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('reports a caller hang-up as request_closed at 499, not as an upstream failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchStub = stubFetch(openAiReply(cardsBody(VALID_CARD)));
    const { runJob, AiJobError } = await router();
    try {
      await runJob(
        'cards',
        { transcript: TRANSCRIPT, context: CONTEXT, signal: controller.signal },
        { resolved: resolved('cards', 'openai', OPENAI), fetchFn: fetchStub.fetchFn, env: {} },
      );
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      expect(err.code).toBe('request_closed');
      expect(err.status).toBe(499);
    }
    // Nothing was sent: a client that left should not have a model call billed.
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('reports our own ceiling as capture_upstream_timeout at 504', async () => {
    const fetchFn = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof globalThis.fetch;

    const { runJob, AiJobError } = await router();
    try {
      await runJob(
        'cards',
        { transcript: TRANSCRIPT, context: CONTEXT },
        { resolved: resolved('cards', 'openai', OPENAI), fetchFn, env: {}, timeoutMs: 5 },
      );
      throw new Error('should have timed out');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      expect(err.code).toBe('capture_upstream_timeout');
      expect(err.status).toBe(504);
      expectNoLeak(err);
    }
  });

  it('forwards capture-service\u2019s own codes and status, because they are ours', async () => {
    const fetchStub = stubFetch(
      new Response(JSON.stringify({ error: 'upload_too_large', maxUploadBytes: 209715200 }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { runJob, AiJobError, silentWav } = await router();
    try {
      await runJob(
        'transcription',
        { audio: silentWav() },
        { resolved: resolved('transcription', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
      );
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      // This is what keeps "the recording is too big" distinguishable from "the
      // model is not pulled" in the UI, now that nginx no longer passes the
      // service's own answer straight through.
      expect(err.code).toBe('upload_too_large');
      expect(err.status).toBe(413);
      expect(err.extras).toEqual({ maxUploadBytes: 209715200 });
    }
  });

  it('forwards a parse reason and card index from capture-service, and nothing else', async () => {
    const fetchStub = stubFetch(
      new Response(
        JSON.stringify({
          error: 'capture_parse_error',
          reason: 'invalid_card',
          cardIndex: 3,
          message: UPSTREAM_MARKER,
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { runJob, AiJobError, silentWav } = await router();
    try {
      await runJob(
        'transcription',
        { audio: silentWav() },
        { resolved: resolved('transcription', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
      );
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      expect(err.code).toBe('capture_parse_error');
      expect(err.reason).toBe('invalid_card');
      expect(err.extras).toEqual({ cardIndex: 3 });
      // The service's own message stays in its log, per its contract.
      expect(err.message).not.toContain(UPSTREAM_MARKER);
      expect(JSON.stringify(err.extras)).not.toContain(UPSTREAM_MARKER);
    }
  });

  it('flattens an upstream code that is not on the allowlist', async () => {
    // A code the browser has no case for would render as a bare string, and a code
    // an upstream invented would render as a sentence we did not write.
    const fetchStub = stubFetch(
      new Response(JSON.stringify({ error: `made_up_code ${UPSTREAM_MARKER}` }), {
        status: 418,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { runJob, AiJobError, silentWav } = await router();
    try {
      await runJob(
        'transcription',
        { audio: silentWav() },
        { resolved: resolved('transcription', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
      );
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      expect(err.code).toBe('capture_upstream_error');
      expect(err.status).toBe(502);
      expect(JSON.stringify(err.extras)).not.toContain(UPSTREAM_MARKER);
    }
  });

  it('reports a transcription that found no speech as empty_transcript', async () => {
    const fetchStub = stubFetch(jsonResponse({ transcript: [] }));
    const { runJob, AiJobError, silentWav } = await router();
    try {
      await runJob(
        'transcription',
        { audio: silentWav() },
        { resolved: resolved('transcription', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
      );
      throw new Error('should have thrown');
    } catch (err) {
      if (!(err instanceof AiJobError)) throw err;
      expect(err.code).toBe('empty_transcript');
      expect(err.status).toBe(422);
    }
  });

  it('strikes our own credential out of an upstream body before logging it', async () => {
    // OpenAI's 401 for a bad key reads "Incorrect API key provided: sk-…", i.e. the
    // vendor echoes back what we sent. Logging that body verbatim would put a live
    // credential in this container's log, which is the one place the module header
    // promises it never reaches. The old api/capture/extract.ts had a redact()
    // helper for exactly this; it moved here with the rest of the upstream code.
    const fetchStub = stubFetch(
      new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}` } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const err = await failCards(fetchStub.fetchFn);
    expect(err.code).toBe('capture_upstream_error');

    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(FAKE_KEY);
    expect(logged).toContain('<redacted>');
    expect(logged).toContain('Incorrect API key provided');
    // And it is a log line only: the response side is a code.
    expect(err.message).not.toContain(FAKE_KEY);
    expect(err.message).not.toContain('Incorrect API key');
  });

  it('strikes capture-service\u2019s shared secret out of a logged upstream body too', async () => {
    // A deployment can resolve transcription to the built-in stack and cards to a
    // cloud provider, so both credentials are always on the redaction list rather
    // than one being chosen by whichever provider happens to be resolved.
    const fetchStub = stubFetch(
      new Response(
        `echoed header: ${BUILTIN_ENV.CAPTURE_SHARED_SECRET}`,
        { status: 500, headers: { 'content-type': 'text/plain' } },
      ),
    );
    const { runJob, AiJobError, silentWav } = await router();
    await expect(
      runJob(
        'transcription',
        { audio: silentWav() },
        { resolved: resolved('transcription', 'builtin'), fetchFn: fetchStub.fetchFn, env: BUILTIN_ENV },
      ),
    ).rejects.toBeInstanceOf(AiJobError);

    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(BUILTIN_ENV.CAPTURE_SHARED_SECRET);
  });

  it('bounds what it logs from an upstream body', async () => {
    const huge = `${UPSTREAM_MARKER}${'x'.repeat(5000)}`;
    const fetchStub = stubFetch(
      new Response(huge, { status: 500, headers: { 'content-type': 'application/json' } }),
    );
    await failCards(fetchStub.fetchFn);
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).toContain(UPSTREAM_MARKER);
    // 300 characters plus an ellipsis, and flattened so a value containing
    // newlines cannot forge extra log lines.
    expect(logged.length).toBeLessThan(500);
    expect(logged).toContain('…');
  });

  it('flattens newlines in logged upstream text', async () => {
    const fetchStub = stubFetch(
      new Response('line-one\nFAKE-SECOND-LOG-LINE', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await failCards(fetchStub.fetchFn);
    const logged = errorSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('\nFAKE-SECOND-LOG-LINE');
    expect(logged).toContain('line-one FAKE-SECOND-LOG-LINE');
  });

  it('translates an unexpected throw into a generic error instead of propagating it', async () => {
    const { asAiJobError } = await router();
    const err = asAiJobError(new TypeError(`cannot read ${SENTINEL}`), 'openai');
    expect(err.code).toBe('capture_upstream_error');
    expect(err.status).toBe(502);
    expect(err.message).not.toContain(SENTINEL);
    // The detail is logged, because a bug is exactly what an operator needs to see.
    expect(errorSpy.mock.calls.flat().join(' ')).toContain(SENTINEL);
  });

  it('passes an AiJobError through asAiJobError unchanged', async () => {
    const { asAiJobError, AiJobError } = await router();
    const original = new AiJobError('capture_not_configured', 503, 'openai');
    expect(asAiJobError(original)).toBe(original);
  });
});

describe('router — the test-connection fixtures', () => {
  it('generates a valid one-second silent WAV', async () => {
    const { silentWav } = await import('../router.ts');
    const blob = silentWav();
    expect(blob.type).toBe('audio/wav');
    // 44 bytes of RIFF header plus one second of 16 kHz mono 16-bit silence.
    expect(blob.size).toBe(44 + 16000 * 2);

    const buffer = Buffer.from(await blob.arrayBuffer());
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buffer.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(buffer.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(buffer.subarray(36, 40).toString('ascii')).toBe('data');
    expect(buffer.readUInt16LE(20)).toBe(1); // PCM
    expect(buffer.readUInt16LE(22)).toBe(1); // mono
    expect(buffer.readUInt32LE(24)).toBe(16000);
    expect(buffer.readUInt32LE(40)).toBe(32000);
    // The data chunk is silence: a real provider rejects noise-free garbage but
    // accepts zeros, and zeros are what "nothing was said" sounds like.
    expect(buffer.subarray(44).every((byte) => byte === 0)).toBe(true);
  });

  it('carries a two-line transcript no provider can mistake for a probe', async () => {
    const { TEST_TRANSCRIPT, TEST_SLIDE_CONTEXT } = await import('../router.ts');
    expect(TEST_TRANSCRIPT).toHaveLength(2);
    expect(TEST_TRANSCRIPT[0].speakerId).not.toBe(TEST_TRANSCRIPT[1].speakerId);
    for (const chunk of TEST_TRANSCRIPT) {
      expect(chunk.text.length).toBeGreaterThan(10);
      expect(chunk.endMs).toBeGreaterThan(chunk.startMs);
    }
    expect(TEST_SLIDE_CONTEXT.slideTitle).toBe('Connection test');
  });
});
