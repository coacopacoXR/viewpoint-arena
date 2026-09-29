// Tests for the defensive InsightCard parser.
//
// The contract under test: a model may return ANYTHING, and this module must
// never crash and never return a half-built card. The four malformed shapes
// called out in the T4.5 ticket — prose, truncated JSON, markdown code fences,
// extra fields — each get their own case, plus every other way a payload can
// be wrong that the parser distinguishes.

import { describe, it, expect } from 'vitest';
import {
  CaptureExtractionError,
  parseInsightCards,
  validateExtractionPayload,
} from './parseInsightCards';
import type { CaptureParseFailureReason } from './parseInsightCards';

const FIXED_NOW = 1_770_000_000_000;
const DETERMINISTIC = {
  now: () => FIXED_NOW,
  newId: (index: number) => `insight-test-${index}`,
};

const VALID_CARD = {
  type: 'RISK',
  title: 'Wall thickness transition risks sink marks',
  description:
    'SYS.OP flagged that the wall drops from 2.8mm to 1.2mm over 15mm, which historically causes sink on A-surfaces.',
  agentId: 'speaker-1',
  relatedPoiId: 'bracket-alpha',
  sourceMessageIds: ['c2', 'c3'],
  details: {
    priority: 'High',
    status: 'Open',
    componentReference: 'Bracket Alpha',
    impact: 'Visible sink on the A-surface',
    mitigationStrategy: 'Re-run moldflow with the updated wall profile',
  },
};

function wrap(cards: unknown[]): string {
  return JSON.stringify({ cards });
}

function expectFailure(
  fn: () => unknown,
  reason: CaptureParseFailureReason,
): CaptureExtractionError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the parser to throw').toBeInstanceOf(
    CaptureExtractionError,
  );
  const failure = caught as CaptureExtractionError;
  expect(failure.reason).toBe(reason);
  // The message is what an operator reads: it must explain itself.
  expect(failure.message.length).toBeGreaterThan(20);
  return failure;
}

