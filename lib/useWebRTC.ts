import { useEffect, useRef, useState, useCallback } from 'react';
import type { RemoteParticipantInfo } from './usePartyPresence';
import type { WebRTCSignalData } from '../party/room.server';

// STUN + public TURN for production NAT traversal.
// STUN alone fails when either peer is behind symmetric NAT (common on 4G/corporate).
//
// TURN credentials are minted server-side by /api/turn-credentials and fetched
// at runtime (see the fetchTurn call below). The static fallback uses the
// openrelay public pool — same behaviour as before the T3.4 credential-sourcing
// change, just without the VITE_TURN_* env vars that shipped secrets in the
// bundle.
//
// Pointing at a non-Cloudflare TURN provider is still supported, and is still
// done with the same three values as commit 1db12fa — they just live in
// server-side env now: set TURN_URL / TURN_USERNAME / TURN_CREDENTIAL (no
// VITE_ prefix) and /api/turn-credentials returns them directly.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// Echo/suppression constraints for every mic open — prevents feedback howl
// when two laptops sit at the same table.
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export type MicPermissionState = 'prompt' | 'granted' | 'blocked';

export interface UseWebRTCReturn {
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  peerStates: Map<string, RTCPeerConnectionState>;
  isMicOn: boolean;
  isCamOn: boolean;
  hasPermission: boolean;
  isStarting: boolean;
  toggleMic: () => void;
  toggleCam: () => void;
  isSpeakerOn: boolean;
  toggleSpeaker: () => void;
  isSameRoom: boolean;
  toggleSameRoom: () => void;
  micPermissionState: MicPermissionState;
}

interface Params {
  localUserId: string;
  remoteParticipantList: RemoteParticipantInfo[];
  broadcastWebRTCSignal: (to: string, data: WebRTCSignalData) => void;
  registerWebRTCSignalHandler: (handler: (payload: { from: string; to: string; data: WebRTCSignalData }) => void) => () => void;
  active: boolean;
  isBoardroomMode: boolean;
}

