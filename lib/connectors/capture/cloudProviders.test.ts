// Tests for the browser-side cloud capture providers (T4.5):
// OpenAICaptureProvider, AnthropicCaptureProvider and the shared
// extractClient they both go through.
//
// The property that matters most here is negative: these modules hold no
// credential, send no credential, and cannot be handed one. Everything else is
// about turning an endpoint response — including every failure code the
// endpoint can produce — into either InsightCard[] or a clear Error.
//
// Since plan 14 batch BF there is a SECOND negative property, and it is the one
// these two classes now exist to demonstrate: they send no PROVIDER either.
// lib/ai/router.ts decides which AI extracts the cards, so a browser that named
// one would be a second place the decision is made. OpenAICaptureProvider and
// AnthropicCaptureProvider are therefore byte-identical on the wire and differ
// only in their class name — the tests below assert that sameness rather than a
// difference, which is the opposite of what they asserted before.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICaptureProvider } from './openai';
import { AnthropicCaptureProvider } from './anthropic';
import {
  CaptureEndpointError,
  EXTRACT_ENDPOINT,
  probeExtractEndpoint,
} from './extractClient';
import { CaptureExtractionError } from './parseInsightCards';
import type { SlideContext, TranscriptChunk } from './types';
import type { InsightCard } from '../../../types';

const transcript: TranscriptChunk[] = [
  { speakerId: 'speaker-1', text: 'The wall drops from 2.8mm to 1.2mm.', startMs: 0, endMs: 4000 },
  { speakerId: 'speaker-2', text: 'That will sink on the A-surface.', startMs: 4000, endMs: 6500 },
];

const context: SlideContext = {
  agendaIdx: 2,
  slideTitle: 'Bracket moulding',
  hoveredPartName: 'Bracket Alpha',
};

const CARD = {
  type: 'RISK',
  title: 'Wall transition risks sink',
  description: 'A 57% wall reduction causes sink on A-surfaces.',
  agentId: 'speaker-1',
  details: { priority: 'High', status: 'Open' },
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Stubs fetch, records the request the browser actually made. */
function stubFetch(reply: Response | (() => Response)): { requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      headers,
      body: String(init?.body ?? ''),
    });
    // A Response body can only be consumed once, and several tests below make
    // more than one request against the same stub.
    return typeof reply === 'function' ? reply() : reply.clone();
  });
  return { requests };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAICaptureProvider', () => {
  it('POSTs the transcript to our own endpoint and returns the cards', async () => {
    const { requests } = stubFetch(jsonResponse({ cards: [CARD] }));
    const provider = new OpenAICaptureProvider();

    const cards: InsightCard[] = await provider.extractInsights(transcript, context);

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('RISK');
    expect(cards[0].details.priority).toBe('High');
    expect(typeof cards[0].id).toBe('string');

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(EXTRACT_ENDPOINT);
    expect(requests[0].method).toBe('POST');
    // The transcript and the context, and nothing else. In particular NO
    // `provider` field: the server picks the AI now, and a body that named one
    // would be a second, contradicting answer to the same question.
    expect(JSON.parse(requests[0].body)).toEqual({ transcript, context });
    expect(Object.keys(JSON.parse(requests[0].body))).toEqual(['transcript', 'context']);
  });

  it('sends no credential of any kind', async () => {
    const { requests } = stubFetch(jsonResponse({ cards: [] }));
    const provider = new OpenAICaptureProvider();

    await provider.extractInsights(transcript, context);

    const request = requests[0];
    // Same-origin relative URL: the browser never learns an upstream host.
    expect(request.url).toBe('/api/capture/extract');
    expect(request.url).not.toContain('openai.com');
    expect(Object.keys(request.headers)).toEqual(['content-type']);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-api-key']).toBeUndefined();
    expect(request.body).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(request.body).not.toMatch(/apiKey|api_key/i);
  });

  it('has no constructor option that could carry a key', async () => {
    // The option bag is only {endpoint, fetchFn}. Passing anything else is a
    // type error at compile time; at runtime it must be ignored rather than
    // forwarded anywhere.
    const { requests } = stubFetch(jsonResponse({ cards: [] }));
    const sneaky = { apiKey: 'sk-should-be-ignored' } as unknown as ConstructorParameters<
      typeof OpenAICaptureProvider
    >[0];
    const provider = new OpenAICaptureProvider(sneaky);

    const cards = await provider.extractInsights(transcript, context);

    expect(cards).toEqual([]);
    expect(requests[0].body).not.toContain('sk-should-be-ignored');
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  it('accepts an endpoint override without changing what is sent', async () => {
    const { requests } = stubFetch(jsonResponse({ cards: [] }));
    const provider = new OpenAICaptureProvider({ endpoint: '/fn/capture/extract' });

    await provider.extractInsights(transcript, context);

    expect(requests[0].url).toBe('/fn/capture/extract');
  });

  it('returns an empty list when the model found nothing', async () => {
    stubFetch(jsonResponse({ cards: [] }));
    const provider = new OpenAICaptureProvider();
    await expect(provider.extractInsights(transcript, context)).resolves.toEqual([]);
  });
});

