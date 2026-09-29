// Tests for components/UI/CarriedOverCards.tsx — the cards a session starts with
// (docs/plan/15-sessions-and-variants.md batch BK).
//
// Three things are worth pinning, and the third is the one that would be expensive
// to get wrong in production:
//
//   1. the group is read from the LINE, so a meeting picks up what its own run of
//      meetings left open and nothing from a variant's;
//   2. it renders nothing at all when there is nothing carried over, which is every
//      first meeting, every ad-hoc room and every install with no database — so the
//      Capture panel looks exactly as it did before this batch;
//   3. a carried card never enters the room's own deck, so the flush at meeting end
//      cannot re-save it. One risk raised in S2 and still open in S4 is one tracker
//      row with one history, not three copies of itself.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { CarriedOverItem } from '../../../lib/reviews/linesRepo';

const { db } = vi.hoisted(() => ({
  db: {
    items: [] as CarriedOverItem[],
    /** What a status change wrote, in order. */
    updates: [] as Array<{ id: string; updates: Record<string, unknown>; by: string }>,
    /** Set to make the write fail, so the panel has to put the value back. */
    refuse: false,
    /** Every line the group asked for, to prove it asks by line and not by review. */
    askedFor: [] as Array<string | null>,
  },
}));

vi.mock('../../../lib/reviews/linesRepo', () => ({
  // The group asks `listCarriedOver`, not `listOpenLineItems`: for a variant that has
  // never met the answer is the parent line's still-open cards, and that difference
  // is pinned in lib/reviews/__tests__/carriedOverOrigin.test.ts.
  listCarriedOver: (line: { id: string } | null) => {
    db.askedFor.push(line?.id ?? null);
    return Promise.resolve(db.items);
  },
  updateLineItem: (id: string, updates: Record<string, unknown>, by: string) => {
    if (db.refuse) return Promise.resolve(false);
    db.updates.push({ id, updates, by });
    // What the real one does to the row: a closed card is closed.
    if (updates['status'] === 'Approved' || updates['status'] === 'Rejected') {
      db.items = db.items.filter((item) => item.id !== id);
    } else {
      db.items = db.items.map((item) => (item.id === id ? { ...item, ...updates } : item));
    }
    return Promise.resolve(true);
  },
}));

import CarriedOverCards from '../CarriedOverCards';
import { useStore } from '../../../store';

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: 'review-1', kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: '',
  createdAt: '2026-03-01T09:00:00.000Z', closedAt: null,
};

const VARIANT_A: ReviewLine = {
  id: 'line-a', reviewId: 'review-1', kind: 'variant', name: 'Weld fix', letter: 'A',
  parentSessionId: 'sess-2', parentLineId: 'line-main', mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-05-04T09:00:00.000Z', closedAt: null,
};

function item(overrides: Partial<CarriedOverItem> = {}): CarriedOverItem {
  return {
    id: 'item-1',
    type: 'RISK',
    title: 'Hinge pin wears',
    description: 'Play develops after 4,000 cycles.',
    priority: 'High',
    status: 'Open',
    assignee: 'Ana',
    fromSessionId: 'sess-2',
    fromSeq: 2,
    createdAt: '2026-03-02T10:00:00.000Z',
    ...overrides,
  };
}

function renderGroup(props: Partial<React.ComponentProps<typeof CarriedOverCards>> = {}) {
  return render(
    <MemoryRouter>
      <CarriedOverCards line={MAIN} mayEdit changedBy="Robin" {...props} />
    </MemoryRouter>,
  );
}

/** Open the group, then one card inside it. */
function openCard(title = 'Hinge pin wears') {
  fireEvent.click(screen.getByText('Carried over'));
  fireEvent.click(screen.getByText(title));
}

beforeEach(() => {
  db.items = [];
  db.updates = [];
  db.refuse = false;
  db.askedFor = [];
  useStore.setState({ insightCards: [] });
});

afterEach(cleanup);

// ─── Nothing carried over ───────────────────────────────────────────────────

describe('CarriedOverCards — when there is nothing to carry', () => {
  it('renders nothing at all for a first meeting', async () => {
    const { container } = renderGroup();
    await waitFor(() => expect(db.askedFor).toEqual(['line-main']));
    expect(container.textContent).toBe('');
    expect(screen.queryByText('Carried over')).toBeNull();
  });

  it('renders nothing for an ad-hoc room, which has no review and so no lines', async () => {
    const { container } = renderGroup({ line: null });
    await waitFor(() => expect(container.textContent).toBe(''));
    // And asks for nothing: an install with no database is not asked for a table it
    // does not have.
    expect(db.askedFor).toEqual([]);
  });

  it('renders nothing on an install whose database has no review_lines yet', async () => {
    // listOpenLineItems answers [] for a 42703, which is the same as "nothing open".
    const { container } = renderGroup();
    await waitFor(() => expect(db.askedFor).toHaveLength(1));
    expect(container.textContent).toBe('');
  });
});

// ─── The group ──────────────────────────────────────────────────────────────

