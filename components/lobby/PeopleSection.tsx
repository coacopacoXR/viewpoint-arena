// Who is on this design review — read from the lobby, and changed from it.
//
// docs/plan/15-sessions-and-variants.md batch BW, from the user's note that "it
// should be possible to add people in the design review straight from the lobby".
// Until now the only way in was the room's Edit panel → People tab, which is three
// clicks past the thing you were doing when you thought of it, and the lobby is
// exactly where a person looks at a review and decides who else needs to see it.
//
// THE ROSTER, THE WRITES AND THE SENTENCES are lib/reviews/useReviewPeople — the
// same hook the room's People tab uses, so the two surfaces cannot disagree about
// what an empty email box says or about when to re-read. What is here is the light
// layout the lobby's preview panel is drawn in, and one difference of substance:
// removal asks INLINE rather than with window.confirm, which is the rule the rest
// of this panel already follows for both of its deletes — a browser dialog cannot
// be styled to the panel that offered it, cannot be tested, and freezes the page
// behind it while it waits.
//
// WHO SEES IT. The section is drawn for the people api/reviews/members.ts lets READ
// a roster (`can(role, 'editReview')` — an owner or an editor), which is the same
// question the panel's `mayEdit` already answers for the name field and "+ Variant",
// and it is drawn only on an install with accounts at all: in identity.mode 'none'
// the endpoint answers 404, there is no roster and nothing a row could be keyed on,
// so the room's People tab is absent there and this is too. Inside the section the
// controls follow the endpoint's own `canManage` rather than a second guess —
// hiding a button is not the enforcement, the endpoint refuses the press anyway.

import React, { useCallback, useState } from 'react';
import { Crown, UserPlus, X } from 'lucide-react';
import { clsx } from 'clsx';
import { Avatar } from './IdentityChip';
import { AVATAR_COLORS } from '../../lib/identity';
import { announceReviewRosterChanged } from '../../lib/reviews/rosterEvents';
import {
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  useReviewPeople,
} from '../../lib/reviews/useReviewPeople';
import type { MemberRole } from '../../lib/reviews/roles';
import type { ReviewPerson } from '../../lib/reviews/membersClient';

const LABEL = 'font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest';
const FIELD =
  'rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 outline-none ' +
  'focus:border-black placeholder:text-gray-300';
const BUTTON =
  'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold ' +
  'transition-colors disabled:opacity-50';
const SECONDARY = 'bg-white border-gray-200 text-gray-600 hover:border-gray-400 hover:text-black';

/** What a person is called here: their name, then their address, then a shrug. */
function nameOf(person: ReviewPerson): string {
  return person.name || person.email || 'Somebody on this install';
}

/**
 * The avatar colour for one account.
 *
 * Hashed from the account id rather than taken by position, because a roster is
 * re-read after every write and can come back in a different order: a colour that
 * moved when a person was added would read as a different person. The colour is
 * still decoration — review_members stores no colour, and the room's own avatar
 * comes from the identity this browser typed.
 */
