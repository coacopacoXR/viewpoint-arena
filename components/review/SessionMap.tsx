// The session map: every meeting of one design review, drawn as the review's own
// history rather than listed as rows.
//
// docs/plan/15-sessions-and-variants.md batch BK, from the "Review Sessions Map"
// sketch the user approved. The main line is a horizontal line of numbered stops;
// a variant leaves from the session it was started at, runs along below, and either
// rejoins the main line with a green stop (adopted) or stops where it was and goes
// grey and dashed (dropped). A stop is a meeting: its number, its date and the
// model revision(s) that were on screen. Clicking one opens the panel below with
// who attended, what was on screen, the minutes if any were stored, and its cards.
//
// Plain SVG and HTML, no charting library: the drawing is four straight lines and a
// circle per meeting, a dependency would be bigger than the thing it draws, and the
// app's light style is easier to keep in hand-written markup. The whole map scrolls
// sideways inside its container, because a review that has met twenty times is
// twenty stops wide and squashing them to fit would make the labels unreadable —
// and unreadable is worse than a scrollbar.
//
// THE WORDS ARE THE SPEC. This is a "Design review" with a "Main line" and
// "Variant A", and these are "Sessions". Branch, fork and commit do not appear
// anywhere in this file, in a label, in a title attribute or in a comment a user
// could be shown: the people reading this map are hardware engineers and the plan is
// explicit that the programming metaphor must not show through. "Merged" does, from
// batch BX, because it is the user's own word for taking one line into another
// (2026-09-26: asked for a variant that could be merged with another variant, they
// said "merged") — and the map has to name the line a green return goes INTO, which
// is no longer always the main one.
//
// Nothing here reads the database. The map is given lines, sessions, revisions and
// cards and draws them, so it renders the same in the room, in the tracker and in a
// test with fixture data; lib/reviews/useSessionMap.ts is the half that fetches.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Download, Trash2, X } from 'lucide-react';
import {
  downloadTranscript,
  formatTranscriptDate,
  transcriptFilename,
  transcriptLineCount,
  transcriptToText,
  type TranscriptRow,
} from '../../lib/capture/transcriptText';
import {
  MAIN_LINE_NAME,
  droppedLineReason,
  hiddenLineCount,
  isMainLine,
  lineLabel,
  lineLabelWithOrigin,
  lineStatusWord,
  mainLineOf,
  mergeTargetWord,
  mergedIntoLabel,
  orderedLines,
  sessionLabel,
  shortLineLabel,
  variantLetter,
  type ReviewLine,
} from '../../lib/reviews/lines';
import { openLine } from '../../lib/reviews/openLine';
import type { LineSession, SessionCardRef } from '../../lib/reviews/linesRepo';
import { deleteSession } from '../../lib/reviews/deleteClient';
import type { ModelRevision } from '../../lib/reviews/revisionsRepo';
import { revisionLabel, shortDate } from '../../lib/trackerContinuity';
import { ExploreVariantButton, VariantActions } from './VariantActions';

/** Stop spacing along a line. Wide enough for a date and two revision letters. */
const STEP = 140;
/** Vertical distance between the main line and each variant below it. */
const ROW_GAP = 96;
const PAD_X = 48;
const PAD_TOP = 40;
const PAD_BOTTOM = 34;
const MAIN_Y = PAD_TOP;
const STOP_R = 14;

const INK = '#111827';
const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const ADOPTED = '#059669';
const DROPPED = '#d1d5db';
const VARIANT_INK = '#7c3aed';

/** One meeting, placed. */
export interface MapStop {
  session: LineSession;
  /** The line it is on, or null for a meeting recorded before lines existed. */
  line: ReviewLine | null;
  x: number;
  y: number;
  /** "S3" / "A2", or the date when the session has no number. */
  label: string;
  date: string;
  /** "Rev B · Rev C" — what was on screen, or '' when nothing was stored. */
  revisions: string;
  cards: number;
  /** A dropped variant's stop: greyed, dashed, and still there for the record. */
  dropped: boolean;
  /** The green stop an adopted variant rejoins the main line at. Not a meeting. */
  rejoin: boolean;
  /**
   * The hollow stop at the head of a main line that has never met. Not a meeting.
   *
   * Batch BV. It is where the line's first meeting will leave from, and — for a
   * variant started before anybody met — where its branch already leaves from, so
   * drawing it is what makes such a review a picture rather than a sentence. Drawn
   * only for a review that HAS lines: one that has none has nothing to start, and
   * its map is still the empty message.
   */
  start?: boolean;
  /**
   * The hollow stop a variant with no meetings ends at, labelled with its letter.
   * Not a meeting.
   *
   * Batch BV, and the reason for it is a report from live testing: a variant started
   * before any meeting, explored, moved a model in and left, was invisible everywhere
   * outside its own room — the map said "No sessions recorded", so the person who had
   * just spent twenty minutes in it read that as "the variant was not saved". Its
   * branch was already drawn; this is the end of it, and it is a thing to click.
   */
  variantEnd?: boolean;
}

/** A line drawn between two points. */
export interface MapEdge {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** 'along' one line, 'leave' the main line for a variant, 'rejoin' it back. */
  kind: 'along' | 'leave' | 'rejoin';
  dashed: boolean;
  colour: string;
  /**
   * The line this piece of drawing belongs to, when it is a VARIANT's. Batch BV: a
   * variant's line is clickable and opens that line's panel, because a variant nobody
   * has met on has no stops to click and its branch is the only thing on the map that
   * says it exists.
   *
   * Left off the main line's own edges — its stops are its meetings, and its start is
   * the one marker that opens its panel — and off the green edge an adopted variant
   * rejoins along, so the whole of that return stays the inert moment it describes.
   */
  lineId?: string;
}

