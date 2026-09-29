// A PLM launch opens a ROOM, and the room is what acts on it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BG, item 5 (T5.3 "Launch in
// Arena"). pages/LaunchPage.tsx resolves a deep link and navigates to
// /review/<id>/setup carrying `{ plmLaunch: { source, doc } }`;
// pages/ReviewSetupRedirect.tsx turns that into `/room/<id>?edit=1` and passes the
// state through. The page that used to meet that state — ReviewSetupPage's
// AssetTab — was deleted in batch BH, and nothing replaced it, so a launch opened
// an empty room: no reference recorded, no document browser, no model.
//
// This is the whole path rather than a unit of it, because the path is the thing
// that broke: RoomPage decides whether the launch needs a review brought into
// existence, RoomPage seeds the store, and components/review/PlmLaunch — rendered
// inside the real Interface's place in the tree — writes the reference and opens
// the browser. So the real RoomPage and the real PlmLaunch run against the real
// stores, and only what cannot run in jsdom is stood in for:
//
//   * lib/supabase — a chainable PostgREST fake. lib/curationsRepo stays real, so
//     the row asserted below is the one draftToRow built;
//   * usePartyPresence — a socket, returning a FRESH object every call as the real
//     hook does. That detail is load-bearing: a launch effect that depended on
//     anything off it would run on every render of the room;
//   * the heavy children (canvas, mobile view, manager, audio, waiting room);
//   * components/UI/Interface — replaced by the real PlmLaunch, so the launch
//     travels the same handler it does in the room;
//   * components/UI/OnshapeBrowser — a probe that renders the props it was given
//     and fires onImported on demand. Its own behaviour is
//     components/UI/__tests__/onshapeBrowser.test.tsx's job; what is pinned here
//     is the address it is handed back for the OAuth round trip and where its file
//     goes.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { PLMLaunch } from '../../lib/connectors/plm/launchParams';

const ROOM = 'room-launch';
const ME = 'user-me';
// Onshape ids are 24 lowercase hex characters, and launchParams.ts refuses
// anything else — so a fixture that is not one would test nothing.
const DOC = 'a1b2c3d4e5f60718293a4b5c';
const WORKSPACE = 'b2c3d4e5f607182930a4b5c6';
const ELEMENT = 'c3d4e5f607182930a4b5c6d7';

// ─── The database ────────────────────────────────────────────────────────────

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../lib/supabase', () => {
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
  broadcasts: [] as Array<{ asset?: { references?: unknown[] } }>,
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
    broadcastReviewConfig: (config: { asset?: { references?: unknown[] } }) => {
      presence.broadcasts.push(config);
      return true;
    },
    requestReviewEdit: () => {},
    // The room server's answer to ?edit=1. Faked as granted rather than driven
    // through the socket: the document browser belongs to Edit mode, and what is
    // under test is what the launch does once the room has said yes.
    endReviewEdit: () => { useStore.getState().setReviewEditing(null); },
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
    // A fresh object every call, as the real hook does.
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

// The room's overlay, reduced to the part of it this file is about.
vi.mock('../../components/UI/Interface', async () => {
  const { default: PlmLaunch } = await import('../../components/review/PlmLaunch');
  return { default: () => <PlmLaunch /> };
});

// The document browser as a probe: what it was handed is the assertion, and its
// import button is how a test reaches onImported.
const browserProbe = vi.hoisted(() => ({
  imported: [] as Array<{ name: string }>,
}));

vi.mock('../../components/UI/OnshapeBrowser', () => ({
  default: (props: {
    signInReturnTo?: string;
    initialDocument?: { id: string; workspaceId?: string };
    initialElementId?: string;
    onImported: (file: File) => void;
    onClose: () => void;
  }) => (
    <div data-testid="onshape-browser">
      <span data-testid="return-to">{props.signInReturnTo ?? 'none'}</span>
      <span data-testid="initial-document">{JSON.stringify(props.initialDocument ?? null)}</span>
      <span data-testid="initial-element">{props.initialElementId ?? 'none'}</span>
      <button
        data-testid="browser-import"
        onClick={() => {
          const file = new File(['glb'], 'onshape-part.glb', { type: 'model/gltf-binary' });
          browserProbe.imported.push({ name: file.name });
          // What the real browser does after a successful import: hand the file
          // over, then get out of the way.
          props.onImported(file);
          props.onClose();
        }}
      >
        import
      </button>
      <button data-testid="browser-close" onClick={props.onClose}>close</button>
    </div>
  ),
}));