describe('parseInsightCards — valid output', () => {
  it('returns every card from a well-formed payload', () => {
    const cards = parseInsightCards(wrap([VALID_CARD]), DETERMINISTIC);

    expect(cards).toHaveLength(1);
    expect(cards[0].type).toBe('RISK');
    expect(cards[0].title).toBe(VALID_CARD.title);
    expect(cards[0].description).toBe(VALID_CARD.description);
    expect(cards[0].agentId).toBe('speaker-1');
    expect(cards[0].relatedPoiId).toBe('bracket-alpha');
    expect(cards[0].sourceMessageIds).toEqual(['c2', 'c3']);
    expect(cards[0].details.priority).toBe('High');
    expect(cards[0].details.status).toBe('Open');
    expect(cards[0].details.impact).toBe('Visible sink on the A-surface');
  });

  it('accepts all three insight types and all four priorities', () => {
    const cards = parseInsightCards(
      wrap([
        { ...VALID_CARD, type: 'RATIONALE', details: { priority: 'Critical' } },
        { ...VALID_CARD, type: 'ACTION', details: { priority: 'Medium' } },
        { ...VALID_CARD, type: 'RISK', details: { priority: 'Low' } },
      ]),
      DETERMINISTIC,
    );

    expect(cards.map((c) => c.type)).toEqual(['RATIONALE', 'ACTION', 'RISK']);
    expect(cards.map((c) => c.details.priority)).toEqual([
      'Critical',
      'Medium',
      'Low',
    ]);
  });

  it('resolves to an empty array when the window held nothing to capture', () => {
    // A meeting window with no insight in it is a valid answer, not a failure.
    expect(parseInsightCards(wrap([]), DETERMINISTIC)).toEqual([]);
  });

  it('mints id and timestamp when the model omits them', () => {
    // VALID_CARD carries neither — the prompt tells the model not to send them.
    const cards = parseInsightCards(wrap([VALID_CARD]), DETERMINISTIC);

    expect(cards[0].id).toBe('insight-test-0');
    expect(cards[0].timestamp).toBe(FIXED_NOW);
  });

  it('mints unique ids for every card when no id mint is injected', () => {
    const cards = parseInsightCards(
      wrap([VALID_CARD, { ...VALID_CARD, type: 'ACTION' }]),
      { now: () => FIXED_NOW },
    );

    expect(cards).toHaveLength(2);
    expect(cards[0].id).toMatch(/^insight-/);
    expect(cards[0].id).not.toBe(cards[1].id);
  });

  it('keeps a model-supplied id and timestamp when they are well-formed', () => {
    const cards = parseInsightCards(
      wrap([{ ...VALID_CARD, id: 'card-42', timestamp: 1_700_000_000_000 }]),
      DETERMINISTIC,
    );

    expect(cards[0].id).toBe('card-42');
    expect(cards[0].timestamp).toBe(1_700_000_000_000);
  });

  it('defaults status to Open and agentId to the supplied default', () => {
    const cards = parseInsightCards(
      wrap([
        {
          type: 'ACTION',
          title: 'Run tolerance stack-up',
          description: 'Design team to provide updated GD&T by Thursday.',
          details: { priority: 'Medium' },
        },
      ]),
      { ...DETERMINISTIC, defaultAgentId: 'speaker-7' },
    );

    expect(cards[0].details.status).toBe('Open');
    expect(cards[0].agentId).toBe('speaker-7');
  });

  it('falls back to a generic agentId when the model omits it and none is given', () => {
    const cards = parseInsightCards(
      wrap([
        {
          type: 'RISK',
          title: 'Clearance risk',
          description: 'Not enough clearance to the sub-assembly.',
          details: { priority: 'High' },
        },
      ]),
      DETERMINISTIC,
    );

    expect(cards[0].agentId).toBe('transcript');
  });

  it('trims strings and drops optional fields the model left empty', () => {
    const cards = parseInsightCards(
      wrap([
        {
          ...VALID_CARD,
          title: '  Padded title  ',
          relatedPoiId: '   ',
          details: { priority: 'High', impact: '', mitigationStrategy: null },
        },
      ]),
      DETERMINISTIC,
    );

    expect(cards[0].title).toBe('Padded title');
    // An empty optional field is treated as absent rather than stored as "".
    expect('relatedPoiId' in cards[0]).toBe(false);
    expect('impact' in cards[0].details).toBe(false);
    expect('mitigationStrategy' in cards[0].details).toBe(false);
  });

  it('does not attach optional keys the model never sent', () => {
    const cards = parseInsightCards(
      wrap([
        {
          type: 'RATIONALE',
          title: 'Hydroformed profile',
          description: 'Chosen for weight optimisation.',
          details: { priority: 'Low' },
        },
      ]),
      DETERMINISTIC,
    );

    expect(Object.keys(cards[0]).sort()).toEqual([
      'agentId',
      'description',
      'details',
      'id',
      'timestamp',
      'title',
      'type',
    ]);
    expect(Object.keys(cards[0].details).sort()).toEqual(['priority', 'status']);
  });

  it('accepts the optional InsightDetails enums when a model does send them', () => {
    const cards = parseInsightCards(
      wrap([
        {
          ...VALID_CARD,
          details: {
            priority: 'High',
            designStage: 'DETAILED_DESIGN',
            decisionRole: 'TRIGGER',
          },
        },
      ]),
      DETERMINISTIC,
    );

    expect(cards[0].details.designStage).toBe('DETAILED_DESIGN');
    expect(cards[0].details.decisionRole).toBe('TRIGGER');
  });

  it('tolerates surrounding whitespace and a trailing newline', () => {
    const cards = parseInsightCards(`\n\n  ${wrap([VALID_CARD])}\n  `, DETERMINISTIC);
    expect(cards).toHaveLength(1);
  });
});

describe('parseInsightCards — MALFORMED: prose', () => {
  it('rejects a natural-language answer with reason "prose"', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          'Sure! Here are the insights I found in the transcript:\n\n' +
            '1. There is a risk of sink marks on the bracket.\n' +
            '2. The team should run a tolerance stack-up.',
          DETERMINISTIC,
        ),
      'prose',
    );
    expect(failure.message).toMatch(/natural language/i);
  });

  it('rejects a refusal with reason "prose"', () => {
    expectFailure(
      () =>
        parseInsightCards(
          'I cannot help with that request.',
          DETERMINISTIC,
        ),
      'prose',
    );
  });

  it('rejects an empty response with reason "prose"', () => {
    const failure = expectFailure(
      () => parseInsightCards('   \n ', DETERMINISTIC),
      'prose',
    );
    expect(failure.message).toMatch(/empty/i);
  });

  it('rejects a missing text content (no string at all)', () => {
    // Anthropic returns no text block for some refusals; Ollama can omit
    // message.content. Both arrive here as a non-string.
    for (const value of [undefined, null, 42, {}]) {
      expectFailure(() => parseInsightCards(value, DETERMINISTIC), 'malformed_json');
    }
  });

  it('rejects JSON that is a bare string, number or null', () => {
    // These DO parse, so they reach the envelope check rather than the prose one.
    expectFailure(() => parseInsightCards('"here you go"', DETERMINISTIC), 'wrong_envelope');
    expectFailure(() => parseInsightCards('42', DETERMINISTIC), 'wrong_envelope');
    expectFailure(() => parseInsightCards('null', DETERMINISTIC), 'wrong_envelope');
  });
});

