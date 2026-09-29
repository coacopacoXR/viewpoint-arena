// useAuth — the one place the browser's sign-in session lives.
//
// It owns three things: the Supabase session (read once on mount, then through
// onAuthStateChange, unsubscribed on unmount), the status the IdentityGate
// branches on, and the sync into localStorage['vp_user'].
//
// vp_user stays the single place a display name is read from: dozens of
// components — the store's currentUser, presence, chat, the pointing timeline,
// the XR panel — read it directly, and none of them know about accounts. So
// signing in does not replace that file, it WRITES it: the account's name lands
// in vp_user.name and everything downstream keeps working untouched.
//
// With identity.mode 'none' this hook never touches Supabase at all. Not "calls
// it and ignores the answer" — the effect returns before the first request, so
// a default install behaves exactly as it did before identity existed, down to
// the network tab.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { AVATAR_COLORS, getStoredIdentity, saveIdentity } from '../identity';
import type { UserIdentity } from '../identity';
import { useStore } from '../../store';
import {
  describeAuthError,
  identityAfterSignOut,
  identityForAccount,
  type PublicIdentity,
} from './authRules';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'guest';

/** What the guest form on the sign-in page collects. */
export interface GuestIdentity {
  name: string;
  color: string;
  role?: string;
}

export interface AuthState {
  status: AuthStatus;
  /** The signed-in account, or null when there is no session. */
  user: User | null;
  signOut: () => Promise<void>;
  /** Enter a room without an account. Only offered where the gate allows it. */
  joinAsGuest: (guest: GuestIdentity) => void;
}

function pickColor(): string {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

/**
 * Push a fresh identity into the room store.
 *
 * store.ts reads vp_user ONCE, when the module is first evaluated — in a built
 * app that is before anybody has signed in. Comments (their `author`) and the
 * laser colour read that snapshot, so without this a signed-in person would
 * still be commenting as "Guest" in the same page session.
 */
function syncStoreIdentity(identity: UserIdentity): void {
  useStore.setState({
    currentUser: identity.name || 'Guest',
    currentUserColor: identity.color || '#10b981',
  });
}

/**
 * Write the account into vp_user, keeping the person's own colour and role.
 * Skips the write when nothing changed: onAuthStateChange fires on every token
 * refresh (hourly), and re-writing the same record each time would churn
 * localStorage for no reason.
 */
function syncIdentityFromAccount(user: User): void {
  const existing = getStoredIdentity();
  const next = identityForAccount(user, existing, existing?.color || pickColor());
  syncStoreIdentity(next);
  if (JSON.stringify(existing) === JSON.stringify(next)) return;
  saveIdentity(next);
}

/** No session: is this browser in a room as a guest? */
function storedGuestFlag(): boolean {
  return getStoredIdentity()?.guest === true;
}

/**
 * Drop the session and clear the account out of vp_user. Returns null on
 * success, or the line to show when GoTrue would not let go of the session.
 *
 * Exported on its own because the lobby's "Sign out" line is mounted nowhere
 * near the gate: it would otherwise need a second useAuth(), and with it a
 * second getSession() and a second onAuthStateChange subscription for one
 * button.
 *
 * vp_user is only cleared once the sign-out actually happened. Clearing it on a
 * failed call would leave the app looking signed out while the token in
 * localStorage still works — the worst of both.
 */
export async function signOutOfAccount(): Promise<string | null> {
  const existing = getStoredIdentity();
  const { error } = await supabase.auth.signOut();
  if (error) return describeAuthError(error);
  const cleared = identityAfterSignOut(existing, existing?.color || pickColor());
  saveIdentity(cleared);
  syncStoreIdentity(cleared);
  return null;
}

export function useAuth(identity: PublicIdentity): AuthState {
  // The mode, not the whole block: a caller that builds the object inline hands
  // us a new reference every render, and the effect must not tear the session
  // subscription down and rebuild it each time.
  const mode = identity.mode;

  const [user, setUser] = useState<User | null>(null);
  const [guest, setGuest] = useState(false);
  // Which mode the session above was read for. Until it matches, the answer is
  // unknown and the status is 'loading' — deriving it this way is what stops a
  // signed-in person seeing the sign-in form for a frame while the config
  // settles and the mode flips from the 'none' default to 'accounts'.
  const [resolvedFor, setResolvedFor] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'none') return;

    let active = true;

    const apply = (session: Session | null) => {
      if (!active) return;
      if (session?.user) {
        syncIdentityFromAccount(session.user);
        setUser(session.user);
        setGuest(false);
      } else {
        setUser(null);
        setGuest(storedGuestFlag());
      }
      setResolvedFor(mode);
    };

    // getSession first: onAuthStateChange's INITIAL_SESSION is not guaranteed to
    // arrive before the first paint, and a signed-in reload must not spend a
    // frame looking signed out.
    supabase.auth.getSession().then(
      ({ data }) => apply(data.session),
      () => apply(null),
    );

    const { data } = supabase.auth.onAuthStateChange((_event, session) => apply(session));

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [mode]);

  const status: AuthStatus =
    mode === 'none'
      ? 'signedOut'
      : resolvedFor !== mode
        ? 'loading'
        : user
          ? 'signedIn'
          : guest
            ? 'guest'
            : 'signedOut';

  const signOut = useCallback(async () => {
    const failure = await signOutOfAccount();
    // Still signed in: the session survived, so the status must not pretend
    // otherwise. The gate keeps showing the app and the caller can say why.
    if (failure) return;
    setUser(null);
    setGuest(false);
  }, []);

  const joinAsGuest = useCallback(
    (entering: GuestIdentity) => {
      const stored: UserIdentity = {
        name: entering.name.trim(),
        color: entering.color,
        role: entering.role,
        guest: true,
      };
      saveIdentity(stored);
      syncStoreIdentity(stored);
      setUser(null);
      setGuest(true);
      setResolvedFor(mode);
    },
    [mode],
  );

  return useMemo(
    () => ({ status, user, signOut, joinAsGuest }),
    [status, user, signOut, joinAsGuest],
  );
}
