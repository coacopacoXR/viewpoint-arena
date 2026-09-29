// The session map, small enough for a lobby card.
//
// docs/plan/15-sessions-and-variants.md batch BO, from the approved lobby sketch:
// every card for a design review carries a miniature of that review's history,
// because the shape is the part worth knowing before opening it — how far the main
// line has got, whether anything has left it, and whether what left was taken in or
// dropped. So this draws the same picture SessionMap draws: the main line as a dark
// line of stops, a variant leaving it, an adopted variant coming back to a green
// stop, a dropped one going grey and dashed, and the meeting the main line is at now
// filled in. No labels, no counts, nothing to press.
//
// IT IS NOT A SECOND LAYOUT. layoutSessionMap places every stop and every line,
// exactly as it does for the full map, and this file only decides how thickly to draw
// what it is handed. A miniature that worked out its own positions would eventually
// disagree with the map it is a miniature of, and a card showing a different shape
// from the review it opens is worse than a card showing none.
//
// Everything here is measured in scaled units rather than in the numbers SessionMap
// uses, because `preserveAspectRatio="meet"` shrinks the whole viewBox into 34px of
// height: a stroke written as 2 units arrives a sixth of that wide, which is a line
// nobody can see. See `unitOf`.
//
// THE WORDS ARE THE SPEC, as they are in SessionMap.tsx: "Main line", "Variant A",
// "session", "adopted", "dropped". Branch, fork, merge and commit do not appear here
// — not in the aria-label, not in a tooltip, not in a comment a reader could be shown.

import React, { useMemo } from 'react';
import { layoutSessionMap, type MapEdge, type MapStop, type SessionMapLayout } from './SessionMap';
import type { ReviewLine } from '../../lib/reviews/lines';
import type { LineSession } from '../../lib/reviews/linesRepo';

/** The height a lobby card gives this drawing, in CSS pixels. `.mini{height:34px}`. */
const HEIGHT_PX = 34;

/**
 * SessionMap's spacing between two stops, which is where the elbow of a 'leave' or a
 * 'rejoin' line turns: half a step back from the stop it lands on. Duplicated rather
// than imported because `edgePath` is drawing and not layout, and the two files have
// to agree on the turn only, not on anything that could drift out of step.
 */
const STEP = 140;

const INK = '#111827';
const ADOPTED = '#059669';
const DROPPED = '#d1d5db';
const VARIANT_INK = '#7c3aed';
const HOLLOW = '#ffffff';

/**
 * Stroke widths and radii, in units of `unitOf(layout.height)` — so ~3 and ~6 for a
 * main line on its own, and proportionally thicker once variant rows make the viewBox
 * taller and the scale smaller. SessionMap's own 2 / 1.5 / 14 would arrive here under
 * a pixel wide.
 *
 * RADIUS is the one of them written against the SCREEN rather than against the drawing:
 * a stop is a dot somebody has to recognise at a glance, so it arrives with a 4 CSS
 * pixel radius however many rows the map has, and in viewBox units that is four of these
 * — `unitOf` is exactly the shrink the scale undoes. At 2 the dot was 2px across on a
 * main line alone and under 1.5px once two variant rows had shrunk the scale further,
 * which is a dot that has to be squinted at.
 */
const ALONG = 1;
const ELBOW = 0.85;
const RADIUS = 4;
/** Dash length for a dropped line, which has to survive the same shrink. */
const DASH = 2.4;

/**
 * A drawn pixel's worth of viewBox units, i.e. how much everything here has to be
 * scaled up to arrive on screen the size it was written to be.
 *
 * `meet` fits the whole viewBox inside the 34px-tall box, and the height is what
 * binds on a card — these maps are far wider than they are tall — so the scale is
 * `HEIGHT_PX / layout.height`: 0.33 for a main line alone, 0.17 with one variant row
 * under it, 0.12 with two.
 *
 * Capped, because a review with five variant rows would otherwise draw stops wider
 * than the gap between the rows they sit on, and at that scale the rows are 6px apart
 * on screen: a blob is not a better answer than a faint line.
 */
function unitOf(height: number): number {
  return Math.min(height / HEIGHT_PX, 8);
}

/** The elbow an edge takes: across first, then down (or up), then across again. */
function edgePath(edge: MapEdge): string {
  const { from, to } = edge;
  if (edge.kind === 'along') return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midX = to.x - STEP / 2;
  return `M ${from.x} ${from.y} L ${midX} ${from.y} L ${midX} ${to.y} L ${to.x} ${to.y}`;
}

/**
 * The meeting the main line is at now: its newest stop, which is its rightmost one,
 * because layoutSessionMap places the main line's stops in the order they happened.
 *
 * The green stop an adopted variant rejoins at is further right still and is NOT the
 * answer — it is not a meeting, and the question a filled dot answers on a lobby card
 * is "where has this review got to". A session recorded before lines existed counts as
 * a main-line one, which is the row layoutSessionMap puts it on.
 */
function currentStop(layout: SessionMapLayout): MapStop | null {
  let newest: MapStop | null = null;
  for (const stop of layout.stops) {
    if (stop.rejoin) continue;
    // Batch BV's two markers are not meetings either: the main line's hollow "Start"
    // and the hollow letter a variant with no meetings ends at. Filling the start in
    // would say the review is at a meeting it has not held, and on a card whose main
    // line has never met it is the only stop there is.
    if (stop.start === true || stop.variantEnd === true) continue;
    if ((stop.line?.kind ?? 'main') !== 'main') continue;
    if (!newest || stop.x > newest.x) newest = stop;
  }
  return newest;
}

