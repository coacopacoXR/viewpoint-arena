// Tests for lib/ai/providers.ts — the one description of each provider, read by
// both the router and the admin form.
//
// The point of a single descriptor list is that the form and the router cannot
// disagree. These tests pin the table from docs/plan/14-rooms-models-admin-ai.md
// batch BF, so a provider that grows a job or loses a required field fails here
// rather than in an administrator's meeting. They also pin the parsing rules that
// decide whether a stored row is usable at all — a row the router cannot
// understand must degrade to the default, not take capture down.
//
// jsdom is fine here: this module is browser-safe by design and touches no
// node: builtin, no process.env and no network.

import { describe, it, expect } from 'vitest';
import {
  AI_JOBS,
  AI_JOB_LABELS,
  AI_PROVIDERS,
  AI_SOURCE_LABELS,
  aiSettingKey,
  describeInUse,
  isAbsoluteHttpUrl,
  isAiProviderId,
  modelForJob,
  parseAiJobSetting,
  providerById,
  providerCanDoJob,
  providersForJob,
  requiresSecret,
  type AiJob,
  type AiProviderId,
} from '../providers.ts';

/** The table from the plan, transcribed. If this drifts, one of the two is wrong. */
const DOCUMENTED: Record<AiProviderId, { jobs: AiJob[]; fields: string[]; secret: string | null }> = {
  builtin: { jobs: ['transcription', 'cards', 'summary'], fields: [], secret: null },
  openai: { jobs: ['transcription', 'cards', 'summary'], fields: ['apiKey', 'model'], secret: 'apiKey' },
  anthropic: { jobs: ['cards', 'summary'], fields: ['apiKey', 'model'], secret: 'apiKey' },
  azureOpenai: {
    jobs: ['transcription', 'cards', 'summary'],
    fields: ['endpoint', 'apiKey', 'deployment', 'apiVersion'],
    secret: 'apiKey',
  },
  gemini: { jobs: ['cards', 'summary'], fields: ['apiKey', 'model'], secret: 'apiKey' },
  openaiCompatible: {
    jobs: ['transcription', 'cards', 'summary'],
    fields: ['baseUrl', 'apiKey', 'model'],
    secret: 'apiKey',
  },
  webhook: {
    jobs: ['transcription', 'cards', 'summary'],
    fields: ['url', 'headerName', 'headerValue'],
    secret: 'headerValue',
  },
};

describe('providers — the documented table', () => {
  it('describes exactly the seven providers', () => {
    expect(AI_PROVIDERS.map((p) => p.id).sort()).toEqual(Object.keys(DOCUMENTED).sort());
  });

  it.each(Object.entries(DOCUMENTED))('%s does the documented jobs', (id, expected) => {
    const provider = providerById(id as AiProviderId);
    expect(provider, `no descriptor for ${id}`).not.toBeNull();
    expect([...provider!.jobs].sort()).toEqual([...expected.jobs].sort());
  });

  it.each(Object.entries(DOCUMENTED))('%s has the documented fields', (id, expected) => {
    const provider = providerById(id as AiProviderId);
    expect(provider!.fields.map((f) => f.name)).toEqual(expected.fields);
    expect(provider!.secretField).toBe(expected.secret);
  });

  it('lists builtin first, because it is what a fresh install runs', () => {
    expect(AI_PROVIDERS[0].id).toBe('builtin');
    for (const job of AI_JOBS) {
      expect(providersForJob(job)[0].id).toBe('builtin');
    }
  });

  it('never offers a provider for a job it cannot do', () => {
    for (const job of AI_JOBS) {
      for (const provider of providersForJob(job)) {
        expect(provider.jobs).toContain(job);
      }
    }
    // The two that have no audio API. A dropdown that offered either would let an
    // administrator save a setting that fails at the first live-transcript chunk.
    expect(providerCanDoJob('anthropic', 'transcription')).toBe(false);
    expect(providerCanDoJob('gemini', 'transcription')).toBe(false);
    expect(providerCanDoJob('anthropic', 'cards')).toBe(true);
    expect(providerCanDoJob('webhook', 'summary')).toBe(true);
  });

  it('names the three jobs, with a label a person reads', () => {
    expect(AI_JOBS).toEqual(['transcription', 'cards', 'summary']);
    for (const job of AI_JOBS) {
      expect(AI_JOB_LABELS[job].length).toBeGreaterThan(0);
    }
    expect(AI_JOB_LABELS.cards).toContain('risks');
  });

  it('says so in the openai-compatible provider\u2019s help text, which is the one that covers everybody else', () => {
    // vLLM, LM Studio, LiteLLM, Mistral, Groq, Together and most enterprise
    // gateways all speak the OpenAI API. An administrator who cannot find their
    // vendor in the dropdown has to be told that this is the entry for it.
    const help = providerById('openaiCompatible')?.help ?? '';
    for (const name of ['vLLM', 'LM Studio', 'LiteLLM', 'Mistral', 'Groq', 'Together', 'gateway']) {
      expect(help).toContain(name);
    }
  });

  it('points the webhook provider at the written contract', () => {
    const fields = providerById('webhook')?.fields ?? [];
    const url = fields.find((f) => f.name === 'url');
    expect(url?.help).toContain('api/ai/WEBHOOK.md');
  });

  it('marks a credential required only where one is required', () => {
    expect(requiresSecret('openai')).toBe(true);
    expect(requiresSecret('anthropic')).toBe(true);
    expect(requiresSecret('azureOpenai')).toBe(true);
    expect(requiresSecret('gemini')).toBe(true);
    // vLLM on a trusted network and an internal webhook both work without a
    // credential, and reporting them as missing one would send an administrator to
    // fix something that is not broken.
    expect(requiresSecret('openaiCompatible')).toBe(false);
    expect(requiresSecret('webhook')).toBe(false);
    expect(requiresSecret('builtin')).toBe(false);
  });

  it('has a password field for every secret, and no password field that is not one', () => {
    for (const provider of AI_PROVIDERS) {
      const secretField = provider.fields.find((f) => f.name === provider.secretField);
      if (provider.secretField === null) {
        expect(provider.fields.some((f) => f.kind === 'password')).toBe(false);
      } else {
        expect(secretField?.kind).toBe('password');
      }
    }
  });

  it('offers a model list per job only where the provider has models to name', () => {
    // Azure addresses a model by DEPLOYMENT name, so there is no list to offer —
    // and a list of model names next to a deployment field is a prompt to type the
    // wrong thing.
    expect(providerById('azureOpenai')?.models).toEqual({});
    expect(providerById('builtin')?.models).toEqual({});
    expect(providerById('webhook')?.models).toEqual({});
    // OpenAI's list is per job, because audio models and chat models are not
    // interchangeable and each job has its own setting.
    const openai = providerById('openai')?.models ?? {};
    expect(openai.transcription?.length).toBeGreaterThan(0);
    expect(openai.cards?.length).toBeGreaterThan(0);
    expect(openai.transcription).not.toEqual(openai.cards);
    expect(openai.transcription?.some((m) => m.includes('whisper'))).toBe(true);
  });
});

