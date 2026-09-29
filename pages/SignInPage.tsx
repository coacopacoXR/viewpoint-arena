// SignInPage — the door a deployment with identity shows instead of the page
// that was asked for.
//
// It is the lobby's frame (dark split screen: brand column left, form column
// right) with a sign-in form where the name form is, so a person who has only
// ever seen this app recognises it. No new colours, no new fonts.
//
// It does NOT navigate. The IdentityGate renders this page at the URL that was
// asked for and keeps rendering it until useAuth reports a session, at which
// point the gate swaps in the real page — so the path and its location.state
// (the joinRoomId a room link carries) survive sign-in without being
// serialised into a redirect.
//
// Deliberately absent: password reset. GoTrue serves one at
// /auth/v1/recovery and wiring it needs a landing route, which is part 3's
// "later" row rather than this batch.

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AVATAR_COLORS, getStoredIdentity } from '../lib/identity';
import type { IdentityMethod } from '../lib/config/schema';
import {
  describeAuthError,
  describeSignUpResult,
  ssoButtonsFor,
  type SsoButton,
} from '../lib/auth/authRules';
import { fetchGoTrueSettings } from '../lib/auth/gotrueSettings';
import type { GuestIdentity } from '../lib/auth/useAuth';

interface SignInPageProps {
  /** The methods this deployment offers, straight from the public config. */
  methods: IdentityMethod[];
  /** The room a guest may enter, or null when guests are not allowed here. */
  guestRoomId: string | null;
  /** Called once the guest form is filled in; the gate does the navigating. */
  onGuest: (guest: GuestIdentity) => void;
}

const FEATURES = [
  { icon: '🧊', label: '3D spatial annotations' },
  { icon: '🤖', label: 'Multi-agent AI analysis' },
  { icon: '🔴', label: 'Live risk matrix & tracking' },
  { icon: '💬', label: 'Teams & SharePoint sync' },
  { icon: '⚙️', label: 'Teamcenter PLM push' },
];

const INPUT_CLASS =
  'w-full bg-white/5 border border-white/10 text-white rounded-xl px-4 py-3 text-sm outline-none focus:border-white/30 placeholder:text-gray-700 transition-colors disabled:opacity-50';

const PRIMARY_BUTTON_CLASS =
  'w-full text-sm font-bold py-3 rounded-xl bg-white hover:bg-gray-100 text-gray-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const Divider: React.FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-3">
    <div className="flex-1 h-px bg-white/5" />
    <span className="text-[10px] font-mono uppercase tracking-widest text-gray-600">{label}</span>
    <div className="flex-1 h-px bg-white/5" />
  </div>
);

