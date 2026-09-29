import React from 'react';
import { Mic, MicOff, Video, VideoOff, Power } from 'lucide-react';
import { clsx } from 'clsx';
import HumanParticipantTile from '../HumanParticipantTile';
import { participantLabel } from '../../../../lib/identity';
import type { RemoteParticipantInfo } from '../../../../lib/usePartyPresence';

interface MobileBoardroomLayoutProps {
  localUserId: string;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  remoteParticipantList: RemoteParticipantInfo[];
  isMicOn: boolean;
  isCamOn: boolean;
  toggleMic: () => void;
  toggleCam: () => void;
  onEnd: () => void;
  isHost: boolean;
  boardroomLeaderId: string | null;
}

const MobileBoardroomLayout: React.FC<MobileBoardroomLayoutProps> = ({
  localUserId,
  localStream,
  remoteStreams,
  remoteParticipantList,
  isMicOn,
  isCamOn,
  toggleMic,
  toggleCam,
  onEnd,
  isHost,
  boardroomLeaderId,
}) => {
  const localUserName = (() => {
    try {
      const s = localStorage.getItem('vp_user');
      return s ? (JSON.parse(s).name || 'You') : 'You';
    } catch { return 'You'; }
  })();

  // Show up to 3 participants in the PiP strip (self + first 2 remote)
  const pipParticipants = [
    { userId: localUserId, name: localUserName, color: '#10b981', isYou: true, stream: localStream },
    ...remoteParticipantList.slice(0, 2).map(p => ({
      userId: p.userId, name: participantLabel(p.name, p.guest), color: p.color, isYou: false,
      stream: remoteStreams.get(p.userId) ?? null,
    })),
  ];

  return (
    <div className="w-full h-full flex flex-col pointer-events-none">
      {/* PiP camera tiles — top-right corner, floating over 3D */}
      <div className="absolute top-3 right-3 z-[100] flex flex-col gap-2 pointer-events-auto">
        {pipParticipants.map(p => (
          <div key={p.userId} className="w-24 h-[68px] rounded-lg overflow-hidden shadow-lg ring-1 ring-white/15">
            <HumanParticipantTile
              stream={p.stream}
              name={p.name}
              color={p.color}
              isMicOn={p.isYou ? isMicOn : true}
              isCamOn={p.isYou ? isCamOn : true}
              isYou={p.isYou}
              isPresenter={boardroomLeaderId === p.userId}
              size="fill"
            />
          </div>
        ))}
      </div>

      {/* Spacer — lets 3D show through */}
      <div className="flex-1" />

      {/* Bottom control bar */}
      <div className="bg-black/60 backdrop-blur-md border-t border-white/10 px-6 py-3 flex items-center justify-center gap-4 pointer-events-auto shrink-0">
        <button
          onClick={toggleMic}
          className={clsx(
            'w-12 h-12 rounded-full flex items-center justify-center border transition-all',
            !isMicOn
              ? 'bg-red-500/30 border-red-500/50 text-red-300'
              : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
          )}
        >
          {isMicOn ? <Mic size={18} /> : <MicOff size={18} />}
        </button>

        <button
          onClick={toggleCam}
          className={clsx(
            'w-12 h-12 rounded-full flex items-center justify-center border transition-all',
            !isCamOn
              ? 'bg-red-500/30 border-red-500/50 text-red-300'
              : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'
          )}
        >
          {isCamOn ? <Video size={18} /> : <VideoOff size={18} />}
        </button>

        {isHost && (
          <button
            onClick={onEnd}
            className="w-12 h-12 rounded-full flex items-center justify-center border bg-red-600/30 border-red-500/40 text-red-300 hover:bg-red-600/50 transition-all"
          >
            <Power size={18} />
          </button>
        )}
      </div>
    </div>
  );
};

export default MobileBoardroomLayout;
