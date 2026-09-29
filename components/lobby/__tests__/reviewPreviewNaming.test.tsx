// The preview panel's two new answers: name this review, and start a variant of it.
//
// docs/plan/15-sessions-and-variants.md batch BQ. The panel could already open a review,
// show its meetings and delete it; what it could not do was CHANGE it, which is why every
// review in the lobby was called "Untitled design review" and why the only way to start a
// variant was three clicks deep inside the Sessions map.
//
// What is pinned here is the two things a lobby-only surface has to get right that the
// room does not:
//
//   * WHO. `mayEdit` is `can(role, 'editReview')` — the owner and the editors, and NOT
//     the wider `mayDelete` (the owner and this install's admins). An editor may name a
//     review and start a variant of it but may not delete it, and the two flags are
//     deliberately different props so neither inherits the other's answer.
//   * THE WRITE. One column, through lib/curationsRepo.renameCuration. This panel holds
//     a SUMMARY of the review, so a whole-draft save from here would upsert the row
//     without the viewpoints, pins and agenda it never read.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LobbyReview } from '../../../lib/lobby/useLobbyData';
import type { LineSession, SessionCardRef } from '../../../lib/reviews/linesRepo';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { ModelRevision } from '../../../lib/reviews/revisionsRepo';

const { mapData, renames, repo, explore, viewer } = vi.hoisted(() => ({
  mapData: {
    current: {
      lines: [] as ReviewLine[],
      sessions: [] as LineSession[],
      revisions: [] as ModelRevision[],
      cards: [] as SessionCardRef[],
      loading: false,
      refresh: () => {},
    },
  },
  renames: { call: vi.fn() },
  repo: { lines: { current: [] as ReviewLine[] }, origin: { current: null as LineSession | null } },
  explore: { call: vi.fn() },
  viewer: { imports: 0 },
}));

vi.mock('../../../lib/reviews/useSessionMap', () => ({
  useSessionMap: () => mapData.current,
}));

vi.mock('../../../lib/reviews/deleteClient', () => ({
  deleteReview: vi.fn(async () => ({ ok: true, sessions: 0, items: 0 })),
  deleteSession: vi.fn(async () => ({ ok: true, items: 0 })),
}));

// The rename goes through curationsRepo, and ONLY the rename is faked: the rest of the
// module is spread in because lib/lobby and the panel's other reads reach it.
vi.mock('../../../lib/curationsRepo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/curationsRepo')>()),
  renameCuration: (id: string, title: string) => renames.call(id, title),
}));

// The "+ Variant" button's two reads and its one write.
vi.mock('../../../lib/reviews/linesRepo', () => ({
  listLines: vi.fn(async () => repo.lines.current),
  lineOriginSession: vi.fn(async () => repo.origin.current),
  resetLineCache: () => {},
}));

vi.mock('../../../lib/reviews/linesClient', () => ({
  exploreVariant: (...args: unknown[]) => explore.call(...args),
}));

// three.js, which this file never asks for: the viewer is lazy and no test below presses
// "Turn in 3D".
vi.mock('../ReviewModelViewer', () => {
  viewer.imports += 1;
  return { default: () => <div data-testid="viewer-3d" /> };
});

const ReviewPreview = (await import('../ReviewPreview')).default;

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: 'r1', kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-09-20T09:00:00.000Z', closedAt: null,
};

const SESSION: LineSession = {
  id: 'sess-3', title: 'Cycle test', endedAt: '2026-09-24T16:00:00.000Z', participantCount: 2,
  attendeeNames: ['Robin', 'Maria'], modelName: 'hinge.glb', lineId: 'line-main',
  seq: 3, revisionIds: ['r-c'], summary: null,
};

