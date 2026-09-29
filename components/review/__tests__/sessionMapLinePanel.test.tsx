// The map's LINE panel — batch BV, generalised by batch BX.
//
// A review whose variant has never met used to have nothing to click: the map said "No
// sessions recorded in this design review yet.", so the variant was invisible everywhere
// outside its own room and read as a variant that had not been saved. The map now draws
// every line whether or not it has met, and a line — its start, the hollow letter a
// session-less variant ends at, or the line a variant is drawn with — opens a panel.
// What is pinned here is that panel: what it says, the way into the room it names, and
// the two lines that are finished with and therefore have no way in at all.
//
// The way in is a BUTTON and not a link, and that is the batch: pages/RoomPage's entry
// guard admits an arrival by its router state or by a mark a deliberate entry writes,
// and a <Link> to the correct address carries neither — so the panel that named the
// right room still bounced the reader back to the lobby.
//
// The words are pinned too, as they are in sessionMap.test.tsx: this is a "Design review"
// with a "Main line" and a "Variant A", and branch, fork and commit do not appear.
// "Merge" does, from batch BX, because it is the user's own word for taking one line
// into another and the panel has to say which line that was.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SessionMap from '../SessionMap';
import { ENTERED_ROOM_KEY } from '../../../lib/reviews/openLine';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

const REVIEW = 'review-1';

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: REVIEW, kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null, parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: '',
  createdAt: '2026-09-01T09:00:00.000Z', closedAt: null,
};

/** The reported case: a variant started before anybody met, so it has no parent session. */
const FRAME: ReviewLine = {
  id: 'line-a', reviewId: REVIEW, kind: 'variant', name: 'Frame forward', letter: 'A',
  parentSessionId: null, parentLineId: 'line-main', mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-09-25T09:00:00.000Z', closedAt: null,
};

function session(id: string, seq: number, lineId: string | null, over: Partial<LineSession> = {}): LineSession {
  return {
    id, title: `Design review — ${id}`, endedAt: '2026-09-24T16:00:00.000Z', participantCount: 3,
    modelName: 'imported', lineId, seq, revisionIds: [], summary: null, ...over,
  };
}

/** Where the router ended up, for the case where the map opens a room itself. */
const LocationDisplay: React.FC = () => {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
};

function renderMap(props: Partial<React.ComponentProps<typeof SessionMap>> = {}) {
  return render(
    <MemoryRouter>
      <LocationDisplay />
      <SessionMap
        reviewTitle="Bike"
        lines={[MAIN, FRAME]}
        sessions={[]}
        reviewId={REVIEW}
        {...props}
      />
    </MemoryRouter>,
  );
}

/** A browser that has already been asked its name, which `openLine` needs to go in. */
function named(): void {
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
}

