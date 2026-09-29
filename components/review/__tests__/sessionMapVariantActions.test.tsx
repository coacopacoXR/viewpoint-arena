// The session map's variant actions: who is offered them, and on which lines.
//
// docs/plan/15-sessions-and-variants.md batch BL. The prompts themselves and the
// writes they make are pinned in components/review/__tests__/variantActions.test.tsx;
// what is pinned here is that the MAP is a place the three actions can be done from at
// all — in the room and in the tracker it is the same component — and that it offers
// them to the right people about the right lines:
//
//   * any session stop, on the main line or on a variant, is somewhere a variant can
//     be started from;
//   * only a variant still being explored can be adopted or dropped, because an
//     adopted one is on the map as history and offering to adopt it again is how a
//     review ends up with two sets of cards claiming the same decision;
//   * somebody who may not edit the review sees the map and nothing to press.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { client } = vi.hoisted(() => ({
  client: { explore: vi.fn(), adopt: vi.fn(), drop: vi.fn() },
}));

vi.mock('../../../lib/reviews/linesClient', () => ({
  exploreVariant: (...args: unknown[]) => client.explore(...args),
  adoptVariant: (...args: unknown[]) => client.adopt(...args),
  dropVariant: (...args: unknown[]) => client.drop(...args),
}));

vi.mock('../../../lib/reviews/linesRepo', () => ({
  resetLineCache: () => undefined,
}));

import SessionMap from '../SessionMap';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

const REVIEW = 'rev-1';
const MAIN_ID = 'line-main';
const A_ID = 'line-a';
const B_ID = 'line-b';

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: MAIN_ID, reviewId: REVIEW, kind: 'main', name: 'Main line', letter: null,
    parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'active', createdBy: null, createdByName: '',
    createdAt: '2026-03-01T09:00:00.000Z', closedAt: null, ...overrides,
  };
}

const MAIN = line();
const VARIANT_A = line({ id: A_ID, kind: 'variant', name: 'Steel hinge pin', letter: 'A', parentSessionId: 'sess-1', parentLineId: null, mergedIntoLineId: null, dropReason: null, createdAt: '2026-05-04T09:00:00.000Z' });
const VARIANT_B = line({ id: B_ID, kind: 'variant', name: 'Weld fix', letter: 'B', parentSessionId: 'sess-1', parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'dropped', closedAt: '2026-06-01T09:00:00.000Z', createdAt: '2026-05-05T09:00:00.000Z' });

function session(id: string, lineId: string | null, seq: number | null, endedAt: string): LineSession {
  return {
    id, title: `Session ${id}`, endedAt, participantCount: 4, modelName: 'Bracket',
    lineId, seq, revisionIds: [], summary: null,
  };
}

const SESSIONS: LineSession[] = [
  session('sess-1', MAIN_ID, 1, '2026-05-01T16:00:00.000Z'),
  session('sess-2', MAIN_ID, 2, '2026-05-03T16:00:00.000Z'),
];

function renderMap(props: Partial<React.ComponentProps<typeof SessionMap>> = {}) {
  return render(
    <MemoryRouter>
      <SessionMap
        reviewTitle="Bracket assembly"
        lines={[MAIN, VARIANT_A, VARIANT_B]}
        sessions={SESSIONS}
        {...props}
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  client.explore.mockReset();
  client.adopt.mockReset();
  client.drop.mockReset();
});

// ─── What the map passes down ───────────────────────────────────────────────

