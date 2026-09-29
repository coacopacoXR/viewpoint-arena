// The room with Edit on: the panel swaps, the bar becomes the amber strip, and
// everybody else gets the banner instead of the tools.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. The four components this
// stitches together are each pinned on their own (components/review/__tests__ and
// components/UI/room/__tests__/topBarEditButton.test.tsx); what only a render of
// the whole Interface can prove is the SWAP — that with Edit on the side panel
// holds the review's tabs and not Capture · Comments · Chat, and that the top bar
// is gone rather than merely joined by a strip — and the asymmetry that makes
// "only one person edits at a time" visible: the editor sees tools, everybody else
// sees a name.
//
// useReviewRole is faked rather than driven through Supabase, because the role
// table is lib/reviews/__tests__'s job and this file is about what the room DOES
// with an answer. Everything else — the store, the panel, the strip, the notice —
// is real.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RemoteParticipantInfo, RemoteLaserState } from '../../../lib/usePartyPresence';
import type { ParticipantPresence } from '../../../party/room.server';
import type { ReviewAction } from '../../../lib/reviews/roles';

const noop = () => {};

// ─── Fakes ──────────────────────────────────────────────────────────────────

const presence = vi.hoisted(() => ({
  localUserId: 'user-me',
  requestReviewEdit: vi.fn(),
  endReviewEdit: vi.fn(),
  broadcastReviewConfig: vi.fn(() => true),
}));

const roleAnswer = vi.hoisted(() => ({
  // Which actions this person may do. Set per test; 'editReview' is the one the
  // room's Edit button is gated on.
  allowed: [] as string[],
  loading: false,
  refresh: vi.fn(),
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    get localUserId() { return presence.localUserId; },
    remoteParticipants: { current: new Map<string, ParticipantPresence>() },
    remoteLasers: { current: new Map<string, RemoteLaserState>() },
    remoteParticipantList: [] as RemoteParticipantInfo[],
    broadcastPresence: noop,
    setSameRoom: noop,
    broadcastPresenterChange: noop,
    broadcastInsightCard: noop,
    broadcastLeaderChange: noop,
    broadcastBoardroomCountdown: noop,
    broadcastArenaEntry: noop,
    broadcastLaserMove: noop,
    broadcastPrivacyMode: noop,
    broadcastLeaderTakeover: noop,
    broadcastSceneUpdate: () => false,
    broadcastSetModelEditors: () => false,
    broadcastReviewConfig: presence.broadcastReviewConfig,
    get requestReviewEdit() { return presence.requestReviewEdit; },
    get endReviewEdit() { return presence.endReviewEdit; },
    broadcastMeetingEnd: noop,
    broadcastTakeoverSync: noop,
    broadcastHostTransfer: noop,
    broadcastPresenterRequest: noop,
    broadcastPresenterRequestDenied: noop,
    broadcastTakeoverAttempt: noop,
    broadcastCommentAdd: noop,
    broadcastCommentUpdate: noop,
    broadcastCommentDelete: noop,
    broadcastCommentResolve: noop,
    broadcastChatMessage: noop,
    broadcastXRPresence: noop,
    broadcastWebRTCSignal: noop,
    registerWebRTCSignalHandler: () => noop,
  }),
}));

// The role this room thinks I have. Everything downstream of the answer is real.
vi.mock('../../../lib/reviews/useReviewRole', () => ({
  useReviewRole: () => ({
    role: roleAnswer.allowed.includes('managePeople') ? 'owner' : 'participant',
    can: (action: ReviewAction) => roleAnswer.allowed.includes(action),
    get loading() { return roleAnswer.loading; },
    ownerId: null,
    members: [],
    get refresh() { return roleAnswer.refresh; },
  }),
}));

// A deployment with accounts, so the People tab belongs in the set.
vi.mock('../../../lib/config/ConfigContext', () => ({
  useConnectorConfig: () => ({
    config: { identity: { mode: 'accounts', methods: ['password'], allowGuests: false } },
    loading: false,
    error: null,
    available: true,
  }),
}));

// PeopleTab reaches lib/supabase at import time, and createClient(undefined, …)
// throws. The tab is never selected in these tests, but the module is loaded.
vi.mock('../../../lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) }, from: () => ({}) },
  supabaseConfigured: true,
}));

// Two things in the interface cannot run in jsdom and have nothing to do with
// editing a review: the conversation column (it scrolls an element) and the XR
// store (its WebXR emulator wants WebGL2RenderingContext).
vi.mock('../ConversationPanel', () => ({ default: () => <div data-testid="conversation" /> }));
vi.mock('../../../lib/xrStore', () => ({
  xrStore: { subscribe: () => noop, getState: () => ({ session: null }), enterAR: noop, enterVR: noop },
}));

// Imported after the mocks are registered.
const { default: Interface } = await import('../Interface');
const { useStore } = await import('../../../store');
const { useActiveReviewStore } = await import('../../../lib/activeReviewStore');
const { createReviewDraft } = await import('../../../lib/reviewSetupStore');