describe('the map — a line opens its own panel', () => {
  it('opens the main line from its start, with the way into its room', () => {
    const onOpenLine = vi.fn();
    renderMap({ onOpenLine });
    fireEvent.click(screen.getByText('Start'));

    const panel = screen.getByTestId('line-panel');
    expect(within(panel).getByText('Main line')).toBeTruthy();
    expect(panel.textContent).toContain('0 sessions');
    // The main line is asked for with null rather than with its own id, because its
    // address carries no ?line= and an id would be a second address for the same room.
    expect(screen.getByTestId('open-main-line').textContent).toBe('Open main line');
    fireEvent.click(screen.getByTestId('open-main-line'));
    expect(onOpenLine).toHaveBeenCalledWith(null);
  });

  it('opens a variant nobody has met on, with the way into ITS room', () => {
    // This is the whole of batch BV: the variant's own room kept every change, and from
    // the map there was no route to it.
    const onOpenLine = vi.fn();
    renderMap({ onOpenLine });
    fireEvent.click(screen.getByText('A'));

    const panel = screen.getByTestId('line-panel');
    expect(within(panel).getByText('Variant A · Frame forward · from Main line')).toBeTruthy();
    expect(panel.textContent).toContain('active');
    expect(panel.textContent).toContain('started from the start');
    expect(panel.textContent).toContain('0 sessions');
    expect(screen.getByTestId('open-variant').textContent).toBe('Open variant');
    fireEvent.click(screen.getByTestId('open-variant'));
    expect(onOpenLine).toHaveBeenCalledWith('line-a');
  });

  it('opens the room itself, through the entry guard, when its host hands it no way in', () => {
    // The bug the button replaced a link for: the address was always right and the room
    // still sent the reader straight back to the lobby, because pages/RoomPage admits an
    // arrival by its router state or by the mark a deliberate entry writes and a <Link>
    // carries neither. lib/reviews/openLine sets both.
    named();
    renderMap();
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByTestId('open-variant'));

    expect(screen.getByTestId('location').textContent).toBe(`/room/${REVIEW}?line=line-a`);
    expect(sessionStorage.getItem(ENTERED_ROOM_KEY)).toBe(REVIEW);
  });

  it('names the line a variant of a variant was started from', () => {
    // Batch BX: "Variant B · Lighter frame" on its own reads as a second answer to the
    // same question, and the point of exploring from another variant is that it is a
    // second answer to a DIFFERENT one.
    const child: ReviewLine = {
      ...FRAME, id: 'line-b', letter: 'B', name: 'Lighter frame',
      parentLineId: 'line-a', parentSessionId: null, createdAt: '2026-09-26T09:00:00.000Z',
    };
    renderMap({ lines: [MAIN, FRAME, child] });
    fireEvent.click(screen.getByText('B'));

    const panel = screen.getByTestId('line-panel');
    expect(within(panel).getByText('Variant B · Lighter frame · from Variant A')).toBeTruthy();
  });

  it('names the meeting a variant left from, by its label and its date', () => {
    renderMap({
      lines: [MAIN, { ...FRAME, parentSessionId: 's2' }],
      sessions: [session('s1', 1, MAIN.id), session('s2', 2, MAIN.id)],
    });
    fireEvent.click(screen.getByText('A'));

    expect(screen.getByTestId('line-panel').textContent).toContain('started from S2 · 24 Sep');
  });

  it('says a variant whose parent meeting was deleted left from the start', () => {
    // The honest answer rather than a date invented from the variant's own created_at,
    // which would say when the line was started and not where it left from.
    renderMap({
      lines: [MAIN, { ...FRAME, parentSessionId: 's-deleted' }],
      sessions: [session('s1', 1, MAIN.id)],
    });
    fireEvent.click(screen.getByText('A'));

    expect(screen.getByTestId('line-panel').textContent).toContain('started from the start');
  });

  it('draws no start once the main line has met, and a meeting still opens its own panel', () => {
    // A session with no `line_id` is the main line's, which is where the map draws it and
    // where the backfill in docs/supabase-schema.sql puts it — so the main line HAS met
    // and its start is no longer the only thing on its row.
    renderMap({ sessions: [session('s1', 1, null), session('s2', 2, MAIN.id)] });

    expect(screen.queryByText('Start')).toBeNull();
    expect(screen.queryAllByTestId('map-line-stop')).toHaveLength(1); // the variant's "A"
    fireEvent.click(screen.getAllByText('S2')[0]);
    expect(screen.getByText('Attended')).toBeTruthy();
    expect(screen.queryByTestId('line-panel')).toBeNull();
  });

  it('offers the two decisions to whoever may change the review’s lines', () => {
    renderMap({ mayEditLines: true });
    fireEvent.click(screen.getByText('A'));

    const panel = screen.getByTestId('line-panel');
    expect(within(panel).getByText(/Merge into/i)).toBeTruthy();
    expect(within(panel).getByText(/Drop/i)).toBeTruthy();
  });

  it('offers a participant and a guest the way in, and nothing to decide', () => {
    renderMap();
    fireEvent.click(screen.getByText('A'));

    const panel = screen.getByTestId('line-panel');
    expect(screen.getByTestId('open-variant')).toBeTruthy();
    expect(within(panel).queryByText(/Merge into/i)).toBeNull();
    expect(within(panel).queryByText(/Drop/i)).toBeNull();
  });

  it('offers "Explore a variant from here" on a line, not only on one of its meetings', () => {
    // Batch BX. A variant is somewhere a further variant can leave from whether or not
    // the reader happens to have one of its meetings open, and it leaves from the newest
    // one — the model this line is at now.
    renderMap({
      mayEditLines: true,
      lines: [MAIN, { ...FRAME, parentSessionId: 's2' }],
      sessions: [session('s1', 1, MAIN.id), session('s2', 2, MAIN.id), session('a1', 1, FRAME.id)],
    });
    fireEvent.click(screen.getAllByTestId('map-line-edge')[0]);

    const panel = screen.getByTestId('line-panel');
    expect(within(panel).getByText('Explore a variant from here')).toBeTruthy();
  });

  it('says why a dropped variant is not somewhere to go, and offers no way in', () => {
    // Its meetings stay readable — they are the record of the answer the review tried —
    // but a room nobody is meeting in any more is a room that can only be edited by
    // mistake, and a merge or a drop of a line that has had both is a second decision
    // about the same one.
    const dropped: ReviewLine = {
      ...FRAME, status: 'dropped', closedAt: '2026-09-26T09:00:00.000Z',
      dropReason: 'Dropped with Variant A: too expensive to tool',
    };
    renderMap({
      mayEditLines: true,
      lines: [MAIN, dropped],
      sessions: [session('s1', 1, MAIN.id), session('a1', 1, FRAME.id)],
    });
    fireEvent.click(screen.getByTestId('show-dropped'));
    fireEvent.click(screen.getAllByTestId('map-line-edge')[0]);

    const panel = screen.getByTestId('line-panel');
    // The reason the meeting gave, without the card's own prefix on it: under this
    // variant's own heading, "Dropped with Variant A: …" would say the same thing twice.
    expect(within(panel).getByText('Dropped: too expensive to tool')).toBeTruthy();
    expect(within(panel).queryByTestId('open-variant')).toBeNull();
    expect(within(panel).queryByText(/Merge into/i)).toBeNull();
    expect(within(panel).queryByText(/Drop variant/i)).toBeNull();
    expect(within(panel).queryByText('Explore a variant from here')).toBeNull();
    // The meeting is still on the map and still opens its own panel.
    fireEvent.click(screen.getByText('A1'));
    expect(screen.getByText('Attended')).toBeTruthy();
  });

  it('says a dropped variant with no stored reason was dropped, and nothing more', () => {
    // Every variant dropped before batch BX has no `drop_reason` row; its cards carry the
    // reason, and a sentence invented here would be a guess about a decision.
    const dropped: ReviewLine = { ...FRAME, status: 'dropped', dropReason: null };
    renderMap({ lines: [MAIN, dropped] });
    fireEvent.click(screen.getByTestId('show-dropped'));
    fireEvent.click(screen.getAllByTestId('map-line-edge')[0]);

    expect(within(screen.getByTestId('line-panel')).getByText('This variant was dropped.')).toBeTruthy();
  });

  it('offers a MERGED variant no way in, and says which line took it', () => {
    // Its room is not somewhere to go: the meeting continues on the line its model went
    // to, and a room that still holds the old one is a room two people can be editing
    // while the review has moved on.
    const merged: ReviewLine = {
      ...FRAME, status: 'adopted', mergedIntoLineId: MAIN.id, closedAt: '2026-09-26T09:00:00.000Z',
    };
    renderMap({
      mayEditLines: true,
      lines: [MAIN, merged],
      sessions: [session('s1', 1, MAIN.id), session('a1', 1, FRAME.id)],
    });
    fireEvent.click(screen.getAllByTestId('map-line-edge')[0]);

    const panel = screen.getByTestId('line-panel');
    expect(panel.textContent).toContain('merged into Main line 26 Sep');
    expect(within(panel).queryByTestId('open-variant')).toBeNull();
    expect(within(panel).queryByText(/Merge into/i)).toBeNull();
  });

  it('closes again, from its own button and from a second click on the marker', () => {
    renderMap();
    fireEvent.click(screen.getByText('A'));
    expect(screen.getByTestId('line-panel')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close this line'));
    expect(screen.queryByTestId('line-panel')).toBeNull();

    fireEvent.click(screen.getByText('A'));
    expect(screen.getByTestId('line-panel')).toBeTruthy();
    fireEvent.click(screen.getByText('A'));
    expect(screen.queryByTestId('line-panel')).toBeNull();
  });

  it('opens the same panel from the variant’s line, not only from its stop', () => {
    // For a variant nobody has met on, the branch is the only thing on the map that says
    // it exists, so the branch itself has to answer. A 1.5px stroke is not a thing
    // anybody can hit with a pointer, which is why it carries a wider invisible one.
    const onOpenLine = vi.fn();
    renderMap({ onOpenLine });
    fireEvent.click(screen.getAllByTestId('map-line-edge')[0]);

    const panel = screen.getByTestId('line-panel');
    expect(within(panel).getByText('Variant A · Frame forward · from Main line')).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-variant'));
    expect(onOpenLine).toHaveBeenCalledWith('line-a');

    // And a second click on the same line closes it again, as a second click on a stop does.
    fireEvent.click(screen.getAllByTestId('map-line-edge')[0]);
    expect(screen.queryByTestId('line-panel')).toBeNull();
  });

  it('makes no other line on the map clickable', () => {
    // The main line's edges are not ways into a panel — its stops are its meetings, and
    // its start is the one marker that opens its panel. Neither is the green edge an
    // adopted variant rejoins along, which stays the inert moment it describes.
    renderMap({
      lines: [MAIN, { ...FRAME, status: 'adopted', closedAt: '2026-09-26T09:00:00.000Z' }],
      sessions: [session('s1', 1, MAIN.id), session('s2', 2, MAIN.id)],
    });

    const clickable = screen.queryAllByTestId('map-line-edge');
    expect(clickable.map((edge) => edge.getAttribute('data-line'))).toEqual(['line-a']);
    // Which is the variant's own branch: its leave, and the return it makes when adopted.
    fireEvent.click(screen.getByText('✓'));
    expect(screen.queryByTestId('line-panel')).toBeNull();
  });

  it('never says branch, fork or commit', () => {
    const { container } = renderMap({ mayEditLines: true });
    fireEvent.click(screen.getByText('A'));

    const shown = (container.textContent ?? '').toLowerCase();
    for (const word of ['branch', 'fork', 'commit']) {
      expect(shown, `the map says "${word}"`).not.toContain(word);
    }
    // "Merge" is the word the panel does use, and it is the user's own (2026-09-26):
    // asked for a variant that could be taken into another variant, they described it as
    // merged. The database's status column still says 'adopted', because a status is not
    // a sentence anybody reads.
    expect(within(screen.getByTestId('line-panel')).getByText(/Merge into/i)).toBeTruthy();

    fireEvent.click(screen.getByText('Start'));
    expect((container.textContent ?? '').toLowerCase()).not.toMatch(/branch|fork|commit/);
  });
});
