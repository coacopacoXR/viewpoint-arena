// The variant actions as a person meets them — components/review/VariantActions.tsx.
//
// docs/plan/15-sessions-and-variants.md batch BL, generalised by batch BX. The decisions
// themselves are pinned elsewhere: who may act in api/reviews/__tests__/lines.test.ts, and
// which model a line ends up showing in lib/reviews/__tests__/adopt.test.ts. What is pinned
// here is the SHAPE of asking, because that is the part the plan is most particular about:
//
//   * "Explore a variant from here" asks for a short name, says WHICH line and which meeting
//     the variant leaves from, and then opens the variant's own room — a different room, so
//     the meeting exploring it cannot move a model on another line's screen.
//   * "Drop variant" asks for a one-line reason, which is the sentence that ends up on every
//     card the drop closes.
//   * A variant that has already been merged or dropped offers nothing at all, and neither
//     does a review the person may not edit — hidden rather than disabled, because the
//     endpoint would refuse the press anyway.
//
// "Merge into…" and the chooser it opens are mergeChooser.test.tsx: batch BX turned that one
// button into a choice of destination, and the choice has more cases than the rest of this
// file put together.
//
// The client and the line cache are faked; the component under test is the real one,
// including its prompts.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const { client, repo } = vi.hoisted(() => ({
  client: {
    explore: vi.fn(),
    adopt: vi.fn(),
    drop: vi.fn(),
  },
  repo: {
    lines: { current: [] as unknown[] },
    resets: 0,
  },
}));

vi.mock('../../../lib/reviews/linesClient', () => ({
  exploreVariant: (...args: unknown[]) => client.explore(...args),
  adoptVariant: (...args: unknown[]) => client.adopt(...args),
  dropVariant: (...args: unknown[]) => client.drop(...args),
}));

vi.mock('../../../lib/reviews/linesRepo', () => ({
  resetLineCache: () => { repo.resets += 1; },
  // Batch BX: the merge chooser lists every line still being explored, so VariantActions
  // reads them when the host hands it none. Answering none is the case it has to survive
  // anyway, and mergeChooser.test.tsx is where the list itself is pinned.
  listLines: async () => repo.lines.current,
}));

import { ExploreVariantButton, VariantActions } from '../VariantActions';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

const REVIEW = 'rev-1';

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
  return {
    id: 'line-a', reviewId: REVIEW, kind: 'variant', name: 'Steel hinge pin', letter: 'A',
    parentSessionId: 'sess-3',
    // Batch BX: where a line was started from and where it went are columns of their own,
    // and a fixture without all three is not a ReviewLine any more.
    parentLineId: 'line-main', mergedIntoLineId: null, dropReason: null,
    status: 'active', createdBy: null, createdByName: 'Robin',
    createdAt: '2026-05-04T09:00:00.000Z', closedAt: null, ...overrides,
  };
}

const MAIN = line({
  id: 'line-main', kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, createdAt: '2026-05-01T09:00:00.000Z',
});
/** Variant A: the line the "impossible before batch BX" case is explored from. */
const A = line({});

/** S3, a meeting of the MAIN line — the only kind a variant could leave from before. */
const SESSION: LineSession = {
  id: 'sess-3', title: 'Hinge review', endedAt: '2026-05-03T16:00:00.000Z', participantCount: 4,
  modelName: 'Bracket', lineId: 'line-main', seq: 3, revisionIds: ['r-b'], summary: null,
};

/** A1, a meeting OF A VARIANT: where "Explore a variant from here" could not be offered. */
const VARIANT_SESSION: LineSession = {
  id: 'sess-a1', title: 'Glass-filled nylon', endedAt: '2026-05-05T16:00:00.000Z', participantCount: 2,
  modelName: 'Bracket', lineId: 'line-a', seq: 1, revisionIds: ['r-b2'], summary: null,
};

const Where: React.FC = () => {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
};

