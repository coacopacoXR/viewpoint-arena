// Admin screen — one console with a left section list.
//
// Two authentication modes:
//   - identity.mode 'none': the admin passphrase, exactly as before. The
//     People section is absent. useAdminGate controls access.
//   - identity.mode 'accounts' | 'sso': a signed-in account with the admin
//     role. The passphrase is not used. The user's Supabase access token is
//     sent as Authorization: Bearer to the admin endpoints.
//
// Sections:
//   - People (accounts/sso only) — manage accounts
//   - Reviews — every review, toggle listed, delete
//   - AI — which provider does transcription, cards and summary
//   - Labels — label field settings
//   - Access — read-only explanation + "Lock this browser"
//   - Activity — audit log
//
// Rooms and Models are not built yet (batch BE). The sidebar leaves space for
// them but does not render placeholder items that do nothing.
//
// First-admin claim: when no admin account exists yet, a signed-in person
// sees "No one administers this install yet. Make me the administrator" —
// one click, checked server-side at the moment of the request.

import React, { useState, useEffect, useCallback } from 'react';
import { useAdminGate } from '../lib/access/useAdminGate.ts';
import { useLabelFieldsStore } from '../lib/labelFieldsStore';
import {
  deleteCuration,
  setCurationListed,
} from '../lib/curationsRepo';
import { listAuditEvents, type AuditEvent, type AuditListResult } from '../lib/auditRepo';
import AdminUnlockPage from './AdminUnlockPage.tsx';
import LabelFieldsSettings from '../components/UI/LabelFieldsSettings';
import AiSettingsSection from '../components/UI/AiSettingsSection';
import { useConnectorConfig } from '../lib/config/ConfigContext';
import { supabase } from '../lib/supabase';

type Section = 'people' | 'reviews' | 'models' | 'ai' | 'labels' | 'access' | 'activity';

// ─── Gate logic ──────────────────────────────────────────────────────────────

const AdminPage: React.FC = () => {
  const { config } = useConnectorConfig();
  const mode = config?.identity?.mode ?? 'none';

  if (mode === 'accounts' || mode === 'sso') {
    return <AdminWithAccounts mode={mode} />;
  }

  return <AdminWithPassphrase />;
};

// ─── Passphrase mode (unchanged behaviour) ───────────────────────────────────

const AdminWithPassphrase: React.FC = () => {
  const { required, unlocked, loading } = useAdminGate();

  if (loading) return null;
  if (!required) return <NotConfigured />;
  if (!unlocked) return <AdminUnlockPage />;
  return <AdminContent mode="none" />;
};

// ─── Accounts/SSO mode ───────────────────────────────────────────────────────

const AdminWithAccounts: React.FC<{ mode: 'accounts' | 'sso' }> = ({ mode }) => {
  const [adminCount, setAdminCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const loadAdminCount = useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) {
        setLoading(false);
        return;
      }
      const res = await fetch('/api/admin/users', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        // Not an admin. Offer the claim only when the install has no admin
        // yet; otherwise say so, instead of a button that can only fail.
        const status = await fetch('/api/admin/claim', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const body = status.ok ? ((await status.json()) as { adminsExist?: boolean }) : null;
        setAdminCount(body && body.adminsExist ? -2 : 0);
        setLoading(false);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { users: AdminUser[] };
        const count = data.users.filter((u) => u.role === 'admin').length;
        setAdminCount(count);
      }
    } catch {
      // Endpoint unreachable — stay on the loading state.
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAdminCount();
  }, [loadAdminCount]);

  const handleClaim = async () => {
    setClaiming(true);
    setClaimError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setClaimError('Not signed in.');
        setClaiming(false);
        return;
      }
      const res = await fetch('/api/admin/claim', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        // The admin role lives in the access token's app_metadata, and the
        // token in hand was issued before the claim — without a refresh every
        // admin call is still refused (found live).
        await supabase.auth.refreshSession();
        await loadAdminCount();
      } else if (res.status === 409) {
        setClaimError('An administrator already exists.');
        await loadAdminCount();
      } else {
        setClaimError('Claim failed. Try again.');
      }
    } catch {
      setClaimError('Could not reach the server.');
    }
    setClaiming(false);
  };

  if (loading) return null;

  if (adminCount === -2) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-white text-2xl font-bold">You are not an administrator</h1>
          <p className="text-gray-500 text-sm">
            This install already has an administrator. Ask them to make you one
            in Admin → People.
          </p>
          <a href="/" className="inline-block text-sm text-gray-300 underline">Back to the lobby</a>
        </div>
      </div>
    );
  }

  // No admins yet — show the claim banner.
  if (adminCount === 0) {
    return <ClaimBanner onClaim={handleClaim} claiming={claiming} error={claimError} mode={mode} />;
  }

  return <AdminContent mode={mode} />;
};

