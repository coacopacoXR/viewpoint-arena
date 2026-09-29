// SignInPage — the door itself.
//
// What is pinned here: the credentials go to Supabase untouched, an error comes
// back in plain words (including nginx's 429, whose body is HTML and whose
// message is therefore a JSON parse error), the "Create an account" switch only
// exists when GoTrue says it may, and a guest gets the name-and-colour form the
// lobby has always had.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import SignInPage from '../SignInPage';
import type { GuestIdentity } from '../../lib/auth/useAuth';

const { authMocks } = vi.hoisted(() => ({
  authMocks: {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signInWithOAuth: vi.fn(),
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
  },
}));

vi.mock('../../lib/supabase', () => ({ supabase: { auth: authMocks } }));

const fetchMock = vi.fn();

/** GoTrue's public /settings answer, or a failure to reach it. */
function stubSettings(body: unknown, ok = true) {
  fetchMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });
}

async function renderPage(
  props: Partial<React.ComponentProps<typeof SignInPage>> = {},
) {
  const onGuest = vi.fn();
  const result = render(
    <SignInPage
      methods={props.methods ?? ['password']}
      guestRoomId={props.guestRoomId ?? null}
      onGuest={props.onGuest ?? onGuest}
    />,
  );
  // The settings fetch decides whether the sign-up switch exists at all.
  await act(async () => {});
  return { ...result, onGuest };
}

async function typeCredentials(email = 'alex@acme.com', password = 'hunter2') {
  fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: email } });
  fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: password } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  });
}

beforeEach(() => {
  for (const fn of Object.values(authMocks)) fn.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  stubSettings({ disable_signup: false });
  authMocks.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  authMocks.signUp.mockResolvedValue({ data: { session: {} }, error: null });
  authMocks.signInWithOAuth.mockResolvedValue({ data: { provider: 'azure' }, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('signing in with a password', () => {
  it('hands Supabase the two fields as typed', async () => {
    await renderPage();

    await typeCredentials('  Alex@Acme.com ', 'hunter2');

    expect(authMocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'Alex@Acme.com',
      password: 'hunter2',
    });
  });

  it('says the pair does not match when GoTrue rejects it', async () => {
    authMocks.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 400, message: 'Invalid login credentials' },
    });
    await renderPage();

    await typeCredentials();

    expect(screen.getByText("That email and password don't match.")).toBeInTheDocument();
  });

  it('passes on a 400 that says something a person can use', async () => {
    authMocks.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: { status: 400, message: 'Password should be at least 6 characters' },
    });
    await renderPage();

    await typeCredentials();

    expect(screen.getByText('Password should be at least 6 characters')).toBeInTheDocument();
  });

  it('says to wait when nginx rate-limited the attempt', async () => {
    authMocks.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      // nginx answers 429 with HTML, so this is what supabase-js can report.
      error: { status: 429, message: 'Unexpected token < in JSON at position 0' },
    });
    await renderPage();

    await typeCredentials();

    expect(
      screen.getByText('Too many attempts. Wait a minute and try again.'),
    ).toBeInTheDocument();
  });

  it('keeps the submit button off until both fields are filled', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });
});

