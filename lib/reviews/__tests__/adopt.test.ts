// Which models the main line ends up showing when a variant is adopted into it —
// lib/reviews/adopt.ts.
//
// docs/plan/15-sessions-and-variants.md batch BL. The rule the user decided is one
// sentence long and has one exception in it:
//
//   the variant's latest revision(s) become the main line's current ones … If both
//   lines changed the model, adopting asks one plain question: "Keep Rev C from the
//   main line or Rev B2 from Variant A?"
//
// So what is pinned here is the exception and its shape. The question has to be that
// sentence, word for word, because it is read out loud in a meeting; there has to be
// exactly ONE of it however many models both lines moved, because two questions in a
// row is the beginning of a conflict screen and a conflict screen is the one piece of
// the programming metaphor the plan forbids; and both of its answers have to be a
// COMPLETE scene, because "keep the main line's" that quietly drops the mating part
// somebody added beside the product would be a decision nobody made.

import { describe, it, expect } from 'vitest';
import { adoptPlan, adoptQuestion, adoptRevisionIds, asAdoptKeep, type AdoptFacts } from '../adopt';

const REVISIONS = [
  { id: 'r-a', line: 'Bracket', revision: 'A' },
  { id: 'r-b', line: 'Bracket', revision: 'B' },
  { id: 'r-b2', line: 'Bracket', revision: 'B2' },
  { id: 'r-c', line: 'Bracket', revision: 'C' },
  { id: 'h-a', line: 'Housing', revision: 'A' },
];

function facts(overrides: Partial<AdoptFacts> = {}): AdoptFacts {
  return {
    parentRevisionIds: ['r-a'],
    mainRevisionIds: ['r-a'],
    variantRevisionIds: ['r-a'],
    revisions: REVISIONS,
    variantLabel: 'Variant A',
    ...overrides,
  };
}

describe('adoptPlan — only one line moved', () => {
  it('takes the variant\'s model when only the variant uploaded since the parent session', () => {
    const plan = adoptPlan(facts({ variantRevisionIds: ['r-b2'] }));
    expect(plan.kind).toBe('take');
    expect(plan.kind === 'take' && plan.revisionIds).toEqual(['r-b2']);
  });

  it('takes every revision the variant is showing, not only the one that differs', () => {
    const plan = adoptPlan(facts({ mainRevisionIds: ['r-a', 'h-a'], variantRevisionIds: ['r-b2', 'h-a'] }));
    expect(plan.kind).toBe('take');
    expect(plan.kind === 'take' && plan.revisionIds).toEqual(['r-b2', 'h-a']);
  });

  it('leaves the main line alone when only the MAIN line uploaded since', () => {
    // The variant left before Rev C existed and has no opinion on it.
    const plan = adoptPlan(facts({ mainRevisionIds: ['r-c'] }));
    expect(plan.kind).toBe('unchanged');
    expect(plan.kind === 'unchanged' && plan.revisionIds).toEqual(['r-c']);
  });

  it('leaves the main line alone when neither moved', () => {
    expect(adoptPlan(facts()).kind).toBe('unchanged');
  });

  it('takes a model the variant added and the main line has never had', () => {
    const plan = adoptPlan(facts({ variantRevisionIds: ['r-a', 'h-a'] }));
    expect(plan.kind).toBe('take');
    expect(plan.kind === 'take' && plan.revisionIds).toEqual(['r-a', 'h-a']);
  });

  it('keeps the main line\'s model for one the variant never showed', () => {
    const plan = adoptPlan(facts({ mainRevisionIds: ['r-c', 'h-a'], variantRevisionIds: ['r-c'] }));
    expect(plan.kind).toBe('unchanged');
    expect(plan.kind === 'unchanged' && plan.revisionIds).toEqual(['r-c', 'h-a']);
  });
});

