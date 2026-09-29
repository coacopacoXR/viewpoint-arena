// Defensive parser for model-produced InsightCard payloads.
//
// Shared by every transcript-driven capture provider: api/capture/extract.ts
// (OpenAI + Anthropic, parsed server-side) and lib/connectors/capture/
// ollamaDirect.ts (parsed in the browser, because there is no server in that
// path). One parser means one set of guarantees and one set of tests.
//
// The rule this module exists to enforce: a model may return ANYTHING, and the
// app must never crash and never accept a half-built card. Every failure is a
// CaptureExtractionError carrying a machine-readable `reason`, so a caller can
// tell an operator what went wrong without echoing model output.
//
// Browser-safe: no env access, no I/O, no secrets.

import type { InsightCard, InsightDetails, InsightType } from '../../../types';

/**
 * Machine-readable failure classification. Safe to put in an HTTP response —
 * unlike `message`, which may quote the model output and therefore the
 * transcript.
 */
export type CaptureParseFailureReason =
  /** The reply was wrapped in a ``` fence despite the prompt forbidding it. */
  | 'markdown_fenced'
  /** The reply was natural language, not JSON. */
  | 'prose'
  /** The reply started as JSON and stopped mid-value (usually max_tokens). */
  | 'truncated_json'
  /** The reply was almost-JSON that does not parse. */
  | 'malformed_json'
  /** Valid JSON, but not the `{ "cards": [...] }` envelope. */
  | 'wrong_envelope'
  /** A key that is not part of InsightCard / InsightDetails. */
  | 'extra_fields'
  /** A known key holding a missing, mistyped or out-of-range value. */
  | 'invalid_card';

export class CaptureExtractionError extends Error {
  readonly reason: CaptureParseFailureReason;
  /** Which card failed, when the failure was per-card. */
  readonly cardIndex: number | null;

  constructor(
    reason: CaptureParseFailureReason,
    message: string,
    cardIndex: number | null = null,
  ) {
    super(message);
    this.name = 'CaptureExtractionError';
    this.reason = reason;
    this.cardIndex = cardIndex;
  }
}

