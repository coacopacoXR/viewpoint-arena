// The name chip, and the small menu behind it.
//
// docs/plan/15-sessions-and-variants.md batch BO, from the sketch the user approved:
// "Your avatar colour moves to a small menu behind your name." The lobby used to spend
// most of its height on an identity FORM — a name field, eight colour swatches and a
// collapsible list of roles — standing above the thing the page is actually for. None
// of that changed often enough to deserve the space, and all of it is one decision
// (how you look in the room) made once and then left alone, so it is a menu now.
//
// WHAT STAYS OUTSIDE THE MENU, AND WHY
//
// The NAME, when this browser has no account behind it. Entering a room nameless is
// refused today and stays refused — a tracker item, a meeting's attendee list and a
// card's assignee are all a name, and "Guest" in a record of who decided what is a
// record of nothing. So when there is no name yet, the field is drawn INLINE above the
// actions rather than hidden behind a chip, and the chip is not offered at all: a menu
// you have to open to find the one box the page will not let you skip is a box nobody
// fills in. With a signed-in account the name comes from the account and is not
// editable, so the chip carries it and the menu holds colour, role and Sign out.
//
// Drawn in the app's own light style — white, gray-200 rules, black ink, mono
// uppercase labels — copied from components/UI/room/TopBar.tsx rather than invented.

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LogOut } from 'lucide-react';
import { clsx } from 'clsx';
import { AVATAR_COLORS } from '../../lib/identity';

/** The roles a person may say they hold. Optional, and the same list the lobby has always offered. */
export const IDENTITY_ROLES = ['Engineer', 'Designer', 'Systems Architect', 'Reviewer', 'Observer'] as const;

const LABEL = 'font-mono text-[9px] font-bold text-gray-400 uppercase tracking-widest';

export interface IdentityChipProps {
  name: string;
  color: string;
  role: string;
  /** True when there is an account to sign out of — a guest and a 'none' install have none. */
  canSignOut: boolean;
  /** True when the name is this browser's to type: no account is standing behind it. */
  nameEditable: boolean;
  onName: (name: string) => void;
  onColor: (color: string) => void;
  onRole: (role: string) => void;
  onSignOut: () => void;
}

/** The round initial, which is the same avatar the room draws for a participant. */
export const Avatar: React.FC<{ name: string; color: string; size?: number }> = ({
  name,
  color,
  size = 22,
}) => (
  <span
    className="inline-grid place-items-center rounded-full border-2 border-white font-bold text-white shrink-0"
    style={{ backgroundColor: color, width: size, height: size, fontSize: Math.round(size * 0.42) }}
    aria-hidden="true"
  >
    {(name.trim()[0] ?? '?').toUpperCase()}
  </span>
);

const IdentityChip: React.FC<IdentityChipProps> = ({
  name,
  color,
  role,
  canSignOut,
  nameEditable,
  onName,
  onColor,
  onRole,
  onSignOut,
}) => {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Closed by a click anywhere else, or by Escape. A menu that only closes on its own
  // chip is one a person leaves open and then cannot see the grid behind.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="identity-chip"
        title="Your name, colour and role"
        className={clsx(
          'inline-flex items-center gap-2 h-9 pl-1.5 pr-2 rounded-md border bg-white transition-colors',
          open ? 'border-black text-black' : 'border-gray-200 text-gray-700 hover:border-gray-400 hover:text-black',
        )}
      >
        <Avatar name={name} color={color} size={22} />
        <span className="text-xs font-semibold max-w-[9rem] truncate">
          {name.trim() === '' ? 'Your name' : name.trim()}
        </span>
        <ChevronDown size={13} className={clsx('text-gray-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="identity-menu"
          className="absolute right-0 top-full mt-1.5 w-64 rounded-md border border-gray-200 bg-white shadow-lg z-30 overflow-hidden"
        >
          {nameEditable && (
            <div className="px-3 py-2.5 border-b border-gray-100">
              <label htmlFor="lobby-chip-name" className={clsx('block mb-1.5', LABEL)}>Your name</label>
              <input
                id="lobby-chip-name"
                type="text"
                value={name}
                maxLength={40}
                onChange={(event) => onName(event.target.value)}
                placeholder="e.g. Alex Chen"
                className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-900 outline-none focus:border-black placeholder:text-gray-300"
              />
            </div>
          )}

          <div className="px-3 py-2.5 border-b border-gray-100">
            <p className={clsx('mb-1.5', LABEL)}>Avatar colour</p>
            <div className="flex gap-1.5 flex-wrap">
              {AVATAR_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  onClick={() => onColor(swatch)}
                  title={color === swatch ? 'Your colour' : 'Use this colour'}
                  aria-label={`Avatar colour ${swatch}`}
                  aria-pressed={color === swatch}
                  className={clsx(
                    'w-6 h-6 rounded-full border-2 transition-transform hover:scale-110',
                    color === swatch ? 'border-black' : 'border-transparent',
                  )}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </div>

          <div className="px-3 py-2.5 border-b border-gray-100">
            <p className={clsx('mb-1.5', LABEL)}>Role (optional)</p>
            <div className="flex flex-col gap-0.5">
              {IDENTITY_ROLES.map((option) => (
                <button
                  key={option}
                  onClick={() => onRole(role === option ? '' : option)}
                  className={clsx(
                    'flex items-center gap-1.5 px-2 py-1 rounded text-xs text-left transition-colors',
                    role === option ? 'bg-black text-white' : 'text-gray-600 hover:bg-gray-100 hover:text-black',
                  )}
                >
                  <Check size={11} className={role === option ? 'opacity-100' : 'opacity-0'} />
                  {option}
                </button>
              ))}
            </div>
          </div>

          {canSignOut && (
            <button
              onClick={() => { setOpen(false); onSignOut(); }}
              data-testid="identity-sign-out"
              className="w-full flex items-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 hover:text-black transition-colors"
            >
              <LogOut size={13} />
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default IdentityChip;
