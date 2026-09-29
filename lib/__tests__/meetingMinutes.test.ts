// The minutes of a meeting: one request, made after the meeting, to
// api/capture/summary.ts, and the answer written onto the meeting's own row.
//
// docs/plan/15-sessions-and-variants.md batch BM. The endpoint has existed since
// plan 14 batch BF and nothing called it, so the session map's panel said "No
// summary was stored for this session" for every meeting ever held. What is pinned
// here is the four things that make the call safe to have: the body it sends, the
// reasons it must send nothing at all, and what a failure is allowed to say out
// loud.
//
// THE LAST OF THOSE IS THE IMPORTANT ONE. The request body is what a company's
// engineers said about a design that has not shipped, which is why
// api/capture/summary.ts's security header allows a failure to carry a code and
// nothing else. A log line that quoted the transcript, a card or the model's answer
// would undo that in the one place nobody reads deliberately.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage, InsightCard } from '../../types';

const mockUpdate = vi.fn();
const mockEq = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => (table === 'tracker_sessions' ? { update: mockUpdate } : {}),
  },
}));

import { SUMMARY_ENDPOINT, liveTranscriptChunks, writeMeetingMinutes } from '../capture/meetingMinutes';
import { setCapturePausedBy } from '../capture/captureGate';

/** The recording the live transcript lines below were stamped with. */
const STARTED_AT = 1_700_000_000_000;

const MINUTES = '## Decisions\nRev B approved.\n\n## Actions\n- [ ] re-run the fatigue case — Ben';

function live(id: string, text: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `live-${STARTED_AT}-${id}`,
    agentId: 'live',
    text,
    timestamp: STARTED_AT,
    speakerId: 'user-1',
    speakerName: 'Olga Owner',
    offsetMs: 1200,
    ...overrides,
  };
}

function card(title: string): InsightCard {
  return {
    id: `ic-${title}`,
    type: 'RISK',
    agentId: 'transcript',
    title,
    description: `${title}, in the words the meeting used.`,
    timestamp: STARTED_AT,
    details: { priority: 'High', status: 'Open' },
  };
}

const TRANSCRIPT = [live('1', 'The hinge pin wears through the bush.'), live('2', 'Then we move to Rev B.')];
const CARDS = [card('Hinge pin wears')];

/** One request the module made, read back the way an assertion wants it. */
interface Sent {
  url: string;
  method: string;
  contentType: string;
  body: Record<string, unknown>;
}

/**
 * A fetch fake that keeps what it was sent.
 *
 * `answer` is a factory rather than a Response because a body can only be read
 * once, and a test that calls the module twice would otherwise read an empty one.
 */
function fakeFetch(answer: () => Response) {
  const sent: Sent[] = [];
  const fn = vi.fn(async (input?: unknown, init?: unknown) => {
    const request = (init ?? {}) as RequestInit;
    const headers = (request.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(input),
      method: request.method ?? '',
      contentType: headers['Content-Type'] ?? '',
      body: JSON.parse(String(request.body ?? '{}')),
    });
    return answer();
  });
  return { fn, sent };
}

/** The endpoint answering with JSON, as api/capture/summary.ts does. */
function jsonAnswer(body: unknown, status = 200) {
  return () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function request(overrides: Partial<Parameters<typeof writeMeetingMinutes>[0]> = {}) {
  return writeMeetingMinutes({
    sessionId: 'sess-1',
    chatHistory: TRANSCRIPT,
    cards: CARDS,
    title: 'Bracket assembly',
    recordingStart: STARTED_AT,
    ...overrides,
  });
}

/** Everything the module warned about, as text, in order. */
let warned: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warned.push(args.map((arg) => String(arg)).join(' '));
  });
  mockUpdate.mockReturnValue({ eq: mockEq.mockResolvedValue({ error: null }) });
  setCapturePausedBy(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  setCapturePausedBy(null);
});

