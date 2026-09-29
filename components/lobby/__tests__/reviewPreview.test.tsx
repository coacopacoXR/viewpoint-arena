// The preview panel: seeing inside a design review without entering it.
//
// docs/plan/15-sessions-and-variants.md batch BO. Three things are pinned here.
//
// 1. WHAT IT SHOWS — every meeting with its label, its date, who was in it and how many
//    cards it raised, and the minutes of the last one drawn the way the room's own
//    session panel draws them.
// 2. WHO IS OFFERED THE DELETES — the owner and this install's administrators, per
//    lib/reviews/roles.ts `deleteReview`, and NOT the review's editors. Both ask INLINE:
//    window.confirm cannot be styled to the panel that offered it, cannot be tested, and
//    freezes the page behind it while it waits.
// 3. THAT THE 3D VIEWER IS LAZY — three.js is hundreds of kilobytes and the lobby is a
//    list. The chunk is fetched when the "Turn in 3D" button is pressed and not before,
//    which is the whole reason the snapshot exists as the default answer.
//
// The panel's own read (lib/reviews/useSessionMap) is mocked: this file is about what the
// panel DRAWS, and the hook has its own coverage.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LobbyReview } from '../../../lib/lobby/useLobbyData';
import type { LineSession, SessionCardRef } from '../../../lib/reviews/linesRepo';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { ModelRevision } from '../../../lib/reviews/revisionsRepo';

const { mapData, deletes, viewer, opened } = vi.hoisted(() => ({
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
  deletes: { review: vi.fn(), session: vi.fn() },
  /** Bumped by the module factory, which runs when — and only when — the chunk loads. */
  viewer: { imports: 0 },
  /** Every call lib/reviews/openLine was asked to make, for a panel with no host door. */
  opened: { call: vi.fn() },
}));

vi.mock('../../../lib/reviews/useSessionMap', () => ({
  useSessionMap: () => mapData.current,
}));

vi.mock('../../../lib/reviews/deleteClient', () => ({
  deleteReview: (...args: unknown[]) => deletes.review(...args),
  deleteSession: (...args: unknown[]) => deletes.session(...args),
}));

// Only `openLine` is faked, and the rest of the module is spread in because the panel is
// not the only thing that reaches it: the session map and the two variant components it
// embeds read the same module, and a mock that answered one export would break them.
vi.mock('../../../lib/reviews/openLine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/reviews/openLine')>()),
  openLine: (...args: unknown[]) => opened.call(...args),
}));

// The lazy boundary under test. vi.mock replaces the module, and the FACTORY is what
// React.lazy's import() resolves to — so counting factory calls counts chunk loads
// without needing a real bundle.
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

/**
 * A variant that was merged, with NO destination recorded — an install whose database
 * predates `merged_into_line_id`. The row then falls back to the status word, which is
 * still true; `MERGED` below is the one that can name where it went.
 */
const VARIANT: ReviewLine = {
  ...MAIN, id: 'line-a', kind: 'variant', name: 'Steel hinge pin', letter: 'A',
  parentSessionId: 's1', status: 'adopted', closedAt: '2026-09-23T09:00:00.000Z',
};

function session(id: string, over: Partial<LineSession> = {}): LineSession {
  return {
    id, title: id, endedAt: '2026-09-20T09:00:00.000Z', participantCount: 2,
    attendeeNames: ['Robin', 'Ben'], modelName: 'hinge.glb', lineId: 'line-main',
    seq: 1, revisionIds: [], summary: null, ...over,
  };
}

function card(id: string, sessionId: string, type: SessionCardRef['type']): SessionCardRef {
  return { id, sessionId, type, title: `Card ${id}`, status: 'Open', priority: 'High', lineId: 'line-main', originLineId: null };
}