// The scene's handoff, watched rather than followed: SceneTree claiming it and
// running the file through the import pipeline is
// components/UI/__tests__/sceneTreeImportHandoff.test.tsx's job.
const handoff = vi.hoisted(() => ({
  files: [] as Array<{ name: string }>,
  taken: true,
}));

vi.mock('../../lib/scene/importHandoff', () => ({
  handSceneImportFile: (file: File) => {
    handoff.files.push({ name: file.name });
    return handoff.taken;
  },
  claimSceneImports: () => () => {},
}));

// Imported after the mocks are registered.
const { default: RoomPage } = await import('../RoomPage');
const { useStore } = await import('../../store');
const { useActiveReviewStore } = await import('../../lib/activeReviewStore');
const { useReviewSetupStore } = await import('../../lib/reviewSetupStore');
const { consumeLocalEdit } = await import('../../lib/reviewLocalEdit');

// ─── Harness ─────────────────────────────────────────────────────────────────

/** What the address bar and the history state hold, read from inside the router. */
const AddressProbe: React.FC = () => {
  const location = useLocation();
  return (
    <div>
      <span data-testid="address">{`${location.pathname}${location.search}`}</span>
      <span data-testid="router-state">{JSON.stringify(location.state ?? null)}</span>
    </div>
  );
};

// An entry object with pathname and search SEPARATE, and not `{ pathname:
// '/room/x?edit=1' }`: MemoryRouter does not split a query out of an object's
// pathname, and a `:roomId` that swallowed `?edit=1` would never equal the
// review's own id. A plain string entry would parse, but a launch also travels in
// the history state, and only the object form carries one.
function roomElement(entry: string, state?: { plmLaunch?: PLMLaunch } | null) {
  const url = new URL(entry, 'http://localhost');
  return (
    <MemoryRouter
      initialEntries={[{
        pathname: url.pathname,
        search: url.search,
        state: state ?? null,
      }]}
    >
      <Routes>
        <Route
          path="/room/:roomId"
          element={<><RoomPage /><AddressProbe /></>}
        />
      </Routes>
    </MemoryRouter>
  );
}

/** The address the redirect chain hands the room: /room/<id>?edit=1, with state. */
function launchEntry(launch: PLMLaunch) {
  return { entry: `/room/${ROOM}?edit=1`, state: { plmLaunch: launch } };
}

function onshapeLaunch(): PLMLaunch {
  return { source: 'onshape', doc: { id: DOC, workspaceId: WORKSPACE, elementId: ELEMENT } };
}

/** Let every promise the room's seed and createReview started land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

/** The review the room is holding, which is the one a launch writes into. */
function references(): Array<{ name: string; url?: string }> {
  return useActiveReviewStore.getState().config?.asset.references ?? [];
}