// ─── Claim banner ────────────────────────────────────────────────────────────

const ClaimBanner: React.FC<{
  onClaim: () => void;
  claiming: boolean;
  error: string | null;
  mode: 'accounts' | 'sso';
}> = ({ onClaim, claiming, error }) => (
  <div
    className="min-h-screen bg-[#0A0A0A] flex items-center justify-center px-6"
    style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
  >
    <div className="w-full max-w-sm space-y-4 text-center">
      <div className="flex items-center justify-center gap-2 mb-2">
        <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
          <span className="text-black font-black text-sm">VA</span>
        </div>
        <span className="font-mono text-white text-sm font-bold tracking-widest uppercase">
          Viewpoint Arena
        </span>
      </div>
      <h1 className="text-white text-2xl font-bold">No administrator yet</h1>
      <p className="text-gray-500 text-sm leading-relaxed">
        No one administers this install yet. Whoever clicks the button below
        becomes the administrator — and can then manage accounts from the
        People section.
      </p>
      <button
        onClick={onClaim}
        disabled={claiming}
        className="w-full text-sm font-semibold px-4 py-2.5 rounded-lg bg-white text-gray-900 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {claiming ? 'Claiming…' : 'Make me the administrator'}
      </button>
      {error && (
        <p className="text-red-400 text-xs">{error}</p>
      )}
    </div>
  </div>
);

// ─── Not configured ──────────────────────────────────────────────────────────

const NotConfigured: React.FC = () => (
  <div
    className="min-h-screen bg-[#0A0A0A] flex items-center justify-center px-6"
    style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
  >
    <div className="w-full max-w-sm space-y-4 text-center">
      <div className="flex items-center justify-center gap-2 mb-2">
        <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
          <span className="text-black font-black text-sm">VA</span>
        </div>
        <span className="font-mono text-white text-sm font-bold tracking-widest uppercase">
          Viewpoint Arena
        </span>
      </div>
      <h1 className="text-white text-2xl font-bold">Admin not available</h1>
      <p className="text-gray-500 text-sm leading-relaxed">
        The admin passphrase is not set on this deployment. Run{' '}
        <code className="text-gray-400 bg-white/5 px-1.5 py-0.5 rounded text-xs font-mono">
          ./install.sh
        </code>{' '}
        to configure one.
      </p>
    </div>
  </div>
);

// ─── Admin content (sidebar + sections) ──────────────────────────────────────

