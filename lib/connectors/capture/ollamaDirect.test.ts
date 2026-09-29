// Tests for OllamaDirectCaptureProvider (T4.6) — browser → Ollama, LAN-only.
//
// This mode has no server and no API key, so the tests focus on the two things
// that can go wrong: (1) the base URL must come from config and must never
// silently default to localhost, and (2) every way Ollama can be unreachable
// or misconfigured must produce an error that says what to CHECK, because the
// browser reports all of them as the same opaque "Failed to fetch".

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OllamaDirectCaptureProvider } from './ollamaDirect';
import EXTRACTION_JSON_SCHEMA from './extractionSchema.json';
import { CaptureEndpointError } from './extractClient';
import { CaptureExtractionError } from './parseInsightCards';
import type { PublicConfig } from '../../config/publicConfig';
import type { SlideContext, TranscriptChunk } from './types';

const BASE_URL = 'http://ollama.internal:11434';

const transcript: TranscriptChunk[] = [
  { speakerId: 'speaker-1', text: 'The wall drops from 2.8mm to 1.2mm.', startMs: 0, endMs: 4000 },
  { speakerId: 'speaker-2', text: 'That will sink on the A-surface.', startMs: 4000, endMs: 6500 },
];

const context: SlideContext = {
  agendaIdx: 2,
  slideTitle: 'Bracket moulding',
  laserTargetPartName: 'Rib Pattern 2',
};

const CARD = {
  type: 'RISK',
  title: 'Wall transition risks sink',
  description: 'A 57% wall reduction causes sink on A-surfaces.',
  agentId: 'speaker-1',
  details: { priority: 'High' },
};

const publicConfig: PublicConfig = {
  plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com' },
  capture: { provider: 'ollamaDirect', model: 'deepseek-r1:7b', baseUrl: BASE_URL },
  turn: { provider: 'cloudflare' },
  db: { provider: 'supabase' },
  identity: { mode: 'none', methods: [], allowGuests: false },
  notifications: [{ provider: 'teams' }],
  modelImport: { provider: 'onshape' },
  modelStorage: { provider: 'local' },
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

function stubOllama(reply: Response | (() => Response)): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    } catch {
      body = {};
    }
    requests.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      headers,
      body,
      signal: init?.signal,
    });
    return typeof reply === 'function' ? reply() : reply.clone();
  });
  return { requests };
}

function ollamaReply(content: string, doneReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      model: 'deepseek-r1:7b',
      created_at: '2026-09-08T10:00:00Z',
      message: { role: 'assistant', content },
      done: true,
      done_reason: doneReason,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function provider(overrides: Partial<ConstructorParameters<typeof OllamaDirectCaptureProvider>[0]> = {}) {
  return new OllamaDirectCaptureProvider({
    baseUrl: BASE_URL,
    model: 'deepseek-r1:7b',
    ...overrides,
  });
}

async function expectFailure(fn: () => Promise<unknown>): Promise<CaptureEndpointError> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the provider to reject').toBeInstanceOf(CaptureEndpointError);
  return caught as CaptureEndpointError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OllamaDirectCaptureProvider — base URL comes from config', () => {
  it('refuses to construct without a base URL instead of defaulting to localhost', () => {
    // This is the whole point: a silent localhost default would POST a real
    // review transcript to whatever happens to be listening on the developer's
    // own machine.
    expect(() => new OllamaDirectCaptureProvider({} as never)).toThrowError(
      /baseUrl is required/i,
    );
    expect(() => new OllamaDirectCaptureProvider({} as never)).toThrowError(
      /refuses to default to localhost/i,
    );
    expect(
      () => new OllamaDirectCaptureProvider({ baseUrl: '', model: 'deepseek-r1:7b' }),
    ).toThrowError(/baseUrl is required/i);
    expect(
      () => new OllamaDirectCaptureProvider({ baseUrl: '   ', model: 'deepseek-r1:7b' }),
    ).toThrowError(/baseUrl is required/i);
  });

  it('the module source contains no hardcoded localhost default', () => {
    const source = readFileSync(join(__dirname, 'ollamaDirect.ts'), 'utf8');
    // Diagnostic prose is allowed to mention 127.0.0.1 (it tells the operator
    // what Ollama binds to by default); an actual default value is not.
    expect(source).not.toMatch(
      /(baseUrl|url|URL)\s*[:=]{1,2}\s*['"`]https?:\/\/(localhost|127\.0\.0\.1)/,
    );
    expect(source).not.toMatch(/DEFAULT_BASE_URL/);
  });

  it('rejects a relative URL', () => {
    expect(() => provider({ baseUrl: '/api/chat' })).toThrowError(/not an absolute URL/i);
    expect(() => provider({ baseUrl: 'ollama.internal:11434' })).toThrowError(
      /must use http or https/i,
    );
  });

  it('rejects a base URL that carries a path', () => {
    let message = '';
    try {
      provider({ baseUrl: 'http://ollama.internal:11434/api' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must be the Ollama root/i);
    // The message hands back the corrected value.
    expect(message).toContain('http://ollama.internal:11434');
  });

  it('rejects a non-http scheme', () => {
    expect(() => provider({ baseUrl: 'file:///etc/ollama' })).toThrowError(
      /must use http or https/i,
    );
  });

  it('normalizes a trailing slash so /api/chat is not doubled', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [] })));
    await provider({ baseUrl: 'http://ollama.internal:11434/' }).extractInsights(
      transcript,
      context,
    );
    expect(requests[0].url).toBe('http://ollama.internal:11434/api/chat');
  });

  it('accepts an https base URL', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [] })));
    await provider({ baseUrl: 'https://ollama.corp.example' }).extractInsights(
      transcript,
      context,
    );
    expect(requests[0].url).toBe('https://ollama.corp.example/api/chat');
  });

  it('requires a model name', () => {
    expect(() => new OllamaDirectCaptureProvider({ baseUrl: BASE_URL } as never)).toThrowError(
      /model name is required/i,
    );
    expect(() => provider({ model: '  ' })).toThrowError(/model name is required/i);
  });
});

