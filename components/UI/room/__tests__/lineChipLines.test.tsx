// The room's way between its review's lines — batch BV.
//
// A variant that has never met had no session to click on the map, so the only route
// between two lines of one design review was out to the lobby and in again — and the
// lobby, until this batch, offered no way into a variant either. So the chip in a
// variant's top bar now lists every line still being explored, each one a link, and the
// main line gets the same list under a small "Lines" menu.
//
// `listLines` is mocked: this file is about what the control draws and where its links
// go, and lib/reviews/linesRepo has its own coverage.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReviewLine } from '../../../../lib/reviews/lines';

const { repo } = vi.hoisted(() => ({
  repo: { lines: [] as unknown[], listLines: vi.fn() },
}));

vi.mock('../../../../lib/reviews/linesRepo', () => ({
  listLines: (...args: unknown[]) => repo.listLines(...args),
}));

// VariantActions asks the api to adopt and drop; nothing here presses either.
vi.mock('../../../review/VariantActions', () => ({
  VariantActions: () => <div data-testid="variant-actions" />,
  ExploreVariantButton: () => null,
}));

const LineChip = (await import('../LineChip')).default;

const REVIEW = 'review-1';

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: REVIEW, kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-09-01T09:00:00.000Z', closedAt: null,
};

function variant(id: string, letter: string, name: string, over: Partial<ReviewLine> = {}): ReviewLine {
  return {
    ...MAIN, id, kind: 'variant', letter, name, parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
    createdAt: `2026-09-2${letter === 'A' ? '1' : '2'}T09:00:00.000Z`, ...over,
  };
}

const A = variant('line-a', 'A', 'Frame forward');
const B = variant('line-b', 'B', 'Steel hinge pin');
const DROPPED = variant('line-c', 'C', 'Old idea', { status: 'dropped', closedAt: '2026-09-24T09:00:00.000Z' });

function renderChip(props: Partial<React.ComponentProps<typeof LineChip>> = {}) {
  return render(
    <MemoryRouter>
      <LineChip roomId={REVIEW} line={A} mayEdit={false} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  repo.lines = [MAIN, A, B, DROPPED];
  repo.listLines.mockReset().mockImplementation(async () => repo.lines);
});

afterEach(cleanup);

describe('LineChip — in a variant’s room', () => {
  it('still names the line, and still says you are on it', () => {
    renderChip();
    expect(screen.getByTestId('line-chip-button').textContent).toContain('You are on Variant A · Frame forward');
  });

  it('lists every line still being explored, each with the room it opens', async () => {
    renderChip();
    fireEvent.click(screen.getByTestId('line-chip-button'));

    await waitFor(() => expect(screen.getByTestId('line-chip-lines')).toBeTruthy());
    const links = screen
      .getAllByTitle(/Go to .*’s room/)
      .map((link) => link.getAttribute('data-href'));
    // The main line first, with no ?line= — the address every link already in
    // circulation carries — then the variants in the order they were started.
    expect(links).toEqual([`/room/${REVIEW}`, `/room/${REVIEW}?line=line-b`]);
  });

  it('names the line this room is on rather than linking to it', async () => {
    renderChip();
    fireEvent.click(screen.getByTestId('line-chip-button'));

    await waitFor(() => expect(screen.getByTestId('line-chip-here')).toBeTruthy());
    expect(screen.getByTestId('line-chip-here').textContent).toContain('Variant A · Frame forward');
    expect(screen.getByTestId('line-chip-here').textContent).toContain('here');
  });

  it('leaves a line that is finished with off the list', async () => {
    renderChip();
    fireEvent.click(screen.getByTestId('line-chip-button'));

    await waitFor(() => expect(screen.getByTestId('line-chip-lines')).toBeTruthy());
    expect(screen.getByTestId('line-chip-lines').textContent).not.toContain('Old idea');
  });

  it('still offers the way back when the review’s lines cannot be read', () => {
    // The one promise this chip was written for, and it must not depend on a read that
    // can fail: without it the only exit from a variant is the address bar.
    repo.lines = [];
    renderChip();
    fireEvent.click(screen.getByTestId('line-chip-button'));

    expect(screen.getByTestId('line-chip-lines').textContent).toContain('Main line');
    expect(screen.getAllByTitle('Go to the main line’s room')[0].getAttribute('data-href')).toBe(`/room/${REVIEW}`);
  });

  it('carries the two decisions for whoever may change the review’s lines', () => {
    renderChip({ mayEdit: true });
    fireEvent.click(screen.getByTestId('line-chip-button'));
    expect(screen.getByTestId('variant-actions')).toBeTruthy();
  });
});

describe('LineChip — on the main line', () => {
  it('is a small Lines menu, and not a chip naming the obvious', () => {
    renderChip({ line: MAIN });
    expect(screen.getByTestId('lines-menu-button').textContent).toBe('Lines');
    expect(screen.queryByTestId('line-chip-button')).toBeNull();
    expect(screen.queryByText(/You are on/)).toBeNull();
  });

  it('lists the variants, so getting to one never needs the lobby', async () => {
    renderChip({ line: MAIN });
    fireEvent.click(screen.getByTestId('lines-menu-button'));

    await waitFor(() => expect(screen.getAllByTitle(/Go to .*’s room/).length).toBeGreaterThan(0));
    const links = screen.getAllByTitle(/Go to .*’s room/).map((link) => link.getAttribute('data-href'));
    expect(links).toEqual([`/room/${REVIEW}?line=line-a`, `/room/${REVIEW}?line=line-b`]);
    // And the line this room is on is the main one, named rather than linked.
    expect(screen.getByTestId('line-chip-here').textContent).toContain('Main line');
  });

  it('offers no decisions, because there is nothing to adopt into itself', () => {
    renderChip({ line: MAIN, mayEdit: true });
    fireEvent.click(screen.getByTestId('lines-menu-button'));
    expect(screen.queryByTestId('variant-actions')).toBeNull();
  });
});

describe('LineChip — where there is no line', () => {
  it('renders nothing for an ad-hoc room and an install with no database', () => {
    const { container } = renderChip({ line: null });
    expect(container.querySelector('[data-testid="line-chip"]')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
