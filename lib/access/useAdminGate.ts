// Client-side state for the admin gate.
//
// Same shape as useAccessGate.ts — module-level state read through
// useSyncExternalStore, shared between the wrapper that decides whether to
// show the unlock form and the form itself. The bug that motivated extracting
// the state out of per-component useState is documented there.
//
// FAILS SAFE, NOT OPEN. The front door resolves to { required: false } when
// the endpoint is unreachable — a missing server should never lock the UI.
// The admin screen is the opposite: it can delete other people's reviews, so
// an unreachable endpoint means LOCKED (required: true, unlocked: false). A
// real deployment always has the endpoint; a failing one is either a network
// problem or the SPA fallback serving index.html, and neither should grant
// access to destructive actions.
//
// `required: false` from the server means ADMIN_PASSPHRASE_HASH is empty.
// On the front door that means "open to everyone"; here it means the admin
// screen is CLOSED — no passphrase is set, so nobody gets in. The admin
// page renders a short explanation instead of the management sections.

import { useCallback, useSyncExternalStore } from 'react';

interface AdminState {
  required: boolean;
  unlocked: boolean;
  loading: boolean;
  error: string | null;
}

const LOCKED: AdminState = { required: true, unlocked: false, loading: false, error: 'Could not reach the server.' };

let state: AdminState = { required: true, unlocked: false, loading: true, error: null };
const listeners = new Set<() => void>();
let started = false;

function setState(next: AdminState): void {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    void refresh();
  }
  return () => { listeners.delete(listener); };
}

function getSnapshot(): AdminState {
  return state;
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/admin-unlock');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      // SPA fallback served index.html — stay locked.
      setState(LOCKED);
      return;
    }
    const data = (await res.json()) as { required: boolean; unlocked: boolean };
    setState({ required: !!data.required, unlocked: !!data.unlocked, loading: false, error: null });
  } catch {
    // Endpoint unreachable — stay locked. The admin screen deletes other
    // people's reviews; failing open would be the wrong safety property.
    setState(LOCKED);
  }
}

/** Exported for tests: forget everything and re-read on the next subscribe. */
export function resetAdminGateForTests(): void {
  state = { required: true, unlocked: false, loading: true, error: null };
  started = false;
  listeners.clear();
}

export function useAdminGate() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const submit = useCallback(async (passphrase: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/admin-unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passphrase }),
      });
      if (res.status === 429) return 'Too many attempts. Wait a minute.';
      if (res.status === 401) return 'Wrong passphrase.';
      if (!res.ok) return 'Something went wrong. Try again.';
      setState({ ...state, unlocked: true, loading: false, error: null });
      return null;
    } catch {
      return 'Could not reach the server.';
    }
  }, []);

  const lock = useCallback(async (): Promise<void> => {
    try {
      await fetch('/api/admin-unlock', { method: 'DELETE' });
    } catch {
      // Best effort — the cookie expires on its own.
    }
    setState({ ...state, unlocked: false });
  }, []);

  return { ...snapshot, submit, lock };
}
