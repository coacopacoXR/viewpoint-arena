// Tests for the admin console's AI section (plan 14, BF).
//
// The form is driven by lib/ai/providers.ts, so these assertions read the
// descriptors instead of repeating them: a provider list, a field list or a
// model list hardcoded here would keep passing after the descriptor changed,
// which is exactly the drift the single description exists to prevent.
//
// Two properties are checked that a fixture-driven test would otherwise miss:
//   * a dropdown never offers a provider that cannot do the job;
//   * a stored credential is rendered as a status line and its value appears
//     nowhere in the document. The fixture below smuggles in a `value` field
//     the real API never sends, so a component that echoed what it was handed
//     about a key would fail rather than pass vacuously.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import AiSettingsSection from '../AiSettingsSection';
import {
  AI_JOBS,
  AI_JOB_LABELS,
  providerById,
  providersForJob,
  requiresSecret,
  type AiJob,
} from '../../../lib/ai/providers';

const GET_PATH = '/api/admin/ai';
const TEST_PATH = '/api/admin/ai/test';

/** A credential the read API never returns. Present in the fixture on purpose. */
const LEAKED_KEY = 'sk-leaked-value-that-must-never-render';

const BUILTIN_IN_USE = {
  provider: 'builtin',
  source: 'default',
  model: null,
  missingSecret: false,
};
const BUILTIN_LABEL = 'Built-in Whisper and Qwen on this server · default';

function savedTranscription() {
  return {
    provider: 'openai',
    fields: { model: 'whisper-1' },
    secret: { set: true, last4: '7f2a', unreadable: false },
    unusable: false,
    updatedAt: '2026-09-24T10:00:00.000Z',
    updatedBy: 'admin-1',
  };
}

/** A GET body, with the transcription job patchable per test. */
function listBody(transcription: Record<string, unknown> = {}) {
  return {
    available: true,
    jobs: [
      {
        job: 'transcription',
        saved: savedTranscription(),
        inUse: {
          provider: 'openai',
          source: 'settings',
          model: 'whisper-1',
          missingSecret: false,
        },
        inUseLabel: 'OpenAI whisper-1 · set here',
        ...transcription,
      },
      { job: 'cards', saved: null, inUse: BUILTIN_IN_USE, inUseLabel: BUILTIN_LABEL },
      { job: 'summary', saved: null, inUse: BUILTIN_IN_USE, inUseLabel: BUILTIN_LABEL },
    ],
  };
}

interface StubOptions {
  getStatus?: number;
  getBody?: unknown;
  putStatus?: number;
  putBody?: unknown;
  testStatus?: number;
  testBody?: unknown;
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(options: StubOptions = {}): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (url === TEST_PATH) {
        return jsonResponse(
          options.testBody ?? { ok: true, job: 'transcription', ms: 1400 },
          options.testStatus ?? 200,
        );
      }
      if (method === 'PUT') {
        return jsonResponse(
          options.putBody ?? {
            ok: true,
            job: 'transcription',
            saved: savedTranscription(),
            inUse: {
              provider: 'openai',
              source: 'settings',
              model: 'whisper-1',
              missingSecret: false,
            },
          },
          options.putStatus ?? 200,
        );
      }
      return jsonResponse(options.getBody ?? listBody(), options.getStatus ?? 200);
    }),
  );
  return calls;
}

function lastCall(calls: RecordedCall[], url: string, method: string): RecordedCall | undefined {
  return [...calls].reverse().find((c) => c.url === url && c.method === method);
}

function card(job: AiJob): HTMLElement {
  return screen.getByTestId(`ai-card-${job}`);
}

function buttonIn(job: AiJob, name: string): HTMLElement {
  return within(card(job)).getByRole('button', { name });
}

/** The cards only exist once the load has settled. */
async function loaded(job: AiJob = 'transcription'): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(`ai-in-use-${job}`)).toBeTruthy());
}

function optionValues(job: AiJob): string[] {
  return Array.from(screen.getByTestId(`ai-provider-${job}`).querySelectorAll('option')).map(
    (o) => o.value,
  );
}

/** The names of the fields a card is currently rendering, in DOM order. */
function renderedFields(job: AiJob): (string | null)[] {
  return Array.from(card(job).querySelectorAll('[data-field-name]')).map((el) =>
    el.getAttribute('data-field-name'),
  );
}

