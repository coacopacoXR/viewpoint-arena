import React from 'react';
import {
  Lock, Unlock, MousePointerClick, LayoutGrid,
  Focus, MessageSquare, Zap, User, Crown, Mic2
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../../store';
import { usePresence } from '../../../lib/PresenceContext';
import { participantLabel } from '../../../lib/identity';
import { BoardroomLayout } from '../../../types';

const LAYOUTS: { id: BoardroomLayout; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: 'focus',   label: 'Focus',   icon: <Focus size={14} />,      desc: 'Fullscreen model + bottom strip' },
  { id: 'gallery', label: 'Gallery', icon: <LayoutGrid size={14} />, desc: 'Participant panel left, model right' },
];

interface MeetingManagerPopoverProps {
  onClose: () => void;
}

const MeetingManagerPopover: React.FC<MeetingManagerPopoverProps> = ({ onClose }) => {
  const {
    boardroomLayout, setBoardroomLayout,
    boardroomInteractionEnabled, toggleBoardroomInteraction,
    boardroomLayoutLocked, toggleBoardroomLayoutLocked,
    boardroomTranscriptPermission, toggleBoardroomTranscriptPermission,
    takeoverModeEnabled, setTakeoverModeEnabled,
    takeoverApprovedUserIds, toggleTakeoverApproval,
    boardroomLeaderId,
    sessionHostId,
  } = useStore();

  const { localUserId, remoteParticipantList, broadcastTakeoverSync, broadcastHostTransfer, broadcastLeaderTakeover } = usePresence();

  const isHost = sessionHostId === localUserId || sessionHostId === null;

  // All participants: local user + remote
  const allParticipants = [
    { userId: localUserId, name: 'You' },
    ...remoteParticipantList.map(p => ({ ...p, name: participantLabel(p.name, p.guest) })),
  ];
  const activeUserIds = new Set(allParticipants.map(p => p.userId));

  // Drop approvals for users who have since left so the host doesn't carry
  // ghosts around. The server also prunes on disconnect, but pre-filtering
  // here avoids a flicker in the UI list.
  const liveApprovedUserIds = takeoverApprovedUserIds.filter(id => activeUserIds.has(id));

  // Helper: toggle takeover enabled and broadcast (pre-pruned)
  const handleTakeoverToggle = () => {
    if (!isHost) return;
    const newEnabled = !takeoverModeEnabled;
    setTakeoverModeEnabled(newEnabled);
    broadcastTakeoverSync(newEnabled, liveApprovedUserIds);
  };

  // Helper: toggle approval and broadcast (pre-pruned)
  const handleApprovalToggle = (userId: string) => {
    if (!isHost) return;
    toggleTakeoverApproval(userId);
    const newApproved = liveApprovedUserIds.includes(userId)
      ? liveApprovedUserIds.filter(id => id !== userId)
      : [...liveApprovedUserIds, userId];
    broadcastTakeoverSync(takeoverModeEnabled, newApproved);
  };

  return (
    <div className="fixed top-14 right-4 z-[9999] w-72 bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-white text-xs font-bold uppercase tracking-wider">Meeting Settings</span>
        <div className="flex items-center gap-2">
          {!isHost && (
            <span className="text-[8px] text-white/30 font-mono uppercase bg-white/5 px-1.5 py-0.5 rounded">View only</span>
          )}
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors text-lg leading-none">×</button>
        </div>
      </div>

      {/* Layout selector */}
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white/60 text-[10px] uppercase tracking-wider font-bold">Layout</span>
          {boardroomLayoutLocked && (
            <span className="text-[8px] text-orange-400 font-mono uppercase">Locked</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYOUTS.map(l => (
            <button
              key={l.id}
              onClick={() => isHost && !boardroomLayoutLocked && setBoardroomLayout(l.id)}
              disabled={!isHost || boardroomLayoutLocked}
              className={clsx(
                'flex flex-col items-start gap-1 p-2 rounded-lg border text-left transition-all',
                boardroomLayout === l.id
                  ? 'bg-white text-black border-white'
                  : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10 hover:text-white',
                (!isHost || boardroomLayoutLocked) && boardroomLayout !== l.id && 'opacity-40 cursor-not-allowed'
              )}
            >
              <div className="flex items-center gap-1.5">
                {l.icon}
                <span className="text-[10px] font-bold">{l.label}</span>
              </div>
              <span className="text-[8px] leading-tight opacity-60">{l.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Camera Presenter — host appoints a real participant */}
      {isHost && (
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-1.5 mb-2">
          <Mic2 size={10} className="text-yellow-400" />
          <span className="text-white/60 text-[10px] uppercase tracking-wider font-bold">Camera Presenter</span>
        </div>
        <div className="flex flex-col gap-1">
          {allParticipants.map(p => {
            const isCurrentPresenter = boardroomLeaderId === p.userId;
            return (
              <button
                key={p.userId}
                onClick={() => broadcastLeaderTakeover(p.userId)}
                className={clsx(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all border',
                  isCurrentPresenter
                    ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-200'
                    : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10 hover:text-white'
                )}
              >
                <User size={10} />
                <span className="flex-1 truncate">{p.name}</span>
                {isCurrentPresenter && (
                  <span className="text-[8px] font-mono text-yellow-400 bg-yellow-500/20 px-1 rounded">PRESENTING</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {/* Toggles */}
      <div className="px-4 py-3 flex flex-col gap-2">
        <button
          onClick={() => isHost && toggleBoardroomInteraction()}
          disabled={!isHost}
          className={clsx(
            'flex items-center justify-between w-full px-3 py-2 rounded-lg border text-xs transition-all',
            boardroomInteractionEnabled
              ? 'bg-green-500/20 border-green-500/40 text-green-300'
              : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10',
            !isHost && 'cursor-not-allowed opacity-60'
          )}
        >
          <div className="flex items-center gap-2">
            <MousePointerClick size={12} />
            Allow model interaction
          </div>
          <Toggle active={boardroomInteractionEnabled} />
        </button>

        <button
          onClick={() => isHost && toggleBoardroomTranscriptPermission()}
          disabled={!isHost}
          className={clsx(
            'flex items-center justify-between w-full px-3 py-2 rounded-lg border text-xs transition-all',
            boardroomTranscriptPermission
              ? 'bg-blue-500/20 border-blue-500/40 text-blue-300'
              : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10',
            !isHost && 'cursor-not-allowed opacity-60'
          )}
        >
          <div className="flex items-center gap-2">
            <MessageSquare size={12} />
            Show transcript to attendees
          </div>
          <Toggle active={boardroomTranscriptPermission} color="blue" />
        </button>

        <button
          onClick={() => isHost && toggleBoardroomLayoutLocked()}
          disabled={!isHost}
          className={clsx(
            'flex items-center justify-between w-full px-3 py-2 rounded-lg border text-xs transition-all',
            boardroomLayoutLocked
              ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
              : 'bg-white/5 border-white/10 text-white/60 hover:bg-white/10',
            !isHost && 'cursor-not-allowed opacity-60'
          )}
        >
          <div className="flex items-center gap-2">
            {boardroomLayoutLocked ? <Lock size={12} /> : <Unlock size={12} />}
            Lock layout
          </div>
          <Toggle active={boardroomLayoutLocked} color="orange" />
        </button>
      </div>

      {/* Takeover Mode */}
      <div className="px-4 py-3 border-t border-white/10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Zap size={10} className="text-yellow-400" />
            <span className="text-white/60 text-[10px] uppercase tracking-wider font-bold">Takeover Mode</span>
          </div>
          <button
            onClick={handleTakeoverToggle}
            disabled={!isHost}
            className={clsx(
              'flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-bold border transition-all',
              takeoverModeEnabled
                ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-300'
                : 'bg-white/5 border-white/10 text-white/40 hover:text-white',
              !isHost && 'cursor-not-allowed opacity-50'
            )}
          >
            <Toggle active={takeoverModeEnabled} color="orange" />
          </button>
        </div>
        <p className="text-white/30 text-[9px] mb-2 leading-tight">
          When on, approved participants auto-claim camera control by moving.
        </p>
        {takeoverModeEnabled && (
          <div className="flex flex-col gap-1">
            {allParticipants.map(p => {
              const isApproved = liveApprovedUserIds.includes(p.userId);
              const isCameraLeader = boardroomLeaderId === p.userId;
              return (
                <button
                  key={p.userId}
                  onClick={() => handleApprovalToggle(p.userId)}
                  disabled={!isHost}
                  className={clsx(
                    'flex items-center gap-2 px-2 py-1.5 rounded-lg border text-xs transition-all text-left',
                    isApproved
                      ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-200'
                      : 'bg-white/5 border-white/10 text-white/50 hover:bg-white/10',
                    !isHost && 'cursor-not-allowed'
                  )}
                >
                  <User size={10} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {isCameraLeader && (
                    <span className="text-[8px] font-mono text-yellow-400 bg-yellow-500/20 px-1 rounded">CAMERA</span>
                  )}
                  <div className={clsx(
                    'w-3 h-3 rounded border shrink-0 flex items-center justify-center',
                    isApproved ? 'bg-yellow-500 border-yellow-400' : 'bg-transparent border-white/20'
                  )}>
                    {isApproved && <div className="w-1.5 h-1.5 bg-white rounded-sm" />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Host Transfer — host only */}
      {isHost && allParticipants.length > 1 && (
        <div className="px-4 py-3 border-t border-white/10">
          <div className="flex items-center gap-1.5 mb-2">
            <Crown size={10} className="text-amber-400" />
            <span className="text-white/60 text-[10px] uppercase tracking-wider font-bold">Transfer Host</span>
          </div>
          <p className="text-white/30 text-[9px] mb-2 leading-tight">
            Pass session control to another participant.
          </p>
          <div className="flex flex-col gap-1">
            {allParticipants.filter(p => p.userId !== localUserId).map(p => (
              <button
                key={p.userId}
                onClick={() => { broadcastHostTransfer(p.userId); onClose(); }}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/50 hover:bg-amber-500/15 hover:border-amber-500/30 hover:text-amber-200 text-xs transition-all text-left"
              >
                <User size={10} />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-[8px] text-white/25">Make host</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const Toggle: React.FC<{ active: boolean; color?: 'green' | 'blue' | 'orange' }> = ({ active, color = 'green' }) => {
  const bg = active
    ? color === 'orange' ? 'bg-orange-500' : color === 'blue' ? 'bg-blue-500' : 'bg-green-500'
    : 'bg-white/20';
  return (
    <div className={clsx('w-8 h-4 rounded-full transition-all relative shrink-0', bg)}>
      <div className={clsx(
        'absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all',
        active ? 'left-[18px]' : 'left-0.5'
      )} />
    </div>
  );
};

export default MeetingManagerPopover;
