// The curation panel's Requirements tab: the drag-reorderable list of
// requirements this review checks against. Shared by the room's Edit panel and —
// until it is deleted — the old curate page
// (docs/plan/14-rooms-models-admin-ai.md batch BH), so its writes arrive as
// `actions`: the two callers keep the review in different stores.

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { GripVertical, Plus, Scale, Trash2 } from 'lucide-react';
import type { Requirement } from '../../types';
import type { ReviewDraftActions } from './draftActions';

const REQ_STATUSES: Requirement['status'][] = ['MET', 'PENDING', 'AT_RISK'];

const STATUS_STYLE: Record<Requirement['status'], string> = {
  MET: 'bg-green-500/20 text-green-400',
  PENDING: 'bg-yellow-500/20 text-yellow-400',
  AT_RISK: 'bg-red-500/20 text-red-400',
};

export const RequirementsTab: React.FC<{
  requirements: Requirement[];
  actions: ReviewDraftActions;
}> = ({ requirements, actions }) => {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  return (
    <div className="p-5 flex flex-col gap-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Define the requirements this review is checking against. Drag to reorder.
      </p>

      {requirements.length === 0 && (
        <div className="text-center py-10 flex flex-col items-center gap-2 text-gray-500 text-xs italic">
          <Scale size={28} className="opacity-30" />
          No requirements yet
        </div>
      )}

      {requirements.map((req, idx) => (
        <div
          key={req.id}
          draggable
          onDragStart={() => setDragIdx(idx)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (dragIdx !== null) { actions.reorderRequirements(dragIdx, idx); setDragIdx(null); } }}
          className="rounded border border-white/10 bg-white/5 overflow-hidden"
        >
          <div className="flex items-center gap-2 p-2">
            <GripVertical size={12} className="text-gray-600 cursor-grab shrink-0" />
            <span className="text-[10px] font-mono text-gray-500 tabular-nums w-6 shrink-0">{String(idx + 1).padStart(2, '0')}</span>
            <input
              value={req.code}
              onChange={(e) => actions.updateRequirement(req.id, { code: e.target.value })}
              placeholder="REQ-001"
              className="w-24 bg-transparent text-[11px] font-mono font-bold text-orange-400 outline-none placeholder:text-gray-600 shrink-0"
            />
            <input
              value={req.description}
              onChange={(e) => actions.updateRequirement(req.id, { description: e.target.value })}
              placeholder="Requirement description"
              className="flex-1 bg-transparent text-xs text-gray-100 outline-none placeholder:text-gray-600 min-w-0"
            />
            <button onClick={() => actions.removeRequirement(req.id)} className="text-gray-500 hover:text-red-400 shrink-0">
              <Trash2 size={13} />
            </button>
          </div>
          <div className="flex items-center gap-2 px-2 pb-2 ml-8">
            <input
              type="text"
              value={req.category}
              onChange={(e) => actions.updateRequirement(req.id, { category: e.target.value })}
              placeholder="Category"
              className="bg-white/5 text-[10px] font-bold uppercase rounded px-1.5 py-0.5 border border-white/10 outline-none text-gray-300 w-32 placeholder:normal-case placeholder:font-normal placeholder:text-gray-600"
            />
            <select
              value={req.status}
              onChange={(e) => actions.updateRequirement(req.id, { status: e.target.value as Requirement['status'] })}
              className={clsx('text-[10px] font-bold uppercase rounded px-1.5 py-0.5 border outline-none', STATUS_STYLE[req.status])}
            >
              {REQ_STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
        </div>
      ))}

      {/* Always available: with the sample set gone, this is the only way in
          from an empty list (user, 2026-09-23: "just click to add"). */}
      <button
        onClick={() => actions.addRequirement({ code: '', description: '', category: '', status: 'PENDING' })}
        className="mt-1 flex items-center justify-center gap-2 p-3 rounded border-2 border-dashed border-white/15 hover:border-emerald-400/50 hover:bg-emerald-500/5 text-xs font-bold uppercase tracking-wide text-gray-400 hover:text-emerald-200 transition-colors"
      >
        <Plus size={14} /> Add requirement
      </button>
    </div>
  );
};