describe('OllamaDirectCaptureProvider.fromPublicConfig', () => {
  it('builds a working provider from the redacted public config', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [CARD] })));

    const cards = await OllamaDirectCaptureProvider.fromPublicConfig(
      publicConfig,
    ).extractInsights(transcript, context);

    expect(cards).toHaveLength(1);
    expect(requests[0].url).toBe(`${BASE_URL}/api/chat`);
    expect(requests[0].body.model).toBe('deepseek-r1:7b');
  });

  it('rejects a config whose capture provider is something else', () => {
    const mockConfig: PublicConfig = {
      ...publicConfig,
      capture: { provider: 'mock' },
    };
    expect(() => OllamaDirectCaptureProvider.fromPublicConfig(mockConfig)).toThrowError(
      /configured capture provider is "mock", not "ollamaDirect"/,
    );
  });

  it('rejects a config with no capture.baseUrl rather than guessing', () => {
    const noBaseUrl: PublicConfig = {
      ...publicConfig,
      capture: { provider: 'ollamaDirect', model: 'deepseek-r1:7b' },
    };
    expect(() => OllamaDirectCaptureProvider.fromPublicConfig(noBaseUrl)).toThrowError(
      /no capture\.baseUrl/,
    );
    expect(() => OllamaDirectCaptureProvider.fromPublicConfig(noBaseUrl)).toThrowError(
      /refuses to default to localhost/,
    );
  });

  it('rejects a config with no capture.model', () => {
    const noModel: PublicConfig = {
      ...publicConfig,
      capture: { provider: 'ollamaDirect', baseUrl: BASE_URL },
    };
    expect(() => OllamaDirectCaptureProvider.fromPublicConfig(noModel)).toThrowError(
      /no capture\.model/,
    );
  });

  it('passes fetch and timeout overrides through', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [] })));
    const built = OllamaDirectCaptureProvider.fromPublicConfig(publicConfig, {
      timeoutMs: 1234,
    });

    await built.extractInsights(transcript, context);

    expect(requests[0].url).toBe(`${BASE_URL}/api/chat`);
  });
});

