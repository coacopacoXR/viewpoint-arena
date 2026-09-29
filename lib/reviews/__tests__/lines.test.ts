// Tests for lib/reviews/lines.ts — the words and the ids a design review's lines
// are known by (docs/plan/15-sessions-and-variants.md batch BK).
//
// These are the labels a reviewer reads on a card, on the session map and in the
// room's address bar, so what is pinned here is mostly what they must NOT say: no
// "S0" for a session that has no number, no letter for the main line, no reused
// letter for a dropped variant, and never one of the four words the plan bans.

import { describe, it, expect } from 'vitest';
import {
  LINE_QUERY_PARAM,
  MAIN_LINE_NAME,
  activeChildrenOf,
  activeLines,
  adoptedCardLabel,
  cardLineLabel,
  defaultMergeTarget,
  descendantsOf,
  droppedCardReason,
  droppedLineReason,
  hiddenLineCount,
  isDescendantOf,
  isMainLine,
  lineById,
  lineFilterLabel,
  lineIdFromSearch,
  lineLabel,
  lineLabelWithOrigin,
  lineOriginLabel,
  lineStatusWord,
  mainLineOf,
  mergeTargetWord,
  mergeTargets,
  mergedIntoLabel,
  nextVariantLetter,
  orderedLines,
  parentChain,
  partyRoomName,
  placementSlotOrder,
  roomPath,
  sessionLabel,
  shortLineLabel,
  toReviewLine,
  type ReviewLine,
} from '../lines';

const REVIEW = 'review-1';

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: 'line-main',
    reviewId: REVIEW,
    kind: 'main',
    name: MAIN_LINE_NAME,
    letter: null,
    parentSessionId: null,
    parentLineId: null,
    mergedIntoLineId: null,
    dropReason: null,
    status: 'active',
    createdBy: null,
    createdByName: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

const variantA = line({
  id: 'line-a', kind: 'variant', name: 'Weld fix', letter: 'A',
  parentSessionId: 'sess-2', createdAt: '2026-09-05T09:00:00.000Z',
});

// ─── Reading a row ──────────────────────────────────────────────────────────

describe('toReviewLine', () => {
  it('reads a main line and gives it no letter', () => {
    const read = toReviewLine({
      id: 'line-main', review_id: REVIEW, kind: 'main', name: 'Main line',
      letter: null, parent_session_id: null, status: 'active', created_by: null,
      created_by_name: '', created_at: '2026-09-01T09:00:00.000Z', closed_at: null,
    });
    expect(read).toMatchObject({ id: 'line-main', kind: 'main', letter: null, status: 'active' });
    expect(isMainLine(read)).toBe(true);
  });

  it('upper-cases and trims a variant letter, because the room name is built from it', () => {
    const read = toReviewLine({ id: 'x', review_id: REVIEW, kind: 'variant', name: 'Weld', letter: ' a ', status: 'dropped', created_at: '' });
    expect(read?.letter).toBe('A');
    expect(read?.status).toBe('dropped');
  });

  it('takes a letter away from a main line that was somehow stored with one', () => {
    // A main line's sessions are S1, S2, S3. Giving it a letter would make it read
    // as one more variant, on the map and in its room name.
    expect(toReviewLine({ id: 'x', review_id: REVIEW, kind: 'main', letter: 'A', created_at: '' })?.letter).toBeNull();
  });

  it('answers null for a row it cannot make sense of, rather than guessing', () => {
    expect(toReviewLine(null)).toBeNull();
    expect(toReviewLine({ id: '', review_id: REVIEW, kind: 'main' })).toBeNull();
    expect(toReviewLine({ id: 'x', review_id: '', kind: 'main' })).toBeNull();
    // A kind a later batch added is not one of ours to render.
    expect(toReviewLine({ id: 'x', review_id: REVIEW, kind: 'spike' })).toBeNull();
  });

  it('reads an unknown status as active, which is the only safe default', () => {
    expect(toReviewLine({ id: 'x', review_id: REVIEW, kind: 'variant', status: 'paused', created_at: '' })?.status).toBe('active');
  });
});