describe('liveTranscriptChunks — the same selection RecordingContext makes', () => {
  it('takes the lines this recording stamped, with their speaker and offset', () => {
    expect(liveTranscriptChunks(TRANSCRIPT, STARTED_AT)).toEqual([
      { speakerId: 'Olga Owner', text: 'The hinge pin wears through the bush.', startMs: 1200, endMs: 1200 },
      { speakerId: 'Olga Owner', text: 'Then we move to Rev B.', startMs: 1200, endMs: 1200 },
    ]);
  });

  it('leaves out everything that is not this recording\'s transcript', () => {
    const chunks = liveTranscriptChunks(
      [
        live('1', 'kept'),
        // Another recording in the same room: its minutes are its own.
        live('2', 'an earlier recording', { id: `live-${STARTED_AT - 999}-2` }),
        // A chat message somebody typed, and lines with nothing to attribute or place.
        { ...live('3', 'typed in chat'), id: 'msg-3' },
        live('4', 'no offset', { offsetMs: undefined }),
        live('5', 'no server-stamped speaker', { speakerId: undefined }),
        live('6', '   '),
      ],
      STARTED_AT,
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual(['kept']);
  });

  it('answers nothing for a room that never recorded', () => {
    // RecordingContext's own first condition. A meeting with no recording still has
    // chat messages, and they are not a transcript.
    expect(liveTranscriptChunks(TRANSCRIPT, 0)).toEqual([]);
  });

  it('falls back to the speaker id when the line carries no name', () => {
    // The endpoint refuses a blank speaker, and lib/ai/summaryPrompt.ts prints this
    // field as the label the minutes attribute a decision to.
    const chunks = liveTranscriptChunks([live('1', 'kept', { speakerName: '' })], STARTED_AT);
    expect(chunks[0].speakerId).toBe('user-1');
  });
});

describe('writeMeetingMinutes — the request', () => {
  it('sends the transcript, the cards and the review\'s title, as JSON', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    await request({ fetchFn: fetch.fn });

    expect(fetch.fn).toHaveBeenCalledTimes(1);
    expect(fetch.sent[0].url).toBe(SUMMARY_ENDPOINT);
    expect(fetch.sent[0].method).toBe('POST');
    expect(fetch.sent[0].contentType).toBe('application/json');
    expect(fetch.sent[0].body.title).toBe('Bracket assembly');
    expect(fetch.sent[0].body.transcript).toHaveLength(2);
    expect(fetch.sent[0].body.cards).toEqual(CARDS);
  });

  it('omits the title rather than sending a blank one', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    await request({ fetchFn: fetch.fn, title: '   ' });

    expect(fetch.sent[0].body).not.toHaveProperty('title');
  });

  it('stores the answer on the meeting\'s own row and hands it back', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    const stored = await request({ fetchFn: fetch.fn });

    expect(stored).toBe(MINUTES);
    expect(mockUpdate).toHaveBeenCalledWith({ summary: MINUTES });
    expect(mockEq).toHaveBeenCalledWith('id', 'sess-1');
  });
});

describe('writeMeetingMinutes — when it sends nothing at all', () => {
  it('has nothing to summarise: no transcript and no cards', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    const stored = await request({ fetchFn: fetch.fn, chatHistory: [], cards: [] });

    expect(fetch.fn).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored).toBeNull();
  });

  it('writes the minutes from the cards, without a model, when there is no transcript', async () => {
    // A curated review that was never recorded is exactly this. Asking a model to
    // write minutes from cards alone made it invent people and decisions (found
    // live, batch BM), so the cards are written out as they are.
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    const stored = await request({ fetchFn: fetch.fn, chatHistory: [], recordingStart: 0 });

    expect(fetch.fn).not.toHaveBeenCalled();
    expect(stored).toContain('No transcript was recorded');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('is in privacy mode, which outlives the meeting', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    const stored = await request({ fetchFn: fetch.fn, privacyMode: true });

    expect(fetch.fn).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(stored).toBeNull();
  });

  it('has capture paused, because somebody is curating the review', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));
    setCapturePausedBy('Maria');

    const stored = await request({ fetchFn: fetch.fn });

    expect(fetch.fn).not.toHaveBeenCalled();
    expect(stored).toBeNull();
  });

  it('has no session row to put the minutes on', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));

    expect(await request({ fetchFn: fetch.fn, sessionId: '' })).toBeNull();
    expect(fetch.fn).not.toHaveBeenCalled();
  });
});