function review(over: Partial<LobbyReview> = {}): LobbyReview {
  return {
    id: 'r1', title: 'Door hinge, rev C', description: '', thumbnail: 'data:image/jpeg;base64,AAAA',
    modelName: 'hinge.glb', updatedAt: '2026-09-24T09:00:00.000Z', createdAt: '2026-09-01T09:00:00.000Z',
    archived: false, listed: true, memberRole: 'owner', mine: true, visited: true,
    lastVisitedAt: '2026-09-24T09:00:00.000Z',
    sessions: [], lines: [], openCards: { RISK: 3, ACTION: 5, RATIONALE: 2 }, revision: 'Rev C',
    ...over,
  };
}

/** The review the panel is given, with the detail its own read would have answered. */
function armDetail() {
  mapData.current = {
    lines: [MAIN, VARIANT],
    sessions: [
      session('s1', { seq: 1, endedAt: '2026-09-20T09:00:00.000Z' }),
      session('s2', { seq: 1, lineId: 'line-a', endedAt: '2026-09-22T09:00:00.000Z', attendeeNames: ['Olga'] }),
      session('s3', {
        seq: 2,
        endedAt: '2026-09-24T09:00:00.000Z',
        attendeeNames: ['Robin', 'Maria'],
        summary: '## Risks raised\n- Hinge pin wears after 1000 cycles\n## Actions\n- Cycle test the steel pin',
      }),
    ],
    revisions: [],
    cards: [card('c1', 's3', 'RISK'), card('c2', 's3', 'ACTION'), card('c3', 's1', 'RATIONALE')],
    loading: false,
    refresh: () => {},
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof ReviewPreview>> = {}) {
  render(
    <MemoryRouter>
      <ReviewPreview
        review={review()}
        mayDelete
        onOpen={() => {}}
        onDeleted={() => {}}
        onChanged={() => {}}
        {...props}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  armDetail();
  deletes.review.mockReset().mockResolvedValue({ ok: true, sessions: 3, items: 6 });
  deletes.session.mockReset().mockResolvedValue({ ok: true, items: 2 });
  opened.call.mockReset();
  // `viewer.imports` is deliberately NOT reset: it counts module loads, and a module is
  // loaded once per run no matter how many panels mount. Resetting it would make the
  // laziness assertion depend on which test pressed the button first.
});

afterEach(cleanup);

describe('the preview panel — the session map it embeds', () => {
  it('embeds it compact, so the panel does not say everything twice', () => {
    renderPanel();

    const map = screen.getByTestId('preview-session-map');
    // This panel's own header has just named the review, counted its sessions and drawn
    // a card around the lot. Batch BO embedded the map as the room mounts it, so the
    // same three facts appeared again three lines lower, inside a second card inside
    // the first — which is what `compact` is for.
    expect(map.querySelector('[data-testid="session-map-heading"]')).toBeNull();
    expect(map.innerHTML).not.toMatch(/shadow-xl/);
    // What the map is FOR survives: the drawing, its stops, and the key that explains
    // the two end states a line can be in.
    expect(map.querySelectorAll('[data-testid="session-stop"]')).toHaveLength(3);
    expect(map.textContent).toContain('Adopted');
    expect(map.textContent).toContain('Dropped');
  });
});

describe('the preview panel', () => {
  it('names the review, how many people have been in it, and how many meetings it has held', () => {
    renderPanel();
    // The panel's own heading, not the session map's: the map repeats the review's name
    // because it is a self-contained component the room and the tracker also show.
    expect(screen.getByTestId('preview-title')).toHaveTextContent('Door hinge, rev C');
    expect(screen.getByText(/4 people · 3 sessions · 1 variant/)).toBeInTheDocument();
  });

  it('lists every meeting with its label, its date, who was in it and its card count', () => {
    renderPanel();
    const rows = screen.getByTestId('preview-session-rows');
    expect(rows).toHaveTextContent('S2');
    expect(rows).toHaveTextContent('Robin, Maria');
    expect(rows).toHaveTextContent('2 cards');
    // The variant's meeting is labelled by its own line, not by the main line's numbering.
    expect(rows).toHaveTextContent('A1');
  });

  it('lists the meetings newest first, because the last one is the one worth reading', () => {
    renderPanel();
    const labels = screen
      .getAllByTestId(/^delete-session-/)
      .map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['Delete session S2', 'Delete session A1', 'Delete session S1']);
  });

  it('draws the last meeting’s minutes the way the room’s session panel does', () => {
    renderPanel();
    const minutes = screen.getByTestId('preview-minutes');
    // "## " and "- " are recognised as a heading and a bullet, so the markers do not show.
    expect(minutes).toHaveTextContent('Risks raised');
    expect(minutes).toHaveTextContent('Hinge pin wears after 1000 cycles');
    expect(minutes.textContent).not.toContain('##');
    expect(minutes.textContent).not.toContain('- ');
  });

  it('shows no minutes block at all for a review whose last meeting stored none', () => {
    mapData.current = {
      ...mapData.current,
      sessions: [session('s1', { summary: null })],
    };
    renderPanel();
    expect(screen.queryByTestId('preview-minutes')).toBeNull();
  });

  it('links to the tracker filtered to this review', () => {
    renderPanel();
    expect(screen.getByTestId('preview-tracker')).toHaveAttribute('href', '/tracker?review=r1');
  });

  it('makes Join the primary button for somebody who arrived by a link', () => {
    renderPanel({ invited: true });
    expect(screen.getByTestId('preview-join')).toHaveTextContent('Join');
    expect(screen.queryByTestId('preview-open-room')).toBeNull();
  });
});