describe('the sign-up switch', () => {
  it('is there when GoTrue accepts sign-ups', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('is hidden when GoTrue says disable_signup', async () => {
    stubSettings({ disable_signup: true });

    await renderPage();

    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();
  });

  it('is hidden when the settings cannot be read at all', async () => {
    stubSettings({ disable_signup: false }, false);

    await renderPage();

    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();
  });

  it('is hidden when a proxy answered the settings call with a page', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      json: async () => {
        throw new Error('<!doctype html>');
      },
    });

    await renderPage();

    expect(screen.queryByRole('button', { name: 'Create an account' })).toBeNull();
  });

  it('asks GoTrue for the public settings with the anon key', async () => {
    await renderPage();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://placeholder.supabase.test/auth/v1/settings',
      { headers: { apikey: 'placeholder-anon-key' } },
    );
  });

  it('does not ask when there is no password method to switch on', async () => {
    await renderPage({ methods: ['azure'] });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signs up instead of signing in once switched over', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Alex Chen'), {
      target: { value: 'Sam Rivera' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'sam@acme.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Your password'), {
      target: { value: 'letmein1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Type it again'), {
      target: { value: 'letmein1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });

    // The name rides on the account, where the room's display name is read from.
    expect(authMocks.signUp).toHaveBeenCalledWith({
      email: 'sam@acme.com',
      password: 'letmein1',
      options: { data: { full_name: 'Sam Rivera' } },
    });
    expect(authMocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('sends the person to their inbox when the sign-up returned no session', async () => {
    authMocks.signUp.mockResolvedValue({ data: { session: null, user: {} }, error: null });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Alex Chen'), {
      target: { value: 'Sam Rivera' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), {
      target: { value: 'sam@acme.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('Your password'), {
      target: { value: 'letmein1' },
    });
    fireEvent.change(screen.getByPlaceholderText('Type it again'), {
      target: { value: 'letmein1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });

    expect(
      screen.getByText('Check your email to confirm your account.'),
    ).toBeInTheDocument();
  });
});

describe('the SSO buttons', () => {
  it('offers one per external method and none for saml', async () => {
    await renderPage({ methods: ['azure', 'google', 'keycloak', 'saml'] });

    expect(screen.getByRole('button', { name: 'Continue with Microsoft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Keycloak' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(3);
  });

  it('comes back to the page that was asked for, and asks Microsoft for the email claim', async () => {
    await renderPage({ methods: ['azure'] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Microsoft' }));
    });

    expect(authMocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'azure',
      options: {
        redirectTo:
          window.location.origin + window.location.pathname + window.location.search,
        scopes: 'email',
      },
    });
  });

  it('sends Google without extra scopes', async () => {
    await renderPage({ methods: ['google'] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    });

    expect(authMocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo:
          window.location.origin + window.location.pathname + window.location.search,
      },
    });
  });

  it('says so when the provider could not be reached', async () => {
    authMocks.signInWithOAuth.mockResolvedValue({
      data: { provider: null },
      error: { status: 429, message: 'Rate limit exceeded' },
    });
    await renderPage({ methods: ['google'] });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    });

    expect(
      screen.getByText('Too many attempts. Wait a minute and try again.'),
    ).toBeInTheDocument();
  });

  it('says what to do when the deployment configured nothing clickable', async () => {
    await renderPage({ methods: ['saml'] });

    expect(
      screen.getByText('This deployment has no sign-in method configured. Ask whoever runs it.'),
    ).toBeInTheDocument();
  });
});

describe('the guest door', () => {
  it('is only offered where a room invitation allows it', async () => {
    await renderPage({ guestRoomId: null });
    expect(screen.queryByRole('button', { name: 'Join as a guest' })).toBeNull();

    cleanup();
    await renderPage({ guestRoomId: 'abc-123' });
    expect(screen.getByRole('button', { name: 'Join as a guest' })).toBeInTheDocument();
  });

  it('collects the lobby\'s name and colour and hands them to the gate', async () => {
    const onGuest = vi.fn();
    await renderPage({ guestRoomId: 'abc-123', onGuest });

    fireEvent.click(screen.getByRole('button', { name: 'Join as a guest' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Alex Chen'), {
      target: { value: 'Supplier Sam' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter the room' }));
    });

    const guest: GuestIdentity = onGuest.mock.calls[0][0];
    expect(guest.name).toBe('Supplier Sam');
    expect(guest.color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('will not send an unnamed guest anywhere', async () => {
    const onGuest = vi.fn();
    await renderPage({ guestRoomId: 'abc-123', onGuest });

    fireEvent.click(screen.getByRole('button', { name: 'Join as a guest' }));

    expect(screen.getByRole('button', { name: 'Enter the room' })).toBeDisabled();
    expect(onGuest).not.toHaveBeenCalled();
  });

  it('keeps the colour this browser already had', async () => {
    localStorage.setItem('vp_user', JSON.stringify({ name: '', color: '#F76B4F' }));
    const onGuest = vi.fn();
    await renderPage({ guestRoomId: 'abc-123', onGuest });

    fireEvent.click(screen.getByRole('button', { name: 'Join as a guest' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Alex Chen'), {
      target: { value: 'Sam' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter the room' }));
    });

    const guest: GuestIdentity = onGuest.mock.calls[0][0];
    expect(guest.color).toBe('#F76B4F');
  });

  it('refuses to create an account when the two passwords differ', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Alex Chen'), { target: { value: 'Sam Rivera' } });
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'sam@acme.com' } });
    fireEvent.change(screen.getByPlaceholderText('Your password'), { target: { value: 'letmein1' } });
    fireEvent.change(screen.getByPlaceholderText('Type it again'), { target: { value: 'letmein2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    });
    expect(authMocks.signUp).not.toHaveBeenCalled();
    expect(screen.getByText("The two passwords don't match.")).toBeTruthy();
  });
});
