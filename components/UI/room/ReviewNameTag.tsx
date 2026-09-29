// Which design review this room is holding, in the room's own top-left corner.
//
// docs/plan/15-sessions-and-variants.md batch BQ. The user's complaint was that
// there was no way to name a review; naming one is only half of it, because a name
// nobody can see in the meeting is a name that exists in a database. So the name is
// shown where every other screen in this app shows what it is looking at — beside
// the logo and the way back to the lobby — and it is shown to EVERYBODY in the room,
// not only to the people who may edit the review: knowing which review you are in is
// what makes it possible to take part in it, which is the same reason the top bar's
// Sessions button is not permission-gated.
//
// A VARIANT room says so here as well ("Door hinge, rev C · Variant A"). LineChip
// already carries the variant's own name and its two decisions, and this does not
// repeat them — it says which review the variant belongs to, which is the thing the
// chip cannot: two reviews can each have a Variant A, and a room showing only
// "Variant A" does not say which.
//
// Truncated, with the whole name in `title`, because a review is named by a person
// in a hurry and the left column is 300px wide.

import React from 'react';
import { shortLineLabel, type ReviewLine } from '../../../lib/reviews/lines';

export interface ReviewNameTagProps {
  /** The review's name, or null when this room is holding no design review. */
  title: string | null;
  /** The line this room resolved itself to. Null on the main line. */
  line?: ReviewLine | null;
  /** 'light' for the desktop room's white chrome, 'dark' for a white-on-black header. */
  tone?: 'light' | 'dark';
}

const ReviewNameTag: React.FC<ReviewNameTagProps> = ({ title, line = null, tone = 'light' }) => {
  const name = title?.trim() ?? '';
  if (name === '') return null;

  const variant = shortLineLabel(line);
  const shown = line?.kind === 'variant' && variant ? `${name} · ${variant}` : name;

  return (
    <span
      data-testid="review-name-tag"
      title={shown}
      aria-label={shown}
      className={
        tone === 'dark'
          ? 'pointer-events-none inline-block max-w-[26ch] truncate align-middle font-mono text-[10px] font-bold tracking-wide text-gray-300'
          : 'pointer-events-none inline-block max-w-[26ch] truncate align-middle font-mono text-[10px] font-bold tracking-wide text-gray-600'
      }
    >
      {shown}
    </span>
  );
};

export default ReviewNameTag;
