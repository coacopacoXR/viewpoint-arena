// Where /review/:reviewId/setup goes now that the curate page is gone.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. pages/ReviewSetupRedirect.tsx
// is three lines of routing, and all three are worth pinning because the address
// is already out in the world — bookmarks, tracker and PLM links, messages sent
// last week — and a removed route in a single-page app quietly answers with the
// lobby instead of the review somebody meant to open.
//
// What is pinned here:
//
//   1. the setup address lands on the ROOM's address with `?edit=1`, so the side
//      panel opens with Edit on rather than the room being read-only
//   2. the router STATE travels with it — the PLM "Launch in Arena" flow arrives
//      here carrying `{ plmLaunch: { source, doc } }`, and dropping it would lose
//      the one thing that says which Onshape document the room was opened for
//   3. the navigation is a REPLACE, so the browser's Back button returns to
//      wherever the person was before, not to an address that no longer exists
//   4. an address that names no review falls back to the lobby
//
// The routes below mirror App.tsx's table for these paths, with a probe standing
// in for RoomPage (modelled on SetupProbe in LaunchPage.test.tsx). Nothing about
// the component is mocked.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  MemoryRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
  useNavigationType,
  useParams,
} from 'react-router-dom';
import ReviewSetupRedirect from '../ReviewSetupRedirect';

type Entry = string | { pathname: string; state?: unknown };

/** Stands in for RoomPage: reports where the redirect landed, and with what. */
const RoomProbe: React.FC = () => {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const { roomId } = useParams<{ roomId: string }>();
  const state = location.state as { plmLaunch?: { source: string } } | null;
  return (
    <div>
      <span data-testid="room-path">{location.pathname}</span>
      <span data-testid="room-search">{location.search}</span>
      <span data-testid="room-id">{roomId ?? ''}</span>
      <span data-testid="room-state">{JSON.stringify(state)}</span>
      <span data-testid="launch-source">{state?.plmLaunch?.source ?? 'none'}</span>
      <span data-testid="nav-type">{navigationType}</span>
      <button onClick={() => navigate(-1)}>Back</button>
    </div>
  );
};

/** The routes App.tsx registers for these paths, minus the gates. */
function renderAppRoutes(...entries: Entry[]) {
  render(
    <MemoryRouter initialEntries={entries}>
      <Routes>
        <Route path="/review/:reviewId/setup" element={<ReviewSetupRedirect />} />
        <Route path="/room/:roomId" element={<RoomProbe />} />
        {/* Where the person was before the link, for the Back test. */}
        <Route path="/earlier" element={<div data-testid="earlier">the page they came from</div>} />
        <Route path="/" element={<div data-testid="lobby">lobby</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * The same component mounted where `useParams()` has no `reviewId` at all.
 *
 * That is the only way to reach the `if (!reviewId)` guard: react-router 7 will
 * NOT match `/review/:reviewId/setup` against `/review//setup`, because a param
 * segment has to be non-empty (verified — the address matches no route and
 * renders nothing at all). The guard is defence in depth, so it is tested
 * directly rather than through an address that cannot get there.
 */
function renderWithoutReviewId(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/review/setup" element={<ReviewSetupRedirect />} />
        <Route path="/room/:roomId" element={<RoomProbe />} />
        <Route path="/" element={<div data-testid="lobby">lobby</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('the setup address a bookmark or a PLM link still carries', () => {
  it('lands on the room, with Edit on', async () => {
    renderAppRoutes('/review/rev-1/setup');

    expect(await screen.findByTestId('room-path')).toBeInTheDocument();
    expect(screen.getByTestId('room-path').textContent).toBe('/room/rev-1');
    expect(screen.getByTestId('room-search').textContent).toBe('?edit=1');
    expect(screen.getByTestId('room-id').textContent).toBe('rev-1');
    // The review is NOT created here: arriving at a setup address means a review
    // with that id was already meant to exist, and the room says so if it does
    // not. What the redirect carries is the id, unchanged.
    expect(screen.queryByTestId('lobby')).toBeNull();
  });

  it('carries the router state across, which is what a PLM launch travels in', async () => {
    const plmLaunch = { source: 'onshape', doc: { id: 'a1b2c3d4e5f60718293a4b5c' } };
    renderAppRoutes({ pathname: '/review/rev-1/setup', state: { plmLaunch } });

    expect(await screen.findByTestId('room-path')).toBeInTheDocument();
    expect(screen.getByTestId('launch-source').textContent).toBe('onshape');
    expect(JSON.parse(screen.getByTestId('room-state').textContent ?? 'null')).toEqual({
      plmLaunch,
    });
  });

  it('replaces rather than pushes, so Back skips the address that no longer exists', async () => {
    renderAppRoutes('/earlier', '/review/rev-1/setup');

    expect(await screen.findByTestId('room-path')).toBeInTheDocument();
    expect(screen.getByTestId('nav-type').textContent).toBe('REPLACE');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    // A push would have left the dead address in the stack: Back would land on
    // it, the redirect would fire again, and the person would be thrown straight
    // back into the room with no way out. Landing on the page they came from is
    // the whole point of `replace`.
    expect(await screen.findByTestId('earlier')).toBeInTheDocument();
    expect(screen.queryByTestId('room-path')).toBeNull();
  });
});

describe('an address that names no review', () => {
  it('falls back to the lobby', async () => {
    renderWithoutReviewId('/review/setup');

    expect(await screen.findByTestId('lobby')).toBeInTheDocument();
    expect(screen.queryByTestId('room-path')).toBeNull();
  });

  it('is not matched by the route at all when the id is simply empty', () => {
    // `/review//setup`: react-router's param will not accept an empty segment,
    // so nothing renders — which in the real app means a blank page rather than
    // a wrong room. Recorded here so the next person does not re-derive it.
    renderAppRoutes('/review//setup');

    expect(screen.queryByTestId('room-path')).toBeNull();
    expect(screen.queryByTestId('lobby')).toBeNull();
    expect(document.body.textContent).toBe('');
  });
});