describe('the preview panel — deleting', () => {
  it('offers the deletes to an owner, and asks inline before doing anything', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderPanel({ mayDelete: true });

    fireEvent.click(screen.getByTestId('delete-review'));
    expect(screen.getByTestId('inline-confirm')).toHaveTextContent('Delete this design review?');
    expect(deletes.review).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletes.review).toHaveBeenCalledTimes(1));
    expect(deletes.review.mock.calls[0][0]).toBe('r1');
    // Never a browser dialog: it cannot be styled to the panel, cannot be tested, and
    // freezes the page behind it while it waits.
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('offers the delete ONCE, inline — the map inside the panel is a diagram', () => {
    // SessionMap carries its own "Delete review" and per-stop session deletes, and both
    // ask with window.confirm. In the room and the tracker that is the only control
    // surface there is, so it is right; in a panel that already has both deletes under
    // its own list of sessions it would be a second way to remove the same review.
    renderPanel({ mayDelete: true });
    expect(screen.getAllByRole('button', { name: /Delete review/i })).toHaveLength(1);
    expect(screen.queryByTestId('delete-review')).toBeInTheDocument();
  });

  it('does not offer them to somebody who may not delete the review', () => {
    renderPanel({ mayDelete: false });
    expect(screen.queryByTestId('delete-review')).toBeNull();
    expect(screen.queryAllByTestId(/^delete-session-/)).toHaveLength(0);
  });

  it('says what the endpoint refused, and keeps the review', async () => {
    deletes.review.mockResolvedValue({ ok: false, error: 'Only the owner of this design review can delete it.' });
    const onDeleted = vi.fn();
    renderPanel({ mayDelete: true, onDeleted });

    fireEvent.click(screen.getByTestId('delete-review'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Only the owner of this design review');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('deletes one meeting through the same endpoint, and cancels without deleting', async () => {
    renderPanel({ mayDelete: true });

    fireEvent.click(screen.getByTestId('delete-session-S1'));
    expect(screen.getByTestId('inline-confirm')).toHaveTextContent('Delete S1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deletes.session).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('delete-session-S1'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletes.session).toHaveBeenCalledTimes(1));
    expect(deletes.session.mock.calls[0][0]).toBe('r1');
    expect(deletes.session.mock.calls[0][1]).toBe('s1');
  });

  it('passes the meeting-host claim only where the caller says to', async () => {
    // A deployment with no accounts has no token to verify, so the endpoint takes the
    // caller's own claim — see api/reviews/delete.ts. Where there ARE accounts the claim
    // must stay false, or the lobby would be asserting something the room never said.
    renderPanel({ mayDelete: true, isMeetingHost: true });
    fireEvent.click(screen.getByTestId('delete-review'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletes.review).toHaveBeenCalledTimes(1));
    expect(deletes.review.mock.calls[0][1]).toEqual({ isMeetingHost: true });
  });
});

describe('the preview panel — "Turn in 3D" is lazy', () => {
  it('does not load the viewer until the button is pressed', async () => {
    // Counted from wherever the module registry happens to be, so the assertion is about
    // THIS panel and not about which test ran first: React.lazy resolves the chunk the
    // first time the element renders, and never before.
    const loadedBefore = viewer.imports;
    renderPanel();
    expect(screen.getByTestId('preview-thumbnail')).toBeInTheDocument();
    expect(screen.queryByTestId('viewer-3d')).toBeNull();
    // The panel is fully drawn — map, sessions, minutes — and three.js has not been fetched.
    expect(viewer.imports).toBe(loadedBefore);

    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-in-3d'));
    });

    await waitFor(() => expect(viewer.imports).toBeGreaterThan(loadedBefore));
    expect(await screen.findByTestId('viewer-3d')).toBeInTheDocument();
    // The snapshot is no longer the thing being shown.
    expect(screen.queryByTestId('preview-thumbnail')).toBeNull();
  });

  it('goes back to the snapshot, and does not fetch the chunk a second time', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-in-3d'));
    });
    await screen.findByTestId('viewer-3d');
    const loadedBefore = viewer.imports;

    await act(async () => {
      fireEvent.click(screen.getByTestId('turn-in-3d'));
    });
    expect(screen.getByTestId('preview-thumbnail')).toBeInTheDocument();
    expect(screen.queryByTestId('viewer-3d')).toBeNull();
    // Unmounting is what disposes the viewer's geometry; turning back does not re-fetch.
    expect(viewer.imports).toBe(loadedBefore);
  });

  it('shows the model name in the placeholder when the review has no snapshot', () => {
    renderPanel({ review: review({ thumbnail: null }) });
    expect(screen.getByTestId('preview-placeholder')).toHaveTextContent('hinge.glb');
  });
});

