// Client-side state for the front-door access gate.
//
// Learns from GET /api/access whether the deployment requires a password and
// whether this browser is already unlocked. The gate screen
// (pages/AccessGatePage.tsx) is shown by App.tsx when required && !unlocked.
//
// The state lives in THIS MODULE, not in each component, and is read through
// useSyncExternalStore. That matters: the wrapper that decides whether to show
// the gate and the gate screen that submits the password are different
// components, so per-component useState gave them separate copies — entering
// the right password flipped the screen's own copy and the wrapper never heard,
// leaving the user staring at the gate after a successful unlock (found live
// 2026-09-23).
//
// When the endpoint is unreachable (local dev without the server, or the SPA
// fallback returning HTML) the state resolves to
// { required: false, unlocked: true } — the open behaviour — so a missing
// server never locks the UI.

import { useCallback, useSyncExternalStore } from 'react';

interface AccessState {
  required: boolean;
  unlocked: boolean;
  loading: boolean;
  error: string | null;
}

const OPEN: AccessState = { required: false, unlocked: true, loading: false, error: null };

let state: AccessState = { required: false, unlocked: true, loading: true, error: null };
const listeners = new Set<() => void>();
let started = false;

function setState(next: AccessState): void {
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

function getSnapshot(): AccessState {
  return state;
}

async function refresh(): Promise<void> {
  try {
    const res = await fetch('/api/access');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      setState(OPEN); // SPA fallback served index.html — treat as open.
      return;
    }
    const data = (await res.json()) as { required: boolean; unlocked: boolean };
    setState({ required: !!data.required, unlocked: !!data.unlocked, loading: false, error: null });
  } catch {
    setState(OPEN); // Endpoint unreachable — fall back to open.
  }
}

/** Exported for tests: forget everything and re-read on the next subscribe. */
export function resetAccessGateForTests(): void {
  state = { required: false, unlocked: true, loading: true, error: null };
  started = false;
  listeners.clear();
}

export function useAccessGate() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const submit = useCallback(async (password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.status === 429) return 'Too many attempts. Wait a minute.';
      if (res.status === 401) return 'Wrong password.';
      if (!res.ok) return 'Something went wrong. Try again.';
      // Module-level, so every consumer — including the wrapper that decides
      // whether the gate is shown at all — sees the unlock.
      setState({ ...state, unlocked: true, loading: false, error: null });
      return null;
    } catch {
      return 'Could not reach the server.';
    }
  }, []);

  return { ...snapshot, submit };
}
