// The People section as the preview panel offers it: to whom, and on which installs.
//
// docs/plan/15-sessions-and-variants.md batch BW. The section's own behaviour is
// pinned in peopleSection.test.tsx; what is pinned HERE is the two gates the panel
// puts in front of it, because both are the panel's decision and not the section's:
//
//   • identity.mode 'none' — no accounts, so api/reviews/members.ts answers 404,
//     there is no roster and nothing a membership row could be keyed on. The room's
//     People tab is absent on such an install for exactly that reason, and so is this.
//   • `mayEdit` — the people the endpoint lets READ a roster, which is
//     can(role, 'editReview'): an owner or an editor. A participant gets no section
//     rather than a section full of refusals, and a guest gets none either.
//
// Neither gate is the enforcement. The endpoint checks the caller's own verified
// token against the roster as the database holds it, and would refuse a write from
// anybody it did not like however the panel was drawn.
//
// The panel's own read (lib/reviews/useSessionMap) and its deletes are faked the way
// reviewPreview.test.tsx fakes them; this file is about whether the section is there.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LobbyReview } from '../../../lib/lobby/useLobbyData';
import type { ReviewPeople, ReviewPerson } from '../../../lib/reviews/membersClient';

const { mapData, members } = vi.hoisted(() => ({
  mapData: {
    current: {
      lines: [] as never[],
      sessions: [] as never[],
      revisions: [] as never[],
      cards: [] as never[],
      loading: false,
      refresh: () => {},
    },
  },
  members: { fetch: vi.fn(), write: vi.fn() },
}));

vi.mock('../../../lib/reviews/useSessionMap', () => ({
  useSessionMap: () => mapData.current,
}));

vi.mock('../../../lib/reviews/membersClient', () => ({
  fetchReviewPeople: (reviewId: string) => members.fetch(reviewId),
  writeReviewMember: (...args: unknown[]) => members.write(...args),
}));

vi.mock('../../../lib/reviews/deleteClient', () => ({
  deleteReview: vi.fn(),
  deleteSession: vi.fn(),
}));

const ReviewPreview = (await import('../ReviewPreview')).default;

const ANA: ReviewPerson = { userId: 'u-ana', role: 'owner', name: 'Ana', email: 'ana@example.com' };

const ROSTER: { people: ReviewPeople } = {
  people: { ownerId: 'u-ana', canManage: true, canClaimOwner: false, people: [ANA] },
};

function review(over: Partial<LobbyReview> = {}): LobbyReview {
  return {
    id: 'r1', title: 'Door hinge, rev C', description: '', thumbnail: null, modelName: 'hinge.glb',
    updatedAt: '2026-09-24T09:00:00.000Z', createdAt: '2026-09-01T09:00:00.000Z',
    archived: false, listed: true, memberRole: 'owner', mine: true, visited: true,
    lastVisitedAt: null, sessions: [], lines: [],
    openCards: { RISK: 0, ACTION: 0, RATIONALE: 0 }, revision: null,
    ...over,
  };
}

const onChanged = vi.fn<() => void>();

function renderPanel(props: Partial<React.ComponentProps<typeof ReviewPreview>> = {}) {
  onChanged.mockReset();
  render(
    <MemoryRouter>
      <ReviewPreview
        review={review()}
        mayDelete={false}
        onOpen={() => {}}
        onDeleted={() => {}}
        onChanged={onChanged}
        {...props}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mapData.current = {
    lines: [], sessions: [], revisions: [], cards: [], loading: false, refresh: () => {},
  };
  members.fetch.mockReset().mockResolvedValue(ROSTER);
  members.write.mockReset().mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('the preview panel — who gets the People section', () => {
  it('has none on an install with no accounts, and asks for no roster there', () => {
    // The default install: identity.mode 'none'. `mayEdit` is TRUE for everybody who
    // got past the front door there, so the mode is the only thing that can hide it.
    renderPanel({ accountsOn: false, mayEdit: true });

    expect(screen.queryByTestId('preview-people')).toBeNull();
    expect(members.fetch).not.toHaveBeenCalled();
  });

  it('has none for somebody the endpoint would not let read the roster', () => {
    // A participant, and a guest: can(role, 'editReview') is false for both, which is
    // the panel's `mayEdit`. No section, and no request that would answer 403.
    renderPanel({ accountsOn: true, mayEdit: false });

    expect(screen.queryByTestId('preview-people')).toBeNull();
    expect(members.fetch).not.toHaveBeenCalled();
  });

  it('has none at all when the caller says nothing, so no other surface grows one', async () => {
    renderPanel({ mayEdit: true });
    expect(screen.queryByTestId('preview-people')).toBeNull();
  });

  it('shows the roster to an owner of a review on an install with accounts', async () => {
    renderPanel({ accountsOn: true, mayEdit: true });

    expect(await screen.findByTestId('preview-people')).toHaveTextContent('Ana');
    expect(members.fetch).toHaveBeenCalledWith('r1');
  });

  it('sits under the heading, above the model, so it reads as a fact about the review', async () => {
    renderPanel({ accountsOn: true, mayEdit: true });
    await screen.findByTestId('preview-people');

    const panel = screen.getByTestId('review-preview');
    const order = Array.from(panel.querySelectorAll('[data-testid]')).map((node) =>
      node.getAttribute('data-testid'),
    );
    expect(order.indexOf('preview-title')).toBeLessThan(order.indexOf('preview-people'));
    expect(order.indexOf('preview-people')).toBeLessThan(order.indexOf('turn-in-3d'));
  });

  it('re-reads the grid after a change, so the card’s head count agrees', async () => {
    renderPanel({ accountsOn: true, mayEdit: true });
    await screen.findByTestId('preview-people');

    fireEvent.click(screen.getByTestId('add-person'));
    fireEvent.change(screen.getByTestId('add-person-email'), { target: { value: 'ben@example.com' } });
    fireEvent.click(screen.getByTestId('add-person-submit'));

    await waitFor(() => expect(members.write).toHaveBeenCalledTimes(1));
    // `onChanged` is the lobby's grid re-read: the card's "3 people" and the panel's
    // own counts come from it, so a roster write that did not call it would leave the
    // card saying something the panel contradicts.
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});