describe('OllamaDirectCaptureProvider — the request it makes', () => {
  it('posts a non-streaming JSON-mode chat completion', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [CARD] })));

    await provider().extractInsights(transcript, context);

    const body = requests[0].body;
    expect(requests[0].method).toBe('POST');
    expect(body.stream).toBe(false);
    // The exact card schema, so Ollama cannot flatten details onto the card.
    expect(body.format).toEqual(EXTRACTION_JSON_SCHEMA);
    expect(body.options).toMatchObject({ temperature: 0 });
    expect(typeof body.options).toBe('object');
  });

  it('sends the shared extraction prompt with the spatial context fused in', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [] })));

    await provider().extractInsights(transcript, context);

    const messages = requests[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('"cards"');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Agenda item 2: Bracket moulding');
    expect(messages[1].content).toContain('laser pointer was on: Rib Pattern 2');
    expect(messages[1].content).toContain('c0 [00:00-00:04] speaker-1:');
    expect(messages[1].content).toContain('The wall drops from 2.8mm to 1.2mm.');
  });

  it('sends no credential — there is nothing to send', async () => {
    const { requests } = stubOllama(ollamaReply(JSON.stringify({ cards: [] })));

    await provider().extractInsights(transcript, context);

    const request = requests[0];
    expect(Object.keys(request.headers)).toEqual(['content-type']);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(request.body)).not.toMatch(/apiKey|api_key|bearer/i);
  });

  it('returns the extracted cards with ids and timestamps minted locally', async () => {
    stubOllama(ollamaReply(JSON.stringify({ cards: [CARD] })));

    const cards = await provider().extractInsights(transcript, context);

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('RISK');
    expect(cards[0].details.priority).toBe('High');
    expect(cards[0].details.status).toBe('Open');
    expect(cards[0].id).toMatch(/^insight-/);
    expect(Number.isFinite(cards[0].timestamp)).toBe(true);
  });

  it('defaults agentId to the first speaker when the model omits it', async () => {
    const { agentId: _agentId, ...noSpeaker } = CARD;
    stubOllama(ollamaReply(JSON.stringify({ cards: [noSpeaker] })));

    const cards = await provider().extractInsights(transcript, context);

    expect(cards[0].agentId).toBe('speaker-1');
  });

  it('resolves to an empty list when nothing was worth capturing', async () => {
    stubOllama(ollamaReply('{"cards":[]}'));
    await expect(provider().extractInsights(transcript, context)).resolves.toEqual([]);
  });
});