// ─── The labels ─────────────────────────────────────────────────────────────

describe('sessionLabel', () => {
  it('numbers the main line S1, S2, S3', () => {
    expect(sessionLabel(line(), 1)).toBe('S1');
    expect(sessionLabel(line(), 3)).toBe('S3');
  });

  it('numbers a variant by its letter', () => {
    expect(sessionLabel(variantA, 2)).toBe('A2');
  });

  it('answers null for a session with no number, so nothing renders "S0"', () => {
    expect(sessionLabel(line(), null)).toBeNull();
    expect(sessionLabel(line(), undefined)).toBeNull();
    expect(sessionLabel(line(), 0)).toBeNull();
    expect(sessionLabel(line(), 1.5)).toBeNull();
  });

  it('still numbers a variant whose letter was never stored, from its name', () => {
    // A row written by hand, or by an install that assigned letters later: a variant
    // called "Weld fix" reads as Variant W rather than as a line with no label.
    expect(sessionLabel(line({ kind: 'variant', name: 'Weld fix', letter: null }), 2)).toBe('W2');
  });

  it('falls back to S for a variant with neither a letter nor a usable name', () => {
    expect(sessionLabel(line({ kind: 'variant', name: '42', letter: null }), 2)).toBe('S2');
  });
});

describe('lineLabel and shortLineLabel', () => {
  it('calls the main line "Main line"', () => {
    expect(lineLabel(line())).toBe('Main line');
    expect(shortLineLabel(line())).toBe('Main line');
  });

  it('names a variant by its letter and, where there is room, its name', () => {
    expect(shortLineLabel(variantA)).toBe('Variant A');
    expect(lineLabel(variantA)).toBe('Variant A · Weld fix');
  });

  it('names a variant with no name by its letter alone', () => {
    expect(lineLabel(line({ kind: 'variant', letter: 'B', name: '  ' }))).toBe('Variant B');
  });

  it('infers a letter from a variant whose name starts with one', () => {
    // A row written by hand, or by an install that assigned letters later: a variant
    // called "Weld fix" still reads as Variant W rather than as a line with no label.
    expect(lineLabel(line({ kind: 'variant', letter: null, name: 'Weld fix' }))).toBe('Variant W · Weld fix');
    expect(shortLineLabel(line({ kind: 'variant', letter: null, name: 'Weld fix' }))).toBe('Variant W');
  });

  it('names a variant with no usable letter by its name alone, not "Variant · 42 mm pin"', () => {
    const nameless = line({ kind: 'variant', letter: null, name: '42 mm pin' });
    expect(lineLabel(nameless)).toBe('42 mm pin');
    expect(shortLineLabel(nameless)).toBe('Variant');
  });

  it('calls a variant with neither a letter nor a name "Variant", and nothing worse', () => {
    expect(lineLabel(line({ kind: 'variant', letter: null, name: '  ' }))).toBe('Variant');
  });

  it('answers null rather than printing a label with a hole in it', () => {
    expect(lineLabel(null)).toBeNull();
    expect(shortLineLabel(undefined)).toBeNull();
  });
});

describe('cardLineLabel', () => {
  it('says where a card came from, in the words the plan asks for', () => {
    expect(cardLineLabel(line(), 3)).toBe('Main line · S3');
    expect(cardLineLabel(variantA, 2)).toBe('Variant A · A2');
  });

  it('answers null unless both halves are there', () => {
    expect(cardLineLabel(line(), null)).toBeNull();
    expect(cardLineLabel(null, 3)).toBeNull();
  });
});

// ─── The room a line meets in ───────────────────────────────────────────────

