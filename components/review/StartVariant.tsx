// "Variant" — the button that starts one, and the two things it says before it does.
//
// docs/plan/15-sessions-and-variants.md batch BQ. Until now the ONLY way to start a
// variant was Sessions → click a meeting → "Explore a variant from here" at the bottom
// of that meeting's panel: three clicks deep, on a diagram, behind a stop you have to
// know to click. The user's own words were "i dont see anything about creating the
// product variants". So the action gets a button on the room's top bar, beside
// Sessions, and the same button on the lobby's preview panel beside "Open room" —
// both places a person looks when they are wondering what they can do here.
//
// The panel it opens says ONE thing the deep version could not: what the variant will
// start from. "Starts from: S3 · 24 Sep", or "Starts from: the model as it is now" for
// a review that has never recorded a meeting — which is the case the endpoint had to
// learn to accept, because a review that has been curated but has not met has no
// session to leave from and its variant is still worth starting.
//
// THE WORDS ARE THE SPEC, and they are the ones components/review/VariantActions.tsx
// is held to: the word on screen is "Variant". Never branch, never fork — the icon may
// be a forking line because that is what a forking line looks like, and the sentence
// beside it is what a hardware engineer reads.
//
// The write is the existing one: lib/reviews/linesClient.exploreVariant →
// api/reviews/lines.ts, which checks `can(role, 'editReview')` from the caller's own
// token and the roster as the database holds it. Hiding this button is not the
// enforcement; it is the room not offering a tool that would be refused.

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, X } from 'lucide-react';
import { clsx } from 'clsx';
import {
  exploreVariant,
  type LineActionContext,
  type LineActionResult,
} from '../../lib/reviews/linesClient';
import { lineOriginSession, listLines, resetLineCache } from '../../lib/reviews/linesRepo';
import { openLine } from '../../lib/reviews/openLine';
import { sessionLabel } from '../../lib/reviews/lines';
import { shortDate } from '../../lib/trackerContinuity';

const FIELD =
  'flex-1 min-w-0 border border-gray-300 rounded px-2 py-1.5 text-[12px] text-gray-800 focus:outline-none focus:ring-1 focus:ring-black';
const BUTTON =
  'inline-flex items-center gap-1 px-2.5 py-1.5 rounded border text-[11px] font-semibold transition-colors disabled:opacity-40';

/** What the variant will start from, once the read that works it out has answered. */
interface Origin {
  /** The meeting it leaves from, or null for a line that has never met. */
  sessionId: string | null;
  /**
   * The LINE it leaves from, or null when this review has no lines at all.
   *
   * Batch BX, and the half that makes a variant of a variant possible: the endpoint
   * records it as `parent_line_id`, and lib/reviews/linesRepo then reads the new room's
   * model, its saved positions and its carried-over cards from that line rather than
   * from the review's main one. Worked out here rather than left to the endpoint's
   * fallback because this panel already has the lines in hand and because a null sent
   * for a variant's room would mean "the main line" — the one answer that is wrong
   * exactly when the button is pressed inside a variant.
   */
  lineId: string | null;
  /** The sentence the panel shows after "Starts from:". */
  text: string;
}

export interface StartVariantProps extends LineActionContext {
  reviewId: string;
  /**
   * can(role, 'editReview'), decided by the host and passed down: both surfaces this
   * button sits on have already asked lib/reviews/useReviewRole, and asking again here
   * would be a second read of the same roster for the same answer.
   */
  mayEdit: boolean;
  /**
   * The line the variant leaves from, or null for the review's main line — which is
   * the answer in a room that is not itself a variant and in the lobby, where the
   * panel is looking at the review rather than standing in one of its lines.
   */
  lineId?: string | null;
  /** What the button says. The word is "Variant" on every surface. */
  label: string;
  /**
   * False when the room's top bar has run out of room and is shedding labels: the icon
   * and the `title` stay, so the button is still there and still says what it is on a
   * hover. Only the bar ever asks — the lobby's row has all the width it wants. See
   * TOP_BAR_DROP_ORDER in components/UI/room/TopBar.tsx.
   */
  showLabel?: boolean;
  /**
   * 'bar' for the room's top bar, whose buttons are 36px tall with a small
   * uppercase label; 'row' for the lobby's preview panel, whose buttons are the
   * taller, sentence-cased ones beside it. Two looks rather than two components,
   * for the reason components/UI/room/LobbyLink.tsx gives: the words, the icon and
   * the write are the one thing that must not drift between them.
   */
  look?: 'bar' | 'row';
  /**
   * Draw the prompt in the flow of the panel rather than floating over it. The lobby's
   * preview is a card with `overflow-hidden`, so a floating panel below its last row
   * would be clipped; the room's top bar floats over the canvas and has nothing to
   * clip it.
   */
  inFlow?: boolean;
  /** Called once the variant exists, before the navigation, so a host can re-read. */
  onStarted?: () => void;
  /**
   * How this host opens a line's room. The lobby passes its own `enterRoom`, which
   * submits the name form first; every other host omits it and lib/reviews/openLine is
   * used, which is what sets the room's entry guard. A plain <Link> is never right:
   * pages/RoomPage admits an arrival by its router state, so a link to the correct
   * address bounces back to the lobby.
   */
  onOpenLine?: (lineId: string | null) => void;
  'data-testid'?: string;
}