const AdminContent: React.FC<{ mode: 'none' | 'accounts' | 'sso' }> = ({ mode }) => {
  const { lock } = useAdminGate();
  const [section, setSection] = useState<Section>(mode !== 'none' ? 'people' : 'reviews');
  const [labelSettingsOpen, setLabelSettingsOpen] = useState(false);
  const labelFields = useLabelFieldsStore((s) => s.fields);
  const loadLabelFields = useLabelFieldsStore((s) => s.load);
  const labelFieldsLoaded = useLabelFieldsStore((s) => s.loaded);

  useEffect(() => {
    if (!labelFieldsLoaded) loadLabelFields();
  }, [labelFieldsLoaded, loadLabelFields]);

  const sections: { id: Section; label: string }[] = [
    ...(mode !== 'none' ? [{ id: 'people' as Section, label: 'People' }] : []),
    { id: 'reviews', label: 'Design reviews' },
    { id: 'models', label: 'Models' },
    { id: 'ai', label: 'AI' },
    { id: 'labels', label: 'Labels' },
    { id: 'access', label: 'Access' },
    { id: 'activity', label: 'Activity' },
  ];

  const handleLock = mode === 'none' ? lock : async () => {
    await supabase.auth.signOut();
  };

  return (
    <div
      className="min-h-screen bg-[#0A0A0A] text-white"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      <div className="flex min-h-screen">
        {/* Sidebar */}
        <aside className="w-56 border-r border-white/10 flex flex-col">
          <div className="px-4 py-5 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 bg-white rounded-lg flex items-center justify-center">
                <span className="text-black font-black text-xs">VA</span>
              </div>
              <span className="font-mono text-white text-xs font-bold tracking-widest uppercase">
                Admin
              </span>
            </div>
          </div>
          <nav className="flex-1 px-2 py-3 space-y-0.5">
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`w-full text-left text-xs font-medium px-3 py-2 rounded-lg transition-colors ${
                  section === s.id
                    ? 'bg-white/10 text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="px-2 py-3 border-t border-white/10">
            <button
              onClick={handleLock}
              className="w-full text-left text-[10px] font-mono text-gray-500 hover:text-white transition-colors px-3 py-2"
            >
              {mode === 'none' ? 'Lock this browser' : 'Sign out'}
            </button>
          </div>
        </aside>

        {/* Content */}
        <main className="flex-1 px-8 py-8 max-w-3xl">
          {section === 'people' && mode !== 'none' && <PeopleSection />}
          {section === 'reviews' && <ReviewsSection mode={mode} />}
          {section === 'models' && <ModelsSection mode={mode} />}
          {/* In passphrase mode the admin cookie rides along on a plain
              same-origin fetch; in accounts/sso mode the token has to be
              attached, which is what adminFetch does. */}
          {section === 'ai' && (
            <AiSettingsSection request={mode === 'none' ? undefined : adminFetch} />
          )}
          {section === 'labels' && (
            <LabelFieldsSection onOpen={() => setLabelSettingsOpen(true)} />
          )}
          {section === 'access' && <AccessSection mode={mode} onLock={handleLock} />}
          {section === 'activity' && <ActivitySection />}
        </main>
      </div>

      {labelSettingsOpen && (
        <LabelFieldsSettings
          fields={labelFields}
          onClose={() => setLabelSettingsOpen(false)}
        />
      )}
    </div>
  );
};

// ─── People section ──────────────────────────────────────────────────────────

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
  last_sign_in_at: string | null;
  disabled: boolean;
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function adminFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new Error('not_signed_in');
  return fetch(path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

const PeopleSection: React.FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await adminFetch('/api/admin/users');
      if (res.status === 401 || res.status === 403) {
        setError('You do not have admin access.');
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError('Could not load people.');
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { users: AdminUser[] };
      setUsers(data.users);
      setError(null);
    } catch {
      setError('Could not reach the server.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleToggleAdmin = async (user: AdminUser) => {
    const res = await adminFetch(`/api/admin/users?id=${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ admin: user.role !== 'admin' }),
    });
    if (res.ok) {
      await reload();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Operation failed.');
    }
  };

  const handleToggleDisabled = async (user: AdminUser) => {
    const res = await adminFetch(`/api/admin/users?id=${encodeURIComponent(user.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ disabled: !user.disabled }),
    });
    if (res.ok) {
      await reload();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Operation failed.');
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    const res = await adminFetch(`/api/admin/users?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setConfirmDeleteId(null);
      await reload();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Delete failed.');
    }
  };

  if (loading) {
    return <p className="text-gray-600 text-xs">Loading…</p>;
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest">
          People{users.length > 0 ? ` · ${users.length}` : ''}
        </h2>
        <button
          onClick={() => setAddOpen(true)}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white text-gray-900 hover:bg-gray-100 transition-colors"
        >
          Add person
        </button>
      </div>

      {error && (
        <p className="text-red-400 text-xs mb-3">{error}</p>
      )}

      {users.length === 0 ? (
        <p className="text-gray-600 text-xs">No accounts yet.</p>
      ) : (
        <div className="space-y-2">
          {users.map((u) => (
            <div
              key={u.id}
              className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-xl px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">
                  {u.name || u.email}
                </p>
                <p className="text-[10px] font-mono text-gray-500 mt-0.5">
                  {u.email} · {u.role === 'admin' ? 'Admin' : 'Member'}
                  {u.disabled ? ' · Disabled' : ''}
                  {u.last_sign_in_at
                    ? ` · Last sign-in ${new Date(u.last_sign_in_at).toLocaleDateString()}`
                    : ' · Never signed in'}
                </p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => handleToggleAdmin(u)}
                  className="text-[10px] font-mono px-2 py-1 rounded border border-white/10 hover:border-white/30 transition-colors"
                >
                  {u.role === 'admin' ? 'Remove admin' : 'Make admin'}
                </button>
                <button
                  onClick={() => handleToggleDisabled(u)}
                  className="text-[10px] font-mono px-2 py-1 rounded border border-white/10 hover:border-white/30 transition-colors"
                >
                  {u.disabled ? 'Enable' : 'Disable'}
                </button>
                {confirmDeleteId === u.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(u.id)}
                      className="text-[10px] font-mono px-2 py-1 rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => handleDelete(u.id)}
                    className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-red-400 transition-colors"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {addOpen && <AddPersonForm onClose={() => setAddOpen(false)} onCreated={reload} />}
    </section>
  );
};

// ─── Add person form ─────────────────────────────────────────────────────────

const AddPersonForm: React.FC<{ onClose: () => void; onCreated: () => void }> = ({
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    if (password !== password2) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await adminFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          password,
          name: name.trim(),
          admin: isAdmin,
        }),
      });
      if (res.ok) {
        onCreated();
        onClose();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'Could not create account.');
      }
    } catch {
      setError('Could not reach the server.');
    }
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6">
      <div className="w-full max-w-sm bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 space-y-4">
        <h3 className="text-white text-sm font-bold">Add person</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-white/30"
          />
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-white/30"
          />
          <input
            type="password"
            placeholder="Temporary password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-white/30"
          />
          <input
            type="password"
            placeholder="Repeat password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            required
            className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-gray-500 focus:outline-none focus:border-white/30"
          />
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
              className="rounded border-white/20"
            />
            Make this person an administrator
          </label>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={submitting}
              className="text-xs font-semibold px-4 py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-medium px-4 py-2 rounded-lg text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ─── Reviews section ─────────────────────────────────────────────────────────

