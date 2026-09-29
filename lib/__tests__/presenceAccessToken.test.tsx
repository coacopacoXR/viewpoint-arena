// The access token that proves a presence name: how it reaches the room
// server, and how it reaches nowhere else.
//
// docs/plan/13-identity.md batch AZ. The server half is pinned in
// party/__tests__/room.server.test.ts; this is the client half, and the two
// properties that matter here are that a signed-in person's token travels with
// every presence they send, and that a browser with no account — which is every
// browser on a deployment whose identity.mode is 'none' — sends exactly the
// payload it sent before identity existed and never asks Supabase for anything.
//
// Same harness as guestPresence.test.tsx and joinKnock.test.tsx: a fake
// partysocket driven by hand.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useStore } from '../../store';
import type { ParticipantPresence } from '../../party/room.server';

interface Listener {
  (event: unknown): void;
}

class FakeSocket {
  static last: FakeSocket | null = null;
  readyState = 1; // WebSocket.OPEN
  sent: string[] = [];
  listeners = new Map<string, Set<Listener>>();

  constructor(_opts: unknown) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  /** Fire the socket's 'open' handlers, as partysocket does once connected. */
  open() {
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }

  /** Every PRESENCE this socket has sent, as raw JSON. */
  rawPresences(): string[] {
    return this.sent.filter((s) => (JSON.parse(s) as { type: string }).type === 'PRESENCE');
  }

  /** The payload of every PRESENCE this socket has sent. */
  presences(): ParticipantPresence[] {
    return this.rawPresences().map(
      (s) => (JSON.parse(s) as { payload: ParticipantPresence }).payload,
    );
  }
}

vi.mock('partysocket', () => ({ default: FakeSocket }));

const { authMocks } = vi.hoisted(() => ({
  authMocks: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
  },
}));

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: authMocks },
  supabaseConfigured: true,
}));

// Imported after the mocks are registered, and dynamically: a static import of
// anything that reaches usePartyPresence would run the factory above while
// FakeSocket is still in its TDZ.
const { usePartyPresence } = await import('../usePartyPresence');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LTEifQ.first-signature'; // gitleaks:allow (fake test value)
const REFRESHED = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LTEifQ.second-signature'; // gitleaks:allow (fake test value)

let captured: ReturnType<typeof usePartyPresence> | null = null;

function Harness() {
  captured = usePartyPresence('room-1');
  return null;
}

function socket(): FakeSocket {
  const s = FakeSocket.last;
  if (!s) throw new Error('no socket was created');
  return s;
}

function setVpUser(user: Record<string, unknown>) {
  localStorage.setItem('vp_user', JSON.stringify(user));
}

/** The session Supabase answers with, and the auth-change listener it keeps. */
let authListener: ((event: string, session: { access_token: string } | null) => void) | null;

function sessionAnswer(token: string | null) {
  authMocks.getSession.mockResolvedValue({
    data: { session: token === null ? null : { access_token: token } },
    error: null,
  });
}

