// "You are on Variant A · Steel hinge pin" — the chip in a variant's own top bar,
// and since batch BV the "Lines" menu in the main line's.
//
// docs/plan/15-sessions-and-variants.md batch BL. A variant meets in a DIFFERENT
// room from the review's main line (`<reviewId>~<letter>`, its own presence, its own
// audio, its own scene), and the address that puts you there is
// `/room/<id>?line=<lineId>` — which looks exactly like the main line's address to
// somebody who arrived by a link. Without a say-so on screen, the meeting that spends
// an hour on a steel hinge pin and never notices it is not on the main line is the
// failure this prevents, and it is a silent one: nothing else in the room looks
// different, because that is the point of a variant.
//
// So: the chip names the line, and the panel it opens carries the way back to the main
// line's room — plus, for the review's owners and editors, the two things you can do with
// a variant from inside it: adopt it into the main line, or drop it. All of it BEHIND the
// chip rather than beside it, because the top bar is full: batch BQ2 took the "Main line"
// button that used to sit next to the chip and put it in here, and gave the bar a measured
// compact state, for exactly that reason. A control nobody can reach is still worse than
// one that needs a click.
//
// BATCH BV added the list. A variant that has never met had no session to click on the
// map and so no way back into it from anywhere but its address, and the only route
// between two lines of one review was out to the lobby and in again. Both panels now
// list every line still being explored, each one a link, so moving between the main line
// and its variants never leaves the room. On the main line the control is a small
// "Lines" menu and nothing else: it has no variant to adopt or drop, and a chip reading
// "You are on Main line" in every room that ever existed would be furniture in all of
// them to say something nobody had wondered about.
//
// Renders NOTHING where there is no line at all — an ad-hoc room, and an install with
// no database.

import React, { useEffect, useState } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { useNavigate } from 'react-router-dom';
import {
  lineLabel,
  orderedLines,
  shortLineLabel,
  type ReviewLine,
} from '../../../lib/reviews/lines';
import { listLines } from '../../../lib/reviews/linesRepo';
import { openLine, roomHref } from '../../../lib/reviews/openLine';
import StartVariant from '../../review/StartVariant';
import { VariantActions } from '../../review/VariantActions';

export interface LineChipProps {
  /** The review's id, which is the room's id. */
  roomId: string;
  /**
   * The line this room resolved itself to. Null for an ad-hoc room and on an install
   * with no database, and this renders nothing for either.
   */
  line: ReviewLine | null;
  /** can('editReview') — whether the two actions belong on the chip at all. */
  mayEdit: boolean;
  /** Whether this browser is running the meeting. Read on an install with no accounts. */
  isMeetingHost?: boolean;
}

const ROW =
  'h-8 px-2 flex items-center gap-1.5 rounded-sm border transition-colors text-[10px] font-bold uppercase tracking-wide';

