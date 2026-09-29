// The chip in a variant's own top bar — components/UI/room/LineChip.tsx.
//
// docs/plan/15-sessions-and-variants.md batch BL. A variant meets in a DIFFERENT room
// from the review's main line (`<reviewId>~<letter>`, its own presence, audio and
// scene), and the address that gets you there differs from the main line's by one
// query parameter. Nothing else in the room looks different — that is the point of a
// variant — so without a say-so on screen a meeting can spend an hour on a steel hinge
// pin and never notice it is not on the main line. That failure is silent, which is
// what makes it worth a test of its own.
//
// Pinned: the chip names the line in the words the app uses everywhere else, its link
// goes to the main line's address (which carries no `?line=`, so every link already in
// circulation still works), it carries the two variant decisions for somebody who may
// make them, and it renders NOTHING at all where there is no line — an ad-hoc session, or
// an install with no database. On the MAIN line it is a small "Lines" menu rather than a
// chip, which is batch BV: same list, no claim about where you are that you had not
// wondered about. The list itself is pinned in lineChipLines.test.tsx.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../../lib/reviews/linesClient', () => ({
  exploreVariant: vi.fn(),
  adoptVariant: vi.fn(),
  dropVariant: vi.fn(),
}));

vi.mock('../../../../lib/reviews/linesRepo', () => ({
  resetLineCache: () => undefined,
  // Batch BV: the panel now lists every line of the review, so the chip reads them.
  // Answering none is the case the chip has to survive anyway — an install whose lines
  // cannot be read must still offer the way back to the main line — and
  // lineChipLines.test.tsx is where the list itself is pinned.
  listLines: async () => [],
}));

import LineChip from '../LineChip';
import type { ReviewLine } from '../../../../lib/reviews/lines';

const REVIEW = 'rev-1';

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: 'line-a', reviewId: REVIEW, kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parentSessionId: 'sess-3', parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'active', createdBy: null, createdByName: 'Robin',
    createdAt: '2026-05-04T09:00:00.000Z', closedAt: null, ...overrides,
  };
}

const MAIN: ReviewLine = line({ id: 'line-main', kind: 'main', name: 'Main line', letter: null, parentSessionId: null });

function renderChip(props: Partial<React.ComponentProps<typeof LineChip>> = {}) {
  return render(
    <MemoryRouter initialEntries={[`/room/${REVIEW}?line=line-a`]}>
      <LineChip roomId={REVIEW} line={line()} mayEdit {...props} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('the chip in a variant’s room', () => {
  it('says which line this room is on, in the app’s own words', () => {
    renderChip();
    expect(screen.getByText('You are on Variant A · Steel hinge pin')).toBeTruthy();
  });

  it('links back to the main line’s room, which is the address with no ?line= in it', () => {
    renderChip();
    // In the panel the chip opens, not beside it: batch BQ2 moved it there because the
    // top bar had run out of room, and the way back is a choice you make once you know
    // you are somewhere else — which is what the chip has just told you.
    fireEvent.click(screen.getByText('You are on Variant A · Steel hinge pin'));
    const back = screen.getByTitle('Go to the main line’s room');
    expect(back.getAttribute('data-href')).toBe(`/room/${REVIEW}`);
    expect(back.textContent).toContain('Main line');
  });

  it('carries the two decisions about this variant for somebody who may make them', () => {
    renderChip();
    fireEvent.click(screen.getByText('You are on Variant A · Steel hinge pin'));
    expect(screen.getByText('Merge into…')).toBeTruthy();
    expect(screen.getByText('Drop variant')).toBeTruthy();
  });

  it('still says where you are when you may not change it, and offers nothing', () => {
    // Knowing you are on a variant is what lets somebody take part in the meeting;
    // changing the review's lines is the part that needs a role.
    renderChip({ mayEdit: false });
    expect(screen.getByText('You are on Variant A · Steel hinge pin')).toBeTruthy();
    expect(screen.queryByTitle(/Adopt it into the main line/)).toBeNull();
    expect(screen.queryByText('Merge into…')).toBeNull();
  });

  it('still lets somebody who may not change the review get back to the main line', () => {
    // The two decisions need a role; the way out does not. A participant who arrived by
    // a variant's link and has no route back to the main line is a participant editing
    // an address bar.
    renderChip({ mayEdit: false });
    fireEvent.click(screen.getByText('You are on Variant A · Steel hinge pin'));
    expect(screen.getByTitle('Go to the main line’s room').getAttribute('data-href')).toBe(`/room/${REVIEW}`);
    expect(screen.queryByText('Merge into…')).toBeNull();
  });
});

describe('the chip on every other room', () => {
  it('is a Lines menu on the main line, and not a chip naming the obvious', () => {
    // Batch BV changed this. It used to render nothing here, on the reasoning that every
    // room that existed before variants has an address with no `?line=` in it and nobody
    // standing in one has wondered which line they are on. What nobody in one HAS is a
    // route to the review's variants: the only way was out to the lobby and back in
    // again, and until this batch the lobby offered no way into a variant either. So the
    // main line gets the same list under a small menu, and still no chip saying "You are
    // on Main line" in every room that ever existed.
    renderChip({ line: MAIN });
    expect(screen.getByTestId('lines-menu-button').textContent).toBe('Lines');
    expect(screen.queryByTestId('line-chip-button')).toBeNull();
    expect(screen.queryByText(/You are on/)).toBeNull();
  });

  it('renders nothing for a room with no line — an ad-hoc session, or no database', () => {
    const { container } = renderChip({ line: null });
    expect(container.textContent).toBe('');
  });
});

describe('the words on the chip', () => {
  it('never say branch, fork, merge or commit', () => {
    const { container } = renderChip();
    fireEvent.click(screen.getByText('You are on Variant A · Steel hinge pin'));
    expect((container.textContent ?? '').toLowerCase()).not.toMatch(/branch|fork|commit/);
  });
});
