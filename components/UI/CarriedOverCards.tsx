// The cards a session starts with: the ones its line was still carrying.
//
// docs/plan/15-sessions-and-variants.md batch BK. A design review's meetings are
// one continuous line of work, and the risks raised in S2 that nobody closed are
// still open in S4 — but before this they were only in the tracker, which is a page
// away from the room, so the fourth meeting started from a blank Capture panel and
// re-raised what the second had already found.
//
// This group sits above the deck of NEW cards and shows the line's still-open ones,
// one line each ("RISK · Hinge pin wears · from S2"), expandable. Three things about
// it are load-bearing and are the reason it is not simply "load the old cards into
// the store":
//
//   * They are the SAME tracker items. Nothing is copied, so editing one here edits
//     the row everybody else is looking at on the tracker page, and the status
//     history that lib/trackerContinuity.ts reads to say when a card closed is the
//     one this writes.
//   * They never enter `insightCards`, so the meeting flush cannot re-save them. A
//     card carried into three meetings is one row with one history, not three.
//   * They are read from `tracker_items` by line, not from a previous room's
//     storage: the room server keeps a scene, not a card list, and a review that met
//     last month has no room left to ask.
//
// Renders NOTHING when there is nothing carried over — a first meeting, an ad-hoc
// room with no review, an install whose database has no review_lines yet — so the
// Capture panel looks exactly as it did before this batch in every one of those.

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, History } from 'lucide-react';
import { clsx } from 'clsx';
import { listCarriedOver, updateLineItem, type CarriedOverItem } from '../../lib/reviews/linesRepo';
import { sessionLabel, type ReviewLine } from '../../lib/reviews/lines';

/** The statuses a carried-over card can be moved to. The tracker's own four. */
const STATUSES: readonly CarriedOverItem['status'][] = ['Open', 'In Review', 'Approved', 'Rejected'];

const TYPE_STYLE: Record<CarriedOverItem['type'], string> = {
  RISK: 'text-red-600',
  ACTION: 'text-blue-600',
  RATIONALE: 'text-amber-600',
};

export interface CarriedOverCardsProps {
  /** The line this room is on. Null — an ad-hoc room, no database — renders nothing. */
  line: ReviewLine | null;
  /**
   * Whether this person may change a card. The room's own answer
   * (lib/reviews/useReviewRole → can('editCard')), passed down rather than asked
   * again here because this group is mounted inside the Capture panel, which has
   * already asked it and which is mounted from three places.
   *
   * Hiding the control is not the enforcement; it is the panel not offering a tool
   * the room server would refuse.
   */
  mayEdit: boolean;
  /** The name written into tracker_status_history when somebody moves a card. */
  changedBy: string;
}

const CarriedOverCards: React.FC<CarriedOverCardsProps> = ({ line, mayEdit, changedBy }) => {
  const [items, setItems] = useState<CarriedOverItem[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!line) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void listCarriedOver(line).then((loaded) => {
      if (!cancelled) setItems(loaded);
    });
    return () => { cancelled = true; };
    // `line` is the row pages/RoomPage.tsx put in the store when it resolved this
    // room's line, and it is set once — so this reads once per line, not once per
    // render. (Contrast lib/usePartyPresence, which answers a fresh object every
    // render and must never be a dependency.)
  }, [line]);

  const changeStatus = useCallback(
    async (id: string, status: CarriedOverItem['status']) => {
      const before = items.find((item) => item.id === id);
      if (!before || before.status === status) return;
      // Optimistic, and reverted on failure: the panel is small and a status that
      // snaps back says "that did not work" more clearly than a spinner does.
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status } : item)));
      setSavingId(id);
      const saved = await updateLineItem(id, { status }, changedBy);
      setSavingId(null);
      if (saved) {
        // Closed here, so it is not carried into the next meeting either.
        if (status === 'Approved' || status === 'Rejected') {
          setItems((prev) => prev.filter((item) => item.id !== id));
        }
        return;
      }
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: before.status } : item)));
    },
    [items, changedBy],
  );

  if (items.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-gray-100 bg-gray-50/60">
      <button
        onClick={() => setExpanded((v) => !v)}
        title="Cards still open from earlier sessions on this line"
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-gray-100 transition-colors"
      >
        {expanded ? <ChevronDown size={11} className="text-gray-400" /> : <ChevronRight size={11} className="text-gray-400" />}
        <History size={11} className="text-gray-400" />
        <span className="text-[10px] font-bold uppercase tracking-widest text-gray-600 flex-1">Carried over</span>
        <span className="text-[10px] font-mono font-bold text-black tabular-nums">{items.length}</span>
      </button>

      {expanded && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          {items.map((item) => {
            // "from S2" — the session it was raised in, on this line. A session with
            // no number (recorded before seq existed) is named by its card alone
            // rather than as "from S0". The read answers the label itself where the
            // card is on a DIFFERENT line — the parent line's open cards, which is
            // what a variant that has never met starts with — because numbering one
            // of those with this variant's letter would call S2 "A2".
            const from = item.fromLabel ?? sessionLabel(line, item.fromSeq);
            const isOpen = openId === item.id;
            return (
              <div key={item.id} className="bg-white rounded border border-gray-200">
                <button
                  onClick={() => setOpenId(isOpen ? null : item.id)}
                  className="w-full flex items-baseline gap-1.5 px-2 py-1.5 text-left hover:bg-gray-50 transition-colors min-w-0"
                  title={item.description || item.title}
                >
                  <span className={clsx('font-mono text-[9px] font-bold flex-shrink-0', TYPE_STYLE[item.type])}>
                    {item.type}
                  </span>
                  <span className="text-[11px] text-gray-700 truncate flex-1">{item.title}</span>
                  {from && (
                    <span className="font-mono text-[9px] text-gray-400 flex-shrink-0">from {from}</span>
                  )}
                  {isOpen ? <ChevronDown size={10} className="text-gray-300 flex-shrink-0" /> : <ChevronRight size={10} className="text-gray-300 flex-shrink-0" />}
                </button>

                {isOpen && (
                  <div className="px-2 pb-2 border-t border-gray-100 pt-1.5">
                    {item.description && (
                      <p className="text-[10px] text-gray-500 leading-relaxed">{item.description}</p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      <span className="font-mono text-[9px] text-gray-400">{item.priority}</span>
                      {item.assignee && <span className="font-mono text-[9px] text-gray-400">· {item.assignee}</span>}
                      {mayEdit ? (
                        <select
                          value={item.status}
                          disabled={savingId === item.id}
                          onChange={(e) => void changeStatus(item.id, e.target.value as CarriedOverItem['status'])}
                          aria-label={`Status of ${item.title}`}
                          className="ml-auto border border-gray-200 rounded px-1.5 py-0.5 text-[10px] bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-black cursor-pointer disabled:opacity-40"
                        >
                          {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                      ) : (
                        <span className="ml-auto font-mono text-[9px] text-gray-400">{item.status}</span>
                      )}
                      <Link
                        to="/tracker"
                        title="Open in the tracker"
                        className="p-0.5 text-gray-300 hover:text-black transition-colors"
                      >
                        <ExternalLink size={11} />
                      </Link>
                    </div>
                    {/* One card, one row, one history. Saying so is the point of the
                        group: these are not copies and closing one closes it
                        everywhere. */}
                    <p className="mt-1 font-mono text-[8px] text-gray-300">
                      The same card the tracker holds — changes here change it there.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CarriedOverCards;
