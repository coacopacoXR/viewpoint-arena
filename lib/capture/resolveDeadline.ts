// "by Friday" → 2026-09-25, in code rather than in a model.
//
// docs/plan/14-rooms-models-admin-ai.md batch BG. The built-in 7B model gets
// relative deadlines wrong even with the calendar in its prompt: given today's
// date and a fortnight of weekday names to LOOK UP, qwen2.5:7b still answered a
// Monday's "by Friday" with 2026-09-28 (the Sunday after). Small models are
// unreliable at exactly this — turning a phrase into an offset — and the wrong
// date is worse than no date, because a reviewer acts on it: an action that says
// "due 2026-09-28" when somebody promised Friday is a promise the tracker
// misreports, and nobody can tell from the card that it was ever wrong.
//
// So the extraction asks for the WORDS as well (`details.dueDateText`, copied
// verbatim) and this module resolves them. Where a phrase resolves, its date
// wins over whatever the model put in `dueDate`; where it does not, the model's
// answer is kept, because "before the freeze" is a deadline the room understood
// even if this code does not.
//
// Pure and dependency-free: no clock of its own (today is a parameter), no I/O,
// no locale. Dates are handled as UTC so a meeting in Auckland and the server
// that recorded it resolve "tomorrow" to the same day, which is the same choice
// lib/connectors/capture/extractionPrompt.ts makes when it renders the calendar.

import type { InsightCard } from '../../types';

const DAY_MS = 86_400_000;

/** Weekday names a speaker uses, indexed the way Date#getUTCDay numbers them. */
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Short forms that come up in a transcript often enough to be worth knowing. */
const WEEKDAY_ABBREVIATIONS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  tues: 2,
  wed: 3,
  weds: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  fri: 5,
  sat: 6,
};

/** Words that introduce a deadline rather than being part of one. */
const LEADING_PREPOSITION =
  /^(?:no later than|due by|due on|due|by|before|until|up to|till|on|for|target)\s+/;

/**
 * Today, as the UTC YYYY-MM-DD this module and the extraction prompt both use.
 * A parameter default rather than a hidden clock, so a test can pin the day.
 */
