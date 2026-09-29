// What a card says about the line it came from once a variant has been through it —
// components/UI/CardContinuity.tsx's CardLineLabel.
//
// docs/plan/15-sessions-and-variants.md batch BL. Batch BK's label ("Main line · S3",
// "Variant A · A2") is the card's line and its meeting's number, and it stays right for
// every card a variant never touched. Two kinds of card can no longer be described that
// way, and both are pinned here:
//
//   ADOPTED. Its line_id is the main line now, but its meeting's `seq` is a number on
//   the VARIANT — so "Main line · S2" would name a meeting that has nothing to do with
//   this card, and a reviewer who went looking for it would find a different one. What
//   it says instead is where it was raised and when the review took it in.
//
//   DROPPED WITH ITS VARIANT. It was closed by the drop rather than by a decision about
//   the engineering, and the reason the meeting gave is the thing worth reading.
//
// The labels themselves are decided in lib/reviews/lines.ts and pinned there; what is
// pinned here is which one the card reaches for, and that a card no variant ever touched
// still renders exactly what it rendered before.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CardContinuityProvider, CardLineLabel } from '../CardContinuity';
import type { TrackerItem, TrackerSession } from '../../../lib/supabase';
import type { ReviewLine } from '../../../lib/reviews/lines';

const REVIEW = 'review-1';
const MAIN_ID = 'line-main';
const VARIANT_A = 'line-a';
const VARIANT_B = 'line-b';

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: VARIANT_A, reviewId: REVIEW, kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parentSessionId: 'sess-3', parentLineId: MAIN_ID, mergedIntoLineId: null, dropReason: null,
    status: 'active', createdBy: null, createdByName: 'Robin',
    createdAt: '2026-05-04T09:00:00.000Z', closedAt: null, ...overrides,
  };
}

const MAIN = line({
  id: MAIN_ID, kind: 'main', name: 'Main line', letter: null, parentSessionId: null, parentLineId: null,
});
const ADOPTED_A = line({ status: 'adopted', closedAt: '2026-10-12T15:00:00.000Z' });
const DROPPED_B = line({ id: VARIANT_B, letter: 'B', name: 'Weld fix', status: 'dropped', closedAt: '2026-10-12T15:00:00.000Z' });

const LINES: ReviewLine[] = [MAIN, ADOPTED_A, DROPPED_B];

/** The meeting a card was raised in, as the joined row the tracker reads it from. */
function sessionRow(overrides: Partial<TrackerSession> = {}): TrackerSession {
  return {
    id: 'sess-a2', room_id: REVIEW, title: 'Variant meeting', ended_at: '2026-05-06T16:00:00.000Z',
    created_at: '2026-05-06T15:00:00.000Z', participant_count: 4, model_name: 'Bracket', labels: {},
    review_id: REVIEW, line_id: VARIANT_A, seq: 2, ...overrides,
  };
}

function item(overrides: Partial<TrackerItem> = {}): TrackerItem {
  return {
    id: 'item-1',
    session_id: 'sess-a2',
    type: 'RISK',
    title: 'Hinge pin wears',
    description: '',
    priority: 'High',
    status: 'Open',
    assignee: null,
    due_date: null,
    component_reference: null,
    department: null,
    agent_id: 'SYS.OP',
    source_message_ids: null,
    affected_requirement_ids: null,
    impact: null,
    mitigation_strategy: null,
    design_driver: null,
    tradeoff_analysis: null,
    created_at: '2026-05-06T16:00:00.000Z',
    updated_at: '2026-05-06T16:00:00.000Z',
    review_id: REVIEW,
    line_id: MAIN_ID,
    origin_line_id: MAIN_ID,
    session: sessionRow(),
    ...overrides,
  };
}

function renderLabel(card: TrackerItem): void {
  render(
    <CardContinuityProvider value={{ revisionsByReview: {}, closedAtByItem: {}, linesByReview: { [REVIEW]: LINES } }}>
      <CardLineLabel item={card} />
    </CardContinuityProvider>,
  );
}

afterEach(cleanup);