export function useWebRTC({
  localUserId,
  remoteParticipantList,
  broadcastWebRTCSignal,
  registerWebRTCSignalHandler,
  active,
  isBoardroomMode,
}: Params): UseWebRTCReturn {
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const makingOffer = useRef<Map<string, boolean>>(new Map());
  const broadcastRef = useRef(broadcastWebRTCSignal);
  const localUserIdRef = useRef(localUserId);
  // Holds the ICE servers used for every new RTCPeerConnection. Starts at the
  // static fallback; overwritten with Cloudflare's ephemeral list when the
  // /api/turn-credentials fetch resolves (once per boardroom activation).
  const iceServersRef = useRef<RTCIceServer[]>(ICE_SERVERS);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [peerStates, setPeerStates] = useState<Map<string, RTCPeerConnectionState>>(new Map());
  // Muted on arrival, deliberately. The call now starts when you enter the
  // room rather than when you press BOARDROOM, so an unmuted default would
  // broadcast whatever is happening around you the moment permission is
  // granted — and, with two laptops at one table, start a feedback howl
  // before anyone has touched a control. The header shows the muted state and
  // one click unmutes.
  const [isMicOn, setIsMicOn] = useState(false);
  const [isCamOn, setIsCamOn] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);
  const [isSameRoom, setIsSameRoom] = useState(false);
  const [micPermissionState, setMicPermissionState] = useState<MicPermissionState>('prompt');

  const knownPeerIds = useRef<Set<string>>(new Set());

  useEffect(() => { broadcastRef.current = broadcastWebRTCSignal; }, [broadcastWebRTCSignal]);
  useEffect(() => { localUserIdRef.current = localUserId; }, [localUserId]);

  // Smaller userId = polite side (rolls back on offer collision)
  const isPolite = useCallback((remoteUserId: string) => localUserIdRef.current < remoteUserId, []);

  function updatePeerState(userId: string, state: RTCPeerConnectionState) {
    setPeerStates(prev => new Map(prev).set(userId, state));
  }

  function addLocalTracksToPeer(pc: RTCPeerConnection) {
    if (!localStreamRef.current) return;
    const senders = pc.getSenders();
    for (const track of localStreamRef.current.getTracks()) {
      if (!senders.some(s => s.track?.id === track.id)) {
        pc.addTrack(track, localStreamRef.current);
      }
    }
  }

  function createPeerConnection(remoteUserId: string): RTCPeerConnection {
    const existing = peerConnections.current.get(remoteUserId);
    if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
      return existing;
    }

    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });

    // Add sendrecv transceivers so ICE gathers candidates immediately, even before local
    // tracks exist. addTrack() later reuses these transceivers without direction conflicts.
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.addTransceiver('video', { direction: 'sendrecv' });

    addLocalTracksToPeer(pc);

    const remoteStream = remoteStreamsRef.current.get(remoteUserId) ?? new MediaStream();
    remoteStreamsRef.current.set(remoteUserId, remoteStream);

    pc.ontrack = (event) => {
      if (!remoteStream.getTrackById(event.track.id)) {
        remoteStream.addTrack(event.track);
      }
      setRemoteStreams(new Map(remoteStreamsRef.current));
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        broadcastRef.current(remoteUserId, { type: 'ice', candidate: e.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      updatePeerState(remoteUserId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        peerConnections.current.delete(remoteUserId);
        remoteStreamsRef.current.delete(remoteUserId);
        makingOffer.current.delete(remoteUserId);
        setRemoteStreams(new Map(remoteStreamsRef.current));
      }
    };

    peerConnections.current.set(remoteUserId, pc);
    makingOffer.current.set(remoteUserId, false);
    updatePeerState(remoteUserId, 'new');
    return pc;
  }

  // Perfect negotiation: BOTH sides always offer.
  // Polite side (smaller userId) rolls back on collision.
  async function initiateConnection(remoteUserId: string) {
    const pc = createPeerConnection(remoteUserId);
    makingOffer.current.set(remoteUserId, true);
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') { makingOffer.current.set(remoteUserId, false); return; }
      await pc.setLocalDescription(offer);
      broadcastRef.current(remoteUserId, { type: 'offer', sdp: pc.localDescription });
    } catch (e) {
      console.warn('[WebRTC] offer error', e);
    } finally {
      makingOffer.current.set(remoteUserId, false);
    }
  }

  const handleSignal = useCallback(async (payload: { from: string; to: string; data: WebRTCSignalData }) => {
    if (payload.to !== localUserIdRef.current) return;
    const { from, data } = payload;

    if (data.type === 'offer') {
      const pc = createPeerConnection(from);
      const polite = isPolite(from);
      const collision = makingOffer.current.get(from) || pc.signalingState !== 'stable';

      if (!polite && collision) return;

      try {
        if (collision) {
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        addLocalTracksToPeer(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        broadcastRef.current(from, { type: 'answer', sdp: pc.localDescription });
      } catch (e) {
        console.warn('[WebRTC] answer error', e);
      }

    } else if (data.type === 'answer') {
      const pc = peerConnections.current.get(from);
      if (pc && pc.signalingState === 'have-local-offer') {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } catch (e) {
          console.warn('[WebRTC] setRemoteDescription(answer) error', e);
        }
      }

    } else if (data.type === 'ice') {
      const pc = peerConnections.current.get(from);
      if (pc && data.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch {
          // harmless timing issues
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start/stop media when the call activates (room entry).
  // Audio-only: video is added separately when the boardroom is entered.
  useEffect(() => {
    if (!active) {
      for (const pc of peerConnections.current.values()) pc.close();
      peerConnections.current.clear();
      knownPeerIds.current.clear();
      remoteStreamsRef.current.clear();
      makingOffer.current.clear();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
      setLocalStream(null);
      setRemoteStreams(new Map());
      setPeerStates(new Map());
      setHasPermission(false);
      setMicPermissionState('prompt');
      return;
    }

    setIsStarting(true);
    setMicPermissionState('prompt');

    // Fetch fresh Cloudflare TURN credentials in parallel with getUserMedia.
    // If the fetch succeeds, iceServersRef.current is upgraded BEFORE we
    // create any peer connections (getUserMedia is slower than the fetch in
    // practice). If it fails, the ref keeps its static fallback so behavior
    // degrades gracefully back to the original openrelay path.
    const fetchTurn = fetch('/api/turn-credentials')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.iceServers && Array.isArray(data.iceServers)) {
          iceServersRef.current = data.iceServers;
        }
      })
      .catch(() => { /* keep fallback */ });

    // Audio-only with echo/suppression constraints — the arena has no camera.
    // Video is added later when the boardroom is entered.
    const media = navigator.mediaDevices
      .getUserMedia({ audio: AUDIO_CONSTRAINTS })
      .then(stream => {
        setMicPermissionState('granted');
        return stream;
      })
      .catch(() => {
        setMicPermissionState('blocked');
        // Return an empty stream so the room still works without a mic.
        return new MediaStream();
      });

    Promise.all([fetchTurn, media])
      .then(([, stream]) => {
        localStreamRef.current = stream;
        // Honour the muted-on-arrival default before the track reaches a peer.
        for (const track of stream.getAudioTracks()) track.enabled = isMicOnRef.current;
        setLocalStream(stream);
        setHasPermission(true);
        setIsStarting(false);

        for (const [userId, pc] of peerConnections.current.entries()) {
          if (pc.signalingState === 'closed') continue;
          addLocalTracksToPeer(pc);
          if (pc.signalingState === 'stable') {
            initiateConnection(userId);
          }
        }
      })
      .catch(() => {
        setIsStarting(false);
        setHasPermission(true);
      });

    return () => {
      for (const pc of peerConnections.current.values()) pc.close();
      peerConnections.current.clear();
      knownPeerIds.current.clear();
      remoteStreamsRef.current.clear();
      makingOffer.current.clear();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
      setLocalStream(null);
      setRemoteStreams(new Map());
      setPeerStates(new Map());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Add/remove video track when the boardroom is entered or left.
  // Arena = audio-only; boardroom = audio + video.
  useEffect(() => {
    if (!hasPermission || !localStreamRef.current) return;
    const stream = localStreamRef.current;

    if (isBoardroomMode) {
      // Check if we already have a video track
      if (stream.getVideoTracks().length > 0) {
        setIsCamOn(true);
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        .then(videoStream => {
          const videoTrack = videoStream.getVideoTracks()[0];
          if (!videoTrack || !localStreamRef.current) return;
          localStreamRef.current.addTrack(videoTrack);
          setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
          setIsCamOn(true);
          // Add video track to all existing peers and renegotiate
          for (const pc of peerConnections.current.values()) {
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed') continue;
            addLocalTracksToPeer(pc);
          }
          // Renegotiate with all peers
          for (const userId of peerConnections.current.keys()) {
            const pc = peerConnections.current.get(userId);
            if (pc && pc.signalingState === 'stable') {
              initiateConnection(userId);
            }
          }
        })
        .catch(() => { /* video not available, stay audio-only in boardroom */ });
    } else {
      // Stop and remove all video tracks
      const videoTracks = stream.getVideoTracks();
      if (videoTracks.length === 0) return;
      for (const track of videoTracks) {
        track.stop();
        stream.removeTrack(track);
      }
      setLocalStream(new MediaStream(stream.getTracks()));
      setIsCamOn(false);
      // Renegotiate so peers know video is gone
      for (const userId of peerConnections.current.keys()) {
        const pc = peerConnections.current.get(userId);
        if (pc && pc.signalingState === 'stable') {
          initiateConnection(userId);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBoardroomMode, hasPermission]);

  // Connect to each remote participant — both sides always initiate (perfect negotiation handles collision)
  useEffect(() => {
    if (!active || !hasPermission) return;

    for (const p of remoteParticipantList) {
      if (!knownPeerIds.current.has(p.userId)) {
        knownPeerIds.current.add(p.userId);
        initiateConnection(p.userId);
      }
    }

    const currentIds = new Set(remoteParticipantList.map(p => p.userId));
    for (const [id, pc] of peerConnections.current.entries()) {
      if (!currentIds.has(id)) {
        pc.close();
        peerConnections.current.delete(id);
        knownPeerIds.current.delete(id);
        remoteStreamsRef.current.delete(id);
        makingOffer.current.delete(id);
        setRemoteStreams(new Map(remoteStreamsRef.current));
        setPeerStates(prev => { const m = new Map(prev); m.delete(id); return m; });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hasPermission, remoteParticipantList]);

  // Register signal handler unconditionally — we need to answer incoming offers even if
  // we haven't entered boardroom mode yet (avoids Perfect Negotiation deadlock where
  // the impolite side's early offer gets dropped and both sides get stuck in have-local-offer).
  useEffect(() => {
    return registerWebRTCSignalHandler(handleSignal);
  }, [registerWebRTCSignalHandler, handleSignal]);

  // Read inside the media promise, which resolves after the first render.
  const isMicOnRef = useRef(isMicOn);
  isMicOnRef.current = isMicOn;

  const toggleMic = useCallback(() => {
    if (!localStreamRef.current) return;
    const next = !isMicOn;
    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = next; });
    setIsMicOn(next);
  }, [isMicOn]);

  const toggleCam = useCallback(() => {
    if (!localStreamRef.current) return;
    const next = !isCamOn;
    localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = next; });
    setIsCamOn(next);
  }, [isCamOn]);

  const toggleSpeaker = useCallback(() => {
    setIsSpeakerOn(prev => !prev);
  }, []);

  const toggleSameRoom = useCallback(() => {
    setIsSameRoom(prev => {
      const next = !prev;
      // Same-room on mutes your speakers (you're sitting next to the other person)
      if (next) setIsSpeakerOn(false);
      return next;
    });
  }, []);

  return {
    localStream, remoteStreams, peerStates, isMicOn, isCamOn, hasPermission, isStarting,
    toggleMic, toggleCam,
    isSpeakerOn, toggleSpeaker,
    isSameRoom, toggleSameRoom,
    micPermissionState,
  };
}
