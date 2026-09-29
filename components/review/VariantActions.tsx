// The three things you can do with a variant, and the two things they ask first.
//
// docs/plan/15-sessions-and-variants.md batch BL, generalised by batch BX. "Explore a
// variant from here" asks for a short name; "Drop variant" asks for a one-line reason;
// "Merge into…" asks WHERE, and then — only if BOTH lines moved the same model — the one
// plain question api/reviews/lines.ts sends back:
//
//   "Keep Rev C from the main line or Rev B2 from Variant A?"
//
// Each question is an inline row of the same panel that offered the action, with a
// text field or two buttons and a way out. There is deliberately NO conflict screen,
// no side-by-side diff and no third state to get lost in: the people using this are
// hardware engineers in a meeting, the plan is explicit that the programming
// metaphor must not show through, and a merge conflict dialogue is the single most
// recognisable piece of that metaphor there is.
//
// One component, three hosts — the session map (in the room, in the tracker and in the
// lobby's preview), the chip in a variant's own top bar, and the lobby's Lines list —
// because the actions, their prompts and the sentences they answer with are the same in
// all of them and a second copy is a second place for the words to drift.
//
// WHO MAY DO IT is decided by lib/reviews/roles.ts through `mayEdit`, which the host
// passes down from lib/reviews/useReviewRole. All three are `editReview`: the
// review's owners and editors, and the meeting host on an install with no accounts.
// Hiding the buttons is not the enforcement — the endpoint checks the caller's own
// token against the roster — it is the panel not offering a tool that would be
// refused.
//
// THE WORDS ARE THE SPEC. "Variant", "Main line", "Explore a variant", "Merge into…",
// "Drop variant". Never branch, fork or commit, in a label, a title attribute, a
// placeholder or a sentence. "Merge" IS allowed and is the user's own word for it
// (2026-09-26); the database's status column still says 'adopted', because a status is
// not a sentence anybody reads.

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import {
  adoptVariant,
  dropVariant,
  exploreVariant,
  type AdoptKeep,
  type LineActionContext,
  type LineActionResult,
} from '../../lib/reviews/linesClient';
import { listLines, resetLineCache, type LineSession } from '../../lib/reviews/linesRepo';
import { openLine } from '../../lib/reviews/openLine';
import {
  activeChildrenOf,
  defaultMergeTarget,
  isMainLine,
  lineLabel,
  lineLabelWithOrigin,
  mergeTargetWord,
  mergeTargets,
  shortLineLabel,
  type ReviewLine,
} from '../../lib/reviews/lines';

const BUTTON =
  'inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold transition-colors disabled:opacity-40';
const FIELD =
  'flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-[11px] text-gray-800 focus:outline-none focus:ring-1 focus:ring-black';
const ROW =
  'w-full h-8 px-2 flex items-center gap-1.5 rounded-sm border text-left text-[11px] font-semibold transition-colors';

/** The sentence shown while a write is in flight, per action. */
const BUSY: Record<string, string> = {
  explore: 'Starting the variant…',
  adopt: 'Merging…',
  drop: 'Dropping the variant…',
};

export interface VariantActionContext extends LineActionContext {
  /**
   * Whether the buttons belong on screen at all. The host's answer from
   * lib/reviews/useReviewRole → can('editReview'), passed down rather than asked
   * again here because this component is mounted inside panels that have already
   * asked it.
   */
  mayEdit: boolean;
  /**
   * Called after a write landed, so the host can read the lines again and redraw.
   * Omitted where there is nothing to refresh — a variant's own room navigates away
   * instead.
   */
  onChanged?: () => void;
  /**
   * How this host opens a line's room.
   *
   * Passed down rather than worked out here, because the lobby has a name form to
   * submit first and opens through its own `enterRoom`, while every other host opens
   * through lib/reviews/openLine. Omitted and `openLine` is used, which is the right
   * answer everywhere except the lobby — and the point of the prop is that a plain
   * <Link> is never the right answer anywhere: pages/RoomPage's entry guard admits an
   * arrival by its router state, so a link to the correct address still bounces.
   */
  onOpenLine?: (lineId: string | null) => void;
}

/** The error line, and the way out of it. Shared by all three prompts. */
const Notice: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-[10px] text-red-600 leading-snug" role="status">{text}</p>
);