function renderIn(node: React.ReactElement, at = `/room/${REVIEW}`) {
  return render(<MemoryRouter initialEntries={[at]}>{node}<Where /></MemoryRouter>);
}

beforeEach(() => {
  client.explore.mockReset();
  client.adopt.mockReset();
  client.drop.mockReset();
  repo.resets = 0;
  repo.lines.current = [MAIN, A];
  // lib/reviews/openLine refuses to enter a room for a browser with no stored name and
  // sends it to the lobby to be asked for one. That is the right behaviour in the app and
  // a bounce to nowhere in a test of where starting a variant leaves you.
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
});

afterEach(cleanup);

// ─── Explore a variant from here ────────────────────────────────────────────

describe('Explore a variant from here', () => {
  it('is not offered to somebody who may not edit the review', () => {
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} mayEdit={false} />);
    expect(screen.queryByText('Explore a variant from here')).toBeNull();
  });

  it('asks for a short name before it does anything', () => {
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    expect(screen.getByPlaceholderText('Steel hinge pin')).toBeTruthy();
    expect(client.explore).not.toHaveBeenCalled();
  });

  it('says which line and which meeting the variant leaves from', () => {
    // The person pressing this is about to start a meeting on a copy of a model, and on a
    // review with more than one line the question "a variant of WHAT" has more than one
    // answer. A prompt that did not say would leave them finding out after the write.
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={VARIANT_SESSION} line={A} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    expect(screen.getByText('New variant from Variant A · Glass-filled nylon')).toBeTruthy();
  });

  it('starts the variant from a MAIN-LINE session, naming both halves of where it leaves from', async () => {
    client.explore.mockResolvedValue({ ok: true, line: line({ id: 'line-new', letter: 'B' }) });
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} line={MAIN} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    fireEvent.change(screen.getByPlaceholderText('Steel hinge pin'), { target: { value: 'Glass-filled nylon' } });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => expect(client.explore).toHaveBeenCalledTimes(1));
    // Batch BX: the second argument is an OBJECT and carries the LINE beside the meeting.
    // It used to be the bare parentSessionId, and the line was implied by it — which is
    // exactly why the only line a variant could be started from was the main one.
    expect(client.explore).toHaveBeenCalledWith(
      REVIEW, { parentSessionId: 'sess-3', parentLineId: 'line-main' }, 'Glass-filled nylon',
      { isMeetingHost: undefined },
    );
    // A different room, and the address says which line it is: /room/<id>?line=<id>.
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}?line=line-new`));
    // The cache held the lines as they were before this write, and the room the navigation
    // opens resolves its own line through it.
    expect(repo.resets).toBe(1);
  });

  it('starts the variant from ANOTHER VARIANT’s session — the case that was impossible before', async () => {
    client.explore.mockResolvedValue({ ok: true, line: line({ id: 'line-new', letter: 'B', parentLineId: 'line-a' }) });
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={VARIANT_SESSION} line={A} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    fireEvent.change(screen.getByPlaceholderText('Steel hinge pin'), { target: { value: 'Glass-filled nylon' } });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => expect(client.explore).toHaveBeenCalledTimes(1));
    // parentLineId is the half the new room reads its model, its saved positions and its
    // carried-over cards from. Sent as null here, the variant would open on the main line's
    // model — the one answer that is wrong exactly when the button is inside a variant.
    expect(client.explore.mock.calls[0][1]).toEqual({ parentSessionId: 'sess-a1', parentLineId: 'line-a' });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}?line=line-new`));
  });

  it('names no line when the host does not know which one the session is on', async () => {
    // A session recorded before lines existed has a meeting and no line, and null is the
    // honest answer: the endpoint then reads it as the main line, which is the only place
    // such a meeting could have been held.
    client.explore.mockResolvedValue({ ok: true, line: line({ id: 'line-new', letter: 'B' }) });
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    fireEvent.change(screen.getByPlaceholderText('Steel hinge pin'), { target: { value: 'Glass-filled nylon' } });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => expect(client.explore).toHaveBeenCalledTimes(1));
    expect(client.explore.mock.calls[0][1]).toEqual({ parentSessionId: 'sess-3', parentLineId: null });
  });

  it('opens through the host when the host has its own way into a room', async () => {
    client.explore.mockResolvedValue({ ok: true, line: line({ id: 'line-new', letter: 'B' }) });
    // The lobby has a name form to submit first and opens through its own enterRoom; every
    // other host omits this and lib/reviews/openLine is used.
    const opened = vi.fn<(lineId: string | null) => void>();
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} line={MAIN} mayEdit onOpenLine={opened} />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    fireEvent.change(screen.getByPlaceholderText('Steel hinge pin'), { target: { value: 'Glass-filled nylon' } });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => expect(opened).toHaveBeenCalledWith('line-new'));
    expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}`);
  });

  it('shows the sentence it was refused with, and stays where it was', async () => {
    client.explore.mockResolvedValue({ ok: false, error: 'Only the owner and the editors of this design review can start, adopt or drop a variant.' });
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    fireEvent.change(screen.getByPlaceholderText('Steel hinge pin'), { target: { value: 'Glass-filled nylon' } });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => expect(screen.getByText(/Only the owner and the editors/)).toBeTruthy());
    expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}`);
  });

  it('will not start a variant nobody named', () => {
    renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    expect(screen.getByText('Start')).toHaveProperty('disabled', true);
  });
});

