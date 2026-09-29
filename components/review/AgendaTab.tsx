// The curation panel's Agenda tab: the slide deck, drag-to-reorder, each slide
// carrying a title, speaker notes and any number of attached viewpoints/pins.
// Shared by the room's Edit panel and — until it is deleted — the old curate
// page (docs/plan/14-rooms-models-admin-ai.md batch BH), so its writes arrive as
// `actions`: the two callers keep the review in different stores.

import React, { useState } from 'react';
import { clsx } from 'clsx';
import { Camera, GripVertical, Layers, MapPin, Plus, X } from 'lucide-react';
import type {
  AgendaItem,
  ReviewPin,
  ReviewViewpoint,
} from '../../lib/reviewSetupStore';
import type { ReviewDraftActions } from './draftActions';
import { SEVERITY_META } from './PinsTab';

export const AgendaTab: React.FC<{
  agenda: AgendaItem[];
  viewpoints: ReviewViewpoint[];
  pins: ReviewPin[];
  onJumpViewpoint: (vp: ReviewViewpoint) => void;
  onSelectPin: (id: string) => void;
  actions: ReviewDraftActions;
}> = ({ agenda, viewpoints, pins, onJumpViewpoint, onSelectPin, actions }) => {
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  return (
    <div className="p-5 flex flex-col gap-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Build the deck. Each slide has a title, speaker notes, and any number of viewpoints and pins. Drag to reorder.
      </p>

      {agenda.length === 0 && (
        <div className="text-center py-10 text-gray-500 text-xs italic">
          <Layers size={28} className="mx-auto mb-2 opacity-30" />
          No slides yet
        </div>
      )}

      {agenda.map((item, idx) => (
        <SlideCard
          key={item.id}
          item={item}
          idx={idx}
          viewpoints={viewpoints}
          pins={pins}
          actions={actions}
          onJumpViewpoint={onJumpViewpoint}
          onSelectPin={onSelectPin}
          onRemove={() => actions.removeAgendaItem(item.id)}
          onDragStart={() => setDragIdx(idx)}
          onDrop={() => { if (dragIdx !== null) { actions.reorderAgenda(dragIdx, idx); setDragIdx(null); } }}
        />
      ))}

      <button
        onClick={() => actions.addAgendaItem({ title: `Slide ${agenda.length + 1}` })}
        className="mt-3 flex items-center justify-center gap-2 p-3 rounded border-2 border-dashed border-white/15 hover:border-emerald-400/50 hover:bg-emerald-500/5 text-xs font-bold uppercase tracking-wide text-gray-400 hover:text-emerald-200 transition-colors"
      >
        <Plus size={14} /> Add blank slide
      </button>
    </div>
  );
};