const SignInPage: React.FC<SignInPageProps> = ({ methods, guestRoomId, onGuest }) => {
  const buttons = ssoButtonsFor(methods);
  const hasPassword = methods.includes('password');

  const [passwordMode, setPasswordMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // Sign-up is offered only when GoTrue says it accepts it. Read once: the
  // answer cannot change without a redeploy of the identity service.
  const [signupAllowed, setSignupAllowed] = useState(false);
  useEffect(() => {
    if (!hasPassword) return;
    let active = true;
    fetchGoTrueSettings().then((settings) => {
      if (active) setSignupAllowed(settings !== null && !settings.disableSignup);
    });
    return () => {
      active = false;
    };
  }, [hasPassword]);

  const [guestFormOpen, setGuestFormOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestColor, setGuestColor] = useState(
    () => getStoredIdentity()?.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
  );

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy('password');
    setError('');
    setNotice('');

    const credentials = { email: email.trim(), password };
    if (passwordMode === 'signup') {
      // A mistyped password on sign-up is a password nobody knows, and there is
      // no reset email on a stack without a mail server — so ask twice.
      if (password !== passwordRepeat) {
        setError("The two passwords don't match.");
        setBusy(null);
        return;
      }
      // The name goes on the account (user_metadata.full_name), which is where
      // displayNameForAccount reads it. Without it a new account showed up in
      // rooms as the part of the email before the @.
      const result = await supabase.auth.signUp({
        ...credentials,
        options: { data: { full_name: fullName.trim() } },
      });
      const line = describeSignUpResult(result);
      // No session back means the provider wants an email confirmation first —
      // an instruction, not a failure, so it is not shown in the error colour.
      if (line) setNotice(line);
    } else {
      const { error: signInError } = await supabase.auth.signInWithPassword(credentials);
      if (signInError) setError(describeAuthError(signInError));
      // On success there is nothing to do here: onAuthStateChange flips the
      // gate and this page unmounts.
    }
    setBusy(null);
  }

  async function startOAuth(button: SsoButton) {
    if (busy) return;
    setBusy(button.provider);
    setError('');
    setNotice('');

    // Come back to the page that was asked for, not to the site root: a room
    // link has to survive the round trip through the provider.
    const redirectTo =
      window.location.origin + window.location.pathname + window.location.search;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: button.provider,
      options: button.scopes ? { redirectTo, scopes: button.scopes } : { redirectTo },
    });
    // On success the browser has already been handed off to the provider.
    if (oauthError) {
      setError(describeAuthError(oauthError));
      setBusy(null);
    }
  }

  function submitGuest(e: React.FormEvent) {
    e.preventDefault();
    if (!guestName.trim()) {
      setError('Enter your name first.');
      return;
    }
    onGuest({ name: guestName.trim(), color: guestColor });
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex font-sans" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* ── Left Panel: Branding ── */}
      <div className="hidden lg:flex flex-col justify-between w-[420px] flex-shrink-0 border-r border-white/5 px-10 py-12">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
              <span className="text-black font-black text-sm">VA</span>
            </div>
            <span className="font-mono text-white text-sm font-bold tracking-widest uppercase">Viewpoint Arena</span>
          </div>
          <p className="text-gray-600 text-sm mt-4 leading-relaxed">
            AI-powered collaborative design review. Real-time 3D sessions with automated risk, action, and rationale capture.
          </p>

          <div className="mt-8 space-y-3">
            {FEATURES.map(f => (
              <div key={f.label} className="flex items-center gap-3">
                <span className="text-base">{f.icon}</span>
                <span className="text-gray-500 text-sm">{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="text-gray-700 text-[11px] font-mono leading-relaxed">
          Sign-in is provided by whoever runs this deployment. If you do not have
          an account, ask the person who shared the link.
        </p>
      </div>

      {/* ── Right Panel: Sign in ── */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm space-y-8">

          <div>
            <p className="text-gray-600 text-xs font-mono uppercase tracking-widest mb-1">Viewpoint Arena</p>
            <h1 className="text-white text-3xl font-bold">Sign in</h1>
            <p className="text-gray-600 text-sm mt-2">
              {guestRoomId
                ? "You've been invited to a session. Sign in to continue."
                : 'This deployment asks you to sign in.'}
            </p>
          </div>

          <div className="space-y-4">
            {/* One button per external method. ssoButtonsFor() is what leaves
                'saml' out: no SAML provider is registered with GoTrue until
                part 3, so there is nothing to redirect to yet. */}
            {buttons.map(button => (
              <button
                key={button.provider}
                onClick={() => startOAuth(button)}
                disabled={busy !== null}
                className={PRIMARY_BUTTON_CLASS}
              >
                {busy === button.provider ? 'Opening…' : button.label}
              </button>
            ))}

            {buttons.length > 0 && hasPassword && <Divider label="or" />}

            {hasPassword && (
              <form onSubmit={submitPassword} className="space-y-4">
                {passwordMode === 'signup' && (
                  <div>
                    <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
                      Your name
                    </label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={e => { setFullName(e.target.value); setError(''); setNotice(''); }}
                      placeholder="e.g. Alex Chen"
                      autoComplete="name"
                      disabled={busy !== null}
                      className={INPUT_CLASS}
                    />
                  </div>
                )}
                <div>
                  <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => { setEmail(e.target.value); setError(''); setNotice(''); }}
                    placeholder="you@company.com"
                    autoComplete="username"
                    autoFocus
                    disabled={busy !== null}
                    className={INPUT_CLASS}
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={e => { setPassword(e.target.value); setError(''); setNotice(''); }}
                    placeholder="Your password"
                    autoComplete={passwordMode === 'signup' ? 'new-password' : 'current-password'}
                    disabled={busy !== null}
                    className={INPUT_CLASS}
                  />
                </div>

                {passwordMode === 'signup' && (
                  <div>
                    <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
                      Repeat password
                    </label>
                    <input
                      type="password"
                      value={passwordRepeat}
                      onChange={e => { setPasswordRepeat(e.target.value); setError(''); setNotice(''); }}
                      placeholder="Type it again"
                      autoComplete="new-password"
                      disabled={busy !== null}
                      className={INPUT_CLASS}
                    />
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy !== null || !email.trim() || !password || (passwordMode === 'signup' && (!fullName.trim() || !passwordRepeat))}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  {busy === 'password'
                    ? 'Checking…'
                    : passwordMode === 'signup'
                      ? 'Create account'
                      : 'Sign in'}
                </button>

                {signupAllowed && (
                  <button
                    type="button"
                    onClick={() => {
                      setPasswordMode(m => (m === 'signup' ? 'signin' : 'signup'));
                      setError('');
                      setNotice('');
                    }}
                    disabled={busy !== null}
                    className="w-full text-[11px] font-mono text-gray-600 hover:text-gray-400 transition-colors"
                  >
                    {passwordMode === 'signup'
                      ? 'Already have an account? Sign in'
                      : 'Create an account'}
                  </button>
                )}
              </form>
            )}

            {!hasPassword && buttons.length === 0 && (
              <p className="text-gray-500 text-xs font-mono">
                This deployment has no sign-in method configured. Ask whoever runs it.
              </p>
            )}

            {error && <p className="text-red-400 text-xs font-mono">{error}</p>}
            {notice && <p className="text-gray-400 text-xs font-mono">{notice}</p>}
          </div>

          {/* ── Guests: only where a room invitation allows it ── */}
          {guestRoomId && (
            <div className="space-y-4">
              <Divider label="no account?" />
              {guestFormOpen ? (
                <form onSubmit={submitGuest} className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
                      Your name
                    </label>
                    <input
                      type="text"
                      value={guestName}
                      onChange={e => { setGuestName(e.target.value); setError(''); }}
                      placeholder="e.g. Alex Chen"
                      maxLength={40}
                      autoFocus
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
                      Avatar colour
                    </label>
                    <div className="flex gap-2">
                      {AVATAR_COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setGuestColor(c)}
                          className="w-7 h-7 rounded-full border-2 transition-all hover:scale-110"
                          style={{ backgroundColor: c, borderColor: guestColor === c ? '#fff' : 'transparent' }}
                        />
                      ))}
                    </div>
                  </div>

                  <button type="submit" disabled={!guestName.trim()} className={PRIMARY_BUTTON_CLASS}>
                    Enter the room
                  </button>
                  <p className="text-gray-700 text-[10px] font-mono leading-relaxed">
                    You will join this session as a guest, and the host still has to let you in.
                  </p>
                </form>
              ) : (
                <button
                  onClick={() => { setGuestFormOpen(true); setError(''); setNotice(''); }}
                  className="w-full text-sm font-bold py-3 rounded-xl bg-white/10 hover:bg-white/20 text-gray-300 hover:text-white border border-white/10 transition-colors"
                >
                  Join as a guest
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SignInPage;
