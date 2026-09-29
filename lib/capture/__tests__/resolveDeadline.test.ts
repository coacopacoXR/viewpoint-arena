// lib/capture/resolveDeadline.ts — "by Friday" → a date, in code.
//
// Every case pins `today` explicitly, because the whole point of the module is
// that the answer must not depend on when the suite runs. 2026-09-24 is a
// Thursday; the Friday cases are the ones the built-in 7B model got wrong.

import { describe, it, expect } from 'vitest';
import { applyResolvedDeadlines, resolveDeadline, todayUtcIso } from '../resolveDeadline';
import type { InsightCard } from '../../../types';

/** Thursday. */
const THURSDAY = '2026-09-24';
/** Friday, the day after. */
const FRIDAY = '2026-09-25';
/** Monday of the next week. */
const MONDAY = '2026-09-28';

function card(details: Partial<InsightCard['details']> = {}): InsightCard {
  return {
    id: 'insight-1',
    type: 'ACTION',
    agentId: 'speaker-2',
    title: 'Re-run the fatigue simulation',
    description: 'Before the next design gate.',
    timestamp: 1_700_000_000_000,
    details: { priority: 'High', status: 'Open', ...details },
  };
}

describe('resolveDeadline — weekday names', () => {
  it.each([
    ['by Friday', '2026-09-25'],
    ['friday', '2026-09-25'],
    ['this Friday', '2026-09-25'],
    ['on FRIDAY', '2026-09-25'],
    ['by fri', '2026-09-25'],
    ['due Monday', '2026-09-28'],
    ['by Sunday', '2026-09-27'],
  ])('resolves "%s" said on a Thursday', (phrase, expected) => {
    expect(resolveDeadline(THURSDAY, phrase)).toBe(expected);
  });

  it('answers today for "this Friday" said on a Friday', () => {
    expect(resolveDeadline(FRIDAY, 'this Friday')).toBe(FRIDAY);
    expect(resolveDeadline(FRIDAY, 'by Friday')).toBe(FRIDAY);
  });

  it('answers the week after for "next Friday" said on a Friday', () => {
    // The one case where "next" is not the same as "the next occurrence": a
    // Friday's "next Friday" is seven days on, not today.
    expect(resolveDeadline(FRIDAY, 'next Friday')).toBe('2026-10-02');
  });

  it('never answers a day that has already gone', () => {
    // Said on a Thursday, "by Tuesday" can only mean the Tuesday after next.
    expect(resolveDeadline(THURSDAY, 'by Tuesday')).toBe('2026-09-29');
  });
});

describe('resolveDeadline — today, tomorrow, next week', () => {
  it.each([
    ['today', THURSDAY],
    ['by end of day', THURSDAY],
    ['tomorrow', FRIDAY],
    ['by tomorrow', FRIDAY],
    ['the day after tomorrow', '2026-09-26'],
    ['next week', MONDAY],
    ['by next week', MONDAY],
  ])('resolves "%s"', (phrase, expected) => {
    expect(resolveDeadline(THURSDAY, phrase)).toBe(expected);
  });

  it('answers next Monday for "next week" said on a Monday', () => {
    expect(resolveDeadline('2026-09-28', 'next week')).toBe('2026-10-05');
  });
});

describe('resolveDeadline — ends of things', () => {
  it.each([
    ['end of the week', FRIDAY],
    ['by the end of the week', FRIDAY],
    ['end of week', FRIDAY],
    ['EOW', FRIDAY],
  ])('resolves "%s" to the Friday', (phrase, expected) => {
    expect(resolveDeadline(THURSDAY, phrase)).toBe(expected);
  });

  it('resolves "end of the week" said on a Friday to that Friday', () => {
    expect(resolveDeadline(FRIDAY, 'end of the week')).toBe(FRIDAY);
  });

  it.each([
    ['end of the month', '2026-09-30'],
    ['by the end of the month', '2026-09-30'],
    ['EOM', '2026-09-30'],
    ['month end', '2026-09-30'],
  ])('resolves "%s" to the last day of the month', (phrase, expected) => {
    expect(resolveDeadline(THURSDAY, phrase)).toBe(expected);
  });

  it('knows February, and that 2028 is a leap year', () => {
    expect(resolveDeadline('2026-02-04', 'end of the month')).toBe('2026-02-28');
    expect(resolveDeadline('2028-02-04', 'end of the month')).toBe('2028-02-29');
  });

  it('resolves "end of the year"', () => {
    expect(resolveDeadline(THURSDAY, 'by the end of the year')).toBe('2026-12-31');
  });
});

