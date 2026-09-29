// The lobby's actions row: start a review, join one, and narrow the grid.
//
// docs/plan/15-sessions-and-variants.md batch BO, from the approved sketch. Three
// things sit in one row because they are the three things a person does from a lobby,
// and the page under them is the grid of design reviews rather than a form.
//
// ONE BUTTON THAT STARTS A REVIEW, NOT TWO. Batch BN made the lobby's "New session"
// write a design review row exactly the way "New design review" does, and left the two
// differing in one respect: whether the room opens with Edit on. Since every room
// started from the lobby IS a design review, "New session" had become "New design
// review, but do not turn Edit on" — a second button whose whole meaning was a query
// parameter. It is dropped here, and the room opens with Edit on, because the person
// who just created a review is the person who is about to put a model in it: without
// Edit they land in a room where the import is locked until somebody else hands it over.
//
// The JOIN box takes a bare id or a whole pasted link, including the `?line=` of a
// variant, through lib/lobby/joinTarget — the link somebody was sent is the thing they
// have, and unpicking it by hand before it can be used is the reason the box was
// avoided.

import React, { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import { LOBBY_FILTERS, type LobbyFilter } from '../../lib/lobby/useLobbyData';
import { MAX_REVIEW_TITLE } from '../../lib/reviewSetupStore';

export interface LobbyActionsProps {
  filter: LobbyFilter;
  onFilter: (filter: LobbyFilter) => void;
  /** How many reviews each chip would show, so a chip with nothing behind it says so. */
  counts: Record<LobbyFilter, number>;
  joinValue: string;
  onJoinValue: (value: string) => void;
  onJoin: () => void;
  /**
   * Create a review, with the name typed in the field the button opens.
   *
   * '' is a valid answer and means "nobody named it": the row is created as
   * "Untitled design review" exactly as it was before the field existed, because
   * the button has to keep working for the person who just wants a room and will
   * name it later from inside it.
   */
  onNewReview: (name: string) => void;
  /** True while the review row is being written, so a second click cannot make a second one. */
  creating: boolean;
  /**
   * False for a guest, who may enter the room they were invited to and start nothing.
   * The button is hidden rather than disabled: a control greyed out for somebody who
   * will never have it is a question the page then has to answer.
   */
  mayStart: boolean;
  /**
   * False for a guest, and for the same reason the grid is one card for them: the chips
   * narrow a set of reviews they were never given, and a count on a chip is a statement
   * about how many reviews this install holds. The old lobby hid its lists from a guest
   * for exactly that reason; hiding the chips is the same decision.
   */
  showFilters: boolean;
}

/**
 * "+ New design review", which opens into the one question worth asking first.
 *
 * Batch BQ. Every review this lobby ever created was called "Untitled design review"
 * and nothing anywhere wrote `review_curations.title`, so the grid was a wall of
 * identical cards and the only way to tell two reviews apart was to open them. The
 * name is asked for HERE rather than in the room, because the lobby is where the
 * review is born and the card it becomes is the first thing anybody sees of it —
 * and it is asked INLINE, in place of the button, rather than in a dialog: a dialog
 * cannot be styled to the row that offered it and hides the grid behind the question.
 *
 * Skippable. Enter on an empty field creates the untitled review, which is what the
 * button did before, so nobody who just wants a room has to think of a name for it.
 */
const NewReviewButton: React.FC<{ creating: boolean; onNewReview: (name: string) => void }> = ({
  creating,
  onNewReview,
}) => {
  const [naming, setNaming] = useState(false);
  const [value, setValue] = useState('');

  if (!naming) {
    return (
      <button
        onClick={() => { setValue(''); setNaming(true); }}
        disabled={creating}
        data-testid="new-design-review"
        className={clsx(
          'inline-flex items-center gap-1.5 h-11 px-4 rounded-md text-sm font-semibold transition-colors',
          'bg-black text-white hover:bg-gray-800 disabled:opacity-50',
        )}
      >
        <Plus size={15} />
        {creating ? 'Creating…' : 'New design review'}
      </button>
    );
  }

  return (
    <div className="flex h-11 items-stretch rounded-md border border-black bg-white overflow-hidden" data-testid="new-design-review-name">
      <input
        type="text"
        value={value}
        autoFocus
        disabled={creating}
        maxLength={MAX_REVIEW_TITLE}
        aria-label="Name this design review"
        data-testid="new-design-review-field"
        placeholder="e.g. Door hinge, rev C"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onNewReview(value);
          // Cancelling leaves nothing behind: no row was written, so there is
          // nothing to undo and no second button to press.
          if (event.key === 'Escape' && !creating) setNaming(false);
        }}
        className="w-56 max-w-[52vw] px-3 text-[13px] text-gray-900 outline-none placeholder:text-gray-400 bg-transparent"
      />
      <button
        onClick={() => onNewReview(value)}
        disabled={creating}
        data-testid="new-design-review-create"
        className="px-3.5 border-l border-gray-200 bg-black text-[13px] font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-50"
      >
        {creating ? 'Creating…' : 'Create'}
      </button>
      <button
        onClick={() => setNaming(false)}
        disabled={creating}
        title="Cancel"
        aria-label="Cancel"
        className="px-2.5 border-l border-gray-200 bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-black transition-colors disabled:opacity-50"
      >
        <X size={14} />
      </button>
    </div>
  );
};

const LobbyActions: React.FC<LobbyActionsProps> = ({
  filter,
  onFilter,
  counts,
  joinValue,
  onJoinValue,
  onJoin,
  onNewReview,
  creating,
  mayStart,
  showFilters,
}) => (
  <div className="flex items-stretch gap-2.5 flex-wrap">
    {mayStart && <NewReviewButton creating={creating} onNewReview={onNewReview} />}

    <div className="flex h-11 rounded-md border border-gray-200 bg-white overflow-hidden focus-within:border-black transition-colors">
      <input
        type="text"
        value={joinValue}
        onChange={(event) => onJoinValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') onJoin(); }}
        placeholder="Room code or link"
        aria-label="Room code or link"
        className="w-52 max-w-[50vw] px-3 text-[13px] text-gray-900 outline-none placeholder:text-gray-400 bg-transparent"
      />
      <button
        onClick={onJoin}
        data-testid="join-button"
        className="px-3.5 border-l border-gray-200 bg-gray-50 text-[13px] font-semibold text-gray-700 hover:bg-gray-100 hover:text-black transition-colors"
      >
        Join
      </button>
    </div>

    {showFilters && (
    <div className="flex items-center gap-1.5 ml-auto flex-wrap" role="group" aria-label="Which design reviews to show">
      {LOBBY_FILTERS.map((option) => (
        <button
          key={option.id}
          onClick={() => onFilter(option.id)}
          aria-pressed={filter === option.id}
          data-testid={`filter-${option.id}`}
          className={clsx(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-xs transition-colors',
            filter === option.id
              ? 'bg-black border-black text-white'
              : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400 hover:text-black',
          )}
        >
          {option.label}
          <span className={clsx('font-mono text-[10px] tabular-nums', filter === option.id ? 'opacity-70' : 'text-gray-400')}>
            {counts[option.id]}
          </span>
        </button>
      ))}
    </div>
    )}
  </div>
);

export default LobbyActions;
