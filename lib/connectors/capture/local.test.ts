// Tests for LocalCaptureProvider (T4.4) — the browser half of local capture.
//
// Two things are under test:
//   1. THE REQUEST — the multipart body is exactly what capture-service's
//      POST /capture declares (field `audio` plus the four SlideContext form
//      fields), and nothing else is put on the wire.
//   2. THE RESPONSE — a well-formed envelope becomes validated InsightCards, and
//      every failure becomes a message that names the status and a validated
//      code WITHOUT repeating any other upstream text, which for this endpoint
//      means without quoting a meeting recording.
//
// No test here touches the network: fetchFn is always injected.

import { describe, it, expect, vi } from 'vitest';
import {
  LocalCaptureProvider,
  LocalCaptureError,
  LOCAL_CAPTURE_ENDPOINT,
  buildCaptureForm,
  meetingSlideContext,
  recordingFilename,
} from './local';
import type { SlideContext } from './types';
import { CaptureExtractionError } from './parseInsightCards';

const CONTEXT: SlideContext = {
  agendaIdx: 3,
  slideTitle: 'Bracket moulding',
  hoveredPartName: 'Bracket Alpha',
  laserTargetPartName: 'Rib Pattern 2',
};

const VALID_CARD = {
  type: 'RISK',
  title: 'Wall transition risks sink marks',
  description: 'A 57% wall reduction historically causes sink on A-surfaces.',
  agentId: 'speaker-1',
  details: { priority: 'High' },
};

/** Marker text: if this reaches an Error message, the body was echoed. */
const UPSTREAM_MARKER = 'UPSTREAM-DETAIL-do-not-echo';

function audioBlob(type = 'audio/webm'): Blob {
  return new Blob([new Uint8Array([26, 69, 223, 163])], { type });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  /** The FormData the provider built, or whatever else it used as a body. */
  body: unknown;
  headers: Record<string, string> | undefined;
  signal: AbortSignal | undefined;
}

function stubFetch(reply: () => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchFn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const headers: Record<string, string> | undefined = init?.headers
        ? Object.fromEntries(new Headers(init.headers).entries())
        : undefined;
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body,
        headers,
        signal: init?.signal,
      });
      return reply();
    },
  );
  return {
    requests,
    fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    last(): RecordedRequest {
      return requests[requests.length - 1];
    },
  };
}

function formOf(request: RecordedRequest): FormData {
  expect(request.body, 'the body must be a FormData').toBeInstanceOf(FormData);
  return request.body as FormData;
}

async function expectRejection(
  promise: Promise<unknown>,
): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the provider to reject, but it resolved');
}

// ─── The request ────────────────────────────────────────────────────────────

describe('LocalCaptureProvider — the multipart request', () => {
  it('posts to the same-origin proxy by default', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await provider.captureRecording(audioBlob(), CONTEXT);

    expect(stub.requests).toHaveLength(1);
    expect(stub.last().url).toBe(LOCAL_CAPTURE_ENDPOINT);
    expect(LOCAL_CAPTURE_ENDPOINT).toBe('/api/capture/local');
    expect(stub.last().method).toBe('POST');
  });

  it('honours an endpoint override', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({
      endpoint: '/elsewhere/capture',
      fetchFn: stub.fetchFn,
    });

    await provider.captureRecording(audioBlob(), CONTEXT);

    expect(stub.last().url).toBe('/elsewhere/capture');
  });

  it('sends the four SlideContext form fields under the names capture-service declares', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await provider.captureRecording(audioBlob(), CONTEXT);

    const form = formOf(stub.last());
    // Form values arrive as strings; the service parses agendaIdx with `ge=0`.
    expect(form.get('agendaIdx')).toBe('3');
    expect(form.get('slideTitle')).toBe('Bracket moulding');
    expect(form.get('hoveredPartName')).toBe('Bracket Alpha');
    expect(form.get('laserTargetPartName')).toBe('Rib Pattern 2');
  });

  it('omits the two part names entirely when they are undefined', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await provider.captureRecording(audioBlob(), {
      agendaIdx: 0,
      slideTitle: 'Kick-off',
    });

    const form = formOf(stub.last());
    // Not the string "undefined" and not "": both would reach the extraction
    // prompt (the service turns a blank into None, but "undefined" is text).
    expect(form.has('hoveredPartName')).toBe(false);
    expect(form.has('laserTargetPartName')).toBe(false);
    expect([...form.keys()].sort()).toEqual(['agendaIdx', 'audio', 'slideTitle']);
  });

  it('sends the audio as a file whose name matches its container', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await provider.captureRecording(audioBlob('audio/ogg;codecs=opus'), CONTEXT);

    const entry = formOf(stub.last()).get('audio');
    expect(entry).toBeInstanceOf(Blob);
    expect((entry as File).name).toBe('meeting.ogg');
  });

  it('sets no Content-Type, so the browser owns the multipart boundary', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await provider.captureRecording(audioBlob(), CONTEXT);

    // Setting one by hand is the classic way to make a multipart upload
    // unparseable: the boundary in the header must be the one the encoder used.
    expect(stub.last().headers).toBeUndefined();
  });

  it('forwards the AbortSignal the caller supplied', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });
    const controller = new AbortController();

    await provider.captureRecording(audioBlob(), CONTEXT, {
      signal: controller.signal,
    });

    expect(stub.last().signal).toBe(controller.signal);
  });
});

