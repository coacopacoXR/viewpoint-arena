// What a lobby card's miniature has to say about a design review.
//
// docs/plan/15-sessions-and-variants.md batch BO. The card is the first thing a
// reviewer sees of a review they have not opened in a fortnight, and the miniature is
// the whole of its answer to "how far did this get?". What is pinned here is
// therefore the four readings the sketch promises and the one thing that would make
// them all wrong:
//
//   * a stop per session, and the NEWEST one on the main line filled — not the last
//     thing drawn, which for an adopted variant is the green stop where it came back;
//   * an adopted variant drawn as a green stop on the main line, and a dropped one
//     greyed and dashed but still there, because a dropped variant is kept for the
//     record and a card that hides it hides a decision the review made;
//   * a review that has never met says so in words rather than drawing an empty box,
//     which on a card reads as a picture that failed to load;
//   * nothing it draws or says may use branch, fork, merge or commit.
//
// No mocks and no router: the component is pure, and layoutSessionMap — which it
// shares with the full map — is the real one, so a fixture that draws here draws the
// same shape there.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import MiniSessionMap from '../MiniSessionMap';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

const REVIEW = 'rev-1';
const MAIN_ID = 'line-main';
const VARIANT_ID = 'line-a';

/** The colours SessionMap draws with, which the miniature has to keep meaning. */
const INK = '#111827';
const ADOPTED = '#059669';
const DROPPED = '#d1d5db';
const VARIANT_INK = '#7c3aed';
const HOLLOW = '#ffffff';

const MAIN: ReviewLine = {
  id: MAIN_ID, reviewId: REVIEW, kind: 'main', name: '', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: '',
  createdAt: '2026-03-01T09:00:00.000Z', closedAt: null,
};

/** A variant started from the main line's second meeting, which is the usual case. */
function variant(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: VARIANT_ID, reviewId: REVIEW, kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parentSessionId: 'sess-2', parentLineId: MAIN_ID, mergedIntoLineId: null, dropReason: null,
    status: 'active', createdBy: null, createdByName: 'Rae',
    createdAt: '2026-05-04T09:00:00.000Z', closedAt: null, ...overrides,
  };
}

function session(id: string, seq: number, endedAt: string, lineId: string | null = MAIN_ID): LineSession {
  return {
    id, title: `Design review — ${id}`, endedAt, participantCount: 4, modelName: 'Bracket',
    lineId, seq, revisionIds: [], summary: null,
  };
}

const MAIN_SESSIONS: LineSession[] = [
  session('sess-1', 1, '2026-05-01T16:00:00.000Z'),
  session('sess-2', 2, '2026-05-03T16:00:00.000Z'),
  session('sess-3', 3, '2026-05-07T16:00:00.000Z'),
];

/** One meeting held on the variant, so it has a shape of its own to draw. */
const VARIANT_SESSIONS: LineSession[] = [
  session('sess-a1', 1, '2026-05-05T16:00:00.000Z', VARIANT_ID),
];

function draw(props: Partial<React.ComponentProps<typeof MiniSessionMap>> = {}) {
  return render(<MiniSessionMap lines={[MAIN]} sessions={MAIN_SESSIONS} {...props} />);
}

/** One attribute of a node, as a string, '' when it is not there. */
function attr(node: Element | null, name: string): string {
  return node?.getAttribute(name) ?? '';
}

function num(node: Element | null, name: string): number {
  return Number(attr(node, name));
}

function circleOf(stop: Element | null): Element | null {
  return stop?.querySelector('circle') ?? null;
}

/**
 * A stop's radius in CSS pixels, i.e. after `meet` has shrunk the viewBox into the
 * 34px-tall box. The height is what binds for these maps — they are far wider than they
 * are tall — so it is the scale the drawing arrives at.
 */
function radiusOnScreen(container: HTMLElement): number {
  const svg = container.querySelector('[data-testid="mini-session-map"]');
  const viewBoxHeight = Number(attr(svg, 'viewBox').split(' ')[3]);
  const scale = Number(attr(svg, 'height')) / viewBoxHeight;
  const stop = container.querySelector('[data-testid="mini-stop"]');
  return num(circleOf(stop), 'r') * scale;
}

function stops(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-testid="mini-stop"]')];
}

function rejoins(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-testid="mini-rejoin"]')];
}

afterEach(cleanup);

