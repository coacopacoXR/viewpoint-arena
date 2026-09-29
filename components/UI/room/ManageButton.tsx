// The one entry point to the host's split-screen Manager workspace.
//
// It used to live at the foot of ReviewPanelContent, which only renders when
// the review pill has viewpoints, pins or slides — so the workspace was
// unreachable in exactly the meeting that has not produced any yet. It is a
// room control, so it sits beside the call bar and is always there for the host.

import React from 'react';
import { ClipboardList } from 'lucide-react';
import { useStore } from '../../../store';
import { usePresence } from '../../../lib/PresenceContext';
import { useActiveReviewStore } from '../../../lib/activeReviewStore';

const ManageButton: React.FC = () => {
  const sessionHostId = useStore((s) => s.sessionHostId);
  const { localUserId } = usePresence();
  const isHost = sessionHostId === localUserId || sessionHostId === null;

  if (!isHost) return null;

  return (
    <button
      onClick={() => useActiveReviewStore.getState().setManagerMode(true)}
      aria-label="Manage"
      title="Split-screen workspace: triage action cards and write follow-ups"
      className="pointer-events-auto h-9 shrink-0 flex items-center gap-2 px-2.5 rounded-md border shadow-sm transition-colors bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
    >
      <ClipboardList size={14} />
      <span className="hidden [@media(min-width:1500px)]:inline text-[11px] font-bold uppercase tracking-wide">
        Manage
      </span>
    </button>
  );
};

export default ManageButton;