describe('CarriedOverCards — the cards a session starts with', () => {
  it('reads them from the LINE the room is on', async () => {
    db.items = [item()];
    renderGroup({ line: VARIANT_A });
    await waitFor(() => expect(db.askedFor).toEqual(['line-a']));
  });

  it('is folded away until asked for, and says how many it is holding', async () => {
    db.items = [item(), item({ id: 'item-2', title: 'Seal weeps at 80°C' })];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());

    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByText('Hinge pin wears')).toBeNull();

    fireEvent.click(screen.getByText('Carried over'));
    expect(screen.getByText('Hinge pin wears')).toBeTruthy();
    expect(screen.getByText('Seal weeps at 80°C')).toBeTruthy();
  });

  it('folds each card to one line, with the type, the title and where it came from', async () => {
    db.items = [item()];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    fireEvent.click(screen.getByText('Carried over'));

    expect(screen.getByText('RISK')).toBeTruthy();
    expect(screen.getByText('Hinge pin wears')).toBeTruthy();
    expect(screen.getByText('from S2')).toBeTruthy();
    // The description is not in the folded line — it is what the expansion is for.
    expect(screen.queryByText('Play develops after 4,000 cycles.')).toBeNull();
  });

  it('names a card from a variant by that variant\'s own numbers', async () => {
    db.items = [item({ fromSeq: 2 })];
    renderGroup({ line: VARIANT_A });
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    fireEvent.click(screen.getByText('Carried over'));
    expect(screen.getByText('from A2')).toBeTruthy();
  });

  it('says nothing about a session that has no number, rather than "from S0"', async () => {
    db.items = [item({ fromSeq: null })];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    fireEvent.click(screen.getByText('Carried over'));
    expect(screen.queryByText(/^from /)).toBeNull();
  });

  it('expands a card to its description, its priority and its status', async () => {
    db.items = [item()];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();

    expect(screen.getByText('Play develops after 4,000 cycles.')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('· Ana')).toBeTruthy();
    expect(screen.getByDisplayValue('Open')).toBeTruthy();
  });
});

// ─── Editing one ────────────────────────────────────────────────────────────

describe('CarriedOverCards — editing a carried card', () => {
  it('writes the change to the tracker, under the name of whoever made it', async () => {
    db.items = [item()];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();

    fireEvent.change(screen.getByDisplayValue('Open'), { target: { value: 'In Review' } });
    await waitFor(() => expect(db.updates).toHaveLength(1));

    expect(db.updates[0]).toEqual({ id: 'item-1', updates: { status: 'In Review' }, by: 'Robin' });
  });

  it('drops a card it closed, so it is not carried into the next meeting either', async () => {
    db.items = [item()];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();

    fireEvent.change(screen.getByDisplayValue('Open'), { target: { value: 'Approved' } });
    await waitFor(() => expect(screen.queryByText('Carried over')).toBeNull());
  });

  it('puts the value back when the write did not land', async () => {
    db.items = [item()];
    db.refuse = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();

    fireEvent.change(screen.getByDisplayValue('Open'), { target: { value: 'Approved' } });
    await waitFor(() => expect(screen.getByDisplayValue('Open')).toBeTruthy());
    error.mockRestore();
  });

  it('shows the status but no control to somebody who may not edit a card', async () => {
    // Hiding the control is not the enforcement — the room server is — but the panel
    // does not offer a tool that would be refused.
    db.items = [item()];
    renderGroup({ mayEdit: false });
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();

    expect(screen.queryByDisplayValue('Open')).toBeNull();
    expect(screen.getByText('Open')).toBeTruthy();
  });

  it('links out to the tracker, where the rest of the card lives', async () => {
    db.items = [item()];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();

    expect(screen.getByTitle('Open in the tracker').getAttribute('href')).toBe('/tracker');
  });
});

// ─── The invariant that keeps one card one card ─────────────────────────────

describe('CarriedOverCards — a carried card is not a new card', () => {
  it('never puts one into the room\'s deck, so the meeting flush cannot re-save it', async () => {
    // store.ts's endMeeting writes `insightCards` and nothing else to the tracker. A
    // carried card that reached that list would be inserted a second time at the end
    // of this meeting, and a third at the end of the next one.
    db.items = [item(), item({ id: 'item-2', title: 'Seal weeps at 80°C' })];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();
    fireEvent.change(screen.getByDisplayValue('Open'), { target: { value: 'In Review' } });
    await waitFor(() => expect(db.updates).toHaveLength(1));

    expect(useStore.getState().insightCards).toEqual([]);
  });

  it('writes to the tracker row it is showing, not to a copy of it', async () => {
    // The same id the read came back with is the id the write goes to, so everybody
    // else looking at the tracker sees the change and the status history that
    // lib/trackerContinuity.ts reads to say when a card closed is the one this makes.
    db.items = [item({ id: 'item-77' })];
    renderGroup();
    await waitFor(() => expect(screen.getByText('Carried over')).toBeTruthy());
    openCard();
    fireEvent.change(screen.getByDisplayValue('Open'), { target: { value: 'Rejected' } });
    await waitFor(() => expect(db.updates).toHaveLength(1));
    expect(db.updates[0].id).toBe('item-77');
  });
});
