// The participants panel must say which of the live people has no account.
//
// The flag arrives on remoteParticipantList (pinned in lib/__tests__/
// guestPresence.test.tsx); this is the render side of the same requirement —
// the left column's "Live" list, which is where a host looks to see who is
// actually in the room with them.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { RemoteParticipantInfo, RemoteLaserState } from '../../../lib/usePartyPresence';
import type { ParticipantPresence } from '../../../party/room.server';

const noop = () => {};

// Only presence is faked. WebRTCContext and the zustand store both have
// complete defaults, so the rest of the interface renders on its own.
let participants: RemoteParticipantInfo[] = [];

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => ({
    localUserId: 'user-me',
    remoteParticipants: { current: new Map<string, ParticipantPresence>() },
    remoteLasers: { current: new Map<string, RemoteLaserState>() },
    get remoteParticipantList() {
      return participants;
    },
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
    broadcastReviewConfig: () => false,
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

// Two things in the interface cannot run in jsdom and have nothing to do with
// the participants panel: the chat/conversation column (it scrolls an element,
// which jsdom does not implement) and the XR store (its WebXR emulator wants
// WebGL2RenderingContext). Both are stubbed out so the left column can render.
vi.mock('../ConversationPanel', () => ({ default: () => <div data-testid="conversation" /> }));
vi.mock('../../../lib/xrStore', () => ({
  xrStore: {
    subscribe: () => noop,
    getState: () => ({ session: null }),
    enterAR: noop,
    enterVR: noop,
  },
}));

// Imported after the mocks are registered.
const { default: Interface } = await import('../Interface');

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/room/room-1']}>
      <Routes>
        <Route path="/room/:roomId" element={<Interface />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  participants = [];
  localStorage.clear();
  Object.defineProperty(Element.prototype, 'scrollTo', {
    value: () => {},
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
});

describe('the participants panel', () => {
  /** The panel is folded away until the top bar's People button opens it. */
  function openPanel() {
    fireEvent.click(screen.getByTitle('Participants'));
  }

  it('marks a guest and leaves an account holder alone', () => {
    participants = [
      { userId: 'user-sam', name: 'Supplier Sam', color: '#4F8EF7', guest: true },
      { userId: 'user-alex', name: 'Alex Chen', color: '#F76B4F' },
    ];

    renderRoom();
    openPanel();

    expect(screen.getByText('Supplier Sam (guest)')).toBeInTheDocument();
    expect(screen.getByText('Alex Chen')).toBeInTheDocument();
    expect(screen.queryByText('Alex Chen (guest)')).toBeNull();
  });

  it('marks a guest in the same-room line too', () => {
    participants = [
      { userId: 'user-sam', name: 'Supplier Sam', color: '#4F8EF7', guest: true, sameRoom: true },
    ];

    renderRoom();
    openPanel();

    expect(screen.getByText('Supplier Sam (guest) in same room')).toBeInTheDocument();
  });
});
