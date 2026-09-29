// The pure identity rules: what an account is called, which buttons a
// deployment gets, where a guest may go, and what an auth error says.
//
// These are the rules the gate and the sign-in page both read, so a wrong
// answer here is wrong in two places at once — hence the coverage of the
// awkward cases (saml with no button, a 429 whose body is HTML, a config body
// that does not have the shape /api/public-config promises).

import { describe, it, expect } from 'vitest';
import {
  NO_IDENTITY,
  CREDENTIALS_DONT_MATCH,
  TOO_MANY_ATTEMPTS,
  CONFIRM_YOUR_EMAIL,
  EMAIL_NOT_CONFIRMED,
  SIGN_IN_FAILED,
  displayNameForAccount,
  identityForAccount,
  identityAfterSignOut,
  ssoButtonsFor,
  guestRoomIdFor,
  isGuestAllowedPath,
  describeAuthError,
  describeSignUpResult,
  publicIdentityOf,
  identityRequired,
} from '../authRules';

describe('displayNameForAccount', () => {
  it('prefers the profile full name', () => {
    expect(
      displayNameForAccount({
        email: 'a.chen@acme.com',
        user_metadata: { full_name: 'Alex Chen', name: 'alex' },
      }),
    ).toBe('Alex Chen');
  });

  it('falls back to the profile name', () => {
    expect(displayNameForAccount({ email: 'a@b.c', user_metadata: { name: 'alex' } })).toBe('alex');
  });

  it('falls back to the part of the email before the @', () => {
    expect(displayNameForAccount({ email: 'alex.chen@acme.com', user_metadata: {} })).toBe(
      'alex.chen',
    );
  });

  it('ignores metadata that is not a usable string', () => {
    expect(
      displayNameForAccount({
        email: 'alex@acme.com',
        user_metadata: { full_name: '   ', name: 42 },
      }),
    ).toBe('alex');
  });

  it('trims a name the provider padded', () => {
    expect(displayNameForAccount({ user_metadata: { full_name: '  Alex Chen  ' } })).toBe(
      'Alex Chen',
    );
  });

  it('has something to show when the account carries no name and no email', () => {
    expect(displayNameForAccount({ user_metadata: {} })).toBe('Signed-in user');
    expect(displayNameForAccount(null)).toBe('Signed-in user');
  });
});

describe('ssoButtonsFor', () => {
  it('gives one button per external provider, in the configured order', () => {
    expect(ssoButtonsFor(['google', 'azure'])).toEqual([
      { provider: 'google', label: 'Continue with Google' },
      { provider: 'azure', label: 'Continue with Microsoft', scopes: 'email' },
    ]);
  });

  it('labels Keycloak plainly until a deployment gives it the org\'s words', () => {
    expect(ssoButtonsFor(['keycloak'])).toEqual([
      { provider: 'keycloak', label: 'Continue with Keycloak' },
    ]);
  });

  it('offers no button for saml — no provider is registered until part 3', () => {
    expect(ssoButtonsFor(['saml'])).toEqual([]);
  });

  it('offers no button for password — that is the form', () => {
    expect(ssoButtonsFor(['password'])).toEqual([]);
  });

  it('keeps the buttons that do exist next to saml', () => {
    expect(ssoButtonsFor(['saml', 'password', 'azure']).map((b) => b.provider)).toEqual(['azure']);
  });

  it('hands out a copy, so a caller cannot edit the shared labels', () => {
    const first = ssoButtonsFor(['azure']);
    first[0].label = 'changed';
    expect(ssoButtonsFor(['azure'])[0].label).toBe('Continue with Microsoft');
  });
});

describe('guestRoomIdFor / isGuestAllowedPath', () => {
  it('reads the room out of a room link', () => {
    expect(guestRoomIdFor('/room/abc-123')).toBe('abc-123');
    expect(guestRoomIdFor('/room/abc-123/')).toBe('abc-123');
  });

  it('reads the room out of the lobby state a room link redirects through', () => {
    expect(guestRoomIdFor('/', { joinRoomId: 'abc-123' })).toBe('abc-123');
  });

  it('is not a room invitation without one', () => {
    expect(guestRoomIdFor('/')).toBeNull();
    expect(guestRoomIdFor('/', {})).toBeNull();
    expect(guestRoomIdFor('/', { joinRoomId: '   ' })).toBeNull();
    expect(guestRoomIdFor('/', { joinRoomId: 42 })).toBeNull();
    expect(guestRoomIdFor('/tracker')).toBeNull();
    expect(guestRoomIdFor('/admin')).toBeNull();
    expect(guestRoomIdFor('/launch')).toBeNull();
    expect(guestRoomIdFor('/review/abc-123/setup')).toBeNull();
  });

  it('lets a guest into a room only when the deployment allows guests', () => {
    expect(isGuestAllowedPath('/room/abc', true)).toBe(true);
    expect(isGuestAllowedPath('/room/abc', false)).toBe(false);
    expect(isGuestAllowedPath('/', true, { joinRoomId: 'abc' })).toBe(true);
    expect(isGuestAllowedPath('/', false, { joinRoomId: 'abc' })).toBe(false);
  });

  it('never lets a guest start a session, curate, track or administer', () => {
    for (const path of ['/', '/tracker', '/admin', '/launch', '/review/abc/setup']) {
      expect(isGuestAllowedPath(path, true)).toBe(false);
    }
  });
});

