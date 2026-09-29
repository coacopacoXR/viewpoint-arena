import React, { useEffect, useRef, useState } from 'react';
import { MonitorPlay } from 'lucide-react';
import { useStore } from '../../store';

const BoardroomCountdown: React.FC = () => {
  const boardroomPendingEntry = useStore(state => state.boardroomPendingEntry);
  const toggleBoardroomMode = useStore(state => state.toggleBoardroomMode);
  const cancelBoardroomEntry = useStore(state => state.cancelBoardroomEntry);

  const [count, setCount] = useState(3);
  const countRef = useRef(3);

  useEffect(() => {
    if (!boardroomPendingEntry) {
      countRef.current = 3;
      setCount(3);
      return;
    }

    countRef.current = 3;
    setCount(3);
    const interval = setInterval(() => {
      countRef.current -= 1;
      setCount(countRef.current);
      if (countRef.current <= 0) {
        clearInterval(interval);
        // toggleBoardroomMode now sets boardroomLeaderId = sessionHostId internally.
        // BoardroomPresenterSync then sets followingRemoteUserId for non-hosts.
        setTimeout(() => { toggleBoardroomMode(); }, 50);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [boardroomPendingEntry]);

  if (!boardroomPendingEntry) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
      <div className="flex flex-col items-center gap-6 text-white select-none">
        <div className="flex items-center gap-3 text-sm font-mono uppercase tracking-widest text-white/60">
          <MonitorPlay size={16} />
          Entering Boardroom View
        </div>

        <div
          className="text-[96px] font-bold font-mono leading-none tabular-nums"
          style={{ textShadow: '0 0 40px rgba(255,255,255,0.3)' }}
        >
          {count}
        </div>

        <div className="w-48 h-1 bg-white/20 rounded-full overflow-hidden">
          <div
            className="h-full bg-white rounded-full transition-all duration-1000 ease-linear"
            style={{ width: `${((3 - count) / 3) * 100}%` }}
          />
        </div>

        <button
          onClick={cancelBoardroomEntry}
          className="mt-2 px-5 py-2 rounded border border-white/30 text-white/70 text-xs font-mono uppercase tracking-widest hover:bg-white/10 hover:text-white transition-all"
        >
          Decline
        </button>
      </div>
    </div>
  );
};

export default BoardroomCountdown;