const INSIGHT_TYPES: readonly InsightType[] = ['RISK', 'RATIONALE', 'ACTION'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
const STATUSES = ['Open', 'In Review', 'Approved', 'Rejected'] as const;
const DECISION_ROLES = [
  'TRIGGER',
  'RATIONALE',
  'INTERMEDIATE_DECISION',
  'FINAL_DECISION',
] as const;
const DESIGN_STAGES = ['DETAILED_DESIGN'] as const;

// Allowlists, not denylists: a field the model invents is rejected rather than
// silently passed through into the tracker. These are exactly the keys of
// InsightCard and InsightDetails in types.ts.
//
// `source` and `createdByName` are in CARD_KEYS but are deliberately NOT copied
// onto a parsed card (see validateCard): they say who wrote a card, and a card
// this parser produced was written by a model, so it is an AI card whatever it
// claims. Listing them here keeps the allowlist the same set as the interface —
// and capture-service/tests/test_typescript_parity.py fails if it is not — while
// a model that echoes them back is tolerated rather than trusted.
const ENVELOPE_KEYS = new Set(['cards']);
const CARD_KEYS = new Set([
  'id',
  'type',
  'agentId',
  'title',
  'description',
  'timestamp',
  'relatedPoiId',
  'sourceMessageIds',
  'details',
  'source',
  'createdByName',
  'affectedRequirementIds',
  'kbRecommendations',
]);
const DETAILS_KEYS = new Set([
  'priority',
  'status',
  'assignee',
  'dueDate',
  'dueDateText',
  'componentReference',
  'designStage',
  'decisionRole',
  'impact',
  'mitigationStrategy',
  'designDriver',
  'alternativesConsidered',
  'tradeoffAnalysis',
  'department',
]);

export interface InsightParseOptions {
  /**
   * Used when a card omits `agentId` (the prompt asks for the speaker, but a
   * synthesized card may span several). Providers pass the first speaker in the
   * transcript window.
   */
  defaultAgentId?: string;
  /** Injectable clock, so minted timestamps are deterministic under test. */
  now?: () => number;
  /** Injectable id mint, so minted ids are deterministic under test. */
  newId?: (index: number) => string;
}

// ─── Text-level entry point (model output as it came off the wire) ──────────

/**
 * Parses raw model output into InsightCard[].
 *
 * @throws CaptureExtractionError for every shape of bad output. Never throws
 *         anything else, and never returns a partial list.
 */
export function parseInsightCards(
  rawModelOutput: unknown,
  options: InsightParseOptions = {},
): InsightCard[] {
  if (typeof rawModelOutput !== 'string') {
    throw new CaptureExtractionError(
      'malformed_json',
      'The model returned no text content to parse.',
    );
  }

  let text = rawModelOutput.trim();

  // Unwrap a markdown code fence before parsing.
  //
  // OpenAI (response_format) and Ollama (format:"json") make fences
  // unreachable, but Anthropic has no JSON mode and fencing is its normal
  // habit — so rejecting a fence outright would make the Anthropic provider
  // fail on well-formed output during ordinary use. Unwrapping is not
  // guesswork: only the fence delimiters are removed, and JSON.parse still
  // validates everything inside. Anything that is not valid JSON after
  // unwrapping still fails below, with the same reasons as before.
  const isFence = (line: string) =>
    line.trim().startsWith('```') || line.trim().startsWith('~~~');
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && isFence(lines[0])) {
    const closing = lines.length - 1;
    if (isFence(lines[closing])) {
      text = lines.slice(1, closing).join('\n').trim();
    } else {
      // An opening fence that is never closed: the reply was cut off.
      throw new CaptureExtractionError(
        'markdown_fenced',
        'The model opened a markdown code fence but never closed it, so the ' +
          `reply is incomplete. Response began: ${snippet(text)}`,
      );
    }
  } else if (isFence(text)) {
    // An opening fence with no closing one: the reply was cut off mid-fence.
    throw new CaptureExtractionError(
      'markdown_fenced',
      'The model opened a markdown code fence but never closed it, so the ' +
        `reply is incomplete. Response began: ${snippet(text)}`,
    );
  }

  if (text.length === 0) {
    throw new CaptureExtractionError(
      'prose',
      'The model returned an empty response.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw classifyUnparseable(text);
  }

  return validateExtractionPayload(parsed, options);
}

/**
 * Why did valid-looking text fail to parse? The distinction matters to an
 * operator: truncation means raise max_tokens, prose means the model ignored
 * the format instruction.
 */
function classifyUnparseable(text: string): CaptureExtractionError {
  const first = text[0];
  const last = text[text.length - 1];
  const looksLikeJson = first === '{' || first === '[';

  if (!looksLikeJson) {
    return new CaptureExtractionError(
      'prose',
      `The model replied in natural language instead of JSON. Response began: ${snippet(text)}`,
    );
  }
  const closesProperly =
    (first === '{' && last === '}') || (first === '[' && last === ']');
  if (!closesProperly) {
    return new CaptureExtractionError(
      'truncated_json',
      'The model output was cut off mid-JSON — usually the completion hit its ' +
        `token limit. Response ended: ${snippet(text.slice(-120), true)}`,
    );
  }
  return new CaptureExtractionError(
    'malformed_json',
    `The model returned JSON that does not parse. Response began: ${snippet(text)}`,
  );
}

// ─── Value-level entry point (already-parsed JSON, e.g. from our own API) ───

/**
 * Validates the `{ cards: [...] }` envelope and every card in it.
 *
 * Used by parseInsightCards for model output and by the browser clients for
 * the response of api/capture/extract.ts, so a proxy that starts returning
 * something unexpected fails the same way a model would.
 */
export function validateExtractionPayload(
  payload: unknown,
  options: InsightParseOptions = {},
): InsightCard[] {
  if (!isRecord(payload)) {
    throw new CaptureExtractionError(
      'wrong_envelope',
      Array.isArray(payload)
        ? 'Expected a JSON object with a "cards" array, got a bare array.'
        : `Expected a JSON object with a "cards" array, got ${describe(payload)}.`,
    );
  }

  // "cards" is checked before the unknown-key sweep so that a model which
  // renamed the envelope ({"insights": [...]}) is told the envelope is wrong,
  // rather than being told it added a field.
  const cards = payload.cards;
  if (!Array.isArray(cards)) {
    throw new CaptureExtractionError(
      'wrong_envelope',
      `"cards" must be an array, got ${describe(cards)}. Expected the shape ` +
        `{ "cards": [ ... ] } described in the extraction prompt.`,
    );
  }

  rejectUnknownKeys(payload, ENVELOPE_KEYS, 'response');

  const now = options.now ? options.now() : Date.now();
  const newId = options.newId ?? defaultNewId;

  return cards.map((raw, index) =>
    validateCard(raw, index, { ...options, nowMs: now, mintId: newId }),
  );
}

/** InsightParseOptions with the clock and the id mint already resolved. */
interface ResolvedOptions extends InsightParseOptions {
  nowMs: number;
  mintId: (index: number) => string;
}

function validateCard(
  raw: unknown,
  index: number,
  options: ResolvedOptions,
): InsightCard {
  const where = `cards[${index}]`;
  if (!isRecord(raw)) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where} must be an object, got ${describe(raw)}.`,
      index,
    );
  }
  rejectUnknownKeys(raw, CARD_KEYS, where, index);

  const type = oneOf(raw, 'type', INSIGHT_TYPES, where, index);
  const details = validateDetails(raw.details, index, `${where}.details`);

  const card: InsightCard = {
    id: optionalNonEmptyString(raw, 'id', where, index) ?? options.mintId(index),
    type,
    agentId:
      optionalNonEmptyString(raw, 'agentId', where, index) ??
      options.defaultAgentId ??
      'transcript',
    title: requiredNonEmptyString(raw, 'title', where, index),
    description: requiredNonEmptyString(raw, 'description', where, index),
    timestamp: optionalTimestamp(raw, index, where, options.nowMs),
    details,
  };

  // Optional fields are only set when the model actually supplied them, so a
  // card never carries `undefined`-valued keys into the tracker.
  const relatedPoiId = optionalNonEmptyString(raw, 'relatedPoiId', where, index);
  if (relatedPoiId !== undefined) card.relatedPoiId = relatedPoiId;

  const sourceMessageIds = optionalStringArray(raw, 'sourceMessageIds', where, index);
  if (sourceMessageIds !== undefined) card.sourceMessageIds = sourceMessageIds;

  const affected = optionalStringArray(raw, 'affectedRequirementIds', where, index);
  if (affected !== undefined) card.affectedRequirementIds = affected;

  const kb = optionalStringArray(raw, 'kbRecommendations', where, index);
  if (kb !== undefined) card.kbRecommendations = kb;

  return card;
}

function validateDetails(
  raw: unknown,
  cardIndex: number,
  where: string,
): InsightDetails {
  if (!isRecord(raw)) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where} must be an object, got ${describe(raw)}.`,
      cardIndex,
    );
  }
  rejectUnknownKeys(raw, DETAILS_KEYS, where, cardIndex);

  const details: InsightDetails = {
    // priority is required: the Manager workspace triages on it, and guessing
    // a priority would be inventing an engineering judgement the model did not
    // make. status defaults to Open, which is what a freshly extracted card is.
    priority: oneOf(raw, 'priority', PRIORITIES, where, cardIndex),
    status: optionalOneOf(raw, 'status', STATUSES, where, cardIndex) ?? 'Open',
  };

  // The InsightDetails fields that are plain optional strings. Listed rather
  // than derived from `keyof` so the write below stays type-safe.
  const STRING_DETAIL_KEYS = [
    'assignee',
    'dueDate',
    'dueDateText',
    'componentReference',
    'impact',
    'mitigationStrategy',
    'designDriver',
    'alternativesConsidered',
    'tradeoffAnalysis',
    'department',
  ] as const;
  for (const key of STRING_DETAIL_KEYS) {
    const value = optionalNonEmptyString(raw, key, where, cardIndex);
    if (value !== undefined) details[key] = value;
  }

  const designStage = optionalOneOf(raw, 'designStage', DESIGN_STAGES, where, cardIndex);
  if (designStage !== undefined) details.designStage = designStage;

  const decisionRole = optionalOneOf(raw, 'decisionRole', DECISION_ROLES, where, cardIndex);
  if (decisionRole !== undefined) details.decisionRole = decisionRole;

  return details;
}