describe('writeMeetingMinutes — a failure', () => {
  it('leaves the summary null and says only which code came back', async () => {
    const fetch = fakeFetch(jsonAnswer({ error: 'capture_upstream_error' }, 502));

    const stored = await request({ fetchFn: fetch.fn });

    expect(stored).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('capture_upstream_error');
  });

  it('never logs the transcript, a card or the model\'s answer', async () => {
    // The endpoint refused, so there is no answer to leak — but the request body is
    // in this process, and a warning that interpolated it would put an unshipped
    // design into a log aggregator.
    const fetch = fakeFetch(jsonAnswer({ error: 'invalid_body' }, 400));

    await request({ fetchFn: fetch.fn });

    const logged = warned.join('\n');
    expect(logged).not.toContain('hinge pin wears through the bush');
    expect(logged).not.toContain('Hinge pin wears');
    expect(logged).not.toContain('Bracket assembly');
    expect(logged).not.toContain(MINUTES);
  });

  it('says the endpoint is missing when a 200 answers with a page', async () => {
    // `vite preview` — which is what the Playwright suite serves — answers every
    // /api/* route with index.html, because Vercel functions do not run there.
    const fetch = fakeFetch(
      () =>
        new Response('<!doctype html><title>Viewpoint</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );

    const stored = await request({ fetchFn: fetch.fn });

    expect(stored).toBeNull();
    expect(warned[0]).toContain('endpoint_unavailable');
  });

  it('says the network failed when the request never landed', async () => {
    const fetch = {
      fn: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
      sent: [] as Sent[],
    };

    const stored = await request({ fetchFn: fetch.fn });

    expect(stored).toBeNull();
    expect(warned[0]).toContain('network');
  });

  it('leaves the summary null when a 200 carries no minutes', async () => {
    const fetch = fakeFetch(jsonAnswer({ summary: '   ' }));

    const stored = await request({ fetchFn: fetch.fn });

    expect(stored).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(warned[0]).toContain('empty_summary');
  });

  it('leaves the meeting recorded when the row cannot be written', async () => {
    // 42703 on an install whose database has not been re-applied since this batch:
    // the minutes exist and there is nowhere to put them.
    const fetch = fakeFetch(jsonAnswer({ summary: MINUTES }));
    mockUpdate.mockReturnValue({
      eq: mockEq.mockResolvedValue({ error: { code: '42703', message: 'undefined_column' } }),
    });

    const stored = await request({ fetchFn: fetch.fn });

    expect(stored).toBeNull();
    expect(warned[0]).toContain('42703');
    expect(warned[0]).not.toContain(MINUTES);
  });
});

// Found live (batch BM): a + Card card has an empty agentId and often no
// description, and api/capture/summary.ts's parser rejected the whole request.
describe('cardForSummary', () => {
  it('makes a hand-made card acceptable to the summary endpoint', async () => {
    const { cardForSummary } = await import('../capture/meetingMinutes');
    const { validateExtractionPayload } = await import('../connectors/capture/parseInsightCards');
    const manual = {
      id: 'manual-1', type: 'RISK' as const, agentId: '', title: 'Hinge pin wears', description: '',
      timestamp: 1000, details: { priority: 'Medium' as const, status: 'Open' as const },
      source: 'manual' as const, createdByName: 'Olga',
    };
    const [parsed] = validateExtractionPayload({ cards: [cardForSummary(manual)] });
    expect(parsed.title).toBe('Hinge pin wears');
    expect(parsed.description).toBe('Hinge pin wears');
  });
});

describe('minutesFromCards', () => {
  it('lists only what the cards say, by section', async () => {
    const { minutesFromCards } = await import('../capture/meetingMinutes');
    const md = minutesFromCards([
      { id: 'a', type: 'RISK', agentId: '', title: 'Hinge pin wears', description: '', timestamp: 1, details: { priority: 'Medium', status: 'Open' } },
      { id: 'b', type: 'ACTION', agentId: '', title: 'Test steel pin', description: 'Cycle test to 5000', timestamp: 2, details: { priority: 'High', status: 'Open', assignee: 'Ben', dueDate: '2026-10-05' } },
    ]);
    expect(md).toContain('## Risks raised\n- Hinge pin wears (Medium)');
    expect(md).toContain('## Actions\n- [ ] Test steel pin: Cycle test to 5000 (High; Ben; by 2026-10-05)');
    expect(md).not.toContain('## Decisions');
  });
});
