// Batch BH3: a review that was saved must not be overwritten by an older copy.
//
// docs/plan/14-rooms-models-admin-ai.md. Found live with two signed-in browsers:
// Olivia created a design review, saved a view from the amber strip and pressed
// Done — the row had her viewpoint. Pete joined, was made an editor, reloaded.
// Olivia walked back into the room, and the row's `viewpoints` went to 0 with an
// `updated_at` later than her save, while her own screen still showed the view.
//
// Two clients, one stale copy, and a writer that had nothing of its own to write:
//
//   * Olivia's browser still held the lobby's handover draft in localStorage
//     (`vp_review_draft`) — the EMPTY review "New design review" created, which
//     nothing in the room ever updates. RoomPage seeds from that draft before it
//     reads the row, and seeding broadcasts. So her re-entry put the empty review
//     on the room server and in front of everybody else.
//   * Pete was the host by then (`computeHost` is join order, and he had joined
//     first after she left), so RoomPage's persistence subscriber was live in his
//     browser. That subscriber saved on ANY change to the review it was holding —
//     including one that arrived off the socket. He never edited anything, and he
//     wrote her row away.
//
// So this file drives two real RoomPages in one jsdom, each from its own module
// registry (two browsers: two stores, two `useStore`s, two draft stores) but
// sharing one fake room server and one fake Supabase, which is what makes "who
// wrote the row" a question the test can answer. Every write to
// `review_curations` is recorded with the client that made it.
//
// `vi.resetModules()` + `vi.doMock` is what gives the second browser its own copy
// of the app: node_modules stay singletons (one React, one react-router, one
// RTL), so both rooms render into the same document and share the same router.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReviewDraft } from '../../lib/reviewSetupStore';
import type { ReviewDraftActions } from '../../components/review/draftActions';
import type { ViewCapture } from '../../types';

const ROOM = 'room-1';
const OLIVIA = 'user-olivia';
const PETE = 'user-pete';

type Row = Record<string, unknown>;

// ─── The world both browsers share ───────────────────────────────────────────