describe('parseInsightCards — MALFORMED: truncated JSON', () => {
  it('rejects a payload cut off mid-card with reason "truncated_json"', () => {
    const truncated = wrap([VALID_CARD]).slice(0, 120);
    const failure = expectFailure(
      () => parseInsightCards(truncated, DETERMINISTIC),
      'truncated_json',
    );
    // Actionable: says what usually causes it.
    expect(failure.message).toMatch(/token limit/i);
  });

  it('rejects a payload that stops right after the opening brace', () => {
    expectFailure(() => parseInsightCards('{"cards": [', DETERMINISTIC), 'truncated_json');
  });

  it('rejects an unterminated string value as truncated', () => {
    expectFailure(
      () => parseInsightCards('{"cards":[{"title":"Wall thickness', DETERMINISTIC),
      'truncated_json',
    );
  });

  it('returns no cards at all when the payload was truncated', () => {
    // Even though the first card was complete, the envelope never closed: the
    // caller gets an error, never a partial list.
    const twoCards = wrap([VALID_CARD, { ...VALID_CARD, type: 'ACTION' }]);
    const boundary = twoCards.indexOf('},{');
    expect(boundary).toBeGreaterThan(0);
    // Cut immediately after card 1's closing brace and the separator comma.
    const truncated = twoCards.slice(0, boundary + 2);
    expect(truncated).toContain(VALID_CARD.title);

    expectFailure(() => parseInsightCards(truncated, DETERMINISTIC), 'truncated_json');
  });

  it('distinguishes malformed-but-closed JSON from truncated JSON', () => {
    // Braces balance, so this is not a truncation — it is just bad JSON.
    expectFailure(
      () => parseInsightCards('{"cards": [ {,} ]}', DETERMINISTIC),
      'malformed_json',
    );
  });
});

describe('parseInsightCards — markdown code fences', () => {
  const inner = wrap([VALID_CARD]);

  // Unwrapped rather than rejected. OpenAI and Ollama have JSON modes that make
  // fences unreachable, but Anthropic has none and fencing is its normal habit,
  // so rejecting would fail well-formed Anthropic output in ordinary use.
  // Removing the delimiters is not guesswork — JSON.parse still validates
  // everything inside, so a fence wrapping junk still fails below.
  it('unwraps a ```json fence and parses the JSON inside', () => {
    const cards = parseInsightCards('```json\n' + inner + '\n```', DETERMINISTIC);
    expect(cards).toHaveLength(1);
  });

  it('unwraps a bare ``` fence', () => {
    expect(parseInsightCards('```\n' + inner + '\n```', DETERMINISTIC)).toHaveLength(1);
  });

  it('unwraps a ~~~ fence', () => {
    expect(parseInsightCards('~~~json\n' + inner + '\n~~~', DETERMINISTIC)).toHaveLength(1);
  });

  it('unwraps a fence preceded by whitespace', () => {
    expect(parseInsightCards('\n   ```json\n' + inner + '\n```', DETERMINISTIC)).toHaveLength(1);
  });

  it('still rejects a fence that is opened but never closed', () => {
    // A cut-off reply, which is a genuine failure rather than a formatting habit.
    const failure = expectFailure(
      () => parseInsightCards('```json\n' + inner, DETERMINISTIC),
      'markdown_fenced',
    );
    expect(failure.message).toMatch(/never closed/i);
  });

  it('still rejects a fence wrapping something that is not JSON', () => {
    expectFailure(
      () => parseInsightCards('```json\nhere are the cards you asked for\n```', DETERMINISTIC),
      'prose',
    );
  });
});