interface AdminReview {
  id: string;
  title: string;
  listed: boolean;
  archived: boolean;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
  member_count: number;
  revisions_count: number;
  last_meeting_at: string | null;
  updated_at: string;
  created_at: string;
}

const ReviewsSection: React.FC<{ mode: 'none' | 'accounts' | 'sso' }> = ({ mode }) => {
  const [reviews, setReviews] = useState<AdminReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [search, setSearch] = useState('');
  const [transferId, setTransferId] = useState<string | null>(null);
  const [transferEmail, setTransferEmail] = useState('');
  const [transferError, setTransferError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = mode === 'none'
        ? await fetch('/api/admin/reviews')
        : await adminFetch('/api/admin/reviews');
      if (res.ok) {
        const data = (await res.json()) as { reviews: AdminReview[] };
        setReviews(data.reviews);
      }
    } catch {
      // Unreachable — stay on the loaded state.
    }
    setLoaded(true);
  }, [mode]);

  useEffect(() => { void reload(); }, [reload]);

  const filtered = reviews.filter((r) => {
    if (filter === 'active' && r.archived) return false;
    if (filter === 'archived' && !r.archived) return false;
    if (search && !r.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const handleToggleListed = async (r: AdminReview) => {
    const ok = await setCurationListed(r.id, !r.listed);
    if (ok) {
      setReviews((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, listed: !x.listed } : x)),
      );
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    const ok = await deleteCuration(id);
    if (ok) {
      setReviews((prev) => prev.filter((x) => x.id !== id));
      setConfirmDeleteId(null);
    }
  };

  const cancelDelete = () => setConfirmDeleteId(null);

  const handleArchive = async (r: AdminReview) => {
    const fetchFn = mode === 'none'
      ? (path: string, opts: RequestInit) => fetch(path, opts)
      : (path: string, opts: RequestInit) => adminFetch(path, opts);
    const res = await fetchFn(`/api/admin/reviews?id=${encodeURIComponent(r.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: !r.archived }),
    });
    if (res.ok) {
      setReviews((prev) =>
        prev.map((x) => (x.id === r.id ? { ...x, archived: !x.archived } : x)),
      );
    }
  };

  const handleTransfer = async (id: string) => {
    if (!transferEmail.trim()) return;
    setTransferError(null);
    const fetchFn = mode === 'none'
      ? (path: string, opts: RequestInit) => fetch(path, opts)
      : (path: string, opts: RequestInit) => adminFetch(path, opts);
    const res = await fetchFn(`/api/admin/reviews?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ owner_email: transferEmail.trim() }),
    });
    if (res.ok) {
      setTransferId(null);
      setTransferEmail('');
      await reload();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setTransferError(data.error ?? 'Transfer failed.');
    }
  };

  return (
    <section>
      <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest mb-4">
        Design reviews{loaded && filtered.length > 0 ? ` · ${filtered.length}` : ''}
      </h2>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center gap-1">
          {(['active', 'archived', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-[10px] font-mono px-2 py-1 rounded border transition-colors ${
                filter === f
                  ? 'border-white/30 text-white bg-white/10'
                  : 'border-white/10 text-gray-500 hover:text-white hover:border-white/30'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-white/30"
        />
      </div>

      {!loaded ? (
        <p className="text-gray-600 text-xs">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-gray-600 text-xs">No design reviews match.</p>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
          {filtered.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {r.title || 'Untitled'}
                    {r.archived && (
                      <span className="ml-2 text-[10px] font-mono text-gray-500 normal-case">archived</span>
                    )}
                  </p>
                  <p className="text-[10px] font-mono text-gray-500 mt-0.5">
                    {new Date(r.updated_at).toLocaleDateString()}
                    {' · '}
                    {r.listed ? 'Listed' : 'Link-only'}
                    {' · '}
                    {r.member_count} member{r.member_count !== 1 ? 's' : ''}
                    {' · '}
                    {r.revisions_count} revision{r.revisions_count !== 1 ? 's' : ''}
                    {r.last_meeting_at && (
                      <>
                        {' · Last meeting '}
                        {new Date(r.last_meeting_at).toLocaleDateString()}
                      </>
                    )}
                  </p>
                  {mode !== 'none' && r.owner_email && (
                    <p className="text-[10px] font-mono text-gray-500 mt-0.5">
                      Owner: {r.owner_name || r.owner_email}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleToggleListed(r)}
                    className="text-[10px] font-mono px-2 py-1 rounded border border-white/10 hover:border-white/30 transition-colors"
                  >
                    {r.listed ? 'Make link-only' : 'List in lobby'}
                  </button>
                  <button
                    onClick={() => handleArchive(r)}
                    className="text-[10px] font-mono px-2 py-1 rounded border border-white/10 hover:border-white/30 transition-colors"
                  >
                    {r.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  {mode !== 'none' && (
                    <button
                      onClick={() => { setTransferId(r.id); setTransferEmail(''); setTransferError(null); }}
                      className="text-[10px] font-mono px-2 py-1 rounded border border-white/10 hover:border-white/30 transition-colors"
                    >
                      Transfer
                    </button>
                  )}
                </div>
              </div>

              {/* Transfer form */}
              {transferId === r.id && (
                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="email"
                    placeholder="New owner email…"
                    value={transferEmail}
                    onChange={(e) => setTransferEmail(e.target.value)}
                    className="flex-1 text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-white placeholder:text-gray-500 focus:outline-none focus:border-white/30"
                  />
                  <button
                    onClick={() => handleTransfer(r.id)}
                    className="text-[10px] font-mono px-2 py-1 rounded bg-white/10 text-white hover:bg-white/20 transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => { setTransferId(null); setTransferError(null); }}
                    className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  {transferError && (
                    <span className="text-[10px] text-red-400">{transferError}</span>
                  )}
                </div>
              )}

              {/* Delete confirm */}
              <div className="flex items-center gap-1">
                {confirmDeleteId === r.id ? (
                  <>
                    <button
                      onClick={() => handleDelete(r.id)}
                      className="text-[10px] font-mono px-2 py-1 rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                    >
                      Confirm delete
                    </button>
                    <button
                      onClick={cancelDelete}
                      className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => handleDelete(r.id)}
                    className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-red-400 transition-colors"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

// ─── Models section ──────────────────────────────────────────────────────────

interface ModelRevisionRef {
  id: string;
  review_id: string;
  review_title: string;
  line: string;
  revision: string;
}

interface CurationRef {
  review_id: string;
  review_title: string;
}

interface AdminModelEntry {
  hash: string;
  file_name: string;
  size: number;
  content_type: string;
  uploaded_at: string;
  uploaded_by_name: string;
  /** False for a file storage holds that no design review points at. */
  referenced: boolean;
  revisions: ModelRevisionRef[];
  curation_refs: CurationRef[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const ModelsSection: React.FC<{ mode: 'none' | 'accounts' | 'sso' }> = ({ mode }) => {
  const [models, setModels] = useState<AdminModelEntry[]>([]);
  const [totalStorage, setTotalStorage] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteHash, setConfirmDeleteHash] = useState<string | null>(null);

  const fetchFn = useCallback((path: string, opts: RequestInit = {}) => {
    return mode === 'none' ? fetch(path, opts) : adminFetch(path, opts);
  }, [mode]);

  const reload = useCallback(async () => {
    try {
      const res = await fetchFn('/api/admin/models');
      if (res.ok) {
        const data = (await res.json()) as { models: AdminModelEntry[]; total_storage: number };
        setModels(data.models);
        setTotalStorage(data.total_storage);
      } else if (res.status === 503) {
        setError('Storage is not available on this deployment.');
      }
    } catch {
      setError('Could not reach the server.');
    }
    setLoaded(true);
  }, [fetchFn]);

  useEffect(() => { void reload(); }, [reload]);

  const handleDeleteRevision = async (revisionId: string) => {
    const res = await fetchFn(
      `/api/admin/models?type=revision&id=${encodeURIComponent(revisionId)}`,
      { method: 'DELETE' },
    );
    if (res.ok) {
      await reload();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Delete failed.');
    }
  };

  const handleDeleteFile = async (hash: string) => {
    if (confirmDeleteHash !== hash) {
      setConfirmDeleteHash(hash);
      return;
    }
    const res = await fetchFn(
      `/api/admin/models?type=file&hash=${encodeURIComponent(hash)}`,
      { method: 'DELETE' },
    );
    if (res.ok) {
      setConfirmDeleteHash(null);
      await reload();
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? 'Delete failed.');
    }
  };

  // The endpoint marks each file `referenced`; the two lists it sends are
  // checked as well, so a delete button only ever comes up enabled when nothing
  // anywhere in the response points at the file.
  const hasAnyRef = (m: AdminModelEntry) =>
    m.referenced || m.revisions.length > 0 || m.curation_refs.length > 0;

  return (
    <section>
      <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest mb-4">
        Models{loaded && models.length > 0 ? ` · ${models.length}` : ''}
        {loaded && totalStorage > 0 && (
          <span className="ml-2 text-gray-500 normal-case">· {formatBytes(totalStorage)}</span>
        )}
      </h2>

      {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

      {!loaded ? (
        <p className="text-gray-600 text-xs">Loading…</p>
      ) : models.length === 0 ? (
        <p className="text-gray-600 text-xs">No model files stored yet.</p>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
          {models.map((m) => (
            <div
              key={m.hash}
              className="flex flex-col gap-1.5 bg-white/5 border border-white/10 rounded-xl px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {m.file_name || m.hash.slice(0, 12)}
                  </p>
                  <p className="text-[10px] font-mono text-gray-500 mt-0.5">
                    {formatBytes(m.size)}
                    {m.uploaded_by_name && ` · ${m.uploaded_by_name}`}
                    {m.uploaded_at && ` · ${new Date(m.uploaded_at).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {confirmDeleteHash === m.hash ? (
                    hasAnyRef(m) ? (
                      <button
                        onClick={() => setConfirmDeleteHash(null)}
                        className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors"
                      >
                        Cancel
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => handleDeleteFile(m.hash)}
                          className="text-[10px] font-mono px-2 py-1 rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmDeleteHash(null)}
                          className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    )
                  ) : (
                    <button
                      onClick={() => handleDeleteFile(m.hash)}
                      disabled={hasAnyRef(m)}
                      className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title={hasAnyRef(m) ? 'Still referenced — delete revisions first' : 'Delete file'}
                    >
                      Delete file
                    </button>
                  )}
                </div>
              </div>

              {/* References */}
              {!hasAnyRef(m) && (
                <p className="pl-2 text-[10px] font-mono text-gray-600">
                  Not used by any design review
                </p>
              )}
              {m.revisions.length > 0 && (
                <div className="pl-2 space-y-0.5">
                  {m.revisions.map((rev) => (
                    <div key={rev.id} className="flex items-center gap-2 text-[10px] font-mono text-gray-500">
                      <span>
                        {rev.review_title} · {rev.line} {rev.revision}
                      </span>
                      <button
                        onClick={() => handleDeleteRevision(rev.id)}
                        className="text-gray-600 hover:text-red-400 transition-colors"
                      >
                        remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {m.curation_refs.length > 0 && (
                <div className="pl-2 space-y-0.5">
                  {m.curation_refs.map((ref) => (
                    <p key={ref.review_id} className="text-[10px] font-mono text-gray-500">
                      Current model in: {ref.review_title}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

// ─── Label fields section ────────────────────────────────────────────────────

const LabelFieldsSection: React.FC<{ onOpen: () => void }> = ({ onOpen }) => (
  <section>
    <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest mb-4">
      Label fields
    </h2>
    <p className="text-gray-500 text-xs leading-relaxed mb-3">
      Configure how design reviews are organised across the install. Changes
      apply to every design review immediately.
    </p>
    <button
      onClick={onOpen}
      className="text-xs font-semibold px-4 py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-100 transition-colors"
    >
      Manage label fields
    </button>
  </section>
);

// ─── Access section ──────────────────────────────────────────────────────────

const AccessSection: React.FC<{ mode: 'none' | 'accounts' | 'sso'; onLock: () => void }> = ({
  mode,
  onLock,
}) => (
  <section>
    <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest mb-4">
      Access
    </h2>
    <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-4 space-y-3">
      {mode === 'none' ? (
        <>
          <p className="text-gray-400 text-xs leading-relaxed">
            The front-door password and the admin passphrase are set by{' '}
            <code className="text-gray-300 bg-white/5 px-1 py-0.5 rounded text-[10px] font-mono">
              ./install.sh
            </code>
            . They are shared passwords, not per-person accounts — anyone with the
            password gets in, and the app cannot tell one person from another.
          </p>
          <p className="text-gray-500 text-[11px] leading-relaxed">
            Rotating a password means editing the deployment's{' '}
            <code className="text-gray-400 font-mono">.env</code> and restarting
            the API container. That is not something a button on this screen can do
            safely, so password rotation is a server-side operation only.
          </p>
        </>
      ) : (
        <p className="text-gray-400 text-xs leading-relaxed">
          This deployment uses per-person accounts. People sign in with their
          email and password (or their company's identity provider). Administrators
          manage accounts from the People section.
        </p>
      )}
      <button
        onClick={onLock}
        className="text-xs font-semibold px-4 py-2 rounded-lg border border-white/10 hover:border-white/30 text-gray-300 hover:text-white transition-colors"
      >
        {mode === 'none' ? 'Lock this browser' : 'Sign out'}
      </button>
    </div>
  </section>
);

// ─── Activity section ────────────────────────────────────────────────────────

function formatAuditEvent(e: AuditEvent): string {
  const actor = e.actor_name || 'Someone';
  const subject = e.subject_name || 'someone';
  const room = e.room_id.slice(0, 8);
  const when = formatAuditTimestamp(e.at);
  switch (e.action) {
    case 'admitted':
      return `${actor} admitted ${subject} · room ${room} · ${when}`;
    case 'declined':
      return `${actor} declined ${subject} · room ${room} · ${when}`;
    case 'join_policy':
      return `${actor} set join policy to ${e.detail} · room ${room} · ${when}`;
    // Batch BY: the irreversible ones, written by the api with the verified caller.
    case 'review_deleted':
      return `${actor} deleted the design review "${e.subject_name || room}"${e.detail ? ` (${e.detail})` : ''} · ${when}`;
    case 'session_deleted':
      return `${actor} deleted a session of "${e.subject_name || room}"${e.detail ? ` (${e.detail})` : ''} · ${when}`;
    case 'variant_dropped':
      return `${actor} dropped ${e.subject_name || 'a variant'}${e.detail ? `: ${e.detail}` : ''} · room ${room} · ${when}`;
    case 'variant_merged':
      return `${actor} merged ${e.subject_name || 'a variant'}${e.detail ? ` (${e.detail})` : ''} · room ${room} · ${when}`;
    case 'review_editing':
      return `${actor} edited the review · room ${room} · ${when}`;
    default:
      return `${actor} ${e.action} · room ${room} · ${when}`;
  }
}

function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' today';
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const ActivitySection: React.FC = () => {
  const [result, setResult] = React.useState<AuditListResult | null>(null);

  useEffect(() => {
    void listAuditEvents().then(setResult);
  }, []);

  return (
    <section>
      <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest mb-4">
        Activity
      </h2>
      <p className="text-gray-500 text-[11px] leading-relaxed mb-3">
        Who admitted people, edited reviews, and deleted, dropped or merged
        anything. Not a tamper-proof ledger: on installs without accounts, names
        are self-asserted.
      </p>
      {!result ? (
        <p className="text-gray-600 text-xs">Loading…</p>
      ) : result.status === 'not_configured' ? (
        <p className="text-gray-600 text-xs">
          The room server has no database configured — audit logging is
          disabled.
        </p>
      ) : result.events.length === 0 ? (
        <p className="text-gray-600 text-xs">Nothing has happened yet.</p>
      ) : (
        <div className="space-y-1">
          {result.events.map((e) => (
            <p key={e.id} className="text-gray-400 text-xs">
              {formatAuditEvent(e)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
};

export default AdminPage;