describe('adoptPlan — both lines moved the same model', () => {
  it('asks the one plain question, in the words the plan gives it', () => {
    const plan = adoptPlan(facts({ mainRevisionIds: ['r-c'], variantRevisionIds: ['r-b2'] }));
    expect(plan.kind).toBe('ask');
    expect(plan.kind === 'ask' && plan.choice.question).toBe(
      'Keep Rev C from the main line or Rev B2 from Variant A?',
    );
  });

  it('names the variant by its own label, and falls back to a sentence that still works without one', () => {
    const asked = adoptPlan(facts({ mainRevisionIds: ['r-c'], variantRevisionIds: ['r-b2'], variantLabel: 'Variant Q' }));
    expect(asked.kind === 'ask' && asked.choice.question).toContain('from Variant Q?');

    const unnamed = adoptPlan(facts({ mainRevisionIds: ['r-c'], variantRevisionIds: ['r-b2'], variantLabel: null }));
    expect(unnamed.kind === 'ask' && unnamed.choice.question).toBe(
      'Keep Rev C from the main line or Rev B2 from the variant?',
    );
  });

  it('offers two COMPLETE scenes, so neither answer can drop a model nobody argued about', () => {
    const plan = adoptPlan(facts({ mainRevisionIds: ['r-c', 'h-a'], variantRevisionIds: ['r-b2', 'h-a'] }));
    expect(plan.kind).toBe('ask');
    if (plan.kind !== 'ask') return;
    expect(plan.choice.mainRevisionIds).toEqual(['r-c', 'h-a']);
    expect(plan.choice.variantRevisionIds).toEqual(['r-b2', 'h-a']);
  });

  it('still asks ONE question when two models moved on both lines', () => {
    const two = [
      { id: 'r-a', line: 'Bracket', revision: 'A' },
      { id: 'r-c', line: 'Bracket', revision: 'C' },
      { id: 'r-b2', line: 'Bracket', revision: 'B2' },
      { id: 'h-a', line: 'Housing', revision: 'A' },
      { id: 'h-b', line: 'Housing', revision: 'B' },
      { id: 'h-a2', line: 'Housing', revision: 'A2' },
    ];
    const plan = adoptPlan(facts({
      parentRevisionIds: ['r-a', 'h-a'],
      mainRevisionIds: ['r-c', 'h-b'],
      variantRevisionIds: ['r-b2', 'h-a2'],
      revisions: two,
    }));
    expect(plan.kind).toBe('ask');
    if (plan.kind !== 'ask') return;
    // One sentence, one question mark, two answers.
    expect(plan.choice.question.split('?')).toHaveLength(2);
    expect(plan.choice.question).toBe('Keep Rev C and Rev B from the main line or Rev B2 and Rev A2 from Variant A?');
    expect(plan.choice.mainRevisionIds).toEqual(['r-c', 'h-b']);
    expect(plan.choice.variantRevisionIds).toEqual(['r-b2', 'h-a2']);
  });

  it('asks rather than guessing when the parent session stored no revisions', () => {
    // revision_ids is empty for every meeting held before batch BC. Nothing can be
    // proved to have moved, so the difference becomes a question instead of a choice
    // this code makes on somebody's behalf.
    const plan = adoptPlan(facts({ parentRevisionIds: [], mainRevisionIds: ['r-c'], variantRevisionIds: ['r-b2'] }));
    expect(plan.kind).toBe('ask');
  });

  it('does not ask about a model both lines ended up showing the same revision of', () => {
    const plan = adoptPlan(facts({ parentRevisionIds: ['r-a'], mainRevisionIds: ['r-c'], variantRevisionIds: ['r-c'] }));
    expect(plan.kind).toBe('unchanged');
  });
});

