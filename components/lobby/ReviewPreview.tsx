// The preview panel: what one design review looks like from outside it.
//
// docs/plan/15-sessions-and-variants.md batch BO, from the sketch the user approved.
// A card in the grid is four facts; this is the rest of them, and it exists because the
// user's complaint was that the lobby gave no way to see inside a review before walking
// into it. What it shows is READ: the model, the whole session map, every meeting with
// who was in it and what it decided, and the minutes of the last one.
//
// WHAT IT WRITES is two different questions with two different answers. Changing the
// review — its name (batch BQ), its variants and where they are merged or dropped
// (batch BX) — is `can(role, 'editReview')` and belongs to its owners and editors. The
// two DELETES are `deleteReview`: the owner and this install's administrators, and not
// its editors. Both go through api/reviews/delete.ts, and every one of them asks INLINE
// rather than with window.confirm — a browser dialog cannot be styled to the panel that
// offered it, cannot be tested, and freezes the page behind it while it waits.
//
// "TURN IN 3D" is the one heavy thing on the page and it is lazy. The viewer pulls
// three.js, which is hundreds of kilobyles nobody wants for a list of reviews, so it is
// behind React.lazy and the chunk is fetched when — and only when — the button is
// pressed. The snapshot stays the default answer, which is why capturing it in the room
// (lib/reviews/thumbnail.ts) is worth a column of its own.
//
// ONE REVIEW'S DETAIL IS READ HERE, NOT IN THE GRID. lib/lobby/useLobbyData batches the
// summaries every card needs; the panel needs this review's revisions and its card
// titles too, which no other card wants. lib/reviews/useSessionMap already reads exactly
// those four things for one review in parallel, so the panel uses it rather than making
// the grid carry detail for sixty reviews to show one.

import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Box, Check, Pencil, X } from 'lucide-react';
import { clsx } from 'clsx';
import SessionMap, { summaryLines } from '../review/SessionMap';
import StartVariant from '../review/StartVariant';
import { VariantActions } from '../review/VariantActions';
import { Avatar } from './IdentityChip';
import PeopleSection from './PeopleSection';
import { useSessionMap } from '../../lib/reviews/useSessionMap';
import { openLine } from '../../lib/reviews/openLine';
import {
  MAIN_LINE_NAME,
  droppedLineReason,
  hiddenLineCount,
  lineLabelWithOrigin,
  lineStatusWord,
  mergedIntoLabel,
  orderedLines,
  sessionLabel,
  type ReviewLine,
} from '../../lib/reviews/lines';
import { deleteReview, deleteSession } from '../../lib/reviews/deleteClient';
import { renameCuration } from '../../lib/curationsRepo';
import { MAX_REVIEW_TITLE } from '../../lib/reviewSetupStore';
import { shortDate } from '../../lib/trackerContinuity';
import { AVATAR_COLORS } from '../../lib/identity';
import { peopleOf, variantCountOf, type LobbyReview } from '../../lib/lobby/useLobbyData';

/** Behind React.lazy so three.js stays out of the lobby's own chunk. See the header. */
const ReviewModelViewer = React.lazy(() => import('./ReviewModelViewer'));

const LABEL = 'font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest';
const BUTTON =
  'inline-flex items-center gap-1.5 px-3 py-2 rounded-md border text-[13px] font-semibold transition-colors disabled:opacity-50';

/**
 * A line the Lines list hides until asked for.
 *
 * The same question `hiddenLineCount` answers, spelled here rather than inferred from
 * `lineStatusWord`, because the number in the toggle's label and the rows it reveals
 * have to be the same set: a "Show dropped (2)" that produced three greyed rows is a
 * list that does not do what it says. A dropped MAIN line is not in it either — a review
 * whose own history was closed has no lobby row to hide, and the map is where that shows.
 */
function isDroppedLine(line: ReviewLine): boolean {
  return line.kind === 'variant' && line.status === 'dropped';
}

