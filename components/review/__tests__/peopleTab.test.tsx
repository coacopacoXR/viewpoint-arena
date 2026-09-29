// The room's People tab, after its logic moved into lib/reviews/useReviewPeople.
//
// docs/plan/15-sessions-and-variants.md batch BW. The lobby's preview panel grew the
// same three writes, and the shared part — the read, the writes, the busy flag, the
// mapping of a refusal to a sentence — went into a hook both surfaces use. This file
// is here because a refactor that serves a new surface must not quietly change the
// old one: the tab still reads the roster, still adds by email with the same
// validation, still re-roles and removes, still says what the endpoint refused, and
// still tells the room to re-read its role after a write LANDS and not after one that
// did not.
//
// Only lib/reviews/membersClient is faked, which is the seam api/reviews/members.ts
// is on the other side of. The tab decides nothing about who may manage the list:
// `canManage` arrives in the read and the controls follow it.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReviewPeople, ReviewPerson } from '../../../lib/reviews/membersClient';

const { members } = vi.hoisted(() => ({
  members: { fetch: vi.fn(), write: vi.fn() },
}));

vi.mock('../../../lib/reviews/membersClient', () => ({
  fetchReviewPeople: (reviewId: string) => members.fetch(reviewId),
  writeReviewMember: (...args: unknown[]) => members.write(...args),
}));

const PeopleTab = (await import('../PeopleTab')).default;
const { MISSING_EMAIL } = await import('../../../lib/reviews/useReviewPeople');

const OWNER: ReviewPerson = {
  userId: 'u-owner', role: 'owner', name: 'Ana Owner', email: 'ana@example.com',
};
const EDITOR: ReviewPerson = {
  userId: 'u-editor', role: 'editor', name: 'Ben Editor', email: 'ben@example.com',
};

function roster(over: Partial<ReviewPeople> = {}): { people: ReviewPeople } {
  return {
    people: {
      ownerId: OWNER.userId,
      canManage: true,
      canClaimOwner: false,
      people: [OWNER, EDITOR],
      ...over,
    },
  };
}

const onRosterChanged = vi.fn<() => void>();

async function renderTab(answer = roster()) {
  members.fetch.mockReset().mockResolvedValue(answer);
  members.write.mockReset().mockResolvedValue({ ok: true });
  onRosterChanged.mockReset();
  render(<PeopleTab reviewId="room-1" onRosterChanged={onRosterChanged} />);
  // Waited on the loading sentence rather than on a name: two of the tests below arm
  // a roster with nobody in it, and an unowned review has no owner row to find.
  await waitFor(() =>
    expect(screen.queryByText('Reading who is on this review…')).toBeNull(),
  );
}

/** The add form's role select: the last combobox, after one per changeable row. */
function addFormRole(): HTMLElement {
  const boxes = screen.getAllByRole('combobox');
  return boxes[boxes.length - 1];
}

beforeEach(() => {
  members.fetch.mockReset();
  members.write.mockReset().mockResolvedValue({ ok: true });
});

afterEach(cleanup);

describe('the People tab — the roster', () => {
  it('reads the review’s people and says what it is doing until they arrive', () => {
    members.fetch.mockReset().mockReturnValue(new Promise(() => {}));
    render(<PeopleTab reviewId="room-1" />);

    expect(screen.getByText('Reading who is on this review…')).toBeInTheDocument();
    expect(members.fetch).toHaveBeenCalledWith('room-1');
  });

  it('draws each person with a name, an address and a role', async () => {
    await renderTab();

    expect(screen.getByText('Ana Owner')).toBeInTheDocument();
    expect(screen.getByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByText('Ben Editor')).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('draws no controls at all for somebody the endpoint answered canManage: false', async () => {
    await renderTab(roster({ canManage: false }));

    // An editor may read the list and may not change it — and the tab says why.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByPlaceholderText('email address')).toBeNull();
    expect(screen.queryByTitle('Remove from this review')).toBeNull();
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText(/Only its owner can change this list/)).toBeInTheDocument();
  });
});

describe('the People tab — adding somebody', () => {
  it('adds by email and role, re-reads, and tells the room', async () => {
    await renderTab();

    fireEvent.change(screen.getByPlaceholderText('email address'), {
      target: { value: 'olga@example.com' },
    });
    fireEvent.change(addFormRole(), { target: { value: 'editor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('room-1', {
        action: 'add',
        email: 'olga@example.com',
        role: 'editor',
      }),
    );
    // The re-read is what makes the tab show the roster the server actually wrote:
    // an add resolves an email to an account id this browser never had.
    expect(members.fetch).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onRosterChanged).toHaveBeenCalledTimes(1));
  });

  it('refuses an empty box with its own sentence and makes no request', async () => {
    await renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(MISSING_EMAIL)).toBeInTheDocument();
    expect(members.write).not.toHaveBeenCalled();
    expect(onRosterChanged).not.toHaveBeenCalled();
  });

  it('says what the endpoint refused — an address nobody signs in with', async () => {
    await renderTab();
    members.write.mockResolvedValue({
      ok: false,
      error: 'Nobody on this install signs in with that email address. Ask an administrator to create their account first.',
    });

    fireEvent.change(screen.getByPlaceholderText('email address'), {
      target: { value: 'stranger@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText(/Nobody on this install signs in with that email address/)).toBeInTheDocument();
    // A refusal changes nothing, so the room has no reason to re-read its role.
    expect(onRosterChanged).not.toHaveBeenCalled();
    expect(members.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the People tab — changing, removing and claiming', () => {
  it('re-roles somebody through the client', async () => {
    await renderTab();

    // The only combobox that is not the add form's belongs to the editor's row: the
    // owner's row has none, because the endpoint refuses to re-roll an owner.
    const rows = screen.getAllByRole('combobox');
    expect(rows).toHaveLength(2);
    fireEvent.change(rows[0], { target: { value: 'participant' } });

    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('room-1', {
        action: 'setRole',
        userId: 'u-editor',
        role: 'participant',
      }),
    );
  });

  it('removes somebody through the client', async () => {
    await renderTab();

    fireEvent.click(screen.getByTitle('Remove from this review'));

    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('room-1', {
        action: 'remove',
        userId: 'u-editor',
      }),
    );
  });

  it('offers an administrator the claim on a review that has no owner, and writes it', async () => {
    await renderTab(roster({ ownerId: null, canClaimOwner: true, people: [] }));

    expect(screen.getByText(/This review has no owner/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Make me the owner/ }));

    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('room-1', { action: 'claimOwner' }),
    );
    await waitFor(() => expect(onRosterChanged).toHaveBeenCalledTimes(1));
  });

  it('offers the claim to nobody else, and says the review is simply unowned', async () => {
    await renderTab(roster({ ownerId: null, canClaimOwner: false, people: [] }));

    expect(screen.getByText(/This review has no owner/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Make me the owner/ })).toBeNull();
  });

  it('says a roster it could not read, rather than showing an empty list', () => {
    // "Nobody is on this review" and "this review could not be read" are different
    // facts, and only one of them is a reason to stop inviting people.
    members.fetch.mockReset().mockResolvedValue({ error: 'You are not signed in, so this review has no people to show.' });
    render(<PeopleTab reviewId="room-1" />);

    return waitFor(() => {
      expect(screen.getByText('You are not signed in, so this review has no people to show.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.queryByText(/Nobody is on this review yet/)).toBeNull();
    });
  });
});