// ─── The response ───────────────────────────────────────────────────────────

describe('LocalCaptureProvider — the response', () => {
  it('returns validated InsightCards from the {cards} envelope', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [VALID_CARD] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const cards = await provider.captureRecording(audioBlob(), CONTEXT);

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('RISK');
    expect(cards[0].title).toBe(VALID_CARD.title);
    expect(cards[0].details.priority).toBe('High');
    // Part of the card contract even though the model is not asked for it.
    expect(cards[0].details.status).toBe('Open');
    // id and timestamp are minted client-side, never trusted from the wire.
    expect(typeof cards[0].id).toBe('string');
    expect(cards[0].id.length).toBeGreaterThan(0);
    expect(Number.isFinite(cards[0].timestamp)).toBe(true);
  });

  it('resolves to [] when nothing in the meeting was worth capturing', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await expect(
      provider.captureRecording(audioBlob(), CONTEXT),
    ).resolves.toEqual([]);
  });

  it('rejects a malformed envelope with the parser reason, never a partial list', async () => {
    const stub = stubFetch(() => jsonResponse({ insights: [VALID_CARD] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    );

    expect(err).toBeInstanceOf(CaptureExtractionError);
    expect((err as CaptureExtractionError).reason).toBe('wrong_envelope');
  });

  it('rejects an unknown field on a card rather than passing it to the tracker', async () => {
    const stub = stubFetch(() =>
      jsonResponse({ cards: [{ ...VALID_CARD, confidence: 0.87 }] }),
    );
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    );

    expect((err as CaptureExtractionError).reason).toBe('extra_fields');
  });

  it('reports a 200 text/html as a missing proxy, not a JSON syntax error', async () => {
    // Exactly what `vite preview` and any static host do for an unknown /api
    // path: the SPA fallback answers 200 with index.html.
    const stub = stubFetch(
      () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err.code).toBe('endpoint_unavailable');
    expect(err.status).toBe(200);
    expect(err.message).toContain('text/html');
    expect(err.message).not.toContain('<!doctype');
  });
});

// ─── Errors ─────────────────────────────────────────────────────────────────

