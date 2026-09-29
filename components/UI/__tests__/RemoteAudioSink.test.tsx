// Tests for RemoteAudioSink — the shared audio element per remote stream.
//
// Verifies:
//   * one <audio> per remote stream is created in the DOM
//   * all elements are muted when the speaker is off
//   * elements are cleaned up on unmount
//   * entering the boardroom does not create a second element for the same stream

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import RemoteAudioSink from '../RemoteAudioSink';
import { WebRTCContext } from '../../../lib/WebRTCContext';
import type { UseWebRTCReturn } from '../../../lib/useWebRTC';

function fakeStream(label: string): MediaStream {
  return { label, id: label } as unknown as MediaStream;
}

function makeContextValue(overrides: Partial<UseWebRTCReturn> = {}): UseWebRTCReturn {
  return {
    localStream: null,
    remoteStreams: new Map(),
    peerStates: new Map(),
    isMicOn: true,
    isCamOn: false,
    hasPermission: true,
    isStarting: false,
    toggleMic: vi.fn(),
    toggleCam: vi.fn(),
    isSpeakerOn: true,
    toggleSpeaker: vi.fn(),
    isSameRoom: false,
    toggleSameRoom: vi.fn(),
    micPermissionState: 'granted',
    ...overrides,
  };
}

describe('RemoteAudioSink', () => {
  afterEach(() => {
    // Clean up any audio elements added to document.body
    document.body.querySelectorAll('audio[data-remote-audio]').forEach((el) => el.remove());
  });

  it('creates one audio element per remote stream', () => {
    const streams = new Map<string, MediaStream>([
      ['user-b', fakeStream('stream-b')],
      ['user-c', fakeStream('stream-c')],
    ]);

    render(
      <WebRTCContext.Provider value={makeContextValue({ remoteStreams: streams })}>
        <RemoteAudioSink />
      </WebRTCContext.Provider>,
    );

    const audioElements = document.body.querySelectorAll('audio[data-remote-audio]');
    expect(audioElements.length).toBe(2);
  });

  it('mutes all elements when speaker is off', () => {
    const streams = new Map<string, MediaStream>([
      ['user-b', fakeStream('stream-b')],
    ]);

    render(
      <WebRTCContext.Provider value={makeContextValue({ remoteStreams: streams, isSpeakerOn: false })}>
        <RemoteAudioSink />
      </WebRTCContext.Provider>,
    );

    const audioEl = document.body.querySelector('audio[data-remote-audio]') as HTMLAudioElement | null;
    expect(audioEl).not.toBeNull();
    expect(audioEl!.muted).toBe(true);
  });

  it('unmutes elements when speaker is on', () => {
    const streams = new Map<string, MediaStream>([
      ['user-b', fakeStream('stream-b')],
    ]);

    render(
      <WebRTCContext.Provider value={makeContextValue({ remoteStreams: streams, isSpeakerOn: true })}>
        <RemoteAudioSink />
      </WebRTCContext.Provider>,
    );

    const audioEl = document.body.querySelector('audio[data-remote-audio]') as HTMLAudioElement | null;
    expect(audioEl).not.toBeNull();
    expect(audioEl!.muted).toBe(false);
  });

  it('cleans up audio elements on unmount', () => {
    const streams = new Map<string, MediaStream>([
      ['user-b', fakeStream('stream-b')],
    ]);

    const { unmount } = render(
      <WebRTCContext.Provider value={makeContextValue({ remoteStreams: streams })}>
        <RemoteAudioSink />
      </WebRTCContext.Provider>,
    );

    expect(document.body.querySelectorAll('audio[data-remote-audio]').length).toBe(1);

    unmount();

    expect(document.body.querySelectorAll('audio[data-remote-audio]').length).toBe(0);
  });

  it('does not create duplicate elements for the same stream on re-render', () => {
    const streams = new Map<string, MediaStream>([
      ['user-b', fakeStream('stream-b')],
    ]);

    const { rerender } = render(
      <WebRTCContext.Provider value={makeContextValue({ remoteStreams: streams })}>
        <RemoteAudioSink />
      </WebRTCContext.Provider>,
    );

    expect(document.body.querySelectorAll('audio[data-remote-audio]').length).toBe(1);

    // Re-render with same streams (simulates boardroom entry)
    rerender(
      <WebRTCContext.Provider value={makeContextValue({ remoteStreams: streams })}>
        <RemoteAudioSink />
      </WebRTCContext.Provider>,
    );

    // Still just one element
    expect(document.body.querySelectorAll('audio[data-remote-audio]').length).toBe(1);
  });
});