describe('adoptRevisionIds — the answer', () => {
  const asked = adoptPlan(facts({ mainRevisionIds: ['r-c'], variantRevisionIds: ['r-b2'] }));

  it('is nothing at all until the question has been answered', () => {
    expect(adoptRevisionIds(asked, null)).toBeNull();
    expect(adoptRevisionIds(asked, asAdoptKeep('perhaps'))).toBeNull();
  });

  it('takes the side that was chosen', () => {
    expect(adoptRevisionIds(asked, asAdoptKeep('main'))).toEqual(['r-c']);
    expect(adoptRevisionIds(asked, asAdoptKeep('variant'))).toEqual(['r-b2']);
  });

  it('needs no answer when there was no question', () => {
    const take = adoptPlan(facts({ variantRevisionIds: ['r-b2'] }));
    expect(adoptRevisionIds(take, null)).toEqual(['r-b2']);
    expect(adoptRevisionIds(adoptPlan(facts()), null)).toEqual(['r-a']);
  });

  it('reads an answer off the wire strictly', () => {
    expect(asAdoptKeep('target')).toBe('target');
    expect(asAdoptKeep('variant')).toBe('variant');
    // 'main' is the word from before batch BX, when the only line a variant could be
    // taken into WAS the main one. Still read, and read as the target, so a browser
    // holding the older bundle cannot break a review by answering in the old word.
    expect(asAdoptKeep('main')).toBe('target');
    expect(asAdoptKeep('MAIN')).toBeNull();
    expect(asAdoptKeep('mainline')).toBeNull();
    expect(asAdoptKeep(undefined)).toBeNull();
    expect(asAdoptKeep(['target'])).toBeNull();
  });

  it('answers the target’s half for either spelling of the same answer', () => {
    const asked = adoptPlan(facts({
      parentRevisionIds: ['r-a'],
      mainRevisionIds: ['r-c'],
      variantRevisionIds: ['r-b2'],
    }));
    expect(asked.kind).toBe('ask');
    expect(adoptRevisionIds(asked, 'target')).toEqual(['r-c']);
    expect(adoptRevisionIds(asked, 'variant')).toEqual(['r-b2']);
    expect(adoptRevisionIds(asked, null)).toBeNull();
  });
});

describe('adoptQuestion — which line the sentence names', () => {
  // Batch BX: a merge has a destination and the destination is not always the main
  // line, so the words follow it. A question that said "the main line" about a merge
  // into Variant A would ask somebody to choose between two models and then write the
  // answer onto a third.
  const conflicts = [{ main: 'r-c', variant: 'r-b2' }];

  it('names the main line when that is where the variant is going', () => {
    expect(adoptQuestion(conflicts, 'Variant B', REVISIONS, 'the main line'))
      .toBe('Keep Rev C from the main line or Rev B2 from Variant B?');
  });

  it('names the target line when the variant is going into another variant', () => {
    expect(adoptQuestion(conflicts, 'Variant B', REVISIONS, 'Variant A'))
      .toBe('Keep Rev C from Variant A or Rev B2 from Variant B?');
  });

  it('says the main line when no target was named at all', () => {
    expect(adoptQuestion(conflicts, 'Variant B', REVISIONS)).toContain('from the main line');
    expect(adoptPlan(facts({ variantLabel: 'Variant B' })).kind).toBe('unchanged');
  });

  it('carries the target’s name through the plan the endpoint builds', () => {
    const asked = adoptPlan(facts({
      parentRevisionIds: ['r-a'],
      mainRevisionIds: ['r-c'],
      variantRevisionIds: ['r-b2'],
      variantLabel: 'Variant B',
      targetLabel: 'Variant A',
    }));
    expect(asked.kind).toBe('ask');
    expect(asked.kind === 'ask' && asked.choice.question)
      .toBe('Keep Rev C from Variant A or Rev B2 from Variant B?');
  });
});

describe('adoptPlan — a review with no stored history', () => {
  it('says nothing has changed when no revision row can be named', () => {
    // An install whose database predates model_revisions: the ids on screen match no
    // row, so there is no model to compare and no question to ask. Adopting still
    // moves the cards.
    const plan = adoptPlan(facts({ revisions: [], mainRevisionIds: ['x'], variantRevisionIds: ['y'] }));
    expect(plan.kind).toBe('unchanged');
  });

  it('says nothing has changed when neither line has met since the variant was started', () => {
    const plan = adoptPlan(facts({ parentRevisionIds: [], mainRevisionIds: [], variantRevisionIds: [] }));
    expect(plan.kind).toBe('unchanged');
    expect(plan.kind === 'unchanged' && plan.revisionIds).toEqual([]);
  });
});