describe('LocalCaptureProvider — errors', () => {
  it('names the HTTP status and a validated upstream code', async () => {
    const stub = stubFetch(() => jsonResponse({ error: 'upload_too_large' }, 413));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err).toBeInstanceOf(LocalCaptureError);
    expect(err.status).toBe(413);
    expect(err.code).toBe('upload_too_large');
    expect(err.message).toContain('413');
    expect(err.message).toContain('upload_too_large');
  });

  it("explains the front proxy's rate limit and never echoes its HTML", async () => {
    const stub = stubFetch(
      () =>
        new Response(`<html><body>429 ${UPSTREAM_MARKER}</body></html>`, {
          status: 429,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err.code).toBe('rate_limited');
    expect(err.message).toMatch(/too many capture requests/);
    expect(err.message).toMatch(/recording is kept/);
    expect(err.message).not.toContain(UPSTREAM_MARKER);
  });

  it('accepts a `code` key as well as the `error` key capture-service uses', async () => {
    const stub = stubFetch(() => jsonResponse({ code: 'empty_transcript' }, 422));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err.code).toBe('empty_transcript');
    expect(err.message).toContain('422');
  });

  it('drops an upstream code that is not [a-z_]{1,64}', async () => {
    // A proxy's HTML, a framework's http_500, or a service that starts echoing
    // detail: none of it is safe to repeat, because it can quote the request.
    const stub = stubFetch(() =>
      jsonResponse(
        { error: `<html>${UPSTREAM_MARKER}</html>`, detail: UPSTREAM_MARKER },
        502,
      ),
    );
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err.code).toBe('upstream_error');
    expect(err.message).toContain('502');
    expect(err.message).not.toContain(UPSTREAM_MARKER);
    expect(err.message).not.toContain('<html>');
  });

  it('never echoes arbitrary body text alongside a valid code', async () => {
    const stub = stubFetch(() =>
      jsonResponse(
        { error: 'transcription_failed', detail: UPSTREAM_MARKER },
        500,
      ),
    );
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err.code).toBe('transcription_failed');
    expect(err.message).toContain('500');
    expect(err.message).not.toContain(UPSTREAM_MARKER);
  });

  it('says more than the transport did when the proxy cannot be reached', async () => {
    const stub = stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT),
    )) as LocalCaptureError;

    expect(err.code).toBe('network');
    // The browser reports every network failure the same way; rethrowing it
    // tells the operator nothing about the deployment they just installed.
    expect(err.message).not.toContain('Failed to fetch');
    expect(err.message.length).toBeGreaterThan(60);
    expect(err.message).toContain(LOCAL_CAPTURE_ENDPOINT);
  });

  it('reports a cancelled upload as an abort, and keeps the Blob reusable', async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubFetch(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    const err = (await expectRejection(
      provider.captureRecording(audioBlob(), CONTEXT, {
        signal: controller.signal,
      }),
    )) as LocalCaptureError;

    expect(err.code).toBe('aborted');
    expect(err.message).toContain('cancelled');
    expect(err.message).not.toContain('AbortError');
  });

  it('puts no credential on the wire and asks for none', async () => {
    const stub = stubFetch(() => jsonResponse({ cards: [] }));
    const provider = new LocalCaptureProvider({ fetchFn: stub.fetchFn });

    await provider.captureRecording(audioBlob(), CONTEXT);

    const request = stub.last();
    const headerNames = Object.keys(request.headers ?? {}).map((n) =>
      n.toLowerCase(),
    );
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('x-capture-token');
    expect(headerNames).not.toContain('x-api-key');
    // No query string either: a secret in a URL lands in every access log.
    expect(request.url).not.toContain('?');
  });
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('recordingFilename', () => {
  it('names the file after the container the browser actually produced', () => {
    expect(recordingFilename('audio/webm')).toBe('meeting.webm');
    expect(recordingFilename('audio/webm;codecs=opus')).toBe('meeting.webm');
    expect(recordingFilename('audio/ogg;codecs=opus')).toBe('meeting.ogg');
    expect(recordingFilename('audio/mp4')).toBe('meeting.m4a');
    // Safari's MediaRecorder has historically reported the empty string.
    expect(recordingFilename('')).toBe('meeting.webm');
    expect(recordingFilename('something/invented')).toBe('meeting.webm');
  });

  it('cannot produce a filename with a path separator in it', () => {
    // capture-service refuses a suffix outside \.[a-z0-9]{1,8} anyway; this is
    // the client half of the same rule.
    for (const type of ['../../etc/passwd', 'audio/../..', 'a/b']) {
      expect(recordingFilename(type)).not.toMatch(/[\\/]/);
    }
  });
});