/**
 * The lines of a review, from the host when it has them and from the database when it
 * does not.
 *
 * The merge chooser has to list every line still being explored, and two of the three
 * hosts already read the lines for their own drawing — but the room's chip reads them
 * lazily and a test's fixtures may not include them at all, so this asks once when it
 * is handed nothing and caches nothing of its own (lib/reviews/linesRepo already does).
 */
function useReviewLines(reviewId: string, given: readonly ReviewLine[] | undefined): readonly ReviewLine[] {
  const [read, setRead] = useState<ReviewLine[] | null>(null);
  useEffect(() => {
    if (given || !reviewId) return;
    let cancelled = false;
    void listLines(reviewId).then((lines) => {
      if (!cancelled && lines.length > 0) setRead(lines);
    });
    return () => { cancelled = true; };
  }, [given, reviewId]);
  return given ?? read ?? [];
}

/**
 * "Explore a variant from here" — on any session stop, on any line.
 *
 * Asks for a short name, starts the variant, and opens its room. The room it opens
 * is a DIFFERENT PartyKit room (`<reviewId>~<letter>`), so the people exploring the
 * variant have their own presence, their own audio and their own scene, and cannot
 * move a model on another line's screen by moving one on theirs.
 */
export const ExploreVariantButton: React.FC<
  VariantActionContext & {
    reviewId: string;
    session: LineSession;
    /** The line the session is on, so the prompt can say where the variant leaves from. */
    line?: ReviewLine | null;
  }
> = ({ reviewId, session, line, mayEdit, isMeetingHost, onChanged, onOpenLine }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const wanted = name.trim();
    if (wanted === '' || busy) return;
    setBusy(true);
    setError(null);
    // Both halves of where it leaves from: the meeting, which is what the map draws
    // the branch leaving from, and the LINE, which is what the new room reads its
    // model, its positions and its carried-over cards from. Batch BX: the line used to
    // be implied by the meeting and could therefore only ever be the main one.
    const result: LineActionResult = await exploreVariant(
      reviewId,
      { parentSessionId: session.id, parentLineId: line?.id ?? null },
      wanted,
      { isMeetingHost },
    );
    setBusy(false);
    if (!result.ok || !result.line) {
      setError(result.error ?? 'The variant could not be started.');
      return;
    }
    // The cache holds the lines as they were before this write, and the room the
    // navigation opens resolves its line from it.
    resetLineCache();
    onChanged?.();
    if (onOpenLine) onOpenLine(result.line.id);
    else openLine(navigate, reviewId, result.line.id);
  }, [line, name, busy, reviewId, session.id, isMeetingHost, onChanged, onOpenLine, navigate]);

  if (!mayEdit) return null;

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setError(null); }}
        className={clsx(BUTTON, 'border-gray-200 text-gray-600 hover:border-gray-400 hover:text-black bg-white')}
        title="Start a named side line from this session, with its model and its open cards"
      >
        <Plus size={11} />
        Explore a variant from here
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="explore-variant">
      <label className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest" htmlFor="variant-name">
        New variant from {shortLineLabel(line ?? null) ?? 'this line'} · {session.title || 'this session'}
      </label>
      <div className="flex items-center gap-1.5">
        <input
          id="variant-name"
          value={name}
          autoFocus
          maxLength={80}
          placeholder="Steel hinge pin"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setOpen(false); }}
          className={FIELD}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || name.trim() === ''}
          className={clsx(BUTTON, 'border-black bg-black text-white hover:bg-gray-800')}
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
        <button
          onClick={() => setOpen(false)}
          disabled={busy}
          title="Cancel"
          aria-label="Cancel"
          className={clsx(BUTTON, 'border-gray-200 text-gray-400 hover:text-black')}
        >
          <X size={11} />
        </button>
      </div>
      {busy && <p className="text-[10px] text-gray-400">{BUSY.explore}</p>}
      {error && <Notice text={error} />}
      <p className="text-[10px] text-gray-400 leading-snug">
        It starts on this session’s model, with the cards that were still open in it.
      </p>
    </div>
  );
};

/**
 * "Merge into…" and "Drop variant" — on a variant that is still being explored.
 *
 * A merged or dropped one has no actions: it is on the map for the record, and offering
 * to merge a variant that has already been merged is how a review ends up with two sets
 * of cards claiming the same decision.
 */
