// An edit made in the room reaches the database.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH2, bug 1. Found live: a signed-in
// owner pressed "New design review", saved a view from the amber strip, pressed
// Done, and `review_curations.viewpoints` for that row was still empty. The row
// existed — the lobby's createReview had written it — so what was missing was the
// room's own write.
//
// This is the whole path rather than a unit of it, because the path is where the
// bug was: RoomPage seeds the review, RoomPage subscribes to it, and RoomPage's
// subscriber is the only thing that calls saveCuration. So the real RoomPage is
// rendered, the real stores are used, the real EditingStrip is clicked, the real
// lib/curationsRepo builds the row — and ONLY the Supabase client under it is
// fake, which is what makes the asserted payload the one draftToRow produced.
//
// What cannot run in jsdom is stood in for, and each stand-in is a thing the room
// server or the GPU would otherwise be doing:
//   * ViewpointCanvas / ManagerPanel — an R3F canvas has no WebGL here;
//   * Interface — replaced by the real EditingStrip, which is the bar the button
//     is in, so the click travels the same handler;
//   * usePartyPresence — a socket. Its `endReviewEdit` does what the server's
//     EDITING_STATE(null) does to every client, because Done is a question and
//     the flush this file asserts happens when the answer arrives.
//
// The hook returns a FRESH object on every render, exactly as the real one does
// (lib/usePartyPresence builds an object literal at the end of the hook). That
// detail is load-bearing: it is what makes `rerender(...)` below reproduce a live
// room re-render, and a live room re-render is what used to throw the edit away.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReviewDraft } from '../../lib/reviewSetupStore';
import type { ViewCapture } from '../../types';

const ROOM = 'room-1';
const ME = 'user-me';

// ─── The database ────────────────────────────────────────────────────────────