// ─── Field validators ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  cardIndex: number | null = null,
): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.has(k));
  if (unknown.length === 0) return;
  throw new CaptureExtractionError(
    'extra_fields',
    `${where} contained field(s) that are not part of the InsightCard shape: ` +
      `${unknown.join(', ')}. Refusing the card rather than passing an ` +
      `unknown field through to the tracker.`,
    cardIndex,
  );
}

function requiredNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  cardIndex: number,
): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where}.${key} must be a non-empty string, got ${describe(value)}.`,
      cardIndex,
    );
  }
  return value.trim();
}

/** Optional string; an empty/whitespace value is treated as absent. */
function optionalNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  cardIndex: number,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where}.${key} must be a string when present, got ${describe(value)}.`,
      cardIndex,
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function optionalStringArray(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  cardIndex: number,
): string[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where}.${key} must be an array of strings when present, got ${describe(value)}.`,
      cardIndex,
    );
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new CaptureExtractionError(
        'invalid_card',
        `${where}.${key} must contain only non-empty strings.`,
        cardIndex,
      );
    }
  }
  return value.map((entry) => entry.trim());
}

function oneOf<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  where: string,
  cardIndex: number,
): T {
  const value = optionalOneOf(obj, key, allowed, where, cardIndex);
  if (value === undefined) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where}.${key} is required and must be one of: ${allowed.join(', ')}.`,
      cardIndex,
    );
  }
  return value;
}