export function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseIsoDate(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Which day of the week a YYYY-MM-DD date is, 0=Sunday. */
function weekdayIndex(ms: number): number {
  return new Date(ms).getUTCDay();
}

/**
 * The next occurrence of weekday `target`, counting today as an occurrence:
 * "this Friday" said on a Friday is today, and "by Friday" said on a Friday is
 * today too, because that is what a reviewer means by it.
 */
function nextOccurrence(todayMs: number, target: number): number {
  const delta = (target - weekdayIndex(todayMs) + 7) % 7;
  return todayMs + delta * DAY_MS;
}

/** The last day of the month `ms` falls in. */
function endOfMonth(ms: number): number {
  const date = new Date(ms);
  // Day 0 of the NEXT month is the last day of this one.
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
}

function weekdayOfPhrase(phrase: string): number | null {
  if ((WEEKDAYS as readonly string[]).includes(phrase)) {
    return (WEEKDAYS as readonly string[]).indexOf(phrase);
  }
  const abbreviation = WEEKDAY_ABBREVIATIONS[phrase];
  return abbreviation === undefined ? null : abbreviation;
}

/**
 * Count words: "in three days", "in 3 days", "in a week". Only the small
 * numbers a deadline is actually spoken with — an "in forty seven weeks" is a
 * plan, not a due date, and the transcript is more likely to have garbled it.
 */
const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

function countOf(word: string): number | null {
  if (/^\d{1,2}$/.test(word)) {
    const value = Number(word);
    return value >= 1 && value <= 31 ? value : null;
  }
  const spelled = NUMBER_WORDS[word];
  return spelled === undefined ? null : spelled;
}

/**
 * Resolve one spoken deadline against one day.
 *
 * `todayIso` is the day the phrase was said (or the day it is being read — for
 * an extraction, the two are the same meeting). Answers an ISO date, or null
 * when the phrase is not one this code knows, which the caller must treat as
 * "keep whatever else is known" and never as "no deadline".
 */
/**
 * The model is asked to copy the deadline words verbatim, and small models do
 * not: live, qwen2.5:7b answered "by Monday 2026-10-02" — the right words with
 * its own (wrong) date glued on — and the exact-phrase resolver then returned
 * null, so the card lost its deadline entirely. So: strip any date or
 * parenthesis the model appended and resolve the words; failing that, find a
 * day word inside the phrase. The model's own date is never what wins when
 * words are there, because the words are what was actually said.
 */
export function resolveDeadline(todayIso: string, phrase: string): string | null {
  const cleaned = phrase
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned === '' ? phrase : cleaned;
  const exact = resolveExactPhrase(todayIso, words);
  if (exact !== null) return exact;
  if (words !== phrase) {
    const original = resolveExactPhrase(todayIso, phrase);
    if (original !== null) return original;
  }
  // Last resort: a single day word somewhere inside ("sometime before Friday's build").
  for (const token of words.toLowerCase().split(/[^a-z]+/)) {
    if (!token) continue;
    if (token === 'today' || token === 'tomorrow' || weekdayOfPhrase(token) !== null) {
      return resolveExactPhrase(todayIso, token);
    }
  }
  return null;
}

function resolveExactPhrase(todayIso: string, phrase: string): string | null {
  const todayMs = parseIsoDate(todayIso);
  if (todayMs === null) return null;

  const normalised = phrase
    .trim()
    .toLowerCase()
    .replace(/["'’]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
    .replace(LEADING_PREPOSITION, '')
    .replace(/^the\s+/, '')
    .trim();

  if (normalised === '') return null;
  // A date the model wrote into the words field instead of the date field.
  if (parseIsoDate(normalised) !== null) return normalised;

  // ─── Fixed phrases ──────────────────────────────────────────────────────
  if (normalised === 'today' || normalised === 'end of day' || normalised === 'eod') {
    return toIso(todayMs);
  }
  if (normalised === 'tomorrow' || normalised === 'day after tomorrow') {
    return toIso(todayMs + (normalised === 'tomorrow' ? 1 : 2) * DAY_MS);
  }
  if (normalised === 'next week' || normalised === 'week after next') {
    // "Next week" means the start of the next working week: the coming Monday,
    // always at least a day away, so a Monday's "next week" is a week on.
    const weeks = normalised === 'next week' ? 1 : 2;
    const delta = (1 - weekdayIndex(todayMs) + 7) % 7 || 7;
    return toIso(todayMs + (delta + (weeks - 1) * 7) * DAY_MS);
  }
  if (
    normalised === 'end of the week' ||
    normalised === 'end of week' ||
    normalised === 'end of this week' ||
    normalised === 'eow'
  ) {
    // Friday, the working week's last day, counting today if today is Friday.
    return toIso(nextOccurrence(todayMs, 5));
  }
  if (
    normalised === 'end of the month' ||
    normalised === 'end of month' ||
    normalised === 'eom' ||
    normalised === 'month end'
  ) {
    return toIso(endOfMonth(todayMs));
  }
  if (normalised === 'end of the year' || normalised === 'end of year') {
    return `${new Date(todayMs).getUTCFullYear()}-12-31`;
  }

  // ─── "in N days / weeks / months" ───────────────────────────────────────
  // Working days are deliberately NOT resolved: skipping weekends and holidays
  // needs a calendar this module does not have, and answering "in three working
  // days" with three calendar days would be the wrong date wearing the right
  // shape. Better null, and the model's own guess kept.
  const inMatch = /^in\s+(\S+)\s+(days?|weeks?|months?)$/.exec(normalised);
  if (inMatch) {
    const count = countOf(inMatch[1]);
    if (count !== null) {
      const unit = inMatch[2];
      if (unit.startsWith('day')) return toIso(todayMs + count * DAY_MS);
      if (unit.startsWith('week')) return toIso(todayMs + count * 7 * DAY_MS);
      const date = new Date(todayMs);
      const year = date.getUTCFullYear();
      const month = date.getUTCMonth() + count;
      // Clamped, because Date.UTC rolls over: "in a month" said on 31 January is
      // 28 February, not 3 March.
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      return toIso(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
    }
    return null;
  }

  // ─── A weekday name, with or without "this" / "next" ────────────────────
  const weekdayMatch = /^(?:(this|next|coming)\s+)?(?:(week|wk)\s+on\s+)?(\S+)$/.exec(normalised);
  if (weekdayMatch) {
    const qualifier = weekdayMatch[1] ?? '';
    const target = weekdayOfPhrase(weekdayMatch[3]);
    if (target !== null) {
      const occurrence = nextOccurrence(todayMs, target);
      // "Next Friday" said on a Friday is the Friday after, not today.
      return toIso(qualifier === 'next' && occurrence === todayMs ? todayMs + 7 * DAY_MS : occurrence);
    }
  }

  return null;
}

/**
 * Give every card that carries a spoken deadline the date that phrase means.
 *
 * The rule, and the reason for it: a phrase this code resolves OVERRIDES the
 * model's `dueDate`, because the model is the thing that got it wrong; a phrase
 * it does not resolve leaves the model's answer alone, because a wrong-looking
 * date a reviewer can still argue with beats one silently deleted. `dueDateText`
 * itself is kept either way — it is what the tracker's reader hears in their head
 * when they look at the date.
 *
 * Cards without the field are returned as they were, and nothing is mutated: the
 * router hands the result straight back to an API response.
 */
export function applyResolvedDeadlines(
  cards: readonly InsightCard[],
  todayIso: string = todayUtcIso(),
): InsightCard[] {
  return cards.map((card) => {
    const phrase = card.details.dueDateText;
    if (phrase === undefined || phrase.trim() === '') return card;
    const resolved = resolveDeadline(todayIso, phrase);
    if (resolved === null) return card;
    if (card.details.dueDate === resolved) return card;
    return { ...card, details: { ...card.details, dueDate: resolved } };
  });
}