describe('resolveDeadline — counts', () => {
  it.each([
    ['in 3 days', '2026-09-27'],
    ['in three days', '2026-09-27'],
    ['in a day', FRIDAY],
    ['in 2 weeks', '2026-10-08'],
    ['in two weeks', '2026-10-08'],
    ['in a week', '2026-10-01'],
    ['in 1 month', '2026-10-24'],
  ])('resolves "%s"', (phrase, expected) => {
    expect(resolveDeadline(THURSDAY, phrase)).toBe(expected);
  });

  it('clamps a month that is shorter than the day it is counted from', () => {
    // 31 January plus a month is 28 February, not 3 March.
    expect(resolveDeadline('2026-01-31', 'in a month')).toBe('2026-02-28');
  });

  it('refuses a count that is not a small number', () => {
    expect(resolveDeadline(THURSDAY, 'in forty seven weeks')).toBeNull();
    expect(resolveDeadline(THURSDAY, 'in 99 days')).toBeNull();
  });

  it('refuses working days rather than answering with calendar ones', () => {
    // Skipping weekends needs a calendar this module does not have, and three
    // calendar days for "three working days" is the wrong date in the right
    // shape — the worst kind of wrong.
    expect(resolveDeadline(THURSDAY, 'in 3 working days')).toBeNull();
  });
});

describe('resolveDeadline — phrases it does not know', () => {
  it.each([
    'before the freeze',
    'asap',
    'when the parts land',
    'sometime next sprint',
    'the 12th',
    'in a bit',
    '',
    '   ',
    'by',
  ])('answers null for "%s"', (phrase) => {
    expect(resolveDeadline(THURSDAY, phrase)).toBeNull();
  });

  it('answers null for a today it cannot read', () => {
    expect(resolveDeadline('not a date', 'tomorrow')).toBeNull();
    expect(resolveDeadline('', 'by Friday')).toBeNull();
  });

  it('passes a date through, which is what a model that ignored the instruction sends', () => {
    expect(resolveDeadline(THURSDAY, '2026-10-02')).toBe('2026-10-02');
  });
});

describe('todayUtcIso', () => {
  it('is the UTC day, in the same shape the extraction prompt renders', () => {
    expect(todayUtcIso()).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('applyResolvedDeadlines', () => {
  it('lets the resolved date beat the one the model computed', () => {
    // The live failure: qwen2.5:7b, given today's date and a fortnight of weekday
    // names, answered a Thursday's "by Friday" with the Sunday after.
    const wrong = card({ dueDate: '2026-09-28', dueDateText: 'by Friday' });
    const [resolved] = applyResolvedDeadlines([wrong], THURSDAY);

    expect(resolved.details.dueDate).toBe('2026-09-25');
    // The words stay: they are what a reviewer hears when they read the date,
    // and they are the only trace left of a phrase this code could not resolve.
    expect(resolved.details.dueDateText).toBe('by Friday');
  });

  it('keeps the model’s date for a phrase it cannot resolve', () => {
    const kept = card({ dueDate: '2026-10-01', dueDateText: 'before the freeze' });
    const [resolved] = applyResolvedDeadlines([kept], THURSDAY);

    expect(resolved.details.dueDate).toBe('2026-10-01');
  });

  it('fills in a date when the model gave words and no date at all', () => {
    const [resolved] = applyResolvedDeadlines([card({ dueDateText: 'tomorrow' })], THURSDAY);
    expect(resolved.details.dueDate).toBe(FRIDAY);
  });

  it('leaves every other card alone, and alone as the same object', () => {
    const noWords = card({ dueDate: '2026-10-01' });
    const blankWords = card({ dueDate: '2026-10-01', dueDateText: '   ' });
    const alreadyRight = card({ dueDate: FRIDAY, dueDateText: 'by Friday' });

    const out = applyResolvedDeadlines([noWords, blankWords, alreadyRight], THURSDAY);

    // Identity, not just equality: nothing is copied that does not change, so a
    // caller comparing cards before and after sees no churn.
    expect(out[0]).toBe(noWords);
    expect(out[1]).toBe(blankWords);
    expect(out[2]).toBe(alreadyRight);
  });

  it('does not mutate the cards it was given', () => {
    const original = card({ dueDate: '2026-09-28', dueDateText: 'by Friday' });
    applyResolvedDeadlines([original], THURSDAY);

    expect(original.details.dueDate).toBe('2026-09-28');
  });

  it('resolves against today when no day is given', () => {
    const [resolved] = applyResolvedDeadlines([card({ dueDateText: 'today' })]);
    expect(resolved.details.dueDate).toBe(todayUtcIso());
  });
});

describe('resolveDeadline — what a small model actually returns', () => {
  it('ignores a date the model glued onto the words (found live)', async () => {
    const { resolveDeadline } = await import('../resolveDeadline');
    // Friday 2026-09-25: Monday is the 28th, not the model's 10-02.
    expect(resolveDeadline('2026-09-25', 'by Monday 2026-10-02')).toBe('2026-09-28');
  });
  it('ignores a parenthesis', async () => {
    const { resolveDeadline } = await import('../resolveDeadline');
    expect(resolveDeadline('2026-09-25', 'by Monday (Oct 2)')).toBe('2026-09-28');
  });
  it('finds a day word inside a longer phrase', async () => {
    const { resolveDeadline } = await import('../resolveDeadline');
    expect(resolveDeadline('2026-09-25', 'sometime before the Wednesday build')).toBe('2026-09-30');
  });
  it('still returns null for words with no day in them', async () => {
    const { resolveDeadline } = await import('../resolveDeadline');
    expect(resolveDeadline('2026-09-25', 'when the supplier answers')).toBeNull();
  });
});
