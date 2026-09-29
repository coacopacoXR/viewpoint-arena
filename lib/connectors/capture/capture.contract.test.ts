// Shared CaptureProvider contract test suite.
//
// CaptureProvider has three capabilities (see types.ts), so there are three
// runners. Any implementation — ours or a corp's custom adapter — is verified
// by handing a factory to the runner for the capability it provides:
//
//   runCaptureContractTests()            the SIMULATION capability
//                                        (generateDialogue / generateInsightDetails)
//   runTranscriptCaptureContractTests()  the TRANSCRIPT capability
//                                        (extractInsights)
//   runRecordingCaptureContractTests()   the RECORDING capability
//                                        (captureRecording)
//
// A provider that offers more than one runs through each of them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
    DialogueOutput,
    RecordingCaptureProvider,
    SimulationCaptureProvider,
    SlideContext,
    TranscriptCaptureProvider,
    TranscriptChunk,
} from './types';
import { MockCaptureProvider } from './mock';
import { OpenAICaptureProvider } from './openai';
import { AnthropicCaptureProvider } from './anthropic';
import { OllamaDirectCaptureProvider } from './ollamaDirect';
import { LocalCaptureProvider } from './local';
import { CaptureExtractionError, parseInsightCards } from './parseInsightCards';

const VALID_TEMPLATE_TYPES = new Set([
    'neutral', 'risk', 'rationale', 'action',
    'visibility', 'social', 'questioning', 'synthesis',
]);

const VALID_INSIGHT_TYPES = new Set(['RISK', 'RATIONALE', 'ACTION']);

export interface CaptureContractSetup {
    // The simulation capability specifically: every assertion below is about
    // generateDialogue/generateInsightDetails. Transcript-driven providers
    // (openai, anthropic, ollamaDirect) are covered by
    // runTranscriptCaptureContractTests at the bottom of this file.
    provider: SimulationCaptureProvider;
}

export function runCaptureContractTests(
    name: string,
    setup: () => CaptureContractSetup | Promise<CaptureContractSetup>,
): void {
    describe(`CaptureProvider contract: ${name}`, () => {
        let ctx: CaptureContractSetup;

        it('generateDialogue returns a well-shaped DialogueOutput', async () => {
            ctx = await setup();
            const output: DialogueOutput = ctx.provider.generateDialogue(
                '1', 'TestPart', 0, false, 'generic',
            );

            expect(typeof output.text).toBe('string');
            expect(output.text.length).toBeGreaterThan(0);
            expect(VALID_TEMPLATE_TYPES.has(output.template.type)).toBe(true);
            // Phase 1 (step 0) should not produce action/synthesis templates
            expect(output.insightType === null || VALID_INSIGHT_TYPES.has(output.insightType)).toBe(true);
        });

        it('generateDialogue replaces {poi} with the part name', async () => {
            ctx ??= await setup();
            const output = ctx.provider.generateDialogue(
                '1', 'Bracket Alpha', 5, false, 'generic',
            );
            expect(output.text).not.toContain('{poi}');
            expect(output.text).toContain('Bracket Alpha');
        });

        it('generateDialogue respects phase selection by step', async () => {
            ctx ??= await setup();
            // Phase 1 (step 0-2): observation — insightType should be null
            const early = ctx.provider.generateDialogue('1', 'Part', 0, false, 'generic');
            expect(early.insightType).toBeNull();

            // Phase 2+ (step 3+): can produce insights
            const later = ctx.provider.generateDialogue('1', 'Part', 5, false, 'generic');
            // May or may not produce an insight depending on template selection,
            // but the template type should be risk/rationale/questioning
            expect(VALID_TEMPLATE_TYPES.has(later.template.type)).toBe(true);
        });

        it('generateDialogue uses bicycle library when modelType is bicycle', async () => {
            ctx ??= await setup();
            const output = ctx.provider.generateDialogue(
                '1', 'Fork', 0, false, 'bicycle',
            );
            expect(typeof output.text).toBe('string');
            expect(output.text.length).toBeGreaterThan(0);
        });

        it('generateInsightDetails returns a well-shaped InsightDetails for RISK', async () => {
            ctx ??= await setup();
            const details = ctx.provider.generateInsightDetails(
                'RISK', 'poi-1', 'Bracket', 'NONE',
                { type: 'risk', reasoningChain: { confidence: 0.9, implication: 'failure risk' } },
            );
            expect(details.priority).toBe('Critical');
            expect(details.decisionRole).toBe('TRIGGER');
            expect(details.status).toBe('Open');
            expect(typeof details.componentReference).toBe('string');
        });

        it('generateInsightDetails returns RATIONALE details', async () => {
            ctx ??= await setup();
            const details = ctx.provider.generateInsightDetails(
                'RATIONALE', 'poi-2', 'Rib', 'NONE',
                { type: 'rationale' },
            );
            expect(details.decisionRole).toBe('RATIONALE');
            expect(typeof details.designDriver).toBe('string');
            expect(typeof details.tradeoffAnalysis).toBe('string');
        });

        it('generateInsightDetails returns ACTION details with correct decision role', async () => {
            ctx ??= await setup();
            const noneState = ctx.provider.generateInsightDetails(
                'ACTION', 'poi-3', 'Boss', 'NONE', { type: 'action' },
            );
            expect(noneState.decisionRole).toBe('INTERMEDIATE_DECISION');

            const finalState = ctx.provider.generateInsightDetails(
                'ACTION', 'poi-3', 'Boss', 'FINAL', { type: 'action' },
            );
            expect(finalState.decisionRole).toBe('FINAL_DECISION');
        });

        it('no method accepts or returns credential-shaped values', async () => {
            ctx ??= await setup();
            const output = ctx.provider.generateDialogue(
                '1', 'TestPart', 0, false, 'generic',
            );
            // The text should not contain anything that looks like a raw secret
            const credentialPattern = /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16})\b/;
            expect(output.text).not.toMatch(credentialPattern);
        });
    });
}