describe('partyRoomName', () => {
  it('keeps the review id for the main line, so every link already out there works', () => {
    expect(partyRoomName(REVIEW, line())).toBe(REVIEW);
    expect(partyRoomName(REVIEW, null)).toBe(REVIEW);
  });

  it('gives a variant its own live room', () => {
    // Its own presence, its own audio and its own scene on the room server: a
    // meeting exploring the variant cannot move the main line's model.
    expect(partyRoomName(REVIEW, variantA)).toBe(`${REVIEW}~A`);
  });

  it('falls back to the main line for a variant with no letter it can use', () => {
    // Two people in the same meeting beats two people in two rooms who cannot hear
    // each other.
    expect(partyRoomName(REVIEW, line({ kind: 'variant', letter: null, name: '42' }))).toBe(REVIEW);
  });
});

describe('roomPath and lineIdFromSearch', () => {
  it('leaves the main line address exactly as it has always been', () => {
    expect(roomPath(REVIEW, null)).toBe(`/room/${REVIEW}`);
    expect(roomPath(REVIEW)).toBe(`/room/${REVIEW}`);
  });

  it('puts a variant in a query parameter', () => {
    expect(roomPath(REVIEW, 'line-a')).toBe(`/room/${REVIEW}?line=line-a`);
  });

  it('reads the line back out of an address', () => {
    expect(lineIdFromSearch(`?${LINE_QUERY_PARAM}=line-a`)).toBe('line-a');
    expect(lineIdFromSearch('?edit=1&line=line-a')).toBe('line-a');
  });

  it('answers null for an address with no line in it', () => {
    expect(lineIdFromSearch('')).toBeNull();
    expect(lineIdFromSearch(null)).toBeNull();
    expect(lineIdFromSearch('?edit=1')).toBeNull();
    // A parameter that is there but empty is an address somebody typed, and it does
    // not name a line.
    expect(lineIdFromSearch('?line=')).toBeNull();
    expect(lineIdFromSearch('?line=   ')).toBeNull();
  });
});

// ─── The next variant's letter ──────────────────────────────────────────────

describe('nextVariantLetter', () => {
  it('starts at A', () => {
    expect(nextVariantLetter([line()])).toBe('A');
    expect(nextVariantLetter([])).toBe('A');
  });

  it('takes the first letter nothing has used', () => {
    const taken = [line(), variantA, line({ id: 'line-c', kind: 'variant', letter: 'C' })];
    expect(nextVariantLetter(taken)).toBe('B');
  });

  it('does not reuse the letter of a DROPPED variant', () => {
    // A letter is an identity, not a slot. Reusing "Variant A" after the first one
    // was dropped would leave two different sets of cards both saying they came from
    // Variant A, and keeping a dropped variant for the record is the whole point.
    const dropped = [line(), line({ id: 'line-a', kind: 'variant', letter: 'A', status: 'dropped' })];
    expect(nextVariantLetter(dropped)).toBe('B');
  });

  it('counts a letter inferred from a name as taken', () => {
    // Every letter is used except W and X, and the one variant with no stored letter
    // is called "Weld fix". W is taken by inference, so the next variant is X.
    const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index))
      .filter((letter) => letter !== 'W' && letter !== 'X');
    const taken = letters.map((letter, index) => line({ id: `line-${index}`, kind: 'variant', letter }));
    const inferred = line({ id: 'line-inferred', kind: 'variant', letter: null, name: 'Weld fix' });
    expect(nextVariantLetter([...taken, inferred])).toBe('X');
  });

  it('goes to two letters once a review has used all twenty-six', () => {
    const all = Array.from({ length: 26 }, (_, index) =>
      line({ id: `line-${index}`, kind: 'variant', letter: String.fromCharCode(65 + index) }),
    );
    expect(nextVariantLetter(all)).toBe('AA');
  });
});

// ─── Picking lines out of a list ────────────────────────────────────────────

