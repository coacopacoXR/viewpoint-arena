// Adding people to a design review from the lobby.
//
// docs/plan/15-sessions-and-variants.md batch BW, from the user's note that "it
// should be possible to add people in the design review straight from the lobby".
// What is pinned here is the section's own behaviour — the read, the three writes,
// the sentences a refusal gets, and the inline "are you sure". The hook behind it is
// real, because the hook IS the point: components/review/PeopleTab.tsx and this
// section share lib/reviews/useReviewPeople, so a test that mocked the hook would be
// testing a drawing of the thing rather than the thing.
//
// Only lib/reviews/membersClient is faked, which is the seam the endpoint is on the
// other side of. Nothing here decides who may do what: `canManage` comes back in the
// read and the controls follow it, exactly as the room's tab does, because hiding a
// control is not the enforcement — api/reviews/members.ts is.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReviewPeople, ReviewPerson } from '../../../lib/reviews/membersClient';
import { REVIEW_ROSTER_CHANGED } from '../../../lib/reviews/rosterEvents';

const { members } = vi.hoisted(() => ({
  members: { fetch: vi.fn(), write: vi.fn() },
}));

vi.mock('../../../lib/reviews/membersClient', () => ({
  fetchReviewPeople: (reviewId: string) => members.fetch(reviewId),
  writeReviewMember: (...args: unknown[]) => members.write(...args),
}));

const PeopleSection = (await import('../PeopleSection')).default;
const { MISSING_EMAIL } = await import('../../../lib/reviews/useReviewPeople');

const OWNER: ReviewPerson = {
  userId: 'u-owner', role: 'owner', name: 'Ana Owner', email: 'ana@example.com',
};
const EDITOR: ReviewPerson = {
  userId: 'u-editor', role: 'editor', name: 'Ben Editor', email: 'ben@example.com',
};

/** What the endpoint answers, with the flags a test wants to vary. */
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

const onChanged = vi.fn<() => void>();
/** The roster-changed events this page heard, so a write can be seen to announce itself. */
let announced: string[] = [];

function onAnnounce(event: Event): void {
  announced.push((event as CustomEvent<string>).detail);
}

async function renderSection(answer = roster()) {
  members.fetch.mockReset().mockResolvedValue(answer);
  members.write.mockReset().mockResolvedValue({ ok: true });
  render(<PeopleSection reviewId="r1" onChanged={onChanged} />);
  await screen.findByTestId('preview-people');
  // Waited on the loading line rather than on a row: two of the tests below arm a
  // roster with nobody in it, and an unowned review has no rows to find.
  await waitFor(() => expect(screen.queryByTestId('people-loading')).toBeNull());
}

beforeEach(() => {
  announced = [];
  onChanged.mockReset();
  members.fetch.mockReset();
  members.write.mockReset().mockResolvedValue({ ok: true });
  window.addEventListener(REVIEW_ROSTER_CHANGED, onAnnounce);
});

afterEach(() => {
  window.removeEventListener(REVIEW_ROSTER_CHANGED, onAnnounce);
  cleanup();
});

describe('the lobby’s People section — the roster', () => {
  it('reads the review’s people and draws each with a name and a role', async () => {
    await renderSection();

    expect(members.fetch).toHaveBeenCalledWith('r1');
    const rows = screen.getAllByTestId('preview-person');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('preview-people')).toHaveTextContent('Ana Owner');
    expect(screen.getByTestId('preview-people')).toHaveTextContent('Ben Editor');
    expect(rows[0].getAttribute('data-role')).toBe('owner');
    expect(rows[1].getAttribute('data-role')).toBe('editor');
  });

  it('gives an owner the controls, and an editor the list only', async () => {
    await renderSection(roster({ canManage: true }));
    expect(screen.getByTestId('add-person')).toBeInTheDocument();
    expect(screen.getByTestId('person-role-u-editor')).toBeInTheDocument();
    cleanup();

    // The endpoint's own answer decides this, not a second reading of the rule: an
    // editor may read the roster and may not change it.
    await renderSection(roster({ canManage: false }));
    expect(screen.queryByTestId('add-person')).toBeNull();
    expect(screen.queryByTestId('person-role-u-editor')).toBeNull();
    expect(screen.queryAllByTestId(/^remove-person-/)).toHaveLength(0);
    // The role is still SAID, it just cannot be changed.
    expect(screen.getByTestId('preview-people')).toHaveTextContent('Editor');
  });

  it('never offers the owner’s own row as something to re-roll or remove', async () => {
    await renderSection();

    // api/reviews/members.ts answers 409 to both, and says to transfer ownership
    // instead: a control drawn only to be refused is a question, not a feature.
    expect(screen.queryByTestId('person-role-u-owner')).toBeNull();
    expect(screen.queryByTestId('remove-person-u-owner')).toBeNull();
    expect(screen.getByTestId('person-role-u-editor')).toBeInTheDocument();
  });

  it('says a roster it could not read, and offers another read', async () => {
    members.fetch.mockReset().mockResolvedValue({ error: 'Could not read this review’s people (503)' });
    members.write.mockReset();
    render(<PeopleSection reviewId="r1" onChanged={onChanged} />);

    expect(await screen.findByRole('status')).toHaveTextContent('Could not read this review’s people');
    expect(screen.queryByTestId('preview-people-rows')).toBeNull();

    members.fetch.mockResolvedValue(roster());
    fireEvent.click(screen.getByTestId('people-try-again'));
    await screen.findByTestId('preview-people-rows');
    expect(members.fetch).toHaveBeenCalledTimes(2);
  });

  it('offers an administrator the claim on a review that has no owner', async () => {
    await renderSection(roster({ ownerId: null, people: [] }));

    expect(screen.getByTestId('preview-people')).toHaveTextContent('This review has no owner');
    // An admin, and no owner — both, and not either on its own.
    expect(screen.queryByTestId('claim-owner')).toBeNull();
    cleanup();

    await renderSection(roster({ ownerId: null, canClaimOwner: true, people: [] }));
    fireEvent.click(screen.getByTestId('claim-owner'));
    await waitFor(() => expect(members.write).toHaveBeenCalledWith('r1', { action: 'claimOwner' }));
  });
});