function renderLaunch(launch: PLMLaunch) {
  const { entry, state } = launchEntry(launch);
  const view = render(roomElement(entry, state));
  return {
    ...view,
    /** A real re-render: a fresh element, so React cannot bail out on identity. */
    rerenderRoom: () => view.rerender(roomElement(entry, state)),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  // Deliberate entry, so RoomPage's lobby guard lets every arrival below in. The
  // one test about that guard clears it again.
  sessionStorage.setItem('vp_enteredRoom', ROOM);
  db.row = null;
  db.upserts = [];
  presence.broadcasts = [];
  presence.localUserId = ME;
  browserProbe.imported = [];
  handoff.files = [];
  handoff.taken = true;
  useActiveReviewStore.getState().setConfig(null);
  useReviewSetupStore.getState().discardDraft();
  useStore.setState({ reviewEditing: null, sessionHostId: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useActiveReviewStore.getState().setConfig(null);
  useReviewSetupStore.getState().discardDraft();
  useStore.setState({ reviewEditing: null, sessionHostId: null });
});

describe('a room opened from Onshape', () => {
  it('creates the review a launch minted an id for, and records the document in it', async () => {
    renderLaunch(onshapeLaunch());
    await settle();

    // The launch arrives for a review nothing has written yet — /launch mints the
    // id and the setup page that used to create the row is a redirect now — so the
    // room makes it, and the document is the first thing in it.
    expect(useActiveReviewStore.getState().config?.reviewId).toBe(ROOM);
    expect(references()).toEqual([
      { id: expect.any(String), name: 'Onshape document', url: `https://cad.onshape.com/documents/${DOC}/w/${WORKSPACE}/e/${ELEMENT}` },
    ]);

    // And it reached the database rather than only this screen.
    await act(async () => { vi.advanceTimersByTime(1100); });
    const written = db.upserts[db.upserts.length - 1];
    const asset = written?.asset as { references?: unknown[] } | undefined;
    expect(asset?.references).toHaveLength(1);
  });

  it('tells everybody else in the room, which is what a store write alone would not do', async () => {
    renderLaunch(onshapeLaunch());
    await settle();

    const broadcast = presence.broadcasts.find((config) => (config.asset?.references?.length ?? 0) > 0);
    expect(broadcast?.asset?.references).toHaveLength(1);
  });

  it('opens the document browser inside Edit mode, aimed at the linked document', async () => {
    renderLaunch(onshapeLaunch());
    await settle();
    // ?edit=1 asks the room for the lock; this is the room saying yes.
    act(() => { useStore.getState().setReviewEditing({ userId: ME, name: 'Me' }); });

    expect(screen.getByTestId('onshape-browser')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('initial-document').textContent ?? 'null')).toEqual({
      id: DOC,
      workspaceId: WORKSPACE,
    });
    expect(screen.getByTestId('initial-element').textContent).toBe(ELEMENT);
  });

  it('does not open the browser for somebody who does not have Edit, and says why', async () => {
    renderLaunch(onshapeLaunch());
    await settle();

    // The reference is written on ARRIVAL, before the room has answered the edit
    // request — a launch whose document is recorded is not a launch that failed.
    expect(references()).toHaveLength(1);
    expect(screen.queryByTestId('onshape-browser')).toBeNull();
    expect(screen.getByText(/as soon as the room gives you Edit/)).toBeTruthy();
  });

  it('sends the OAuth round trip back to THIS room with Edit on, carrying the launch', async () => {
    renderLaunch(onshapeLaunch());
    await settle();
    act(() => { useStore.getState().setReviewEditing({ userId: ME, name: 'Me' }); });

    // Not /launch?… , which is what the deleted setup page returned to: /launch
    // mints a fresh crypto.randomUUID(), so signing in would have abandoned the
    // room the launch just created and started another one. The ids travel in the
    // address because the round trip has no router state to carry them in.
    expect(screen.getByTestId('return-to').textContent).toBe(
      `/room/${ROOM}?edit=1&plmSource=onshape&plmDoc=${DOC}&plmWorkspace=${WORKSPACE}&plmElement=${ELEMENT}`,
    );
  });

  it('takes the launch out of the address bar and the history state, so a reload cannot replay it', async () => {
    renderLaunch(onshapeLaunch());
    await settle();

    expect(screen.getByTestId('address').textContent).toBe(`/room/${ROOM}?edit=1`);
    expect(screen.getByTestId('router-state').textContent).toBe('null');
  });

  it('records the document once, however many times React mounts the room', async () => {
    const { rerenderRoom } = renderLaunch(onshapeLaunch());
    await settle();
    // A live room re-renders constantly — participants, the join gate, the host —
    // and usePartyPresence hands out a fresh object every time.
    rerenderRoom();
    await settle();

    expect(references()).toHaveLength(1);
  });

  it('hands the imported file to the scene’s own pipeline', async () => {
    renderLaunch(onshapeLaunch());
    await settle();
    act(() => { useStore.getState().setReviewEditing({ userId: ME, name: 'Me' }); });

    fireEvent.click(screen.getByTestId('browser-import'));

    // One pipeline, not a second copy of it: SceneTree shares the file, parses it
    // and asks beside / replace / revision. See
    // components/UI/__tests__/sceneTreeImportHandoff.test.tsx for the other half.
    expect(handoff.files).toEqual([{ name: 'onshape-part.glb' }]);
  });

  it('says so rather than dropping the model when no scene panel took it', async () => {
    handoff.taken = false;
    renderLaunch(onshapeLaunch());
    await settle();
    act(() => { useStore.getState().setReviewEditing({ userId: ME, name: 'Me' }); });

    fireEvent.click(screen.getByTestId('browser-import'));

    expect(screen.getByText(/could not be handed to the room’s scene/)).toBeTruthy();
  });

  it('leaves the way back in when the browser is closed without a part picked', async () => {
    renderLaunch(onshapeLaunch());
    await settle();
    act(() => { useStore.getState().setReviewEditing({ userId: ME, name: 'Me' }); });

    fireEvent.click(screen.getByTestId('browser-close'));

    expect(screen.queryByTestId('onshape-browser')).toBeNull();
    expect(screen.getByRole('button', { name: /Open the Onshape document/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Open the Onshape document/ }));
    expect(screen.getByTestId('onshape-browser')).toBeTruthy();
  });

  it('is not sent back to the lobby, which is where the state would be lost', async () => {
    // RoomPage bounces an arrival that did not come from the lobby back to it. A
    // launch is a third way in and already asked for the name, and the bounce
    // would drop the router state — the only copy of the resolved document.
    sessionStorage.clear();
    renderLaunch(onshapeLaunch());
    await settle();

    // Recorded as a deliberate entry the way the lobby records one, so a reload of
    // the room — by which time the launch has been handled and its state cleared —
    // is let back in too.
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe(ROOM);
    expect(references()).toHaveLength(1);
  });
});

describe('the arrival the OAuth round trip makes', () => {
  // A full page load has no router state at all: the launch is in the address.
  const RETURN = `/room/${ROOM}?edit=1&plmSource=onshape&plmDoc=${DOC}&plmWorkspace=${WORKSPACE}&plmElement=${ELEMENT}`;

  it('re-opens the document browser from the address alone', async () => {
    render(roomElement(RETURN));
    await settle();
    act(() => { useStore.getState().setReviewEditing({ userId: ME, name: 'Me' }); });

    expect(screen.getByTestId('onshape-browser')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('initial-document').textContent ?? 'null')).toEqual({
      id: DOC,
      workspaceId: WORKSPACE,
    });
  });

  it('records the document once, not once per arrival', async () => {
    // The first arrival writes the reference, and the room's own save puts it in
    // the row the second arrival reads back.
    renderLaunch(onshapeLaunch());
    await settle();
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(references()).toHaveLength(1);
    cleanup();

    render(roomElement(RETURN));
    await settle();

    expect(references()).toHaveLength(1);
  });

  it('leaves an address a reload cannot launch from again', async () => {
    render(roomElement(RETURN));
    await settle();

    expect(screen.getByTestId('address').textContent).toBe(`/room/${ROOM}?edit=1`);
  });
});

