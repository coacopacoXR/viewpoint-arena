// authRules — the pure half of the browser's identity rules.
//
// Every export here is a function of its arguments: no Supabase client, no
// localStorage, no router, no clock. useAuth, IdentityGate and SignInPage read
// these instead of each carrying their own copy of "who may in and what do we
// call it", which is what makes a rule like "saml has no button yet" testable
// without mounting React.

import type { PublicConfig } from '../config/publicConfig';
import type { IdentityMethod } from '../config/schema';

/** The identity block exactly as /api/public-config exposes it. */
export type PublicIdentity = PublicConfig['identity'];

/**
 * What "no identity" means. Used when the config omits the block, when the
 * endpoint is unreachable, and by tests — one spelling of the default so the
 * three cannot drift apart.
 */
export const NO_IDENTITY: PublicIdentity = { mode: 'none', methods: [], allowGuests: false };

/** True when this deployment asks people to sign in at all. */
export function identityRequired(identity: PublicIdentity): boolean {
  return identity.mode === 'accounts' || identity.mode === 'sso';
}

const IDENTITY_METHODS: readonly string[] = ['password', 'azure', 'google', 'keycloak', 'saml'];

function isIdentityMethod(value: unknown): value is IdentityMethod {
  return typeof value === 'string' && IDENTITY_METHODS.includes(value);
}

/**
 * The identity block out of a fetched public config, normalised.
 *
 * /api/public-config always includes it, but the body arrives over the network
 * and ConfigContext's shape check stops at the connector providers — it never
 * looks inside `identity`. An older cached response, a half-finished deploy or a
 * proxy answering with something else must therefore land on "no identity"
 * (today's behaviour) rather than on `undefined.methods`.
 */
export function publicIdentityOf(config: { identity?: unknown } | null): PublicIdentity {
  const raw = config?.identity;
  if (typeof raw !== 'object' || raw === null) return NO_IDENTITY;

  const value = raw as { mode?: unknown; methods?: unknown; allowGuests?: unknown };
  const mode = value.mode === 'accounts' || value.mode === 'sso' ? value.mode : 'none';
  if (mode === 'none') return NO_IDENTITY;

  return {
    mode,
    methods: Array.isArray(value.methods) ? value.methods.filter(isIdentityMethod) : [],
    allowGuests: value.allowGuests === true,
  };
}

// ─── Names ──────────────────────────────────────────────────────────────────