describe('orderedLines, mainLineOf and lineById', () => {
  const lateVariant = line({
    id: 'line-b', kind: 'variant', name: 'Lighter bracket', letter: 'B',
    createdAt: '2026-09-09T09:00:00.000Z',
  });

  it('puts the main line first and the variants in the order they were started', () => {
    // The map's rows are positional: a variant that moved between two renders would
    // look like a different variant.
    const ordered = orderedLines([lateVariant, variantA, line()]);
    expect(ordered.map((entry) => entry.id)).toEqual(['line-main', 'line-a', 'line-b']);
  });

  it('finds the main line, and answers null when there is none', () => {
    expect(mainLineOf([variantA, line()])?.id).toBe('line-main');
    expect(mainLineOf([variantA])).toBeNull();
    expect(mainLineOf([])).toBeNull();
  });

  it('finds one line by id', () => {
    const both = [line(), variantA];
    expect(lineById(both, 'line-a')?.name).toBe('Weld fix');
    expect(lineById(both, 'nope')).toBeNull();
    expect(lineById(both, null)).toBeNull();
  });
});

// ─── Where a line came from, and where it went (batch BX) ────────────────────

const mainLine = line();
// A is started from the main line; B from A; C from A; D from B. A review whose
// variants are a tree and not a list, which is the shape batch BX makes possible.
const variantB = line({
  id: 'line-b', kind: 'variant', name: 'Lighter frame', letter: 'B',
  parentSessionId: null, parentLineId: 'line-a', createdAt: '2026-09-08T09:00:00.000Z',
});
const variantC = line({
  id: 'line-c', kind: 'variant', name: 'Carbon', letter: 'C',
  parentSessionId: null, parentLineId: 'line-a', createdAt: '2026-09-09T09:00:00.000Z',
});
const variantD = line({
  id: 'line-d', kind: 'variant', name: 'Deeper', letter: 'D',
  parentSessionId: null, parentLineId: 'line-b', createdAt: '2026-09-10T09:00:00.000Z',
});
const TREE = [mainLine, variantA, variantB, variantC, variantD];

describe('a line’s own chain', () => {
  it('walks up to the main line, nearest first, and stops there', () => {
    expect(parentChain(TREE, 'line-d').map((each) => each.id)).toEqual(['line-b', 'line-a']);
    expect(parentChain(TREE, 'line-a')).toEqual([]);
    expect(parentChain(TREE, 'line-main')).toEqual([]);
  });

  it('answers nothing for a chain that cannot be followed', () => {
    // A parent row that was never written, and a row that points at itself. Neither
    // may hang a render: both are answered with the chain that does exist.
    expect(parentChain(TREE, 'nope')).toEqual([]);
    expect(parentChain([line({ id: 'loop', kind: 'variant', parentLineId: 'loop' })], 'loop')).toEqual([]);
    const circle = [
      line({ id: 'x', kind: 'variant', parentLineId: 'y' }),
      line({ id: 'y', kind: 'variant', parentLineId: 'x' }),
    ];
    expect(parentChain(circle, 'x').length).toBeLessThanOrEqual(circle.length);
  });

  it('knows a descendant at any depth, and never calls a line its own', () => {
    expect(isDescendantOf(TREE, 'line-d', 'line-a')).toBe(true);
    expect(isDescendantOf(TREE, 'line-b', 'line-a')).toBe(true);
    expect(isDescendantOf(TREE, 'line-a', 'line-b')).toBe(false);
    expect(isDescendantOf(TREE, 'line-c', 'line-b')).toBe(false);
    expect(isDescendantOf(TREE, 'line-a', 'line-a')).toBe(false);
    expect(isDescendantOf(TREE, null, 'line-a')).toBe(false);
  });

  it('lists every line started from one, and its own active children', () => {
    expect(descendantsOf(TREE, 'line-a').map((each) => each.id)).toEqual(['line-b', 'line-c', 'line-d']);
    expect(activeChildrenOf(TREE, 'line-a').map((each) => each.id)).toEqual(['line-b', 'line-c']);
    // A child that has been merged or dropped is not one anybody has to deal with
    // before dropping the line above it.
    const closed = [mainLine, variantA, line({ ...variantB, status: 'dropped' })];
    expect(activeChildrenOf(closed, 'line-a')).toEqual([]);
  });
});