// ─── Run against MockCaptureProvider (regular CI path) ────────────────

describe('CaptureProvider contract suite', () => {
    runCaptureContractTests('MockCaptureProvider', () => ({
        provider: new MockCaptureProvider(),
    }));
});

// ═══════════════════════════════════════════════════════════════════════
// The TRANSCRIPT capability (T4.5 / T4.6).
//
// CaptureProvider covers two different kinds of backend; the suite above pins
// the simulation one, this pins the transcript one. Every transcript-driven
// provider — ours or a corp's — must pass it, which is the point of a contract
// suite: the guarantees are stated once and re-asserted per implementation.
//
// What is guaranteed, transport-independently:
//   1. a well-formed model answer becomes validated InsightCard[];
//   2. "nothing to capture" resolves to [] rather than failing;
//   3. every malformed answer — prose, truncated JSON, markdown fences, extra
//      fields, an invalid card — REJECTS with a `reason` from
//      CaptureParseFailureReason, and never yields a partial list;
//   4. no credential goes on the wire, in a header, a URL or a body;
//   5. an unreachable model host produces an error that says more than the
//      transport's own opaque message.
// ═══════════════════════════════════════════════════════════════════════

const CONTRACT_TRANSCRIPT: TranscriptChunk[] = [
    { speakerId: 'speaker-1', text: 'The wall drops from 2.8mm to 1.2mm.', startMs: 0, endMs: 4000 },
    { speakerId: 'speaker-2', text: 'That will sink on the A-surface.', startMs: 4000, endMs: 6500 },
];

const CONTRACT_CONTEXT: SlideContext = {
    agendaIdx: 2,
    slideTitle: 'Bracket moulding',
    hoveredPartName: 'Bracket Alpha',
};

const CONTRACT_CARD = {
    type: 'RISK',
    title: 'Wall transition risks sink marks',
    description: 'A 57% wall reduction historically causes sink on A-surfaces.',
    agentId: 'speaker-1',
    details: { priority: 'High' },
};

const CONTRACT_CREDENTIAL_PATTERN =
    /\b(sk-[a-zA-Z0-9]{20,}|sk-ant-[a-zA-Z0-9-]{20,}|ghp_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16})\b/;

export interface TranscriptContractRequest {
    url: string;
    headers: Record<string, string>;
    body: string;
}