describe('the miniature of a review that has met three times on its main line', () => {
  it('draws one stop for every session, and nothing that came back', () => {
    const { container } = draw();

    expect(stops(container)).toHaveLength(3);
    expect(rejoins(container)).toHaveLength(0);
    // All three on the main line, and the main line is a row of its own: the stops
    // sit at three different places along it rather than on top of one another.
    const xs = stops(container).map((stop) => num(circleOf(stop), 'cx'));
    expect(new Set(xs).size).toBe(3);
    expect(stops(container).every((stop) => attr(stop, 'data-line') === 'main')).toBe(true);
  });

  it('fills exactly one stop, and it is the newest meeting on the main line', () => {
    const { container } = draw();

    const current = container.querySelectorAll('[data-current]');
    expect(current).toHaveLength(1);
    expect(attr(current[0], 'data-testid')).toBe('mini-stop');
    expect(attr(circleOf(current[0]), 'fill')).toBe(INK);

    // The newest, which on the main line is the rightmost: a filled dot on any other
    // stop would say the review is somewhere it has already been.
    const furthest = Math.max(...stops(container).map((stop) => num(circleOf(stop), 'cx')));
    expect(num(circleOf(current[0]), 'cx')).toBe(furthest);

    // And every other meeting stays hollow, which is what makes the filled one legible.
    const hollow = stops(container).filter((stop) => !stop.hasAttribute('data-current'));
    expect(hollow).toHaveLength(2);
    expect(hollow.every((stop) => attr(circleOf(stop), 'fill') === HOLLOW)).toBe(true);
  });

  it('says in words that there are no variants', () => {
    draw();

    expect(attr(screen.getByTestId('mini-session-map'), 'aria-label')).toBe('Main line, no variants');
  });
});

describe('the miniature of a review with a variant', () => {
  it('draws an adopted variant coming back to a green stop on the main line', () => {
    const lines = [MAIN, variant({ status: 'adopted', closedAt: '2026-05-08T10:00:00.000Z' })];
    const { container } = draw({ lines, sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS] });

    const rejoin = rejoins(container);
    expect(rejoin).toHaveLength(1);
    expect(attr(circleOf(rejoin[0]), 'fill')).toBe(ADOPTED);
    expect(attr(circleOf(rejoin[0]), 'stroke')).toBe(ADOPTED);
    // The green stop is on the main line: that is where the variant came back to.
    expect(attr(rejoin[0], 'data-line')).toBe('main');
    // And the meeting that was held on the variant is still on the card, hollow like
    // any other, in the variant's own colour.
    const onVariant = container.querySelector('[data-testid="mini-stop"][data-line="variant"]');
    expect(attr(circleOf(onVariant), 'fill')).toBe(HOLLOW);
    expect(attr(circleOf(onVariant), 'stroke')).toBe(VARIANT_INK);
    expect(stops(container)).toHaveLength(4);

    // Coming back does not move the review on: the filled stop is still the main
    // line's newest meeting, not the green one drawn to the right of it.
    const current = container.querySelector('[data-current]');
    expect(attr(current, 'data-testid')).toBe('mini-stop');
    expect(num(circleOf(current), 'cx')).toBeLessThan(num(circleOf(rejoin[0]), 'cx'));
  });

  it('does not draw a dropped variant, or the meeting that was held on it', () => {
    // Batch BX. A dropped variant is kept for the record and the record is the map and
    // the Lines list, both of which have a "Show dropped" toggle — this strip has room
    // for the shape of the review as it stands and nothing else, and a row of grey
    // dashes in it reads as a drawing that went wrong rather than as history. Its
    // meetings go with it: a stop with no row to sit on is a dot in mid-air.
    const lines = [MAIN, variant({ status: 'dropped', closedAt: '2026-05-06T10:00:00.000Z' })];
    const { container } = draw({ lines, sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS] });

    expect(container.querySelectorAll('[data-testid="mini-stop"][data-dropped]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="mini-stop"][data-line="variant"]')).toHaveLength(0);
    // Nothing is drawn in the dropped grey at all, so there is no half-hidden row left
    // behind for somebody to wonder about.
    expect(container.innerHTML).not.toContain(DROPPED);
    // The main line's own meetings are untouched, and so is the count in the label:
    // a card that said "Main line and 1 variant" about a review that has rejected its
    // only variant would be describing a review that no longer exists.
    expect(container.querySelectorAll('[data-testid="mini-stop"][data-line="main"]'))
      .toHaveLength(MAIN_SESSIONS.length);
    expect(attr(screen.getByTestId('mini-session-map'), 'aria-label')).toBe('Main line, no variants');
  });

  it('still draws a variant that was merged, because that is how the review got here', () => {
    // The other half of the same rule, and the reason the filter is on 'dropped' and not
    // on "finished with": a merged line is part of the answer the review settled on, and
    // the green return into the line it went to is the most informative thing this
    // miniature can say about a review that has been through a variant.
    const lines = [
      MAIN,
      variant({ status: 'adopted', closedAt: '2026-05-06T10:00:00.000Z', mergedIntoLineId: MAIN_ID }),
    ];
    const { container } = draw({ lines, sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS] });

    expect(container.querySelectorAll('[data-testid="mini-stop"][data-line="variant"]')).toHaveLength(1);
    expect(attr(screen.getByTestId('mini-session-map'), 'aria-label')).toBe('Main line and 1 variant');
  });

  it('draws a variant in its own colour, not the main line\'s', () => {
    const lines = [MAIN, variant()];
    const { container } = draw({ lines, sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS] });

    const onVariant = container.querySelector('[data-testid="mini-stop"][data-line="variant"]');
    const onMain = container.querySelector('[data-testid="mini-stop"][data-line="main"]');
    expect(attr(circleOf(onVariant), 'stroke')).toBe(VARIANT_INK);
    expect(attr(circleOf(onVariant), 'stroke')).not.toBe(attr(circleOf(onMain), 'stroke'));
    expect(attr(circleOf(onMain), 'stroke')).toBe(INK);
  });

  it('names how many variants there are, and never the programming words', () => {
    const lines = [MAIN, variant(), variant({ id: 'line-b', letter: 'B', name: 'Glued joint' })];
    const { container } = draw({ lines, sessions: MAIN_SESSIONS });

    const label = attr(screen.getByTestId('mini-session-map'), 'aria-label');
    expect(label).toBe('Main line and 2 variants');
    expect(label.toLowerCase()).not.toMatch(/branch|fork|merge|commit/);
    expect(container.innerHTML.toLowerCase()).not.toMatch(/branch|fork|merge|commit/);
  });
});