export interface SessionMapLayout {
  stops: MapStop[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** One row per line drawn, so the map can name them at the left edge. */
  rows: Array<{ id: string; label: string; title: string; y: number; colour: string; dropped: boolean }>;
}

/** The revisions a meeting had on screen, as the labels the app uses for them. */
function revisionsText(session: LineSession, revisions: readonly ModelRevision[]): string {
  if (session.revisionIds.length === 0) return '';
  const labels: string[] = [];
  for (const id of session.revisionIds) {
    const row = revisions.find((revision) => revision.id === id);
    const label = revisionLabel(row ? { revision: row.revision } : null);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join(' · ');
}

/**
 * Meetings in the order they happened: by their number on their own line, then by
 * when they ended, then by id so that two recorded in the same second still draw in
 * the same order every render.
 *
 * A meeting with no number — recorded before `seq` existed — sorts last rather than
 * first, because a row that put an unnumbered meeting before S1 would say the review
 * met in an order it did not.
 */
function inSessionOrder(list: readonly LineSession[]): LineSession[] {
  return [...list].sort((a, b) => {
    const sa = a.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return a.endedAt.localeCompare(b.endedAt) || a.id.localeCompare(b.id);
  });
}

/**
 * One row of the drawing, and what the rows that leave from it or come back to it
 * need to know about it.
 *
 * The map is not a list of independent rows: a variant leaves from a meeting on
 * ANOTHER row, and a merged one comes back onto the row of whichever line took it in,
 * which is not necessarily the one above it. Both need the row's own meetings to have
 * been placed first, which is what this holds.
 */
interface RowPlacement {
  /** The line drawn on it, or null for a review whose lines have not been read. */
  line: ReviewLine | null;
  y: number;
  /** The meetings on this row, in the order they happened. Not the row's markers. */
  meetings: MapStop[];
  /**
   * Where the row begins: the x of its first meeting, or of the marker standing in
   * for one when it has never met. A variant with no meeting to leave from leaves from
   * here, because it did not leave from a meeting at all and drawing it from the end
   * of the row would say it continues work that happened after it was started.
   */
  startX: number;
  /** The rightmost thing drawn on the row before any green return is placed on it. */
  endX: number;
  /** How many green returns have been placed on it, so two do not land on top of each other. */
  returns: number;
}

/**
 * Where the map puts everything.
 *
 * Pure, and the interesting work: the main line's stops are numbered in the order
 * they happened, each variant leaves from the session it was started at and runs to
 * the right of it on its own row, and a merged variant's line comes back to a green
 * stop on the row of the line that took it in. A variant whose parent session has
 * been deleted leaves from that row's last stop instead, because a side line floating
 * in mid-air with nothing attached to it would look like a bug rather than like a gap
 * in the record.
 *
 * A variant can be started from ANOTHER variant and merged into any line still being
 * explored, so a row's neighbours are not fixed: rows are ordered parent first, which
 * puts a variant under the line it was started from, and the green returns are placed
 * in a second pass once every row knows where its own meetings landed — a return onto
 * a row drawn below the one it leaves would otherwise have nowhere to be measured
 * from. A variant whose parent line is not among the lines it was given leaves from
 * the main row, which is the only row the drawing can honestly attach it to.
 *
 * Sessions with no line — recorded before this batch, on an install the backfill has
 * not reached — go on the main row, which is where the backfill in
 * docs/supabase-schema.sql puts them too.
 */
export function layoutSessionMap(
  lines: readonly ReviewLine[],
  sessions: readonly LineSession[],
  revisions: readonly ModelRevision[],
  cards: readonly SessionCardRef[],
): SessionMapLayout {
  const ordered = orderedLines(lines);
  const main = mainLineOf(ordered);
  const variants = ordered.filter((line) => line.kind === 'variant');

  const bySession = new Map<string, LineSession>();
  for (const session of sessions) bySession.set(session.id, session);
  const byId = new Map<string, ReviewLine>();
  for (const line of ordered) byId.set(line.id, line);

  const onMain = inSessionOrder(
    sessions.filter((s) => !main || s.lineId === main.id || s.lineId === null),
  );

  const stops: MapStop[] = [];
  const edges: MapEdge[] = [];
  const rows: SessionMapLayout['rows'] = [];

  const stopFor = (session: LineSession, line: ReviewLine | null, x: number, y: number): MapStop => {
    const dropped = line?.status === 'dropped';
    return {
      session,
      line,
      x,
      y,
      label: sessionLabel(line, session.seq) ?? shortDate(session.endedAt) ?? 'Session',
      date: shortDate(session.endedAt) ?? '',
      revisions: revisionsText(session, revisions),
      cards: cards.filter((card) => card.sessionId === session.id).length,
      dropped,
      rejoin: false,
    };
  };

  // ─── The main line ──────────────────────────────────────────────────────────
  const mainRowId = main?.id ?? '__main__';
  rows.push({ id: mainRowId, label: MAIN_LINE_NAME, title: MAIN_LINE_NAME, y: MAIN_Y, colour: INK, dropped: false });
  const mainStops: MapStop[] = onMain.map((session, index) =>
    stopFor(session, main, PAD_X + index * STEP, MAIN_Y),
  );
  stops.push(...mainStops);
  for (let i = 1; i < mainStops.length; i++) {
    edges.push({
      id: `main-${i}`,
      from: { x: mainStops[i - 1].x, y: MAIN_Y },
      to: { x: mainStops[i].x, y: MAIN_Y },
      kind: 'along',
      dashed: false,
      colour: INK,
    });
  }

  const placed = new Map<string, RowPlacement>();
  const mainRow: RowPlacement = {
    line: main,
    y: MAIN_Y,
    meetings: mainStops,
    startX: PAD_X,
    endX: mainStops.length > 0 ? mainStops[mainStops.length - 1].x : PAD_X,
    returns: 0,
  };
  placed.set(mainRowId, mainRow);

  // A main line that has never met still gets its start, as long as the review has
  // lines at all. One STEP of line rather than a dot on its own, so it reads as the
  // beginning of the row the meetings will be placed along and not as a stray mark.
  if (mainStops.length === 0 && ordered.length > 0) {
    stops.push(markerStop(main, `start-${mainRowId}`, PAD_X, MAIN_Y, 'Start', 'start'));
    edges.push({
      id: 'main-start',
      from: { x: PAD_X, y: MAIN_Y },
      to: { x: PAD_X + STEP, y: MAIN_Y },
      kind: 'along',
      dashed: false,
      colour: INK,
    });
  }

  // ─── The variants ───────────────────────────────────────────────────────────
  // Rows in the order they are drawn: each variant directly under the line it was
  // started from, so a variant of a variant sits below its own parent rather than in
  // whatever order the database answered in. A variant whose parent line is not among
  // the lines it was given — a row written before `parent_line_id` existed, or one
  // whose parent has been deleted — belongs to the main row's family, which is the
  // only place the drawing can attach it to.
  const rowParentId = (variant: ReviewLine): string => {
    const parent = variant.parentLineId ? byId.get(variant.parentLineId) ?? null : null;
    return parent ? parent.id : mainRowId;
  };
  const rowOrder: ReviewLine[] = [];
  const inRowOrder = new Set<string>();
  const placeUnder = (parentId: string): void => {
    for (const variant of variants) {
      if (inRowOrder.has(variant.id) || rowParentId(variant) !== parentId) continue;
      inRowOrder.add(variant.id);
      rowOrder.push(variant);
      placeUnder(variant.id);
    }
  };
  placeUnder(mainRowId);
  // Whatever is left is a line whose parent chain runs in a circle, which the database
  // does not allow but a hand-written row could. Drawn rather than dropped: a variant
  // that vanished from the map because of its own row's contents is a variant nobody
  // can find again.
  for (const variant of variants) {
    if (inRowOrder.has(variant.id)) continue;
    inRowOrder.add(variant.id);
    rowOrder.push(variant);
    placeUnder(variant.id);
  }

  rowOrder.forEach((variant, rowIndex) => {
    const y = MAIN_Y + ROW_GAP * (rowIndex + 1);
    const dropped = variant.status === 'dropped';
    const adopted = variant.status === 'adopted';
    const colour = dropped ? DROPPED : adopted ? ADOPTED : VARIANT_INK;
    // The row is named in the short form — "Variant A" — because the left edge has
    // room for a chip and not for a sentence. The name the people exploring it gave
    // it, and the line it was started from when that was another variant, go in the
    // row's tooltip and in the panel one of its stops opens.
    rows.push({
      id: variant.id,
      label: shortLineLabel(variant) ?? 'Variant',
      title: lineLabelWithOrigin(ordered, variant) ?? 'Variant',
      y,
      colour,
      dropped,
    });

    const own = inSessionOrder(sessions.filter((s) => s.lineId === variant.id));

    // Where it leaves from: the session it was started at, or the end of the row it
    // left when that session is gone, or the START of that row for a variant started
    // with no meeting to leave from — batch BQ, a review that had not met yet, and
    // batch BX, a variant of a variant nobody has met on. Leaving at the start rather
    // than at the end is what keeps the drawing honest: a variant that left before any
    // of that row's meetings did not continue the work they did.
    const parentRow = placed.get(rowParentId(variant)) ?? mainRow;
    const parent = variant.parentSessionId ? bySession.get(variant.parentSessionId) ?? null : null;
    const parentStop = parent
      ? parentRow.meetings.find((stop) => stop.session.id === parent.id) ?? null
      : null;
    const originX = parentStop?.x
      ?? (variant.parentSessionId === null || parentRow.meetings.length === 0
        ? parentRow.startX
        : parentRow.endX);
    const originY = parentRow.y;

    const variantStops = own.map((session, index) =>
      stopFor(session, variant, originX + STEP * (index + 1), y),
    );
    stops.push(...variantStops);

    const firstPoint = variantStops.length > 0
      ? { x: variantStops[0].x, y }
      : { x: originX + STEP, y };

    // A variant nobody has met on yet ends its branch in a hollow stop carrying its
    // letter. Batch BV: without it the branch was a coloured line to nowhere, the map
    // had no stops at all when the main line had not met either, and the whole review
    // read as "No sessions recorded" — which is what made an explored variant look
    // like a variant that had not been saved.
    if (variantStops.length === 0) {
      stops.push(markerStop(
        variant,
        `end-${variant.id}`,
        firstPoint.x,
        y,
        variantLetter(variant) ?? '•',
        'variantEnd',
      ));
    }

    // The elbow off the line it left: across, then down, then along.
    edges.push({
      id: `leave-${variant.id}`,
      from: { x: originX, y: originY },
      to: firstPoint,
      kind: 'leave',
      dashed: dropped,
      colour,
      lineId: variant.id,
    });
    for (let i = 1; i < variantStops.length; i++) {
      edges.push({
        id: `${variant.id}-${i}`,
        from: { x: variantStops[i - 1].x, y },
        to: { x: variantStops[i].x, y },
        kind: 'along',
        dashed: dropped,
        colour,
        lineId: variant.id,
      });
    }

    const lastStop = variantStops.length > 0 ? variantStops[variantStops.length - 1] : null;
    placed.set(variant.id, {
      line: variant,
      y,
      meetings: variantStops,
      startX: firstPoint.x,
      endX: lastStop ? lastStop.x : firstPoint.x,
      returns: 0,
    });
  });

  // ─── The green returns ──────────────────────────────────────────────────────
  // A second pass, and it has to be: a return lands on the row of the line the variant
  // was merged INTO, which since batch BX is any line still being explored and may be
  // drawn below the one it leaves. Placed after the row's last meeting rather than on
  // top of it, one STEP apart per return so two variants merged into the same line do
  // not land on each other.
  //
  // A merge from before `merged_into_line_id` existed — an install whose schema has not
  // been upgraded, or a target line that has since been deleted — comes back to the
  // main row, which is the only line a merge could go to before then.
  for (const variant of rowOrder) {
    if (variant.status !== 'adopted') continue;
    const row = placed.get(variant.id);
    if (!row) continue;
    const targetId = variant.mergedIntoLineId !== null && placed.has(variant.mergedIntoLineId)
      ? variant.mergedIntoLineId
      : mainRowId;
    const target = placed.get(targetId) ?? mainRow;
    const x = target.endX + STEP * (target.returns + 1);
    target.returns += 1;

    const lastMeeting = row.meetings.length > 0 ? row.meetings[row.meetings.length - 1] : null;
    const lastPoint = lastMeeting
      ? { x: lastMeeting.x, y: row.y }
      : { x: row.startX, y: row.y };
    const targetLast = target.meetings.length > 0 ? target.meetings[target.meetings.length - 1] : null;

    stops.push({
      // Not a meeting: the moment the variant's model and cards became the other
      // line's. It carries the variant's newest session so the panel has something
      // true to show, and `rejoin` is what tells the drawing to make it green.
      session: lastMeeting
        ? lastMeeting.session
        : { ...(target.meetings[0]?.session ?? emptySession()), id: `rejoin-${variant.id}` },
      line: target.line,
      x,
      y: target.y,
      label: '✓',
      date: shortDate(variant.closedAt ?? '') ?? '',
      revisions: '',
      cards: 0,
      dropped: false,
      rejoin: true,
    });
    edges.push({
      id: `rejoin-${variant.id}`,
      from: lastPoint,
      to: { x, y: target.y },
      kind: 'rejoin',
      dashed: false,
      colour: ADOPTED,
    });
    if (targetLast) {
      edges.push({
        id: `rejoin-along-${variant.id}`,
        from: { x: targetLast.x, y: target.y },
        to: { x, y: target.y },
        kind: 'along',
        dashed: false,
        colour: ADOPTED,
      });
    }
  }

  const width = Math.max(PAD_X * 2 + STEP, ...stops.map((stop) => stop.x + PAD_X));
  const height = MAIN_Y + ROW_GAP * variants.length + PAD_BOTTOM + STOP_R * 2;

  return { stops, edges, width, height, rows };
}

function emptySession(): LineSession {
  return {
    id: '',
    title: '',
    endedAt: '',
    participantCount: 0,
    modelName: null,
    lineId: null,
    seq: null,
    revisionIds: [],
    summary: null,
  };
}

/**
 * A stop that is not a meeting: the main line's start, or the end of a variant
 * nobody has met on.
 *
 * Carried on the same shape as a real stop — and given a `session` with a made-up id
 * that cannot collide with one — because everything that draws, keys and measures the
 * map works on stops, and a second collection of "the other things on the map" would
 * be a second thing for the drawing, the miniature and the width arithmetic to keep in
 * step. The id is what makes it clickable: the panel below opens on the LINE it names.
 */
function markerStop(
  line: ReviewLine | null,
  id: string,
  x: number,
  y: number,
  label: string,
  kind: 'start' | 'variantEnd',
): MapStop {
  return {
    session: { ...emptySession(), id, lineId: line?.id ?? null },
    line,
    x,
    y,
    label,
    date: '',
    revisions: '',
    cards: 0,
    dropped: line?.status === 'dropped',
    rejoin: false,
    ...(kind === 'start' ? { start: true } : { variantEnd: true }),
  };
}

/**
 * "from S2 · 24 Sep", or "from the start" — where a variant left the main line.
 *
 * "From the start" is the answer for a variant started in a review that had never
 * met (`parent_session_id` NULL, batch BQ) AND for one whose parent meeting has since
 * been deleted, because in both cases there is no meeting to name — and a date
 * invented from the variant's own `created_at` would say when the line was started,
 * not where it left from, which is the question this line answers.
 */
function startedFromText(
  line: ReviewLine,
  lines: readonly ReviewLine[],
  sessions: readonly LineSession[],
): string {
  if (line.kind !== 'variant' || !line.parentSessionId) return 'from the start';
  const parent = sessions.find((session) => session.id === line.parentSessionId) ?? null;
  if (!parent) return 'from the start';
  const on = lines.find((one) => one.id === parent.lineId) ?? mainLineOf(orderedLines(lines));
  const label = sessionLabel(on, parent.seq);
  const date = shortDate(parent.endedAt);
  if (label && date) return `from ${label} · ${date}`;
  if (label) return `from ${label}`;
  if (date) return `from ${date}`;
  return 'from the start';
}

/**
 * The meetings a line has held, oldest first.
 *
 * A session with no `line_id` belongs to the main line, which is where the map draws
 * it and where the backfill in docs/supabase-schema.sql puts it.
 */
function lineMeetings(
  line: ReviewLine,
  lines: readonly ReviewLine[],
  sessions: readonly LineSession[],
): LineSession[] {
  const main = mainLineOf(orderedLines(lines));
  const mine = main !== null && line.id === main.id;
  return inSessionOrder(
    sessions.filter((session) => session.lineId === line.id || (mine && session.lineId === null)),
  );
}

/** The elbow an edge takes: across first, then down (or up), then across again. */
function edgePath(edge: MapEdge): string {
  const { from, to } = edge;
  if (edge.kind === 'along') return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midX = to.x - STEP / 2;
  return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
}

export interface SessionMapProps {
  /** The design review's name, for the heading. */
  reviewTitle?: string | null;
  lines: readonly ReviewLine[];
  sessions: readonly LineSession[];
  /** The review's stored revisions, so a stop can name what was on screen. */
  revisions?: readonly ModelRevision[];
  /** The review's cards, so a stop can count its own. */
  cards?: readonly SessionCardRef[];
  /** Close the panel this map is in. Omitted where the map is part of the page. */
  onClose?: () => void;
  /** Empty-state text, for a review that has not met yet. */
  emptyMessage?: string;
  /**
   * Whether dropped variants are shown, when the page holding the map also lists
   * lines (the lobby preview): one switch for both, so "Show dropped" on either
   * reveals them in the map AND the list. Uncontrolled when absent.
   */
  showDropped?: boolean;
  onShowDroppedChange?: (shown: boolean) => void;
  /**
   * The review's id, and whether this person may change its lines. Both are needed
   * for the map to offer any of the three variant actions, and both are omitted
   * where it should not: a map with no review id cannot say which review a variant
   * would belong to, and a map whose reader is a participant or a guest offers
   * actions the endpoint would refuse.
   *
   * `mayEditLines` is the host's `can('editReview')` — starting, adopting and
   * dropping a variant are all the same permission as changing the review's agenda
   * or its models, not three new ones. See lib/reviews/roles.ts.
   */
  reviewId?: string | null;
  mayEditLines?: boolean;
  /**
   * Whether this person may DELETE one of the review's sessions.
   *
   * Narrower than `mayEditLines`, and deliberately so: `deleteReview` in
   * lib/reviews/roles.ts is the owner's and this install's administrators', not its
   * editors'. Removing a meeting removes the cards raised in it, which is not a change
   * to the review's agenda that an editor makes every week. Passed down like
   * `mayEditLines` rather than asked again here, because this map is mounted inside
   * panels that have already asked; hiding the button is not the enforcement —
   * api/reviews/delete.ts checks the caller's own token against the roster.
   */
  mayDelete?: boolean;
  /** Whether this browser is running the meeting. Read on an install with no accounts. */
  isMeetingHost?: boolean;
  /** Read the lines, sessions and cards again, after an action changed them. */
  onChanged?: () => void;
  /**
   * How this host opens a line's room: null for the main line, an id for a variant.
   *
   * Handed in rather than linked to, and the reason is a bug the user found by pressing
   * a button: pages/RoomPage's entry guard admits an arrival by its router state
   * (`{ fromLobby: true }`) or by the sessionStorage mark a deliberate entry writes, and
   * a plain <Link> to the correct address carries NEITHER — so the room the map linked
   * to sent the person straight back to the lobby. Every "open a line" in the app goes
   * through lib/reviews/openLine, which sets one of the two; a host that has a form to
   * submit first (the lobby asks for a name before it lets anybody in) passes its own.
   *
   * Omitted and this map opens lines through `openLine` itself, which is the right
   * answer everywhere except the lobby. Passed on to VariantActions and
   * ExploreVariantButton, because a merge or a newly started variant navigates too and
   * would otherwise bounce in exactly the same way.
   */
  onOpenLine?: (lineId: string | null) => void;
  /**
   * Read ONE meeting's transcript, so the panel can offer it as a .txt.
   *
   * A reader handed in rather than a read made here, which keeps this file's rule
   * intact: nothing here touches the database, so the same map renders in the room,
   * in the tracker, in the lobby's preview and in a test with fixture data.
   * lib/reviews/useSessionMap is the half that fetches, and every caller that uses
   * it passes this down. Omitted, and the panel simply has no transcript row — a map
   * that cannot read one is a map that does not offer one, which is the honest
   * answer for a test's fixtures and for a surface that has no database.
   */
  readTranscript?: (sessionId: string) => Promise<TranscriptRow[] | null>;
  /**
   * Draw the map as a DIAGRAM inside somebody else's panel: no heading, no card.
   *
   * Batch BP. The lobby's preview panel embeds this map, and embedded it repeated the
   * panel's own header — "DESIGN REVIEW", the same title, the same session count — three
   * lines under a header that had just said all of it, inside a bordered white card
   * inside the panel's own bordered white card. Compact drops both: the heading, because
   * the panel it sits in has one, and the rounded border and shadow, because the panel
   * is the card. The drawing, the row labels down its left edge, the stop panel one of
   * its stops opens and the variant actions are all unchanged, and so is every other
   * caller: the room and the tracker both mount this map as the whole of a surface, so
   * both keep the heading and the chrome and neither passes this.
   *
   * What survives of the heading is the key, moved above the drawing and right-aligned
   * out of its way: "Adopted" and "Dropped" are the two states a line can end in and the
   * only part of the drawing that does not label itself. It is shown at every width here
   * rather than from the `sm` breakpoint up, because that breakpoint measures the
   * VIEWPORT and this map is now inside a panel of a fixed narrow width — a phone in
   * landscape would have kept the key and a desktop with a narrow window would have
   * dropped it, which is an answer about the window and not about the room available.
   */
  compact?: boolean;
}

/** The button style VariantActions uses, so a session's actions all read alike. */
const BUTTON =
  'inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-semibold transition-colors disabled:opacity-40';

/**
 * "Delete session" — one meeting, and the cards raised in it.
 *
 * An inline confirm in the same panel that offered it, naming the stop the way the map
 * names it and saying how many cards go with it, because "Delete" on its own does not
 * say which of twenty meetings is about to disappear. Deliberately NOT window.confirm:
 * it cannot be styled to the panel it belongs to, it cannot be tested, and it freezes
 * the room behind it while it waits.
 *
 * What the endpoint may refuse, and the sentence it refuses with, are its own: a
 * variant that leaves FROM this meeting blocks it, because the map draws that variant
 * starting at this stop. Session numbers are not reused and not renumbered, so the
 * meetings after this one keep saying what they always said.
 */
const DeleteSessionButton: React.FC<{
  reviewId: string;
  session: LineSession;
  /** "S2" / "A1" — the label the map draws on this stop. */
  label: string;
  /** How many cards were raised in it, for the sentence that asks. */
  cards: number;
  isMeetingHost?: boolean;
  onDeleted?: () => void;
}> = ({ reviewId, session, label, cards, isMeetingHost, onDeleted }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteSession(reviewId, session.id, { isMeetingHost });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That session could not be deleted.');
      return;
    }
    setConfirming(false);
    onDeleted?.();
  };