export interface TranscriptContractSetup {
    provider: TranscriptCaptureProvider;
    /**
     * Arranges the transport so the model's raw text answer is `raw`.
     *
     * For the proxied providers this simulates api/capture/extract.ts
     * faithfully: the endpoint parses server-side and forwards either the
     * cards or a `reason` code. For OllamaDirect it is the raw
     * message.content, because that provider parses in the browser.
     */
    modelReplies(raw: string): void;
    /** Arranges a transport-level failure: the model host cannot be reached. */
    transportFails(): void;
    /** The last request the provider put on the wire. */
    lastRequest(): TranscriptContractRequest;
}

export function runTranscriptCaptureContractTests(
    name: string,
    setup: () => TranscriptContractSetup,
): void {
    describe(`TranscriptCaptureProvider contract: ${name}`, () => {
        let ctx: TranscriptContractSetup;

        beforeEach(() => {
            ctx = setup();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        async function expectReason(raw: string, reason: string): Promise<Error> {
            ctx.modelReplies(raw);
            let caught: unknown;
            try {
                await ctx.provider.extractInsights(CONTRACT_TRANSCRIPT, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }
            expect(caught, `expected "${reason}" for ${raw.slice(0, 40)}`).toBeInstanceOf(Error);
            expect((caught as { reason?: string }).reason).toBe(reason);
            return caught as Error;
        }

        it('extractInsights turns a transcript window into InsightCards', async () => {
            ctx.modelReplies(JSON.stringify({ cards: [CONTRACT_CARD] }));

            const cards = await ctx.provider.extractInsights(
                CONTRACT_TRANSCRIPT,
                CONTRACT_CONTEXT,
            );

            expect(cards).toHaveLength(1);
            expect(cards[0].type).toBe('RISK');
            expect(cards[0].title).toBe(CONTRACT_CARD.title);
            expect(cards[0].description).toBe(CONTRACT_CARD.description);
            expect(cards[0].details.priority).toBe('High');
            // Status is part of the card contract even though the model is not
            // asked for it: a freshly extracted card is Open.
            expect(cards[0].details.status).toBe('Open');
        });

        it('mints id and timestamp rather than trusting the model', async () => {
            ctx.modelReplies(JSON.stringify({ cards: [CONTRACT_CARD] }));

            const cards = await ctx.provider.extractInsights(
                CONTRACT_TRANSCRIPT,
                CONTRACT_CONTEXT,
            );

            expect(typeof cards[0].id).toBe('string');
            expect(cards[0].id.length).toBeGreaterThan(0);
            expect(Number.isFinite(cards[0].timestamp)).toBe(true);
        });

        it('resolves to [] when the window held nothing worth capturing', async () => {
            ctx.modelReplies(JSON.stringify({ cards: [] }));

            await expect(
                ctx.provider.extractInsights(CONTRACT_TRANSCRIPT, CONTRACT_CONTEXT),
            ).resolves.toEqual([]);
        });

        it('MALFORMED: rejects prose with reason "prose"', async () => {
            await expectReason(
                'Looking at the transcript, the main concern is the wall thickness.',
                'prose',
            );
        });

        it('MALFORMED: rejects truncated JSON with reason "truncated_json"', async () => {
            await expectReason(
                JSON.stringify({ cards: [CONTRACT_CARD] }).slice(0, 60),
                'truncated_json',
            );
        });

        // A closed fence around valid JSON is unwrapped and accepted (Anthropic
        // fences by habit and has no JSON mode). An unclosed one means the reply
        // was cut off, which is still a real failure.
        it('MALFORMED: rejects an unclosed markdown fence with reason "markdown_fenced"', async () => {
            await expectReason(
                '```json\n' + JSON.stringify({ cards: [CONTRACT_CARD] }),
                'markdown_fenced',
            );
        });

        it('MALFORMED: rejects extra fields with reason "extra_fields"', async () => {
            await expectReason(
                JSON.stringify({ cards: [{ ...CONTRACT_CARD, confidence: 0.87 }] }),
                'extra_fields',
            );
            // Deliberately does NOT assert that the message names "confidence",
            // even though the parser's message does. The two transports differ
            // on purpose: OllamaDirect parses in the browser and can quote the
            // model output, while the cloud providers parse in
            // api/capture/extract.ts, which forwards only the `reason` — its
            // message would echo the model output, which echoes the
            // transcript. `reason` is the one part of the failure that is
            // guaranteed to cross every transport.
        });

        it('MALFORMED: rejects an invalid enum with reason "invalid_card"', async () => {
            await expectReason(
                JSON.stringify({ cards: [{ ...CONTRACT_CARD, type: 'OBSERVATION' }] }),
                'invalid_card',
            );
        });

        it('never returns a partial list when one card of several is invalid', async () => {
            ctx.modelReplies(
                JSON.stringify({
                    cards: [CONTRACT_CARD, { ...CONTRACT_CARD, type: 'NOT_A_TYPE' }],
                }),
            );

            let resolved: unknown = 'DID NOT REJECT';
            try {
                resolved = await ctx.provider.extractInsights(
                    CONTRACT_TRANSCRIPT,
                    CONTRACT_CONTEXT,
                );
            } catch {
                resolved = 'rejected';
            }

            expect(resolved).toBe('rejected');
        });

        it('puts no credential on the wire', async () => {
            ctx.modelReplies(JSON.stringify({ cards: [CONTRACT_CARD] }));

            const cards = await ctx.provider.extractInsights(
                CONTRACT_TRANSCRIPT,
                CONTRACT_CONTEXT,
            );
            const request = ctx.lastRequest();

            expect(request.headers.authorization).toBeUndefined();
            expect(request.headers['x-api-key']).toBeUndefined();
            expect(request.url).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
            expect(request.body).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
            expect(request.body).not.toMatch(/apiKey|api_key/i);
            expect(JSON.stringify(cards)).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
        });

        it('fails with more information than the transport did', async () => {
            // The browser reports every network failure as the same opaque
            // "Failed to fetch". A provider that just rethrows it has told the
            // operator nothing, and this mode is the one they misconfigure most.
            ctx.transportFails();

            let caught: unknown;
            try {
                await ctx.provider.extractInsights(CONTRACT_TRANSCRIPT, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }

            expect(caught, 'expected the provider to reject').toBeInstanceOf(Error);
            const failure = caught as Error;
            expect(failure.message).not.toContain('Failed to fetch');
            expect(failure.message.length).toBeGreaterThan(60);
            expect(failure.message).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
        });
    });
}

// ─── Harnesses ────────────────────────────────────────────────────────

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

/**
 * Records every request and hands back whatever `nextReply` produces.
 * Each harness sets `nextReply` from modelReplies()/transportFails().
 */
function stubTransport(requests: TranscriptContractRequest[]) {
    let nextReply: () => Response = () => jsonResponse({ cards: [] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
            headers[key] = value;
        });
        requests.push({
            url: typeof input === 'string' ? input : String(input),
            headers,
            body: String(init?.body ?? ''),
        });
        return nextReply();
    });
    return {
        setReply(reply: () => Response): void {
            nextReply = reply;
        },
    };
}

/**
 * The two cloud providers go through api/capture/extract.ts, so their harness
 * simulates that endpoint: parse server-side, forward the cards on success or
 * the reason code on failure. The browser client then re-validates the cards,
 * exactly as it does against the real endpoint.
 */
function cloudHarness(providerName: 'openai' | 'anthropic'): () => TranscriptContractSetup {
    return () => {
        const requests: TranscriptContractRequest[] = [];
        const transport = stubTransport(requests);
        const instance =
            providerName === 'openai'
                ? new OpenAICaptureProvider()
                : new AnthropicCaptureProvider();

        return {
            provider: instance,
            modelReplies(raw: string): void {
                transport.setReply(() => {
                    try {
                        const cards = parseInsightCards(raw, {
                            defaultAgentId: CONTRACT_TRANSCRIPT[0].speakerId,
                        });
                        return jsonResponse({ cards });
                    } catch (err) {
                        return jsonResponse(
                            {
                                error: 'capture_parse_error',
                                reason: (err as CaptureExtractionError).reason,
                                provider: providerName,
                            },
                            422,
                        );
                    }
                });
            },
            transportFails(): void {
                transport.setReply(() => {
                    throw new TypeError('Failed to fetch');
                });
            },
            lastRequest(): TranscriptContractRequest {
                return requests[requests.length - 1];
            },
        };
    };
}

/**
 * OllamaDirect has no proxy: the browser talks to Ollama and parses the model
 * text itself, so the harness hands back the raw content in Ollama's envelope.
 */
function ollamaHarness(): () => TranscriptContractSetup {
    return () => {
        const requests: TranscriptContractRequest[] = [];
        const transport = stubTransport(requests);
        const instance = new OllamaDirectCaptureProvider({
            // A name that cannot resolve: if a test ever forgot to stub the
            // transport it would fail loudly instead of hitting a real host.
            baseUrl: 'http://ollama.contract.invalid:11434',
            model: 'contract-test-model',
        });

        return {
            provider: instance,
            modelReplies(raw: string): void {
                transport.setReply(() =>
                    jsonResponse({
                        model: 'contract-test-model',
                        message: { role: 'assistant', content: raw },
                        done: true,
                        done_reason: 'stop',
                    }),
                );
            },
            transportFails(): void {
                transport.setReply(() => {
                    throw new TypeError('Failed to fetch');
                });
            },
            lastRequest(): TranscriptContractRequest {
                return requests[requests.length - 1];
            },
        };
    };
}

describe('TranscriptCaptureProvider contract suite', () => {
    runTranscriptCaptureContractTests('OpenAICaptureProvider', cloudHarness('openai'));
    runTranscriptCaptureContractTests('AnthropicCaptureProvider', cloudHarness('anthropic'));
    runTranscriptCaptureContractTests('OllamaDirectCaptureProvider', ollamaHarness());
});

// ═══════════════════════════════════════════════════════════════════════
// The RECORDING capability (T4.4).
//
// A third flavour, not a variant of the transcript one: the caller hands over
// AUDIO and the service transcribes internally, so there is no TranscriptChunk[]
// to send and no model text to parse client-side. capture-service is the only
// backend in this repo that works this way, and LocalCaptureProvider is its
// browser client.
//
// What is guaranteed, transport-independently:
//   1. the recording travels as multipart `audio` plus the SlideContext form
//      fields, and nothing else is put on the wire;
//   2. a well-formed answer becomes validated InsightCard[];
//   3. "nothing to capture" resolves to [] rather than failing;
//   4. a malformed answer REJECTS with a `reason` from
//      CaptureParseFailureReason and never yields a partial list. Only the
//      value-level reasons can occur here — 'prose' and 'truncated_json'
//      describe unparseable model TEXT, and this transport carries JSON that
//      the service already parsed;
//   5. no credential goes on the wire, in a header, a URL or a body — and the
//      provider does not even have an option that would accept one;
//   6. an upstream failure names the status and a VALIDATED code, and echoes no
//      other upstream text, which for this endpoint means no part of a meeting;
//   7. an unreachable service produces an error that says more than the
//      transport's own opaque message.
// ═══════════════════════════════════════════════════════════════════════

const CONTRACT_AUDIO = new Blob([new Uint8Array([26, 69, 223, 163])], {
    type: 'audio/webm',
});

const CONTRACT_UPSTREAM_MARKER = 'UPSTREAM-BODY-MARKER-do-not-echo';

export interface RecordingContractRequest {
    url: string;
    method: string;
    headers: Record<string, string> | undefined;
    /** The multipart body as the provider built it. */
    form: FormData;
}

export interface RecordingContractSetup {
    provider: RecordingCaptureProvider;
    /** Arranges the transport so the service answers with this JSON body. */
    serviceReplies(payload: unknown, status?: number): void;
    /** Arranges a reply that is not JSON at all (a proxy, an SPA fallback). */
    serviceRepliesNotJson(contentType: string, body: string, status?: number): void;
    /** Arranges a transport-level failure: the service cannot be reached. */
    transportFails(): void;
    /** The last request the provider put on the wire. */
    lastRequest(): RecordingContractRequest;
}

export function runRecordingCaptureContractTests(
    name: string,
    setup: () => RecordingContractSetup,
): void {
    describe(`RecordingCaptureProvider contract: ${name}`, () => {
        let ctx: RecordingContractSetup;

        beforeEach(() => {
            ctx = setup();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        async function expectReason(payload: unknown, reason: string): Promise<unknown> {
            ctx.serviceReplies(payload);
            let caught: unknown;
            try {
                await ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }
            expect(caught, `expected "${reason}"`).toBeInstanceOf(Error);
            expect((caught as { reason?: string }).reason).toBe(reason);
            return caught;
        }

        it('captureRecording turns a complete recording into InsightCards', async () => {
            ctx.serviceReplies({ cards: [CONTRACT_CARD] });

            const cards = await ctx.provider.captureRecording(
                CONTRACT_AUDIO,
                CONTRACT_CONTEXT,
            );

            expect(cards).toHaveLength(1);
            expect(cards[0].type).toBe('RISK');
            expect(cards[0].title).toBe(CONTRACT_CARD.title);
            expect(cards[0].details.priority).toBe('High');
            expect(cards[0].details.status).toBe('Open');
        });

        it('mints id and timestamp rather than trusting the service', async () => {
            ctx.serviceReplies({ cards: [CONTRACT_CARD] });

            const cards = await ctx.provider.captureRecording(
                CONTRACT_AUDIO,
                CONTRACT_CONTEXT,
            );

            expect(typeof cards[0].id).toBe('string');
            expect(cards[0].id.length).toBeGreaterThan(0);
            expect(Number.isFinite(cards[0].timestamp)).toBe(true);
        });

        it('resolves to [] when nothing in the meeting was worth capturing', async () => {
            ctx.serviceReplies({ cards: [] });

            await expect(
                ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT),
            ).resolves.toEqual([]);
        });

        it('sends the recording as multipart audio plus the SlideContext fields', async () => {
            ctx.serviceReplies({ cards: [] });

            await ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT);

            const request = ctx.lastRequest();
            expect(request.method).toBe('POST');
            expect(request.form).toBeInstanceOf(FormData);
            expect(request.form.get('audio')).toBeInstanceOf(Blob);
            expect(request.form.get('agendaIdx')).toBe(String(CONTRACT_CONTEXT.agendaIdx));
            expect(request.form.get('slideTitle')).toBe(CONTRACT_CONTEXT.slideTitle);
            expect(request.form.get('hoveredPartName')).toBe(
                CONTRACT_CONTEXT.hoveredPartName,
            );
            // The one optional field this context omits must be absent, not the
            // string "undefined": it would end up inside the extraction prompt.
            expect(request.form.has('laserTargetPartName')).toBe(false);
        });

        it('MALFORMED: rejects a renamed envelope with reason "wrong_envelope"', async () => {
            await expectReason({ insights: [CONTRACT_CARD] }, 'wrong_envelope');
        });

        it('MALFORMED: rejects extra fields with reason "extra_fields"', async () => {
            await expectReason(
                { cards: [{ ...CONTRACT_CARD, confidence: 0.87 }] },
                'extra_fields',
            );
        });

        it('MALFORMED: rejects an invalid enum with reason "invalid_card"', async () => {
            await expectReason(
                { cards: [{ ...CONTRACT_CARD, type: 'OBSERVATION' }] },
                'invalid_card',
            );
        });

        it('never returns a partial list when one card of several is invalid', async () => {
            ctx.serviceReplies({
                cards: [CONTRACT_CARD, { ...CONTRACT_CARD, type: 'NOT_A_TYPE' }],
            });

            let resolved: unknown = 'DID NOT REJECT';
            try {
                resolved = await ctx.provider.captureRecording(
                    CONTRACT_AUDIO,
                    CONTRACT_CONTEXT,
                );
            } catch {
                resolved = 'rejected';
            }

            expect(resolved).toBe('rejected');
        });

        it('rejects a non-JSON 2xx instead of throwing a bare SyntaxError', async () => {
            // What a static host does for an unknown /api path: the SPA fallback
            // answers 200 text/html. Without an explicit content-type check the
            // failure surfaces as a SyntaxError that looks like a client bug.
            ctx.serviceRepliesNotJson(
                'text/html',
                `<!doctype html>${CONTRACT_UPSTREAM_MARKER}`,
            );

            let caught: unknown;
            try {
                await ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(Error);
            const failure = caught as Error;
            expect(failure.name).not.toBe('SyntaxError');
            expect(failure.message.length).toBeGreaterThan(60);
            expect(failure.message).not.toContain(CONTRACT_UPSTREAM_MARKER);
        });

        it('puts no credential on the wire', async () => {
            ctx.serviceReplies({ cards: [CONTRACT_CARD] });

            const cards = await ctx.provider.captureRecording(
                CONTRACT_AUDIO,
                CONTRACT_CONTEXT,
            );
            const request = ctx.lastRequest();

            const headerNames = Object.keys(request.headers ?? {}).map((n) =>
                n.toLowerCase(),
            );
            // The shared secret that guards capture-service is added by the
            // server-side hop; a browser provider that sent it would have had
            // to be given it first.
            expect(headerNames).not.toContain('authorization');
            expect(headerNames).not.toContain('x-capture-token');
            expect(headerNames).not.toContain('x-api-key');
            expect(request.url).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
            // No query string: a secret in a URL lands in every access log.
            expect(request.url).not.toContain('?');
            expect(JSON.stringify(cards)).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
        });

        it('names the status and a validated code, and echoes no other upstream text', async () => {
            ctx.serviceReplies(
                { error: 'transcription_failed', detail: CONTRACT_UPSTREAM_MARKER },
                500,
            );

            let caught: unknown;
            try {
                await ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(Error);
            const failure = caught as Error;
            expect(failure.message).toContain('500');
            expect(failure.message).toContain('transcription_failed');
            expect(failure.message).not.toContain(CONTRACT_UPSTREAM_MARKER);
        });

        it('drops an upstream code that is not machine-readable', async () => {
            // A code is the one part of a failure that is safe to repeat, and
            // only if it looks like one. Anything else — HTML, prose, a stack —
            // can quote the request, which is a meeting recording.
            ctx.serviceReplies(
                { error: `<html>${CONTRACT_UPSTREAM_MARKER}</html>` },
                502,
            );

            let caught: unknown;
            try {
                await ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }

            const failure = caught as Error;
            expect(failure.message).toContain('502');
            expect(failure.message).not.toContain(CONTRACT_UPSTREAM_MARKER);
            expect(failure.message).not.toContain('<html>');
        });

        it('fails with more information than the transport did', async () => {
            ctx.transportFails();

            let caught: unknown;
            try {
                await ctx.provider.captureRecording(CONTRACT_AUDIO, CONTRACT_CONTEXT);
            } catch (err) {
                caught = err;
            }

            expect(caught, 'expected the provider to reject').toBeInstanceOf(Error);
            const failure = caught as Error;
            expect(failure.message).not.toContain('Failed to fetch');
            expect(failure.message.length).toBeGreaterThan(60);
            expect(failure.message).not.toMatch(CONTRACT_CREDENTIAL_PATTERN);
        });
    });
}

// ─── Harness ──────────────────────────────────────────────────────────

/**
 * LocalCaptureProvider goes through a same-origin proxy, so the harness
 * simulates capture-service faithfully: the exact `{cards}` envelope on success
 * and a `{error: code}` body on failure, both over the real fetch signature.
 */
function localRecordingHarness(): () => RecordingContractSetup {
    return () => {
        const requests: RecordingContractRequest[] = [];
        let nextReply: () => Response = () => jsonResponse({ cards: [] });

        const fetchFn = vi.fn(
            async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                requests.push({
                    url: String(input),
                    method: init?.method ?? 'GET',
                    headers: init?.headers
                        ? Object.fromEntries(new Headers(init.headers).entries())
                        : undefined,
                    form: init?.body as FormData,
                });
                return nextReply();
            },
        );

        return {
            // No `endpoint` override on purpose: the default must already be a
            // same-origin relative URL, because an absolute one would mean the
            // browser knows where capture-service lives.
            provider: new LocalCaptureProvider({
                fetchFn: fetchFn as unknown as typeof globalThis.fetch,
            }),
            serviceReplies(payload: unknown, status = 200): void {
                nextReply = () => jsonResponse(payload, status);
            },
            serviceRepliesNotJson(
                contentType: string,
                body: string,
                status = 200,
            ): void {
                nextReply = () =>
                    new Response(body, {
                        status,
                        headers: { 'content-type': contentType },
                    });
            },
            transportFails(): void {
                nextReply = () => {
                    throw new TypeError('Failed to fetch');
                };
            },
            lastRequest(): RecordingContractRequest {
                return requests[requests.length - 1];
            },
        };
    };
}

describe('RecordingCaptureProvider contract suite', () => {
    runRecordingCaptureContractTests('LocalCaptureProvider', localRecordingHarness());
});
