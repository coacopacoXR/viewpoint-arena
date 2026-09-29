// The bottom call bar. Two things are asserted here:
//   1. the simulation transport is gone — no Play/Pause, no Reset, no OP.STATUS;
//   2. every control that moved into the bar kept the handler it had in the
//      top-right row (mic/speaker/same room from WebRTCContext, End Session from
//      the store + presence), and a guest now gets a way out too.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ViewMode } from '../../../types';

let storeState: Record<string, unknown>;
let presenceState: Record<string, unknown>;
let webrtcState: Record<string, unknown>;

vi.mock('../../../store', () => ({
  useStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(storeState);
    return storeState;
  },
}));

vi.mock('../../../lib/PresenceContext', () => ({
  usePresence: () => presenceState,
}));

vi.mock('../../../lib/WebRTCContext', () => ({
  useWebRTCContext: () => webrtcState,
}));

import CallBar from '../room/CallBar';

const handlers = {
  onFreeView: vi.fn(),
  onLeaderToggle: vi.fn(),
  onSplitToggle: vi.fn(),
  onLeave: vi.fn(),
};

function setup(options: { isHost?: boolean; micOn?: boolean; micBlocked?: boolean } = {}) {
  // The person at this browser, whose name leads the attendee list the End button
  // passes down (batch BM). Without it lib/identity answers 'Guest'.
  localStorage.setItem('vp_user', JSON.stringify({ name: 'Olga Owner', color: '#4F8EF7' }));
  storeState = {
    viewMode: ViewMode.FREE,
    setViewMode: vi.fn(),
    setActiveAgent: vi.fn(),
    leaderId: null,
    endMeeting: vi.fn(),
  };
  presenceState = {
    remoteParticipantList: [{ userId: 'p1', name: 'Maria' }, { userId: 'p2', name: 'Jonas' }],
    broadcastMeetingEnd: vi.fn(),
  };
  webrtcState = {
    isMicOn: options.micOn ?? true,
    toggleMic: vi.fn(),
    isSpeakerOn: true,
    toggleSpeaker: vi.fn(),
    isSameRoom: false,
    toggleSameRoom: vi.fn(),
    micPermissionState: options.micBlocked ? 'blocked' : 'granted',
  };
  return options.isHost ?? true;
}

function renderBar(isHost: boolean) {
  return render(
    <CallBar
      isHost={isHost}
      onFreeView={handlers.onFreeView}
      onLeaderToggle={handlers.onLeaderToggle}
      onSplitToggle={handlers.onSplitToggle}
      onLeave={handlers.onLeave}
    />,
  );
}

describe('CallBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.removeItem('vp_user');
  });

  it('carries no playback transport and no OP.STATUS readout', () => {
    renderBar(setup());

    expect(screen.queryByTitle('Play/Pause')).toBeNull();
    expect(screen.queryByTitle('Reset')).toBeNull();
    expect(screen.queryByText('OP.STATUS')).toBeNull();
    expect(screen.queryByText('RUNNING')).toBeNull();
  });

  it('mutes and unmutes through the WebRTC context', () => {
    renderBar(setup({ micOn: true }));

    fireEvent.click(screen.getByTitle('Mute microphone'));
    expect(webrtcState.toggleMic).toHaveBeenCalledTimes(1);
    expect(screen.getByTitle('Mute microphone').className).not.toContain('bg-red-600');
  });

  it('shows a muted mic in red', () => {
    renderBar(setup({ micOn: false }));

    const mic = screen.getByTitle('Unmute microphone');
    fireEvent.click(mic);

    expect(webrtcState.toggleMic).toHaveBeenCalledTimes(1);
    expect(mic.className).toContain('bg-red-600');
  });

  it('shows a blocked mic in orange and says where to fix it', () => {
    renderBar(setup({ micBlocked: true }));

    expect(
      screen.getByTitle('Microphone blocked — re-enable in browser settings').className,
    ).toContain('bg-orange-100');
  });

  it('keeps the speaker and same-room toggles', () => {
    renderBar(setup());

    fireEvent.click(screen.getByTitle('Mute all remote audio'));
    expect(webrtcState.toggleSpeaker).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByTitle('Mark that you share a physical room with another participant'),
    );
    expect(webrtcState.toggleSameRoom).toHaveBeenCalledTimes(1);
  });

  it('passes the view-mode handlers straight through', () => {
    renderBar(setup());

    fireEvent.click(screen.getByTitle('Free View'));
    fireEvent.click(screen.getByTitle('Sync / Leader Mode'));
    fireEvent.click(screen.getByTitle('Hybrid Split Screen'));

    expect(handlers.onFreeView).toHaveBeenCalledTimes(1);
    expect(handlers.onLeaderToggle).toHaveBeenCalledTimes(1);
    expect(handlers.onSplitToggle).toHaveBeenCalledTimes(1);
  });

  it('AI guided focus still clears the possessed agent', () => {
    renderBar(setup());

    fireEvent.click(screen.getByTitle('AI Guided Focus (Group Gaze)'));

    expect(storeState.setViewMode).toHaveBeenCalledWith(ViewMode.AI_GUIDED);
    expect(storeState.setActiveAgent).toHaveBeenCalledWith(null);
  });

  it('ends the session for everybody when the host presses it', () => {
    renderBar(setup({ isHost: true }));

    fireEvent.click(screen.getByTitle('End Session'));

    // The head count AND the names: the count says that three people met, the
    // names say who they were, and the session row now carries both (batch BM).
    expect(storeState.endMeeting).toHaveBeenCalledWith(true, 3, ['Olga Owner', 'Maria', 'Jonas']);
    expect(presenceState.broadcastMeetingEnd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle('Leave')).toBeNull();
  });

  it('gives a guest a way out instead, and no end-session control', () => {
    renderBar(setup({ isHost: false }));

    fireEvent.click(screen.getByTitle('Leave'));

    expect(handlers.onLeave).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle('End Session')).toBeNull();
    expect(storeState.endMeeting).not.toHaveBeenCalled();
  });
});
