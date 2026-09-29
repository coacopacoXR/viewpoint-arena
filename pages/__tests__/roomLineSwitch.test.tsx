// Switching the line a room is on, from inside the room, without a reload —
// pages/RoomPage.tsx.
//
// docs/plan/15-sessions-and-variants.md batch BX. The user's report was that a variant
// could not be opened at all; the fix for that is lib/reviews/openLine, which gives an
// arrival the two things the room's entry guard admits it by. This file is about the
// OTHER half of the same complaint: once a room can be moved onto another line — from
// the chip's "Go to…", from the Variant menu, from the session map — the move has to be
// a move and not a partial one.
//
// A line is a different PartyKit room, a different scene, a different set of
// carried-over cards, a different Edit lock and a different name on the chip, and until
// this batch every one of those was owned by an effect or a ref whose dependency list
// had no line in it — because a room could not change line without a page load. So what
// is pinned here is the whole set, by watching the room rebuild itself: the socket is
// asked for the new room's name and never for two at once, the store's line and review
// are cleared by the old session's unmount and set again by the new one, and the review
// is seeded afresh rather than carried over.
//
// And the one room that must NOT behave like a meeting: a line that was dropped, whose
// address keeps working because a dropped variant is kept for the record. It says why it
// was dropped and offers the main line, and the room server refuses its scene changes —
// partykit/__tests__/server.reviewLinesFacts.test.ts is where that half is pinned.
//
// The harness is pages/__tests__/roomLineQuery.test.tsx's: the real RoomPage and the
// real stores, with the socket, the canvas and the database stood in for.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

const ROOM = 'review-1';
const MAIN_ID = 'line-main';
const A_ID = 'line-a';
const B_ID = 'line-b';
const DROPPED_ID = 'line-c';

// ─── The room's surroundings ────────────────────────────────────────────────

const presence = vi.hoisted(() => ({
  /** Every room name the page asked the socket for, in order. */
  rooms: [] as Array<string | undefined>,
  localUserId: 'user-me',
}));

vi.mock('../../lib/usePartyPresence', async () => {
  const build = () => ({
    localUserId: presence.localUserId,
    remoteParticipants: { current: new Map() },
    remoteLasers: { current: new Map() },
    remoteParticipantList: [],
    setSameRoom: () => {},
    broadcastPresence: () => {},
    broadcastPresenterChange: () => {},
    broadcastInsightCard: () => {},
    broadcastLeaderChange: () => {},
    broadcastBoardroomCountdown: () => {},
    broadcastArenaEntry: () => {},
    broadcastLaserMove: () => {},
    broadcastPrivacyMode: () => {},
    broadcastLeaderTakeover: () => {},
    broadcastSceneUpdate: () => false,
    broadcastSetModelEditors: () => false,
    broadcastReviewConfig: () => true,
    requestReviewEdit: () => {},
    endReviewEdit: () => {},
    broadcastMeetingEnd: () => {},
    broadcastTakeoverSync: () => {},
    broadcastHostTransfer: () => {},
    broadcastPresenterRequest: () => {},
    broadcastPresenterRequestDenied: () => {},
    broadcastTakeoverAttempt: () => {},
    broadcastCommentAdd: () => {},
    broadcastCommentUpdate: () => {},
    broadcastCommentDelete: () => {},
    broadcastCommentResolve: () => {},
    broadcastChatMessage: () => {},
    broadcastXRPresence: () => {},
    broadcastWebRTCSignal: () => {},
    registerWebRTCSignalHandler: () => () => {},
  });
  return {
    usePartyPresence: (roomId?: string) => {
      presence.rooms.push(roomId);
      return build();
    },
    useJoinState: () => 'admitted',
    useJoinRequests: () => [],
    useJoinPolicy: () => 'open' as const,
  };
});

vi.mock('../../lib/useWebRTC', () => ({ useWebRTC: () => ({}) }));
vi.mock('../../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../lib/RecordingContext', () => ({
  RecordingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../lib/reviewParticipantsRepo', () => ({
  recordJoin: () => Promise.resolve(),
  joinRoleFor: () => null,
}));

// Which review the room seeds itself from is one of the things under test: a switch
// that did not re-seed would leave the new line showing the model the old one was on.
const curations = vi.hoisted(() => ({
  loadedFor: [] as Array<string | null | undefined>,
}));

vi.mock('../../lib/curationsRepo', () => ({
  loadCuration: (reviewId: string) => {
    curations.loadedFor.push(reviewId);
    return Promise.resolve(null);
  },
  createReview: () => Promise.resolve(null),
  saveCuration: () => Promise.resolve(),
}));