export interface ReviewPreviewProps {
  review: LobbyReview;
  /**
   * True when this review is the one an invitation link named. Join becomes the primary
   * button and "Open room" is not offered as well: the person arrived to enter a meeting,
   * and two buttons that both enter it is a choice with one answer.
   */
  invited?: boolean;
  /** Whether this person may delete this review and its sessions. Decided by the caller. */
  mayDelete: boolean;
  /**
   * Whether this person may CHANGE this review — `can(role, 'editReview')` in
   * lib/reviews/roles.ts, decided by the caller the way `mayDelete` is.
   *
   * Narrower than `mayDelete` on one side and wider on the other, and both differences
   * are the table's: an editor may name the review and start a variant of it but may
   * not delete it, and on a deployment with no accounts the person who got past the
   * front door may do all three. Batch BQ, which is what put a name field and a
   * "+ Variant" on this panel.
   */
  mayEdit?: boolean;
  /** Read on a deployment with no accounts, where there is no token to verify. */
  isMeetingHost?: boolean;
  /**
   * Whether this install has accounts at all — `identityRequired(publicIdentityOf(config))`
   * in the page, and the same fact the room reads.
   *
   * False on the default 'none' install, where api/reviews/members.ts answers 404
   * because there is no roster to manage and nothing a membership row could be keyed
   * on. The People section is absent there for exactly the reason the room's People
   * tab is, and the meeting host edits freely as they always did.
   */
  accountsOn?: boolean;
  onOpen: () => void;
  /**
   * How this host opens one line's room — `lineId` null for the main line.
   *
   * Every "open a line" in this panel goes through it: the Lines list, the session map
   * drawn above it, and the panel that has just started a variant and wants to stand in
   * it. The lobby passes its own `enterRoom`, which writes this browser's name first;
   * omitted, lib/reviews/openLine is used, which does the same for everybody else and
   * sends a browser with no name to the lobby to get one.
   *
   * A plain <Link to={roomPath(…)}> is never the answer, however convenient it looks
   * here: pages/RoomPage admits an arrival by its router state or by the mark openLine
   * leaves in sessionStorage, and a link carries neither — so it navigates to exactly
   * the right address and is then bounced straight back to the lobby. That bounce is
   * what "it is not possible to open variants from the lobby" actually was.
   */
  onOpenLine?: (lineId: string | null) => void;
  /** The review is gone; the caller drops it from the grid and clears the panel. */
  onDeleted: () => void;
  /** A session was deleted; the caller re-reads the grid's summaries. */
  onChanged: () => void;
}

/** An inline "are you sure", which is the only confirmation this panel ever shows. */
const InlineConfirm: React.FC<{
  question: string;
  busy: boolean;
  busyWord: string;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ question, busy, busyWord, error, onConfirm, onCancel }) => (
  <div className="flex flex-col gap-2" data-testid="inline-confirm">
    <p className="text-[11px] text-gray-700 leading-snug">{question}</p>
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        onClick={onConfirm}
        disabled={busy}
        className={clsx(BUTTON, 'px-2.5 py-1 text-[11px] border-red-600 bg-red-600 text-white hover:bg-red-700')}
      >
        {busy ? busyWord : 'Delete'}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        className={clsx(BUTTON, 'px-2.5 py-1 text-[11px] border-gray-200 text-gray-400 bg-white hover:text-black')}
      >
        Cancel
      </button>
    </div>
    {error && <p className="text-[10px] text-red-600 leading-snug" role="status">{error}</p>}
  </div>
);