describe('AnthropicCaptureProvider', () => {
  it('POSTs the transcript to the same endpoint, naming no provider', async () => {
    const { requests } = stubFetch(jsonResponse({ cards: [CARD] }));
    const provider = new AnthropicCaptureProvider();

    const cards = await provider.extractInsights(transcript, context);

    expect(cards).toHaveLength(1);
    expect(requests[0].url).toBe(EXTRACT_ENDPOINT);
    // The class is called Anthropic and the request never says so. Which AI
    // answers is lib/ai/router.ts's decision, taken from the admin console's AI
    // section, from viewpoint.config.ts or from the built-in stack.
    expect(JSON.parse(requests[0].body)).toEqual({ transcript, context });
    expect(requests[0].body).not.toContain('anthropic');
    expect(requests[0].body).not.toContain('provider');
  });

  it('sends no credential of any kind', async () => {
    const { requests } = stubFetch(jsonResponse({ cards: [] }));
    const provider = new AnthropicCaptureProvider();

    await provider.extractInsights(transcript, context);

    expect(requests[0].url).not.toContain('anthropic.com');
    expect(requests[0].headers.authorization).toBeUndefined();
    expect(requests[0].headers['x-api-key']).toBeUndefined();
    expect(requests[0].headers['anthropic-version']).toBeUndefined();
    expect(requests[0].body).not.toMatch(/sk-ant-/);
  });

  it('sends a byte-identical request to OpenAICaptureProvider', async () => {
    // The two classes are deliberately the same request. If this ever fails,
    // one of them has started choosing an AI in the browser again — which is the
    // thing batch BF removed, and the thing that makes the server-side key the
    // only key.
    const { requests } = stubFetch(jsonResponse({ cards: [] }));

    await new OpenAICaptureProvider().extractInsights(transcript, context);
    await new AnthropicCaptureProvider().extractInsights(transcript, context);

    expect(requests.map((r) => r.url)).toEqual([EXTRACT_ENDPOINT, EXTRACT_ENDPOINT]);
    expect(requests[0].body).toBe(requests[1].body);
    expect(requests[0].method).toBe(requests[1].method);
    expect(requests[0].headers).toEqual(requests[1].headers);
  });
});