/** The parts of a signed-in account these rules read. Supabase's User fits. */
export interface AccountLike {
  id?: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

const FALLBACK_DISPLAY_NAME = 'Signed-in user';

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The name a signed-in person is shown under, in order: what the provider or
 * the person put in their profile, then the local part of their email address.
 * Nothing here invents a prettier version of an email ("a.chen" stays
 * "a.chen") — the lobby shows what the account says.
 */
export function displayNameForAccount(user: AccountLike | null): string {
  const metadata = user?.user_metadata ?? null;
  const fromMetadata = trimmed(metadata?.full_name) || trimmed(metadata?.name);
  if (fromMetadata) return fromMetadata;

  const email = trimmed(user?.email);
  if (!email) return FALLBACK_DISPLAY_NAME;
  return trimmed(email.split('@')[0]) || email;
}

/** The record `localStorage['vp_user']` holds. */
export interface StoredIdentity {
  name: string;
  color: string;
  team?: string;
  role?: string;
  /** True while this browser is in a room without an account. */
  guest?: boolean;
  /** The account's id, present only while signed in. Part 3 reads it. */
  accountId?: string;
}

/**
 * vp_user after a sign-in: the account's name, the person's own colour (the
 * caller passes the one to keep, since picking one needs a clock), their role
 * if they had chosen one, and the account id for part 3. Never a guest.
 */
export function identityForAccount(
  user: AccountLike,
  existing: StoredIdentity | null,
  color: string,
): StoredIdentity {
  const next: StoredIdentity = { name: displayNameForAccount(user), color, guest: false };
  if (existing?.role) next.role = existing.role;
  if (existing?.team) next.team = existing.team;
  if (user.id) next.accountId = user.id;
  return next;
}

/**
 * vp_user after a sign-out: the account is gone (no name, no accountId, no
 * guest flag) but the colour and role survive, so signing in again — or
 * typing a name on a deployment with identity off — looks the same as before.
 */
export function identityAfterSignOut(
  existing: StoredIdentity | null,
  color: string,
): StoredIdentity {
  const next: StoredIdentity = { name: '', color, guest: false };
  if (existing?.role) next.role = existing.role;
  return next;
}

// ─── Which buttons ──────────────────────────────────────────────────────────

/** The external providers GoTrue can redirect to from a button click. */
export type SsoProvider = 'azure' | 'google' | 'keycloak';

export interface SsoButton {
  provider: SsoProvider;
  label: string;
  /** Extra OAuth scopes, when the provider needs one. */
  scopes?: string;
}

const SSO_BUTTONS: Record<SsoProvider, SsoButton> = {
  // Entra ID's default scopes do not include the email claim, and the account
  // name comes from that claim — without it a Microsoft sign-in lands on the
  // email fallback with no email to fall back to.
  azure: { provider: 'azure', label: 'Continue with Microsoft', scopes: 'email' },
  google: { provider: 'google', label: 'Continue with Google' },
  keycloak: { provider: 'keycloak', label: 'Continue with Keycloak' },
};

export function isSsoProvider(method: IdentityMethod): method is SsoProvider {
  return method in SSO_BUTTONS;
}

/**
 * One button per SSO method, in the order the deployment listed them.
 *
 * 'password' gets no button — it is the form. 'saml' gets none either: a SAML
 * provider is registered through GoTrue's admin API (part 3), and until one
 * exists there is no provider name to send, so a button would only produce a
 * 404 from /auth/v1/authorize.
 */
export function ssoButtonsFor(methods: readonly IdentityMethod[]): SsoButton[] {
  const buttons: SsoButton[] = [];
  for (const method of methods) {
    // A copy: handing out the shared constant would let one caller's mutation
    // change every later render.
    if (isSsoProvider(method)) buttons.push({ ...SSO_BUTTONS[method] });
  }
  return buttons;
}

// ─── Where a guest may go ───────────────────────────────────────────────────

/**
 * The room a person without an account is allowed into from this location, or
 * null when the location is not a room invitation.
 *
 * Two spellings of the same invitation: a room link (`/room/<id>`), and the
 * lobby reached by RoomPage's own redirect with `state.joinRoomId` — which is
 * where a room link lands for anyone who has not set a name yet.
 *
 * `allowGuests` is deliberately NOT consulted here, so a caller can tell "not
 * a room" from "a room this deployment keeps locked" apart.
 */
export function guestRoomIdFor(pathname: string, state?: unknown): string | null {
  const room = /^\/room\/([^/?#]+)\/?$/.exec(pathname)?.[1];
  if (room) return room;

  if (pathname === '/' || pathname === '') {
    const joinRoomId = (state as { joinRoomId?: unknown } | null | undefined)?.joinRoomId;
    const trimmedId = trimmed(joinRoomId);
    if (trimmedId) return trimmedId;
  }

  // Everything else — the lobby with no invitation, curation, the tracker,
  // admin, /launch — needs an account.
  return null;
}

/** True when a guest may be let in at this location. */
export function isGuestAllowedPath(
  pathname: string,
  allowGuests: boolean,
  state?: unknown,
): boolean {
  return allowGuests && guestRoomIdFor(pathname, state) !== null;
}

// ─── Errors in plain words ──────────────────────────────────────────────────

export const TOO_MANY_ATTEMPTS = 'Too many attempts. Wait a minute and try again.';
export const CREDENTIALS_DONT_MATCH = "That email and password don't match.";
export const EMAIL_NOT_CONFIRMED = 'That account is not confirmed yet. Check your email.';
export const CONFIRM_YOUR_EMAIL = 'Check your email to confirm your account.';
export const SIGN_IN_FAILED = 'Sign-in failed. Try again.';

function readField(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

/**
 * A message worth showing a person, or null.
 *
 * The rejections are the internals: a URL, a stack trace or a very long dump
 * describes the deployment, not what the person should do next. nginx's 429 is
 * the common case — its body is HTML, so supabase-js reports the JSON parse
 * failure as the message and only the status is meaningful.
 */
function humanMessage(error: unknown): string | null {
  const message = trimmed(readField(error, 'message'));
  if (!message || message.length > 160) return null;
  if (message.includes('http') || message.includes('\n') || message.includes('<')) return null;
  return message;
}

/** Any auth error, in words a person can act on. Never throws. */
export function describeAuthError(error: unknown): string {
  if (readField(error, 'status') === 429) return TOO_MANY_ATTEMPTS;

  const message = humanMessage(error) ?? '';
  if (
    readField(error, 'name') === 'AuthInvalidCredentialsError' ||
    /invalid (login )?credentials/i.test(message)
  ) {
    return CREDENTIALS_DONT_MATCH;
  }
  if (/email not confirmed/i.test(message)) return EMAIL_NOT_CONFIRMED;

  return message || SIGN_IN_FAILED;
}

/** What `signInWithPassword` / `signUp` hand back. */
export interface AuthResultLike {
  data?: { session?: unknown | null } | null;
  error?: unknown;
}

/**
 * The line to show after a sign-up, or null when it signed the person straight
 * in. Self-hosted GoTrue auto-confirms and returns a session; a provider that
 * requires email confirmation (hosted Supabase, say) returns a user and no
 * session, and the person has to go to their inbox.
 */
export function describeSignUpResult(result: AuthResultLike | null): string | null {
  if (!result) return SIGN_IN_FAILED;
  if (result.error) return describeAuthError(result.error);
  return result.data?.session ? null : CONFIRM_YOUR_EMAIL;
}
