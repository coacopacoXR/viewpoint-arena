// The merge chooser — the "Merge into…" half of components/review/VariantActions.tsx.
//
// docs/plan/15-sessions-and-variants.md batch BX. Until this batch a variant could only
// ever be taken into the review's MAIN line, so the action was one button that wrote at
// once and the only thing it could ask was the endpoint's model question. A merge now has
// a DESTINATION and the destination is a choice, so the button opens a chooser — and the
// choice is what is pinned here:
//
//   * WHICH lines are in it. Every line still being explored, minus this variant and minus
//     its own variants: merging a line into one of its own descendants would make the
//     descendant its own ancestor, and every card on both would end up on a line whose
//     history runs in a circle. Dropped and merged lines are not in it either, because a
//     row in a chooser is an offer to write somewhere and a closed line is nowhere.
//   * WHICH one is already selected. The line the variant was started from, and the main
//     line when that one has itself been closed — a chooser that opens with nothing
//     selected makes somebody read a list before they can press the obvious thing.
//   * THE EXACT ARGUMENTS the confirm sends, `keep: null` first. The endpoint reads a
//     missing target as "the main line", so a chooser that sent nothing would merge into
//     a line nobody picked and move every card there.
//   * And the ONE plain question, whose two answers must name the target. A question that
//     said "the main line's" about a merge into Variant A would ask somebody to choose
//     between two models and then write the answer onto a third.
//
// The rest of VariantActions — "Explore a variant from here", "Drop variant", and who is
// offered any of it — is variantActions.test.tsx.
//
// The client, the line cache and the line read are faked; the chooser is the real one.

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
  // VariantActions reads the review's lines itself when the host hands it none, which is
  // the case for the two hosts that are not already drawing the map.
  listLines: async () => repo.lines.current,
}));

import { VariantActions } from '../VariantActions';
import type { ReviewLine } from '../../../lib/reviews/lines';

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
/** The variant under the chooser in most of these tests: started from the main line. */
const A = line({});
/** A variant of Variant A — batch BX is what made this a thing the data can hold. */
const B = line({
  id: 'line-b', letter: 'B', name: 'Glass-filled nylon', parentLineId: 'line-a',
  parentSessionId: null, createdAt: '2026-05-05T09:00:00.000Z',
});
/** A second variant of the main line: somewhere to merge that is not the main line. */
const D = line({
  id: 'line-d', letter: 'D', name: 'Titanium pin', parentSessionId: 'sess-4',
  createdAt: '2026-05-06T09:00:00.000Z',
});
const DROPPED = line({
  id: 'line-c', letter: 'C', name: 'Old idea', status: 'dropped',
  dropReason: 'Dropped with Variant C: Too expensive to tool',
  closedAt: '2026-05-07T09:00:00.000Z', createdAt: '2026-05-03T09:00:00.000Z',
});

/** Stands in for the room a navigation lands in, so the address can be read. */
const Where: React.FC = () => {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
};

function renderChooser(props: Partial<React.ComponentProps<typeof VariantActions>> = {}, at = `/room/${REVIEW}`) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <VariantActions reviewId={REVIEW} variant={A} lines={[MAIN, A, B, D, DROPPED]} mayEdit {...props} />
      <Where />
    </MemoryRouter>,
  );
}

/** Open the chooser, and wait for the list of targets to be on screen. */
async function openChooser(): Promise<void> {
  fireEvent.click(screen.getByTestId('merge-variant'));
  await waitFor(() => expect(screen.getByTestId('merge-chooser')).toBeTruthy());
}

/** The ids the chooser is offering, in the order it offers them. */
function offeredIds(): Array<string | null> {
  return screen.getAllByTestId('merge-target').map((row) => row.getAttribute('data-line'));
}

function rowFor(lineId: string): HTMLElement {
  const row = screen
    .getAllByTestId('merge-target')
    .find((each) => each.getAttribute('data-line') === lineId);
  if (!row) throw new Error(`the chooser is not offering ${lineId}`);
  return row;
}

beforeEach(() => {
  client.explore.mockReset();
  client.adopt.mockReset();
  client.drop.mockReset();
  repo.resets = 0;
  repo.lines.current = [MAIN, A, B, D, DROPPED];
  // lib/reviews/openLine refuses to enter a room for a browser with no stored name and
  // sends it to the lobby instead, which is the right behaviour in the app and a bounce
  // to nowhere in a test of where a merge leaves you.
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
});

afterEach(cleanup);

// ─── What the chooser offers ────────────────────────────────────────────────

