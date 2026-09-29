// IdentityGate — the one decision every route goes through.
//
// The regression that matters most is the first test: a deployment with no
// identity block must render its children and must not so much as look at
// Supabase. Everything else is the door closing and opening again.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import * as ConfigContext from '../../../lib/config/ConfigContext';
import { useStore } from '../../../store';
import { IdentityGate } from '../IdentityGate';
import type { PublicIdentity } from '../../../lib/auth/authRules';

const { authMocks } = vi.hoisted(() => ({
  authMocks: {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signInWithOAuth: vi.fn(),
  },
}));

vi.mock('../../../lib/supabase', () => ({ supabase: { auth: authMocks } }));

// The page is tested on its own; here it only has to be recognisable, and to
// show what the gate handed it. The guest button stands in for the page's guest
// form so the gate's half of that flow can be driven from here.
vi.mock('../../../pages/SignInPage', () => ({
  default: (props: {
    methods: string[];
    guestRoomId: string | null;
    onGuest: (guest: { name: string; color: string }) => void;
  }) => (
    <div
      data-testid="sign-in-page"
      data-methods={props.methods.join(',')}
      data-guest-room={props.guestRoomId ?? ''}
    >
      <button
        data-testid="mock-guest"
        onClick={() => props.onGuest({ name: 'Supplier Sam', color: '#4F8EF7' })}
      />
    </div>
  ),
}));

/** Where the app is, so a test can see the page asked for was kept. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {JSON.stringify({ pathname: location.pathname, state: location.state ?? null })}
    </div>
  );
}

const ACCOUNTS: PublicIdentity = { mode: 'accounts', methods: ['password'], allowGuests: false };

function configWith(identity: PublicIdentity | undefined, loading = false) {
  return {
    config: identity
      ? {
          plm: { provider: 'mock' },
          capture: { provider: 'mock' },
          turn: { provider: 'cloudflare' },
          db: { provider: 'supabase' },
          identity,
          notifications: [],
          modelImport: { provider: 'genericGltf' },
          modelStorage: { provider: 'local' },
        }
      : null,
    loading,
    error: null,
    available: Boolean(identity),
    publicUrl: undefined,
    plm: 'mock',
    capture: 'mock',
    turn: 'cloudflare',
    db: 'supabase',
    modelImport: 'genericGltf',
    notifications: [],
  } satisfies ConfigContext.ConnectorConfig;
}

/** An onAuthStateChange that hands back a subscription and keeps the callback. */
let authListener: ((event: string, session: unknown) => void) | null = null;
const unsubscribe = vi.fn();

function signedOut() {
  authMocks.getSession.mockResolvedValue({ data: { session: null } });
  authMocks.onAuthStateChange.mockImplementation((cb: typeof authListener) => {
    authListener = cb;
    cb('INITIAL_SESSION', null);
    return { data: { subscription: { unsubscribe } } };
  });
}

function signedInAs(user: { id: string; email: string; user_metadata?: Record<string, unknown> }) {
  authMocks.getSession.mockResolvedValue({ data: { session: { user } } });
  authMocks.onAuthStateChange.mockImplementation((cb: typeof authListener) => {
    authListener = cb;
    cb('INITIAL_SESSION', { user });
    return { data: { subscription: { unsubscribe } } };
  });
}