beforeEach(() => {
  FakeSocket.last = null;
  captured = null;
  authListener = null;
  sessionStorage.setItem('vp_userId', 'user-maria');
  for (const fn of Object.values(authMocks)) fn.mockReset();
  sessionAnswer(TOKEN);
  authMocks.onAuthStateChange.mockImplementation((listener: typeof authListener) => {
    authListener = listener;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
});

afterEach(() => {
  cleanup();
  useStore.setState({ followingRemoteUserId: null, followNudged: false });
  vi.restoreAllMocks();
});

describe('a signed-in client', () => {
  beforeEach(() => {
    setVpUser({ name: 'Maria', color: '#fff', accountId: 'account-1', guest: false });
  });

  it('sends the token with every presence it broadcasts', async () => {
    render(<Harness />);
    await act(async () => {});

    act(() => {
      captured!.broadcastPresence([1, 2, 3], [1, 2, 2]);
      captured!.broadcastPresence([1, 2, 4], [1, 2, 2]);
    });

    const presences = socket().presences();
    // At least the two broadcasts; the knock that the token's arrival triggers
    // is in here as well, which is the point of re-knocking — it is the first
    // frame the server is able to verify.
    expect(presences.length).toBeGreaterThanOrEqual(2);
    for (const presence of presences) {
      expect(presence).toMatchObject({ name: 'Maria', guest: false, accessToken: TOKEN });
    }
  });

  it('sends it on the knock too, so the host judges a proven name', async () => {
    // The knock is what the host's queue is built from, and the room server
    // verifies it exactly like any other presence — so a person who is signed
    // in must not appear in that queue as a guest.
    render(<Harness />);
    await act(async () => {});

    act(() => {
      socket().open();
    });

    expect(socket().presences()[0]).toMatchObject({ name: 'Maria', accessToken: TOKEN });
  });

  it('re-knocks when the token lands after the socket already opened', async () => {
    // getSession() reads localStorage and so usually wins the race against a
    // websocket handshake. "Usually" is not a rule, and the alternative is a
    // signed-in person sitting in the host's queue marked "(guest)" for three
    // seconds — so the token arriving late sends a knock of its own.
    let resolveSession: (value: unknown) => void = () => {};
    authMocks.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    render(<Harness />);

    act(() => {
      socket().open();
    });
    expect(socket().presences()[0]).not.toHaveProperty('accessToken');

    await act(async () => {
      resolveSession({ data: { session: { access_token: TOKEN } }, error: null });
    });

    expect(socket().presences().at(-1)).toMatchObject({ accessToken: TOKEN });
  });

  it('sends the refreshed token once the session has been renewed', async () => {
    // GoTrue tokens last an hour and supabase-js refreshes them quietly. The
    // room server only re-verifies when the string changes, so a refresh that
    // never reached the socket would leave an expired token being sent — and an
    // expired token reads as a guest.
    render(<Harness />);
    await act(async () => {});

    act(() => {
      authListener?.('TOKEN_REFRESHED', { access_token: REFRESHED });
      captured!.broadcastPresence([0, 0, 0], [0, 0, -1]);
    });

    expect(socket().presences().at(-1)).toMatchObject({ accessToken: REFRESHED });
  });

  it('carries no token once the session is gone', async () => {
    render(<Harness />);
    await act(async () => {});

    act(() => {
      authListener?.('SIGNED_OUT', null);
      captured!.broadcastPresence([0, 0, 0], [0, 0, -1]);
    });

    // Absent, not null: the field must not appear on the wire at all.
    expect(socket().presences().at(-1)).not.toHaveProperty('accessToken');
  });

  it('never writes the token to a log', async () => {
    const logs = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    };

    render(<Harness />);
    await act(async () => {});
    act(() => {
      socket().open();
      captured!.broadcastPresence([0, 0, 0], [0, 0, -1]);
    });

    const written = Object.values(logs)
      .flatMap((spy) => spy.mock.calls)
      .map((call) => call.map((arg) => String(arg)).join(' '))
      .join('\n');
    expect(written).not.toContain(TOKEN);
  });
});

describe('a browser with no account', () => {
  it('sends exactly what it sent before identity existed, and asks Supabase nothing', async () => {
    // The default install: identity.mode 'none' never writes an accountId into
    // vp_user, so this is also the mode-'none' guarantee.
    setVpUser({ name: 'Maria', color: '#fff' });
    render(<Harness />);
    await act(async () => {});

    act(() => {
      socket().open();
      captured!.broadcastPresence([0, 0, 0], [0, 0, -1]);
    });

    const presences = socket().presences();
    expect(presences.length).toBeGreaterThan(1);
    for (const presence of presences) {
      expect(presence).toMatchObject({ name: 'Maria', guest: false });
      expect(presence).not.toHaveProperty('accessToken');
    }
    // Not even a getSession(): a deployment with no auth service must not gain
    // a request to one, or a console error when it does not answer.
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.onAuthStateChange).not.toHaveBeenCalled();
    for (const raw of socket().rawPresences()) expect(raw).not.toContain('accessToken');
  });

  it('sends nothing for a guest either, whose name is already marked as unproven', async () => {
    setVpUser({ name: 'Supplier Sam', color: '#fff', guest: true });
    render(<Harness />);
    await act(async () => {});

    act(() => {
      socket().open();
      captured!.broadcastPresence([0, 0, 0], [0, 0, -1]);
    });

    expect(socket().presences().at(-1)).toMatchObject({ name: 'Supplier Sam', guest: true });
    for (const raw of socket().rawPresences()) expect(raw).not.toContain('accessToken');
    expect(authMocks.getSession).not.toHaveBeenCalled();
  });

  it('sends no token when the session behind a stale accountId is gone', async () => {
    // A deployment that turned identity off leaves the accountId in vp_user
    // until the next sign-in or sign-out. There is then no session to read, and
    // the only honest answer is no token — which the room server reads as a
    // guest, not as a name it vouches for.
    setVpUser({ name: 'Maria', color: '#fff', accountId: 'account-1' });
    sessionAnswer(null);
    render(<Harness />);
    await act(async () => {});

    act(() => {
      socket().open();
    });

    expect(socket().presences()[0]).not.toHaveProperty('accessToken');
  });
});