// ─── Batch BV: every line, and the way into each ──────────────────────────────
//
// The report this batch came from: a variant started before anybody met, explored, and
// left with a moved model in it was kept perfectly by its own room and was invisible from
// everywhere else. This panel counted it in its header ("0 sessions · 1 variant"), the map
// under that said "No sessions recorded", and the list below it is of SESSIONS — so there
// was no row to read and no link to press. What is pinned here is that the panel now names
// every line of the review and offers the room each one meets in.

describe('the preview panel — its lines, and the way into each', () => {
  /** A variant still being explored, and one nobody has met on: the reported case. */
  const ACTIVE: ReviewLine = {
    ...MAIN, id: 'line-b', kind: 'variant', name: 'Frame forward', letter: 'B',
    parentSessionId: null, status: 'active', closedAt: null,
    // Started before VARIANT, so `orderedLines` — which sorts by the moment a line was
    // started and then by id — puts it first and the row order below is pinned by the
    // data rather than by two ids happening to sort the same way.
    createdAt: '2026-09-19T09:00:00.000Z',
  };

  it('lists the main line and every variant, each with the room it opens', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE, VARIANT] };
    const onOpenLine = vi.fn();
    renderPanel({ onOpenLine });

    const rows = screen.getAllByTestId('preview-line');
    expect(rows).toHaveLength(3);
    // In the order the map above it draws them: the main line first, then the variants
    // in the order they were started.
    expect(rows.map((row) => row.getAttribute('data-line'))).toEqual(['line-main', 'line-b', 'line-a']);
    // A BUTTON and not a link, which is the whole of batch BX's first half: the row used
    // to be a <Link> to `roomPath`, which is the right address, and pages/RoomPage still
    // turned the arrival away because it admits one by its router state or by the mark
    // lib/reviews/openLine leaves behind — neither of which a link carries. So it
    // navigated and bounced straight back here, which is what "it is not possible to open
    // variants from the lobby" was.
    expect(screen.getByTestId('open-main-line').tagName).toBe('BUTTON');
    expect(screen.getByTestId('open-variant').tagName).toBe('BUTTON');

    // null is the main line, whose address deliberately carries no ?line= — every link
    // already in circulation for a review opens exactly the room it always did.
    fireEvent.click(screen.getByTestId('open-main-line'));
    expect(onOpenLine).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByTestId('open-variant'));
    expect(onOpenLine).toHaveBeenLastCalledWith('line-b');
    expect(screen.getByTestId('preview-lines')).toHaveTextContent('Variant B · Frame forward');
  });

  it('opens through lib/reviews/openLine when its host has no door of its own', () => {
    // The lobby passes `onOpenLine` because it has a name form to submit first. Every
    // other host of this panel — and every test that does not think about it — gets the
    // shared opener, which writes the same mark the lobby's `enterRoom` writes and so is
    // admitted by the room. What must never happen is the panel navigating by itself.
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE] };
    renderPanel();

    fireEvent.click(screen.getByTestId('open-variant'));
    expect(opened.call).toHaveBeenCalledTimes(1);
    expect(opened.call.mock.calls[0]?.slice(1)).toEqual(['r1', 'line-b']);

    fireEvent.click(screen.getByTestId('open-main-line'));
    expect(opened.call.mock.calls[1]?.slice(1)).toEqual(['r1', null]);
  });

  it('offers a way into a variant that has never met, which is the whole of the batch', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE], sessions: [] };
    const onOpenLine = vi.fn();
    renderPanel({ review: review({ sessions: [], lines: [MAIN, ACTIVE] }), onOpenLine });

    fireEvent.click(screen.getByTestId('open-variant'));
    expect(onOpenLine).toHaveBeenCalledWith('line-b');
    expect(screen.getByTestId('preview-lines')).toHaveTextContent('0 sessions');
    expect(screen.getByTestId('preview-lines')).toHaveTextContent('active');
  });

  it('greys a line that is finished with, and offers no way into it', () => {
    // An adopted or dropped variant has no meeting to walk into. Its record is its cards
    // and its place on the map, so it stays on the list and loses the way in.
    mapData.current = { ...mapData.current, lines: [MAIN, VARIANT] };
    renderPanel();

    const closed = screen
      .getAllByTestId('preview-line')
      .find((row) => row.getAttribute('data-line') === 'line-a');
    expect(closed?.getAttribute('data-status')).toBe('adopted');
    expect(closed?.textContent).toContain('adopted');
    expect(closed?.querySelector('a')).toBeNull();
    expect(closed?.querySelector('button')).toBeNull();
    // The main line is not finished with, so it keeps its way in.
    expect(screen.getByTestId('open-main-line')).toBeInTheDocument();
  });

  it('counts each line’s own meetings, and counts a meeting with no line as the main line’s', () => {
    mapData.current = {
      ...mapData.current,
      lines: [MAIN, ACTIVE],
      sessions: [
        session('s1', { seq: 1, lineId: null }),
        session('s2', { seq: 2 }),
        session('s3', { seq: 1, lineId: 'line-b' }),
      ],
    };
    renderPanel();

    const [main, variantRow] = screen.getAllByTestId('preview-line');
    expect(main.textContent).toContain('2 sessions');
    expect(variantRow.textContent).toContain('1 session');
  });

  it('has no Lines heading at all for a review with no lines', () => {
    // An ad-hoc room and an install with no database. An empty heading under the map
    // would be a question the panel then has to answer.
    mapData.current = { ...mapData.current, lines: [], sessions: [] };
    renderPanel({ review: review({ lines: [], sessions: [] }) });

    expect(screen.queryByTestId('preview-lines')).toBeNull();
  });
});

