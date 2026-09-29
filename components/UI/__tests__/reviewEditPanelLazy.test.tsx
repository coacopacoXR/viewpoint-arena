// The review's editing tools arrive when somebody turns Edit on, and not before.
//
// Batch BI's fourth section. Only an owner or an editor with Edit on ever sees
// these tabs, but the panel and the six tabs it renders were in the main chunk —
// the one every participant downloads in order to look at a model. What only a
// render of the whole Interface can prove is the two halves of the swap: that the
// first paint of Edit mode is the placeholder rather than six tabs, and that the
// tabs really do arrive in it, so the boundary is not a panel that never fills.
//
// One test on purpose. React.lazy resolves a chunk once per module registry, so a
// second render in this file would see the panel already loaded and the placeholder
// would be unobservable — which is also why this lives in its own file rather than
// beside interfaceReviewEditing.test.tsx, where an earlier test has already loaded
// it by the time a placeholder assertion would run.
//
// Same fakes as that file, for the same reasons: the role table is
// lib/reviews/__tests__'s job, and the conversation column and the XR store cannot
// run in jsdom and have nothing to do with any of this.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RemoteParticipantInfo, RemoteLaserState } from '../../../lib/usePartyPresence';
import type { ParticipantPresence } from '../../../party/room.server';
import type { ReviewAction } from '../../../lib/reviews/roles';

const noop = () => {};

const presence = vi.hoisted(() => ({
  localUserId: 'user-me',
  requestReviewEdit: vi.fn(),
  endReviewEdit: vi.fn(),
  broadcastReviewConfig: vi.fn(() => true),
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

vi.mock('../../../lib/reviews/useReviewRole', () => ({
  useReviewRole: () => ({
    role: 'owner',
    can: (action: ReviewAction) => action === 'editReview' || action === 'managePeople',
    loading: false,
    ownerId: null,
    members: [],
    refresh: noop,
  }),
}));

vi.mock('../../../lib/config/ConfigContext', () => ({
  useConnectorConfig: () => ({
    config: { identity: { mode: 'accounts', methods: ['password'], allowGuests: false } },
    loading: false,
    error: null,
    available: true,
  }),
}));

// PeopleTab reaches lib/supabase at import time, and createClient(undefined, …)
// throws. The tab is never selected here, but the module is loaded.
vi.mock('../../../lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) }, from: () => ({}) },
  supabaseConfigured: true,
}));

vi.mock('../ConversationPanel', () => ({ default: () => <div data-testid="conversation" /> }));
vi.mock('../../../lib/xrStore', () => ({
  xrStore: { subscribe: () => noop, getState: () => ({ session: null }), enterAR: noop, enterVR: noop },
}));

const { default: Interface } = await import('../Interface');
const { useStore } = await import('../../../store');
const { useActiveReviewStore } = await import('../../../lib/activeReviewStore');
const { createReviewDraft } = await import('../../../lib/reviewSetupStore');

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe('the editing tools are their own chunk', () => {
  it('shows a neutral placeholder until they arrive, and the tabs once they have', async () => {
    useActiveReviewStore.getState().setConfig(createReviewDraft('room-1', 'Landing gear review'));
    useStore.getState().setReviewEditing({ userId: 'user-me', name: 'Me' });

    render(
      <MemoryRouter initialEntries={['/room/room-1']}>
        <Routes>
          <Route path="/room/:roomId" element={<Interface />} />
        </Routes>
      </MemoryRouter>,
    );

    // The amber strip is in the main bundle and is there at once; the panel it
    // swaps in is not, so the first paint of Edit mode is the placeholder.
    expect(screen.getByText('Editing the review — changes are saved and seen by everyone')).toBeTruthy();
    expect(screen.getByText('Loading the editing tools…')).toBeTruthy();
    expect(screen.queryByRole('tablist', { name: 'Review sections' })).toBeNull();

    // And the tabs do arrive in it — the boundary is a delay, not a hole. Gone
    // rather than joined, so the placeholder cannot be left sitting above six tabs.
    expect(await screen.findByRole('tablist', { name: 'Review sections' })).toBeTruthy();
    expect(screen.queryByText('Loading the editing tools…')).toBeNull();
  });
});
