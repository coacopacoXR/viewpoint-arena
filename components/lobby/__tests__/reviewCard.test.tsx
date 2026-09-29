// A lobby card says what the review looks like inside, from outside it.
//
// docs/plan/15-sessions-and-variants.md batch BO. The user's complaint about the old
// lobby was that it gave no way to see inside a design review before walking into it, so
// what a card carries is the thing under test: the snapshot (or a placeholder naming the
// model when the room never took one), the review's name, one line of meta, a miniature
// of its session map, and how many of each kind of card are still open.
//
// Fixture data only. The card is given a LobbyReview and draws it, exactly as
// components/review/SessionMap is given lines and sessions, so a test needs no database
// and no mocks — which is also why lib/lobby/useLobbyData has its own test for the half
// that reads.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ReviewCard from '../ReviewCard';
import type { LobbyReview } from '../../../lib/lobby/useLobbyData';
import type { LineSession } from '../../../lib/reviews/linesRepo';
import type { ReviewLine } from '../../../lib/reviews/lines';

function session(id: string, over: Partial<LineSession> = {}): LineSession {
  return {
    id,
    title: id,
    endedAt: '2026-09-20T09:00:00.000Z',
    participantCount: 2,
    attendeeNames: ['Robin', 'Ben'],
    modelName: 'hinge.glb',
    lineId: 'line-main',
    seq: 1,
    revisionIds: [],
    summary: null,
    ...over,
  };
}

const MAIN: ReviewLine = {
  id: 'line-main',
  reviewId: 'r1',
  kind: 'main',
  name: 'Main line',
  letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active',
  createdBy: null,
  createdByName: 'Robin',
  createdAt: '2026-09-20T09:00:00.000Z',
  closedAt: null,
};

const VARIANT: ReviewLine = { ...MAIN, id: 'line-a', kind: 'variant', name: 'Steel pin', letter: 'A', parentSessionId: 's1', parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'adopted' };

function review(over: Partial<LobbyReview> = {}): LobbyReview {
  return {
    id: 'r1',
    title: 'Door hinge, rev C',
    description: '',
    thumbnail: 'data:image/jpeg;base64,AAAA',
    modelName: 'hinge.glb',
    updatedAt: '2026-09-24T09:00:00.000Z',
    createdAt: '2026-09-01T09:00:00.000Z',
    archived: false,
    listed: true,
    memberRole: 'owner',
    mine: true,
    visited: true,
    lastVisitedAt: '2026-09-24T09:00:00.000Z',
    sessions: [
      session('s1'),
      session('s2', { seq: 1, lineId: 'line-a', endedAt: '2026-09-22T09:00:00.000Z' }),
      session('s3', { seq: 2, endedAt: '2026-09-24T09:00:00.000Z' }),
    ],
    lines: [MAIN, VARIANT],
    openCards: { RISK: 3, ACTION: 5, RATIONALE: 2 },
    revision: 'Rev C',
    ...over,
  };
}

afterEach(cleanup);

describe('a lobby card', () => {
  it('shows the snapshot the room took', () => {
    render(<ReviewCard review={review()} selected={false} onSelect={() => {}} />);
    const image = screen.getByTestId('review-card-thumbnail');
    expect(image).toHaveAttribute('src', 'data:image/jpeg;base64,AAAA');
  });

  it('shows a placeholder naming the model when no snapshot was ever taken', () => {
    render(<ReviewCard review={review({ thumbnail: null })} selected={false} onSelect={() => {}} />);
    expect(screen.queryByTestId('review-card-thumbnail')).toBeNull();
    expect(screen.getByTestId('review-card-placeholder')).toHaveTextContent('hinge.glb');
  });

  it('says the revision, when it last met, and what this person is to it', () => {
    render(<ReviewCard review={review()} selected={false} onSelect={() => {}} />);
    expect(screen.getByText('Door hinge, rev C')).toBeInTheDocument();
    expect(screen.getByText(/Rev C · last session/)).toBeInTheDocument();
    expect(screen.getByText(/you own it/)).toBeInTheDocument();
  });

  it('counts the open cards by kind, in the tracker’s own colours', () => {
    render(<ReviewCard review={review()} selected={false} onSelect={() => {}} />);
    expect(screen.getByTitle('3 open risk')).toHaveTextContent('3');
    expect(screen.getByTitle('5 open action')).toHaveTextContent('5');
    expect(screen.getByTitle('2 open rationale')).toHaveTextContent('2');
  });

  it('says there are no cards yet rather than showing three zeroes', () => {
    render(
      <ReviewCard
        review={review({ openCards: { RISK: 0, ACTION: 0, RATIONALE: 0 } })}
        selected={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('No cards yet')).toBeInTheDocument();
    expect(screen.queryByTitle('0 open risk')).toBeNull();
  });

  it('draws a miniature of the session map, including the variant', () => {
    render(<ReviewCard review={review()} selected={false} onSelect={() => {}} />);
    expect(screen.getByTestId('mini-session-map')).toBeInTheDocument();
    // Two meetings on the main line, one on the variant.
    expect(screen.getAllByTestId('mini-stop')).toHaveLength(3);
    expect(screen.getAllByTestId('mini-rejoin')).toHaveLength(1);
  });

  it('says a review with no lines at all has no sessions yet', () => {
    render(<ReviewCard review={review({ sessions: [], lines: [] })} selected={false} onSelect={() => {}} />);
    expect(screen.getByTestId('mini-session-map-empty')).toHaveTextContent('No sessions yet');
  });

  it('draws a review that has lines and has not met, rather than saying it has nothing', () => {
    // Batch BV: the card carries the main line's start — and a variant's stub if it has
    // one — so a review whose first meeting has not happened yet is still recognisable
    // in a grid of them, and a variant started before anybody met is still visible.
    render(<ReviewCard review={review({ sessions: [], lines: [MAIN] })} selected={false} onSelect={() => {}} />);
    expect(screen.getByTestId('mini-session-map')).toBeInTheDocument();
    expect(screen.queryByTestId('mini-session-map-empty')).toBeNull();
  });

  it('selects the review when the card is pressed', () => {
    const onSelect = vi.fn();
    render(<ReviewCard review={review()} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('review-card').querySelector('button') as HTMLElement);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks the selected card, so the grid and the panel agree about which one is open', () => {
    render(<ReviewCard review={review()} selected onSelect={() => {}} />);
    expect(screen.getByTestId('review-card')).toHaveAttribute('data-selected', 'true');
  });
});
