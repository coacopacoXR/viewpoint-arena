// A card somebody typed, instead of one an agent read out of the transcript.
//
// docs/plan/14-rooms-models-admin-ai.md batch BG. The user's ask was that "it
// should be possible for users to add decision cards themselves in case they do
// not want to use AI" — and the gap was DURING the meeting, because the tracker
// page has had Add item since a meeting ended. So this is an inline form in the
// Capture panel's insights deck, not a modal and not a browser dialog: the deck
// is where the cards this one will sit beside are already listed, and a form that
// covers the 3D scene would hide the very part the card is about.
//
// What it produces is an ordinary InsightCard, differing from an agent's in two
// fields only — `source: 'manual'` and `createdByName`. That is deliberate: the
// broadcast (usePartyPresence's INSIGHT_CARD), the store's dedupe-and-cap, the
// detail modal a click opens, and the tracker row written at meeting end all
// already handle an InsightCard, so a hand-made card needs no new path through
// any of them. lib/trackerBridge writes source/created_by_name from exactly
// those two fields.
//
// The three exported helpers are pure — no store, no DOM, no clock of their own —
// so the part-attachment rule and the card shape are testable without rendering.

import React, { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Lightbulb, X } from 'lucide-react';
import { clsx } from 'clsx';
import { InsightCard, InsightDetails, InsightType } from '../../types';
import type { FlatComponent } from '../../lib/componentIndex';

/** A part in the scene this card can be about, by the id the tree knows it by. */
export interface PointedPart {
  /** The scene node's id — what a grounded AI card puts in componentReference. */
  id: string;
  /** The name the room shows for that node. */
  name: string;
}

/** The fields the form collects. Empty strings mean "not filled in". */
export interface ManualCardInput {
  type: InsightType;
  title: string;
  description: string;
  priority: InsightDetails['priority'];
  /** ACTION only, as in the extraction prompt: the person who owns it. */
  assignee: string;
  /** ACTION only, YYYY-MM-DD — what an `<input type="date">` gives. */
  dueDate: string;
}

export interface BuildManualCardOptions {
  /** The part to attach, or null for a card about the meeting rather than a mesh. */
  part: PointedPart | null;
  /** My display name, for the tracker's "added by" and the card's footer. */
  createdByName: string;
  now: number;
  id: string;
}

/**
 * Build the card. `agentId` is empty because no agent wrote it: every consumer
 * that looks an agent up by id (`agents.find(...)`) then answers "none", which is
 * the truth, and the footer prints `createdByName` instead.
 */
export function buildManualCard(
  input: ManualCardInput,
  options: BuildManualCardOptions,
): InsightCard {
  const details: InsightDetails = {
    priority: input.priority,
    status: 'Open',
  };
  const assignee = input.assignee.trim();
  if (assignee !== '') details.assignee = assignee;
  const dueDate = input.dueDate.trim();
  if (dueDate !== '') details.dueDate = dueDate;
  // The part is recorded the way a grounded AI card records it: the node id in
  // componentReference, which is what lib/trackerBridge.cardPart reads to work
  // out part_node_id and which revision the card was raised on.
  if (options.part) details.componentReference = options.part.id;

  return {
    id: options.id,
    type: input.type,
    agentId: '',
    title: input.title.trim(),
    description: input.description.trim(),
    timestamp: options.now,
    details,
    source: 'manual',
    createdByName: options.createdByName,
  };
}

/**
 * Which part this card would be about, out of the two states the room already has.
 *
 * The laser wins when it is fresh, because it is the only one of the two that
 * carries a NAME as well as an id — and because "the part I am pointing at" is
 * what a person means when they press + Card mid-sentence. Otherwise the selected
 * node, which is what clicking a part in the model tree leaves behind (the laser
 * selects too, so on a desktop the two usually agree) and whose name has to be
 * looked up in the flattened tree.
 *
 * Null when neither names a part, which is the common case in an ad-hoc room with
 * no model loaded — and then the form simply has no checkbox.
 */
export function pointedPartFor(opts: {
  /** The local user's laser entry, or null when the laser is not on a part. */
  laser: { id: string | null; name: string | null } | null;
  /** The node the room has selected, or null. */
  selectedNodeId: string | null;
  /** The scene tree flattened the way the extraction prompt flattens it. */
  components: readonly FlatComponent[];
}): PointedPart | null {
  const laserId = opts.laser?.id ?? null;
  const laserName = opts.laser?.name ?? null;
  if (laserId !== null && laserId !== '' && laserName !== null && laserName !== '') {
    return { id: laserId, name: laserName };
  }

  const selected = opts.selectedNodeId;
  if (selected === null || selected === '') return null;
  const found = opts.components.find((c) => c.id === selected);
  // A selected id the tree does not know is a stale selection — a model that was
  // replaced while the form was open. No name means no checkbox rather than a
  // checkbox offering a bare id.
  return found ? { id: found.id, name: found.name } : null;
}