// ─── Merge into… and Drop variant ───────────────────────────────────────────

describe('the two decisions on a variant', () => {
  it('offers a merge with somewhere to go, and a drop', () => {
    // Batch BX changed the first of these. "Adopt into main line" was a button that wrote
    // at once, because there was only ever one place a variant could go; a merge now has a
    // destination to pick, so the button is "Merge into…" and it opens a chooser rather
    // than writing — see mergeChooser.test.tsx.
    renderIn(<VariantActions reviewId={REVIEW} variant={A} lines={[MAIN, A]} mayEdit />);
    expect(screen.getByTestId('merge-variant').textContent).toBe('Merge into…');
    expect(screen.getByTestId('drop-variant-open').textContent).toBe('Drop variant');
    expect(screen.queryByText('Adopt into main line')).toBeNull();
  });

  it('is not offered for a variant that has already been merged', () => {
    // Offering to merge a variant that has already been merged is how a review ends up with
    // two sets of cards claiming the same decision.
    renderIn(<VariantActions reviewId={REVIEW} variant={line({ status: 'adopted', mergedIntoLineId: 'line-main', closedAt: '2026-05-08T09:00:00.000Z' })} mayEdit />);
    expect(screen.queryByText('Merge into…')).toBeNull();
    expect(screen.queryByText('Drop variant')).toBeNull();
  });

  it('is not offered for a variant that has already been dropped', () => {
    renderIn(<VariantActions reviewId={REVIEW} variant={line({ status: 'dropped', dropReason: 'Too expensive to tool', closedAt: '2026-05-08T09:00:00.000Z' })} mayEdit />);
    expect(screen.queryByText('Merge into…')).toBeNull();
    expect(screen.queryByText('Drop variant')).toBeNull();
  });

  it('is not offered to somebody who may not edit the review', () => {
    renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit={false} />);
    expect(screen.queryByText('Merge into…')).toBeNull();
    expect(screen.queryByText('Drop variant')).toBeNull();
  });
});

// ─── Drop variant ───────────────────────────────────────────────────────────