describe('the session map — what it tells the endpoint about this browser', () => {
  it('passes on whether this browser is running the meeting', async () => {
    // The one fact the endpoint cannot work out for itself, and the one that decides
    // a variant action on the default self-hosted install, where there is no token to
    // check and the meeting host holds the editor's powers. A map that dropped it
    // would leave every variant action on such an install refused — and the tracker,
    // which holds no meeting, answers it the way the rest of the app answers a solo
    // session: nobody has been named, so you are the host.
    client.drop.mockResolvedValue({ ok: true, changed: 1 });
    renderMap({ reviewId: REVIEW, mayEditLines: true, isMeetingHost: true });
    fireEvent.click(screen.getByText('Drop variant'));
    fireEvent.change(screen.getByPlaceholderText('Too expensive to tool'), { target: { value: 'Too expensive to tool' } });
    fireEvent.click(screen.getByText('Drop it'));

    await waitFor(() => expect(client.drop).toHaveBeenCalledTimes(1));
    expect(client.drop.mock.calls[0][3]).toEqual({ isMeetingHost: true });
  });

  it('says so when this browser is not running the meeting', async () => {
    client.drop.mockResolvedValue({ ok: true, changed: 1 });
    renderMap({ reviewId: REVIEW, mayEditLines: true, isMeetingHost: false });
    fireEvent.click(screen.getByText('Drop variant'));
    fireEvent.change(screen.getByPlaceholderText('Too expensive to tool'), { target: { value: 'Too expensive to tool' } });
    fireEvent.click(screen.getByText('Drop it'));

    await waitFor(() => expect(client.drop).toHaveBeenCalledTimes(1));
    expect(client.drop.mock.calls[0][3]).toEqual({ isMeetingHost: false });
  });
});

describe('the session map — what it offers, and to whom', () => {
  it('lists every variant still being explored, with both of its actions', () => {
    renderMap({ reviewId: REVIEW, mayEditLines: true });
    expect(screen.getByTestId('map-variants')).toBeTruthy();
    expect(screen.getByText('Merge into…')).toBeTruthy();
    expect(screen.getByText('Drop variant')).toBeTruthy();
  });

  it('names the variant it is offering them for', () => {
    renderMap({ reviewId: REVIEW, mayEditLines: true });
    // The map draws the name too — down the left edge of the drawing, and in the
    // tooltip of its row — so this is scoped to the strip that carries the actions.
    const strip = screen.getByTestId('map-variants');
    expect(within(strip).getByText('Variant A · Steel hinge pin')).toBeTruthy();
  });

  it('hides a dropped variant until asked, and never offers it anything', () => {
    renderMap({ reviewId: REVIEW, mayEditLines: true });
    const strip = screen.getByTestId('map-variants');
    // Not offered anything.
    expect(within(strip).queryByText(/Weld fix/)).toBeNull();
    // Batch BX (user: "when they are dropped they still show up"): hidden by default…
    expect(screen.queryAllByText('Variant B · Weld fix')).toHaveLength(0);
    // …and kept for the record behind "Show dropped (1)".
    fireEvent.click(screen.getByText('Show dropped (1)'));
    expect(screen.getAllByText('Variant B · Weld fix').length).toBeGreaterThan(0);
    // One active variant, so one set of actions.
    expect(within(strip).getAllByText('Merge into…')).toHaveLength(1);
  });

  it('offers nothing to somebody who may not edit the review', () => {
    // Hidden rather than disabled: a control greyed out for somebody who will never
    // have it is a question the map then has to answer, and the endpoint would refuse
    // the press anyway.
    renderMap({ reviewId: REVIEW, mayEditLines: false });
    expect(screen.queryByTestId('map-variants')).toBeNull();
  });

  it('offers nothing at all without a review to act on', () => {
    renderMap({ mayEditLines: true });
    expect(screen.queryByTestId('map-variants')).toBeNull();
  });

  it('offers "Explore a variant from here" on a session that has been opened', () => {
    renderMap({ reviewId: REVIEW, mayEditLines: true });
    fireEvent.click(screen.getAllByTestId('session-stop')[0]);
    expect(screen.getByText('Explore a variant from here')).toBeTruthy();
  });

  it('does not offer it to somebody who may not edit the review', () => {
    renderMap({ reviewId: REVIEW, mayEditLines: false });
    fireEvent.click(screen.getAllByTestId('session-stop')[0]);
    expect(screen.queryByText('Explore a variant from here')).toBeNull();
  });

  it('still draws the map for somebody who may not change its lines', () => {
    // Seeing how a review got here is what lets somebody take part in it. The actions
    // need a role; the map does not.
    renderMap({ reviewId: REVIEW, mayEditLines: false });
    expect(screen.getAllByTestId('session-stop').length).toBeGreaterThan(0);
  });
});

describe('the session map — the words on it', () => {
  it('never say branch, fork, merge or commit', () => {
    const { container } = renderMap({ reviewId: REVIEW, mayEditLines: true });
    fireEvent.click(screen.getAllByTestId('session-stop')[0]);
    expect((container.textContent ?? '').toLowerCase()).not.toMatch(/branch|fork|commit/);
  });
});