describe('a launch from a PLM with no geometry to import', () => {
  it('records a Teamcenter document and says why there is no model', async () => {
    renderLaunch({ source: 'teamcenter', doc: { id: 'uid-42', workspaceId: 'w-1' } });
    await settle();

    expect(references()).toEqual([
      // No link: launchParams.ts builds none for Teamcenter rather than invent a
      // document path that would 404 inside a customer's own TC web client.
      { id: expect.any(String), name: 'Teamcenter document', url: undefined },
    ]);
    expect(screen.queryByTestId('onshape-browser')).toBeNull();
    expect(screen.getByText(/Geometry import from Teamcenter is not available yet/)).toBeTruthy();
  });

  it('records the mock connector’s document the same way', async () => {
    renderLaunch({ source: 'mock', doc: { id: 'mock-doc-1' } });
    await settle();

    expect(references()[0].name).toBe('Mock PLM document');
    expect(screen.getByText(/mock PLM connector, which has no geometry to import/)).toBeTruthy();
  });
});

describe('an arrival that is not a launch', () => {
  it('leaves the room alone, and does not create a review nobody asked for', async () => {
    render(roomElement(`/room/${ROOM}?edit=1`));
    await settle();

    // An ad-hoc session with no row is still exactly that.
    expect(useActiveReviewStore.getState().config).toBeNull();
    expect(db.upserts).toHaveLength(0);
    expect(screen.queryByTestId('onshape-browser')).toBeNull();
    expect(consumeLocalEdit()).toBe(false);
  });

  it('ignores a launch link that does not validate', async () => {
    // parseLaunchParams refuses an id that is not 24 hex characters, and the room
    // must not act on something the validator turned down.
    render(roomElement(`/room/${ROOM}?edit=1&plmSource=onshape&plmDoc=../etc/passwd`));
    await settle();

    expect(useActiveReviewStore.getState().config).toBeNull();
    expect(screen.queryByTestId('onshape-browser')).toBeNull();
    expect(screen.getByTestId('address').textContent).toBe(`/room/${ROOM}?edit=1&plmSource=onshape&plmDoc=../etc/passwd`);
  });
});