  if (!confirming) {
    return (
      <button
        onClick={() => { setConfirming(true); setError(null); }}
        className={`${BUTTON} border-gray-200 text-gray-500 hover:border-red-300 hover:text-red-600 bg-white`}
        title="Delete this meeting and the cards raised in it"
      >
        <Trash2 size={11} />
        Delete session
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="delete-session">
      <p className="text-[11px] text-gray-700 leading-snug">
        Delete {label}
        {cards > 0 ? ` and its ${cards} ${cards === 1 ? 'card' : 'cards'}` : ''}? This cannot be undone.
      </p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => void run()}
          disabled={busy}
          className={`${BUTTON} border-red-600 bg-red-600 text-white hover:bg-red-700`}
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={busy}
          className={`${BUTTON} border-gray-200 text-gray-400 hover:text-black bg-white`}
        >
          Cancel
        </button>
      </div>
      {busy && <p className="text-[10px] text-gray-400">Deleting the session and its cards…</p>}
      {error && <p className="text-[10px] text-red-600 leading-snug" role="status">{error}</p>}
    </div>
  );
};

/**
 * "Show dropped (2)" / "Hide dropped" — the variants this review has finished with.
 *
 * A count in the label rather than a bare "Show dropped", because the button is the only
 * place the map says anything at all about lines it is not drawing: without the number a
 * review that dropped six answers and kept one offers a button that looks like a filter
 * for nothing, and a reader who never presses it never learns the history is there.
 *
 * `aria-pressed` and not a checkbox: it changes what one drawing shows rather than
 * choosing between two, and a screen reader user gets the same answer the key beside it
 * gives a sighted one.
 */