describe('a card no variant ever touched', () => {
  it('says its line and its session, exactly as batch BK left it', () => {
    renderLabel(item({ line_id: MAIN_ID, origin_line_id: MAIN_ID, session: sessionRow({ line_id: MAIN_ID, seq: 3 }) }));
    expect(screen.getByText('Main line · S3')).toBeTruthy();
  });

  it('says "Variant A · A2" on a card still on the variant it was raised in', () => {
    renderLabel(item({ line_id: VARIANT_A, origin_line_id: VARIANT_A }));
    expect(screen.getByText('Variant A · A2')).toBeTruthy();
  });

  it('says nothing when its line row was never read', () => {
    render(
      <CardContinuityProvider value={{ revisionsByReview: {}, closedAtByItem: {} }}>
        <CardLineLabel item={item()} />
      </CardContinuityProvider>,
    );
    expect(screen.queryByText(/Main line|Variant/)).toBeNull();
  });
});

describe('a card adopted into the main line', () => {
  it('says where it was raised and when the review took it in', () => {
    renderLabel(item({
      line_id: MAIN_ID,
      origin_line_id: VARIANT_A,
      adopted_at: '2026-10-12T15:00:00.000Z',
      status: 'Open',
    }));
    expect(screen.getByText('Raised in Variant A · adopted 12 Oct')).toBeTruthy();
  });

  it('does not say "Main line · S2", which would name a meeting this card has nothing to do with', () => {
    // seq 2 is a number on the VARIANT. The card is on the main line now, and the main
    // line's S2 is a different meeting with different people in it.
    renderLabel(item({ line_id: MAIN_ID, origin_line_id: VARIANT_A, adopted_at: '2026-10-12T15:00:00.000Z' }));
    expect(screen.queryByText('Main line · S2')).toBeNull();
  });

  it('still says where it was raised when the moment it was adopted was never written', () => {
    renderLabel(item({ line_id: MAIN_ID, origin_line_id: VARIANT_A, adopted_at: null }));
    expect(screen.getByText('Raised in Variant A')).toBeTruthy();
  });

  it('says it for a card that was already closed when the variant was adopted', () => {
    // Adopting moves the cards "still open or not", so a closed one moves too and still
    // has to say it came from the variant.
    renderLabel(item({
      line_id: MAIN_ID, origin_line_id: VARIANT_A, adopted_at: '2026-10-12T15:00:00.000Z', status: 'Approved',
    }));
    expect(screen.getByText('Raised in Variant A · adopted 12 Oct')).toBeTruthy();
  });
});

describe('a card closed because its variant was dropped', () => {
  it('carries the reason the meeting gave', () => {
    renderLabel(item({
      line_id: VARIANT_B,
      origin_line_id: VARIANT_B,
      status: 'Rejected',
      closed_reason: 'Dropped with Variant B: Too expensive to tool',
    }));
    expect(screen.getByText('Closed — dropped with Variant B: Too expensive to tool')).toBeTruthy();
  });

  it('says the reason rather than the line, because the reason is the newer fact', () => {
    renderLabel(item({
      line_id: VARIANT_B,
      origin_line_id: VARIANT_B,
      status: 'Rejected',
      closed_reason: 'Dropped with Variant B: Too expensive to tool',
      session: sessionRow({ line_id: VARIANT_B, seq: 1 }),
    }));
    expect(screen.queryByText('Variant B · B1')).toBeNull();
  });

  it('says nothing extra about a card closed by hand', () => {
    renderLabel(item({ status: 'Rejected', closed_reason: null }));
    expect(screen.queryByText(/^Closed/)).toBeNull();
  });
});

describe('the words on a card', () => {
  it('never say branch, fork, merge or commit', () => {
    const cards = [
      item({ line_id: MAIN_ID, origin_line_id: VARIANT_A, adopted_at: '2026-10-12T15:00:00.000Z' }),
      item({ line_id: VARIANT_B, origin_line_id: VARIANT_B, status: 'Rejected', closed_reason: 'Dropped with Variant B: Too expensive to tool' }),
      item(),
    ];
    const { container } = render(
      <CardContinuityProvider value={{ revisionsByReview: {}, closedAtByItem: {}, linesByReview: { [REVIEW]: LINES } }}>
        {cards.map((card) => <CardLineLabel key={card.id + String(card.line_id) + String(card.adopted_at)} item={card} />)}
      </CardContinuityProvider>,
    );
    const said = (container.textContent ?? '').toLowerCase();
    expect(said).not.toMatch(/branch|fork|merge|commit/);
  });
});
