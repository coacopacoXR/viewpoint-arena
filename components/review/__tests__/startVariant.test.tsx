// The "Variant" button: starting one from somewhere a person looks.
//
// docs/plan/15-sessions-and-variants.md batch BQ. The action existed already —
// components/review/VariantActions.tsx, on a meeting's stop inside the Sessions map —
// and the user's report was still "i dont see anything about creating the product
// variants". So what is pinned here is what the new button adds rather than the write
// it makes, which is VariantActions' own coverage:
//
//   * it says what the variant will START FROM before it starts one, which the deep
//     version could not: a person who cannot see the consequence of the button does
//     not press it
//   * and it works for a review that has NEVER MET, which the endpoint had to learn:
//     there is no session to leave from, so the line is written with no parent and the
//     new room opens on the model as it is now
//
// The words are the spec. "Variant" on the button, never branch or fork — the icon may
// be a forking line, the sentence beside it is what a hardware engineer reads.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReviewLine } from '../../../lib/reviews/lines';
import type { LineSession } from '../../../lib/reviews/linesRepo';

const { repo, explore } = vi.hoisted(() => ({
  repo: {
    lines: { current: [] as unknown[] },
    origin: { current: null as unknown },
    resets: 0,
  },
  explore: { call: vi.fn() },
}));

vi.mock('../../../lib/reviews/linesRepo', () => ({
  listLines: vi.fn(async () => repo.lines.current),
  lineOriginSession: vi.fn(async () => repo.origin.current),
  resetLineCache: () => { repo.resets += 1; },
}));

vi.mock('../../../lib/reviews/linesClient', () => ({
  exploreVariant: (...args: unknown[]) => explore.call(...args),
}));

const StartVariant = (await import('../StartVariant')).default;

const MAIN: ReviewLine = {
  id: 'line-main', reviewId: 'r1', kind: 'main', name: 'Main line', letter: null,
  parentSessionId: null,
  // Batch BX: where a line was started from and where it went are columns of their own,
  // and a fixture without all three is not a ReviewLine any more. Both null on the main
  // line, which came from nowhere and went nowhere.
  parentLineId: null, mergedIntoLineId: null, dropReason: null,
  status: 'active', createdBy: null, createdByName: 'Robin',
  createdAt: '2026-09-20T09:00:00.000Z', closedAt: null,
};

/** Variant A: the room this button is pressed in for the case batch BX made possible. */
const VARIANT_A: ReviewLine = {
  ...MAIN, id: 'line-a', kind: 'variant', name: 'Steel hinge pin', letter: 'A',
  parentLineId: 'line-main', createdAt: '2026-09-21T09:00:00.000Z',
};

/** S3 on the main line: the meeting a variant started in a review that has met leaves from. */
const SESSION: LineSession = {
  id: 'sess-3', title: 'Cycle test', endedAt: '2026-09-24T16:00:00.000Z', participantCount: 3,
  attendeeNames: ['Robin', 'Maria'], modelName: 'hinge.glb', lineId: 'line-main',
  seq: 3, revisionIds: ['r-c'], summary: null,
};

/** A1 on Variant A: a meeting held on a variant, which batch BX is what made reachable. */
const SESSION_ON_VARIANT: LineSession = {
  id: 'sess-a1', title: 'Nylon trial', endedAt: '2026-09-23T16:00:00.000Z', participantCount: 2,
  modelName: 'hinge.glb', lineId: 'line-a', seq: 1, revisionIds: ['r-b2'], summary: null,
};

/** Stands in for the room the navigation lands in, so the address can be read. */
const RoomProbe: React.FC = () => {
  const location = useLocation();
  return <span data-testid="path">{location.pathname}{location.search}</span>;
};

