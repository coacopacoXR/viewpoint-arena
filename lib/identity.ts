import { useState, useEffect } from 'react';

export interface UserIdentity {
  name: string;
  color: string;
  team?: string;
  role?: string;
  /**
   * True while this browser is in a room WITHOUT an account, on a deployment
   * whose identity block sets allowGuests. Set by lib/auth/useAuth.ts's
   * joinAsGuest, carried in presence, and never typed by the person: a name
   * that says "(guest)" in its text would end up stored in tracker items.
   */
  guest?: boolean;
  /** The signed-in account's id. Present only while a session exists. */
  accountId?: string;
}

const KEY = 'vp_user';

export const AVATAR_COLORS = [
  '#4F8EF7', '#F76B4F', '#4FF7A0', '#F7E24F',
  '#C44FF7', '#F74FA0', '#4FF7F7', '#F7A44F',
];

/**
 * The stored record as written, name or not. Signing out clears the name but
 * keeps the colour, so the identity a signed-out browser holds is real and
 * getIdentity() — which is about "who is this person" — reports nothing.
 */
export function getStoredIdentity(): UserIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserIdentity | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getIdentity(): UserIdentity | null {
  const stored = getStoredIdentity();
  return stored?.name ? stored : null;
}

/**
 * How a participant's name reads when it comes from presence: guests carry a
 * suffix so nobody mistakes a self-asserted name for an account's. The flag,
 * not the string, is what travels — see ParticipantPresence.guest.
 */
export function participantLabel(name: string, guest?: boolean): string {
  return guest ? `${name} (guest)` : name;
}

/**
 * Who attended a meeting, as names: this browser's person first, then everybody
 * else in the room.
 *
 * The names are stored WITHOUT the "(guest)" suffix participantLabel adds on
 * screen, for the reason UserIdentity.guest gives: a suffix in the text would end
 * up in a tracker row, and the row is a record of who was in the meeting rather
 * than of how one of them signed in.
 *
 * Deduplicated and with no blanks in it. Two browsers can hold the same person
 * (a tab reopened without a reload), and a participant whose presence arrived
 * before their name did would otherwise be recorded as an empty string in the
 * middle of the list — which reads as a missing name in the session panel.
 */
export function attendeeNames(
  localName: string,
  remote: readonly { name?: string | null }[],
): string[] {
  const names: string[] = [];
  for (const raw of [localName, ...remote.map((person) => person?.name ?? '')]) {
    const name = (raw ?? '').trim();
    if (name === '' || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

// `storage` only fires in OTHER tabs, so a sign-in or sign-out written here
// (lib/auth/useAuth.ts) would leave every mounted useIdentity() consumer
// showing the old name until a reload. One custom event closes that gap.
const CHANGE_EVENT = 'vp_user_change';

function notifyIdentityChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function saveIdentity(identity: UserIdentity): void {
  localStorage.setItem(KEY, JSON.stringify(identity));
  notifyIdentityChanged();
}

export function clearIdentity(): void {
  localStorage.removeItem(KEY);
  notifyIdentityChanged();
}

export function useIdentity(): [UserIdentity | null, (i: UserIdentity) => void] {
  const [identity, setIdentityState] = useState<UserIdentity | null>(() => getIdentity());

  function setIdentity(i: UserIdentity) {
    saveIdentity(i);
    setIdentityState(i);
  }

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setIdentityState(getIdentity());
    }
    function onChange() {
      setIdentityState(getIdentity());
    }
    window.addEventListener('storage', onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  return [identity, setIdentity];
}

export function getDisplayName(): string {
  return getIdentity()?.name ?? 'Guest';
}