/** An id no agent's card can collide with, in the parser's own `insight-` family. */
export function newManualCardId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') {
    return `insight-manual-${crypto.randomUUID()}`;
  }
  // jsdom and some edge runtimes ship crypto without randomUUID.
  const rand = Math.random().toString(36).slice(2, 10);
  return `insight-manual-${Date.now().toString(36)}-${rand}`;
}

const TYPES: Array<{ id: InsightType; label: string; icon: typeof AlertTriangle; chip: string }> = [
  { id: 'RISK', label: 'Risk', icon: AlertTriangle, chip: 'bg-red-50 text-red-600 border-red-200' },
  { id: 'ACTION', label: 'Action', icon: CheckCircle2, chip: 'bg-blue-50 text-blue-600 border-blue-200' },
  { id: 'RATIONALE', label: 'Rationale', icon: Lightbulb, chip: 'bg-amber-50 text-amber-600 border-amber-200' },
];

const PRIORITIES: InsightDetails['priority'][] = ['Critical', 'High', 'Medium', 'Low'];

const ManualCardForm: React.FC<{
  /** The part on screen, or null when nothing is selected or pointed at. */
  part: PointedPart | null;
  onSave: (input: ManualCardInput, part: PointedPart | null) => void;
  onCancel: () => void;
}> = ({ part, onSave, onCancel }) => {
  const [type, setType] = useState<InsightType>('RISK');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<InsightDetails['priority']>('Medium');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  // Null until the person says otherwise, so a part that appears while the form
  // is open comes with the box already ticked — pointing at something and then
  // pressing + Card is the whole gesture.
  const [aboutPart, setAboutPart] = useState<boolean | null>(null);

  const attachPart = part !== null && (aboutPart ?? true);
  const isAction = type === 'ACTION';
  const canSave = title.trim() !== '';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave(
      { type, title, description, priority, assignee: isAction ? assignee : '', dueDate: isAction ? dueDate : '' },
      attachPart ? part : null,
    );
  }

  return (
    <form
      onSubmit={submit}
      className="border border-gray-200 rounded shadow-sm bg-gray-50/60 p-2.5 flex flex-col gap-2"
      aria-label="New card"
    >
      <div className="flex items-center gap-1">
        {TYPES.map(({ id, label, icon: Icon, chip }) => (
          <button
            key={id}
            type="button"
            onClick={() => setType(id)}
            aria-pressed={type === id}
            className={clsx(
              'text-[9px] font-bold px-1.5 py-0.5 rounded-full border uppercase tracking-wide flex items-center gap-1 transition-colors',
              chip,
              type === id ? 'ring-1 ring-black/20' : 'opacity-50 hover:opacity-90',
            )}
          >
            <Icon size={10} />
            {label}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        maxLength={120}
        autoFocus
        aria-label="Title"
        className="text-xs font-semibold text-gray-800 bg-white border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-gray-400 w-full"
      />

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What was said, and why it matters"
        rows={2}
        aria-label="Description"
        className="text-[10px] leading-snug text-gray-700 bg-white border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-gray-400 w-full resize-none"
      />

      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-[9px] font-bold text-gray-500 uppercase shrink-0">
          Priority
        </label>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as InsightDetails['priority'])}
          aria-label="Priority"
          className="text-[10px] font-bold text-gray-700 bg-white border border-gray-200 rounded px-1.5 py-1 outline-none cursor-pointer"
        >
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {isAction && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Assignee"
            maxLength={60}
            aria-label="Assignee"
            className="flex-1 min-w-0 text-[10px] text-gray-700 bg-white border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400"
          />
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            aria-label="Due date"
            className="text-[10px] text-gray-700 bg-white border border-gray-200 rounded px-1.5 py-1 outline-none focus:border-gray-400"
          />
        </div>
      )}

      {part && (
        <label className="flex items-center gap-1.5 text-[10px] text-gray-600 cursor-pointer">
          <input
            type="checkbox"
            checked={attachPart}
            onChange={(e) => setAboutPart(e.target.checked)}
            className="accent-black"
          />
          <span className="truncate">About the part: <span className="font-mono font-bold">{part.name}</span></span>
        </label>
      )}

      <div className="flex items-center justify-end gap-1 pt-0.5">
        <button
          type="button"
          onClick={onCancel}
          className="p-1.5 rounded-full text-gray-500 hover:bg-gray-200 transition-colors"
          title="Cancel"
        >
          <X size={12} />
        </button>
        <button
          type="submit"
          disabled={!canSave}
          title={canSave ? 'Add card' : 'A title is required'}
          className="p-1.5 rounded-full bg-green-50 text-green-600 hover:bg-green-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Check size={12} />
        </button>
      </div>
    </form>
  );
};

export default ManualCardForm;