function renderButton(props: Partial<React.ComponentProps<typeof StartVariant>> = {}) {
  return render(
    <MemoryRouter initialEntries={['/room/r1']}>
      <Routes>
        <Route
          path="/room/:roomId"
          element={
            <>
              <StartVariant reviewId="r1" mayEdit label="Variant" {...props} />
              <RoomProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/** Open the popover and wait for the read that works out what it starts from. */
async function open() {
  fireEvent.click(screen.getByTestId('start-variant'));
  await waitFor(() => {
    expect(screen.getByTestId('start-variant-origin').textContent).not.toContain('…');
  });
}

async function start(name: string) {
  fireEvent.change(screen.getByTestId('start-variant-field'), { target: { value: name } });
  await act(async () => {
    fireEvent.click(screen.getByTestId('start-variant-go'));
  });
}

beforeEach(() => {
  repo.lines.current = [MAIN, VARIANT_A];
  repo.origin.current = SESSION;
  repo.resets = 0;
  explore.call.mockReset().mockResolvedValue({
    ok: true,
    line: { ...VARIANT_A, id: 'line-new', kind: 'variant', name: 'Glass-filled nylon', letter: 'B', parentSessionId: 'sess-3' },
  });
  // lib/reviews/openLine refuses to enter a room for a browser with no stored name and
  // sends it to the lobby to be asked for one instead — right in the app, and a bounce to
  // nowhere in a test of where starting a variant leaves you.
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
});

afterEach(cleanup);

describe('the Variant button', () => {
  it('is not there for somebody who may not change the review', () => {
    renderButton({ mayEdit: false });
    expect(screen.queryByTestId('start-variant')).toBeNull();
  });

  it('says "Variant", and never the programming word the icon suggests', () => {
    renderButton();
    const button = screen.getByTestId('start-variant');
    expect(button).toHaveTextContent('Variant');
    expect(button.textContent?.toLowerCase()).not.toMatch(/branch|fork/);
  });

  it('says what the variant starts from before it starts one', async () => {
    renderButton();
    // Not read until the question is on screen: a room that never starts a variant
    // never asks the database which meeting it would leave from.
    expect(screen.queryByTestId('start-variant-origin')).toBeNull();

    await open();

    const origin = screen.getByTestId('start-variant-origin');
    // "S3 · 24 Sep" — the label the map gives the meeting, and the day it was held.
    expect(origin).toHaveTextContent('Starts from: S3');
    expect(origin.textContent).toMatch(/S3 · \d{1,2} Sep/);
  });
});

describe('starting a variant from a meeting', () => {
  it('leaves from that meeting, drops the line cache, and opens the new variant\'s room', async () => {
    renderButton();
    await open();

    // Start with no name does nothing: a variant nobody named is a row on a map nobody
    // can read, and the endpoint would refuse it anyway.
    expect(screen.getByTestId('start-variant-go')).toBeDisabled();

    await start('Steel hinge pin');

    expect(explore.call).toHaveBeenCalledTimes(1);
    // (reviewId, from, name, context) — batch BX made the second argument an OBJECT: it
    // used to be the bare parentSessionId, and the line was implied by it, which is why a
    // variant could only ever be started from a meeting of the main line.
    expect(explore.call.mock.calls[0][0]).toBe('r1');
    expect(explore.call.mock.calls[0][1]).toEqual({ parentSessionId: 'sess-3', parentLineId: 'line-main' });
    expect(explore.call.mock.calls[0][2]).toBe('Steel hinge pin');
    // The cache holds the lines as they were before the write, and the room this
    // navigates to resolves its line out of it.
    expect(repo.resets).toBe(1);
    expect(screen.getByTestId('path').textContent).toBe('/room/r1?line=line-new');
  });

  it('opens through the host when the host has its own way into a room', async () => {
    // The lobby passes its own enterRoom, which submits the name form first. Navigating
    // here instead would drop the person into a room the lobby has not told them about.
    const opened = vi.fn<(lineId: string | null) => void>();
    renderButton({ onOpenLine: opened });
    await open();
    await start('Steel hinge pin');

    expect(opened).toHaveBeenCalledWith('line-new');
    expect(screen.getByTestId('path').textContent).toBe('/room/r1');
    expect(repo.resets).toBe(1);
  });

  it('leaves from the LINE the room is standing on when that is a variant', async () => {
    // Batch BX, and the half that makes a variant of a variant possible: parentLineId is
    // what the new room reads its model, its saved positions and its carried-over cards
    // from. Sent as null inside Variant A, the new variant would open on the main line's
    // model — the one answer that is wrong exactly here.
    repo.origin.current = SESSION_ON_VARIANT;
    renderButton({ lineId: 'line-a' });
    await open();

    expect(screen.getByTestId('start-variant-origin')).toHaveTextContent('Starts from: A1');

    await start('Glass-filled nylon');

    expect(explore.call.mock.calls[0][1]).toEqual({ parentSessionId: 'sess-a1', parentLineId: 'line-a' });
    expect(screen.getByTestId('path').textContent).toBe('/room/r1?line=line-new');
  });

  it('still names the line it is standing on when the review’s lines cannot be read', async () => {
    // An install whose lines cannot be read has no meeting to name either, but the room
    // knows which line IT is on, and that is enough for the endpoint to write the parent.
    repo.lines.current = [];
    repo.origin.current = null;
    renderButton({ lineId: 'line-a' });
    await open();
    await start('Glass-filled nylon');

    expect(explore.call.mock.calls[0][1]).toEqual({ parentSessionId: null, parentLineId: 'line-a' });
  });

  it('passes the meeting-host claim on, for a deployment with no accounts to verify', async () => {
    renderButton({ isMeetingHost: true });
    await open();
    await start('Steel hinge pin');

    expect(explore.call.mock.calls[0][3]).toEqual({ isMeetingHost: true });
  });

  it('says what the endpoint refused, and stays in the room it was in', async () => {
    explore.call.mockResolvedValue({ ok: false, error: 'Only an owner or an editor can change this review’s variants.' });
    renderButton();
    await open();
    await start('Steel hinge pin');

    expect(await screen.findByRole('status')).toHaveTextContent('Only an owner or an editor');
    expect(repo.resets).toBe(0);
    expect(screen.getByTestId('path').textContent).toBe('/room/r1');
  });
});

describe('starting a variant in a review that has never met', () => {
  beforeEach(() => {
    repo.origin.current = null;
  });

  it('says it starts from the model as it is now, and names no meeting', async () => {
    renderButton();
    await open();

    expect(screen.getByTestId('start-variant-origin')).toHaveTextContent(
      'Starts from: the model as it is now',
    );

    await start('Glass-filled nylon');

    // NULL for the meeting, not an empty string and not a made-up session:
    // api/reviews/lines.ts accepts a missing parent only when the line really has no
    // sessions, and writes parent_session_id NULL so the map draws the variant leaving from
    // the start of the line rather than from a stop it was never given. The LINE still goes,
    // and it is the whole answer for a variant of a variant that has never met anywhere.
    expect(explore.call.mock.calls[0][1]).toEqual({ parentSessionId: null, parentLineId: 'line-main' });
    expect(screen.getByTestId('path').textContent).toBe('/room/r1?line=line-new');
  });

  it('starts from the review\'s main line when the room is not standing on a line at all', async () => {
    repo.lines.current = [];
    renderButton();
    await open();

    // No line rows: nothing was written to find out (the lobby opens this popover too,
    // and a popover must not create a main line), and no line means no meeting.
    expect(screen.getByTestId('start-variant-origin')).toHaveTextContent('the model as it is now');
  });
});
