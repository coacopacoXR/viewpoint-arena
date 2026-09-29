// The session map's "Delete session" — one meeting, and the cards raised in it.
//
// docs/plan/15-sessions-and-variants.md batch BN. What is pinned here is the four
// things a destructive action in a meeting has to get right:
//
//   * it is offered to the people the endpoint would let act, and to nobody else —
//     `mayDelete` is `deleteReview` in lib/reviews/roles.ts, which is NARROWER than the
//     `mayEditLines` the variant actions are offered on;
//   * it asks first, in the panel, naming the stop the way the map names it and saying
//     how many cards go with it — never window.confirm, which cannot be styled to the
//     panel it belongs to, cannot be tested, and freezes the room behind it;
//   * nothing is sent until the question is answered, and Cancel is a real answer;
//   * a refusal is shown where it happened and the map is left alone, because a map that
//     reloads after a delete that did not happen says the meeting is gone when it is not.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { client } = vi.hoisted(() => ({
  client: { session: vi.fn() },
}));

vi.mock('../../../lib/reviews/deleteClient', () => ({
  deleteSession: (...args: unknown[]) => client.session(...args),
  deleteReview: vi.fn(),
}));

// SessionMap reaches nothing but this from the repo; the map is fed its data by props.
vi.mock('../../../lib/reviews/linesRepo', () => ({
  resetLineCache: () => undefined,
}));

import SessionMap from '../SessionMap';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession, SessionCardRef } from '../../../lib/reviews/linesRepo';

const REVIEW = 'rev-1';
const MAIN_ID = 'line-main';

const MAIN: ReviewLine = {
  id: MAIN_ID, reviewId: REVIEW, kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null, status: 'active', createdBy: null, createdByName: '',
  createdAt: '2026-03-01T09:00:00.000Z', closedAt: null,
};

function session(id: string, seq: number, endedAt: string): LineSession {
  return {
    id, title: `Design Review — ${id}`, endedAt, participantCount: 4, modelName: 'Bracket',
    lineId: MAIN_ID, seq, revisionIds: [], summary: null,
  };
}

const SESSIONS: LineSession[] = [
  session('sess-1', 1, '2026-05-01T16:00:00.000Z'),
  session('sess-2', 2, '2026-05-03T16:00:00.000Z'),
  session('sess-3', 3, '2026-05-07T16:00:00.000Z'),
];

function card(id: string, sessionId: string): SessionCardRef {
  return {
    id, sessionId, type: 'RISK', title: `Card ${id}`, status: 'Open', priority: 'Medium',
    lineId: MAIN_ID, originLineId: MAIN_ID,
  };
}

/** Three cards in S2, one in S3 — the number the confirm has to say. */
const CARDS: SessionCardRef[] = [
  card('c-1', 'sess-2'),
  card('c-2', 'sess-2'),
  card('c-3', 'sess-2'),
  card('c-4', 'sess-3'),
];

const BLOCKED = 'Variant A starts from this session. Delete or drop the variant’s sessions first.';