describe('cloud providers — endpoint failure codes become clear errors', () => {
  async function expectEndpointFailure(
    response: Response,
    code: string,
  ): Promise<CaptureEndpointError> {
    stubFetch(response);
    const provider = new OpenAICaptureProvider();

    let caught: unknown;
    try {
      await provider.extractInsights(transcript, context);
    } catch (err) {
      caught = err;
    }

    expect(caught, 'expected the provider to reject').toBeInstanceOf(CaptureEndpointError);
    const failure = caught as CaptureEndpointError;
    expect(failure.code).toBe(code);
    expect(failure.message.length).toBeGreaterThan(40);
    return failure;
  }

  it('503 capture_not_configured says the choice is made server-side', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'capture_not_configured' }, 503),
      'capture_not_configured',
    );
    expect(failure.status).toBe(503);
    // Actionable without disclosing which variable holds the key, which vendor
    // was resolved, or that the deployment has an admin console setting at all
    // beyond where to change it.
    expect(failure.message).toMatch(/viewpoint\.config\.ts/);
    expect(failure.message).toMatch(/admin console/i);
    expect(failure.message).toMatch(/nothing to fix client-side/i);
    expect(failure.message).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY|apiKeyEnv/);
    expect(failure.message).not.toMatch(/openai\.com|anthropic\.com/i);
  });

  it('502 capture_upstream_error points at the server log, not the upstream body', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'capture_upstream_error' }, 502),
      'capture_upstream_error',
    );
    expect(failure.message).toMatch(/server log/i);
    expect(failure.message).not.toMatch(/openai\.com/);
  });

  it('502 capture_upstream_unreachable is distinguishable from a rejected request', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'capture_upstream_unreachable' }, 502),
      'capture_upstream_unreachable',
    );
    expect(failure.message).toMatch(/could not reach/i);
  });

  it('422 capture_output_truncated says how to fix it', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'capture_output_truncated' }, 422),
      'capture_output_truncated',
    );
    expect(failure.message).toMatch(/token/i);
    expect(failure.message).toMatch(/transcript window/i);
  });

  it('422 capture_parse_error carries the parser reason across the HTTP boundary', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'capture_parse_error', reason: 'markdown_fenced' }, 422),
      'capture_parse_error',
    );
    expect(failure.reason).toBe('markdown_fenced');
    expect(failure.message).toContain('markdown_fenced');
  });

  it('422 capture_parse_error survives a missing reason', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'capture_parse_error' }, 422),
      'capture_parse_error',
    );
    expect(failure.reason).toBeNull();
  });

  it('413 transcript_too_large tells the caller to shorten the window', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'transcript_too_large' }, 413),
      'transcript_too_large',
    );
    expect(failure.message).toMatch(/shorter window/i);
  });

  it('400 empty_transcript is reported as a client-side condition', async () => {
    await expectEndpointFailure(
      jsonResponse({ error: 'empty_transcript' }, 400),
      'empty_transcript',
    );
  });

  it('400 invalid_transcript is called a client bug, not a model failure', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'invalid_transcript' }, 400),
      'invalid_transcript',
    );
    expect(failure.message).toMatch(/client bug/i);
  });

  it('an unknown error code still produces a readable error', async () => {
    const failure = await expectEndpointFailure(
      jsonResponse({ error: 'something_new' }, 500),
      'something_new',
    );
    expect(failure.status).toBe(500);
    expect(failure.message).toContain('something_new');
  });

  it('a non-JSON error body does not throw a SyntaxError', async () => {
    const failure = await expectEndpointFailure(
      new Response('<html>500</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }),
      'unknown',
    );
    expect(failure.message).toContain('500');
  });

  it('a network failure says the function is not answering', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const provider = new OpenAICaptureProvider();

    let caught: unknown;
    try {
      await provider.extractInsights(transcript, context);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CaptureEndpointError);
    const failure = caught as CaptureEndpointError;
    expect(failure.code).toBe('network');
    expect(failure.message).toMatch(/api\/capture\/extract/);
    // Fetch's own message embeds the URL; it must not be concatenated in.
    expect(failure.message).not.toContain('Failed to fetch');
  });

  it('a 200 text/html SPA fallback explains that api/* is not running', async () => {
    // This is exactly what `vite preview` answers for an unknown /api path:
    // 200 with index.html. Without this branch the failure is a bare
    // SyntaxError from response.json().
    const failure = await expectEndpointFailure(
      new Response('<!doctype html><html><body>app</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      'endpoint_unavailable',
    );
    expect(failure.message).toMatch(/vite preview/);
    expect(failure.message).toMatch(/index\.html/);
  });

  it('a 200 with a JSON content type but an unparseable body is reported clearly', async () => {
    const failure = await expectEndpointFailure(
      new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      'endpoint_unavailable',
    );
    expect(failure.message).toMatch(/not valid JSON/i);
  });
});