describe('parseInsightCards — MALFORMED: extra fields', () => {
  it('rejects an unknown field on a card and names it', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, confidence: 0.91 }]),
          DETERMINISTIC,
        ),
      'extra_fields',
    );
    expect(failure.message).toContain('confidence');
    expect(failure.cardIndex).toBe(0);
  });

  it('rejects an unknown field on details and names it', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          wrap([
            {
              ...VALID_CARD,
              details: { priority: 'High', severityScore: 7 },
            },
          ]),
          DETERMINISTIC,
        ),
      'extra_fields',
    );
    expect(failure.message).toContain('severityScore');
  });

  it('rejects an unknown field on the envelope and names it', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          JSON.stringify({ cards: [VALID_CARD], summary: 'Three items found' }),
          DETERMINISTIC,
        ),
      'extra_fields',
    );
    expect(failure.message).toContain('summary');
  });

  it('names every offending field, not just the first', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, confidence: 0.9, tags: ['x'] }]),
          DETERMINISTIC,
        ),
      'extra_fields',
    );
    expect(failure.message).toContain('confidence');
    expect(failure.message).toContain('tags');
  });

  it('rejects a card that renamed a known field instead of using it', () => {
    // `component` is not `componentReference`; the allowlist catches the drift.
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, details: { priority: 'High', component: 'Bracket' } }]),
          DETERMINISTIC,
        ),
      'extra_fields',
    );
  });
});

describe('parseInsightCards — MALFORMED: wrong envelope or values', () => {
  it('rejects a bare array of cards', () => {
    const failure = expectFailure(
      () => parseInsightCards(JSON.stringify([VALID_CARD]), DETERMINISTIC),
      'wrong_envelope',
    );
    expect(failure.message).toMatch(/bare array/i);
  });

  it('rejects an envelope that renamed "cards"', () => {
    expectFailure(
      () => parseInsightCards(JSON.stringify({ insights: [VALID_CARD] }), DETERMINISTIC),
      'wrong_envelope',
    );
  });

  it('rejects a non-array "cards"', () => {
    expectFailure(
      () => parseInsightCards(JSON.stringify({ cards: VALID_CARD }), DETERMINISTIC),
      'wrong_envelope',
    );
  });

  it('rejects a card that is not an object, naming the index', () => {
    const failure = expectFailure(
      () => parseInsightCards(wrap([VALID_CARD, 'not a card']), DETERMINISTIC),
      'invalid_card',
    );
    expect(failure.cardIndex).toBe(1);
    expect(failure.message).toContain('cards[1]');
  });

  it('rejects an unknown insight type and lists the allowed values', () => {
    const failure = expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, type: 'WARNING' }]), DETERMINISTIC),
      'invalid_card',
    );
    expect(failure.message).toContain('RISK, RATIONALE, ACTION');
  });

  it('rejects a lowercase insight type rather than silently fixing it', () => {
    expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, type: 'risk' }]), DETERMINISTIC),
      'invalid_card',
    );
  });

  it('rejects a missing type', () => {
    const { type: _type, ...rest } = VALID_CARD;
    expectFailure(() => parseInsightCards(wrap([rest]), DETERMINISTIC), 'invalid_card');
  });

  it('rejects a missing or empty title', () => {
    expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, title: '' }]), DETERMINISTIC),
      'invalid_card',
    );
    expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, title: '   ' }]), DETERMINISTIC),
      'invalid_card',
    );
    const { title: _title, ...noTitle } = VALID_CARD;
    expectFailure(() => parseInsightCards(wrap([noTitle]), DETERMINISTIC), 'invalid_card');
  });

  it('rejects a missing description', () => {
    const { description: _description, ...rest } = VALID_CARD;
    expectFailure(() => parseInsightCards(wrap([rest]), DETERMINISTIC), 'invalid_card');
  });

  it('rejects a non-string description', () => {
    expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, description: 12 }]), DETERMINISTIC),
      'invalid_card',
    );
  });

  it('rejects missing details', () => {
    const { details: _details, ...rest } = VALID_CARD;
    const failure = expectFailure(
      () => parseInsightCards(wrap([rest]), DETERMINISTIC),
      'invalid_card',
    );
    expect(failure.message).toContain('cards[0].details');
  });

  it('rejects details that are a string instead of an object', () => {
    expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, details: 'High' }]), DETERMINISTIC),
      'invalid_card',
    );
  });

  it('rejects a missing priority — the one details field that is required', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, details: { status: 'Open' } }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
    expect(failure.message).toMatch(/priority is required/i);
  });

  it('rejects out-of-range priority and status values', () => {
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, details: { priority: 'Urgent' } }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, details: { priority: 'High', status: 'Todo' } }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
  });

  it('rejects an ISO-string timestamp — the app stamps cards itself', () => {
    const failure = expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, timestamp: '2026-09-08T10:00:00Z' }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
    expect(failure.message).toMatch(/epoch milliseconds/i);
  });

  it('rejects a timestamp that is not a number', () => {
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, timestamp: { ms: 1_700_000_000_000 } }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
  });

  it('rejects sourceMessageIds that are not an array of non-empty strings', () => {
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, sourceMessageIds: 'c3' }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, sourceMessageIds: [3, 4] }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
    expectFailure(
      () =>
        parseInsightCards(
          wrap([{ ...VALID_CARD, sourceMessageIds: ['c3', ''] }]),
          DETERMINISTIC,
        ),
      'invalid_card',
    );
  });

  it('ignores a blank model-supplied id and mints one instead', () => {
    // Consistent with every other optional field: blank means "not supplied",
    // not "invalid". The app owns ids anyway — the prompt tells the model not
    // to send one. A non-string id IS a type error, though.
    const blank = parseInsightCards(
      wrap([{ ...VALID_CARD, id: '   ' }]),
      DETERMINISTIC,
    );
    expect(blank[0].id).toBe('insight-test-0');

    expectFailure(
      () => parseInsightCards(wrap([{ ...VALID_CARD, id: 7 }]), DETERMINISTIC),
      'invalid_card',
    );
  });
});