describe('AiSettingsSection', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders one card per job, each offering only the providers that can do it', async () => {
    stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    for (const job of AI_JOBS) {
      expect(screen.getByText(AI_JOB_LABELS[job])).toBeTruthy();
      expect(screen.getByTestId(`ai-card-${job}`)).toBeTruthy();
      expect(optionValues(job)).toEqual(providersForJob(job).map((p) => p.id));
    }

    // The filter is the feature: Anthropic and Gemini take text and images, not
    // audio, so offering them for transcription would save a setting that fails
    // during the first meeting anyone holds.
    expect(optionValues('transcription')).not.toContain('anthropic');
    expect(optionValues('transcription')).not.toContain('gemini');
    expect(optionValues('cards')).toContain('anthropic');
    expect(optionValues('cards')).toContain('gemini');
    expect(optionValues('summary')).toContain('anthropic');
  });

  it('renders a stored key as a status line, and its value nowhere', async () => {
    stubFetch({
      getBody: listBody({
        saved: {
          ...savedTranscription(),
          // No such field exists in the API. Anything the component rendered
          // from it would be a leak this test is here to catch.
          secret: { set: true, last4: '7f2a', unreadable: false, value: LEAKED_KEY },
        },
      }),
    });
    render(<AiSettingsSection />);
    await loaded();

    expect(screen.getByText('Key set · ends in …7f2a')).toBeTruthy();
    expect(screen.queryByDisplayValue(LEAKED_KEY)).toBeNull();
    expect(document.body.textContent).not.toContain(LEAKED_KEY);
    expect(document.body.innerHTML).not.toContain(LEAKED_KEY);
  });

  it('renders exactly the chosen provider’s fields, in descriptor order', async () => {
    stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    const select = screen.getByTestId('ai-provider-cards');

    // The default has no fields at all, which is the point of it.
    expect(renderedFields('cards')).toEqual([]);

    fireEvent.change(select, { target: { value: 'openai' } });
    const openai = providerById('openai');
    const webhook = providerById('webhook');
    expect(openai).not.toBeNull();
    expect(webhook).not.toBeNull();
    expect(renderedFields('cards')).toEqual(openai?.fields.map((f) => f.name) ?? []);

    // A different provider has a different set — and switching drops the old
    // values, so nothing typed for OpenAI can be posted under a webhook name.
    fireEvent.change(screen.getByTestId('ai-input-cards-model'), {
      target: { value: 'gpt-4o-mini' },
    });
    fireEvent.change(select, { target: { value: 'webhook' } });
    expect(renderedFields('cards')).toEqual(webhook?.fields.map((f) => f.name) ?? []);
    expect(screen.queryByTestId('ai-input-cards-model')).toBeNull();
    expect(renderedFields('cards')).not.toEqual(openai?.fields.map((f) => f.name) ?? []);
  });

  it('renders a model field as free text with the descriptor’s suggestions', async () => {
    stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    fireEvent.change(screen.getByTestId('ai-provider-cards'), { target: { value: 'openai' } });

    const model = screen.getByTestId('ai-input-cards-model');
    expect(model.getAttribute('type')).toBe('text');
    expect(model.getAttribute('list')).toBe('ai-input-cards-model-models');

    const suggested = Array.from(
      card('cards').querySelectorAll('datalist#ai-input-cards-model-models option'),
    ).map((o) => o.getAttribute('value'));
    const openai = providerById('openai');
    expect(suggested).toEqual([...(openai?.models.cards ?? [])]);
  });

  it('renders the secret field as a password the browser will not fill', async () => {
    stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    fireEvent.change(screen.getByTestId('ai-provider-cards'), { target: { value: 'openai' } });

    const key = screen.getByTestId('ai-input-cards-apiKey');
    expect(key.getAttribute('type')).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('off');
    // Nothing is stored for this job yet, so the box says a key is required.
    expect(screen.getByTestId('ai-secret-status-cards').textContent).toContain(
      'No key is stored — one is required.',
    );
  });

  it('calls the credential optional for a provider that works without one', async () => {
    stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    // Both of these HAVE a secret field, so `secretField !== null` would call
    // them misconfigured and send an administrator chasing a key that a model
    // server on a trusted network never asked for.
    expect(requiresSecret('webhook')).toBe(false);
    expect(requiresSecret('openaiCompatible')).toBe(false);
    expect(requiresSecret('openai')).toBe(true);

    fireEvent.change(screen.getByTestId('ai-provider-cards'), { target: { value: 'webhook' } });
    expect(screen.getByTestId('ai-secret-status-cards').textContent).toContain(
      'No key is stored — it is optional for this provider.',
    );
    expect(screen.getByTestId('ai-input-cards-headerValue').getAttribute('placeholder')).toBe(
      'Optional',
    );

    fireEvent.change(screen.getByTestId('ai-provider-cards'), {
      target: { value: 'openaiCompatible' },
    });
    expect(screen.getByTestId('ai-secret-status-cards').textContent).toContain(
      'No key is stored — it is optional for this provider.',
    );
  });

  it('reports a working connection with the elapsed time, and posts the draft', async () => {
    const calls = stubFetch({ testBody: { ok: true, job: 'transcription', ms: 1400 } });
    render(<AiSettingsSection />);
    await loaded();

    // A model the saved row does not have, so the body can only have come from
    // what is on screen rather than from the GET.
    fireEvent.change(screen.getByTestId('ai-input-transcription-model'), {
      target: { value: 'gpt-4o-mini-transcribe' },
    });
    fireEvent.change(screen.getByTestId('ai-input-transcription-apiKey'), {
      target: { value: 'sk-typed-by-the-admin' },
    });
    fireEvent.click(buttonIn('transcription', 'Test connection'));

    await waitFor(() => expect(screen.getByText('Works — answered in 1.4 s')).toBeTruthy());
    expect(lastCall(calls, TEST_PATH, 'POST')?.body).toEqual({
      job: 'transcription',
      provider: 'openai',
      fields: { model: 'gpt-4o-mini-transcribe' },
      secret: 'sk-typed-by-the-admin',
    });
  });

  it('renders a failed connection’s reason verbatim', async () => {
    const reason = 'ai/openai: capture_not_configured (no apiKey is stored for this job)';
    stubFetch({
      testBody: {
        ok: false,
        job: 'transcription',
        ms: 900,
        code: 'capture_not_configured',
        reason,
      },
    });
    render(<AiSettingsSection />);
    await loaded();

    fireEvent.click(buttonIn('transcription', 'Test connection'));

    // The whole text content, not a substring: the server wrote this sentence
    // for a human and already stripped it of keys and transcripts, so nothing
    // may be added to it or reworded from `code`.
    await waitFor(() =>
      expect(screen.getByTestId('ai-test-result-transcription').textContent).toBe(reason),
    );
  });

  it('omits secret from the PUT body when the key box is blank, and sends it when typed', async () => {
    const calls = stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    const save = buttonIn('cards', 'Save');
    fireEvent.change(screen.getByTestId('ai-provider-cards'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByTestId('ai-input-cards-model'), {
      target: { value: 'gpt-4o-mini' },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(lastCall(calls, GET_PATH, 'PUT')?.body).toEqual({
        job: 'cards',
        provider: 'openai',
        fields: { model: 'gpt-4o-mini' },
      }),
    );
    // toEqual treats an absent key and an undefined one alike; the API does not.
    const blankBody = lastCall(calls, GET_PATH, 'PUT')?.body as Record<string, unknown>;
    expect(Object.keys(blankBody)).not.toContain('secret');

    fireEvent.change(screen.getByTestId('ai-input-cards-apiKey'), { target: { value: 'sk-typed' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(lastCall(calls, GET_PATH, 'PUT')?.body).toEqual({
        job: 'cards',
        provider: 'openai',
        fields: { model: 'gpt-4o-mini' },
        secret: 'sk-typed',
      }),
    );
  });

  it('refuses a base URL that is not absolute, without calling the API', async () => {
    const calls = stubFetch();
    render(<AiSettingsSection />);
    await loaded();

    fireEvent.change(screen.getByTestId('ai-provider-cards'), {
      target: { value: 'openaiCompatible' },
    });
    fireEvent.change(screen.getByTestId('ai-input-cards-baseUrl'), {
      target: { value: 'gateway.acme.com/v1' },
    });
    fireEvent.change(screen.getByTestId('ai-input-cards-model'), {
      target: { value: 'qwen2.5:7b' },
    });
    fireEvent.click(buttonIn('cards', 'Save'));

    await waitFor(() =>
      expect(
        screen.getByText('Base URL must be a full web address, like https://example.com.'),
      ).toBeTruthy(),
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('surfaces a failed load as a message instead of throwing', async () => {
    stubFetch({ getStatus: 500, getBody: { error: 'boom' } });
    render(<AiSettingsSection />);

    await waitFor(() => expect(screen.getByTestId('ai-load-error')).toBeTruthy());
    expect(screen.getByTestId('ai-load-error').textContent).toBe(
      'The server refused the request (HTTP 500).',
    );
    expect(screen.queryByTestId('ai-card-transcription')).toBeNull();
  });

  it('turns secret_required into a sentence', async () => {
    const calls = stubFetch({
      putStatus: 400,
      putBody: { error: 'secret_required', field: 'apiKey' },
    });
    render(<AiSettingsSection />);
    await loaded();

    fireEvent.change(screen.getByTestId('ai-provider-cards'), { target: { value: 'openai' } });
    fireEvent.click(buttonIn('cards', 'Save'));

    await waitFor(() =>
      expect(
        screen.getByText(
          'This provider needs a key and none is stored. Type the key in, then save again.',
        ),
      ).toBeTruthy(),
    );
    expect(calls.filter((c) => c.url === GET_PATH && c.method === 'PUT')).toHaveLength(1);
  });

  it('says settings cannot be saved when the deployment has no store', async () => {
    stubFetch({ getBody: { ...listBody(), available: false } });
    render(<AiSettingsSection />);
    await loaded();

    expect(screen.getByTestId('ai-unavailable').textContent).toContain(
      'AI settings cannot be saved on this deployment',
    );
    // Read-only rather than a Save that can only answer 503.
    expect((buttonIn('cards', 'Save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('ai-in-use-cards').textContent).toContain(BUILTIN_LABEL);
  });

  it('warns when the provider in use wants a key and none is stored', async () => {
    stubFetch({
      getBody: listBody({
        inUse: {
          provider: 'openai',
          source: 'settings',
          model: 'whisper-1',
          missingSecret: true,
        },
      }),
    });
    render(<AiSettingsSection />);
    await loaded();

    expect(card('transcription').textContent).toContain(
      'The provider in use wants a key and none is stored',
    );
  });
});