describe('providers — isAbsoluteHttpUrl', () => {
  it.each([
    'https://gateway.acme.com/v1',
    'http://vllm.internal:8000/v1',
    'https://contoso.openai.azure.com',
  ])('accepts %s', (value) => {
    expect(isAbsoluteHttpUrl(value)).toBe(true);
  });

  it.each([
    ['a relative path', '/api/ai'],
    ['a protocol-relative URL', '//gateway.acme.com/v1'],
    ['a file URL', 'file:///etc/passwd'],
    ['a data URL', 'data:text/plain,hello'],
    ['a bare host', 'gateway.acme.com'],
    ['prose', 'not a url'],
    ['an empty string', ''],
  ])('refuses %s', (_label, value) => {
    // A relative URL would resolve against this server, which is a request loop;
    // a file or data URL from inside a container is not a hypothetical.
    expect(isAbsoluteHttpUrl(value)).toBe(false);
  });
});

describe('providers — the stored setting', () => {
  it('keys a setting by job', () => {
    expect(aiSettingKey('transcription')).toBe('ai.transcription');
    expect(aiSettingKey('cards')).toBe('ai.cards');
    expect(aiSettingKey('summary')).toBe('ai.summary');
  });

  it('accepts a complete setting and keeps only the fields it knows', () => {
    const parsed = parseAiJobSetting('cards', {
      provider: 'openai',
      fields: { model: 'gpt-4o-mini', somethingElse: 'dropped' },
    });
    expect(parsed).toEqual({ provider: 'openai', fields: { model: 'gpt-4o-mini' } });
  });

  it('never reads a credential out of the value column', () => {
    // The secret belongs in its own encrypted column. A row that smuggles one into
    // `fields` is treated as not having one, which is the safe reading: the value
    // column is the one the admin screen is allowed to render.
    const parsed = parseAiJobSetting('cards', {
      provider: 'openai',
      fields: { model: 'gpt-4o-mini', apiKey: 'sk-should-not-survive' },
    });
    expect(parsed?.fields.apiKey).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('sk-should-not-survive');
  });

  it('refuses a setting for a job the provider cannot do', () => {
    expect(parseAiJobSetting('transcription', { provider: 'anthropic', fields: { model: 'x' } })).toBeNull();
    expect(parseAiJobSetting('transcription', { provider: 'gemini', fields: { model: 'x' } })).toBeNull();
  });

  it.each([
    ['is not an object', 'openai'],
    ['is an array', []],
    ['is null', null],
    ['names an unknown provider', { provider: 'skynet', fields: {} }],
    ['names no provider', { fields: {} }],
    ['has a non-object fields value', { provider: 'openai', fields: 'nope' }],
    ['omits a required field', { provider: 'webhook', fields: {} }],
    ['has a blank required field', { provider: 'webhook', fields: { url: '   ' } }],
    ['has a non-string required field', { provider: 'webhook', fields: { url: 42 } }],
    ['has a relative URL', { provider: 'webhook', fields: { url: '/api/ai' } }],
  ])('refuses a stored row that %s', (_label, value) => {
    // Returning null rather than throwing is the contract: a row an older version
    // wrote must cost an installation its saved preference, not its capture.
    expect(parseAiJobSetting('cards', value)).toBeNull();
  });

  it('accepts an optional field left out entirely', () => {
    expect(parseAiJobSetting('cards', { provider: 'webhook', fields: { url: 'https://ai.internal/vp' } })).toEqual({
      provider: 'webhook',
      fields: { url: 'https://ai.internal/vp' },
    });
    expect(
      parseAiJobSetting('cards', {
        provider: 'openaiCompatible',
        fields: { baseUrl: 'http://vllm.internal:8000/v1', model: 'qwen2.5:7b' },
      }),
    ).not.toBeNull();
  });

  it('accepts the built-in provider with no fields at all', () => {
    expect(parseAiJobSetting('transcription', { provider: 'builtin' })).toEqual({
      provider: 'builtin',
      fields: {},
    });
  });

  it('recognises a provider id and refuses anything else', () => {
    expect(isAiProviderId('openai')).toBe(true);
    expect(isAiProviderId('skynet')).toBe(false);
    expect(isAiProviderId(undefined)).toBe(false);
    expect(isAiProviderId(42)).toBe(false);
  });
});