describe('buildCaptureForm', () => {
  it('is the same body the provider sends', () => {
    const form = buildCaptureForm(audioBlob('audio/webm'), CONTEXT);

    expect(form).toBeInstanceOf(FormData);
    expect((form.get('audio') as File).name).toBe('meeting.webm');
    expect(form.get('agendaIdx')).toBe('3');
    expect(form.get('slideTitle')).toBe('Bracket moulding');
    expect(form.get('hoveredPartName')).toBe('Bracket Alpha');
    expect(form.get('laserTargetPartName')).toBe('Rib Pattern 2');
  });

  it('sends the three grounded fields when supplied', () => {
    const form = buildCaptureForm(audioBlob(), CONTEXT, {
      componentTree: [{ id: 'left_cup', name: 'Left Cup', path: 'HP / Left Cup' }],
      pointingSegments: [
        {
          userId: 'u1',
          userName: 'Alice',
          partId: 'left_cup',
          partName: 'Left Cup',
          fromMs: 1000,
          toMs: 5000,
        },
      ],
      transcriptHint: [{ speaker: 'Alice', text: 'This cup', offsetMs: 3000 }],
    });

    expect(form.has('componentTree')).toBe(true);
    expect(form.has('pointingSegments')).toBe(true);
    expect(form.has('transcriptHint')).toBe(true);

    const tree = JSON.parse(form.get('componentTree') as string);
    expect(tree).toEqual([{ id: 'left_cup', name: 'Left Cup', path: 'HP / Left Cup' }]);

    const segs = JSON.parse(form.get('pointingSegments') as string);
    expect(segs).toHaveLength(1);
    expect(segs[0].userName).toBe('Alice');

    const hint = JSON.parse(form.get('transcriptHint') as string);
    expect(hint[0].speaker).toBe('Alice');
  });

  it('omits the three grounded fields when not supplied', () => {
    const form = buildCaptureForm(audioBlob(), CONTEXT);
    expect(form.has('componentTree')).toBe(false);
    expect(form.has('pointingSegments')).toBe(false);
    expect(form.has('transcriptHint')).toBe(false);
  });

  it('omits a grounded field when its array is empty', () => {
    const form = buildCaptureForm(audioBlob(), CONTEXT, {
      componentTree: [],
      pointingSegments: [],
      transcriptHint: [],
    });
    expect(form.has('componentTree')).toBe(false);
    expect(form.has('pointingSegments')).toBe(false);
    expect(form.has('transcriptHint')).toBe(false);
  });
});

describe('meetingSlideContext', () => {
  const review = {
    title: 'Bracket review 2026-09',
    agenda: [
      { id: 'a', title: 'Introductions' },
      { id: 'b', title: 'Bracket moulding' },
      { id: 'c', title: '   ' },
    ],
  };

  it('uses the slide the host is on', () => {
    expect(meetingSlideContext(review, 1)).toEqual({
      agendaIdx: 1,
      slideTitle: 'Bracket moulding',
    });
  });

  it('clamps an out-of-range agenda index instead of producing undefined', () => {
    expect(meetingSlideContext(review, 99).agendaIdx).toBe(2);
    expect(meetingSlideContext(review, -4).agendaIdx).toBe(0);
  });

  it('falls back to the review title for a blank slide title', () => {
    expect(meetingSlideContext(review, 2).slideTitle).toBe(
      'Bracket review 2026-09',
    );
  });

  it('falls back to agendaIdx 0 and a generic title with no review at all', () => {
    expect(meetingSlideContext(null, 5)).toEqual({
      agendaIdx: 0,
      slideTitle: 'Design review',
    });
    expect(meetingSlideContext({ title: '  ', agenda: [] }, 0).slideTitle).toBe(
      'Design review',
    );
  });

  it('never produces an empty slideTitle', () => {
    // capture-service substitutes its own default for a blank, but an empty
    // string in a prompt is a label the model can read as meaningful.
    const cases: Array<
      [{ title?: string; agenda?: Array<{ title?: string }> } | null, number]
    > = [
      [null, 0],
      [{}, 0],
      [{ title: '', agenda: [{ title: '' }] }, 0],
      [{ title: '   ', agenda: [] }, 3],
      [{ agenda: [{ title: '\t' }] }, 0],
    ];
    for (const [cfg, idx] of cases) {
      expect(meetingSlideContext(cfg, idx).slideTitle.length).toBeGreaterThan(0);
    }
  });
});
