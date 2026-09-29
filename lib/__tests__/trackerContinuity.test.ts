// The continuity line a tracker card carries.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. What is pinned here is not the
// happy path — "Raised on Rev A · still open on Rev C" is one assertion — but
// every case where the data does not support a sentence and the answer has to be
// silence: a card from before this batch, a revision id that is gone, a review
// whose history was never stored, and above all a later revision of a DIFFERENT
// line, which must never be reported as a card still being open.

import { describe, it, expect } from 'vitest';
import {
  cardContinuity,
  isClosed,
  isLaterRevision,
  laterRevisionOnLine,
  revisionLabel,
  revisionOfLineAt,
  revisionRaisedOn,
  shortDate,
} from '../trackerContinuity';
import type { ModelRevision } from '../reviews/revisionsRepo';

let seq = 0;

function revision(overrides: Partial<ModelRevision> = {}): ModelRevision {
  seq += 1;
  return {
    id: `rev-${seq}`,
    reviewId: 'review-1',
    line: 'Bracket',
    revision: 'A',
    hash: `hash-${seq}`,
    fileName: 'bracket.step',
    size: 1024,
    notes: '',
    uploadedBy: null,
    uploadedByName: '',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Rev A, B and C of one line, a month apart, oldest first — as listModelRevisions answers. */
function bracketLine(): ModelRevision[] {
  return [
    revision({ id: 'rev-a', revision: 'A', line: 'Bracket', createdAt: '2026-03-01T10:00:00.000Z' }),
    revision({ id: 'rev-b', revision: 'B', line: 'Bracket', createdAt: '2026-04-01T10:00:00.000Z' }),
    revision({ id: 'rev-c', revision: 'C', line: 'Bracket', createdAt: '2026-05-01T10:00:00.000Z' }),
  ];
}

describe('trackerContinuity — isClosed', () => {
  it('agrees with the test computeStats uses', () => {
    expect(isClosed('Approved')).toBe(true);
    expect(isClosed('Rejected')).toBe(true);
    expect(isClosed('Open')).toBe(false);
    // Under review is the one a reviewer most needs to see "still open" on.
    expect(isClosed('In Review')).toBe(false);
  });
});

describe('trackerContinuity — revisionRaisedOn', () => {
  it('finds the revision a card names', () => {
    const revisions = bracketLine();
    expect(revisionRaisedOn('rev-b', revisions)?.revision).toBe('B');
  });

  it('answers null for a card that names no revision', () => {
    expect(revisionRaisedOn(null, bracketLine())).toBeNull();
    expect(revisionRaisedOn(undefined, bracketLine())).toBeNull();
    expect(revisionRaisedOn('', bracketLine())).toBeNull();
  });

  it('answers null for a revision id that is not in the review any more', () => {
    expect(revisionRaisedOn('rev-deleted', bracketLine())).toBeNull();
  });

  it('answers null when the review has no stored revisions at all', () => {
    // An install whose database predates model_revisions: listModelRevisions
    // answers [], and every card in it has to render exactly as it did before.
    expect(revisionRaisedOn('rev-a', [])).toBeNull();
  });
});

describe('trackerContinuity — revisionLabel', () => {
  it('reads the way the model tree does', () => {
    expect(revisionLabel(revision({ revision: 'A' }))).toBe('Rev A');
    expect(revisionLabel(revision({ revision: 'aa' }))).toBe('Rev AA');
  });

  it('answers null rather than "Rev " for a row with no letter', () => {
    expect(revisionLabel(revision({ revision: '  ' }))).toBeNull();
    expect(revisionLabel(null)).toBeNull();
  });
});

describe('trackerContinuity — isLaterRevision', () => {
  const raised = revision({ line: 'Bracket', revision: 'A' });

  it('orders letters the way the Excel-column arithmetic does', () => {
    expect(isLaterRevision(raised, revision({ line: 'Bracket', revision: 'B' }))).toBe(true);
    expect(isLaterRevision(raised, revision({ line: 'Bracket', revision: 'A' }))).toBe(false);
    // A longer run of letters is later, which is what carries Z into AA.
    expect(isLaterRevision(revision({ line: 'Bracket', revision: 'Z' }), revision({ line: 'Bracket', revision: 'AA' }))).toBe(true);
    expect(isLaterRevision(revision({ line: 'Bracket', revision: 'AA' }), revision({ line: 'Bracket', revision: 'Z' }))).toBe(false);
    expect(isLaterRevision(revision({ line: 'Bracket', revision: 'AZ' }), revision({ line: 'Bracket', revision: 'BA' }))).toBe(true);
  });

  it('is case- and space-insensitive, because the letter is free text in a row', () => {
    expect(isLaterRevision(raised, revision({ line: 'Bracket', revision: ' b ' }))).toBe(true);
  });

  it('never counts a later revision of another line', () => {
    expect(isLaterRevision(raised, revision({ line: 'Mating part', revision: 'C' }))).toBe(false);
  });

  it('refuses to order a revision with no letter', () => {
    expect(isLaterRevision(revision({ revision: '' }), revision({ revision: 'B' }))).toBe(false);
    expect(isLaterRevision(raised, revision({ revision: '' }))).toBe(false);
  });
});

describe('trackerContinuity — laterRevisionOnLine', () => {
  it('answers the newest revision of the same line', () => {
    const revisions = bracketLine();
    const raised = revisions[0];
    expect(laterRevisionOnLine(raised, revisions)?.id).toBe('rev-c');
  });

  it('answers null for the revision that is already the newest', () => {
    const revisions = bracketLine();
    expect(laterRevisionOnLine(revisions[2], revisions)).toBeNull();
  });

  it('ignores a later revision of a different line', () => {
    const revisions = [
      ...bracketLine(),
      revision({ id: 'mate-a', line: 'Mating part', revision: 'A', createdAt: '2026-03-02T10:00:00.000Z' }),
      revision({ id: 'mate-z', line: 'Mating part', revision: 'Z', createdAt: '2026-06-01T10:00:00.000Z' }),
    ];
    // The bracket has not moved since Rev C; the mating part going to Rev Z says
    // nothing about whether a risk on the bracket is still open.
    expect(laterRevisionOnLine(revisions[2], revisions)).toBeNull();
    expect(laterRevisionOnLine(revisions[0], revisions)?.id).toBe('rev-c');
  });

  it('answers null for a card raised on no revision, and for an empty history', () => {
    expect(laterRevisionOnLine(null, bracketLine())).toBeNull();
    expect(laterRevisionOnLine(revision(), [])).toBeNull();
  });
});

describe('trackerContinuity — revisionOfLineAt', () => {
  const revisions = bracketLine();

  it('answers the newest revision that already existed at that moment', () => {
    expect(revisionOfLineAt('Bracket', '2026-03-15T09:00:00.000Z', revisions)?.id).toBe('rev-a');
    expect(revisionOfLineAt('Bracket', '2026-04-30T09:00:00.000Z', revisions)?.id).toBe('rev-b');
    expect(revisionOfLineAt('Bracket', '2026-09-01T09:00:00.000Z', revisions)?.id).toBe('rev-c');
  });

  it('counts a revision uploaded in the same instant as existing', () => {
    expect(revisionOfLineAt('Bracket', '2026-04-01T10:00:00.000Z', revisions)?.id).toBe('rev-b');
  });

  it('answers null before the line had any revision, and for another line', () => {
    expect(revisionOfLineAt('Bracket', '2026-02-01T09:00:00.000Z', revisions)).toBeNull();
    expect(revisionOfLineAt('Mating part', '2026-09-01T09:00:00.000Z', revisions)).toBeNull();
  });

  it('answers null for a timestamp it cannot read', () => {
    expect(revisionOfLineAt('Bracket', 'not a date', revisions)).toBeNull();
    expect(revisionOfLineAt('Bracket', '', revisions)).toBeNull();
  });

  it('does not depend on the order it was handed the revisions in', () => {
    expect(revisionOfLineAt('Bracket', '2026-04-30T09:00:00.000Z', [...revisions].reverse())?.id).toBe('rev-b');
  });

  it('answers null for an empty history', () => {
    expect(revisionOfLineAt('Bracket', '2026-09-01T09:00:00.000Z', [])).toBeNull();
  });
});

describe('trackerContinuity — shortDate', () => {
  it('reads the way the tracker reads a date, in UTC', () => {
    expect(shortDate('2026-03-12T23:40:00.000Z')).toBe('12 Mar');
    expect(shortDate('2026-01-01T00:00:00.000Z')).toBe('1 Jan');
  });

  it('answers null for a timestamp it cannot read', () => {
    expect(shortDate('nope')).toBeNull();
  });
});

describe('trackerContinuity — cardContinuity', () => {
  const revisions = bracketLine();

  it('says a card raised on Rev A is still open on Rev C', () => {
    expect(
      cardContinuity({ status: 'Open', raisedOnRevision: 'rev-a' }, revisions),
    ).toBe('Raised on Rev A · still open on Rev C');
  });

  it('says the same for a card under review, which is not closed', () => {
    expect(
      cardContinuity({ status: 'In Review', raisedOnRevision: 'rev-a' }, revisions),
    ).toBe('Raised on Rev A · still open on Rev C');
  });

  it('names only the revision it was raised on while that is the newest', () => {
    expect(
      cardContinuity({ status: 'Open', raisedOnRevision: 'rev-c' }, revisions),
    ).toBe('Raised on Rev C');
    expect(
      cardContinuity({ status: 'Open', raisedOnRevision: 'rev-b' }, revisions),
    ).toBe('Raised on Rev B · still open on Rev C');
  });

  it('does not claim a card is still open because another line moved', () => {
    const twoLines = [
      ...revisions,
      revision({ id: 'mate-a', line: 'Mating part', revision: 'A', createdAt: '2026-03-02T10:00:00.000Z' }),
      revision({ id: 'mate-b', line: 'Mating part', revision: 'B', createdAt: '2026-06-01T10:00:00.000Z' }),
    ];
    expect(
      cardContinuity({ status: 'Open', raisedOnRevision: 'rev-c' }, twoLines),
    ).toBe('Raised on Rev C');
  });

  it('says nothing at all for a card that names no revision', () => {
    // Every card recorded before this batch, and every card from an ad-hoc room.
    expect(cardContinuity({ status: 'Open', raisedOnRevision: null }, revisions)).toBeNull();
    expect(cardContinuity({ status: 'Open', raisedOnRevision: undefined }, revisions)).toBeNull();
    expect(cardContinuity({ status: 'Approved', raisedOnRevision: null, closedAt: '2026-05-02T10:00:00.000Z' }, revisions)).toBeNull();
  });

  it('says nothing for a revision id that is not in the review', () => {
    expect(cardContinuity({ status: 'Open', raisedOnRevision: 'rev-gone' }, revisions)).toBeNull();
  });

  it('says nothing when the review has no stored revisions', () => {
    expect(cardContinuity({ status: 'Open', raisedOnRevision: 'rev-a' }, [])).toBeNull();
  });

  it('says nothing for a revision stored without a letter', () => {
    const letterless = [revision({ id: 'rev-x', revision: '', line: 'Bracket' })];
    expect(cardContinuity({ status: 'Open', raisedOnRevision: 'rev-x' }, letterless)).toBeNull();
  });

  describe('a closed card', () => {
    it('names the revision it was closed in and the day, from the history timestamp', () => {
      expect(
        cardContinuity(
          { status: 'Approved', raisedOnRevision: 'rev-a', closedAt: '2026-04-12T16:20:00.000Z' },
          revisions,
        ),
      ).toBe('Raised on Rev A · Closed on Rev B · 12 Apr');
    });

    it('does not repeat the revision when it was closed on the one it was raised on', () => {
      expect(
        cardContinuity(
          { status: 'Rejected', raisedOnRevision: 'rev-a', closedAt: '2026-03-20T09:00:00.000Z' },
          revisions,
        ),
      ).toBe('Raised on Rev A · Closed 20 Mar');
    });

    it('falls back to the date when no revision of that line predates the close', () => {
      expect(
        cardContinuity(
          { status: 'Approved', raisedOnRevision: 'rev-a', closedAt: '2026-02-01T09:00:00.000Z' },
          revisions,
        ),
      ).toBe('Raised on Rev A · Closed 1 Feb');
    });

    it('says only what it was raised on when the history has no close to read', () => {
      expect(
        cardContinuity({ status: 'Approved', raisedOnRevision: 'rev-b' }, revisions),
      ).toBe('Raised on Rev B');
      expect(
        cardContinuity({ status: 'Approved', raisedOnRevision: 'rev-b', closedAt: null }, revisions),
      ).toBe('Raised on Rev B');
    });

    it('never says "still open" about a closed card, however far the line has moved', () => {
      const line = cardContinuity({ status: 'Approved', raisedOnRevision: 'rev-a' }, revisions);
      expect(line).not.toMatch(/still open/);
    });
  });
});