vi.mock('../../components/Scene/ViewpointCanvas', () => ({ default: () => null }));
vi.mock('../../components/UI/MobileRoomView', () => ({ default: () => null }));
vi.mock('../../components/UI/ManagerPanel', () => ({ default: () => null }));
vi.mock('../../components/UI/RemoteAudioSink', () => ({ default: () => null }));
vi.mock('../../components/UI/JoinWaitingRoom', () => ({ default: () => null }));
vi.mock('../../components/UI/Interface', () => ({ default: () => null }));

// ─── The database, and the lines in it ──────────────────────────────────────

const db = vi.hoisted(() => ({
  lines: [] as Array<Record<string, unknown>>,
  down: false,
}));

vi.mock('../../lib/supabase', () => {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: () => query,
    single: () => Promise.resolve({ data: null, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(db.down ? { data: null, error: { message: 'down' } } : { data: db.lines, error: null }).then(resolve),
  };
  const channel = {
    on: () => channel, subscribe: () => channel, presenceState: () => ({}),
    track: () => Promise.resolve({ error: null }), unsubscribe: () => {},
  };
  return {
    supabase: {
      from: () => query,
      channel: () => channel,
      removeChannel: () => {},
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
    supabaseConfigured: true,
  };
});

const { default: RoomPage } = await import('../RoomPage');
const { useStore } = await import('../../store');
const { resetLineCache } = await import('../../lib/reviews/linesRepo');
const { openLine } = await import('../../lib/reviews/openLine');

/** The one line this review has that nobody is exploring any more. */
const DROPPED_REASON = 'Dropped with Variant C: Too expensive to tool';

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    review_id: ROOM, kind: 'variant', parent_session_id: null, parent_line_id: MAIN_ID,
    status: 'active', created_by: null, created_by_name: 'Robin', closed_at: null,
    merged_into_line_id: null, drop_reason: null, ...overrides,
  };
}

const ROWS = [
  row({
    id: MAIN_ID, kind: 'main', name: 'Main line', letter: null, parent_line_id: null,
    created_at: '2026-03-01T09:00:00.000Z',
  }),
  // B was started from A, which is the shape batch BX makes possible and the one the
  // switch below has to survive: two variants that are not siblings.
  row({ id: A_ID, name: 'Weld fix', letter: 'A', parent_session_id: 'sess-2', created_at: '2026-05-04T09:00:00.000Z' }),
  row({ id: B_ID, name: 'Lighter frame', letter: 'B', parent_line_id: A_ID, created_at: '2026-06-01T09:00:00.000Z' }),
  row({
    id: DROPPED_ID, name: 'Carbon', letter: 'C', parent_line_id: A_ID,
    status: 'dropped', drop_reason: DROPPED_REASON, closed_at: '2026-07-01T09:00:00.000Z',
    created_at: '2026-06-15T09:00:00.000Z',
  }),
];

// ─── Switching line from inside the room ────────────────────────────────────

/** The room's own way of moving between lines, held where a test can press it. */
const switcher = vi.hoisted(() => ({
  go: null as null | ((lineId: string | null) => void),
}));

const Switcher: React.FC = () => {
  const navigate = useNavigate();
  React.useEffect(() => {
    switcher.go = (lineId: string | null) => openLine(navigate, ROOM, lineId);
    return () => { switcher.go = null; };
  }, [navigate]);
  return null;
};

/** Let every promise the room's resolve started land, without moving the clock. */
async function settle() {
  for (let turn = 0; turn < 8; turn++) {
    await act(async () => { await Promise.resolve(); });
  }
}

