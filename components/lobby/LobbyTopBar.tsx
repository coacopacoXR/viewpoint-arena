// The lobby's top bar: the brand, the two other screens, and you.
//
// docs/plan/15-sessions-and-variants.md batch BO. The left column this replaces was a
// 420px panel of marketing — a feature list with emoji on it, a "LIVE TRACKER" block of
// three numbers, and the four most recent sessions — standing beside a form. The user's
// note was that the lobby "sucks" and that they wanted to see what a design review looks
// like from outside. Nothing in that column showed a review, so the column is gone and
// what it linked to is two pills in a bar: Tracker and Admin.
//
// The ADMIN pill is drawn only for somebody the admin screen would let in, using the
// admin screen's own check (lib/access/useAdminGate, which fails LOCKED when the
// endpoint cannot be reached). A link that leads to an unlock form is not a link to the
// admin screen, and on an install with no passphrase configured the page itself says so
// — offering it to everybody would be a button that does nothing.
//
// Style copied from components/UI/room/TopBar.tsx: white pills on a light ground,
// gray-200 rules, black for the thing that is on.
//
// Batch BW made it the app's top bar rather than the lobby's: the tracker wears the
// same one, so the two screens are recognisably the same product. What that needed
// was two props and no second component — `here`, because a bar that offers "Tracker"
// while standing on the tracker offers a link to where you already are, and `actions`,
// because a screen's own controls belong in its bar rather than in a second bar under
// it. The name chip is the lobby's, unchanged, and it is why the tracker gets no
// identity form of its own.

import React from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAdminGate } from '../../lib/access/useAdminGate.ts';
import IdentityChip from './IdentityChip';

const PILL =
  'inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-gray-200 bg-white ' +
  'text-xs font-semibold text-gray-600 hover:border-gray-400 hover:text-black transition-colors';

/** The screens this bar can stand on. Each offers the OTHER one, never itself. */
export type TopBarScreen = 'lobby' | 'tracker';

export interface LobbyTopBarProps {
  name: string;
  color: string;
  role: string;
  /** True when there is an account to sign out of. */
  canSignOut: boolean;
  /** True when the name is this browser's to type — see IdentityChip's header comment. */
  nameEditable: boolean;
  onName: (name: string) => void;
  onColor: (color: string) => void;
  onRole: (role: string) => void;
  onSignOut: () => void;
  /** Which screen this is. Defaults to the lobby, which is where the bar started. */
  here?: TopBarScreen;
  /**
   * This screen's own controls, drawn between the nav pills and the name chip.
   *
   * Slot rather than props: the tracker's are four buttons that open its own panels
   * and export its own CSV, and a bar that knew about them would be the tracker's
   * bar with a lobby flag on it.
   */
  actions?: React.ReactNode;
}

const LobbyTopBar: React.FC<LobbyTopBarProps> = ({
  name,
  color,
  role,
  canSignOut,
  nameEditable,
  onName,
  onColor,
  onRole,
  onSignOut,
  here = 'lobby',
  actions,
}) => {
  // required && unlocked is the admin page's own gate: `required` false means no
  // passphrase is configured, which closes /admin for everyone rather than opening it.
  const { required, unlocked } = useAdminGate();
  const mayAdmin = required && unlocked;

  return (
    <header className="flex items-center gap-3 flex-wrap py-4">
      <Link to="/" className="flex items-center gap-2.5 shrink-0" aria-label="Viewpoint Arena lobby">
        <span className="w-[30px] h-[30px] rounded-md bg-black text-white grid place-items-center font-mono text-xs font-bold">
          VA
        </span>
        <span className="font-mono text-[13px] font-bold tracking-[0.12em] text-black uppercase">
          Viewpoint Arena
        </span>
      </Link>

      <div className="flex-1" />

      <nav className="flex items-center gap-2 flex-wrap" aria-label="Other screens">
        {here === 'tracker' ? (
          <Link to="/" className={PILL} data-testid="topbar-lobby-link">
            Lobby
          </Link>
        ) : (
          <Link to="/tracker" className={PILL} data-testid="lobby-tracker-link">
            Tracker
          </Link>
        )}
        {mayAdmin && (
          <Link to="/admin" className={clsx(PILL, 'border-black text-black')} data-testid="lobby-admin-link">
            Admin
          </Link>
        )}
      </nav>

      {actions && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="topbar-actions">
          {actions}
        </div>
      )}

      <IdentityChip
        name={name}
        color={color}
        role={role}
        canSignOut={canSignOut}
        nameEditable={nameEditable}
        onName={onName}
        onColor={onColor}
        onRole={onRole}
        onSignOut={onSignOut}
      />
    </header>
  );
};

export default LobbyTopBar;