describe('the merge chooser — what it offers', () => {
  it('lists every line still being explored except this variant and its own, main line first', async () => {
    renderChooser();
    await openChooser();

    // B is A's own variant, and DROPPED is finished with: neither is somewhere a merge
    // can go. The main line is first because it is the answer nearly every time.
    expect(offeredIds()).toEqual(['line-main', 'line-d']);
    const chooser = screen.getByTestId('merge-chooser');
    expect(chooser.textContent).not.toContain('Glass-filled nylon');
    expect(chooser.textContent).not.toContain('Old idea');
  });

  it('names each target with where it came from, so two variants are not two identical rows', async () => {
    renderChooser();
    await openChooser();

    // A variant of a variant that read only "Variant D · Titanium pin" would look like a
    // second answer to the same question, and the point of exploring from another variant
    // is that it is a second answer to a DIFFERENT one.
    expect(rowFor('line-d').textContent).toContain('Variant D · Titanium pin · from Main line');
    expect(rowFor('line-main').textContent).toContain('Main line');
  });

  it('offers nothing, and says so, when every other line is one of its own', async () => {
    // The descendant rule seen from the other side: with only its own variant left, there
    // is nowhere to go, and the sentence is what stops that reading as a broken list.
    renderChooser({ variant: A, lines: [A, B] });
    await openChooser();

    expect(screen.getByText(/no other line still being explored to merge it into/)).toBeTruthy();
    expect(screen.queryByTestId('merge-targets')).toBeNull();
    expect(screen.queryByTestId('merge-go')).toBeNull();
  });

  it('says so rather than showing an empty list when the review’s lines cannot be read', async () => {
    // The dangerous version of this case: `targetLineId: null` means "the main line" to the
    // endpoint, so a chooser that offered a confirm button with no rows in it would merge
    // the variant into a line nobody chose. There is no button, so there is no write.
    repo.lines.current = [];
    renderChooser({ lines: undefined });
    await openChooser();

    await waitFor(() =>
      expect(screen.getByText(/no other line still being explored to merge it into/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('merge-go')).toBeNull();
    expect(client.adopt).not.toHaveBeenCalled();
  });
});

// ─── What is already selected ───────────────────────────────────────────────

describe('the merge chooser — what is already selected', () => {
  it('has the line the variant was started from selected, and says so on the button', async () => {
    renderChooser({ variant: B, lines: [MAIN, A, B] });
    await openChooser();

    expect(rowFor('line-a').getAttribute('aria-pressed')).toBe('true');
    expect(rowFor('line-main').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('merge-go').textContent).toBe('Merge into Variant A');
  });

  it('falls back to the main line when the line it was started from has been closed', async () => {
    // Its parent was itself merged, so the main line is where its own variants are going
    // to continue from — the same answer the merge gave for them.
    const closed = line({
      id: 'line-a', status: 'adopted', mergedIntoLineId: 'line-main',
      closedAt: '2026-05-08T09:00:00.000Z',
    });
    renderChooser({ variant: B, lines: [MAIN, closed, B, D] });
    await openChooser();

    expect(offeredIds()).toEqual(['line-main', 'line-d']);
    expect(rowFor('line-main').getAttribute('aria-pressed')).toBe('true');
    expect(rowFor('line-d').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('merge-go').textContent).toBe('Merge into the main line');
  });

  it('reads the review’s lines itself when the host hands it none', async () => {
    // The room's own chip reads its lines lazily and a map in the lobby may not have them
    // at all, so the chooser asks — and a chooser with no rows in it is a dead end.
    renderChooser({ lines: undefined });
    fireEvent.click(screen.getByTestId('merge-variant'));

    await waitFor(() => expect(screen.queryAllByTestId('merge-target').length).toBe(2));
    expect(offeredIds()).toEqual(['line-main', 'line-d']);
  });
});

// ─── What it sends ──────────────────────────────────────────────────────────

describe('the merge chooser — what it sends', () => {
  it('sends the line already selected, and no answer to a question nobody asked', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    const onChanged = vi.fn<() => void>();
    renderChooser({ onChanged });
    await openChooser();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(client.adopt).toHaveBeenCalledTimes(1));
    // keep null on the first post: the endpoint only needs it once it has asked, and a
    // 'target' sent up front would silently answer a question about a model nobody saw.
    expect(client.adopt).toHaveBeenCalledWith(
      REVIEW, 'line-a', { targetLineId: 'line-main', keep: null }, { isMeetingHost: undefined },
    );
    // The cache held the lines as they were before this write, and every reader — the map,
    // the tracker's filter, the room's own chip — resolves through it.
    expect(repo.resets).toBe(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('sends the line that was picked in the list instead', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    renderChooser();
    await openChooser();
    fireEvent.click(rowFor('line-d'));
    expect(screen.getByTestId('merge-go').textContent).toBe('Merge into Variant D');
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(client.adopt).toHaveBeenCalledTimes(1));
    expect(client.adopt).toHaveBeenCalledWith(
      REVIEW, 'line-a', { targetLineId: 'line-d', keep: null }, { isMeetingHost: undefined },
    );
  });

  it('passes the meeting-host claim on, for a deployment with no accounts to verify', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    renderChooser({ isMeetingHost: true });
    await openChooser();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(client.adopt).toHaveBeenCalledTimes(1));
    expect(client.adopt.mock.calls[0][3]).toEqual({ isMeetingHost: true });
  });

  it('shows the sentence it was refused with, and leaves the chooser open', async () => {
    client.adopt.mockResolvedValue({
      ok: false, error: 'Only the owner and the editors of this design review can merge a variant.',
    });
    renderChooser();
    await openChooser();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(screen.getByText(/Only the owner and the editors/)).toBeTruthy());
    expect(screen.getByTestId('merge-chooser')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}`);
  });
});

// ─── The one plain question ─────────────────────────────────────────────────

describe('the merge chooser — the one plain question', () => {
  const QUESTION = 'Keep Rev C from Variant A or Rev B2 from Variant B?';

  /** B merged into A: the case batch BX made possible and the case the words must follow. */
  function renderQuestion() {
    client.adopt
      .mockResolvedValueOnce({ ok: false, question: QUESTION })
      .mockResolvedValueOnce({ ok: true, changed: 3 });
    renderChooser({ variant: B, lines: [MAIN, A, B] });
    fireEvent.click(screen.getByTestId('merge-variant'));
  }

  it('asks the endpoint’s own question inline, and nothing else', async () => {
    renderQuestion();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());
    // Two answers and a way out. No side-by-side, no list of differences, no second
    // question — the buttons are the whole of the decision.
    expect(screen.getByText('Not now')).toBeTruthy();
    expect(screen.queryByTestId('merge-chooser')).toBeNull();
    expect(screen.queryByTestId('merge-variant')).toBeNull();
  });

  it('names the line the merge is going into, and not "the main line"', async () => {
    renderQuestion();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(screen.getByText(QUESTION)).toBeTruthy());
    expect(screen.getByText('Keep Variant A’s')).toBeTruthy();
    expect(screen.getByText('Take Variant B’s')).toBeTruthy();
    // The wording batch BL used, which would be a lie about a merge into Variant A: it
    // would ask somebody to choose between two models and write the answer onto a third.
    expect(screen.queryByText('Keep the main line’s')).toBeNull();
  });

  it('posts the same target again with keep "target" when that answer is chosen', async () => {
    renderQuestion();
    fireEvent.click(screen.getByTestId('merge-go'));
    await waitFor(() => expect(screen.getByText('Keep Variant A’s')).toBeTruthy());
    fireEvent.click(screen.getByText('Keep Variant A’s'));

    await waitFor(() => expect(client.adopt).toHaveBeenCalledTimes(2));
    expect(client.adopt).toHaveBeenNthCalledWith(
      2, REVIEW, 'line-b', { targetLineId: 'line-a', keep: 'target' }, { isMeetingHost: undefined },
    );
  });

  it('posts the same target again with keep "variant" when that answer is chosen', async () => {
    renderQuestion();
    fireEvent.click(screen.getByTestId('merge-go'));
    await waitFor(() => expect(screen.getByText('Take Variant B’s')).toBeTruthy());
    fireEvent.click(screen.getByText('Take Variant B’s'));

    await waitFor(() => expect(client.adopt).toHaveBeenCalledTimes(2));
    expect(client.adopt).toHaveBeenNthCalledWith(
      2, REVIEW, 'line-b', { targetLineId: 'line-a', keep: 'variant' }, { isMeetingHost: undefined },
    );
  });

  it('goes back to the chooser when the answer is "not now", and writes nothing more', async () => {
    client.adopt.mockResolvedValueOnce({ ok: false, question: QUESTION });
    renderChooser({ variant: B, lines: [MAIN, A, B] });
    fireEvent.click(screen.getByTestId('merge-variant'));
    await waitFor(() => expect(screen.getByTestId('merge-go')).toBeTruthy());
    fireEvent.click(screen.getByTestId('merge-go'));
    await waitFor(() => expect(screen.getByText('Not now')).toBeTruthy());
    fireEvent.click(screen.getByText('Not now'));

    // Batch BX changed this: "not now" used to put the two buttons back, because there was
    // nothing between them and the write. Now it puts the CHOOSER back, with the same line
    // still selected, which is the useful answer — the person who backed out of a question
    // about a model has not backed out of the merge. The chooser's own "Not now" is the way
    // out of that, and neither press writes anything.
    await waitFor(() => expect(screen.getByTestId('merge-chooser')).toBeTruthy());
    expect(rowFor('line-a').getAttribute('aria-pressed')).toBe('true');
    expect(client.adopt).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Not now'));
    await waitFor(() => expect(screen.getByTestId('merge-variant')).toBeTruthy());
    expect(client.adopt).toHaveBeenCalledTimes(1);
  });
});

// ─── Its own variants ───────────────────────────────────────────────────────

describe('the merge chooser — a variant that has variants', () => {
  it('says which of its own will continue from the target', async () => {
    renderChooser();
    await openChooser();

    // Not a warning and not a silent re-parenting: the person merging A has to know that B
    // is not lost by it, and that B's parent is about to be a line that has just closed.
    const children = screen.getByTestId('merge-children');
    expect((children.textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'Variant B, started from it, will continue from the main line.',
    );
  });

  it('follows the target that is selected', async () => {
    renderChooser();
    await openChooser();
    fireEvent.click(rowFor('line-d'));

    expect((screen.getByTestId('merge-children').textContent ?? '').replace(/\s+/g, ' ')).toContain(
      'continue from Variant D.',
    );
  });

  it('says nothing about children when it has none still being explored', async () => {
    // B was dropped with the reason on its cards, so it is not continuing anywhere and
    // naming it would be a sentence about a line that is over.
    renderChooser({
      variant: A,
      lines: [MAIN, A, line({ id: 'line-b', letter: 'B', name: 'Glass-filled nylon', parentLineId: 'line-a', status: 'dropped', dropReason: 'Too expensive to tool', closedAt: '2026-05-07T09:00:00.000Z' }), D],
    });
    await openChooser();

    expect(screen.queryByTestId('merge-children')).toBeNull();
  });
});

// ─── Where the meeting goes afterwards ──────────────────────────────────────

describe('the merge chooser — where the meeting goes afterwards', () => {
  it('leaves the room for the TARGET line’s room, not always the main one', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    // Arrived on the variant's own address, which is the only way to be in its room.
    renderChooser({ inRoom: true }, `/room/${REVIEW}?line=line-a`);
    await openChooser();
    fireEvent.click(rowFor('line-d'));
    fireEvent.click(screen.getByTestId('merge-go'));

    // A variant that has just been merged has no room to be in: its model and its cards are
    // on the target now, and the meeting continues there.
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}?line=line-d`));
  });

  it('leaves for the main line’s address — the one with no ?line= in it — when that was the target', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    renderChooser({ inRoom: true }, `/room/${REVIEW}?line=line-a`);
    await openChooser();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}`));
  });

  it('opens through the host when the host has its own way into a room', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    // The lobby has a name form to submit first and opens through its own enterRoom; the
    // main line travels as null, because its address deliberately carries no parameter.
    const opened = vi.fn<(lineId: string | null) => void>();
    renderChooser({ inRoom: true, onOpenLine: opened });
    await openChooser();
    fireEvent.click(rowFor('line-d'));
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(opened).toHaveBeenCalledWith('line-d'));
    expect(screen.getByTestId('where').textContent).toBe(`/room/${REVIEW}`);
  });

  it('does not move anybody when these actions are on a map', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    const opened = vi.fn<(lineId: string | null) => void>();
    // Not `inRoom`: the person pressed a button about a line they are not standing on, and
    // yanking them out of the map they were reading is not what they asked for.
    renderChooser({ onOpenLine: opened }, '/tracker');
    await openChooser();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(client.adopt).toHaveBeenCalledTimes(1));
    expect(opened).not.toHaveBeenCalled();
    expect(screen.getByTestId('where').textContent).toBe('/tracker');
  });

  it('closes the chooser once the merge has landed', async () => {
    client.adopt.mockResolvedValue({ ok: true, changed: 3 });
    renderChooser();
    await openChooser();
    fireEvent.click(screen.getByTestId('merge-go'));

    await waitFor(() => expect(screen.queryByTestId('merge-chooser')).toBeNull());
    expect(screen.getByTestId('merge-variant')).toBeTruthy();
  });
});