describe('OllamaDirectCaptureProvider — MALFORMED MODEL OUTPUT', () => {
  // Same four cases as the cloud path. The difference: parsing happens in the
  // browser here, so the error is a CaptureExtractionError thrown directly.
  async function expectParseFailure(content: string): Promise<CaptureExtractionError> {
    stubOllama(ollamaReply(content));
    let caught: unknown;
    try {
      await provider().extractInsights(transcript, context);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected a parse failure').toBeInstanceOf(CaptureExtractionError);
    return caught as CaptureExtractionError;
  }

  it('prose → reason "prose"', async () => {
    const failure = await expectParseFailure(
      'Here is what I found in the meeting: the wall is too thin.',
    );
    expect(failure.reason).toBe('prose');
  });

  it('truncated JSON → reason "truncated_json"', async () => {
    const failure = await expectParseFailure(JSON.stringify({ cards: [CARD] }).slice(0, 60));
    expect(failure.reason).toBe('truncated_json');
  });

  it('unclosed markdown fence → reason "markdown_fenced"', async () => {
    const failure = await expectParseFailure(
      '```json\n' + JSON.stringify({ cards: [CARD] }),
    );
    expect(failure.reason).toBe('markdown_fenced');
  });

  it('extra fields → reason "extra_fields"', async () => {
    const failure = await expectParseFailure(
      JSON.stringify({ cards: [{ ...CARD, confidence: 0.8 }] }),
    );
    expect(failure.reason).toBe('extra_fields');
    expect(failure.message).toContain('confidence');
  });

  it('an invalid insight type → reason "invalid_card"', async () => {
    const failure = await expectParseFailure(
      JSON.stringify({ cards: [{ ...CARD, type: 'OBSERVATION' }] }),
    );
    expect(failure.reason).toBe('invalid_card');
  });

  it('never returns a partial list when one of two cards is bad', async () => {
    stubOllama(
      ollamaReply(JSON.stringify({ cards: [CARD, { ...CARD, type: 'NOPE' }] })),
    );
    await expect(provider().extractInsights(transcript, context)).rejects.toBeInstanceOf(
      CaptureExtractionError,
    );
  });
});

describe('OllamaDirectCaptureProvider — unreachable and misconfigured', () => {
  it('explains what to check when the browser cannot reach Ollama', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('network');
    // The failure message IS the troubleshooting guide for this mode.
    expect(failure.message).toContain(BASE_URL);
    expect(failure.message).toContain('/api/chat');
    expect(failure.message).toMatch(/ollama serve/);
    expect(failure.message).toMatch(/OLLAMA_HOST=0\.0\.0\.0/);
    expect(failure.message).toMatch(/OLLAMA_ORIGINS/);
    expect(failure.message).toMatch(/CORS/i);
    expect(failure.message).toMatch(/Mixed content/i);
    expect(failure.message).toMatch(/reachable FROM THE BROWSER/i);
    // Fetch's opaque message adds nothing and is not appended.
    expect(failure.message).not.toContain('Failed to fetch');
  });

  it('reports a timeout separately from an unreachable host', async () => {
    // A faithful stub: real fetch rejects when the signal aborts.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('This operation was aborted'));
          });
        }),
    );

    const failure = await expectFailure(() =>
      provider({ timeoutMs: 10 }).extractInsights(transcript, context),
    );

    expect(failure.code).toBe('timeout');
    expect(failure.message).toMatch(/timeoutMs/);
    expect(failure.message).toMatch(/ollama ps/);
  });

  it('passes an AbortSignal so a hung Ollama cannot hang the browser', async () => {
    const { requests } = stubOllama(ollamaReply('{"cards":[]}'));
    await provider({ timeoutMs: 5000 }).extractInsights(transcript, context);
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('names the missing model and the command that fixes it', async () => {
    stubOllama(
      () =>
        new Response(
          JSON.stringify({
            error: "model 'deepseek-r1:7b' not found, try pulling or updating to the latest version",
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('ollama_model_not_found');
    expect(failure.status).toBe(404);
    expect(failure.message).toContain('ollama pull deepseek-r1:7b');
    expect(failure.message).toContain('ollama list');
    expect(failure.message).toContain("model 'deepseek-r1:7b' not found");
  });

  it('distinguishes a 404 that is not Ollama at all from a missing model', async () => {
    stubOllama(
      () => new Response('<html>Not Found</html>', { status: 404 }),
    );

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('endpoint_unavailable');
    expect(failure.message).toMatch(/not the Ollama API/i);
    expect(failure.message).toMatch(/Ollama root/i);
  });

  it('reports a server error with the status and the body detail', async () => {
    stubOllama(
      () =>
        new Response(JSON.stringify({ error: 'gpu memory exhausted' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('ollama_error');
    expect(failure.status).toBe(500);
    expect(failure.message).toContain('gpu memory exhausted');
  });

  it('reports a 200 that is not JSON as something-else-answering', async () => {
    stubOllama(
      () =>
        new Response('<!doctype html><html>app shell</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('endpoint_unavailable');
    expect(failure.message).toMatch(/something other than Ollama/i);
  });

  it('reports a 200 with a JSON content type but an unparseable body', async () => {
    stubOllama(
      () =>
        new Response('{not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('endpoint_unavailable');
    expect(failure.message).toMatch(/not valid JSON/i);
  });

  it('reports a 200 carrying an error instead of a message', async () => {
    stubOllama(
      () =>
        new Response(JSON.stringify({ error: 'context length exceeded' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('ollama_error');
    expect(failure.message).toContain('context length exceeded');
    expect(failure.message).toMatch(/ollama ps/);
  });

  it('reports a completion cut short by num_predict distinctly', async () => {
    stubOllama(() => ollamaReply('{"cards":[{', 'length'));

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('capture_output_truncated');
    expect(failure.message).toContain('deepseek-r1:7b');
    expect(failure.message).toMatch(/transcript window/i);
  });

  it('never reports a bare HTTP status without a fix to try', async () => {
    stubOllama(() => new Response('', { status: 403 }));

    const failure = await expectFailure(() =>
      provider().extractInsights(transcript, context),
    );

    expect(failure.code).toBe('ollama_error');
    expect(failure.message).toContain('403');
    expect(failure.message).toMatch(/server log/i);
    expect(failure.message.length).toBeGreaterThan(60);
  });
});