describe('where a merge can go', () => {
  it('offers every line still being explored except itself and its own descendants', () => {
    expect(mergeTargets(TREE, variantD).map((each) => each.id))
      .toEqual(['line-main', 'line-a', 'line-b', 'line-c']);
    // B has D below it, so D is not somewhere B can go.
    expect(mergeTargets(TREE, variantB).map((each) => each.id))
      .toEqual(['line-main', 'line-a', 'line-c']);
  });

  it('selects the line it was started from, and the main line when that one is closed', () => {
    expect(defaultMergeTarget(TREE, variantD)?.id).toBe('line-b');
    const parentGone = [mainLine, variantA, line({ ...variantB, status: 'adopted' }), variantD];
    expect(defaultMergeTarget(parentGone, variantD)?.id).toBe('line-main');
    expect(defaultMergeTarget([mainLine], mainLine)).toBeNull();
  });

  it('names the target the way a sentence would', () => {
    expect(mergeTargetWord(mainLine)).toBe('the main line');
    expect(mergeTargetWord(variantA)).toBe('Variant A');
    expect(mergeTargetWord(null)).toBe('the other line');
  });
});

describe('the positions a line opens on', () => {
  it('lists its own slot first and then its ancestors’, and stops before the main line', () => {
    // The main line's positions are asset.placements and have no id in them, so the
    // walk ends at the last variant and placementsForLine falls back on its own.
    expect(placementSlotOrder(TREE, 'line-d')).toEqual(['line-d', 'line-b', 'line-a']);
    expect(placementSlotOrder(TREE, 'line-a')).toEqual(['line-a']);
    expect(placementSlotOrder(TREE, 'line-main')).toEqual([]);
    expect(placementSlotOrder(TREE, null)).toEqual([]);
    expect(placementSlotOrder(TREE, '')).toEqual([]);
  });

  it('keeps an id it cannot look up, so a line’s own slot is still honoured', () => {
    // A caller with no lines in hand — the lobby's viewer, a fixture — still gets the
    // slot it named rather than being silently moved onto the main line's positions.
    expect(placementSlotOrder([], 'line-z')).toEqual(['line-z']);
  });
});

describe('the labels batch BX added', () => {
  it('says where a variant was started from', () => {
    expect(lineOriginLabel(TREE, variantB)).toBe('from Variant A');
    expect(lineLabelWithOrigin(TREE, variantB)).toBe('Variant B · Lighter frame · from Variant A');
    // The main line came from nowhere, and a variant with no readable parent does not
    // get a guess printed for it.
    expect(lineOriginLabel(TREE, mainLine)).toBeNull();
    expect(lineOriginLabel(TREE, variantA)).toBeNull();
    expect(lineLabelWithOrigin(TREE, mainLine)).toBe('Main line');
    expect(lineLabelWithOrigin(TREE, variantA)).toBe('Variant A · Weld fix');
    expect(lineLabelWithOrigin(TREE, null)).toBeNull();
  });

  it('says where a merged line went, with the date it went there', () => {
    const merged = line({
      ...variantB, status: 'adopted', mergedIntoLineId: 'line-a', closedAt: '2026-09-26T10:00:00.000Z',
    });
    expect(mergedIntoLabel(TREE, merged)).toBe('merged into Variant A 26 Sep');
    // Not merged, no target recorded, no date: no sentence, rather than half of one.
    expect(mergedIntoLabel(TREE, variantB)).toBeNull();
    expect(mergedIntoLabel(TREE, line({ ...variantB, status: 'adopted', closedAt: '2026-09-26T10:00:00.000Z' }))).toBeNull();
    expect(mergedIntoLabel(TREE, line({ ...variantB, status: 'adopted', mergedIntoLineId: 'line-a' }))).toBeNull();
    expect(mergedIntoLabel(TREE, mainLine)).toBeNull();
  });

  it('puts that clause into the sentence a card carries', () => {
    const when = '2026-10-12T09:00:00.000Z';
    expect(adoptedCardLabel(variantB, when, 'merged into Variant A 12 Oct'))
      .toBe('Raised in Variant B · merged into Variant A 12 Oct');
    // And without it — an install whose database has no merged_into_line_id yet, or a
    // target line that has since been deleted — the older sentence, which is still true.
    expect(adoptedCardLabel(variantB, when)).toBe('Raised in Variant B · adopted 12 Oct');
  });

  it('counts only the dropped ones as hidden', () => {
    const withClosed = [
      mainLine, variantA,
      line({ ...variantB, status: 'dropped' }),
      line({ ...variantC, status: 'adopted' }),
    ];
    expect(hiddenLineCount(withClosed)).toBe(1);
    expect(hiddenLineCount([])).toBe(0);
    expect(activeLines(withClosed).map((each) => each.id)).toEqual(['line-main', 'line-a']);
  });

  it('reads a dropped line’s reason without the prefix its cards carry', () => {
    const dropped = line({
      ...variantA, status: 'dropped', dropReason: 'Dropped with Variant A: Too expensive to tool',
    });
    expect(droppedLineReason(dropped)).toBe('Too expensive to tool');
    // Stored without the prefix, it is the reason as it was typed.
    expect(droppedLineReason(line({ ...variantA, status: 'dropped', dropReason: 'Too heavy' }))).toBe('Too heavy');
    // Nothing stored, not dropped, or nothing but the prefix: no reason, and the
    // banner then says "This variant was dropped." and stops.
    expect(droppedLineReason(variantA)).toBeNull();
    expect(droppedLineReason(line({ ...variantA, status: 'dropped' }))).toBeNull();
    expect(droppedLineReason(line({ ...variantA, status: 'dropped', dropReason: 'Dropped with Variant A:' }))).toBeNull();
    expect(droppedLineReason(mainLine)).toBeNull();
  });
});