describe('the lobby’s People section — adding somebody', () => {
  it('adds by email and role through the same client the room’s tab uses', async () => {
    await renderSection();

    fireEvent.click(screen.getByTestId('add-person'));
    fireEvent.change(screen.getByTestId('add-person-email'), { target: { value: 'olga@example.com' } });
    fireEvent.change(screen.getByTestId('add-person-role'), { target: { value: 'editor' } });
    fireEvent.click(screen.getByTestId('add-person-submit'));

    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('r1', {
        action: 'add',
        email: 'olga@example.com',
        role: 'editor',
      }),
    );
  });

  it('refuses an empty box with the tab’s own sentence, and makes no request', async () => {
    await renderSection();

    fireEvent.click(screen.getByTestId('add-person'));
    fireEvent.click(screen.getByTestId('add-person-submit'));

    expect(await screen.findByRole('status')).toHaveTextContent(MISSING_EMAIL);
    expect(members.write).not.toHaveBeenCalled();
  });

  it('shows what the endpoint refused — an address nobody signs in with', async () => {
    await renderSection();
    members.write.mockResolvedValue({
      ok: false,
      error: 'Nobody on this install signs in with that email address. Ask an administrator to create their account first.',
    });

    fireEvent.click(screen.getByTestId('add-person'));
    fireEvent.change(screen.getByTestId('add-person-email'), { target: { value: 'stranger@example.com' } });
    fireEvent.click(screen.getByTestId('add-person-submit'));

    expect(await screen.findByRole('status')).toHaveTextContent('Nobody on this install signs in with that email address');
    // A refusal is not a change: the grid is not re-read and nothing is announced.
    expect(onChanged).not.toHaveBeenCalled();
    expect(announced).toHaveLength(0);
  });

  it('re-reads the roster, tells the lobby, and announces the change after a write lands', async () => {
    await renderSection();

    fireEvent.click(screen.getByTestId('add-person'));
    fireEvent.change(screen.getByTestId('add-person-email'), { target: { value: 'olga@example.com' } });
    fireEvent.click(screen.getByTestId('add-person-submit'));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // The roster is read again rather than patched: an add resolves an email to an
    // account id this browser never had.
    expect(members.fetch).toHaveBeenCalledTimes(2);
    // lib/reviews/rosterEvents, so any open role check on the page re-reads.
    expect(announced).toEqual(['r1']);
  });
});

describe('the lobby’s People section — changing and removing', () => {
  it('changes a role through the client', async () => {
    await renderSection();

    fireEvent.change(screen.getByTestId('person-role-u-editor'), { target: { value: 'participant' } });

    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('r1', {
        action: 'setRole',
        userId: 'u-editor',
        role: 'participant',
      }),
    );
  });

  it('removes only after an inline question, and never with a browser dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    await renderSection();

    fireEvent.click(screen.getByTestId('remove-person-u-editor'));
    expect(screen.getByTestId('people-inline-confirm')).toHaveTextContent('Remove Ben Editor from this design review?');
    expect(members.write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-remove-u-editor'));
    await waitFor(() =>
      expect(members.write).toHaveBeenCalledWith('r1', { action: 'remove', userId: 'u-editor' }),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('cancels the removal and writes nothing', async () => {
    await renderSection();

    fireEvent.click(screen.getByTestId('remove-person-u-editor'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('people-inline-confirm')).toBeNull();
    expect(members.write).not.toHaveBeenCalled();
  });

  it('says what a removal was refused with, and keeps the person on the list', async () => {
    await renderSection();
    members.write.mockResolvedValue({
      ok: false,
      error: 'The owner cannot be re-rolled or removed. Transfer ownership instead.',
    });

    fireEvent.click(screen.getByTestId('remove-person-u-editor'));
    fireEvent.click(screen.getByTestId('confirm-remove-u-editor'));

    expect(await screen.findByRole('status')).toHaveTextContent('Transfer ownership instead');
    expect(screen.getAllByTestId('preview-person')).toHaveLength(2);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