function optionalOneOf<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  where: string,
  cardIndex: number,
): T | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where}.${key} must be one of ${allowed.join(', ')}, got ${describe(value)}.`,
      cardIndex,
    );
  }
  return value as T;
}

function optionalTimestamp(
  obj: Record<string, unknown>,
  cardIndex: number,
  where: string,
  now: number,
): number {
  const value = obj.timestamp;
  if (value === undefined || value === null) return now;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CaptureExtractionError(
      'invalid_card',
      `${where}.timestamp must be a finite number of epoch milliseconds when ` +
        `present, got ${describe(value)}. Omit it and the app will stamp the card.`,
      cardIndex,
    );
  }
  return value;
}

function defaultNewId(index: number): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') {
    return `insight-${crypto.randomUUID()}`;
  }
  // jsdom and some edge runtimes ship crypto without randomUUID.
  const rand = Math.random().toString(36).slice(2, 10);
  return `insight-${Date.now().toString(36)}-${index}-${rand}`;
}

// ─── Message helpers ────────────────────────────────────────────────────────

function describe(value: unknown): string {
  if (value === undefined) return 'nothing (the key is missing)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  return `${typeof value} ${String(value)}`;
}

/** Collapses whitespace so a snippet cannot smuggle newlines into a log line. */
function snippet(text: string, fromEnd = false): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = fromEnd ? flat.slice(-120) : flat.slice(0, 120);
  return JSON.stringify(cut.length < flat.length ? `${cut}…` : cut);
}