const ShowDroppedButton: React.FC<{
  count: number;
  shown: boolean;
  onToggle: () => void;
}> = ({ count, shown, onToggle }) => (
  <button
    onClick={onToggle}
    data-testid="show-dropped"
    aria-pressed={shown}
    title={
      shown
        ? 'Leave the variants this review dropped off the map'
        : 'Draw the variants this review dropped, greyed, for the record'
    }
    className="flex-shrink-0 font-mono text-[9px] text-gray-400 underline decoration-dotted underline-offset-2 hover:text-black transition-colors"
  >
    {shown ? 'Hide dropped' : `Show dropped (${count})`}
  </button>
);

/**
 * The map, and the panel one of its stops opens.
 *
 * Drawn in the app's own light style — white card, grey rules, black ink — because
 * it sits over the room's canvas in one place and inside the tracker's white page in
 * the other, and has to read the same in both.
 */
const SessionMap: React.FC<SessionMapProps> = ({
  reviewTitle,
  lines,
  sessions,
  revisions = [],
  cards = [],
  onClose,
  emptyMessage = 'No sessions recorded in this design review yet.',
  showDropped: showDroppedProp,
  onShowDroppedChange,
  reviewId = null,
  mayEditLines = false,
  mayDelete = false,
  isMeetingHost = false,
  onChanged,
  onOpenLine,
  readTranscript,
  compact = false,
}) => {
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The line one of the map's two markers opened. Batch BV: a review whose variant
  // has never met has nothing to open a SESSION panel on, and the way into that
  // variant's room is the thing its reader is looking for.
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  /**
   * Whether the variants this review dropped are drawn. Off, which is the answer the
   * user asked for: a dropped variant is a decision the review made and its row is
   * kept for the record, but a map of a review that has tried six answers and kept two
   * is mostly grey rows nobody is meeting on, and the two live lines are hard to find
   * in them. Per view and not remembered — a reader who wants the history back asks
   * for it, and the next person to open the map gets the map that answers "where is
   * this review now".
   *
   * Merged variants are NOT hidden. They are part of how the review got here: their
   * model is on the line they went into and their cards say where they came from, so
   * taking the row away would leave a green return on that line with nothing leaving
   * into it.
   */
  const [showDroppedOwn, setShowDroppedOwn] = useState(false);
  const showDropped = showDroppedProp ?? showDroppedOwn;
  const setShowDropped = (next: (now: boolean) => boolean) => {
    const value = next(showDropped);
    if (onShowDroppedChange) onShowDroppedChange(value);
    else setShowDroppedOwn(value);
  };
  const droppedCount = hiddenLineCount(lines);
  const hiddenIds = useMemo(
    () =>
      new Set(
        showDropped
          ? []
          : lines.filter((line) => line.status === 'dropped').map((line) => line.id),
      ),
    [lines, showDropped],
  );
  // Filtered BEFORE the layout, so a hidden variant takes its row, its meetings and its
  // edges with it rather than being drawn and then painted over: a row that stayed in
  // the layout would still hold its place in the row order and leave a gap where the
  // variants below it were.
  const drawnLines = useMemo(
    () => (hiddenIds.size === 0 ? lines : lines.filter((line) => !hiddenIds.has(line.id))),
    [lines, hiddenIds],
  );
  const drawnSessions = useMemo(
    () =>
      hiddenIds.size === 0
        ? sessions
        : sessions.filter((session) => session.lineId === null || !hiddenIds.has(session.lineId)),
    [sessions, hiddenIds],
  );
  const layout = useMemo(
    () => layoutSessionMap(drawnLines, drawnSessions, revisions, cards),
    [drawnLines, drawnSessions, revisions, cards],
  );
  // Counted from what is drawn and not from everything the review has, so the heading
  // agrees with the picture under it: "4 sessions · 3 variants" over a map of three
  // sessions and one variant is a heading about a review the reader cannot see.
  const drawnVariants = drawnLines.filter((line) => line.kind === 'variant').length;

  const selected = layout.stops.find(
    (stop) => stop.session.id === selectedId && !stop.rejoin && !stop.start && !stop.variantEnd,
  ) ?? null;
  // Resolved against the lines the map is DRAWING rather than against all of them: a
  // variant dropped from its own panel comes back a moment later as a line that is no
  // longer drawn, and a panel left open on a row that has gone is a panel about
  // nothing — with a way into a room nobody is meeting in.
  const selectedLine = selectedLineId
    ? drawnLines.find((line) => line.id === selectedLineId) ?? null
    : null;

  // The selected meeting's transcript, read when its stop is clicked and dropped
  // when another one is. The id travels with the rows so a slow answer about the
  // stop that was open a moment ago cannot land on the panel of the one open now —
  // the panel would otherwise offer a download of a different meeting's transcript
  // under this meeting's heading.
  const [transcript, setTranscript] = useState<{ id: string; rows: TranscriptRow[] } | null>(null);
  useEffect(() => {
    if (!selectedId || !readTranscript) {
      setTranscript(null);
      return;
    }
    let cancelled = false;
    void readTranscript(selectedId).then((rows) => {
      if (cancelled) return;
      setTranscript(rows && rows.length > 0 ? { id: selectedId, rows } : null);
    });
    return () => { cancelled = true; };
  }, [selectedId, readTranscript]);
  const selectedTranscript =
    selected !== null && transcript?.id === selected.session.id ? transcript.rows : null;
  const byLine = useMemo(() => {
    const table = new Map<string, ReviewLine>();
    for (const line of lines) table.set(line.id, line);
    return table;
  }, [lines]);

  // The variants still being explored, which are the only ones with anything to
  // merge or drop. A merged or dropped one is on the map for the record and offers
  // nothing — that is what stops a merge being offered twice for the same decision,
  // and what makes the greyed row on the map read as history.
  const activeVariants = useMemo(
    () => lines.filter((line) => line.kind === 'variant' && line.status === 'active'),
    [lines],
  );

  /**
   * The meetings on the line whose panel is open, and the newest of them.
   *
   * The newest is what "Explore a variant from here" leaves from when it is offered on
   * a LINE rather than on one of its stops: a variant starts on the model its parent
   * line is at now, and that model is the one its last meeting left on screen. Null for
   * a line that has never met, which then offers no explore — there is no meeting to
   * leave from, and the room of a line in that state has its own "Variant" button that
   * starts one from the model as it is.
   */
  const selectedLineMeetings = selectedLine ? lineMeetings(selectedLine, lines, sessions) : [];
  const newestOnSelectedLine =
    selectedLineMeetings.length > 0
      ? selectedLineMeetings[selectedLineMeetings.length - 1] ?? null
      : null;
  // Both read from EVERY line rather than from the ones being drawn: a merged variant
  // names the line it went into and a variant names the one it was started from, and
  // either of those may be a dropped one the map is not drawing at the moment.
  const mergedIntoText = mergedIntoLabel(lines, selectedLine);
  const droppedWhy = droppedLineReason(selectedLine);

  /**
   * How this map opens a line's room: the host's way when it handed one in, and
   * lib/reviews/openLine's otherwise. Never a link — see the `onOpenLine` prop.
   *
   * The main line is asked for with null rather than with its own id, because its
   * address carries no `?line=` and an id would be a second address for the same room.
   */
  const openLineFromMap = useCallback(
    (lineId: string | null) => {
      if (onOpenLine) {
        onOpenLine(lineId);
        return;
      }
      openLine(navigate, reviewId, lineId);
    },
    [navigate, onOpenLine, reviewId],
  );

  const selectedCards = selected ? cards.filter((card) => card.sessionId === selected.session.id) : [];
  // The names a meeting recorded, which are what "Attended" says from batch BM on.
  // [] for a meeting recorded before the column existed, and then the head count is
  // the answer — it is still a true statement about who was in the room.
  const selectedAttendees = selected?.session.attendeeNames ?? [];
  const transcriptLines = selectedTranscript ? transcriptLineCount(selectedTranscript) : 0;

  /**
   * The selected meeting's transcript as a .txt — the same file, byte for byte, that
   * the person who stopped the recording could have downloaded from the stop panel,
   * because both go through lib/capture/transcriptText.
   *
   * `includePointing` is true and is not a choice here: what people pointed at was
   * decided when the transcript was SAVED, and rows of that kind are in the stored
   * array or they are not. Rendering everything the meeting kept is the only honest
   * reading of a record — a second checkbox would offer to hide part of what was
   * stored, and the file would stop being that meeting's transcript.
   */
  const downloadSelectedTranscript = () => {
    if (!selected || !selectedTranscript) return;
    const ended = new Date(selected.session.endedAt);
    const date = formatTranscriptDate(Number.isNaN(ended.getTime()) ? new Date() : ended);
    // The review's name, and the meeting's own title for a session recorded with no
    // review behind it — a file called "transcript.txt" in a folder of them is a file
    // nobody opens twice.
    const heading = (reviewTitle ?? '').trim() || selected.session.title.trim() || null;
    downloadTranscript(
      transcriptToText(selectedTranscript, {
        includePointing: true,
        title: heading,
        date,
        attendees: selectedAttendees,
      }),
      transcriptFilename(heading, date),
    );
  };

  return (
    <div
      className={
        compact
          ? 'h-full flex flex-col bg-white overflow-hidden'
          : 'h-full flex flex-col bg-white rounded-lg border border-gray-200 shadow-xl overflow-hidden'
      }
    >
      {/* The key on its own, which is all of the heading a compact map keeps. */}
      {compact && (
        <div
          className="flex-shrink-0 flex items-center justify-end gap-3 px-1 pb-1 font-mono text-[9px] text-gray-400"
          data-testid="session-map-legend"
        >
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full border-2" style={{ borderColor: ADOPTED }} /> Adopted
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-px border-t border-dashed" style={{ borderColor: FAINT }} /> Dropped
          </span>
          {droppedCount > 0 && (
            <ShowDroppedButton
              count={droppedCount}
              shown={showDropped}
              onToggle={() => setShowDropped((now) => !now)}
            />
          )}
        </div>
      )}
      {/* Heading */}
      {!compact && <div
        className="flex-shrink-0 flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-100 bg-gray-50/60"
        data-testid="session-map-heading"
      >
        <div className="min-w-0">
          <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Design review</p>
          <h2 className="text-sm font-semibold text-gray-900 leading-snug truncate">
            {reviewTitle?.trim() || 'This design review'}
          </h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {drawnSessions.length} {drawnSessions.length === 1 ? 'session' : 'sessions'}
            {drawnVariants > 0 &&
              ` · ${drawnVariants} ${drawnVariants === 1 ? 'variant' : 'variants'}`}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* The two states a line can end in, which are the only part of the
              drawing that needs a key: the lines name themselves down the left edge,
              and repeating "Main line" here would put the same words on screen twice
              for no reason. */}
          <div className="hidden sm:flex items-center gap-3 font-mono text-[9px] text-gray-400">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full border-2" style={{ borderColor: ADOPTED }} /> Adopted</span>
            <span className="flex items-center gap-1"><span className="w-3 h-px border-t border-dashed" style={{ borderColor: FAINT }} /> Dropped</span>
          </div>
          {/* Outside the key's `hidden sm:flex`, and deliberately: the key is a
              nicety a narrow window can do without, and this is the only way back to
              rows the map has taken off it. */}
          {droppedCount > 0 && (
            <ShowDroppedButton
              count={droppedCount}
              shown={showDropped}
              onToggle={() => setShowDropped((now) => !now)}
            />
          )}
          {onClose && (
            <button
              onClick={onClose}
              title="Close"
              aria-label="Close the session map"
              className="p-1 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>}

      {/* The drawing */}
      <div className="flex-1 min-h-0 overflow-auto custom-scrollbar bg-white">
        {layout.stops.length === 0 ? (
          <p className="p-8 text-center text-[11px] font-mono italic text-gray-300">{emptyMessage}</p>
        ) : (
          <svg
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label="Map of this design review's sessions"
            className="block"
          >
            {layout.edges.map((edge) => {
              // A variant's line is a way into its panel — batch BV, and for a variant
              // nobody has met on it is the ONLY way, because it has no stops to click.
              const opensLine = edge.lineId;
              return (
                <g key={edge.id}>
                  <path
                    d={edgePath(edge)}
                    fill="none"
                    stroke={edge.colour}
                    strokeWidth={edge.kind === 'along' ? 2 : 1.5}
                    strokeDasharray={edge.dashed ? '4 4' : undefined}
                    strokeLinecap="round"
                    opacity={edge.dashed ? 0.9 : 1}
                  />
                  {opensLine && (
                    // A second, wider, invisible stroke over the same path, because a
                    // 1.5px line is not a thing anybody can hit with a pointer. Made a
                    // sibling rather than a thicker visible stroke so the drawing stays
                    // exactly as legible as it was and only the hit area grows.
                    <path
                      d={edgePath(edge)}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      pointerEvents="stroke"
                      style={{ cursor: 'pointer' }}
                      data-testid="map-line-edge"
                      data-line={opensLine}
                      onClick={() => {
                        setSelectedId(null);
                        setSelectedLineId((now) => (now === opensLine ? null : opensLine));
                      }}
                    >
                      <title>
                        {layout.rows.find((row) => row.id === opensLine)?.title ?? 'This line'}
                      </title>
                    </path>
                  )}
                </g>
              );
            })}

            {layout.rows.map((row) => (
              <text
                key={row.id}
                x={8}
                y={row.y + 3}
                fontSize={9}
                fontFamily="ui-monospace, monospace"
                fontWeight={700}
                fill={row.dropped ? FAINT : MUTED}
              >
                {/* Only where the tooltip says more than the row does: "Main line"
                    over "Main line" is a tooltip for its own sake. */}
                {row.title !== row.label && <title>{row.title}</title>}
                {row.label}
              </text>
            ))}

            {layout.stops.map((stop) => {
              // Not a meeting: the main line's start, or the end of a variant nobody
              // has met on. Both open the LINE's panel rather than a session's.
              const marker = stop.start === true || stop.variantEnd === true;
              const isSelected = marker
                ? selectedLineId !== null && selectedLineId === stop.line?.id
                : selectedId === stop.session.id && !stop.rejoin;
              const fill = stop.rejoin ? ADOPTED : marker ? '#ffffff' : stop.dropped ? '#f3f4f6' : '#ffffff';
              const stroke = stop.rejoin ? ADOPTED : stop.dropped ? DROPPED : stop.line && stop.line.kind === 'variant' ? VARIANT_INK : INK;
              return (
                <g
                  key={`${stop.session.id}-${stop.x}`}
                  onClick={() => {
                    if (stop.rejoin) return;
                    if (marker) {
                      setSelectedId(null);
                      setSelectedLineId(isSelected ? null : stop.line?.id ?? null);
                      return;
                    }
                    setSelectedLineId(null);
                    setSelectedId(isSelected ? null : stop.session.id);
                  }}
                  style={{ cursor: stop.rejoin ? 'default' : 'pointer' }}
                  data-testid={stop.rejoin ? undefined : marker ? 'map-line-stop' : 'session-stop'}
                >
                  <title>
                    {stop.rejoin
                      ? // Names the line it went INTO, which since batch BX is not always
                        // the main one: a green stop on Variant A's row that said "into
                        // the main line" would describe a merge the map is not drawing.
                        `Merged into ${mergeTargetWord(stop.line)}${stop.date ? ` · ${stop.date}` : ''}`
                      : marker
                        ? `${lineLabel(stop.line) ?? MAIN_LINE_NAME} — no sessions on it yet`
                        : `${stop.label} — ${stop.date}${stop.revisions ? ` — ${stop.revisions}` : ''}`}
                  </title>
                  <circle
                    cx={stop.x}
                    cy={stop.y}
                    r={STOP_R}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSelected ? 3 : 1.5}
                    strokeDasharray={stop.dropped ? '3 3' : undefined}
                  />
                  <text
                    x={stop.x}
                    y={stop.y + 3.5}
                    textAnchor="middle"
                    fontSize={marker ? 9 : 10}
                    fontWeight={700}
                    fontFamily="ui-monospace, monospace"
                    fill={stop.rejoin ? '#ffffff' : stop.dropped ? FAINT : INK}
                  >
                    {stop.label}
                  </text>
                  {!stop.rejoin && !marker && (
                    <>
                      <text x={stop.x} y={stop.y + STOP_R + 13} textAnchor="middle" fontSize={9} fill={stop.dropped ? FAINT : MUTED}>
                        {stop.date}
                      </text>
                      {stop.revisions && (
                        <text
                          x={stop.x}
                          y={stop.y + STOP_R + 25}
                          textAnchor="middle"
                          fontSize={8.5}
                          fontFamily="ui-monospace, monospace"
                          fill={stop.dropped ? FAINT : '#4b5563'}
                        >
                          {stop.revisions}
                        </text>
                      )}
                      {stop.cards > 0 && (
                        <text x={stop.x} y={stop.y - STOP_R - 6} textAnchor="middle" fontSize={8.5} fontFamily="ui-monospace, monospace" fill={FAINT}>
                          {stop.cards} {stop.cards === 1 ? 'card' : 'cards'}
                        </text>
                      )}
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* The variants still being explored, and the two things that can be done with
          each. Below the drawing rather than on it: the map is a picture of the
          review's history, and a button floating in the middle of it is a button
          nobody finds twice. Rendered only for somebody who may change the review's
          lines — a participant or a guest sees the map and nothing to press. */}
      {reviewId && mayEditLines && activeVariants.length > 0 && (
        <div
          className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-2.5 flex flex-col gap-2"
          data-testid="map-variants"
        >
          {activeVariants.map((variant) => (
            <div key={variant.id} className="flex items-start gap-3">
              <p
                className="text-[11px] text-gray-700 font-medium pt-1 w-40 shrink-0 truncate"
                title={lineLabel(variant) ?? undefined}
              >
                {lineLabel(variant) ?? 'Variant'}
              </p>
              <div className="flex-1 min-w-0">
                <VariantActions
                  reviewId={reviewId}
                  variant={variant}
                  lines={lines}
                  mayEdit={mayEditLines}
                  isMeetingHost={isMeetingHost}
                  onChanged={onChanged}
                  onOpenLine={openLineFromMap}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One LINE, opened — batch BV, and from batch BX the panel of any line the map
          draws, not only of the two markers: the main line's start, the hollow stop a
          variant nobody has met on ends at, and the line a variant is drawn with, which
          is the only thing on the map that says a variant exists until somebody has met
          on it.

          It exists because a variant with no meetings had nothing to click and
          therefore no way into its own room from anywhere but its address: the map
          said "No sessions recorded", the lobby preview counted it and could not
          name it, and the person who had just spent twenty minutes moving a model
          inside it read all of that as "the variant was not saved". What it offers is
          the way in, then the same decisions the map already offers for a variant —
          and it offers them to exactly the same people, because VariantActions is the
          component that asks. A line that is finished with offers neither, and says
          what became of it instead. */}
      {selectedLine && (
        <div
          className="flex-shrink-0 border-t border-gray-100 bg-gray-50/40 px-4 py-3 max-h-[45%] overflow-y-auto custom-scrollbar"
          data-testid="line-panel"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Line</p>
              <h3 className="text-sm font-semibold text-gray-900 leading-snug">
                {lineLabelWithOrigin(lines, selectedLine) ?? MAIN_LINE_NAME}
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {lineStatusWord(selectedLine) ?? 'active'}
                {/* Where it went, when it went there, and into which line — the last of
                    which is the half that used to have one answer. */}
                {mergedIntoText ? ` · ${mergedIntoText}` : ''}
                {selectedLine.kind === 'variant'
                  ? ` · started ${startedFromText(selectedLine, lines, sessions)}`
                  : ''}
                {` · ${selectedLineMeetings.length} ${
                  selectedLineMeetings.length === 1 ? 'session' : 'sessions'
                }`}
              </p>
            </div>
            <button
              onClick={() => setSelectedLineId(null)}
              className="p-1 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition-colors flex-shrink-0"
              title="Close this line"
              aria-label="Close this line"
            >
              <X size={14} />
            </button>
          </div>

          {/* A dropped variant is a decision, not somewhere to go. Its meetings stay
              readable — they are the record of the answer the review tried, and the
              cards closed with it all carry the reason — but the panel offers no way
              in and nothing to decide, because a room nobody is meeting in any more is
              a room that can only be edited by mistake. */}
          {selectedLine.status === 'dropped' && (
            <div className="mt-3" data-testid="dropped-line">
              <p className="text-[11px] text-gray-600 leading-snug">
                {droppedWhy ? `Dropped: ${droppedWhy}` : 'This variant was dropped.'}
              </p>
              <p className="mt-1 text-[10px] text-gray-400 leading-snug">
                Its meetings stay on the map for the record, and the cards it left open closed with this reason on them.
              </p>
            </div>
          )}

          {/* The way in, for a line somebody is still meeting on. A BUTTON and not a
              link: pages/RoomPage admits an arrival by its router state or by the mark
              a deliberate entry writes, and a link to the right address carries
              neither — it bounced the reader back to the lobby, which is the bug this
              prop exists to end. The main line is asked for with null, because its
              address carries no `?line=` and an id would be a second address for the
              same room. */}
          {reviewId && selectedLine.status === 'active' && (
            <button
              onClick={() => openLineFromMap(isMainLine(selectedLine) ? null : selectedLine.id)}
              data-testid={selectedLine.kind === 'variant' ? 'open-variant' : 'open-main-line'}
              className={`${BUTTON} mt-3 border-black bg-black text-white hover:bg-gray-800`}
              title={
                selectedLine.kind === 'variant'
                  ? 'Open this variant’s room'
                  : 'Open the main line’s room'
              }
            >
              {selectedLine.kind === 'variant' ? 'Open variant' : 'Open main line'}
            </button>
          )}

          {reviewId && mayEditLines && selectedLine.status === 'active' && (
            <div className="mt-2.5 border-t border-gray-200/70 pt-2.5 flex flex-col items-start gap-2">
              {selectedLine.kind === 'variant' && (
                <VariantActions
                  reviewId={reviewId}
                  variant={selectedLine}
                  lines={lines}
                  mayEdit={mayEditLines}
                  isMeetingHost={isMeetingHost}
                  onChanged={onChanged}
                  onOpenLine={openLineFromMap}
                />
              )}
              {/* Any line still being explored is somewhere a variant can leave from,
                  whether or not the reader happens to have one of its meetings open:
                  it leaves from the newest one, which is the model this line is at now.
                  A line that has never met offers nothing here, because there is no
                  meeting to leave from and its own room says so with a button of its
                  own. */}
              {newestOnSelectedLine && (
                <ExploreVariantButton
                  reviewId={reviewId}
                  session={newestOnSelectedLine}
                  line={selectedLine}
                  mayEdit={mayEditLines}
                  isMeetingHost={isMeetingHost}
                  onChanged={onChanged}
                  onOpenLine={openLineFromMap}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* One session, opened */}
      {selected && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-gray-50/40 px-4 py-3 max-h-[45%] overflow-y-auto custom-scrollbar">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Session</p>
              <h3 className="text-sm font-semibold text-gray-900 leading-snug">
                {selected.label}
                <span className="font-normal text-gray-500"> · {selected.date}</span>
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {lineLabel(selected.line ?? byLine.get(selected.session.lineId ?? '') ?? null) ?? 'Main line'}
                {selected.session.title ? ` · ${selected.session.title}` : ''}
              </p>
            </div>
            <button
              onClick={() => setSelectedId(null)}
              className="p-1 rounded text-gray-400 hover:text-black hover:bg-gray-100 transition-colors flex-shrink-0"
              title="Close this session"
              aria-label="Close this session"
            >
              <X size={14} />
            </button>
          </div>

          <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <dt className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Attended</dt>
              <dd className="text-xs text-gray-800 mt-0.5">
                {selectedAttendees.length > 0
                  ? selectedAttendees.join(', ')
                  : `${selected.session.participantCount} ${
                      selected.session.participantCount === 1 ? 'person' : 'people'
                    }`}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">On screen</dt>
              <dd className="text-xs text-gray-800 mt-0.5">
                {selected.revisions || <span className="text-gray-300 italic">Not stored</span>}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Cards</dt>
              <dd className="text-xs text-gray-800 mt-0.5">{selected.cards}</dd>
            </div>
            <div>
              <dt className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Model</dt>
              <dd className="text-xs text-gray-800 mt-0.5 truncate">
                {selected.session.modelName || <span className="text-gray-300 italic">—</span>}
              </dd>
            </div>
          </dl>

          {/* Any session on any line still being explored is somewhere a variant can
              leave from — that is what the map is for. Starting one takes its model and
              its still-open cards and opens the new line's own room.

              Not offered on a meeting of a DROPPED variant, whose stops stay readable
              because they are the record: a variant started from one would hang off a
              line the review has finished with, on a model nobody is maintaining, and
              the room it opens would be a room the map has just greyed out. */}
          {reviewId && mayEditLines && !selected.dropped && (
            <div className="mt-3">
              <ExploreVariantButton
                reviewId={reviewId}
                session={selected.session}
                line={selected.line ?? byLine.get(selected.session.lineId ?? '') ?? null}
                mayEdit={mayEditLines}
                isMeetingHost={isMeetingHost}
                onChanged={onChanged}
                onOpenLine={openLineFromMap}
              />
            </div>
          )}

          {/* Deleting the meeting is offered to fewer people than starting a variant
              from it — `mayDelete` is the owner and this install's admins, where
              `mayEditLines` is its editors too — and sits apart from it for that
              reason, so the two are not read as one row of things you can do. */}
          {reviewId && mayDelete && (
            <div className="mt-2">
              <DeleteSessionButton
                reviewId={reviewId}
                session={selected.session}
                label={selected.label}
                cards={selected.cards}
                isMeetingHost={isMeetingHost}
                onDeleted={() => {
                  // The stop is gone, so the panel that was open on it has nothing to
                  // show; closing it is what stops the map redrawing a selected stop
                  // that is no longer there.
                  setSelectedId(null);
                  onChanged?.();
                }}
              />
            </div>
          )}

          {/* The meeting's transcript, when the meeting kept one. Above the minutes
              rather than below them: what was said is the record and the minutes are
              a summary of it, and a reader who wants one of them wants that order.
              Absent — not empty, not greyed out — when nothing was stored, because
              every meeting held before batch BU and every meeting nobody asked to
              keep has no transcript and is not missing one. */}
          {selectedTranscript && (
            <div className="mt-3" data-testid="session-transcript">
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                Transcript · {transcriptLines} {transcriptLines === 1 ? 'line' : 'lines'}
              </p>
              <button
                onClick={downloadSelectedTranscript}
                className={`${BUTTON} mt-1.5 border-gray-200 text-gray-500 hover:border-black hover:text-black bg-white`}
                title="Download this meeting’s transcript as a text file"
              >
                <Download size={11} /> Download .txt
              </button>
            </div>
          )}

          {selected.session.summary ? (
            <div className="mt-3">
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest">Summary</p>
              {/* Model output, so no dangerouslySetInnerHTML and no markdown
                  library: every line is React text. Only the two shapes the minutes
                  use are recognised — "## " headings and "- " bullets — so the
                  markers do not show; anything else stays as written. Capped, so a
                  long meeting's minutes scroll inside the panel instead of pushing
                  the cards out of reach. */}
              <div className="text-[11px] text-gray-600 leading-relaxed mt-1 max-h-40 overflow-y-auto custom-scrollbar">
                {summaryLines(selected.session.summary).map((line, i) => (
                  line.kind === 'heading' ? (
                    <p key={i} className="font-semibold text-gray-800 mt-2 first:mt-0">{line.text}</p>
                  ) : line.kind === 'bullet' ? (
                    <p key={i} className="pl-3 -indent-2">• {line.text}</p>
                  ) : line.text === '' ? null : (
                    <p key={i}>{line.text}</p>
                  )
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-[11px] font-mono italic text-gray-300">
              No summary was stored for this session.
            </p>
          )}

          {selectedCards.length > 0 && (
            <div className="mt-3">
              <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">
                Cards from this session
              </p>
              <ul className="space-y-1">
                {selectedCards.slice(0, 12).map((card) => {
                  const origin = byLine.get(card.originLineId ?? '');
                  return (
                    <li key={card.id}>
                      <Link
                        to={`/tracker?session=${selected.session.id}`}
                        className="flex items-baseline gap-2 text-[11px] text-gray-600 hover:text-black transition-colors min-w-0"
                      >
                        <span className="font-mono text-[9px] font-bold text-gray-400 flex-shrink-0">{card.type}</span>
                        <span className="truncate flex-1">{card.title}</span>
                        <span className="font-mono text-[9px] text-gray-400 flex-shrink-0">{card.status}</span>
                        {origin && origin.kind === 'variant' && (
                          <span className="font-mono text-[9px] text-gray-400 flex-shrink-0">
                            from {shortLineLabel(origin)}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {selectedCards.length > 12 && (
                <Link
                  to={`/tracker?session=${selected.session.id}`}
                  className="inline-block mt-1.5 font-mono text-[10px] text-gray-400 hover:text-black transition-colors"
                >
                  + {selectedCards.length - 12} more in the tracker
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SessionMap;

/** Stops in the order the map draws them, for a test that does not parse SVG. */
export function stopLabels(layout: SessionMapLayout): string[] {
  return layout.stops.map((stop) => stop.label);
}

/** The line labels down the left edge, top to bottom. */
export function rowLabels(layout: SessionMapLayout): string[] {
  return layout.rows.map((row) => row.label);
}

/** The minutes, line by line, as the three shapes the session panel draws. */
export function summaryLines(summary: string): { kind: 'heading' | 'bullet' | 'text'; text: string }[] {
  return summary.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return { kind: 'heading', text: heading[1] };
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) return { kind: 'bullet', text: bullet[1] };
    return { kind: 'text', text: line };
  });
}
