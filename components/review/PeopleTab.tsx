// The curation panel's People tab: who is on this design review, and — for the
// owner — who else may be.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. This is the screen that makes
// lib/reviews/roles.ts something a person can act on: making a colleague an editor
// is what lets them press Edit in the room, and until now the only way to change a
// review's roster was a SQL client.
//
// Two things this tab does NOT do, both on purpose:
//
//   • It does not decide who may change the list. api/reviews/members.ts decides,
//     from the caller's verified token and the roster as the database holds it, and
//     answers with `canManage`. Rendering the controls from that flag rather than
//     from a second reading of the same rule is what keeps the screen and the
//     endpoint from ever disagreeing about who is allowed.
//   • It does not create accounts. Adding somebody needs an address that already
//     signs in to this install, because a permission has to be keyed on an account
//     and not on a name somebody typed. Creating the account is the admin console's
//     job, and the sentence an unmatched email gets says so.
//
// Absent entirely on a deployment whose identity.mode is 'none': there are no
// accounts there, so there is no roster to show and nothing a row could be keyed
// on. The meeting host edits freely, as the curate page always allowed.

import React, { useState } from 'react';
import { Crown, UserPlus, Users, X } from 'lucide-react';
import {
  ASSIGNABLE_ROLES,
  ROLE_LABEL,
  useReviewPeople,
} from '../../lib/reviews/useReviewPeople';
import type { MemberRole } from '../../lib/reviews/roles';

const PeopleTab: React.FC<{
  reviewId: string;
  /** Called after a write lands, so the room can re-read its own role. */
  onRosterChanged?: () => void;
}> = ({ reviewId, onRosterChanged }) => {
  // The read, the writes and the error mapping are lib/reviews/useReviewPeople, which
  // the lobby's preview panel shares: one reading of api/reviews/members.ts rather than
  // two. What is left here is this tab's own layout, drawn for the room's dark panel —
  // components/lobby/PeopleSection.tsx is the same roster in the lobby's light one.
  const { people, ownerId, canManage, canClaimOwner, error, busy, reload, write, add } =
    useReviewPeople(reviewId, onRosterChanged);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>('participant');

  if (people === null) {
    return (
      <div className="p-5 flex flex-col gap-3">
        <p className="text-[11px] text-gray-500 leading-relaxed">
          {error ?? 'Reading who is on this review…'}
        </p>
        {error && (
          <button
            onClick={() => void reload()}
            className="self-start px-3 py-1.5 rounded bg-white/10 text-[11px] font-bold text-gray-200 hover:bg-white/20 transition-colors"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-5 flex flex-col gap-3">
      <p className="text-[11px] text-gray-500 leading-relaxed">
        {canManage
          ? 'Editors can turn Edit on in the room and change the review. Participants can take part in the meeting and nothing else.'
          : 'Who is on this design review. Only its owner can change this list.'}
      </p>

      {/* A review created before accounts existed has no owner, so nobody can
          administer it and the roles in it mean nothing. An administrator is
          offered the claim; everybody else just sees an unowned review. */}
      {ownerId === null && (
        <div className="rounded border border-amber-400/30 bg-amber-500/10 p-3 flex flex-col gap-2">
          <p className="text-[11px] text-amber-200 leading-relaxed">
            This review has no owner — it was created before accounts existed on
            this install.
          </p>
          {canClaimOwner && (
            <button
              onClick={() => void write({ action: 'claimOwner' })}
              disabled={busy}
              className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-400 text-black text-[11px] font-bold hover:bg-amber-300 transition-colors disabled:opacity-50"
            >
              <Crown size={12} /> Make me the owner
            </button>
          )}
        </div>
      )}

      {people.length === 0 && ownerId === null && (
        <div className="text-center py-8 text-gray-500 text-xs italic">
          <Users size={28} className="mx-auto mb-2 opacity-30" />
          Nobody is on this review yet
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {people.map((person) => {
          const isOwnerRow = person.userId === ownerId;
          return (
            <div
              key={person.userId}
              className="rounded border border-white/10 bg-white/5 p-2 flex items-center gap-2"
            >
              <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-gray-200 shrink-0">
                {(person.name || person.email || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold text-gray-100 truncate">
                  {person.name || person.email || 'Somebody on this install'}
                </div>
                <div className="text-[10px] font-mono text-gray-500 truncate">
                  {person.email || person.userId.slice(0, 8)}
                </div>
              </div>
              {canManage && !isOwnerRow ? (
                <div className="flex items-center gap-1 shrink-0">
                  <select
                    value={person.role}
                    disabled={busy}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (next !== 'editor' && next !== 'participant') return;
                      void write({ action: 'setRole', userId: person.userId, role: next });
                    }}
                    className="bg-white/5 text-[10px] font-bold uppercase rounded px-1.5 py-1 border border-white/10 outline-none text-gray-300"
                  >
                    {ASSIGNABLE_ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => void write({ action: 'remove', userId: person.userId })}
                    disabled={busy}
                    className="text-gray-500 hover:text-red-400 disabled:opacity-50"
                    title="Remove from this review"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-400 shrink-0">
                  {ROLE_LABEL[person.role]}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <div className="rounded border border-dashed border-white/20 p-3 flex flex-col gap-2">
          <label className="text-[10px] font-bold uppercase tracking-widest text-gray-500">
            Add somebody
          </label>
          <div className="flex gap-1.5">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email address"
              className="text-gray-100 flex-1 min-w-0 bg-white/5 text-xs rounded px-2 py-1.5 border border-white/10 outline-none focus:border-emerald-400/50 placeholder:text-gray-600"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value === 'editor' ? 'editor' : 'participant')}
              className="bg-white/5 text-[10px] font-bold uppercase rounded px-1.5 py-1.5 border border-white/10 outline-none text-gray-300 shrink-0"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => {
              // The empty-box sentence lives in the hook, so this tab and the lobby's
              // People section cannot drift into two answers for the same mistake.
              setEmail('');
              void add(email, role);
            }}
            disabled={busy}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded bg-white text-gray-900 text-[11px] font-bold hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <UserPlus size={12} /> {busy ? 'Working…' : 'Add'}
          </button>
          <p className="text-[10px] text-gray-600 leading-relaxed">
            They need an account on this install already. An administrator creates
            those, in the admin console.
          </p>
        </div>
      )}

      {error && <p className="text-[11px] text-red-400 leading-relaxed">{error}</p>}
    </div>
  );
};

export default PeopleTab;
