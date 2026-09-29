// The session map as a diagram inside somebody else's panel.
//
// docs/plan/15-sessions-and-variants.md batch BP. Found in live testing of the new
// lobby: the preview panel embeds this map, and embedded it repeated the panel's own
// header — "DESIGN REVIEW", the same title, the same session count — three lines under a
// header that had just said all of it, in a bordered white card inside the panel's own
// bordered white card. `compact` drops the heading and the chrome and keeps the key.
//
// What is pinned here is BOTH halves of that: what compact removes, and that nothing
// else was removed with it — the drawing, the stops and their panel, and the row labels
// down the left edge all still arrive. And that the default is unchanged, because the
// room and the tracker both mount this map as the whole of a surface and both need the
// heading and the card that compact takes away.
//
// No mocks and no database: the map reads nothing and is given everything.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import SessionMap from '../SessionMap';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

const REVIEW = 'rev-1';
const MAIN_ID = 'line-main';
const TITLE = 'Landing gear review';

const MAIN: ReviewLine = {
  id: MAIN_ID, reviewId: REVIEW, kind: 'main', name: '', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'active', createdBy: null, createdByName: '',
  createdAt: '2026-03-01T09:00:00.000Z', closedAt: null,
};

function session(id: string, seq: number, endedAt: string): LineSession {
  return {
    id, title: `Design review — ${id}`, endedAt, participantCount: 4, modelName: 'Bracket',
    lineId: MAIN_ID, seq, revisionIds: [], summary: null,
  };
}

const SESSIONS: LineSession[] = [
  session('sess-1', 1, '2026-05-01T16:00:00.000Z'),
  session('sess-2', 2, '2026-05-03T16:00:00.000Z'),
  session('sess-3', 3, '2026-05-07T16:00:00.000Z'),
];

function draw(props: Partial<React.ComponentProps<typeof SessionMap>> = {}) {
  return render(
    <MemoryRouter>
      <SessionMap reviewTitle={TITLE} lines={[MAIN]} sessions={SESSIONS} {...props} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('compact', () => {
  it('drops the heading the panel it sits in has already drawn', () => {
    draw({ compact: true });

    expect(screen.queryByTestId('session-map-heading')).toBeNull();
    expect(screen.queryByText('Design review')).toBeNull();
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.queryByText('3 sessions')).toBeNull();
  });

  it('keeps the key, small and out of the way above the drawing', () => {
    draw({ compact: true });

    const legend = screen.getByTestId('session-map-legend');
    // The two end states a line can be in are the only part of the drawing that does not
    // label itself, so they are the one part of the heading worth keeping.
    expect(legend.textContent).toContain('Adopted');
    expect(legend.textContent).toContain('Dropped');
    // Shown at every width rather than from the `sm` breakpoint up, which measures the
    // window and not the panel this map is inside.
    expect(legend.className).not.toMatch(/hidden/);
    expect(legend.className).toMatch(/justify-end/);
  });

  it('keeps the drawing, its stops and its row labels', () => {
    draw({ compact: true });

    expect(screen.getAllByTestId('session-stop')).toHaveLength(3);
    expect(screen.getByLabelText("Map of this design review's sessions")).toBeTruthy();
    expect(screen.getByText('Main line')).toBeTruthy();
  });

  it('drops the card chrome, because the panel it is embedded in is the card', () => {
    const { container } = draw({ compact: true });
    const root = container.firstElementChild;

    expect(root?.className).not.toMatch(/rounded-lg/);
    expect(root?.className).not.toMatch(/shadow-xl/);
    expect(root?.className).not.toMatch(/border-gray-200/);
    expect(root?.className).toMatch(/bg-white/);
  });

  it('still opens a stop, and still offers what its caller asked for', () => {
    // Compact is about chrome and not about what the map can do: a stop still opens its
    // panel, and a delete the caller allowed is still offered inside it. The preview
    // panel embeds this map with mayDelete={false} and provides both deletes itself,
    // inline, because window.confirm cannot be styled to a panel that is not this one.
    draw({ compact: true, reviewId: REVIEW, mayDelete: true });

    fireEvent.click(screen.getAllByTestId('session-stop')[0]);

    expect(screen.getByText('Attended')).toBeTruthy();
    expect(screen.getByText('On screen')).toBeTruthy();
    expect(screen.getByText('Delete session')).toBeTruthy();
  });
});

describe('the default, which the room and the tracker both mount', () => {
  it('keeps the heading and the card', () => {
    const { container } = draw();

    expect(screen.getByTestId('session-map-heading')).toBeTruthy();
    expect(screen.getByText('Design review')).toBeTruthy();
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.getByText('3 sessions')).toBeTruthy();
    expect(screen.queryByTestId('session-map-legend')).toBeNull();

    const root = container.firstElementChild;
    expect(root?.className).toMatch(/rounded-lg/);
    expect(root?.className).toMatch(/shadow-xl/);
    expect(root?.className).toMatch(/border-gray-200/);
  });

  it('draws the same map in both modes', () => {
    draw();
    const fullStops = screen.getAllByTestId('session-stop').length;
    cleanup();

    draw({ compact: true });
    expect(screen.getAllByTestId('session-stop')).toHaveLength(fullStops);
  });
});