/** One meeting, as a row: its label, when it was held, who was in it, its cards, and a ✕. */
const SessionRow: React.FC<{
  reviewId: string;
  sessionId: string;
  label: string;
  when: string;
  people: string;
  cards: number;
  mayDelete: boolean;
  isMeetingHost: boolean;
  onDeleted: () => void;
}> = ({ reviewId, sessionId, label, when, people, cards, mayDelete, isMeetingHost, onDeleted }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteSession(reviewId, sessionId, { isMeetingHost });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That session could not be deleted.');
      return;
    }
    setConfirming(false);
    onDeleted();
  };

  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-[11px] font-bold text-gray-900 shrink-0">{label}</span>
        <span className="flex-1 min-w-0 truncate text-gray-500">
          {when}
          {people ? ` · ${people}` : ''}
          {` · ${cards} ${cards === 1 ? 'card' : 'cards'}`}
        </span>
        {mayDelete && !confirming && (
          <button
            onClick={() => { setConfirming(true); setError(null); }}
            data-testid={`delete-session-${label}`}
            title="Delete this session and the cards raised in it"
            aria-label={`Delete session ${label}`}
            className="w-[22px] h-[22px] shrink-0 grid place-items-center rounded border border-gray-200 bg-white text-gray-400 hover:border-red-300 hover:text-red-600 transition-colors"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {confirming && (
        <InlineConfirm
          question={`Delete ${label}${cards > 0 ? ` and its ${cards} ${cards === 1 ? 'card' : 'cards'}` : ''}? This cannot be undone.`}
          busy={busy}
          busyWord="Deleting…"
          error={error}
          onConfirm={() => void run()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </li>
  );
};

const ReviewPreview: React.FC<ReviewPreviewProps> = ({
  review,
  invited = false,
  mayDelete,
  mayEdit = false,
  isMeetingHost = false,
  accountsOn = false,
  onOpen,
  onOpenLine,
  onDeleted,
  onChanged,
}) => {
  const navigate = useNavigate();
  const map = useSessionMap(review.id);
  const [turned, setTurned] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Naming the review, inline in its own heading (batch BQ).
  const [renaming, setRenaming] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  // Whether the Lines list is showing the variants that were dropped. See the list.
  const [showDropped, setShowDropped] = useState(false);

  // Another review selected: the 3D viewer of the last one must go, along with any
  // confirmation that was open on it. Unmounting is what disposes its geometry.
  useEffect(() => {
    setTurned(false);
    setConfirming(false);
    setError(null);
    setRenaming(false);
    setNameError(null);
    setShowDropped(false);
  }, [review.id]);

  // The grid's summaries are already in hand, so they stand in until this review's own
  // detail arrives. Without that the panel would flash "No sessions recorded" for every
  // review that has met, which reads as a lost history rather than as a read in flight.
  const lines = map.lines.length > 0 ? map.lines : review.lines;
  const sessions = map.sessions.length > 0 ? map.sessions : review.sessions;

  /**
   * Open one of this review's lines, the way its host opens rooms.
   *
   * One function for all three places in this panel that open a line, because they must
   * not disagree: a Lines row that went through the lobby's name form and a map panel
   * that navigated by itself would answer the same press differently on a browser with
   * no name yet — one would ask, the other would bounce.
   */
  const openAt = useCallback(
    (lineId: string | null) => {
      if (onOpenLine) onOpenLine(lineId);
      else openLine(navigate, review.id, lineId);
    },
    [navigate, onOpenLine, review.id],
  );

  const people = useMemo(() => peopleOf({ sessions }), [sessions]);
  const variants = useMemo(() => variantCountOf({ lines }), [lines]);

  const cardsIn = (sessionId: string): number => map.cards.filter((card) => card.sessionId === sessionId).length;

  // Newest first: the last meeting is the one worth reading, and the minutes below are
  // its. The map above draws them oldest first, which is the order a history reads in.
  const rows = useMemo(() => [...sessions].reverse(), [sessions]);
  const latest = rows[0] ?? null;

  const lineOf = (lineId: string | null) => lines.find((line) => line.id === lineId) ?? null;

  // What the Lines list draws: everything still being explored and everything merged,
  // plus the dropped ones only once they have been asked for. See the list itself.
  const dropped = hiddenLineCount(lines);
  const visibleLines = useMemo(
    () => orderedLines(lines).filter((line) => showDropped || !isDroppedLine(line)),
    [lines, showDropped],
  );

  /**
   * How many meetings a line has held.
   *
   * A session with no `line_id` is the main line's, which is where the map above
   * draws it and where the backfill in docs/supabase-schema.sql puts it.
   */
  const countOnLine = (line: ReviewLine): number =>
    sessions.filter(
      (session) => session.lineId === line.id || (line.kind === 'main' && session.lineId === null),
    ).length;

  const runDelete = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteReview(review.id, { isMeetingHost });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That design review could not be deleted.');
      return;
    }
    onDeleted();
  };

  const title = review.title.trim() === '' ? `Design review ${review.id.slice(0, 8)}` : review.title;

  /**
   * Name this design review.
   *
   * ONE COLUMN, through lib/curationsRepo.renameCuration, and not a whole-draft save:
   * this panel holds a SUMMARY of the review and not its viewpoints, pins and agenda,
   * and upserting the row from a summary would empty every field it never read. A
   * meeting in progress in this review keeps its own write path — RoomPage's
   * save-on-local-edit — and the two cannot disagree about anything but the name.
   */
  const saveName = async () => {
    const wanted = nameValue.trim().slice(0, MAX_REVIEW_TITLE);
    setRenaming(false);
    setNameError(null);
    // An empty field keeps the name the review has: pressing Enter in a field nobody
    // filled in is not a decision to call it nothing.
    if (wanted === '' || wanted === review.title.trim()) return;
    setNameBusy(true);
    const result = await renameCuration(review.id, wanted);
    setNameBusy(false);
    if (!result.ok) {
      setNameError(result.error ?? 'That name could not be saved.');
      return;
    }
    // The card in the grid and this heading both read the name out of the grid's rows,
    // so the re-read is what makes the two agree.
    onChanged();
  };

  return (
    <aside
      aria-label="Preview"
      data-testid="review-preview"
      className="rounded-lg border border-gray-200 bg-white overflow-hidden"
    >
      {/* Heading */}
      <div className="flex flex-col gap-1.5 px-4 py-3.5 border-b border-gray-100">
        <p className={LABEL}>Design review</p>
        <h2 className="text-[17px] font-semibold text-gray-900 leading-snug [text-wrap:balance]" data-testid="preview-title">
          {renaming ? (
            <span className="flex items-center gap-1.5">
              <input
                value={nameValue}
                autoFocus
                disabled={nameBusy}
                maxLength={MAX_REVIEW_TITLE}
                aria-label="Name this design review"
                data-testid="preview-title-field"
                placeholder="e.g. Door hinge, rev C"
                onChange={(event) => setNameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveName();
                  if (event.key === 'Escape' && !nameBusy) setRenaming(false);
                }}
                className="flex-1 min-w-0 rounded border border-gray-300 px-2 py-1 text-[14px] font-semibold text-gray-900 outline-none focus:ring-1 focus:ring-black"
              />
              <button
                onClick={() => void saveName()}
                disabled={nameBusy}
                data-testid="preview-title-save"
                title="Save this name"
                aria-label="Save this name"
                className="w-7 h-7 shrink-0 grid place-items-center rounded border border-black bg-black text-white hover:bg-gray-800 transition-colors disabled:opacity-40"
              >
                <Check size={13} />
              </button>
              <button
                onClick={() => setRenaming(false)}
                disabled={nameBusy}
                title="Cancel"
                aria-label="Cancel"
                className="w-7 h-7 shrink-0 grid place-items-center rounded border border-gray-200 text-gray-400 hover:text-black transition-colors disabled:opacity-40"
              >
                <X size={13} />
              </button>
            </span>
          ) : mayEdit ? (
            /* The name is a button rather than a pencil beside it: the whole point of
               batch BQ is that naming a review is something a person looks for, and a
               control you have to notice a 12px icon to find is not one. */
            <button
              onClick={() => { setNameValue(review.title); setNameError(null); setRenaming(true); }}
              disabled={nameBusy}
              data-testid="preview-title-edit"
              title="Rename this design review"
              className="group flex items-center gap-1.5 text-left"
            >
              <span className="min-w-0">{title}</span>
              <Pencil size={13} className="shrink-0 text-gray-300 group-hover:text-gray-600 transition-colors" />
            </button>
          ) : (
            title
          )}
        </h2>
        {nameError && <p className="text-[10px] text-red-600 leading-snug" role="status">{nameError}</p>}
        <div className="flex items-center gap-2 mt-0.5">
          {/* The names this review's meetings recorded. The colours are picked by
              position because a name in a meeting's attendee list has no colour stored
              with it — this is decoration, and stable decoration, not an identity. */}
          <div className="flex items-center">
            {people.names.slice(0, 5).map((name, index) => (
              <span key={name} className={index === 0 ? '' : '-ml-1.5'}>
                <Avatar name={name} color={AVATAR_COLORS[index % AVATAR_COLORS.length]} size={22} />
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            {people.count} {people.count === 1 ? 'person' : 'people'} · {sessions.length}{' '}
            {sessions.length === 1 ? 'session' : 'sessions'}
            {variants > 0 && ` · ${variants} ${variants === 1 ? 'variant' : 'variants'}`}
          </p>
        </div>
      </div>

      {/* WHO IS ON IT, and who else may be — batch BW.

          Under the heading rather than down with the sessions because it is a fact
          about the review and not about one meeting, and because the person deciding
          whether to invite a colleague is reading the review's name and not its
          history. The avatars above count the names this review's MEETINGS recorded;
          this counts its roster, and the two are different sets — somebody added
          here who has never met is on the review and in no attendee list.

          Drawn for the people api/reviews/members.ts lets read a roster, which is
          the same `can(role, 'editReview')` the panel already answers as `mayEdit`,
          and only on an install with accounts at all — see the `accountsOn` prop. */}
      {accountsOn && mayEdit && <PeopleSection reviewId={review.id} onChanged={onChanged} />}

      {/* The model: the snapshot, or the live viewer once "Turn in 3D" is pressed. */}
      <div className="relative border-b border-gray-100 bg-gradient-to-b from-[#f7f8fa] to-[#e9ecf1]" style={{ aspectRatio: '16 / 9' }}>
        {turned ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 grid place-items-center">
                <p className="font-mono text-[10px] uppercase tracking-widest text-gray-400 animate-pulse">
                  Loading the model…
                </p>
              </div>
            }
          >
            <ReviewModelViewer reviewId={review.id} className="absolute inset-0" />
          </Suspense>
        ) : review.thumbnail ? (
          <img
            src={review.thumbnail}
            alt="The model this design review is looking at"
            className="absolute inset-0 w-full h-full object-cover"
            data-testid="preview-thumbnail"
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center px-4" data-testid="preview-placeholder">
            <p className="font-mono text-[10px] uppercase tracking-widest text-gray-400 text-center truncate w-full">
              {review.modelName ?? 'No model yet'}
            </p>
          </div>
        )}
        <button
          onClick={() => setTurned((value) => !value)}
          data-testid="turn-in-3d"
          aria-pressed={turned}
          className={clsx(
            'absolute bottom-2 right-2 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[10px] font-bold uppercase tracking-wide transition-colors',
            turned
              ? 'bg-black border-black text-white'
              : 'bg-white/95 border-gray-200 text-gray-600 hover:border-gray-400 hover:text-black',
          )}
        >
          <Box size={12} />
          {turned ? 'Snapshot' : 'Turn in 3D'}
        </button>
      </div>

      {/* The whole session map, which is the same component the room and the tracker show.
          `mayDelete` is FALSE on purpose. SessionMap carries its own "Delete review" and
          per-stop session deletes, and both ask with window.confirm — the room and the
          tracker want them because the map is the only control surface there. Here it is
          a DIAGRAM in a panel that already has both deletes, inline, under its own list
          of sessions: two ways to remove the same review, one of them a browser dialog
          that cannot be styled to this panel and cannot be tested, is one too many.
          `compact` for the same reason it is a diagram: this panel has already named the
          review, counted its sessions and drawn its own card, so the map drops its
          heading and its chrome and keeps its key. */}
      <div className="border-b border-gray-100 px-3 py-2" data-testid="preview-session-map">
        <SessionMap
          reviewTitle={title}
          lines={lines}
          sessions={sessions}
          revisions={map.revisions}
          cards={map.cards}
          reviewId={review.id}
          mayDelete={false}
          compact
          // Its line panel's "Open this line's room" goes the same way the list below
          // does, so this page's name form is submitted first. Without it the map opens
          // the room by itself, and on a browser with no name yet that is a bounce back
          // to the page the button was pressed on. See `onOpenLine` above.
          onOpenLine={openAt}
          // A meeting's transcript is read for the one stop somebody clicks, so the
          // reader comes down with the rest of the map's data rather than the map
          // reaching for the database itself.
          readTranscript={map.readTranscript}
          onChanged={() => { map.refresh(); onChanged(); }}
          emptyMessage="No sessions recorded in this design review yet."
          showDropped={showDropped}
          onShowDroppedChange={setShowDropped}
        />
      </div>

      {/* Every line of this review, and the way into each — batch BV, generalised by
          batch BX.

          The map above draws the lines, but a drawing is not a way in, and the list
          below this one is of SESSIONS: a variant started before anybody met had no row
          in it, so this panel counted the variant in its header ("0 sessions · 1
          variant") and then offered no way to open it. That was the first half of the
          report this batch came from — the variant's own room had kept every change,
          and from the lobby it did not exist.

          THE WAY IN IS A BUTTON AND NOT A LINK. It was a link, it looked like a link,
          and pressing it did nothing at all: `roomPath` builds the right address, and
          pages/RoomPage still turns away an arrival that comes with neither `fromLobby`
          in its router state nor this review in `sessionStorage.vp_enteredRoom` — which
          is every arrival a bare <Link> makes. That silent bounce was the second half of
          the report ("it is not possible to open variants from the lobby"), and it is
          why the row calls the host's opener instead of naming an address.

          WHAT A ROW OFFERS depends on what the line is:

            * Still being explored: Open, and — for a variant — its own "+ Variant" and
              its own "Merge into…" and "Drop variant". Those three are the rest of the
              report. A variant of a variant is the only way to answer a second question
              about a side line without losing the first answer, and a merge that could
              only ever go into the main line left two variants that turned out to agree
              with no way to be brought together.
            * Merged: no way in, and the line it went into with the date. Its meetings
              continue there, so a row that offered to open it would open a room nobody
              is in any more.
            * Dropped: no way in, and the reason the meeting gave. Hidden until asked
              for, because a dropped line is a record and not a choice, and a list where
              the finished ones outnumber the live ones stops being a way in at all.

          Rendered only where the review has lines at all, so an ad-hoc room and an
          install with no database show no empty heading. */}
      {lines.length > 0 && (
        <div className="flex flex-col gap-2 px-4 py-3 border-b border-gray-100" data-testid="preview-lines">
          <div className="flex items-center gap-2">
            <p className={LABEL}>Lines</p>
            {dropped > 0 && (
              <button
                onClick={() => setShowDropped((value) => !value)}
                aria-pressed={showDropped}
                data-testid="show-dropped"
                title={showDropped ? 'Hide the variants that were dropped' : 'Show the variants that were dropped'}
                className="ml-auto font-mono text-[10px] font-semibold text-gray-500 hover:text-black transition-colors"
              >
                {showDropped ? 'Hide dropped' : `Show dropped (${dropped})`}
              </button>
            )}
          </div>
          <ul className="flex flex-col gap-1.5">
            {visibleLines.map((line) => {
              const closed = lineStatusWord(line);
              const held = countOnLine(line);
              const live = closed === null;
              const variantRow = line.kind === 'variant';
              const name = variantRow
                ? lineLabelWithOrigin(lines, line) ?? 'Variant'
                : MAIN_LINE_NAME;
              // What became of a line nobody is meeting on any more. Both halves are
              // null on an install whose database predates the columns that hold them,
              // and the row then says the one thing it does know — which is still true,
              // and still better than a greyed name with no explanation beside it.
              const went = mergedIntoLabel(lines, line);
              const why = droppedLineReason(line);
              const fate =
                closed === 'adopted'
                  ? went ?? 'This variant was adopted.'
                  : closed === 'dropped'
                    ? why
                      ? `This variant was dropped: ${why}`
                      : 'This variant was dropped.'
                    : null;
              return (
                <li
                  key={line.id}
                  data-testid="preview-line"
                  data-line={line.id}
                  data-status={closed ?? 'active'}
                  className={clsx(
                    'flex flex-col gap-1',
                    closed && 'opacity-60',
                    // Dashed the way the map draws a dropped line's branch, so the two
                    // say the same thing about it in the same panel.
                    closed === 'dropped' && 'border-l-2 border-dashed border-gray-300 pl-2',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="flex-1 min-w-0 truncate text-gray-700" title={name}>
                      {name}
                      {variantRow && live && <span className="text-gray-400"> · active</span>}
                      <span className="text-gray-400">
                        {' · '}{held} {held === 1 ? 'session' : 'sessions'}
                      </span>
                    </span>
                    {live && (
                      <button
                        onClick={() => openAt(variantRow ? line.id : null)}
                        data-testid={variantRow ? 'open-variant' : 'open-main-line'}
                        title={variantRow ? 'Open this variant’s room' : 'Open the main line’s room'}
                        className={clsx(
                          BUTTON,
                          'px-2.5 py-1 text-[11px] bg-white border-gray-200 text-gray-600 hover:border-gray-400 hover:text-black shrink-0',
                        )}
                      >
                        Open
                      </button>
                    )}
                    {/* Its own "+ Variant", on the variant's own row. The main line's
                        row has none because the button in the actions list below
                        already explores from it, and two buttons that start the same
                        thing are a choice with one answer. */}
                    {live && variantRow && mayEdit && (
                      <StartVariant
                        reviewId={review.id}
                        lineId={line.id}
                        mayEdit={mayEdit}
                        isMeetingHost={isMeetingHost}
                        label="+ Variant"
                        look="row"
                        inFlow
                        data-testid="line-row-variant"
                        onOpenLine={openAt}
                        onStarted={() => { map.refresh(); onChanged(); }}
                      />
                    )}
                  </div>
                  {fate && (
                    <p className="text-[11px] text-gray-500 leading-snug" data-testid="line-fate">{fate}</p>
                  )}
                  {/* Where a merge or a drop is decided from the lobby, for the same
                      people the room offers them to. `lines` comes down with it so the
                      chooser lists the review's live lines from the rows this panel
                      has already read rather than asking for them a second time. */}
                  {live && variantRow && mayEdit && (
                    <VariantActions
                      reviewId={review.id}
                      variant={line}
                      lines={lines}
                      mayEdit={mayEdit}
                      isMeetingHost={isMeetingHost}
                      onOpenLine={openAt}
                      onChanged={() => { map.refresh(); onChanged(); }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Every meeting, newest first, with a delete for whoever may delete the review. */}
      <div className="flex flex-col gap-2 px-4 py-3 border-b border-gray-100">
        <p className={LABEL}>Sessions</p>
        {rows.length === 0 ? (
          <p className="text-[11px] font-mono italic text-gray-300">No sessions yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="preview-session-rows">
            {rows.map((session) => {
              const label = sessionLabel(lineOf(session.lineId), session.seq) ?? shortDate(session.endedAt) ?? 'Session';
              const names = session.attendeeNames ?? [];
              return (
                <SessionRow
                  key={session.id}
                  reviewId={review.id}
                  sessionId={session.id}
                  label={label}
                  when={shortDate(session.endedAt) ?? session.title}
                  people={names.length > 0 ? names.join(', ') : `${session.participantCount} in the room`}
                  cards={cardsIn(session.id)}
                  mayDelete={mayDelete}
                  isMeetingHost={isMeetingHost}
                  onDeleted={() => { map.refresh(); onChanged(); }}
                />
              );
            })}
          </ul>
        )}
      </div>

      {/* The last meeting's minutes, drawn the way the room's own session panel draws
          them: model output, so every line is React text and only the two shapes the
          minutes use are recognised. */}
      {latest?.summary && (
        <div className="flex flex-col gap-1.5 px-4 py-3 border-b border-gray-100">
          <p className={LABEL}>
            Last minutes · {sessionLabel(lineOf(latest.lineId), latest.seq) ?? shortDate(latest.endedAt) ?? 'session'}
          </p>
          <div className="text-[11px] text-gray-600 leading-relaxed bg-gray-50 border border-gray-200 rounded-md px-2.5 py-2 max-h-44 overflow-y-auto custom-scrollbar" data-testid="preview-minutes">
            {summaryLines(latest.summary).map((line, index) => (
              line.kind === 'heading' ? (
                <p key={index} className="font-semibold text-gray-800 mt-2 first:mt-0">{line.text}</p>
              ) : line.kind === 'bullet' ? (
                <p key={index} className="pl-3 -indent-2">• {line.text}</p>
              ) : line.text === '' ? null : (
                <p key={index}>{line.text}</p>
              )
            ))}
          </div>
        </div>
      )}

      {/* The way in, and the way out. */}
      <div className="flex items-center gap-2 flex-wrap px-4 py-3">
        <button
          onClick={onOpen}
          data-testid={invited ? 'preview-join' : 'preview-open-room'}
          className={clsx(BUTTON, 'bg-black border-black text-white hover:bg-gray-800')}
        >
          {invited ? 'Join' : 'Open room'}
        </button>
        {/* Start a variant from the lobby, for the same people the room's top bar
            offers it to and through the same write. Somebody reading a review from
            outside it is exactly the person who decides it needs a second line, and
            making them enter the room, open Sessions and click a meeting to find the
            action is why nobody found it (batch BQ). */}
        {mayEdit && (
          <StartVariant
            reviewId={review.id}
            mayEdit={mayEdit}
            isMeetingHost={isMeetingHost}
            label="+ Variant"
            look="row"
            inFlow
            data-testid="preview-variant"
            onOpenLine={openAt}
            // The panel's own read as well as the grid's: the Lines list above draws
            // `map.lines` when it has any, so a grid re-read on its own would leave the
            // variant that was just started out of the very list that offers to open it.
            onStarted={() => { map.refresh(); onChanged(); }}
          />
        )}
        {/* Filtered to this review: the tracker reads ?review= the way it reads
            ?session=, and a card on the map already links in with both. */}
        <Link
          to={`/tracker?review=${review.id}`}
          data-testid="preview-tracker"
          className={clsx(BUTTON, 'bg-white border-gray-200 text-gray-600 hover:border-gray-400 hover:text-black')}
        >
          Tracker
        </Link>

        {mayDelete && (
          <div className="ml-auto">
            {confirming ? (
              <InlineConfirm
                question={`Delete this design review? Its ${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}, the cards raised in them and its lines all go. This cannot be undone.`}
                busy={busy}
                busyWord="Deleting…"
                error={error}
                onConfirm={() => void runDelete()}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              <button
                onClick={() => { setConfirming(true); setError(null); }}
                data-testid="delete-review"
                className={clsx(BUTTON, 'bg-white border-red-200 text-red-700 hover:border-red-400')}
              >
                Delete review
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};

export default ReviewPreview;
