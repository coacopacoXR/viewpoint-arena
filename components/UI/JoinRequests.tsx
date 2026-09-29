import React from 'react';
import { UserPlus, X } from 'lucide-react';
import { useJoinRequests, broadcastAdmit, broadcastDecline } from '../../lib/usePartyPresence';
import { participantLabel } from '../../lib/identity';

const JoinRequests: React.FC = () => {
  const requests = useJoinRequests();
  if (requests.length === 0) return null;

  return (
    <div
      className="pointer-events-auto flex flex-col gap-1 px-3 py-2 rounded-lg shadow-lg"
      style={{
        background: 'rgba(0,0,0,0.85)',
        border: '1px solid rgba(255,255,255,0.12)',
        minWidth: 200,
      }}
    >
      <div
        className="text-[9px] font-bold uppercase tracking-widest mb-1"
        style={{ color: 'rgba(255,255,255,0.4)' }}
      >
        Waiting to Join
      </div>
      {requests.map((req) => (
        <div
          key={req.userId}
          className="flex items-center justify-between gap-3 py-1.5"
        >
          <span className="text-xs font-bold text-white truncate">
            {participantLabel(req.name, req.guest)}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => broadcastAdmit(req.userId)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold transition-colors"
              style={{ background: '#10b981', color: '#fff' }}
              title="Admit"
            >
              <UserPlus size={11} />
              Admit
            </button>
            <button
              onClick={() => broadcastDecline(req.userId)}
              className="flex items-center justify-center p-1 rounded transition-colors"
              style={{ color: 'rgba(255,255,255,0.4)' }}
              title="Decline"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default JoinRequests;