export interface MiniSessionMapProps {
  /**
   * The review's lines: its main line and every variant, adopted and dropped alike.
   *
   * Dropped ones are not DRAWN — see the filter below. They are still wanted in the
   * prop, because a card's job is to describe the review and "this review has tried and
   * rejected two answers" is part of that; it is the drawing that has no room for them.
   */
  lines: readonly ReviewLine[];
  /** Every session of the review, on every line. */
  sessions: readonly LineSession[];
  /** Sizing and spacing, which belong to the card this sits in and not to the drawing. */
  className?: string;
}

/**
 * A miniature of one design review's session map, for a lobby card.
 *
 * Stateless and non-interactive on purpose: the card it sits in is the link, and a
 * second thing to aim at inside a 34px strip would be a control nobody can hit twice.
 */
export const MiniSessionMap: React.FC<MiniSessionMapProps> = ({ lines, sessions, className }) => {
  // Dropped lines are hidden, and there is deliberately no toggle here. Batch BX: a
  // dropped variant is an answer the review tried and rejected, and it is kept for the
  // record — but the record is the map and the Lines list, both of which have a "Show
  // dropped" toggle. A 34px strip on a lobby card has room for the shape of the review
  // as it stands and nothing else, and a row of grey dashes in it reads as a drawing
  // that went wrong rather than as history. Merged lines stay: they are part of how the
  // review got to where it is, and the green return into the line they went to is the
  // most informative thing this miniature can say.
  const drawn = useMemo(() => lines.filter((line) => line.status !== 'dropped'), [lines]);
  const droppedIds = useMemo(
    () => new Set(lines.filter((line) => line.status === 'dropped').map((line) => line.id)),
    [lines],
  );
  // A meeting held on a line that is not drawn has no row to sit on, so it goes too. It
  // is not lost: the session it belongs to is still in the tracker and still on the map.
  const drawnSessions = useMemo(
    () => sessions.filter((session) => !session.lineId || !droppedIds.has(session.lineId)),
    [droppedIds, sessions],
  );

  // No revisions and no cards: those two only ever produce the labels SessionMap puts
  // under and above a stop, and this drawing has no room for a single character.
  const layout = useMemo(() => layoutSessionMap(drawn, drawnSessions, [], []), [drawn, drawnSessions]);
  const current = useMemo(() => currentStop(layout), [layout]);

  // A review that has not met has no shape to show, and an empty box where a picture
  // should be reads as something that failed to load.
  if (layout.stops.length === 0) {
    return (
      <span data-testid="mini-session-map-empty" className="font-mono text-[10px] text-gray-400">
        No sessions yet
      </span>
    );
  }

  const unit = unitOf(layout.height);
  const dash = `${unit * DASH} ${unit * DASH}`;
  const variants = drawn.filter((line) => line.kind === 'variant').length;
  const label =
    variants === 0
      ? 'Main line, no variants'
      : `Main line and ${variants} ${variants === 1 ? 'variant' : 'variants'}`;

  return (
    <svg
      data-testid="mini-session-map"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      height={HEIGHT_PX}
      preserveAspectRatio="xMinYMid meet"
      role="img"
      aria-label={label}
      className={className}
    >
      {/* The main line itself, from the left edge of the drawing to the meeting the
          review is at.

          layoutSessionMap only ever draws an edge BETWEEN two stops, which is right for
          a review that has met twice and leaves a review that has met once as a single
          dot floating in an empty box — the shape of a card that failed to load, and the
          case most reviews in a new install are in. So the line is drawn here from the
          edge rather than from a first stop: it says "this is the main line and this is
          where it has got to", which is the whole of what the miniature is for, and it
          says it for one meeting as well as for twenty. To the LAST stop, which is the
          same stop `current` fills in, so the line and the filled dot always agree about
          where the review is; an adopted variant's green stop further right is joined to
          it by the layout's own green edge, so the main line stays one unbroken stroke. */}
      {current && (
        <path
          data-testid="mini-main-line"
          d={`M 0 ${current.y} L ${current.x} ${current.y}`}
          fill="none"
          stroke={INK}
          strokeWidth={unit * ALONG}
          strokeLinecap="round"
        />
      )}

      {layout.edges.map((edge) => (
        <path
          key={edge.id}
          d={edgePath(edge)}
          fill="none"
          stroke={edge.colour}
          strokeWidth={unit * (edge.kind === 'along' ? ALONG : ELBOW)}
          strokeDasharray={edge.dashed ? dash : undefined}
          strokeLinecap="round"
          opacity={edge.dashed ? 0.9 : 1}
        />
      ))}

      {layout.stops.map((stop) => {
        const isCurrent = stop === current;
        // Filled for the two stops that mean something at a glance — the review is
        // here, and this variant came back — and hollow for every meeting in between.
        const fill = stop.rejoin ? ADOPTED : isCurrent ? INK : HOLLOW;
        const stroke = stop.rejoin
          ? ADOPTED
          : stop.dropped
            ? DROPPED
            : stop.line?.kind === 'variant'
              ? VARIANT_INK
              : INK;
        return (
          <g
            key={`${stop.session.id}-${stop.x}`}
            data-testid={stop.rejoin ? 'mini-rejoin' : 'mini-stop'}
            data-line={stop.line?.kind ?? 'main'}
            data-dropped={stop.dropped ? 'true' : undefined}
            data-current={isCurrent ? 'true' : undefined}
            data-marker={stop.start === true ? 'start' : stop.variantEnd === true ? 'variant-end' : undefined}
          >
            <circle
              cx={stop.x}
              cy={stop.y}
              r={unit * RADIUS}
              fill={fill}
              stroke={stroke}
              strokeWidth={unit * (stop.rejoin || isCurrent ? ALONG : ELBOW)}
              strokeDasharray={stop.dropped ? dash : undefined}
            />
          </g>
        );
      })}
    </svg>
  );
};

export default MiniSessionMap;
