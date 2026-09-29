// What the room says while a review is being edited, to the people who are not
// editing it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. Three things, one stack, because
// they are three answers to the same question and only one of them is true at a
// time for any given person:
//
//   the banner   somebody else has Edit on. Persistent, and the reason the tools
//                are not on this screen — without it a participant would see the
//                review change and have no idea who was changing it.
//   the prompt   I pressed Edit and the room said somebody has it. Dismissible,
//                and carrying the one thing that can be done about it: take over.
//   the notice   I WAS editing and somebody took over. Shown once.
//
// All three read state the room server wrote. None of them guesses, which is what
// keeps "only one person edits at a time" from being six clients' opinions about
// it.

import React from 'react';
import { Pencil, X } from 'lucide-react';
import { useStore } from '../../store';

const ReviewEditingNotice: React.FC<{
  /** This browser's presence id, so the banner knows not to greet itself. */
  localUserId: string;
  /** Ask the room to hand Edit to me, ending whoever has it. */
  onTakeOver: () => void;
}> = ({ localUserId, onTakeOver }) => {
  const editing = useStore((s) => s.reviewEditing);
  const refusal = useStore((s) => s.reviewEditRefusal);
  const notice = useStore((s) => s.reviewEditNotice);
  const setNotice = useStore((s) => s.setReviewEditNotice);
  const setRefusal = useStore((s) => s.setReviewEditRefusal);

  const someoneElseEditing = editing !== null && editing.userId !== localUserId;
  const editorName = editing?.name || 'Somebody';

  /**
   * The room's answer to a press of Edit.
   *
   * Three answers, and the third is not about this person: 'busy' names a colleague
   * and comes with the take-over, 'role' names the review's roster, and 'dropped'
   * names the LINE — this room is a variant the review has finished with, so there is
   * no edit for anybody to hold and nothing to take over. A dropped variant is kept on
   * the session map for the record and its room is still reachable by address, which
   * is how somebody comes to press Edit in one.
   */
  const refusalText = (reason: 'busy' | 'role' | 'dropped', name: string | null): string => {
    if (reason === 'busy') return `${name || 'Somebody'} is editing`;
    if (reason === 'dropped') return 'This variant was dropped, so it can no longer be edited.';
    return 'Editing this review is for its owner and its editors';
  };

  if (!someoneElseEditing && !refusal && !notice) return null;

  return (
    <div className="flex flex-col items-center gap-2 pointer-events-none">
      {/* Taken over. One-shot: it is an event, not a state, and leaving it up
          would be a stale accusation against a colleague who has since stopped. */}
      {notice && (
        <div className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-lg bg-black/90 text-white shadow-2xl border border-gray-700">
          <Pencil size={14} className="text-amber-400 shrink-0" />
          <span className="text-xs font-bold">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-gray-400 hover:text-white transition-colors shrink-0"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Refused. The room's answer to a press of Edit, and the only place the
          take-over is offered: taking Edit away from somebody is a decision, not a
          default, so it is never one click from the banner. */}
      {refusal && (
        <div className="pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-lg bg-white shadow-lg border border-amber-400">
          <span className="text-xs text-gray-800">
            {refusalText(refusal.reason, refusal.editorName)}
          </span>
          {refusal.reason === 'busy' && (
            <>
              <span className="text-xs text-gray-500">— ask them, or</span>
              <button
                onClick={onTakeOver}
                className="px-2.5 py-1 rounded bg-amber-400 text-black text-[10px] font-bold uppercase tracking-wide hover:bg-amber-300 transition-colors shrink-0"
              >
                Take over
              </button>
            </>
          )}
          <button
            onClick={() => setRefusal(null)}
            className="text-gray-400 hover:text-gray-700 transition-colors shrink-0"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* The banner. Amber, not the tools' amber-on-black: this is a notice about
          the meeting, and the person it describes is the one with the strip. */}
      {someoneElseEditing && !refusal && (
        <div className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-amber-400/95 shadow-lg border border-amber-500">
          <Pencil size={13} className="text-amber-950 shrink-0" />
          <span className="text-[11px] font-bold text-amber-950">
            {editorName} is editing the review
          </span>
        </div>
      )}
    </div>
  );
};

export default ReviewEditingNotice;