function review(over: Partial<LobbyReview> = {}): LobbyReview {
  return {
    id: 'r1', title: 'Door hinge, rev C', description: '', thumbnail: null,
    modelName: 'hinge.glb', updatedAt: '2026-09-24T09:00:00.000Z', createdAt: '2026-09-01T09:00:00.000Z',
    archived: false, listed: true, memberRole: 'owner', mine: true, visited: true,
    lastVisitedAt: '2026-09-24T09:00:00.000Z',
    sessions: [], lines: [], openCards: { RISK: 0, ACTION: 0, RATIONALE: 0 }, revision: 'Rev C',
    ...over,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof ReviewPreview>> = {}) {
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ReviewPreview
        review={review()}
        mayDelete
        mayEdit
        onChanged={onChanged}
        onOpen={() => {}}
        onDeleted={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onChanged };
}

beforeEach(() => {
  mapData.current = {
    lines: [MAIN], sessions: [SESSION], revisions: [], cards: [], loading: false, refresh: () => {},
  };
  repo.lines.current = [MAIN];
  repo.origin.current = SESSION;
  renames.call.mockReset().mockResolvedValue({ ok: true });
  explore.call.mockReset().mockResolvedValue({
    ok: true,
    line: { ...MAIN, id: 'line-a', kind: 'variant', name: 'Steel hinge pin', letter: 'A' },
  });
});

afterEach(cleanup);

describe('the preview panel — naming the review', () => {
  it('offers the name as something you can change, to somebody who may', async () => {
    const { onChanged } = renderPanel({ mayEdit: true });

    fireEvent.click(screen.getByTestId('preview-title-edit'));
    const field = screen.getByTestId('preview-title-field');
    // Prefilled with the name it has, because renaming is an edit of that name and not a
    // fresh start.
    expect(field).toHaveValue('Door hinge, rev C');
    expect(renames.call).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '  Hinge, supplier change  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(renames.call).toHaveBeenCalledTimes(1));
    expect(renames.call.mock.calls[0]).toEqual(['r1', 'Hinge, supplier change']);
    // The card in the grid reads the name out of the grid's rows, so the re-read is what
    // makes the two agree.
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('writes one column, and keeps the name it had when the field is emptied', async () => {
    renderPanel({ mayEdit: true });

    fireEvent.click(screen.getByTestId('preview-title-edit'));
    fireEvent.change(screen.getByTestId('preview-title-field'), { target: { value: '   ' } });
    fireEvent.keyDown(screen.getByTestId('preview-title-field'), { key: 'Enter' });

    await act(async () => {});
    // Not a decision to call the review nothing.
    expect(renames.call).not.toHaveBeenCalled();
    expect(screen.getByTestId('preview-title')).toHaveTextContent('Door hinge, rev C');
  });

  it('says what a refused rename said, and keeps the old name on screen', async () => {
    renames.call.mockResolvedValue({ ok: false, error: 'Give the design review a name.' });
    renderPanel({ mayEdit: true });

    fireEvent.click(screen.getByTestId('preview-title-edit'));
    fireEvent.change(screen.getByTestId('preview-title-field'), { target: { value: 'x'.repeat(400) } });
    fireEvent.keyDown(screen.getByTestId('preview-title-field'), { key: 'Enter' });

    expect(await screen.findByRole('status')).toHaveTextContent('Give the design review a name.');
  });

  it('is not offered to somebody who may not change the review', () => {
    // A participant, and — narrower than `mayDelete` in the other direction — this is not
    // the same question the delete answers.
    renderPanel({ mayEdit: false });

    expect(screen.queryByTestId('preview-title-edit')).toBeNull();
    expect(screen.getByTestId('preview-title')).toHaveTextContent('Door hinge, rev C');
  });

  it('changes nothing when the rename is escaped', () => {
    renderPanel({ mayEdit: true });

    fireEvent.click(screen.getByTestId('preview-title-edit'));
    fireEvent.change(screen.getByTestId('preview-title-field'), { target: { value: 'Something else' } });
    fireEvent.keyDown(screen.getByTestId('preview-title-field'), { key: 'Escape' });

    expect(screen.queryByTestId('preview-title-field')).toBeNull();
    expect(renames.call).not.toHaveBeenCalled();
  });
});

describe('the preview panel — starting a variant', () => {
  it('offers it beside "Open room", to the same people the room offers it to', async () => {
    renderPanel({ mayEdit: true });

    const button = screen.getByTestId('preview-variant');
    expect(button).toHaveTextContent('+ Variant');
    // The word on screen is "Variant" and never the programming one the icon suggests.
    expect(button.textContent?.toLowerCase()).not.toMatch(/branch|fork/);
    expect(screen.getByTestId('preview-open-room')).toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId('start-variant-origin')).toHaveTextContent('Starts from: S3');
    });

    fireEvent.change(screen.getByTestId('start-variant-field'), { target: { value: 'Steel hinge pin' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-variant-go'));
    });

    expect(explore.call).toHaveBeenCalledTimes(1);
    // Both halves of where the variant leaves from: the MEETING, which is what the map
    // draws the branch leaving from, and the LINE, which is what the new room reads its
    // model, its saved positions and its carried-over cards from. Batch BX is what split
    // the two apart — before it the line was implied by the meeting and could therefore
    // only ever be the main one, which is exactly why a variant of a variant was
    // impossible and why every variant branched off the top row of the map.
    expect(explore.call.mock.calls[0][1]).toEqual({
      parentSessionId: 'sess-3',
      parentLineId: 'line-main',
    });
  });

  it('is not offered to somebody who may not change the review', () => {
    renderPanel({ mayEdit: false });
    expect(screen.queryByTestId('preview-variant')).toBeNull();
    // The way in survives: entering a review is not changing it.
    expect(screen.getByTestId('preview-open-room')).toBeInTheDocument();
  });
});
