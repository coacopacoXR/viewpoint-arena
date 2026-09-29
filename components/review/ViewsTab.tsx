// The curation panel's Views tab: captured viewpoints, each with a title, an
// explainer note and a jump-to button. Shared by the room's Edit panel and —
// until it is deleted — the old curate page
// (docs/plan/14-rooms-models-admin-ai.md batch BH), so its writes arrive as
// `actions`: the two callers keep the review in different stores.

import React from 'react';
import { Camera, Trash2 } from 'lucide-react';
import type { ReviewViewpoint } from '../../lib/reviewSetupStore';
import type { ReviewDraftActions } from './draftActions';

export const ViewsTab: React.FC<{
  viewpoints: ReviewViewpoint[];
  onJump: (vp: ReviewViewpoint) => void;
  actions: ReviewDraftActions;
}> = ({ viewpoints, onJump, actions }) => {
  return (
    <div className="p-5 flex flex-col gap-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Move the camera to the angle you want, then press <strong className="text-white">Save this view</strong> in the amber bar above. Saved viewpoints become jump-to anchors during the review, and a slide can be linked to one.
      </p>
      {viewpoints.length === 0 && (
        <div className="text-center py-12 text-gray-500 text-xs italic">
          <Camera size={28} className="mx-auto mb-2 opacity-30" />
          No viewpoints saved yet
        </div>
      )}
      {viewpoints.map((v, i) => (
        <div key={v.id} className="rounded border border-white/10 bg-white/5 overflow-hidden">
          {v.thumbnail && (
            <button onClick={() => onJump(v)} className="block w-full aspect-video bg-black overflow-hidden">
              <img src={v.thumbnail} alt={v.label} className="w-full h-full object-cover hover:opacity-90 transition-opacity" />
            </button>
          )}
          <div className="p-2 flex items-center gap-2">
            <span className="text-[10px] font-mono text-gray-500 tabular-nums w-6">{String(i + 1).padStart(2, '0')}</span>
            <input
              value={v.label}
              onChange={(e) => actions.updateViewpoint(v.id, { label: e.target.value })}
              placeholder="Viewpoint title"
              className="text-gray-100 flex-1 bg-transparent text-xs font-bold outline-none placeholder:text-gray-600"
            />
            <button onClick={() => onJump(v)} className="text-[10px] font-bold uppercase text-emerald-400 hover:text-emerald-300 px-1.5">
              Jump
            </button>
            <button onClick={() => actions.removeViewpoint(v.id)} className="text-gray-500 hover:text-red-400">
              <Trash2 size={13} />
            </button>
          </div>
          {/* Explainer notes — surfaces in-room as the viewpoint's comment content */}
          <div className="px-2 pb-2">
            <textarea
              value={v.notes ?? ''}
              onChange={(e) => actions.updateViewpoint(v.id, { notes: e.target.value })}
              placeholder="Notes / explainer — what should the room discuss at this view?"
              className="text-gray-100 w-full h-14 bg-black/30 text-[11px] rounded p-1.5 border border-white/10 outline-none focus:border-emerald-400/40 placeholder:text-gray-600 resize-none"
            />
          </div>
        </div>
      ))}
    </div>
  );
};
