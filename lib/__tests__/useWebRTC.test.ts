// Tests for useWebRTC — the "voice in the arena" hook.
//
// jsdom has no getUserMedia, so every test stubs navigator.mediaDevices with
// fakes. The point is to verify the contract: audio-only constraints in the
// arena, video added on boardroom entry, toggleMic flips enabled (not stop),
// speaker/sameRoom toggles, and mic denial does not break the room.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWebRTC, AUDIO_CONSTRAINTS } from '../useWebRTC';

// ─── Fakes ──────────────────────────────────────────────────────────────────

function fakeAudioTrack(id: string) {
  return {
    kind: 'audio' as const,
    id,
    enabled: true,
    readyState: 'live' as const,
    stop: vi.fn(),
  };
}

function fakeVideoTrack(id: string) {
  return {
    kind: 'video' as const,
    id,
    enabled: true,
    readyState: 'live' as const,
    stop: vi.fn(),
  };
}

interface FakeTrack {
  kind: string;
  id: string;
  enabled: boolean;
  readyState: string;
  stop: ReturnType<typeof vi.fn>;
}

function fakeStream(tracks: FakeTrack[]) {
  return {
    _tracks: tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getTracks: () => tracks,
    addTrack: (t: FakeTrack) => { tracks.push(t); },
    removeTrack: (t: FakeTrack) => {
      const idx = tracks.indexOf(t);
      if (idx >= 0) tracks.splice(idx, 1);
    },
  };
}

interface GUMCall {
  constraints: { audio?: MediaTrackConstraints | boolean; video?: MediaTrackConstraints | boolean };
}

function installFakeGUM(options?: { deny?: boolean; videoTrack?: boolean }) {
  const calls: GUMCall[] = [];
  const getUserMedia = vi.fn((constraints: { audio?: MediaTrackConstraints | boolean; video?: MediaTrackConstraints | boolean }) => {
    calls.push({ constraints });
    if (options?.deny) {
      return Promise.reject(new Error('Permission denied'));
    }
    const tracks: FakeTrack[] = [fakeAudioTrack(`audio-${calls.length}`)];
    if (constraints.video && options?.videoTrack) {
      tracks.push(fakeVideoTrack(`video-${calls.length}`));
    }
    return Promise.resolve(fakeStream(tracks));
  });

  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia },
  });

  return { getUserMedia, calls };
}

function installFakeFetch() {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const defaultParams = {
  localUserId: 'user-a',
  remoteParticipantList: [],
  broadcastWebRTCSignal: vi.fn(),
  registerWebRTCSignalHandler: vi.fn(() => () => {}),
  active: true,
  isBoardroomMode: false,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('useWebRTC', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('requests audio with echo/noise/autoGain constraints', async () => {
    const { getUserMedia, calls } = installFakeGUM();
    installFakeFetch();

    renderHook(() => useWebRTC(defaultParams));

    // Wait for the async getUserMedia to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(getUserMedia).toHaveBeenCalled();
    const audioConstraint = calls[0].constraints.audio as MediaTrackConstraints;
    expect(audioConstraint).toEqual(AUDIO_CONSTRAINTS);
    expect(audioConstraint.echoCancellation).toBe(true);
    expect(audioConstraint.noiseSuppression).toBe(true);
    expect(audioConstraint.autoGainControl).toBe(true);
    // No video in arena mode
    expect(calls[0].constraints.video).toBeUndefined();
  });

  it('starts muted, so entering a room never broadcasts before you say so', async () => {
    installFakeGUM();
    installFakeFetch();
    const { result } = renderHook(() => useWebRTC(defaultParams));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(result.current.isMicOn).toBe(false);
    for (const track of result.current.localStream?.getAudioTracks() ?? []) {
      expect(track.enabled).toBe(false);
    }
  });

  it('toggleMic flips enabled, does not call stop()', async () => {
    installFakeGUM();
    installFakeFetch();

    const { result } = renderHook(() => useWebRTC(defaultParams));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.isMicOn).toBe(false);

    act(() => {
      result.current.toggleMic();
    });

    expect(result.current.isMicOn).toBe(true);

    act(() => {
      result.current.toggleMic();
    });

    expect(result.current.isMicOn).toBe(false);
  });

  it('toggleSpeaker flips isSpeakerOn', async () => {
    installFakeGUM();
    installFakeFetch();

    const { result } = renderHook(() => useWebRTC(defaultParams));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.isSpeakerOn).toBe(true);

    act(() => {
      result.current.toggleSpeaker();
    });

    expect(result.current.isSpeakerOn).toBe(false);
  });

  it('toggleSameRoom flips isSameRoom and mutes speaker', async () => {
    installFakeGUM();
    installFakeFetch();

    const { result } = renderHook(() => useWebRTC(defaultParams));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.isSameRoom).toBe(false);
    expect(result.current.isSpeakerOn).toBe(true);

    act(() => {
      result.current.toggleSameRoom();
    });

    expect(result.current.isSameRoom).toBe(true);
    expect(result.current.isSpeakerOn).toBe(false);
  });

  it('handles mic permission denial gracefully', async () => {
    installFakeGUM({ deny: true });
    installFakeFetch();

    const { result } = renderHook(() => useWebRTC(defaultParams));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(result.current.micPermissionState).toBe('blocked');
    expect(result.current.hasPermission).toBe(true);
    expect(result.current.isStarting).toBe(false);
  });

  it('requests video when boardroom mode is entered', async () => {
    const { calls } = installFakeGUM({ videoTrack: true });
    installFakeFetch();

    const { rerender } = renderHook(
      ({ isBoardroomMode }) => useWebRTC({ ...defaultParams, isBoardroomMode }),
      { initialProps: { isBoardroomMode: false } },
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Initially audio-only
    expect(calls.length).toBe(1);
    expect(calls[0].constraints.video).toBeUndefined();

    // Enter boardroom
    rerender({ isBoardroomMode: true });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Should have requested video
    const videoCall = calls.find((c) => c.constraints.video);
    expect(videoCall).toBeDefined();
    expect(videoCall!.constraints.audio).toBeFalsy();
  });
});