function colourOf(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export interface PeopleSectionProps {
  reviewId: string;
  /**
   * The roster changed. The lobby re-reads its grid, which is what makes the card's
   * head count and this section agree about who is on the review.
   */
  onChanged: () => void;
}

const PeopleSection: React.FC<PeopleSectionProps> = ({ reviewId, onChanged }) => {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('participant');
  const [adding, setAdding] = useState(false);
  /** The account id whose removal is being asked about. One at a time, and inline. */
  const [removing, setRemoving] = useState<string | null>(null);

  // Told after a write LANDS, never after a refusal: the roster event is what makes
  // any open role check on this page re-read (lib/reviews/rosterEvents), and the grid
  // re-read is what refreshes the card's "3 people".
  const onRosterChanged = useCallback(() => {
    announceReviewRosterChanged(reviewId);
    onChanged();
  }, [reviewId, onChanged]);

  const { people, ownerId, canManage, canClaimOwner, error, busy, reload, write, add } =
    useReviewPeople(reviewId, onRosterChanged);

  const submitAdd = async () => {
    // The box is cleared whatever happens, exactly as the room's tab clears it: a
    // refused address is one the person will retype or give up on, and leaving it
    // in the field invites a second press of the same mistake.
    const typed = email;
    setEmail('');
    const landed = await add(typed, role);
    setAdding(!landed);
  };

  return (
    <div
      className="flex flex-col gap-2 px-4 py-3 border-b border-gray-100"
      data-testid="preview-people"
    >
      <p className={LABEL}>People</p>

      {people === null && !error && (
        <p className="text-[11px] text-gray-500" data-testid="people-loading">
          Reading who is on this review…
        </p>
      )}

      {people !== null && (
        <>
          {/* A review created before accounts existed has no owner, so nobody can
              administer it and the roles in it mean nothing. An administrator is
              offered the claim; everybody else just sees an unowned review. */}
          {ownerId === null && (
            <div className="flex flex-col gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-2">
              <p className="text-[11px] text-gray-600 leading-relaxed">
                This review has no owner — it was created before accounts existed on this
                install.
              </p>
              {canClaimOwner && (
                <button
                  onClick={() => void write({ action: 'claimOwner' })}
                  disabled={busy}
                  data-testid="claim-owner"
                  className={clsx(BUTTON, 'self-start bg-black border-black text-white hover:bg-gray-800')}
                >
                  <Crown size={12} /> Make me the owner
                </button>
              )}
            </div>
          )}

          {people.length === 0 && ownerId !== null && (
            <p className="text-[11px] text-gray-400 italic">Nobody is on this review yet.</p>
          )}

          {people.length > 0 && (
            <ul className="flex flex-col gap-1.5" data-testid="preview-people-rows">
              {people.map((person) => {
                const isOwnerRow = person.userId === ownerId;
                const name = nameOf(person);
                // The owner's row is not re-rollable and not removable: the endpoint
                // refuses both (409) and says to transfer ownership instead, so the
                // controls are not drawn rather than drawn and then refused.
                const mayChangeRow = canManage && !isOwnerRow;
                return (
                  <li key={person.userId} data-testid="preview-person" data-role={person.role}>
                    <div className="flex items-center gap-2">
                      <Avatar name={name} color={colourOf(person.userId)} size={22} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs text-gray-800 truncate">{name}</span>
                        {person.email && person.email !== name && (
                          <span className="block font-mono text-[10px] text-gray-400 truncate">
                            {person.email}
                          </span>
                        )}
                      </span>
                      {mayChangeRow ? (
                        <span className="flex items-center gap-1 shrink-0">
                          <select
                            value={person.role}
                            disabled={busy}
                            data-testid={`person-role-${person.userId}`}
                            aria-label={`Role of ${name}`}
                            onChange={(event) => {
                              const next = event.target.value;
                              if (next !== 'editor' && next !== 'participant') return;
                              void write({ action: 'setRole', userId: person.userId, role: next });
                            }}
                            className={clsx(FIELD, 'text-[10px] font-bold uppercase py-0.5 cursor-pointer')}
                          >
                            {ASSIGNABLE_ROLES.map((assignable) => (
                              <option key={assignable} value={assignable}>
                                {ROLE_LABEL[assignable]}
                              </option>
                            ))}
                          </select>
                          {removing === person.userId ? (
                            <button
                              onClick={() => setRemoving(null)}
                              disabled={busy}
                              data-testid={`cancel-remove-${person.userId}`}
                              title="Keep this person"
                              aria-label={`Keep ${name}`}
                              className={clsx(
                                'w-[22px] h-[22px] grid place-items-center rounded border border-gray-200 bg-white text-gray-400 hover:text-black transition-colors',
                              )}
                            >
                              <X size={12} />
                            </button>
                          ) : (
                            <button
                              onClick={() => setRemoving(person.userId)}
                              disabled={busy}
                              data-testid={`remove-person-${person.userId}`}
                              title="Remove from this review"
                              aria-label={`Remove ${name}`}
                              className="w-[22px] h-[22px] grid place-items-center rounded border border-gray-200 bg-white text-gray-400 hover:border-red-300 hover:text-red-600 transition-colors"
                            >
                              <X size={12} />
                            </button>
                          )}
                        </span>
                      ) : (
                        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-gray-500 shrink-0">
                          {ROLE_LABEL[person.role]}
                        </span>
                      )}
                    </div>

                    {/* The inline "are you sure", which is the only confirmation this
                        section ever shows. */}
                    {removing === person.userId && (
                      <div
                        className="flex flex-col gap-1.5 mt-1.5 ml-[30px]"
                        data-testid="people-inline-confirm"
                      >
                        <p className="text-[11px] text-gray-700 leading-snug">
                          Remove {name} from this design review? They keep their account,
                          and lose the role this review gave them.
                        </p>
                        <span className="flex items-center gap-1.5 flex-wrap">
                          <button
                            onClick={() => {
                              setRemoving(null);
                              void write({ action: 'remove', userId: person.userId });
                            }}
                            disabled={busy}
                            data-testid={`confirm-remove-${person.userId}`}
                            className={clsx(
                              BUTTON,
                              'border-red-600 bg-red-600 text-white hover:bg-red-700',
                            )}
                          >
                            {busy ? 'Working…' : 'Remove'}
                          </button>
                          <button
                            onClick={() => setRemoving(null)}
                            disabled={busy}
                            className={clsx(BUTTON, SECONDARY, 'text-gray-400')}
                          >
                            Cancel
                          </button>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {canManage &&
            (adding ? (
              <div className="flex flex-col gap-1.5" data-testid="add-person-form">
                <span className="flex items-center gap-1.5 flex-wrap">
                  <input
                    type="email"
                    value={email}
                    autoFocus
                    disabled={busy}
                    onChange={(event) => setEmail(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitAdd();
                      if (event.key === 'Escape' && !busy) setAdding(false);
                    }}
                    placeholder="email address"
                    aria-label="Email address"
                    data-testid="add-person-email"
                    className={clsx(FIELD, 'flex-1 min-w-[10rem]')}
                  />
                  <select
                    value={role}
                    disabled={busy}
                    aria-label="Role to add them with"
                    data-testid="add-person-role"
                    onChange={(event) =>
                      setRole(event.target.value === 'editor' ? 'editor' : 'participant')
                    }
                    className={clsx(FIELD, 'text-[10px] font-bold uppercase cursor-pointer')}
                  >
                    {ASSIGNABLE_ROLES.map((assignable) => (
                      <option key={assignable} value={assignable}>
                        {ROLE_LABEL[assignable]}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void submitAdd()}
                    disabled={busy}
                    data-testid="add-person-submit"
                    className={clsx(BUTTON, 'bg-black border-black text-white hover:bg-gray-800')}
                  >
                    <UserPlus size={12} /> {busy ? 'Working…' : 'Add'}
                  </button>
                </span>
                <p className="text-[10px] text-gray-400 leading-relaxed">
                  They need an account on this install already. An administrator creates
                  those, in the admin console.
                </p>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                data-testid="add-person"
                className={clsx(BUTTON, SECONDARY, 'self-start')}
              >
                <UserPlus size={12} /> Add person
              </button>
            ))}
        </>
      )}

      {/* Outside the loaded branch on purpose: a roster that could not be read is the
          one case where the only control worth offering is another read. */}
      {people === null && error && (
        <button
          onClick={() => void reload()}
          data-testid="people-try-again"
          className={clsx(BUTTON, SECONDARY, 'self-start')}
        >
          Try again
        </button>
      )}

      {error && (
        <p className="text-[10px] text-red-600 leading-snug" role="status" data-testid="people-error">
          {error}
        </p>
      )}
    </div>
  );
};

export default PeopleSection;