/** One `review_curations` row, and every upsert this room made against it. */
const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../lib/supabase', () => {
  // PostgREST's chain, in the two shapes curationsRepo uses: a query, whose
  // terminals answer with `{ data, error }`, and a mutation, whose `.eq()` is
  // itself the terminal and answers with `{ error }`.
  const mutation = { eq: () => Promise.resolve({ error: null }) };
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve({ data: db.row ? { ...db.row } : null, error: null }),
    update: (patch: Record<string, unknown>) => {
      db.row = { ...(db.row ?? {}), ...patch };
      return mutation;
    },
    upsert: (row: Record<string, unknown>) => {
      db.upserts.push(row);
      db.row = { ...(db.row ?? {}), ...row };
      return Promise.resolve({ error: null });
    },
    delete: () => mutation,
  };
  const channel = {
    on: () => channel,
    subscribe: () => channel,
    presenceState: () => ({}),
    track: () => Promise.resolve({ error: null }),
    unsubscribe: () => {},
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

// ─── The room's surroundings ─────────────────────────────────────────────────

const presence = vi.hoisted(() => ({
  localUserId: 'user-me',
  broadcasts: [] as Array<{ viewpoints: unknown[] }>,
  endReviewEdits: 0,
}));

vi.mock('../../lib/usePartyPresence', async () => {
  const { useStore } = await import('../../store');
  const build = () => ({
    get localUserId() { return presence.localUserId; },
    remoteParticipants: { current: new Map() },
    remoteLasers: { current: new Map() },
    remoteParticipantList: [],
    broadcastPresence: () => {},
    setSameRoom: () => {},
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
    broadcastReviewConfig: (config: { viewpoints: unknown[] }) => {
      presence.broadcasts.push(config);
      return true;
    },
    requestReviewEdit: () => {},
    // The room server's answer to Done: EDITING_STATE with nobody in it, relayed
    // to the sender too. RoomPage's persistence subscriber is torn down by that
    // change of `reviewEditing`, and its teardown is the flush under test.
    endReviewEdit: () => {
      presence.endReviewEdits += 1;
      useStore.getState().setReviewEditing(null);
    },
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
    // A fresh object every call, as the real hook does. See the file header.
    usePartyPresence: () => build(),
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

vi.mock('../../components/Scene/ViewpointCanvas', () => ({ default: () => null }));
vi.mock('../../components/UI/MobileRoomView', () => ({ default: () => null }));
vi.mock('../../components/UI/ManagerPanel', () => ({ default: () => null }));
vi.mock('../../components/UI/RemoteAudioSink', () => ({ default: () => null }));
vi.mock('../../components/UI/JoinWaitingRoom', () => ({ default: () => null }));

// The room's overlay, reduced to the one part of it this file is about: the amber
// strip. Real component, real handler, real store write.
vi.mock('../../components/UI/Interface', async () => {
  const { default: EditingStrip } = await import('../../components/review/EditingStrip');
  const { usePresence } = await import('../../lib/PresenceContext');
  const Strip: React.FC = () => {
    const { endReviewEdit } = usePresence();
    return <EditingStrip onDone={endReviewEdit} />;
  };
  return { default: Strip };
});

// Imported after the mocks are registered.
const { default: RoomPage } = await import('../RoomPage');
const { useStore } = await import('../../store');
const { useActiveReviewStore } = await import('../../lib/activeReviewStore');
const { useReviewSetupStore, createReviewDraft } = await import('../../lib/reviewSetupStore');

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** The camera pose "Save this view" reads out of the canvas. */
const CAPTURE: ViewCapture = {
  position: [1.5, 2, 3.5],
  lookAt: [0, 0.75, 0],
  thumbnail: 'data:image/jpeg;base64,/9j/thumb',
};

/** The row the lobby's createReview wrote, as the database would hold it. */
function dbRowFrom(draft: ReviewDraft, updatedAt: number): void {
  db.row = {
    id: draft.reviewId,
    title: draft.title,
    description: draft.description,
    asset: draft.asset,
    viewpoints: draft.viewpoints,
    pins: draft.pins,
    agenda: draft.agenda,
    requirements: draft.requirements,
    team: draft.team,
    labels: draft.labels,
    listed: draft.listed,
    created_at: new Date(draft.createdAt).toISOString(),
    updated_at: new Date(updatedAt).toISOString(),
  };
}

// A string entry rather than `{ pathname: '/room/x?edit=1' }`: only a string is
// parsed into pathname and search, and a `:roomId` that swallowed the query would
// never equal the review's own id.
const ENTRY = `/room/${ROOM}?edit=1`;

function roomElement() {
  return (
    <MemoryRouter initialEntries={[ENTRY]}>
      <Routes>
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderRoom() {
  const view = render(roomElement());
  return {
    ...view,
    /** A real re-render: a fresh element, so React cannot bail out on identity. */
    rerenderRoom: () => view.rerender(roomElement()),
  };
}

/** Let every promise the room's seed started land, without moving the clock. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

/** The payload of the most recent write to review_curations. */
function lastUpsert(): Record<string, unknown> {
  const last = db.upserts[db.upserts.length - 1];
  expect(last, 'expected the room to have written to review_curations').toBeTruthy();
  return last;
}

function viewpointsOf(row: Record<string, unknown>): unknown[] {
  return Array.isArray(row.viewpoints) ? row.viewpoints : [];
}

/**
 * "New design review" in the lobby: the row is written, and the draft is handed
 * to lib/reviewSetupStore, which is where RoomPage looks first.
 */
function arriveFromLobby(options?: { cloudUpdatedAt?: number; cloudViewpoints?: number }): ReviewDraft {
  const handed = createReviewDraft(ROOM);
  useReviewSetupStore.getState().hydrateDraft(handed);
  const withViews = options?.cloudViewpoints
    ? {
        ...handed,
        viewpoints: Array.from({ length: options.cloudViewpoints }, (_, i) => ({
          id: `saved-${i}`,
          label: `View ${i + 1}`,
          position: [0, 0, 0] as [number, number, number],
          lookAt: [0, 0, 0] as [number, number, number],
          createdAt: handed.createdAt,
        })),
      }
    : handed;
  dbRowFrom(withViews, options?.cloudUpdatedAt ?? handed.updatedAt);
  return handed;
}

/** The camera the canvas would hand over, and the edit lock the room granted. */
function enterEditMode(): void {
  useStore.setState({ _viewCapture: () => CAPTURE, sessionHostId: ME });
  act(() => {
    useStore.getState().setReviewEditing({ userId: ME, name: 'Me' });
  });
}

const SAVE_THIS_VIEW = 'Add the current camera as a viewpoint of the review';
const DONE = 'Finish editing and go back to the meeting';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('vp_enteredRoom', ROOM);
  db.row = null;
  db.upserts = [];
  presence.broadcasts = [];
  presence.endReviewEdits = 0;
  presence.localUserId = ME;
  useActiveReviewStore.getState().setConfig(null);
  useReviewSetupStore.getState().discardDraft();
  useStore.setState({ reviewEditing: null, sessionHostId: null, _viewCapture: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useActiveReviewStore.getState().setConfig(null);
  useReviewSetupStore.getState().discardDraft();
  useStore.setState({ reviewEditing: null, sessionHostId: null, _viewCapture: null });
});

describe('the room writes its review edits to the database', () => {
  it('saves a view taken from the amber strip once the debounce elapses', async () => {
    arriveFromLobby();
    const { rerenderRoom } = renderRoom();
    await settle();
    enterEditMode();
    db.upserts = [];

    fireEvent.click(screen.getByTitle(SAVE_THIS_VIEW));
    expect(useActiveReviewStore.getState().config?.viewpoints).toHaveLength(1);

    // The room re-renders many times during a meeting — the participant list,
    // the join gate, the host. None of them is a reason to lose an edit.
    rerenderRoom();
    expect(useActiveReviewStore.getState().config?.viewpoints).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(1100); });

    expect(viewpointsOf(lastUpsert())).toHaveLength(1);
    expect(viewpointsOf(db.row ?? {})).toHaveLength(1);
  });

  it('flushes the pending write when Done is pressed inside the debounce', async () => {
    arriveFromLobby();
    const { rerenderRoom } = renderRoom();
    await settle();
    enterEditMode();
    db.upserts = [];

    fireEvent.click(screen.getByTitle(SAVE_THIS_VIEW));
    rerenderRoom();
    // Done, well inside the second the debounce would have waited.
    fireEvent.click(screen.getByTitle(DONE));

    expect(presence.endReviewEdits).toBe(1);
    expect(db.upserts).toHaveLength(1);
    expect(viewpointsOf(lastUpsert())).toHaveLength(1);
  });

  it('persists the other curation tabs’ writes the same way', async () => {
    arriveFromLobby();
    const { rerenderRoom } = renderRoom();
    await settle();
    enterEditMode();
    db.upserts = [];

    act(() => {
      useActiveReviewStore.getState().addAgendaItem({ title: 'Mating surfaces' });
    });
    rerenderRoom();
    act(() => {
      useActiveReviewStore.getState().addRequirement({
        code: 'REQ-7',
        description: 'Must seal at 3 bar',
        category: 'MECHANICAL',
        status: 'PENDING',
      });
    });
    rerenderRoom();
    act(() => {
      useActiveReviewStore.getState().setLabel('material', 'Ti-6Al-4V');
    });
    rerenderRoom();

    await act(async () => { vi.advanceTimersByTime(1100); });

    const written = lastUpsert();
    expect(written.agenda).toHaveLength(1);
    expect(written.requirements).toHaveLength(1);
    expect(written.labels).toEqual({ material: 'Ti-6Al-4V' });
  });

  it('reopens on the row that was saved, not on the draft the lobby handed over', async () => {
    // The review was edited and saved in an earlier visit; the lobby's persisted
    // handover draft still describes it as it was when it was created.
    const handed = arriveFromLobby({ cloudUpdatedAt: Date.now() + 60_000, cloudViewpoints: 2 });
    expect(handed.viewpoints).toHaveLength(0);

    renderRoom();
    await settle();

    expect(useActiveReviewStore.getState().config?.viewpoints).toHaveLength(2);
  });

  it('keeps an edit made before the row finished loading', async () => {
    arriveFromLobby({ cloudUpdatedAt: Date.now() - 60_000 });
    renderRoom();
    // No settle(): the read is still in flight when this person starts working.
    enterEditMode();
    fireEvent.click(screen.getByTitle(SAVE_THIS_VIEW));
    await settle();

    expect(useActiveReviewStore.getState().config?.viewpoints).toHaveLength(1);
  });
});