const LineChip: React.FC<LineChipProps> = ({ roomId, line, mayEdit, isMeetingHost }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  /** Every line of the review, read when the panel is first opened. Null until then. */
  const [all, setAll] = useState<ReviewLine[] | null>(null);

  // Read on opening rather than on mount: a room that never opens the panel pays no
  // query, and `listLines` caches per review anyway, so the second opening is free.
  useEffect(() => {
    if (!open || all !== null || !line) return;
    let cancelled = false;
    void listLines(roomId).then((lines) => {
      if (!cancelled && lines.length > 0) setAll(lines);
    });
    return () => { cancelled = true; };
  }, [open, all, line, roomId]);

  if (!line) return null;

  const onVariant = line.kind === 'variant';
  const full = lineLabel(line) ?? 'Variant';
  const short = onVariant ? shortLineLabel(line) ?? 'Variant' : 'Lines';

  /**
   * Move this room onto another line of the same review.
   *
   * `openLine` and NOT a <Link>, and that is the whole of batch BX's first fix: the
   * room's entry guard admits an arrival by its router state or by a sessionStorage
   * mark, and a plain link carries neither — so the address was right and the room
   * still sent the person straight back to the lobby. The helper writes the mark and
   * the state, which is also what makes the reload of the room it lands in work.
   */
  const go = (lineId: string | null) => {
    setOpen(false);
    openLine(navigate, roomId, lineId);
  };

  // One row per line: its name, and whether this browser is standing in it.
  const known = orderedLines(all ?? []);
  const current = known.find((one) => one.id === line.id) ?? line;
  // The main line is ALWAYS a row, and it is the first one. It is the way back, and on
  // an install whose lines could not be read it is the only row there is — a variant's
  // panel with nothing but its own name in it is a dead end with the address bar as the
  // only exit, which is what this chip was written to remove. The variants after it are
  // the ones still being explored, plus this one whatever its status: a variant that
  // was merged while its room was open is still the room somebody is standing in.
  //
  // Merged and dropped lines are otherwise NOT here (batch BX). Both are records, and
  // a row in a menu is an offer to go somewhere — into a room whose model can no longer
  // be changed and whose cards have already moved. The map and the lobby's Lines list
  // are where they are kept, and the map has a "Show dropped" toggle for the person who
  // wants to look at one.
  const rows: Array<{ key: string; name: string; lineId: string | null; title: string; here: boolean }> = [
    {
      key: 'main',
      name: 'Main line',
      lineId: null,
      title: 'Go to the main line’s room',
      here: !onVariant,
    },
    ...known
      .filter((one) => one.kind === 'variant' && (one.status === 'active' || one.id === current.id))
      .map((one) => {
        const name = lineLabel(one) ?? 'Variant';
        return { key: one.id, name, lineId: one.id, title: `Go to ${name}’s room`, here: one.id === current.id };
      }),
  ];

  return (
    <div className="relative shrink-0 flex items-center" data-testid="line-chip">
      {/* One control, and it is a button for EVERYBODY in the room. It used to be a
          chip with a second button beside it — "Main line →" — which is how the top bar
          came to hold twelve controls and stop fitting; the way back is a thing you
          choose once you know you are somewhere else, so it lives in the panel the chip
          opens. Somebody who may not change the review gets the same chip and the same
          panel, with only the links in it: knowing which lines a review has is what
          lets you take part in the meeting, and a participant with no route between
          them is a participant who has to edit the address bar. */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid={onVariant ? 'line-chip-button' : 'lines-menu-button'}
        title={
          onVariant
            ? mayEdit
              ? `You are on ${full}. Merge it into another line, or drop it.`
              : `You are on ${full}`
            : 'This design review’s lines'
        }
        className={clsx(
          'h-9 px-2 flex items-center gap-1.5 rounded-sm border transition-all pointer-events-auto',
          onVariant
            ? 'bg-violet-50 text-violet-800 border-violet-200 hover:border-violet-400'
            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-black',
        )}
      >
        <span className="text-[10px] font-bold uppercase tracking-wide max-w-[16ch] truncate">
          {onVariant ? `You are on ${full}` : 'Lines'}
        </span>
        <ChevronDown size={13} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className={clsx(
            'absolute top-10 left-0 z-50 max-w-[80vw] bg-white border border-gray-200 rounded-md shadow-lg p-3 pointer-events-auto',
            mayEdit ? 'w-[380px]' : 'w-64',
          )}
          data-testid="line-chip-panel"
        >
          <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-2">
            {onVariant ? short : 'Lines'}
          </p>

          {/* Every line still being explored. The one this room is on is named rather
              than linked: a link to the room you are standing in is a thing to press
              by accident, and it would look like the other rows. */}
          <p className="font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1">Go to…</p>
          <ul className="flex flex-col gap-1" data-testid="line-chip-lines">
            {rows.map((row) => (
              <li key={row.key}>
                {row.here ? (
                  <span
                    className={clsx(ROW, 'border-gray-200 bg-gray-50 text-gray-500')}
                    data-testid="line-chip-here"
                  >
                    <span className="truncate normal-case font-semibold tracking-normal">{row.name}</span>
                    <span className="ml-auto font-mono text-[9px] text-gray-400">here</span>
                  </span>
                ) : (
                  <button
                    onClick={() => go(row.lineId)}
                    title={row.title}
                    // Where it goes, readable without navigating: tests and anybody
                    // inspecting the page. The navigation itself is openLine's.
                    data-href={roomHref(roomId, row.lineId)}
                    data-testid="line-chip-go"
                    className={clsx(
                      ROW,
                      'w-full text-left border-gray-200 bg-white text-gray-600 hover:border-gray-400 hover:text-black',
                    )}
                  >
                    <span className="truncate normal-case font-semibold tracking-normal">{row.name}</span>
                    <ArrowRight size={12} className="ml-auto shrink-0" />
                  </button>
                )}
              </li>
            ))}
          </ul>

          {/* Start a variant from the line this room is on — batch BX, and offered on
              EVERY line rather than only in the map's session panel, because the person
              who has just moved a model and wants a second answer to it is standing here
              and not looking at a diagram. The same component the top bar's own Variant
              button uses, so the words, the prompt and the write cannot drift. */}
          {mayEdit && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <StartVariant
                reviewId={roomId}
                lineId={line.id}
                mayEdit={mayEdit}
                isMeetingHost={isMeetingHost}
                label="Explore a variant from here"
                look="row"
                inFlow
                data-testid="line-chip-explore"
                onStarted={() => setAll(null)}
              />
            </div>
          )}

          {onVariant && mayEdit && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <VariantActions
                reviewId={roomId}
                variant={line}
                lines={all ?? undefined}
                mayEdit={mayEdit}
                isMeetingHost={isMeetingHost}
                onOpenLine={go}
                inRoom
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LineChip;