describe('a review that has not met', () => {
  it('says so in words and draws nothing, for a review with no lines at all', () => {
    draw({ lines: [], sessions: [] });

    expect(screen.getByTestId('mini-session-map-empty').textContent).toBe('No sessions yet');
    expect(screen.queryByTestId('mini-session-map')).toBeNull();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('draws the main line’s start for a review that has lines and no meetings', () => {
    // Batch BV. A review with lines has a shape before its first meeting, so the card
    // carries that shape rather than saying there is nothing to show.
    draw({ lines: [MAIN], sessions: [] });

    expect(screen.getByTestId('mini-session-map')).toBeInTheDocument();
    expect(document.querySelector('[data-marker="start"]')).not.toBeNull();
    expect(screen.queryByTestId('mini-session-map-empty')).toBeNull();
    // Nothing is filled in as "where this review has got to", because it has not got
    // anywhere yet — the start is hollow.
    expect(document.querySelector('[data-current="true"]')).toBeNull();
  });

  it('draws a session-less variant as a short coloured stub', () => {
    // The reported case: a variant started before any meeting, explored, and left with a
    // moved model in it. Its branch was already drawn, and ended in nothing.
    draw({ lines: [MAIN, variant()], sessions: [] });

    const stub = document.querySelector('[data-marker="variant-end"]');
    expect(stub).not.toBeNull();
    expect(stub?.getAttribute('data-line')).toBe('variant');
    expect(stub?.querySelector('circle')?.getAttribute('stroke')).toBe(VARIANT_INK);
    // And it is not mistaken for a meeting the main line is at.
    expect(document.querySelector('[data-current="true"]')).toBeNull();
  });
});

describe('drawing into 34px', () => {
  it('keeps the whole map in the box, and left-aligned in it', () => {
    draw();

    const svg = screen.getByTestId('mini-session-map');
    expect(attr(svg, 'height')).toBe('34');
    expect(attr(svg, 'preserveAspectRatio')).toBe('xMinYMid meet');
    expect(attr(svg, 'width')).toBe('100%');
    expect(attr(svg, 'viewBox').split(' ')).toHaveLength(4);
  });

  it('thickens every line as the map grows taller, so none of them vanish', () => {
    // `meet` scales the viewBox to 34px of height, so a stroke written in viewBox
    // units arrives at 34 / height of itself: 2 units is 0.66px on a main line alone
    // and 0.34px with one variant row under it, which is a line nobody can see. The
    // strokes are therefore written in units of that shrink, and get thicker as the
    // map gets taller.
    const plain = draw();
    const plainWidths = [...plain.container.querySelectorAll('path')].map((path) =>
      num(path, 'stroke-width'),
    );
    expect(plainWidths.length).toBeGreaterThan(0);
    expect(Math.min(...plainWidths)).toBeGreaterThan(2);

    const withVariant = draw({
      lines: [MAIN, variant()],
      sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS],
    });
    const taller = [...withVariant.container.querySelectorAll('path')].map((path) =>
      num(path, 'stroke-width'),
    );
    // Taller viewBox, smaller scale, thicker strokes: the two have to move together.
    expect(Math.min(...taller)).toBeGreaterThan(Math.max(...plainWidths));
  });

  it('draws every stop as a 4px dot on screen, however many rows the map has', () => {
    // A stop is the thing a card has to be readable by, so its radius is written
    // against the screen rather than against the viewBox: at 2 units it was a 2px speck
    // on a main line alone and under 1.5px once variant rows had shrunk the scale.
    expect(radiusOnScreen(draw().container)).toBeCloseTo(4, 6);

    const withVariant = draw({
      lines: [MAIN, variant()],
      sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS],
    });
    expect(radiusOnScreen(withVariant.container)).toBeCloseTo(4, 6);
  });
});

