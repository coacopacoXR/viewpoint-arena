import React, { useEffect, useRef } from 'react';
import { useWebRTCContext } from '../../lib/WebRTCContext';

// One hidden <audio> per remote stream, mounted at the RoomPage level so audio
// plays in the arena AND the boardroom. The boardroom tiles are always muted
// (HumanParticipantTile sets muted on every video element) — this is the single
// sink for all remote audio. When isSpeakerOn is false, every element is muted
// to silence all remote participants at once.
const RemoteAudioSink: React.FC = () => {
  const { remoteStreams, isSpeakerOn } = useWebRTCContext();
  // Track which userId each audio element belongs to, so we can reassign
  // srcObject when the stream Map changes (peer reconnect, etc.)
  const elementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  useEffect(() => {
    const elements = elementsRef.current;
    // Remove elements for streams that no longer exist
    for (const [userId, el] of elements) {
      if (!remoteStreams.has(userId)) {
        el.srcObject = null;
        elements.delete(userId);
      }
    }
    // Add or update elements for current streams
    for (const [userId, stream] of remoteStreams) {
      let el = elements.get(userId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('data-remote-audio', userId);
        document.body.appendChild(el);
        elements.set(userId, el);
      }
      if (el.srcObject !== stream) {
        el.srcObject = stream;
      }
    }
  }, [remoteStreams]);

  // Mute/unmute all elements when speaker toggles
  useEffect(() => {
    for (const el of elementsRef.current.values()) {
      el.muted = !isSpeakerOn;
    }
  }, [isSpeakerOn]);

  // Cleanup on unmount
  useEffect(() => {
    const elements = elementsRef.current;
    return () => {
      for (const el of elements.values()) {
        el.srcObject = null;
        el.remove();
      }
      elements.clear();
    };
  }, []);

  return null;
};

export default RemoteAudioSink;