const StartVariant: React.FC<StartVariantProps> = ({
  reviewId,
  mayEdit,
  isMeetingHost,
  lineId = null,
  label,
  showLabel = true,
  look = 'bar',
  inFlow = false,
  onStarted,
  onOpenLine,
  'data-testid': testId = 'start-variant',
}) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);

  // Read when the panel opens, and not before: the newest meeting on this line is a
  // fact that changes while a review is being worked on, and a room that never starts
  // a variant should never ask for it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOrigin(null);
    void (async () => {
      // `listLines` rather than `resolveLine`: the lobby must not WRITE the main line
      // row as a side effect of somebody opening a popover, and a review with no line
      // rows has no meetings on one either — so "no line" and "no sessions" answer the
      // same thing here.
      const lines = await listLines(reviewId);
      const line = lineId
        ? lines.find((each) => each.id === lineId) ?? null
        : lines.find((each) => each.kind === 'main') ?? null;
      // The meeting this line starts from, which is the one the new room will open on:
      // its own newest meeting, or — for a variant that has never met — the meeting it
      // left. Asking `lastSessionOnLine` instead would say "the model as it is now" in
      // a variant's room that DOES have a meeting to leave from, and then start the
      // new variant from one anyway.
      const from = await lineOriginSession(line);
      if (cancelled) return;
      if (!from) {
        // No meeting to name, but the LINE is still known and still goes: the endpoint
        // writes it as parent_line_id, and a variant of a variant with no meetings
        // anywhere reads its model, its positions and its cards from its parent.
        setOrigin({ sessionId: null, lineId: line?.id ?? null, text: 'the model as it is now' });
        return;
      }
      // Labelled by the line the meeting is actually ON: a variant that has never met
      // leaves from a main-line meeting, and calling S3 "A3" would number it by a line
      // it was never held on.
      const onLine = lines.find((each) => each.id === from.lineId) ?? line;
      const when = shortDate(from.endedAt);
      const which = sessionLabel(onLine, from.seq) ?? (from.title || 'the last session');
      setOrigin({
        sessionId: from.id,
        lineId: onLine?.id ?? line?.id ?? null,
        text: when ? `${which} · ${when}` : which,
      });
    })();
    return () => { cancelled = true; };
  }, [open, reviewId, lineId]);

  const submit = useCallback(async () => {
    const wanted = name.trim();
    if (wanted === '' || busy) return;
    setBusy(true);
    setError(null);
    const result: LineActionResult = await exploreVariant(
      reviewId,
      { parentSessionId: origin?.sessionId ?? null, parentLineId: origin?.lineId ?? lineId },
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
    onStarted?.();
    if (onOpenLine) onOpenLine(result.line.id);
    else openLine(navigate, reviewId, result.line.id);
  }, [busy, isMeetingHost, lineId, name, navigate, onOpenLine, onStarted, origin, reviewId]);

  if (!mayEdit) return null;

  const prompt = (
    <div className="flex flex-col gap-2" data-testid="start-variant-panel">
      <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">
        Explore a variant
      </p>
      <div className="flex items-center gap-1.5">
        <input
          value={name}
          autoFocus
          maxLength={80}
          aria-label="Name this variant"
          data-testid="start-variant-field"
          placeholder="Steel hinge pin"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
            if (event.key === 'Escape' && !busy) setOpen(false);
          }}
          className={FIELD}
        />
        <button
          onClick={() => void submit()}
          disabled={busy || name.trim() === ''}
          data-testid="start-variant-go"
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
          <X size={12} />
        </button>
      </div>
      <p className="text-[11px] text-gray-600 leading-snug" data-testid="start-variant-origin">
        Starts from: {origin ? origin.text : '…'}
      </p>
      <p className="text-[10px] text-gray-400 leading-snug">
        It opens in its own room, on that model, with the cards that were still open.
      </p>
      {error && <p className="text-[10px] text-red-600 leading-snug" role="status">{error}</p>}
    </div>
  );

  return (
    // Closed, this is a compact button that sits in its host's row. Open and in flow,
    // the wrapper takes the whole row (`w-full` in a wrapping flex row is a line
    // break) so the prompt is not squeezed between two buttons — and `items-start`
    // keeps the button its own width instead of stretching it across the panel.
    <div
      className={clsx(
        inFlow && open ? 'w-full flex flex-col items-start gap-2' : 'shrink-0 relative',
      )}
    >
      <button
        onClick={() => { setOpen((value) => !value); setError(null); }}
        aria-expanded={open}
        data-testid={testId}
        title="Start a named variant of this design review, in its own room"
        className={clsx(
          'flex items-center gap-1.5 rounded-sm border transition-all pointer-events-auto',
          look === 'row' ? 'px-3 py-2 rounded-md text-[13px] font-semibold' : 'h-9 px-2',
          open
            ? 'bg-black text-white border-black'
            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-black',
        )}
      >
        <GitBranch size={look === 'row' ? 14 : 16} />
        {showLabel && (
          <span className={look === 'row' ? '' : 'text-[10px] font-bold uppercase tracking-wide'}>{label}</span>
        )}
      </button>

      {open && (
        inFlow ? (
          <div className="w-full rounded-md border border-gray-200 bg-white p-3">{prompt}</div>
        ) : (
          <div className="absolute top-10 left-0 z-50 w-[340px] max-w-[80vw] rounded-md border border-gray-200 bg-white p-3 shadow-lg pointer-events-auto">
            {prompt}
          </div>
        )
      )}
    </div>
  );
};

export default StartVariant;