describe('Drop variant', () => {
  it('asks for the one-line reason first', () => {
    renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit />);
    fireEvent.click(screen.getByText('Drop variant'));
    expect(screen.getByPlaceholderText('Too expensive to tool')).toBeTruthy();
    expect(client.drop).not.toHaveBeenCalled();
  });

  it('sends the reason the meeting gave', async () => {
    client.drop.mockResolvedValue({ ok: true, changed: 2 });
    renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit />);
    fireEvent.click(screen.getByText('Drop variant'));
    fireEvent.change(screen.getByPlaceholderText('Too expensive to tool'), { target: { value: 'Too expensive to tool' } });
    fireEvent.click(screen.getByText('Drop it'));

    await waitFor(() => expect(client.drop).toHaveBeenCalledTimes(1));
    expect(client.drop.mock.calls[0][0]).toBe(REVIEW);
    expect(client.drop.mock.calls[0][1]).toBe('line-a');
    expect(client.drop.mock.calls[0][2]).toBe('Too expensive to tool');
  });

  it('will not drop a variant without saying why', () => {
    renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit />);
    fireEvent.click(screen.getByText('Drop variant'));
    expect(screen.getByText('Drop it')).toHaveProperty('disabled', true);
  });

  it('says that the cards close with the reason and the variant stays on the map', () => {
    // The person dropping it has to know it is not a delete: the risks are closed, not
    // lost, and the line stays there greyed.
    renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit />);
    fireEvent.click(screen.getByText('Drop variant'));
    expect(screen.getByText(/Its open cards close with this reason on them/)).toBeTruthy();
    expect(screen.getByText(/It stays on the map, greyed, for the record/)).toBeTruthy();
  });

  it('leaves the room for the main line once the variant has been dropped', async () => {
    client.drop.mockResolvedValue({ ok: true, changed: 2 });
    renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit inRoom />, `/room/${REVIEW}?line=line-a`);
    fireEvent.click(screen.getByText('Drop variant'));
    fireEvent.change(screen.getByPlaceholderText('Too expensive to tool'), { target: { value: 'Too expensive to tool' } });
    fireEvent.click(screen.getByText('Drop it'));

    // A dropped variant has no room to be in either, and its cards went nowhere: the
    // meeting continues on the main line, whose address carries no ?line=.
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}`));
  });
});

// ─── The words ──────────────────────────────────────────────────────────────

describe('the words on screen', () => {
  it('never say branch, fork or commit — in a button, a prompt, a list or a question', async () => {
    // "merge" is no longer in this list, and that is batch BX rather than a slip: the user
    // asked for a variant that could be taken into another variant and described it as
    // "merged", so it is their own word for the action and the word on the button. The
    // three that stay banned are the ones that would make this look like git.
    const forbidden = /branch|fork|commit/;

    const choosing = renderIn(<VariantActions reviewId={REVIEW} variant={A} lines={[MAIN, A]} mayEdit />);
    fireEvent.click(screen.getByTestId('merge-variant'));
    await waitFor(() => expect(screen.getByTestId('merge-chooser')).toBeTruthy());
    expect((choosing.container.textContent ?? '').toLowerCase()).not.toMatch(forbidden);
    cleanup();

    const asking = renderIn(<VariantActions reviewId={REVIEW} variant={A} lines={[MAIN, A]} mayEdit />);
    client.adopt.mockResolvedValueOnce({ ok: false, question: 'Keep Rev C from the main line or Rev B2 from Variant A?' });
    fireEvent.click(screen.getByTestId('merge-variant'));
    await waitFor(() => expect(screen.getByTestId('merge-go')).toBeTruthy());
    fireEvent.click(screen.getByTestId('merge-go'));
    await waitFor(() => expect(screen.getByText('Not now')).toBeTruthy());
    expect((asking.container.textContent ?? '').toLowerCase()).not.toMatch(forbidden);
    cleanup();

    const exploring = renderIn(<ExploreVariantButton reviewId={REVIEW} session={SESSION} line={MAIN} mayEdit />);
    fireEvent.click(screen.getByText('Explore a variant from here'));
    expect((exploring.container.textContent ?? '').toLowerCase()).not.toMatch(forbidden);
    cleanup();

    const dropping = renderIn(<VariantActions reviewId={REVIEW} variant={A} mayEdit />);
    fireEvent.click(screen.getByText('Drop variant'));
    expect((dropping.container.textContent ?? '').toLowerCase()).not.toMatch(forbidden);
  });
});