function renderMap(props: Partial<React.ComponentProps<typeof SessionMap>> = {}) {
  return render(
    <MemoryRouter>
      <SessionMap
        reviewTitle="Bracket assembly"
        lines={[MAIN]}
        sessions={SESSIONS}
        cards={CARDS}
        reviewId={REVIEW}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** Open the panel on one stop. The drawing comes first, so the stop is the first match. */
function openStop(label: string) {
  fireEvent.click(screen.getAllByText(label)[0]);
  expect(screen.getByText('Attended')).toBeTruthy();
}

function deleteButton() {
  return screen.getByRole('button', { name: /Delete session/ });
}

beforeEach(() => {
  client.session.mockReset().mockResolvedValue({ ok: true, items: 3 });
});

afterEach(cleanup);

describe('the session map — who is offered a delete', () => {
  it('is not offered at all when the room did not say this person may', () => {
    // The map is mounted in the tracker too, where there is no review to be the owner
    // of, and by an editor who may change the lines and may not unmake a meeting.
    renderMap({ mayDelete: false, mayEditLines: true });
    openStop('S2');

    expect(screen.queryByRole('button', { name: /Delete session/ })).toBeNull();
  });

  it('is offered to the people the endpoint would let act', () => {
    renderMap({ mayDelete: true });
    openStop('S2');

    expect(deleteButton()).toBeInTheDocument();
  });

  it('is not offered when the map has no review to delete from', () => {
    renderMap({ mayDelete: true, reviewId: null });
    openStop('S2');

    expect(screen.queryByRole('button', { name: /Delete session/ })).toBeNull();
  });
});

describe('the session map — asking before it deletes', () => {
  it('asks in the panel, naming the stop and how many cards go with it', () => {
    renderMap({ mayDelete: true });
    openStop('S2');
    fireEvent.click(deleteButton());

    expect(screen.getByTestId('delete-session')).toBeInTheDocument();
    expect(screen.getByText(/Delete S2 and its 3 cards\? This cannot be undone\./)).toBeInTheDocument();
    expect(client.session).not.toHaveBeenCalled();
  });

  it('never asks with window.confirm', () => {
    // It cannot be styled to the panel it belongs to, it cannot be tested, and it
    // freezes the room behind it while it waits for an answer.
    const confirm = vi.spyOn(window, 'confirm');
    renderMap({ mayDelete: true });
    openStop('S2');
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('cancels, and deletes nothing', async () => {
    renderMap({ mayDelete: true });
    openStop('S2');
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(client.session).not.toHaveBeenCalled());
    expect(screen.queryByTestId('delete-session')).toBeNull();
    // The panel is still open on the same meeting, because nothing happened to it.
    expect(screen.getByText('Attended')).toBeInTheDocument();
  });

  it('says S2 rather than "session 2", because that is what the map draws', () => {
    // The number in the sentence has to be the one the person can see on the stop they
    // clicked, or the confirm is asking about a meeting they cannot find.
    renderMap({ mayDelete: true });
    openStop('S3');
    fireEvent.click(deleteButton());

    expect(screen.getByText(/Delete S3 and its 1 card\? This cannot be undone\./)).toBeInTheDocument();
  });
});

describe('the session map — deleting', () => {
  it('sends the review, the session and whether this browser is running the meeting', async () => {
    // `isMeetingHost` is the one fact the endpoint cannot work out for itself, and the
    // one that decides a delete on the default self-hosted install, where there is no
    // token to check.
    renderMap({ mayDelete: true, isMeetingHost: true });
    openStop('S2');
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(client.session).toHaveBeenCalledTimes(1));
    expect(client.session.mock.calls[0][0]).toBe(REVIEW);
    expect(client.session.mock.calls[0][1]).toBe('sess-2');
    expect(client.session.mock.calls[0][2]).toEqual({ isMeetingHost: true });
  });

  it('closes the panel and reloads the map when the delete lands', async () => {
    const onChanged = vi.fn();
    renderMap({ mayDelete: true, onChanged });
    openStop('S2');
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // The stop is gone, so the panel that was open on it has nothing to show; leaving it
    // open would be a panel about a meeting that no longer exists.
    expect(screen.queryByText('Attended')).toBeNull();
  });

  it('says what the endpoint said when it refuses, and leaves the map alone', async () => {
    const onChanged = vi.fn();
    client.session.mockResolvedValue({ ok: false, error: BLOCKED });
    renderMap({ mayDelete: true, onChanged });
    openStop('S2');
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText(BLOCKED)).toBeInTheDocument());
    // A map that reloads after a delete that did not happen says the meeting is gone
    // when it is not, and the sentence would be pointing at nothing.
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText('Attended')).toBeInTheDocument();
  });

  it('says something when the endpoint answers nothing at all', async () => {
    client.session.mockResolvedValue({ ok: false });
    renderMap({ mayDelete: true });
    openStop('S2');
    fireEvent.click(deleteButton());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByText('That session could not be deleted.')).toBeInTheDocument();
    });
  });
});