const world = vi.hoisted(() => {
  const db = {
    row: null as Record<string, unknown> | null,
    upserts: [] as Array<{ by: string; row: Record<string, unknown> }>,
  };

  /**
   * The room server's REVIEW_CONFIG handling: remember the copy, relay it to
   * every connection except the sender's, and replay it to whoever arrives next
   * (party/room.server.ts sendRoomState).
   */
  const listeners = new Map<string, (config: import('../../lib/reviewSetupStore').ReviewDraft) => void>();
  const room = {
    config: null as import('../../lib/reviewSetupStore').ReviewDraft | null,
    sends: [] as Array<{ by: string; config: import('../../lib/reviewSetupStore').ReviewDraft }>,
    send(by: string, config: import('../../lib/reviewSetupStore').ReviewDraft) {
      room.config = config;
      room.sends.push({ by, config });
      for (const [id, deliver] of listeners) {
        if (id !== by) deliver(config);
      }
    },
    connect(id: string, deliver: (config: import('../../lib/reviewSetupStore').ReviewDraft) => void) {
      listeners.set(id, deliver);
    },
    replay(id: string) {
      const deliver = listeners.get(id);
      if (deliver && room.config) deliver(room.config);
    },
    reset() {
      room.config = null;
      room.sends = [];
    },
  };

  /** The Supabase client lib/curationsRepo talks to, attributed to one browser. */
  function makeSupabase(by: string) {
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
        db.upserts.push({ by, row });
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
  }

  /**
   * lib/usePartyPresence as one browser sees it. The socket is the only thing
   * replaced: `localUserId` is this browser's, `broadcastReviewConfig` puts the
   * draft on the shared room server, and a REVIEW_CONFIG from somebody else lands
   * in THIS registry's review store through `setConfig` — the same call the real
   * handler makes.
   */
  function presenceModule(clientId: string, mods: {
    setReviewEditing: (editing: { userId: string; name: string } | null) => void;
    setConfig: (config: import('../../lib/reviewSetupStore').ReviewDraft) => void;
  }) {
    room.connect(clientId, (config) => mods.setConfig(config));
    const build = () => ({
      localUserId: clientId,
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
      broadcastReviewConfig: (config: import('../../lib/reviewSetupStore').ReviewDraft) => {
        room.send(clientId, config);
        return true;
      },
      requestReviewEdit: () => {},
      endReviewEdit: () => mods.setReviewEditing(null),
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
      // A fresh object every call, exactly as the real hook returns.
      usePartyPresence: () => build(),
      useJoinState: () => 'admitted',
      useJoinRequests: () => [],
      useJoinPolicy: () => 'open' as const,
    };
  }

  const stubs = {
    nullComponent: () => ({ default: () => null }),
    webrtc: () => ({ useWebRTC: () => ({}) }),
    notMobile: () => ({ useIsMobile: () => false }),
    recording: () => ({
      RecordingProvider: ({ children }: { children?: import('react').ReactNode }) => children,
    }),
    participants: () => ({
      recordJoin: () => Promise.resolve(),
      joinRoleFor: () => null,
    }),
  };

  /** Everything a RoomPage needs that jsdom cannot give it, per browser. */
  const SURROUNDINGS: Array<[string, () => unknown]> = [
    ['../../lib/useWebRTC', stubs.webrtc],
    ['../../lib/useIsMobile', stubs.notMobile],
    ['../../lib/RecordingContext', stubs.recording],
    ['../../lib/reviewParticipantsRepo', stubs.participants],
    ['../../components/Scene/ViewpointCanvas', stubs.nullComponent],
    ['../../components/UI/MobileRoomView', stubs.nullComponent],
    ['../../components/UI/ManagerPanel', stubs.nullComponent],
    ['../../components/UI/RemoteAudioSink', stubs.nullComponent],
    ['../../components/UI/JoinWaitingRoom', stubs.nullComponent],
  ];

  return { db, room, makeSupabase, presenceModule, SURROUNDINGS };
});

/** The editing actions Olivia's room built, so a test can drive them directly. */
const captured = vi.hoisted(() => ({
  actions: null as import('../../components/review/draftActions').ReviewDraftActions | null,
}));

// ─── This browser (Olivia): the owner, with Edit on ──────────────────────────

vi.mock('../../lib/supabase', () => world.makeSupabase('user-olivia'));
vi.mock('../../lib/usePartyPresence', async () => {
  const { useStore } = await import('../../store');
  const { useActiveReviewStore } = await import('../../lib/activeReviewStore');
  return world.presenceModule(OLIVIA, {
    setReviewEditing: (editing) => useStore.getState().setReviewEditing(editing),
    setConfig: (config) => useActiveReviewStore.getState().setConfig(config),
  });
});

// The room's overlay, reduced to the amber strip — the real one, so "Save this
// view" travels the real handler — plus the real actions hook, handed to the test.
vi.mock('../../components/UI/Interface', async () => {
  const { default: EditingStrip } = await import('../../components/review/EditingStrip');
  const { useActiveReviewActions } = await import('../../components/review/useActiveReviewActions');
  const { usePresence } = await import('../../lib/PresenceContext');
  const Strip: React.FC = () => {
    const { endReviewEdit } = usePresence();
    captured.actions = useActiveReviewActions();
    return <EditingStrip onDone={endReviewEdit} />;
  };
  return { default: Strip };
});

for (const [path, factory] of world.SURROUNDINGS) vi.doMock(path, factory);

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

const SAVE_THIS_VIEW = 'Add the current camera as a viewpoint of the review';

const viewpoint = (id: string, label: string): ReviewDraft['viewpoints'][number] => ({
  id,
  label,
  position: [0, 0, 0],
  lookAt: [0, 0, 0],
  createdAt: 1_700_000_000_000,
});

/** The review as it is stored: a saved view, two pins, two slides, two reqs. */
function storedDraft(): ReviewDraft {
  const base = createReviewDraft(ROOM, 'Bracket');
  return {
    ...base,
    viewpoints: [viewpoint('vp-1', 'View 1')],
    pins: [
      { id: 'pin-1', label: 'Weld', worldPos: [0, 0, 0], severity: 'info', createdAt: base.createdAt },
      { id: 'pin-2', label: 'Gap', worldPos: [0, 0, 0], severity: 'info', createdAt: base.createdAt },
    ],
    agenda: [
      { id: 'ag-1', title: 'First', viewpointIds: [], pinIds: [] },
      { id: 'ag-2', title: 'Second', viewpointIds: [], pinIds: [] },
    ],
    requirements: [
      { id: 'req-1', code: 'R1', description: 'One', category: 'MECHANICAL', status: 'PENDING' },
      { id: 'req-2', code: 'R2', description: 'Two', category: 'MECHANICAL', status: 'PENDING' },
    ],
  };
}

function putRow(draft: ReviewDraft): void {
  world.db.row = {
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
    updated_at: new Date(draft.updatedAt).toISOString(),
  };
}

function viewpointsOf(holding: { viewpoints?: unknown } | null | undefined): unknown[] {
  return Array.isArray(holding?.viewpoints) ? holding.viewpoints : [];
}

function upsertsBy(client: string): Row[] {
  return world.db.upserts.filter((u) => u.by === client).map((u) => u.row);
}

/** The draft this browser left in localStorage under `vp_review_draft`. */
function persistedHandover(): ReviewDraft | null {
  const raw = localStorage.getItem('vp_review_draft');
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { state?: { draft?: ReviewDraft | null } };
  return parsed.state?.draft ?? null;
}

/** Let every promise the room's seed started land, without moving the clock. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

async function debounceElapses(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1100);
  });
}

function unmount(view: { unmount: () => void }): void {
  act(() => {
    view.unmount();
  });
}

function roomRoute(Page: React.ComponentType, edit: boolean) {
  const element = (
    <MemoryRouter initialEntries={[edit ? `/room/${ROOM}?edit=1` : `/room/${ROOM}`]}>
      <Routes>
        <Route path="/room/:roomId" element={<Page />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(element);
  return { ...view, rerenderRoom: () => view.rerender(element) };
}

/** Olivia's browser: Pete hosts, she has Edit on, the canvas can be captured. */
function enterEditMode(): void {
  useStore.setState({ _viewCapture: () => CAPTURE, sessionHostId: PETE });
  act(() => {
    useStore.getState().setReviewEditing({ userId: OLIVIA, name: 'Olivia' });
  });
}

function editingActions(): ReviewDraftActions {
  const actions = captured.actions;
  if (!actions) throw new Error('the room did not build its editing actions');
  return actions;
}

// ─── The other browser (Pete): admitted, host, never editing ─────────────────

interface OtherBrowser {
  RoomPage: React.ComponentType;
  useStore: typeof import('../../store').useStore;
  useActiveReviewStore: typeof import('../../lib/activeReviewStore').useActiveReviewStore;
  useReviewSetupStore: typeof import('../../lib/reviewSetupStore').useReviewSetupStore;
}

/**
 * A second browser: its own module registry, so its own stores — but the same
 * fake database and the same fake room server as the first one.
 */
async function openSecondBrowser(): Promise<OtherBrowser> {
  vi.resetModules();
  vi.doMock('../../lib/supabase', () => world.makeSupabase(PETE));
  vi.doMock('../../lib/usePartyPresence', async () => {
    const { useStore: peteStore } = await import('../../store');
    const { useActiveReviewStore: peteReview } = await import('../../lib/activeReviewStore');
    return world.presenceModule(PETE, {
      setReviewEditing: (editing) => peteStore.getState().setReviewEditing(editing),
      setConfig: (config) => peteReview.getState().setConfig(config),
    });
  });
  for (const [path, factory] of world.SURROUNDINGS) vi.doMock(path, factory);
  // Pete sees the room, not the amber strip: he has no Edit.
  vi.doMock('../../components/UI/Interface', () => ({ default: () => null }));

  return {
    RoomPage: (await import('../RoomPage')).default,
    useStore: (await import('../../store')).useStore,
    useActiveReviewStore: (await import('../../lib/activeReviewStore')).useActiveReviewStore,
    useReviewSetupStore: (await import('../../lib/reviewSetupStore')).useReviewSetupStore,
  };
}

/** Pete is in the room, admitted, and the host — but he has no Edit. */
async function peteJoins(pete: OtherBrowser) {
  pete.useStore.setState({ sessionHostId: PETE, reviewEditing: null });
  const view = roomRoute(pete.RoomPage, false);
  await settle();
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  sessionStorage.setItem('vp_enteredRoom', ROOM);
  world.db.row = null;
  world.db.upserts = [];
  world.room.reset();
  captured.actions = null;
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

// ─── Two browsers, one row ───────────────────────────────────────────────────

describe('a browser that only receives the review never writes it', () => {
  it('keeps the editor’s saved view when the other browser is told about it', async () => {
    putRow(storedDraft());
    const pete = await openSecondBrowser();
    const peteRoom = await peteJoins(pete);
    expect(viewpointsOf(pete.useActiveReviewStore.getState().config)).toHaveLength(1);

    enterEditMode();
    const olivia = roomRoute(RoomPage, true);
    await settle();
    world.db.upserts = [];

    fireEvent.click(within(olivia.container).getByTitle(SAVE_THIS_VIEW));
    expect(viewpointsOf(useActiveReviewStore.getState().config)).toHaveLength(2);
    await debounceElapses();

    expect(upsertsBy(OLIVIA)).toHaveLength(1);
    expect(viewpointsOf(world.db.row)).toHaveLength(2);
    // Pete was handed the same copy over the socket, and wrote nothing.
    expect(viewpointsOf(pete.useActiveReviewStore.getState().config)).toHaveLength(2);
    expect(upsertsBy(PETE)).toHaveLength(0);

    // A live room re-renders constantly — the participant list, the join gate.
    peteRoom.rerenderRoom();
    await debounceElapses();
    expect(upsertsBy(PETE)).toHaveLength(0);

    // And Pete can leave and come back: the server replays the review to him.
    unmount(peteRoom);
    const peteAgain = await peteJoins(pete);
    world.room.replay(PETE);
    await settle();
    await debounceElapses();
    expect(upsertsBy(PETE)).toHaveLength(0);
    expect(viewpointsOf(world.db.row)).toHaveLength(2);
    unmount(peteAgain);
  });

  it('does not write an older copy of the review that arrives after a newer one', async () => {
    putRow(storedDraft());
    const pete = await openSecondBrowser();
    await peteJoins(pete);

    enterEditMode();
    const olivia = roomRoute(RoomPage, true);
    await settle();
    fireEvent.click(within(olivia.container).getByTitle(SAVE_THIS_VIEW));
    await debounceElapses();
    expect(viewpointsOf(world.db.row)).toHaveLength(2);
    world.db.upserts = [];

    // Olivia's re-entry, as it was before this batch: her browser seeds the room
    // from the empty draft the lobby left in localStorage and broadcasts it, so
    // the room server hands Pete a copy older than the row he is looking at.
    act(() => {
      world.room.send(OLIVIA, createReviewDraft(ROOM, 'Bracket'));
    });
    expect(viewpointsOf(pete.useActiveReviewStore.getState().config)).toHaveLength(0);
    await debounceElapses();

    expect(upsertsBy(PETE)).toHaveLength(0);
    expect(viewpointsOf(world.db.row)).toHaveLength(2);
  });
});

// ─── The handover draft ──────────────────────────────────────────────────────

describe('the lobby’s handover draft is dropped once the room has read the row', () => {
  it('does not put a stale draft in front of the room on a later visit', async () => {
    putRow(storedDraft());
    // "New design review" in the lobby, a visit ago: an empty review, persisted
    // in localStorage, and nothing the room did since ever updated it.
    useReviewSetupStore.getState().hydrateDraft(createReviewDraft(ROOM, 'Bracket'));
    expect(persistedHandover()?.reviewId).toBe(ROOM);

    enterEditMode();
    const firstVisit = roomRoute(RoomPage, true);
    await settle();
    await debounceElapses();
    expect(viewpointsOf(useActiveReviewStore.getState().config)).toHaveLength(1);
    unmount(firstVisit);

    // The row has been read, so the handover copy has nothing left to say — here,
    // or on any later visit from this browser.
    expect(persistedHandover()).toBeNull();
    world.room.reset();
    world.db.upserts = [];

    const secondVisit = roomRoute(RoomPage, true);
    await settle();
    await debounceElapses();

    expect(viewpointsOf(useActiveReviewStore.getState().config)).toHaveLength(1);
    // What this browser put in front of everybody else is the row, not the draft.
    expect(world.room.sends.length).toBeGreaterThan(0);
    for (const { config } of world.room.sends) {
      expect(config.viewpoints).toHaveLength(1);
    }
    expect(upsertsBy(OLIVIA)).toHaveLength(0);
    expect(viewpointsOf(world.db.row)).toHaveLength(1);
    unmount(secondVisit);
  });
});

// ─── Every editing action still saves, exactly once ──────────────────────────

describe('an edit this browser made is written once, after the debounce', () => {
  /**
   * Every write a room can make to its review, in an order that leaves each one
   * something to act on. These are the actions the curation tabs are given, so
   * this is the whole list the tabs can reach — plus "Save this view", which is
   * clicked rather than called.
   */
  const ACTIONS: Array<[string, (actions: ReviewDraftActions) => void]> = [
    ['updateViewpoint', (a) => a.updateViewpoint('vp-1', { label: 'Renamed' })],
    ['updatePin', (a) => a.updatePin('pin-1', { notes: 'Undercut' })],
    ['addAgendaItem', (a) => a.addAgendaItem({ title: 'Third' })],
    ['updateAgendaItem', (a) => a.updateAgendaItem('ag-1', { title: 'First, revised' })],
    ['reorderAgenda', (a) => a.reorderAgenda(0, 1)],
    ['attachViewpointToAgendaItem', (a) => a.attachViewpointToAgendaItem('ag-1', 'vp-1')],
    ['detachViewpointFromAgendaItem', (a) => a.detachViewpointFromAgendaItem('ag-1', 'vp-1')],
    ['attachPinToAgendaItem', (a) => a.attachPinToAgendaItem('ag-1', 'pin-1')],
    ['detachPinFromAgendaItem', (a) => a.detachPinFromAgendaItem('ag-1', 'pin-1')],
    ['removeAgendaItem', (a) => a.removeAgendaItem('ag-2')],
    ['addRequirement', (a) => a.addRequirement({ code: 'R3', description: 'Three', category: 'MECHANICAL', status: 'PENDING' })],
    ['updateRequirement', (a) => a.updateRequirement('req-1', { status: 'AT_RISK' })],
    ['reorderRequirements', (a) => a.reorderRequirements(0, 1)],
    ['removeRequirement', (a) => a.removeRequirement('req-2')],
    ['setLabel', (a) => a.setLabel('material', 'Ti-6Al-4V')],
    ['clearLabel', (a) => a.clearLabel('material')],
    ['removePin', (a) => a.removePin('pin-2')],
    ['removeViewpoint', (a) => a.removeViewpoint('vp-1')],
  ];

  beforeEach(async () => {
    putRow(storedDraft());
    enterEditMode();
    roomRoute(RoomPage, true);
    await settle();
    world.db.upserts = [];
  });

  it('writes each curation-tab action once, and only once the debounce elapses', async () => {
    const actions = editingActions();
    for (const [name, run] of ACTIONS) {
      world.db.upserts = [];
      act(() => {
        run(actions);
      });
      expect(upsertsBy(OLIVIA), `${name}: nothing is written before the debounce`).toHaveLength(0);
      await debounceElapses();
      expect(upsertsBy(OLIVIA), `${name}: written once after the debounce`).toHaveLength(1);
    }
  });

  it('coalesces a run of edits into one write', async () => {
    const actions = editingActions();
    act(() => {
      actions.setLabel('material', 'Ti-6Al-4V');
      actions.addAgendaItem({ title: 'Third' });
      actions.updateViewpoint('vp-1', { label: 'Renamed' });
    });
    await debounceElapses();

    expect(upsertsBy(OLIVIA)).toHaveLength(1);
    const written = upsertsBy(OLIVIA)[0];
    expect(written.labels).toEqual({ material: 'Ti-6Al-4V' });
    expect(written.agenda).toHaveLength(3);
    expect(viewpointsOf(written)[0]).toMatchObject({ label: 'Renamed' });
  });

  it('writes the view taken from the amber strip', async () => {
    fireEvent.click(screen.getByTitle(SAVE_THIS_VIEW));
    await debounceElapses();

    expect(upsertsBy(OLIVIA)).toHaveLength(1);
    expect(viewpointsOf(world.db.row)).toHaveLength(2);
  });
});
