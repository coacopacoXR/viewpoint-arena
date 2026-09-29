// One design review, as a card in the lobby's grid.
//
// docs/plan/15-sessions-and-variants.md batch BO, from the sketch the user approved:
// "I want that it is possible from outside to see what the design review looks inside."
// A card answers that with four things and nothing else — a snapshot of the model, the
// review's name, one line of meta, and a miniature of its session map — because a grid
// that has to be read is a grid nobody scans. The detail is the preview panel's job and
// it opens when the card is clicked.
//
// THE SNAPSHOT is a JPEG captured in the room (lib/reviews/thumbnail.ts) and stored on
// the review's own row. A review that has never been captured — every one that existed
// before this batch, and any whose room had no model in it — gets a neutral placeholder
// carrying the model's own file name, which is still an answer to "what is this one
// about" and costs no request.
//
// THE COUNTS are the cards still open, by kind, in the tracker's own colours. They are
// squares and not badges: three numbers side by side are a shape the eye reads at a
// glance, and a pill per kind is three pills.

import React from 'react';
import { clsx } from 'clsx';
import MiniSessionMap from '../review/MiniSessionMap';
import { metaLineOf } from '../../lib/lobby/useLobbyData';
import type { LobbyReview } from '../../lib/lobby/useLobbyData';

/** The three kinds of card, and the colour the tracker already gives each of them. */
const CARD_KINDS = [
  { type: 'RISK', colour: '#dc2626', word: 'risk' },
  { type: 'ACTION', colour: '#2563eb', word: 'action' },
  { type: 'RATIONALE', colour: '#d97706', word: 'rationale' },
] as const;

export interface ReviewCardProps {
  review: LobbyReview;
  selected: boolean;
  onSelect: () => void;
}

const ReviewCard: React.FC<ReviewCardProps> = ({ review, selected, onSelect }) => {
  const open = review.openCards;
  const total = open.RISK + open.ACTION + open.RATIONALE;

  return (
    <article
      className={clsx(
        'flex flex-col rounded-lg border bg-white overflow-hidden text-left transition-shadow cursor-pointer',
        selected ? 'border-black shadow-[0_0_0_1px_#000]' : 'border-gray-200 hover:border-gray-400',
      )}
      data-testid="review-card"
      data-selected={selected ? 'true' : undefined}
    >
      <button
        onClick={onSelect}
        aria-pressed={selected}
        className="flex flex-col text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-black"
        title={selected ? 'This design review is open in the preview' : 'Preview this design review'}
      >
        {/* The snapshot, 16:9, or a placeholder that names the model. */}
        <div className="relative w-full border-b border-gray-200 bg-gradient-to-b from-[#f7f8fa] to-[#eceef2]" style={{ aspectRatio: '16 / 9' }}>
          {review.thumbnail ? (
            <img
              src={review.thumbnail}
              alt={`The model this design review is looking at`}
              className="absolute inset-0 w-full h-full object-cover"
              data-testid="review-card-thumbnail"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center px-3" data-testid="review-card-placeholder">
              <p className="font-mono text-[10px] uppercase tracking-widest text-gray-400 text-center truncate w-full">
                {review.modelName ?? 'No model yet'}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 px-3.5 py-3">
          <h3 className="text-sm font-semibold text-gray-900 leading-snug line-clamp-2">
            {review.title.trim() === '' ? `Design review ${review.id.slice(0, 8)}` : review.title}
          </h3>
          <p className="text-xs text-gray-500 leading-snug">{metaLineOf(review)}</p>

          <div className="h-[34px]">
            <MiniSessionMap lines={review.lines} sessions={review.sessions} />
          </div>

          {/* Open cards, by kind. "No cards yet" rather than three zeroes: a review
              that has never met has nothing open and saying 0 · 0 · 0 reads like a
              score rather than like an absence. */}
          {total > 0 ? (
            <p className="flex items-center gap-2.5 font-mono text-[11px] font-bold text-gray-800">
              {CARD_KINDS.map((kind) => (
                <span key={kind.type} className="inline-flex items-center gap-1" title={`${open[kind.type]} open ${kind.word}`}>
                  <span className="w-[7px] h-[7px] rounded-[2px] inline-block" style={{ backgroundColor: kind.colour }} />
                  {open[kind.type]}
                </span>
              ))}
              <span className="text-gray-400 font-medium">open</span>
            </p>
          ) : (
            <p className="font-mono text-[11px] font-medium text-gray-400">No cards yet</p>
          )}
        </div>
      </button>
    </article>
  );
};

export default ReviewCard;
