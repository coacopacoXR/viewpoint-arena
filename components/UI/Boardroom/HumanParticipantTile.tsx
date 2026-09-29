import React, { useEffect, useRef, useState } from 'react';

interface HumanParticipantTileProps {
  stream: MediaStream | null;
  name: string;
  color: string;
  isMicOn?: boolean;
  isCamOn?: boolean;
  isYou?: boolean;
  isPresenter?: boolean;
  size?: 'sm' | 'md' | 'fill';
}

const HumanParticipantTile: React.FC<HumanParticipantTileProps> = ({
  stream,
  name,
  color,
  isMicOn = true,
  isCamOn = true,
  isYou = false,
  isPresenter = false,
  size = 'md',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  // Attach stream to video element
  useEffect(() => {
    if (!videoRef.current) return;
    if (stream) {
      videoRef.current.srcObject = stream;
    } else {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

  // Audio level detection — only for local user for performance
  useEffect(() => {
    if (!stream || !isYou) return;
    let ctx: AudioContext | null = null;
    let animId: number;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyzer = ctx.createAnalyser();
      analyzer.fftSize = 256;
      src.connect(analyzer);
      const buf = new Uint8Array(analyzer.frequencyBinCount);
      function tick() {
        analyzer.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        setAudioLevel(avg);
        animId = requestAnimationFrame(tick);
      }
      tick();
    } catch {
      // AudioContext not available
    }
    return () => {
      cancelAnimationFrame(animId);
      ctx?.close();
    };
  }, [stream, isYou]);

  const isSpeaking = isYou && isMicOn && audioLevel > 12;

  const hasActiveVideo = !!(
    stream &&
    isCamOn !== false &&
    stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live')
  );

  const initials = name
    .split(' ')
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const sizeClasses =
    size === 'sm'
      ? 'w-28 h-20'
      : size === 'fill'
      ? 'w-full h-full'
      : 'w-44 h-32';

  return (
    <div
      className={`relative rounded-lg overflow-hidden shrink-0 ${size !== 'fill' ? sizeClasses : 'w-full h-full'} group`}
      style={{
        background: `radial-gradient(ellipse at 50% 30%, ${color}22 0%, #0d0d0d 80%)`,
        boxShadow: isSpeaking ? `0 0 0 2px ${color}` : '0 0 0 1px rgba(255,255,255,0.12)',
      }}
    >
      {/* Corner brackets */}
      <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t border-l border-white/20 rounded-tl z-10 pointer-events-none" />
      <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t border-r border-white/20 rounded-tr z-10 pointer-events-none" />
      <div className="absolute bottom-6 left-1.5 w-3 h-3 border-b border-l border-white/20 rounded-bl z-10 pointer-events-none" />
      <div className="absolute bottom-6 right-1.5 w-3 h-3 border-b border-r border-white/20 rounded-br z-10 pointer-events-none" />

      {/* Video element — always mounted, hidden when no active video.
          Always muted: remote audio is played by the shared RemoteAudioSink
          in RoomPage, not by individual tiles (which would double playback). */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full"
        style={{
          objectFit: 'cover',
          display: hasActiveVideo ? 'block' : 'none',
        }}
      />

      {/* Avatar fallback when no video */}
      {!hasActiveVideo && (
        <div className="flex items-center justify-center h-[calc(100%-28px)] relative">
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-base shadow-lg"
            style={{ background: color, boxShadow: `0 0 20px ${color}55` }}
          >
            {initials}
          </div>
          {!isCamOn && (
            <div className="absolute bottom-2 right-2 text-[7px] font-mono text-white/25 bg-black/30 px-1.5 py-0.5 rounded tracking-wider">
              CAM OFF
            </div>
          )}
        </div>
      )}

      {/* Speaking ring glow */}
      {isSpeaking && (
        <div
          className="absolute inset-0 rounded-lg pointer-events-none"
          style={{ boxShadow: `inset 0 0 0 2px ${color}`, opacity: 0.85 }}
        />
      )}

      {/* Live indicator */}
      {hasActiveVideo && (
        <div className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-black/50 px-1.5 py-0.5 rounded z-20">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-[7px] font-mono text-green-400">LIVE</span>
        </div>
      )}

      {/* Mic muted indicator */}
      {!isMicOn && (
        <div className="absolute top-1.5 right-1.5 bg-red-500/80 p-0.5 rounded z-20">
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </div>
      )}

      {/* Name bar */}
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 backdrop-blur-sm px-2 py-1 flex items-center justify-between z-20">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-white text-[10px] font-mono font-bold truncate">
            {isYou ? 'YOU' : name.split(' ')[0]}
          </span>
        </div>
        {isPresenter && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded shrink-0 bg-yellow-500/30 text-yellow-300">PRES</span>
        )}
        {isYou && !isPresenter && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded shrink-0 bg-emerald-500/30 text-emerald-300">YOU</span>
        )}
      </div>
    </div>
  );
};

export default HumanParticipantTile;