describe('parseInsightCards — all-or-nothing', () => {
  it('returns nothing when only the SECOND card is invalid', () => {
    // The failure mode this guards: a caller receiving [goodCard] would show a
    // user one insight and silently drop the rest of the meeting.
    let caught: unknown;
    try {
      parseInsightCards(
        wrap([VALID_CARD, { ...VALID_CARD, type: 'OBSERVATION' }]),
        DETERMINISTIC,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CaptureExtractionError);
    expect((caught as CaptureExtractionError).cardIndex).toBe(1);
  });

  it('never returns a partial list for any malformed shape', () => {
    const malformed: string[] = [
      'Here are your cards!',
      '{"cards": [{',
      '```json\n{"cards":[]}',  // opened fence, never closed
      wrap([{ ...VALID_CARD, extra: true }]),
      JSON.stringify({ items: [] }),
      wrap([VALID_CARD, 'nope']),
    ];

    for (const raw of malformed) {
      let result: unknown = 'DID NOT THROW';
      try {
        result = parseInsightCards(raw, DETERMINISTIC);
      } catch {
        result = 'threw';
      }
      expect(result, `expected ${raw.slice(0, 40)} to be rejected`).toBe('threw');
    }
  });
});

describe('validateExtractionPayload — already-parsed JSON', () => {
  // Used by the browser clients on the response of api/capture/extract.ts, so
  // a proxy that starts returning something unexpected fails the same way.

  it('accepts the same payload the parser accepts', () => {
    const cards = validateExtractionPayload({ cards: [VALID_CARD] }, DETERMINISTIC);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('insight-test-0');
  });

  it('rejects a non-object payload', () => {
    expectFailure(() => validateExtractionPayload('cards', DETERMINISTIC), 'wrong_envelope');
    expectFailure(() => validateExtractionPayload(null, DETERMINISTIC), 'wrong_envelope');
    expectFailure(() => validateExtractionPayload([], DETERMINISTIC), 'wrong_envelope');
  });

  it('rejects an error body that a proxy returned with a 200', () => {
    // A serverless platform can answer 200 with its own JSON envelope.
    expectFailure(
      () => validateExtractionPayload({ error: 'rate_limited' }, DETERMINISTIC),
      'wrong_envelope',
    );
  });

  it('applies the same extra-fields and invalid-card rules', () => {
    expectFailure(
      () => validateExtractionPayload({ cards: [{ ...VALID_CARD, extra: 1 }] }, DETERMINISTIC),
      'extra_fields',
    );
    expectFailure(
      () => validateExtractionPayload({ cards: [{ ...VALID_CARD, type: 'NOPE' }] }, DETERMINISTIC),
      'invalid_card',
    );
  });
});

describe('CaptureExtractionError', () => {
  it('is a real Error with a stable name and a machine-readable reason', () => {
    const err = new CaptureExtractionError('prose', 'message', 2);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CaptureExtractionError');
    expect(err.reason).toBe('prose');
    expect(err.cardIndex).toBe(2);
  });

  it('defaults cardIndex to null for payload-level failures', () => {
    expect(new CaptureExtractionError('prose', 'm').cardIndex).toBeNull();
  });
});