function renderRoom(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/room/room-1${search}`]}>
      <Routes>
        <Route path="/room/:roomId" element={<Interface />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The room with a review in it, which is the only kind of room that can be edited. */
function seedReview() {
  const draft = createReviewDraft('room-1', 'Landing gear review');
  useActiveReviewStore.getState().setConfig(draft);
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: () => {},
    configurable: true,
    writable: true,
  });
  presence.localUserId = 'user-me';
  presence.requestReviewEdit.mockReset();
  presence.endReviewEdit.mockReset();
  roleAnswer.allowed = ['meet', 'addCard', 'editCard'];
  roleAnswer.loading = false;
  seedReview();
});

afterEach(() => {
  cleanup();
  // The store is a module singleton: an edit lock left set here would be a room
  // still being edited for every later test in the file.
  useStore.getState().setReviewEditing(null);
  useStore.getState().setReviewEditRefusal(null);
  useStore.getState().setReviewEditNotice(null);
  useStore.setState({ activeSceneModelId: null });
  useActiveReviewStore.getState().setConfig(null);
});

describe('Interface — the room while a review is being edited', () => {
  // ─── The Edit button, per role ────────────────────────────────────────────

  it('offers Edit to an owner', () => {
    roleAnswer.allowed = ['meet', 'addCard', 'editCard', 'runMeeting', 'editReview', 'managePeople'];
    renderRoom();

    const button = screen.getByTitle('Edit the review');
    fireEvent.click(button);
    expect(presence.requestReviewEdit).toHaveBeenCalledTimes(1);
  });

  it('offers Edit to an editor, who may change the review but not its people', () => {
    roleAnswer.allowed = ['meet', 'addCard', 'editCard', 'runMeeting', 'editReview', 'setModelEditors'];
    renderRoom();

    expect(screen.getByTitle('Edit the review')).toBeTruthy();
  });

  it('does not offer Edit to a participant, and leaves the rest of the bar alone', () => {
    renderRoom();

    expect(screen.queryByTitle('Edit the review')).toBeNull();
    // Hidden, not disabled — and the meeting's own controls are untouched, which
    // is the "meetings exactly as today when nobody edits" half of the brief.
    expect(screen.getByTitle('Participants')).toBeTruthy();
  });

  it('does not offer Edit while the role is still being read, so the button cannot flash', () => {
    roleAnswer.allowed = ['editReview'];
    roleAnswer.loading = true;
    renderRoom();

    expect(screen.queryByTitle('Edit the review')).toBeNull();
  });

  it('asks the room for Edit on arrival at ?edit=1, which is where New design review lands', () => {
    roleAnswer.allowed = ['editReview'];
    renderRoom('?edit=1');

    expect(presence.requestReviewEdit).toHaveBeenCalled();
  });

  it('does not ask for Edit on arrival at a plain room address', () => {
    roleAnswer.allowed = ['editReview'];
    renderRoom();

    expect(presence.requestReviewEdit).not.toHaveBeenCalled();
  });

  // ─── The swap, for the person editing ─────────────────────────────────────

  it('replaces the top bar with the amber strip and the panel with the review’s tabs', async () => {
    roleAnswer.allowed = ['editReview'];
    useStore.getState().setReviewEditing({ userId: 'user-me', name: 'Me' });
    // A model to transform. The strip's three tools are disabled without one, and
    // a disabled control carries a different title, so this is what makes them
    // findable by the thing they do.
    useStore.setState({ activeSceneModelId: 'model-1' });
    renderRoom();

    // The strip, in the bar's place.
    expect(screen.getByText('Editing the review — changes are saved and seen by everyone')).toBeTruthy();
    expect(screen.getByTitle('Move the selected model')).toBeTruthy();
    expect(screen.getByTitle('Finish editing and go back to the meeting')).toBeTruthy();
    // The meeting's bar is GONE, not joined: its controls would change the meeting
    // for five other people, and none of them is what this person is here to use.
    expect(screen.queryByTitle('Participants')).toBeNull();
    // The panel holds the review's tabs, in the approved order. Awaited, because
    // batch BI moved the panel into its own React.lazy chunk: the strip is in the
    // main bundle and the tabs arrive a tick later, with the placeholder on screen
    // until they do.
    expect(await screen.findByRole('tablist', { name: 'Review sections' })).toBeTruthy();
    const labels = screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'));
    expect(labels).toEqual(['Agenda', 'Viewpoints', 'Pins', 'Requirements', 'Labels', 'People']);
  });

  it('gives Edit up on Done', () => {
    roleAnswer.allowed = ['editReview'];
    useStore.getState().setReviewEditing({ userId: 'user-me', name: 'Me' });
    renderRoom();

    fireEvent.click(screen.getByTitle('Finish editing and go back to the meeting'));

    expect(presence.endReviewEdit).toHaveBeenCalledTimes(1);
    // Asked, not assumed: the tools stay up until the room says the lock is gone.
    expect(useStore.getState().reviewEditing).not.toBeNull();
  });

  // ─── The banner, for everybody else ───────────────────────────────────────

  it('shows a participant the name of whoever is editing, and no tools at all', () => {
    useStore.getState().setReviewEditing({ userId: 'somebody-else', name: 'Robin' });
    renderRoom();

    expect(screen.getByText('Robin is editing the review')).toBeTruthy();
    // Not the tools.
    expect(screen.queryByTitle('Move the selected model')).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Review sections' })).toBeNull();
    expect(screen.queryByText('Editing the review — changes are saved and seen by everyone')).toBeNull();
    // And not the meeting's bar either having lost anything: they are still in
    // the meeting, they are just not the one preparing the review.
    expect(screen.getByTitle('Participants')).toBeTruthy();
  });

  it('offers a take-over to a second editor who was told the room is busy', () => {
    roleAnswer.allowed = ['editReview'];
    useStore.getState().setReviewEditing({ userId: 'somebody-else', name: 'Robin' });
    useStore.getState().setReviewEditRefusal({ reason: 'busy', editorName: 'Robin' });
    renderRoom();

    fireEvent.click(screen.getByText('Take over'));

    // The second press, and the only place a lock is taken off somebody: one
    // explicit act, never one click from the banner.
    expect(presence.requestReviewEdit).toHaveBeenCalledWith(true);
  });

  it('tells a person whose edit was taken over, once, by name', () => {
    useStore.getState().setReviewEditNotice('Maria took over editing');
    renderRoom();

    expect(screen.getByText('Maria took over editing')).toBeTruthy();
  });
});
