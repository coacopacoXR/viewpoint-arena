import React, { useMemo } from 'react';
import { Mic, Pin } from 'lucide-react';
import { clsx } from 'clsx';
import { AgentState, PointOfInterest } from '../../../types';
import VRHeadsetTile from './VRHeadsetTile';

interface ParticipantTileProps {
  agent: AgentState;
  isSpeaking: boolean;
  isPinned: boolean;
  currentPoi: PointOfInterest | null;
  onPin: () => void;
  size?: 'sm' | 'md' | 'lg';
  fill?: boolean;
}

// Agent webcam capability map — id '2' (ENG.UNIT) has webcam; id '4' (VR.USER) has VR; rest are no-cam
const WEBCAM_AGENTS = new Set(['2']);
const VR_AGENTS = new Set(['4']);

function darkenHex(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (n >> 16) - amount);
  const g = Math.max(0, ((n >> 8) & 0xff) - amount);
  const b = Math.max(0, (n & 0xff) - amount);
  return `rgb(${r},${g},${b})`;
}

const SpeakingWaveform: React.FC<{ color: string }> = ({ color }) => (
  <div className="flex items-center gap-[2px] h-3">
    {[0, 1, 2, 3, 4].map(i => (
      <div
        key={i}
        className="w-[3px] rounded-full animate-pulse"
        style={{
          backgroundColor: color,
          height: `${[40, 70, 100, 60, 45][i]}%`,
          animationDelay: `${i * 80}ms`,
          animationDuration: '600ms',
        }}
      />
    ))}
  </div>
);

// No-cam silhouette (Teams/Zoom style)
const SilhouetteContent: React.FC = () => (
  <div className="flex items-center justify-center h-[calc(100%-28px)] relative">
    <svg
      viewBox="0 0 100 80"
      className="w-3/5 max-w-[72px] opacity-20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="50" cy="26" r="17" fill="rgba(255,255,255,0.9)" />
      <path d="M10 80 C10 53 28 45 50 45 C72 45 90 53 90 80 Z" fill="rgba(255,255,255,0.7)" />
    </svg>
    <div className="absolute bottom-2 right-2 text-[7px] font-mono text-white/25 bg-black/30 px-1.5 py-0.5 rounded tracking-wider">
      CAM OFF
    </div>
  </div>
);

// Live webcam-style content for agents with a camera (ENG.UNIT)
const WebcamContent: React.FC<{
  agent: AgentState;
  fill: boolean;
  size: 'sm' | 'md' | 'lg';
}> = ({ agent, fill, size }) => (
  <div className="flex items-center justify-center h-[calc(100%-28px)] relative overflow-hidden">
    {/* Subtle scanline overlay for webcam feel */}
    <div
      className="absolute inset-0 pointer-events-none opacity-[0.035] z-10"
      style={{
        backgroundImage:
          'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(255,255,255,1) 3px, rgba(255,255,255,1) 4px)',
      }}
    />
    {/* Avatar circle */}
    <div
      className={clsx(
        'rounded-full flex items-center justify-center text-white font-bold shadow-lg',
        fill
          ? 'w-12 h-12 text-xl'
          : size === 'sm'
          ? 'w-9 h-9 text-sm'
          : size === 'md'
          ? 'w-11 h-11 text-lg'
          : 'w-14 h-14 text-xl'
      )}
      style={{
        backgroundColor: agent.color,
        boxShadow: `0 0 20px ${agent.color}55, 0 0 40px ${agent.color}22`,
        border: `1px solid ${agent.color}88`,
      }}
    >
      {agent.name[0]}
    </div>
    {/* LIVE badge */}
    <div className="absolute top-1.5 left-1.5 flex items-center gap-1 bg-black/50 px-1.5 py-0.5 rounded z-20">
      <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
      <span className="text-[7px] font-mono text-green-400">LIVE</span>
    </div>
  </div>
);

const ParticipantTile: React.FC<ParticipantTileProps> = ({
  agent,
  isSpeaking,
  isPinned,
  currentPoi,
  onPin,
  size = 'md',
  fill = false,
}) => {
  const isVR = VR_AGENTS.has(agent.id);
  const hasWebcam = WEBCAM_AGENTS.has(agent.id);

  const bgStyle = useMemo(() => ({
    background: `radial-gradient(ellipse at 50% 30%, ${darkenHex(agent.color, 140)} 0%, #0d0d0d 80%)`,
  }), [agent.color]);

  const sizeClasses = fill
    ? 'w-full h-full'
    : {
        sm: 'w-32 h-24',
        md: 'w-44 h-32',
        lg: 'w-56 h-40',
      }[size];

  const roleBadgeColor: Record<string, string> = {
    PRESENTER: 'bg-orange-500/30 text-orange-300',
    REVIEWER: 'bg-blue-500/30 text-blue-300',
    OBSERVER: 'bg-gray-500/30 text-gray-300',
  };

  return (
    <div
      className={clsx(
        'relative rounded-lg overflow-hidden cursor-pointer select-none transition-all duration-200 group shrink-0',
        sizeClasses,
        isPinned
          ? 'ring-2 ring-white shadow-lg shadow-white/10'
          : 'ring-1 ring-white/10 hover:ring-white/30',
        isSpeaking && !isPinned && 'ring-2 ring-green-400 shadow-green-400/20 shadow-md',
      )}
      style={bgStyle}
      onClick={onPin}
      title={`${isPinned ? 'Unpin' : 'Pin'} ${agent.name}'s view`}
    >
      {/* Corner brackets aesthetic */}
      <div className="absolute top-1.5 left-1.5 w-3 h-3 border-t border-l border-white/20 rounded-tl" />
      <div className="absolute top-1.5 right-1.5 w-3 h-3 border-t border-r border-white/20 rounded-tr" />
      <div className="absolute bottom-6 left-1.5 w-3 h-3 border-b border-l border-white/20 rounded-bl" />
      <div className="absolute bottom-6 right-1.5 w-3 h-3 border-b border-r border-white/20 rounded-br" />

      {/* Main content area */}
      {isVR ? (
        <VRHeadsetTile agentId={agent.id} agentColor={agent.color} />
      ) : hasWebcam ? (
        <WebcamContent agent={agent} fill={fill} size={size} />
      ) : (
        <SilhouetteContent />
      )}

      {/* Name bar */}
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 backdrop-blur-sm px-2 py-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          {isSpeaking
            ? <SpeakingWaveform color={agent.color} />
            : <Mic size={9} className="text-white/40 shrink-0" />
          }
          <span className="text-white text-[10px] font-mono font-bold truncate">{agent.name}</span>
        </div>
        <span className={clsx('text-[8px] font-bold px-1 py-0.5 rounded shrink-0', roleBadgeColor[agent.role] || roleBadgeColor.OBSERVER)}>
          {agent.role[0]}
        </span>
      </div>

      {/* POI inspection badge */}
      {currentPoi && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white/80 text-[8px] font-mono px-2 py-0.5 rounded-full whitespace-nowrap max-w-[90%] truncate">
          👁 {currentPoi.label}
        </div>
      )}

      {/* Pinned indicator */}
      {isPinned && (
        <div className="absolute top-1.5 right-6 bg-white/90 text-black rounded px-1 py-0.5 text-[8px] font-bold flex items-center gap-0.5">
          <Pin size={7} />
          PINNED
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-white/0 group-hover:bg-white/5 transition-colors duration-150 pointer-events-none" />
    </div>
  );
};

export default ParticipantTile;