// Async because the gate starts in 'loading' and only decides once getSession
// settles: asserting straight after render() would test the loading frame.
async function renderGate(
  identity: PublicIdentity | undefined,
  path = '/tracker',
  state?: unknown,
  loading = false,
) {
  vi.spyOn(ConfigContext, 'useConnectorConfig').mockReturnValue(configWith(identity, loading));
  const result = render(
    <MemoryRouter initialEntries={[{ pathname: path, state: state ?? null }]}>
      <LocationProbe />
      <IdentityGate>
        <div data-testid="page" />
      </IdentityGate>
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
}

const account = {
  id: 'user-1',
  email: 'alex.chen@acme.com',
  user_metadata: { full_name: 'Alex Chen' },
};

beforeEach(() => {
  authListener = null;
  unsubscribe.mockClear();
  for (const fn of Object.values(authMocks)) fn.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  signedOut();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('identity.mode "none" — the default install', () => {
  it('renders its children and never calls Supabase', async () => {
    await renderGate(undefined);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-page')).toBeNull();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.onAuthStateChange).not.toHaveBeenCalled();
  });

  it('does the same when the config says none explicitly', async () => {
    await renderGate({ mode: 'none', methods: [], allowGuests: false });

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(authMocks.getSession).not.toHaveBeenCalled();
    expect(authMocks.onAuthStateChange).not.toHaveBeenCalled();
  });
});

describe('while loading', () => {
  it('shows neither the page nor the sign-in form until the config settles', async () => {
    await renderGate(undefined, '/tracker', null, true);

    expect(screen.queryByTestId('sign-in-page')).toBeNull();
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('shows no sign-in form while the session is still being read', async () => {
    authMocks.getSession.mockReturnValue(new Promise(() => {})); // never settles
    authMocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe } } });

    await renderGate(ACCOUNTS);

    expect(screen.queryByTestId('sign-in-page')).toBeNull();
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('does not flash the sign-in form at a signed-in person while the mode arrives', async () => {
    signedInAs(account);
    // A fresh element each time: handing React the same object twice makes it
    // bail out of the re-render, and this test is about the re-render.
    const tree = () => (
      <MemoryRouter initialEntries={['/tracker']}>
        <IdentityGate>
          <div data-testid="page" />
        </IdentityGate>
      </MemoryRouter>
    );

    // First paint: the config has not landed, so the mode is still the default.
    const spy = vi.spyOn(ConfigContext, 'useConnectorConfig');
    spy.mockReturnValue(configWith(undefined, true));
    const { rerender } = render(tree());
    expect(screen.queryByTestId('sign-in-page')).toBeNull();

    // The config lands and the mode flips to 'accounts'. The session has not
    // been read yet at this instant, which must read as "still loading" rather
    // than "signed out" — this is the frame a signed-in person would otherwise
    // see the sign-in form in.
    spy.mockReturnValue(configWith(ACCOUNTS, false));
    rerender(tree());
    expect(screen.queryByTestId('sign-in-page')).toBeNull();

    await act(async () => {});
    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-page')).toBeNull();
  });
});

describe('identity.mode "accounts"', () => {
  it('shows the sign-in page instead of the page asked for', async () => {
    await renderGate(ACCOUNTS);

    expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).toBeNull();
    // The URL was not touched, so there is nothing to navigate back to.
    expect(JSON.parse(screen.getByTestId('location').textContent ?? '{}')).toEqual({
      pathname: '/tracker',
      state: null,
    });
  });

  it('hands the sign-in page the configured methods', async () => {
    await renderGate({ mode: 'sso', methods: ['azure', 'saml'], allowGuests: false });

    expect(screen.getByTestId('sign-in-page')).toHaveAttribute('data-methods', 'azure,saml');
  });

  it('renders the page asked for when signed in', async () => {
    signedInAs(account);

    await renderGate(ACCOUNTS);

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(screen.queryByTestId('sign-in-page')).toBeNull();
  });

  it('writes the account into vp_user, keeping the colour that was there', async () => {
    localStorage.setItem(
      'vp_user',
      JSON.stringify({ name: 'Typed', color: '#F76B4F', role: 'Reviewer' }),
    );
    signedInAs(account);

    await renderGate(ACCOUNTS);

    expect(JSON.parse(localStorage.getItem('vp_user') ?? '{}')).toEqual({
      name: 'Alex Chen',
      color: '#F76B4F',
      role: 'Reviewer',
      guest: false,
      accountId: 'user-1',
    });
    // store.ts snapshots vp_user when the module loads, which is before any
    // sign-in: a comment would otherwise be authored by "Guest".
    expect(useStore.getState().currentUser).toBe('Alex Chen');
    expect(useStore.getState().currentUserColor).toBe('#F76B4F');
  });

  it('swaps the sign-in page for the page asked for when a session arrives', async () => {
    await renderGate(ACCOUNTS, '/review/abc/setup', { from: 'link' });
    expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();

    await act(async () => {
      authListener?.('SIGNED_IN', { user: account });
    });

    expect(screen.queryByTestId('sign-in-page')).toBeNull();
    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('location').textContent ?? '{}')).toEqual({
      pathname: '/review/abc/setup',
      state: { from: 'link' },
    });
  });

  it('goes back to the sign-in page when the session goes away', async () => {
    signedInAs(account);
    await renderGate(ACCOUNTS);
    expect(screen.getByTestId('page')).toBeInTheDocument();

    await act(async () => {
      authListener?.('SIGNED_OUT', null);
    });

    expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('unsubscribes when it unmounts', async () => {
    const { unmount } = await renderGate(ACCOUNTS);

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('guests', () => {
  const guestsAllowed: PublicIdentity = { mode: 'accounts', methods: ['password'], allowGuests: true };
  const guest = JSON.stringify({ name: 'Supplier Sam', color: '#4F8EF7', guest: true });

  it('offers the guest door on a room link', async () => {
    await renderGate(guestsAllowed, '/room/abc-123');

    expect(screen.getByTestId('sign-in-page')).toHaveAttribute('data-guest-room', 'abc-123');
  });

  it('offers it on the lobby a room link redirected to', async () => {
    await renderGate(guestsAllowed, '/', { joinRoomId: 'abc-123' });

    expect(screen.getByTestId('sign-in-page')).toHaveAttribute('data-guest-room', 'abc-123');
  });

  it('does not offer it anywhere else', async () => {
    await renderGate(guestsAllowed, '/tracker');

    expect(screen.getByTestId('sign-in-page')).toHaveAttribute('data-guest-room', '');
  });

  it('does not offer it at all when the deployment has guests off', async () => {
    await renderGate(ACCOUNTS, '/room/abc-123');

    expect(screen.getByTestId('sign-in-page')).toHaveAttribute('data-guest-room', '');
  });

  it('lets a guest back into the room they entered, and nowhere else', async () => {
    localStorage.setItem('vp_user', guest);

    await renderGate(guestsAllowed, '/room/abc-123');
    expect(screen.getByTestId('page')).toBeInTheDocument();

    cleanup();
    await renderGate(guestsAllowed, '/tracker');
    expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();
  });

  it('sends a guest to the sign-in page when guests are not allowed', async () => {
    localStorage.setItem('vp_user', guest);

    await renderGate(ACCOUNTS, '/room/abc-123');

    expect(screen.getByTestId('sign-in-page')).toBeInTheDocument();
  });

  it('takes a guest from the lobby invitation into that room, past RoomPage\'s own guard', async () => {
    await renderGate(guestsAllowed, '/', { joinRoomId: 'abc-123' });

    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-guest'));
    });

    expect(JSON.parse(localStorage.getItem('vp_user') ?? '{}')).toEqual({
      name: 'Supplier Sam',
      color: '#4F8EF7',
      role: undefined,
      guest: true,
    });
    // Set before the room mounts, or RoomPage bounces back to the lobby.
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe('abc-123');
    expect(useStore.getState().currentUser).toBe('Supplier Sam');
    expect(JSON.parse(screen.getByTestId('location').textContent ?? '{}')).toEqual({
      pathname: '/room/abc-123',
      state: { fromLobby: true },
    });
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('leaves a guest who arrived on the room link itself where they are', async () => {
    await renderGate(guestsAllowed, '/room/abc-123');

    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-guest'));
    });

    expect(JSON.parse(screen.getByTestId('location').textContent ?? '{}').pathname).toBe(
      '/room/abc-123',
    );
    expect(sessionStorage.getItem('vp_enteredRoom')).toBe('abc-123');
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });
});