describe('providers — the model a job asks for', () => {
  it('uses the typed model over the default', () => {
    const setting = { provider: 'openai' as AiProviderId, fields: { model: 'gpt-5' } };
    expect(modelForJob('cards', setting)).toBe('gpt-5');
  });

  it('falls back to the provider\u2019s default for THIS job', () => {
    // Each job has its own setting, so the same provider can default to an audio
    // model for transcription and a chat model for cards.
    expect(modelForJob('transcription', { provider: 'openai', fields: {} })).toContain('transcribe');
    expect(modelForJob('cards', { provider: 'openai', fields: {} })).toBe('gpt-4o-mini');
    expect(modelForJob('summary', { provider: 'anthropic', fields: {} })).toBe('claude-sonnet-4-5');
  });

  it('ignores a blank model and trims a typed one', () => {
    expect(modelForJob('cards', { provider: 'openai', fields: { model: '   ' } })).toBe('gpt-4o-mini');
    expect(modelForJob('cards', { provider: 'openai', fields: { model: ' gpt-5 ' } })).toBe('gpt-5');
  });

  it('answers null for a provider with no model field', () => {
    // Azure names a DEPLOYMENT, not a model; the built-in stack and a webhook have
    // no model to choose at all. A null here is not a failure — it is the router's
    // signal to leave the field out of the request.
    expect(modelForJob('cards', { provider: 'azureOpenai', fields: { deployment: 'gpt-4o-mini' } })).toBeNull();
    expect(modelForJob('cards', { provider: 'builtin', fields: {} })).toBeNull();
    expect(modelForJob('cards', { provider: 'webhook', fields: { url: 'https://x/vp' } })).toBeNull();
  });
});

describe('providers — the line the admin screen shows', () => {
  it('names the provider, the model and where the choice came from', () => {
    expect(describeInUse('cards', 'openai', 'gpt-4o-mini', 'settings')).toBe('OpenAI gpt-4o-mini · set here');
    expect(describeInUse('cards', 'openai', 'gpt-4o-mini', 'config')).toBe(
      'OpenAI gpt-4o-mini · viewpoint.config.ts',
    );
    expect(describeInUse('transcription', 'builtin', null, 'default')).toContain('default');
  });

  it('describes the built-in stack in words an operator recognises', () => {
    const label = describeInUse('transcription', 'builtin', null, 'default');
    expect(label).toContain('Built-in');
    expect(label).toContain('this server');
    // It names the models the bundled stack actually runs, so an operator can tell
    // it apart from a cloud provider at a glance.
    expect(label).toContain('Whisper');
    expect(label).toContain('Qwen');
  });

  it('never puts a source in the label that is not one of the three', () => {
    expect(Object.keys(AI_SOURCE_LABELS).sort()).toEqual(['config', 'default', 'settings']);
  });

  it('falls back to the raw id for a provider it does not know', () => {
    // Defensive: describeInUse is rendered in a browser, and throwing there would
    // blank the whole section over one bad row.
    expect(describeInUse('cards', 'skynet' as AiProviderId, null, 'settings')).toContain('skynet');
  });
});

describe('providers — nothing a browser must not have', () => {
  it('carries no default credential and no placeholder that looks like one', () => {
    for (const provider of AI_PROVIDERS) {
      for (const field of provider.fields) {
        expect(field.placeholder ?? '').not.toMatch(/^sk-[A-Za-z0-9]/);
        expect(JSON.stringify(field)).not.toContain('JWT_SECRET');
      }
    }
  });

  it('names no vendor endpoint — the router owns those', () => {
    // A descriptor is rendered in a browser. If it carried api.openai.com the
    // bundle would tell every visitor which hosts this app talks to, and there
    // would be two places to change when one moves.
    const source = JSON.stringify(AI_PROVIDERS);
    expect(source).not.toContain('api.openai.com');
    expect(source).not.toContain('api.anthropic.com');
    expect(source).not.toContain('generativelanguage.googleapis.com');
  });
});