export const VariantActions: React.FC<
  VariantActionContext & {
    reviewId: string;
    variant: ReviewLine;
    /** Every line of the review, so the chooser can list the ones still being explored. */
    lines?: readonly ReviewLine[];
    /**
     * True when these actions are in the variant's OWN room rather than on a map
     * looking at it. A variant that has just been merged or dropped has no room to
     * be in — the meeting continues on the line its model and its cards went to, or on
     * the main line after a drop — so the room navigates there. A map does not: the
     * person pressed a button about a line they are not standing on.
     */
    inRoom?: boolean;
  }
> = ({ reviewId, variant, lines, mayEdit, isMeetingHost, onChanged, onOpenLine, inRoom = false }) => {
  const navigate = useNavigate();
  const all = useReviewLines(reviewId, lines);
  const [busy, setBusy] = useState<null | 'adopt' | 'drop'>(null);
  const [error, setError] = useState<string | null>(null);
  /** The question a merge asked. */
  const [question, setQuestion] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState('');
  /** The chooser, and the line it has selected. */
  const [choosing, setChoosing] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);

  const targets = mergeTargets(all, variant);
  const chosen = targets.find((line) => line.id === targetId) ?? defaultMergeTarget(all, variant);
  const children = activeChildrenOf(all, variant.id);

  const where = shortLineLabel(variant) ?? 'This variant';

  const goTo = useCallback(
    (line: ReviewLine | null) => {
      if (onOpenLine) onOpenLine(line && !isMainLine(line) ? line.id : null);
      else openLine(navigate, reviewId, line && !isMainLine(line) ? line.id : null);
    },
    [navigate, onOpenLine, reviewId],
  );

  const after = useCallback(
    (target: ReviewLine | null) => {
      // The cache holds the lines as they were before this write, and every reader —
      // the map, the tracker's filter, the room's own chip — resolves through it.
      resetLineCache();
      onChanged?.();
      // A merged variant's meeting continues on the line its model went to, and a
      // dropped one's on the main line: neither has a room to be in any more.
      if (inRoom) goTo(target);
    },
    [goTo, inRoom, onChanged],
  );

  const runAdopt = useCallback(
    async (keep: AdoptKeep | null) => {
      const target = chosen;
      setBusy('adopt');
      setError(null);
      const result = await adoptVariant(
        reviewId,
        variant.id,
        { targetLineId: target?.id ?? null, keep },
        { isMeetingHost },
      );
      setBusy(null);
      if (result.question) {
        setQuestion(result.question);
        return;
      }
      if (!result.ok) {
        setError(result.error ?? 'The variant could not be merged.');
        return;
      }
      setQuestion(null);
      setChoosing(false);
      after(target);
    },
    [after, chosen, isMeetingHost, reviewId, variant.id],
  );

  const runDrop = useCallback(async () => {
    const wanted = reason.trim();
    if (wanted === '') return;
    setBusy('drop');
    setError(null);
    const result = await dropVariant(reviewId, variant.id, wanted, { isMeetingHost });
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? 'The variant could not be dropped.');
      return;
    }
    setDropping(false);
    after(null);
  }, [after, isMeetingHost, reason, reviewId, variant.id]);

  if (!mayEdit || variant.kind !== 'variant' || variant.status !== 'active') return null;

  const targetWord = mergeTargetWord(chosen);

  return (
    <div className="flex flex-col gap-1.5">
      {question === null && !dropping && !choosing && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => { setChoosing(true); setTargetId(null); setError(null); }}
            disabled={busy !== null}
            data-testid="merge-variant"
            className={clsx(BUTTON, 'border-green-600 text-green-700 hover:bg-green-50 bg-white')}
            title="Take this variant’s model and its cards into another line"
          >
            <Check size={11} />
            Merge into…
          </button>
          <button
            onClick={() => { setDropping(true); setError(null); }}
            disabled={busy !== null}
            data-testid="drop-variant-open"
            className={clsx(BUTTON, 'border-gray-200 text-gray-500 hover:border-gray-400 hover:text-black bg-white')}
            title="Close this variant and its open cards, and keep it on the map for the record"
          >
            <X size={11} />
            Drop variant
          </button>
        </div>
      )}

      {/* WHERE IT IS GOING — batch BX. A chooser rather than a button, because a merge
          has a destination and the destination is no longer always the main line. The
          line it was started from is already selected: that is the answer nearly every
          time, and a chooser that opens with nothing selected is a chooser that makes
          somebody read a list before they can press the obvious thing. */}
      {choosing && question === null && (
        <div className="flex flex-col gap-1.5" data-testid="merge-chooser">
          <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">
            Merge {where} into
          </p>
          {targets.length === 0 ? (
            <p className="text-[10px] text-gray-400 leading-snug">
              There is no other line still being explored to merge it into.
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="merge-targets">
              {targets.map((line) => {
                const selected = chosen?.id === line.id;
                const name = lineLabelWithOrigin(all, line) ?? (isMainLine(line) ? 'Main line' : 'Variant');
                return (
                  <li key={line.id}>
                    <button
                      onClick={() => { setTargetId(line.id); setError(null); }}
                      data-testid="merge-target"
                      data-line={line.id}
                      aria-pressed={selected}
                      className={clsx(
                        ROW,
                        selected
                          ? 'border-black bg-black text-white'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:text-black',
                      )}
                    >
                      <span className="truncate">{name}</span>
                      <ChevronRight size={12} className="ml-auto shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {/* Its own variants are not lost by a merge, and saying so is what stops the
              chooser reading as a warning. They continue from the line this one went
              into, in the same transaction — see adopt_review_line. */}
          {children.length > 0 && chosen && (
            <p className="text-[10px] text-gray-500 leading-snug" data-testid="merge-children">
              {children.map((child) => shortLineLabel(child) ?? 'Another variant').join(' and ')}
              , started from it, will continue from {mergeTargetWord(chosen)}.
            </p>
          )}
          {targets.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => void runAdopt(null)}
                disabled={busy !== null || !chosen}
                data-testid="merge-go"
                className={clsx(BUTTON, 'border-black bg-black text-white hover:bg-gray-800')}
              >
                {busy === 'adopt' ? 'Merging…' : `Merge into ${targetWord}`}
              </button>
              <button
                onClick={() => setChoosing(false)}
                disabled={busy !== null}
                className={clsx(BUTTON, 'border-gray-200 text-gray-400 hover:text-black')}
              >
                Not now
              </button>
            </div>
          )}
        </div>
      )}

      {/* ONE plain question, two answers, and a way out. Not a comparison. Both halves
          name a LINE, and from batch BX the first one is whichever line the merge is
          going into — a question that said "the main line" about a merge into Variant A
          would ask somebody to choose between two models and write the answer onto a
          third. */}
      {question !== null && (
        <div className="flex flex-col gap-1.5" data-testid="adopt-question">
          <p className="text-[11px] text-gray-700 leading-snug">{question}</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => void runAdopt('target')}
              disabled={busy !== null}
              className={clsx(BUTTON, 'border-gray-300 text-gray-700 hover:border-black hover:text-black bg-white')}
            >
              Keep {targetWord}’s
            </button>
            <button
              onClick={() => void runAdopt('variant')}
              disabled={busy !== null}
              className={clsx(BUTTON, 'border-black bg-black text-white hover:bg-gray-800')}
            >
              Take {where}’s
            </button>
            <button
              onClick={() => setQuestion(null)}
              disabled={busy !== null}
              className={clsx(BUTTON, 'border-transparent text-gray-400 hover:text-black')}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {dropping && (
        <div className="flex flex-col gap-1.5" data-testid="drop-variant">
          <label className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest" htmlFor="drop-reason">
            Why {lineLabel(variant) ?? 'this variant'} was dropped
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="drop-reason"
              value={reason}
              autoFocus
              maxLength={200}
              placeholder="Too expensive to tool"
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void runDrop(); if (e.key === 'Escape') setDropping(false); }}
              className={FIELD}
            />
            <button
              onClick={() => void runDrop()}
              disabled={busy !== null || reason.trim() === ''}
              className={clsx(BUTTON, 'border-black bg-black text-white hover:bg-gray-800')}
            >
              Drop it
            </button>
            <button
              onClick={() => setDropping(false)}
              disabled={busy !== null}
              title="Cancel"
              aria-label="Cancel"
              className={clsx(BUTTON, 'border-gray-200 text-gray-400 hover:text-black')}
            >
              <X size={11} />
            </button>
          </div>
          <p className="text-[10px] text-gray-400 leading-snug">
            Its open cards close with this reason on them. It stays on the map, greyed, for the record.
          </p>
        </div>
      )}

      {busy !== null && <p className="text-[10px] text-gray-400">{BUSY[busy]}</p>}
      {error && <Notice text={error} />}
    </div>
  );
};

export default VariantActions;