describe('cloud providers — defence in depth on the response', () => {
  it('re-validates the endpoint payload instead of trusting it', async () => {
    // If the endpoint ever starts returning a half-built card, the browser
    // must refuse it rather than render it.
    stubFetch(jsonResponse({ cards: [{ type: 'RISK', title: 'x' }] }));
    const provider = new OpenAICaptureProvider();

    await expect(provider.extractInsights(transcript, context)).rejects.toBeInstanceOf(
      CaptureExtractionError,
    );
  });

  it('rejects an endpoint that answers 200 with a different envelope', async () => {
    stubFetch(jsonResponse({ insights: [CARD] }));
    const provider = new OpenAICaptureProvider();

    await expect(provider.extractInsights(transcript, context)).rejects.toBeInstanceOf(
      CaptureExtractionError,
    );
  });

  it('holds the endpoint to the same extra-field rule it holds the model to', async () => {
    // The endpoint answers with {cards} and nothing else. If it ever grows a
    // transport field — a `provider` naming the AI that answered is the obvious
    // candidate, and exactly what batch BF removed from the request side — this
    // fails loudly instead of the two sides drifting: one strict envelope is the
    // whole reason the parser is shared. Which AI answered is not the browser's
    // business, so it must not arrive in a response either.
    stubFetch(jsonResponse({ cards: [CARD], provider: 'openai' }));
    const provider = new OpenAICaptureProvider();

    let caught: unknown;
    try {
      await provider.extractInsights(transcript, context);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CaptureExtractionError);
    expect((caught as CaptureExtractionError).reason).toBe('extra_fields');
    expect((caught as CaptureExtractionError).message).toContain('provider');
  });

  it('defaults a missing agentId to the first speaker in the window', async () => {
    const { agentId: _agentId, ...noSpeaker } = CARD;
    stubFetch(jsonResponse({ cards: [noSpeaker] }));
    const provider = new AnthropicCaptureProvider();

    const cards = await provider.extractInsights(transcript, context);

    expect(cards[0].agentId).toBe('speaker-1');
  });
});

describe('isConfigured — HEAD probe', () => {
  it('is true when the server has a cloud key', async () => {
    const { requests } = stubFetch(new Response(null, { status: 200 }));

    await expect(new OpenAICaptureProvider().isConfigured()).resolves.toBe(true);
    await expect(new AnthropicCaptureProvider().isConfigured()).resolves.toBe(true);
    expect(requests.every((r) => r.method === 'HEAD')).toBe(true);
  });

  it('is false when the server reports no key', async () => {
    stubFetch(new Response(null, { status: 503 }));
    await expect(new OpenAICaptureProvider().isConfigured()).resolves.toBe(false);
  });

  it('is false rather than throwing when the endpoint is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(probeExtractEndpoint()).resolves.toBe(false);
  });

  it('never exposes the key through the probe', async () => {
    const { requests } = stubFetch(new Response(null, { status: 200 }));
    await probeExtractEndpoint();

    expect(requests[0].method).toBe('HEAD');
    expect(requests[0].body).toBe('');
    expect(requests[0].headers.authorization).toBeUndefined();
  });
});

describe('CaptureEndpointError', () => {
  it('is a real Error carrying code, status and reason', () => {
    const err = new CaptureEndpointError('capture_parse_error', 'message', 422, 'prose');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CaptureEndpointError');
    expect(err.code).toBe('capture_parse_error');
    expect(err.status).toBe(422);
    expect(err.reason).toBe('prose');
  });

  it('defaults status and reason to null', () => {
    const err = new CaptureEndpointError('network', 'message');
    expect(err.status).toBeNull();
    expect(err.reason).toBeNull();
  });
});
