// A room opened on a line of a design review joins THAT line's live room.
//
// docs/plan/15-sessions-and-variants.md batch BK. `/room/<reviewId>` is the main
// line and every link already in circulation keeps opening the room it always did;
// `/room/<reviewId>?line=<lineId>` is one of its variants, whose meetings are held in
// a PartyKit room of their own (`<reviewId>~<letter>`) so a variant has its own
// presence, its own audio and its own scene.
//
// The invariant that matters is the negative one, and it is why the whole page is
// rendered rather than a helper unit-tested: the room must NOT join the main line's
// meeting for the moment it takes to read which line it is on. Joining and then
// moving would put the person on the main line's participant list, in its call, able
// to move its model — and everybody already in it would see somebody arrive and then
// vanish.
//
// The harness is pages/__tests__/roomReviewPersistence.test.tsx's: the real RoomPage
// and the real stores, with the socket, the canvas and the database stood in for.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const ROOM = 'review-1';
const VARIANT_ID = 'line-a';

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

// Which id the room reads its curation by is one of the things under test, so the
// read is recorded rather than answered from the fake database below.
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
  /** The review_lines rows this install has. */
  lines: [] as Array<Record<string, unknown>>,
  /** Set to fail every read, for an install with no review_lines table. */
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

// lib/reviews/linesRepo is NOT mocked: listLines, resolveLine and ensureMainLine all
// run for real against the faked supabase above, so "the address named a line that is
// not this review's" really does go through the fallback rather than through a stub
// of it.

const { default: RoomPage } = await import('../RoomPage');
const { useStore } = await import('../../store');
const { toReviewLine } = await import('../../lib/reviews/lines');
const { resetLineCache } = await import('../../lib/reviews/linesRepo');

const MAIN_ROW = {
  id: 'line-main', review_id: ROOM, kind: 'main', name: 'Main line', letter: null,
  parent_session_id: null, status: 'active', created_by: null, created_by_name: '',
  created_at: '2026-03-01T09:00:00.000Z', closed_at: null,
};

const VARIANT_ROW = {
  id: VARIANT_ID, review_id: ROOM, kind: 'variant', name: 'Weld fix', letter: 'A',
  parent_session_id: 'sess-2', status: 'active', created_by: null, created_by_name: 'Robin',
  created_at: '2026-05-04T09:00:00.000Z', closed_at: null,
};

/** Let every promise the room's resolve started land, without moving the clock. */
async function settle() {
  for (let turn = 0; turn < 6; turn++) {
    await act(async () => { await Promise.resolve(); });
  }
}

function renderRoom(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  presence.rooms = [];
  curations.loadedFor = [];
  db.lines = [MAIN_ROW, VARIANT_ROW];
  db.down = false;
  // The room's own entry guard sends a visitor who did not come from the lobby back
  // there; this is what a deliberate entry records.
  sessionStorage.setItem('vp_enteredRoom', ROOM);
  resetLineCache();
  useStore.getState().setActiveLine(null);
  useStore.getState().setActiveReviewId(null);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('a room opened with no ?line=', () => {
  it('joins the review\'s own PartyKit room, exactly as every link already does', async () => {
    renderRoom(`/room/${ROOM}`);
    await settle();

    expect(presence.rooms[0]).toBe(ROOM);
    expect(presence.rooms.every((name) => name === ROOM)).toBe(true);
  });

  it('is on the main line, whether or not the database had a row saying so', async () => {
    renderRoom(`/room/${ROOM}`);
    await settle();

    expect(useStore.getState().activeLine?.kind).toBe('main');
    expect(useStore.getState().activeLine?.id).toBe('line-main');
  });

  it('still opens on an install whose database has no review_lines table', async () => {
    // A room that waits for a line it cannot resolve is a room nobody can enter.
    db.down = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderRoom(`/room/${ROOM}`);
    await settle();
    error.mockRestore();

    expect(presence.rooms[0]).toBe(ROOM);
    expect(useStore.getState().activeLine).toBeNull();
  });
});

describe('a room opened on a variant', () => {
  it('joins the variant\'s own PartyKit room, not the review\'s', async () => {
    renderRoom(`/room/${ROOM}?line=${VARIANT_ID}`);
    await settle();

    expect(presence.rooms).toContain(`${ROOM}~A`);
    expect(useStore.getState().activeLine?.id).toBe(VARIANT_ID);
  });

  it('never joins the main line\'s room on the way', async () => {
    // The whole point of resolving the line before opening the socket: joining and
    // then moving would put this person on the main line's participant list, in its
    // call, able to move its model, and then take them away again.
    renderRoom(`/room/${ROOM}?line=${VARIANT_ID}`);
    await settle();

    expect(presence.rooms).not.toContain(ROOM);
    expect(presence.rooms[0]).toBeUndefined();
  });

  it('falls back to the main line for a line id that is not this review\'s', async () => {
    // A stale link or a variant somebody deleted. A room that opens on a line it
    // cannot find must still open.
    renderRoom(`/room/${ROOM}?line=line-from-somewhere-else`);
    await settle();

    expect(presence.rooms).toContain(ROOM);
    expect(useStore.getState().activeLine?.id).toBe('line-main');
  });

  it('reads the review by its own id, not by the variant room name', async () => {
    // The curation row is keyed on the review id: a variant's meeting is a meeting of
    // the SAME design review, with the same viewpoints and the same pins. Reading it
    // by `<reviewId>~A` would find no row and open the variant as an ad-hoc room.
    renderRoom(`/room/${ROOM}?line=${VARIANT_ID}`);
    await settle();

    expect(curations.loadedFor).toContain(ROOM);
    expect(curations.loadedFor).not.toContain(`${ROOM}~A`);
  });
});

describe('leaving the room', () => {
  it('takes the line with it, so the next room cannot inherit it', async () => {
    const view = renderRoom(`/room/${ROOM}?line=${VARIANT_ID}`);
    await settle();
    expect(useStore.getState().activeLine?.id).toBe(VARIANT_ID);

    view.unmount();
    // A meeting ended from the lobby, or from the next room this browser opens, must
    // not be numbered on a line it was never held on.
    expect(useStore.getState().activeLine).toBeNull();
  });
});

describe('the line the room resolved', () => {
  it('is a real row of the review, with the letter its room name is built from', async () => {
    renderRoom(`/room/${ROOM}?line=${VARIANT_ID}`);
    await settle();

    const line = useStore.getState().activeLine;
    expect(line).toEqual(toReviewLine(VARIANT_ROW));
    expect(line?.letter).toBe('A');
  });
});