// Module-private: a slide is only ever rendered by the deck above it, and the
// reorder state lives there.
const SlideCard: React.FC<{
  item: AgendaItem;
  idx: number;
  viewpoints: ReviewViewpoint[];
  pins: ReviewPin[];
  actions: ReviewDraftActions;
  onJumpViewpoint: (vp: ReviewViewpoint) => void;
  onSelectPin: (id: string) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}> = ({ item, idx, viewpoints, pins, actions, onJumpViewpoint, onSelectPin, onRemove, onDragStart, onDrop }) => {
  const [pickerOpen, setPickerOpen] = useState<'viewpoint' | 'pin' | null>(null);

  const linkedVps = item.viewpointIds
    .map((vid) => viewpoints.find((v) => v.id === vid))
    .filter((v): v is ReviewViewpoint => Boolean(v));
  const linkedPins = item.pinIds
    .map((pid) => pins.find((p) => p.id === pid))
    .filter((p): p is ReviewPin => Boolean(p));

  const availableVps = viewpoints.filter((v) => !item.viewpointIds.includes(v.id));
  const availablePins = pins.filter((p) => !item.pinIds.includes(p.id));

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      className="rounded border border-white/10 bg-white/5 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-start gap-2 p-2 border-b border-white/5">
        <div className="flex flex-col items-center pt-1">
          <GripVertical size={12} className="text-gray-600 cursor-grab" />
          <span className="text-[9px] font-mono text-gray-500 tabular-nums">{String(idx + 1).padStart(2, '0')}</span>
        </div>
        <input
          value={item.title}
          onChange={(e) => actions.updateAgendaItem(item.id, { title: e.target.value })}
          placeholder="Slide title"
          className="text-gray-100 flex-1 bg-transparent text-xs font-bold outline-none placeholder:text-gray-600"
        />
        <button onClick={onRemove} className="text-gray-500 hover:text-red-400" title="Remove slide">
          <X size={14} />
        </button>
      </div>

      {/* Speaker notes */}
      <div className="px-2 pt-2">
        <textarea
          value={item.notes ?? ''}
          onChange={(e) => actions.updateAgendaItem(item.id, { notes: e.target.value })}
          placeholder="Speaker notes — what should you say at this slide?"
          className="text-gray-100 w-full h-14 bg-black/30 text-[11px] rounded p-1.5 border border-white/10 outline-none focus:border-emerald-400/40 placeholder:text-gray-600 resize-none"
        />
      </div>

      {/* Attachments */}
      <div className="p-2 flex flex-col gap-2">
        {/* Viewpoints */}
        {linkedVps.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {linkedVps.map((v) => (
              <div key={v.id} className="flex items-center gap-1 rounded bg-emerald-500/10 border border-emerald-400/30 pl-1 pr-1">
                {v.thumbnail && (
                  <img src={v.thumbnail} alt="" className="w-6 h-4 object-cover rounded-sm" />
                )}
                <button
                  onClick={() => onJumpViewpoint(v)}
                  className="text-[10px] font-bold text-emerald-100 hover:text-white px-1 truncate max-w-[140px]"
                  title="Jump camera to this viewpoint"
                >
                  <Camera size={9} className="inline -mt-0.5 mr-0.5" />{v.label}
                </button>
                <button
                  onClick={() => actions.detachViewpointFromAgendaItem(item.id, v.id)}
                  className="text-emerald-300/60 hover:text-red-300"
                  title="Remove from slide"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Pins */}
        {linkedPins.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {linkedPins.map((p) => {
              const sev = SEVERITY_META[p.severity];
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-1 rounded border pl-1 pr-1"
                  style={{ background: `${sev.color}1a`, borderColor: `${sev.color}66` }}
                >
                  <span style={{ color: sev.color }} className="flex items-center">{sev.icon}</span>
                  <button
                    onClick={() => onSelectPin(p.id)}
                    className="text-[10px] font-bold text-white hover:text-white px-1 truncate max-w-[140px]"
                    title="Show pin in Pins tab"
                  >
                    {p.label}
                  </button>
                  <button
                    onClick={() => actions.detachPinFromAgendaItem(item.id, p.id)}
                    className="text-white/40 hover:text-red-300"
                    title="Remove from slide"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Attach buttons */}
        <div className="flex gap-1.5 flex-wrap">
          {availableVps.length > 0 && (
            <button
              onClick={() => setPickerOpen(pickerOpen === 'viewpoint' ? null : 'viewpoint')}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors',
                pickerOpen === 'viewpoint'
                  ? 'bg-emerald-500/20 text-emerald-200'
                  : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'
              )}
            >
              <Camera size={11} /> + Viewpoint
            </button>
          )}
          {availablePins.length > 0 && (
            <button
              onClick={() => setPickerOpen(pickerOpen === 'pin' ? null : 'pin')}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider transition-colors',
                pickerOpen === 'pin'
                  ? 'bg-amber-500/20 text-amber-200'
                  : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'
              )}
            >
              <MapPin size={11} /> + Pin
            </button>
          )}
          {availableVps.length === 0 && availablePins.length === 0 && linkedVps.length === 0 && linkedPins.length === 0 && (
            <span className="text-[10px] text-gray-600 italic">No viewpoints or pins captured yet — add them in the other tabs.</span>
          )}
        </div>

        {/* Pickers */}
        {pickerOpen === 'viewpoint' && availableVps.length > 0 && (
          <div className="flex flex-col gap-0.5 rounded bg-black/40 border border-white/10 p-1 max-h-40 overflow-y-auto">
            {availableVps.map((v) => (
              <button
                key={v.id}
                onClick={() => { actions.attachViewpointToAgendaItem(item.id, v.id); setPickerOpen(null); }}
                className="flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] hover:bg-emerald-500/10 hover:text-emerald-200"
              >
                {v.thumbnail && <img src={v.thumbnail} alt="" className="w-8 h-5 object-cover rounded-sm" />}
                <span className="truncate">{v.label}</span>
              </button>
            ))}
          </div>
        )}
        {pickerOpen === 'pin' && availablePins.length > 0 && (
          <div className="flex flex-col gap-0.5 rounded bg-black/40 border border-white/10 p-1 max-h-40 overflow-y-auto">
            {availablePins.map((p) => {
              const sev = SEVERITY_META[p.severity];
              return (
                <button
                  key={p.id}
                  onClick={() => { actions.attachPinToAgendaItem(item.id, p.id); setPickerOpen(null); }}
                  className="flex items-center gap-2 px-2 py-1 rounded text-left text-[11px] hover:bg-amber-500/10 hover:text-amber-100"
                >
                  <span style={{ color: sev.color }} className="flex items-center">{sev.icon}</span>
                  <span className="truncate flex-1">{p.label}</span>
                  {p.partName && <span className="text-[9px] text-gray-500 truncate">{p.partName}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