// ─── The words ──────────────────────────────────────────────────────────────

describe('the words on screen', () => {
  it('never says branch, fork or commit', () => {
    // The plan is explicit: hardware engineers are the people reading this, and the
    // programming metaphor must not show through. Every label this module can
    // produce is checked, not just the ones a test happens to build.
    //
    // "merge" came OFF this list in batch BX and is checked for separately below. The
    // user asked for a variant that could be taken into another variant and described
    // it as "merged", so it is the word on the button and in the sentence a card
    // carries afterwards — but only there, and never as a noun for the line itself.
    const banned = ['branch', 'fork', 'commit'];
    const produced = [
      lineLabel(line()), shortLineLabel(line()), cardLineLabel(line(), 3),
      lineLabel(variantA), shortLineLabel(variantA), cardLineLabel(variantA, 2),
      sessionLabel(line(), 1), sessionLabel(variantA, 1), MAIN_LINE_NAME,
      partyRoomName(REVIEW, variantA), roomPath(REVIEW, 'line-a'),
      nextVariantLetter([]), lineOriginLabel(TREE, variantB),
      lineLabelWithOrigin(TREE, variantD), mergeTargetWord(variantA),
      lineFilterLabel(variantA),
      lineStatusWord(line({ kind: 'variant', status: 'adopted' })),
      lineStatusWord(line({ kind: 'variant', status: 'dropped' })),
      droppedCardReason(variantA, 'Too expensive'),
    ];
    for (const label of produced) {
      const lowered = String(label).toLowerCase();
      for (const word of banned) {
        expect(lowered, `"${label}" says "${word}"`).not.toContain(word);
      }
    }
  });

  it('says "merged into", and only there', () => {
    const merged = line({
      ...variantB, status: 'adopted', mergedIntoLineId: 'line-a', closedAt: '2026-10-12T10:00:00.000Z',
    });
    expect(mergedIntoLabel(TREE, merged)).toMatch(/^merged into Variant A \d{1,2} \w{3}$/);
    expect(adoptedCardLabel(variantB, '2026-10-12T09:00:00.000Z', mergedIntoLabel(TREE, merged)))
      .toBe('Raised in Variant B · merged into Variant A 12 Oct');
    // A line's own label is never the merge sentence: the map, the chip and the Lines
    // list all say "Variant B", and only the record of what happened to it says more.
    expect(lineLabel(merged)).toBe('Variant B · Lighter frame');
    expect(lineFilterLabel(merged)).toBe('Variant B · Lighter frame · adopted');
  });
});
