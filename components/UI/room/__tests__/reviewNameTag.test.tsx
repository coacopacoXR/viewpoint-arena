// The name in the room's top-left corner: which design review this room is holding.
//
// docs/plan/15-sessions-and-variants.md batch BQ. Naming a review is only half of the
// user's complaint — a name nobody can see during the meeting is a name that exists in
// a database. So what is pinned here is the three things the corner has to get right:
//
//   * the name is shown to EVERYBODY in the room, not only to whoever may edit it —
//     the tag takes no permission prop at all, which is the point
//   * a VARIANT's room says which review the variant belongs to, because LineChip's
//     "Variant A · Steel hinge pin" cannot: two reviews can each have a Variant A
//   * a room holding no review at all shows nothing, rather than an empty chip or the
//     word "null" in a corner

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ReviewNameTag from '../ReviewNameTag';
import type { ReviewLine } from '../../../../lib/reviews/lines';

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: 'r1', kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-09-20T09:00:00.000Z', closedAt: null,
};

const VARIANT: ReviewLine = {
  ...MAIN, id: 'line-a', kind: 'variant', name: 'Steel hinge pin', letter: 'A',
  parentSessionId: 's1', parentLineId: 'line-main',
};

afterEach(cleanup);

describe('the room\'s review name', () => {
  it('shows the review\'s name, and the whole of it in a title attribute', () => {
    render(<ReviewNameTag title="Door hinge, rev C" />);

    const tag = screen.getByTestId('review-name-tag');
    expect(tag).toHaveTextContent('Door hinge, rev C');
    // Truncated on screen, whole in the tooltip: the left column is 300px wide and a
    // name is written by a person in a hurry.
    expect(tag).toHaveAttribute('title', 'Door hinge, rev C');
  });

  it('says which review a variant\'s room belongs to, beside the variant', () => {
    render(<ReviewNameTag title="Door hinge, rev C" line={VARIANT} />);

    expect(screen.getByTestId('review-name-tag')).toHaveTextContent('Door hinge, rev C · Variant A');
    // The variant's OWN name is not repeated here — LineChip, on the same bar, carries
    // it along with its Adopt / Drop decisions, and saying it twice would push the
    // review's name out of the corner it is in.
    expect(screen.getByTestId('review-name-tag').textContent).not.toContain('Steel hinge pin');
  });

  it('does not label the main line\'s room as a line at all', () => {
    render(<ReviewNameTag title="Door hinge, rev C" line={MAIN} />);

    // "Main line" is a word the map needs, where lines are distinguished; in a corner
    // that says which review this is, it is noise.
    expect(screen.getByTestId('review-name-tag')).toHaveTextContent('Door hinge, rev C');
    expect(screen.getByTestId('review-name-tag').textContent).not.toContain('Main line');
  });

  it('shows nothing for a room holding no review, and nothing for a review with no name', () => {
    const { unmount } = render(<ReviewNameTag title={null} />);
    expect(screen.queryByTestId('review-name-tag')).toBeNull();
    unmount();

    // A row whose title is empty or only spaces is a review nobody named; an empty chip
    // in the corner would look like a rendering bug rather than like a missing name.
    render(<ReviewNameTag title="   " />);
    expect(screen.queryByTestId('review-name-tag')).toBeNull();
  });
});