describe('describeAuthError', () => {
  it('says so when nginx rate-limited the attempt', () => {
    // A 429 from nginx has an HTML body, so supabase-js reports the JSON parse
    // failure as the message and only the status is worth reading.
    expect(
      describeAuthError({ status: 429, message: 'Unexpected token < in JSON at position 0' }),
    ).toBe(TOO_MANY_ATTEMPTS);
    expect(describeAuthError({ status: 429, message: 'Rate limit exceeded' })).toBe(
      TOO_MANY_ATTEMPTS,
    );
  });

  it('says the pair does not match when the credentials were wrong', () => {
    expect(describeAuthError({ status: 400, message: 'Invalid login credentials' })).toBe(
      CREDENTIALS_DONT_MATCH,
    );
    expect(describeAuthError({ name: 'AuthInvalidCredentialsError', message: '' })).toBe(
      CREDENTIALS_DONT_MATCH,
    );
  });

  it('points at the inbox for an unconfirmed account', () => {
    expect(describeAuthError({ status: 400, message: 'Email not confirmed' })).toBe(
      EMAIL_NOT_CONFIRMED,
    );
  });

  it('passes on a message a person can act on', () => {
    expect(describeAuthError({ status: 400, message: 'Password should be at least 6 characters' })).toBe(
      'Password should be at least 6 characters',
    );
  });

  it('keeps internals out of anything else', () => {
    expect(describeAuthError({ status: 500, message: 'Get "https://gotrue:9999/token": dial tcp' })).toBe(
      SIGN_IN_FAILED,
    );
    expect(describeAuthError({ message: 'x'.repeat(400) })).toBe(SIGN_IN_FAILED);
    expect(describeAuthError(null)).toBe(SIGN_IN_FAILED);
    expect(describeAuthError('nope')).toBe(SIGN_IN_FAILED);
  });
});

describe('describeSignUpResult', () => {
  it('says nothing when the sign-up signed the person straight in', () => {
    expect(describeSignUpResult({ data: { session: { access_token: 't' } }, error: null })).toBeNull();
  });

  it('sends them to their inbox when there is no session', () => {
    expect(describeSignUpResult({ data: { session: null }, error: null })).toBe(CONFIRM_YOUR_EMAIL);
    expect(describeSignUpResult({ data: null, error: null })).toBe(CONFIRM_YOUR_EMAIL);
  });

  it('reports an error as an error', () => {
    expect(
      describeSignUpResult({ data: null, error: { status: 429, message: 'slow down' } }),
    ).toBe(TOO_MANY_ATTEMPTS);
  });

  it('has an answer when there is no result at all', () => {
    expect(describeSignUpResult(null)).toBe(SIGN_IN_FAILED);
  });
});

describe('the vp_user record a session produces', () => {
  it('takes the name from the account and keeps the person\'s colour', () => {
    expect(
      identityForAccount(
        { id: 'user-1', email: 'alex@acme.com', user_metadata: { full_name: 'Alex Chen' } },
        { name: 'Old Typed Name', color: '#F76B4F', role: 'Reviewer', guest: true },
        '#F76B4F',
      ),
    ).toEqual({
      name: 'Alex Chen',
      color: '#F76B4F',
      role: 'Reviewer',
      guest: false,
      accountId: 'user-1',
    });
  });

  it('drops a guest flag and an old accountId when the account has no id', () => {
    const next = identityForAccount({ email: 'alex@acme.com' }, { name: 'x', color: '#fff', guest: true }, '#fff');
    expect(next.guest).toBe(false);
    expect(next.accountId).toBeUndefined();
  });

  it('clears the account on sign-out but keeps the colour and role', () => {
    expect(
      identityAfterSignOut({ name: 'Alex', color: '#4F8EF7', role: 'Engineer', accountId: 'user-1' }, '#4F8EF7'),
    ).toEqual({ name: '', color: '#4F8EF7', role: 'Engineer', guest: false });
  });
});

describe('publicIdentityOf', () => {
  it('reads a real identity block', () => {
    expect(
      publicIdentityOf({
        identity: { mode: 'accounts', methods: ['password'], allowGuests: true },
      }),
    ).toEqual({ mode: 'accounts', methods: ['password'], allowGuests: true });
  });

  it('falls back to no identity when the block is missing or unreadable', () => {
    expect(publicIdentityOf(null)).toEqual(NO_IDENTITY);
    expect(publicIdentityOf({})).toEqual(NO_IDENTITY);
    expect(publicIdentityOf({ identity: 'accounts' })).toEqual(NO_IDENTITY);
    expect(publicIdentityOf({ identity: { mode: 'wat', methods: ['password'] } })).toEqual(
      NO_IDENTITY,
    );
  });

  it('drops methods it does not know rather than rendering a button for them', () => {
    expect(
      publicIdentityOf({ identity: { mode: 'sso', methods: ['azure', 'carrier-pigeon'], allowGuests: 'yes' } }),
    ).toEqual({ mode: 'sso', methods: ['azure'], allowGuests: false });
  });

  it('survives a methods array that is not an array', () => {
    expect(publicIdentityOf({ identity: { mode: 'accounts', methods: 'password' } })).toEqual({
      mode: 'accounts',
      methods: [],
      allowGuests: false,
    });
  });
});

describe('identityRequired', () => {
  it('is false only for the default', () => {
    expect(identityRequired(NO_IDENTITY)).toBe(false);
    expect(identityRequired({ mode: 'accounts', methods: ['password'], allowGuests: false })).toBe(true);
    expect(identityRequired({ mode: 'sso', methods: ['google'], allowGuests: true })).toBe(true);
  });
});
