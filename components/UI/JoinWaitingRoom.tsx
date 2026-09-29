import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useJoinState } from '../../lib/usePartyPresence';

interface JoinWaitingRoomProps {
  roomId: string;
}

function getUserName(): string {
  try {
    const s = localStorage.getItem('vp_user');
    return s ? (JSON.parse(s).name || 'Guest') : 'Guest';
  } catch {
    return 'Guest';
  }
}

const JoinWaitingRoom: React.FC<JoinWaitingRoomProps> = ({ roomId }) => {
  const joinState = useJoinState();
  const navigate = useNavigate();
  const name = getUserName();

  return (
    <div
      className="flex items-center justify-center w-full h-screen"
      style={{ background: '#0a0a0b' }}
    >
      <div
        className="flex flex-col items-center gap-4 px-8 py-10 rounded-xl max-w-sm w-full mx-4"
        style={{
          background: '#111',
          border: '1px solid rgba(255,255,255,0.12)',
        }}
      >
        <div
          className="text-[10px] font-mono uppercase tracking-widest"
          style={{ color: 'rgba(255,255,255,0.3)' }}
        >
          Room · {roomId.slice(0, 8).toUpperCase()}
        </div>

        <div className="text-white text-sm font-bold">{name}</div>

        {joinState === 'declined' ? (
          <>
            <p
              className="text-xs text-center leading-relaxed"
              style={{ color: 'rgba(255,255,255,0.5)' }}
            >
              The host declined this request.
            </p>
            <button
              onClick={() => navigate('/')}
              className="px-4 py-2 rounded-lg text-xs font-bold transition-colors"
              style={{ background: '#fff', color: '#000' }}
            >
              Back to Lobby
            </button>
          </>
        ) : (
          <>
            <div
              className="w-6 h-6 border-2 rounded-full animate-spin"
              style={{
                borderColor: 'rgba(255,255,255,0.15)',
                borderTopColor: '#fff',
              }}
            />
            <p
              className="text-xs text-center leading-relaxed"
              style={{ color: 'rgba(255,255,255,0.5)' }}
            >
              {joinState === 'joining'
                ? 'Connecting…'
                : 'Waiting for the host to let you in.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default JoinWaitingRoom;
