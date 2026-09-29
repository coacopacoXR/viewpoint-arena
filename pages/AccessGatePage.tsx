// The front-door gate: a full-page password form shown before any route renders
// when the deployment has ACCESS_PASSWORD_HASH set and this browser has not yet
// unlocked. One input, one button, an error line, and a note that the password
// comes from whoever runs the deployment. Nothing is stored in localStorage —
// the HttpOnly cookie is the state.
//
// This is a shared password, not per-person access control. Anyone with the
// password gets in; the app cannot tell one person from another. That is the
// design decision in docs/plan/11-accounts-and-admin.md §M.

import React, { useState } from 'react';
import { useAccessGate } from '../lib/access/useAccessGate.ts';

const AccessGatePage: React.FC = () => {
  const { submit } = useAccessGate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    const err = await submit(password);
    if (err) {
      setError(err);
      setSubmitting(false);
    }
    // On success the parent re-renders (unlocked flips to true) and this
    // component unmounts. No need to clear state here.
  }

  return (
    <div
      className="min-h-screen bg-[#0A0A0A] flex items-center justify-center px-6"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
            <span className="text-black font-black text-sm">VA</span>
          </div>
          <span className="font-mono text-white text-sm font-bold tracking-widest uppercase">
            Viewpoint Arena
          </span>
        </div>

        <div>
          <h1 className="text-white text-2xl font-bold">Password required</h1>
          <p className="text-gray-500 text-sm mt-2">
            This deployment is password protected. Enter the password to continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }}
              placeholder="Enter password"
              autoFocus
              disabled={submitting}
              className="w-full bg-white/5 border border-white/10 text-white rounded-xl px-4 py-3 text-sm outline-none focus:border-white/30 placeholder:text-gray-700 transition-colors disabled:opacity-50"
            />
          </div>

          {error && (
            <p className="text-red-400 text-xs font-mono">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full text-sm font-bold py-3 rounded-xl bg-white hover:bg-gray-100 text-gray-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Checking…' : 'Enter'}
          </button>
        </form>

        <p className="text-gray-700 text-[11px] font-mono leading-relaxed">
          The password is set by whoever runs this deployment. If you do not
          have it, ask the person who shared the link.
        </p>
      </div>
    </div>
  );
};

export default AccessGatePage;