describe('the main line itself', () => {
  it('runs from the left edge to the meeting the review is at', () => {
    const { container } = draw();

    const line = container.querySelector('[data-testid="mini-main-line"]');
    const current = circleOf(container.querySelector('[data-current]'));
    expect(attr(line, 'd')).toBe(
      `M 0 ${num(current, 'cy')} L ${num(current, 'cx')} ${num(current, 'cy')}`,
    );
    // The main line's own ink, solid: it is the review's history and not a dropped one.
    expect(attr(line, 'stroke')).toBe(INK);
    expect(line?.hasAttribute('stroke-dasharray')).toBe(false);
  });

  it('is drawn for a review that has met once, which is the case that was a lone dot', () => {
    const { container } = draw({ sessions: [MAIN_SESSIONS[0]] });

    expect(stops(container)).toHaveLength(1);
    // layoutSessionMap only ever draws an edge BETWEEN two stops, so a review that has
    // met once arrived as a single dot in an empty box — on a card, the shape of a
    // picture that failed to load, and the commonest review there is.
    const line = container.querySelector('[data-testid="mini-main-line"]');
    expect(line).toBeTruthy();
    const dot = circleOf(container.querySelector('[data-current]'));
    expect(attr(line, 'd')).toBe(`M 0 ${num(dot, 'cy')} L ${num(dot, 'cx')} ${num(dot, 'cy')}`);
    expect(num(dot, 'cx')).toBeGreaterThan(0);
    // And the one meeting is still the filled one: the line says where the review has
    // got to, the dot says the same thing, and the two agree.
    expect(attr(dot, 'fill')).toBe(INK);
  });

  it('stops at the last meeting, and lets the layout draw on to a variant that came back', () => {
    const lines = [MAIN, variant({ status: 'adopted', closedAt: '2026-05-08T10:00:00.000Z' })];
    const { container } = draw({ lines, sessions: [...MAIN_SESSIONS, ...VARIANT_SESSIONS] });

    const line = container.querySelector('[data-testid="mini-main-line"]');
    const current = circleOf(container.querySelector('[data-current]'));
    const rejoin = circleOf(rejoins(container)[0]);

    // The ink line reaches the newest MEETING and no further. The green stop where the
    // variant came back is not a meeting, so it is joined by the layout's own green edge
    // rather than by this one — which keeps the main line a single unbroken stroke and
    // keeps the shared layout's ordering, rather than this file inventing a second one.
    expect(attr(line, 'd').endsWith(`L ${num(current, 'cx')} ${num(current, 'cy')}`)).toBe(true);
    expect(num(current, 'cx')).toBeLessThan(num(rejoin, 'cx'));
    const green = [...container.querySelectorAll('path')].filter(
      (path) => attr(path, 'stroke') === ADOPTED,
    );
    expect(green.length).toBeGreaterThan(0);
  });
});
