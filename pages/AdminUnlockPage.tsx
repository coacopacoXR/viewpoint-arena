// Admin unlock page: a passphrase form shown when the deployment has an admin
// passphrase configured and this browser has not yet unlocked. Same visual
// shape as AccessGatePage — one input, one button, an error line.
//
// This is a shared passphrase, not a per-person account. Anyone with the
// passphrase gets admin access; the app cannot tell one admin from another.

import React, { useState } from 'react';
import { useAdminGate } from '../lib/access/useAdminGate.ts';

const AdminUnlockPage: React.FC = () => {
  const { submit } = useAdminGate();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    const err = await submit(passphrase);
    if (err) {
      setError(err);
      setSubmitting(false);
    }
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
          <h1 className="text-white text-2xl font-bold">Admin access</h1>
          <p className="text-gray-500 text-sm mt-2">
            Enter the admin passphrase to manage reviews and settings.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2">
              Passphrase
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => { setPassphrase(e.target.value); setError(''); }}
              placeholder="Enter admin passphrase"
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
            disabled={submitting || !passphrase}
            className="w-full text-sm font-bold py-3 rounded-xl bg-white hover:bg-gray-100 text-gray-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default AdminUnlockPage;