function renderRoom(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Switcher />
      <Routes>
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function goTo(lineId: string | null) {
  act(() => { switcher.go?.(lineId); });
  await settle();
}

/** The room names the socket was asked for, with the repeats a re-render makes gone. */
function roomsAsked(): Array<string | undefined> {
  return presence.rooms.filter((name, at) => name !== presence.rooms[at - 1]);
}

beforeEach(() => {
  presence.rooms = [];
  curations.loadedFor = [];
  db.lines = ROWS;
  db.down = false;
  // The room's entry guard sends a visitor who did not come from the lobby back there;
  // this is what a deliberate entry records. And openLine refuses to enter a room for a
  // browser with no name, which is the lobby's rule and a good one.
  sessionStorage.setItem('vp_enteredRoom', ROOM);
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Robin', color: '#000' }));
  resetLineCache();
  useStore.getState().setActiveLine(null);
  useStore.getState().setActiveReviewId(null);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

describe('a room that moves from line to line without a reload', () => {
  it('goes main → variant → another variant → main, and joins each room in turn', async () => {
    renderRoom(`/room/${ROOM}`);
    await settle();

    // The main line's room is the review's own id, with no suffix — the address every
    // link already in circulation opens.
    expect(roomsAsked().at(-1)).toBe(ROOM);
    expect(useStore.getState().activeLine?.id).toBe(MAIN_ID);

    await goTo(A_ID);
    expect(roomsAsked().at(-1)).toBe(`${ROOM}~A`);
    expect(useStore.getState().activeLine?.id).toBe(A_ID);

    await goTo(B_ID);
    expect(roomsAsked().at(-1)).toBe(`${ROOM}~B`);
    expect(useStore.getState().activeLine?.id).toBe(B_ID);

    await goTo(null);
    expect(roomsAsked().at(-1)).toBe(ROOM);
    expect(useStore.getState().activeLine?.id).toBe(MAIN_ID);

    // And it never asked for two rooms at once: a switch that connected to the new line
    // before leaving the old one would put this person on two participant lists, in two
    // calls, able to move two models.
    const asked = roomsAsked().filter((name): name is string => typeof name === 'string');
    expect(asked).toEqual([ROOM, `${ROOM}~A`, `${ROOM}~B`, ROOM]);
  });

  it('does not join the line it is leaving while the new one is being read', async () => {
    renderRoom(`/room/${ROOM}`);
    await settle();

    // A variant's line has to be resolved before the socket opens, so the room is
    // connected to NOTHING for the moment the read takes — which the join gate already
    // renders as a waiting room, and which is the invariant roomLineQuery pins.
    presence.rooms = [];
    act(() => { switcher.go?.(B_ID); });
    expect(presence.rooms[0]).toBeUndefined();

    await settle();
    expect(presence.rooms.at(-1)).toBe(`${ROOM}~B`);
  });

  it('seeds the review again for each line, so the new room opens on its own model', async () => {
    renderRoom(`/room/${ROOM}`);
    await settle();
    const afterFirst = curations.loadedFor.length;
    expect(afterFirst).toBeGreaterThan(0);

    await goTo(A_ID);
    // The seed is what puts a review's scene up, and lib/scene/showCurationModel rebuilds
    // it once per (review, line). A switch that did not re-seed would leave the new line
    // showing whatever the old one had on screen — and on a line whose own room server has
    // never held a scene, that is nothing at all.
    expect(curations.loadedFor.length).toBeGreaterThan(afterFirst);

    await goTo(B_ID);
    expect(curations.loadedFor.length).toBeGreaterThan(afterFirst + 1);
  });

  it('keeps the mark that lets a reload of the new line back in', async () => {
    renderRoom(`/room/${ROOM}`);
    await settle();

    await goTo(B_ID);

    // openLine writes the mark the entry guard reads. Without it a reload of a variant's
    // address — where the router state is gone because the browser has nothing left to
    // carry it in — bounces to the lobby, which is the first thing the user reported.
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe(ROOM);
    // And the room is still on the line it was moved to, not back at the door.
    expect(roomsAsked().at(-1)).toBe(`${ROOM}~B`);
    expect(useStore.getState().activeLine?.id).toBe(B_ID);
  });
});

describe('a room opened on a line that was dropped', () => {
  it('says why, and offers the main line', async () => {
    renderRoom(`/room/${ROOM}?line=${DROPPED_ID}`);
    await settle();

    const banner = screen.getByTestId('dropped-line-banner');
    expect(banner.textContent).toContain('This variant was dropped');
    // The reason as the meeting gave it, and NOT the sentence its cards carry: that one
    // begins "Dropped with Variant C:", which under a banner already naming the variant
    // reads as a stutter.
    expect(banner.textContent).toContain('Too expensive to tool');
    expect(banner.textContent).not.toContain('Dropped with Variant C');
  });

  it('is a room on the dropped line, and not on the main line', async () => {
    // The banner is not a redirect. A dropped variant is kept for the record and its
    // address keeps working, so the person who follows a three-week-old link sees the
    // line they asked for and is told what happened to it.
    renderRoom(`/room/${ROOM}?line=${DROPPED_ID}`);
    await settle();

    expect(useStore.getState().activeLine?.id).toBe(DROPPED_ID);
    expect(roomsAsked().at(-1)).toBe(`${ROOM}~C`);
  });

  it('leaves for the main line when the banner is used', async () => {
    renderRoom(`/room/${ROOM}?line=${DROPPED_ID}`);
    await settle();

    await act(async () => {
      screen.getByTestId('dropped-line-banner').querySelector('button')?.click();
    });
    await settle();

    expect(screen.queryByTestId('dropped-line-banner')).toBeNull();
    expect(useStore.getState().activeLine?.id).toBe(MAIN_ID);
    expect(roomsAsked().at(-1)).toBe(ROOM);
  });

  it('says nothing about a line still being explored', async () => {
    renderRoom(`/room/${ROOM}?line=${A_ID}`);
    await settle();

    expect(screen.queryByTestId('dropped-line-banner')).toBeNull();
  });
});