// ─── Batch BX: where a line came from, where it went, and the ones that are over ──
//
// Three things the user reported at once: a variant could not be opened from the lobby
// (pinned above), a variant could only ever be merged into the main line, and a variant
// that had been dropped still showed up as though it were somewhere to go. What is pinned
// here is the second half — that the list says where a line came from and where it went,
// that a dropped one is out of the way until somebody asks for it, and that the panel
// offers a variant OF A VARIANT from the variant's own row.

describe('the preview panel — a line’s origin, its end, and the ones it hides', () => {
  /** A variant still being explored, started from the main line. */
  const ACTIVE: ReviewLine = {
    ...MAIN, id: 'line-b', kind: 'variant', name: 'Frame forward', letter: 'B',
    parentSessionId: null, parentLineId: 'line-main', status: 'active', closedAt: null,
    createdAt: '2026-09-19T09:00:00.000Z',
  };

  /** The same variant after a merge into Variant A, with the destination recorded. */
  const MERGED: ReviewLine = {
    ...ACTIVE, id: 'line-a', name: 'Steel hinge pin', letter: 'A', parentLineId: 'line-main',
    status: 'adopted', mergedIntoLineId: 'line-b', closedAt: '2026-09-23T09:00:00.000Z',
    createdAt: '2026-09-20T09:00:00.000Z',
  };

  /** A dropped one. Its stored reason carries the prefix `droppedLineReason` strips. */
  const DROPPED: ReviewLine = {
    ...ACTIVE, id: 'line-c', name: 'Printed bracket', letter: 'C', parentLineId: 'line-b',
    status: 'dropped', dropReason: 'Dropped with Variant C: Too expensive to tool',
    closedAt: '2026-09-24T09:00:00.000Z', createdAt: '2026-09-21T09:00:00.000Z',
  };

  const rowOf = (lineId: string): HTMLElement | undefined =>
    screen.getAllByTestId('preview-line').find((row) => row.getAttribute('data-line') === lineId);

  /**
   * Scoped to the Lines list, because the session map this panel embeds has a toggle of
   * its own with the SAME test id and the same words. Two "Show dropped (N)" buttons on
   * one screen is deliberate — they are the same offer on two drawings of the same fact,
   * and a panel whose list and whose map disagreed about what was hidden would be worse
   * than either — so a test that means one of them has to say which.
   */
  const linesPanel = () => within(screen.getByTestId('preview-lines'));

  it('says where a variant came from, so a variant of a variant is not a second answer to the same question', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE, DROPPED], sessions: [] };
    renderPanel();
    // Variant C was started from Variant B, and the row says so rather than leaving the
    // reader to work out from the map above which line it left.
    expect(linesPanel().getByTestId('show-dropped')).toBeInTheDocument();
    fireEvent.click(linesPanel().getByTestId('show-dropped'));
    expect(rowOf('line-c')?.textContent).toContain('Variant C · Printed bracket · from Variant B');
    expect(rowOf('line-b')?.textContent).toContain('Variant B · Frame forward · from Main line');
  });

  it('says where a merged variant went, and offers no way into it', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE, MERGED], sessions: [] };
    renderPanel();

    const merged = rowOf('line-a');
    expect(merged?.getAttribute('data-status')).toBe('adopted');
    expect(merged?.textContent).toContain('merged into Variant B 23 Sep');
    // Its meetings continue on the line it went into; a row that offered to open it would
    // open a room nobody is in any more.
    expect(merged?.querySelector('button')).toBeNull();
    expect(rowOf('line-b')?.querySelector('[data-testid="open-variant"]')).not.toBeNull();
  });

  it('hides a dropped variant until it is asked for, and then says why it was dropped', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE, MERGED, DROPPED], sessions: [] };
    renderPanel();

    // Out of the way by default: it is a record and not a choice, and a list where the
    // finished lines outnumber the live ones stops being a way in at all.
    expect(screen.getAllByTestId('preview-line').map((row) => row.getAttribute('data-line')))
      .toEqual(['line-main', 'line-b', 'line-a']);
    const toggle = linesPanel().getByTestId('show-dropped');
    expect(toggle).toHaveTextContent('Show dropped (1)');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(screen.getAllByTestId('preview-line').map((row) => row.getAttribute('data-line')))
      .toEqual(['line-main', 'line-b', 'line-a', 'line-c']);
    const dropped = rowOf('line-c');
    expect(dropped?.getAttribute('data-status')).toBe('dropped');
    // The reason the meeting agreed, without the "Dropped with Variant C:" prefix the
    // CARDS carry — under the variant's own name that prefix says the same thing twice.
    expect(dropped?.textContent).toContain('This variant was dropped: Too expensive to tool');
    expect(dropped?.textContent).not.toContain('Dropped with');
    expect(dropped?.querySelector('button')).toBeNull();
    expect(linesPanel().getByTestId('show-dropped')).toHaveTextContent('Hide dropped');
    expect(linesPanel().getByTestId('show-dropped')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(linesPanel().getByTestId('show-dropped'));
    expect(screen.getAllByTestId('preview-line')).toHaveLength(3);
  });

  it('has no toggle at all for a review with nothing dropped', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE], sessions: [] };
    renderPanel();
    expect(linesPanel().queryByTestId('show-dropped')).toBeNull();
  });

  it('offers a variant OF A VARIANT from the variant’s own row', () => {
    // The second half of the report: a variant could only be started from the review, so
    // there was no way to answer a second question about a side line without losing the
    // first answer. The row's own button starts one from THAT line.
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE], sessions: [] };
    renderPanel({ mayEdit: true });

    const rowButton = screen.getByTestId('line-row-variant');
    expect(rowButton.closest('[data-testid="preview-line"]')?.getAttribute('data-line')).toBe('line-b');
    // The main line's row has none: the actions list at the bottom already offers that
    // one, and two buttons that start the same thing are a choice with one answer.
    expect(rowOf('line-main')?.querySelector('[data-testid="line-row-variant"]')).toBeNull();
    expect(screen.getByTestId('preview-variant')).toBeInTheDocument();
  });

  it('offers to merge a variant into another line, and to drop it, from the same row', () => {
    // Neither was reachable from the lobby at all before this batch: the map embedded
    // above is a diagram (`mayDelete` false, no line actions), so the only place a merge
    // could be started was inside a room — and the merge it offered had one destination.
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE], sessions: [] };
    renderPanel({ mayEdit: true });

    const row = rowOf('line-b');
    expect(row?.querySelector('[data-testid="merge-variant"]')).not.toBeNull();
    expect(row?.querySelector('[data-testid="drop-variant-open"]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('merge-variant'));
    const chooser = screen.getByTestId('merge-chooser');
    expect(chooser).toHaveTextContent('Merge Variant B into');
    // The main line is the only other line still being explored here, and it is the one
    // already selected — a chooser that opens with nothing selected makes somebody read
    // a list before they can press the obvious thing.
    const targets = screen.getAllByTestId('merge-target');
    expect(targets.map((target) => target.getAttribute('data-line'))).toEqual(['line-main']);
    expect(targets[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no merge and no drop to somebody who may not change the review', () => {
    mapData.current = { ...mapData.current, lines: [MAIN, ACTIVE], sessions: [] };
    renderPanel({ mayEdit: false });

    expect(screen.queryByTestId('merge-variant')).toBeNull();
    expect(screen.queryByTestId('drop-variant-open')).toBeNull();
    expect(screen.queryByTestId('line-row-variant')).toBeNull();
    // Reading a line and opening one are not changing the review.
    expect(screen.getByTestId('open-variant')).toBeInTheDocument();
  });
});
