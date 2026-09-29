// The PLM launch deep link (T5.3) — "open a design review straight from Onshape
// or Teamcenter".
//
//   https://<host>/launch?plmSource=onshape&plmDoc=<id>&plmWorkspace=<id>&plmElement=<id>
//
// No server-side routing change is needed for this page: vercel.json rewrites
// every non-/api path to index.html, and deploy/nginx/app.conf's `location /`
// does `try_files $uri $uri/ /index.html`. /launch is an SPA route like every
// other, so the PLM can point at it directly.
//
// The flow: validate the link (lib/connectors/plm/launchParams.ts), check that
// this deployment's configured PLM connector agrees with it, let THAT
// connector's adapter resolve the launch context, then create a brand-new review
// and hand the resolved document to the setup page through router state.
//
// Two things this page deliberately does not do:
//
//  1. IT NEVER READS A TOKEN FROM THE URL. The plan's sketch of this feature
//     mentions `token=<short-lived>`; accepting one would put a credential where
//     browser history, proxy and server logs, and the Referer header of every
//     later request can all see it. A launch authenticates with the PLM session
//     the browser already holds — for Onshape, the HttpOnly OAuth cookies. A
//     credential-shaped parameter is therefore ignored, and removed from the
//     address bar before anything else runs.
//  2. IT NEVER DERIVES THE REVIEW ID FROM THE DOCUMENT. The adapter's `roomHint`
//     is a human-readable label. The review id is crypto.randomUUID(), exactly
//     as in the lobby, because an unguessable id is what protects a room today
//     and a document id is visible to everyone who can see the document.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, Box, AlertTriangle } from 'lucide-react';
import { useConnectorConfig } from '../lib/config/ConfigContext';
import { useIdentity, AVATAR_COLORS } from '../lib/identity';
import {
  PLM_SOURCE_LABELS,
  isLaunchError,
  launchQuery,
  parseLaunchParams,
  stripCredentialParams,
  type LaunchSource,
} from '../lib/connectors/plm/launchParams';
import type { PLMAdapter, PLMDocumentRef } from '../lib/connectors/plm/types';
import { OnshapePLMAdapter } from '../lib/connectors/plm/onshape';
import { TeamcenterPLMAdapter } from '../lib/connectors/plm/teamcenter';
import { MockPLMAdapter } from '../lib/connectors/plm/mock';

// Adapters are constructed the way the rest of the app constructs them
// (components/UI/IntegrationsPanel.tsx, lib/health/aggregate.ts): no arguments,
// TeamcenterPLMAdapter defaulting to globalThis.fetch. No config field is read
// here beyond the provider name that selects the adapter.
function adapterForProvider(provider: string): PLMAdapter | null {
  if (provider === 'onshape') return new OnshapePLMAdapter();
  if (provider === 'teamcenter') return new TeamcenterPLMAdapter();
  if (provider === 'mock') return new MockPLMAdapter();
  // 'none' — a deployment that deliberately has no PLM — or a provider this
  // build has no adapter for.
  return null;
}

function providerLabel(provider: string): string {
  if (provider === 'none') return 'no PLM system';
  return PLM_SOURCE_LABELS[provider as LaunchSource] ?? provider;
}

const MSG = {
  configUnavailable:
    'The connector configuration for this deployment could not be loaded, so the launch link cannot be verified. Reload the page, or start from the lobby.',
  unresolved:
    'The PLM system could not resolve this launch link. The document may have been moved, deleted, or shared without read access.',
  noAdapter:
    'This deployment is not connected to a PLM this app can launch from, so it cannot open the link.',
} as const;

type Status =
  | { kind: 'working' }
  | { kind: 'needs-name' }
  | { kind: 'error'; message: string };

const LaunchPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { plm, loading: configLoading, available: configAvailable } = useConnectorConfig();
  const [identity, setIdentity] = useIdentity();

  // The query string this page acts on. Seeded from the router and then replaced
  // by the credential-stripped form, so every later decision reads the clean one.
  const [search, setSearch] = useState(location.search);
  const [status, setStatus] = useState<Status>({ kind: 'working' });
  const [name, setName] = useState('');
  const strippedRef = useRef(false);
  const navigatedRef = useRef(false);

  // Step 1 — get any credential out of the address bar BEFORE anything else
  // happens. replaceState rather than navigate(): this must not create a history
  // entry, must not re-run routing, and must leave the user looking at a URL that
  // is safe to copy, bookmark or paste into a ticket.
  useEffect(() => {
    if (strippedRef.current) return;
    strippedRef.current = true;
    const clean = stripCredentialParams(location.search);
    if (clean === location.search) return;
    window.history.replaceState(window.history.state, '', window.location.pathname + clean);
    setSearch(clean);
  }, [location.search]);

  const parsed = useMemo(() => parseLaunchParams(search), [search]);
  const hasName = Boolean(identity?.name?.trim());

  // Steps 2-5 — wait for config, check the connector agrees, resolve, navigate.
  useEffect(() => {
    if (navigatedRef.current) return;
    // While the config is still loading there is nothing to decide with: an
    // answer now would be the fallback provider, which is a guess.
    if (configLoading) return;

    if (isLaunchError(parsed)) {
      setStatus({ kind: 'error', message: parsed.error });
      return;
    }
    // Fail-safe: no config means no verification, and an unverified launch link
    // is not resolved. Falling back to a default provider here would let a link
    // for one PLM be answered by another.
    if (!configAvailable) {
      setStatus({ kind: 'error', message: MSG.configUnavailable });
      return;
    }
    const adapter = adapterForProvider(plm);
    if (!adapter) {
      // plm 'none' — a deployment that deliberately has no PLM — or a provider
      // this build has no adapter for.
      setStatus({ kind: 'error', message: MSG.noAdapter });
      return;
    }
    if (plm !== parsed.source) {
      setStatus({
        kind: 'error',
        message: `This deployment is connected to ${providerLabel(plm)}, so it cannot open a link from ${PLM_SOURCE_LABELS[parsed.source]}.`,
      });
      return;
    }
    // Identity is asked for here rather than by bouncing to the lobby: a redirect
    // to / would drop the launch parameters and the user would have to start
    // again from the PLM.
    if (!hasName) {
      setStatus({ kind: 'needs-name' });
      return;
    }

    let cancelled = false;
    void (async () => {
      let resolved: { roomHint: string; doc: PLMDocumentRef } | null;
      try {
        resolved = await adapter.resolveLaunchContext(
          launchQuery({ source: parsed.source, doc: parsed.doc }),
        );
      } catch {
        // A corp's adapter may reject. Treat it as "could not resolve" rather
        // than letting the exception escape into an error boundary.
        resolved = null;
      }
      if (cancelled || navigatedRef.current) return;
      if (!resolved) {
        setStatus({ kind: 'error', message: MSG.unresolved });
        return;
      }
      navigatedRef.current = true;
      // A NEW review with an unguessable id. resolved.roomHint is a label and is
      // deliberately not used here — see rule 2 in the file header.
      navigate(`/review/${crypto.randomUUID()}/setup`, {
        state: { plmLaunch: { source: parsed.source, doc: resolved.doc } },
        replace: true,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [configLoading, configAvailable, plm, parsed, hasName, navigate]);

  function saveName() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIdentity({
      name: trimmed,
      color: identity?.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      role: identity?.role,
    });
    setStatus({ kind: 'working' });
  }

  return (
    <div
      className="min-h-screen bg-[#0A0A0A] flex items-center justify-center px-6 py-12 font-sans"
      style={{ fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
            <span className="text-black font-black text-sm">VA</span>
          </div>
          <span className="font-mono text-white text-sm font-bold tracking-widest uppercase">
            Viewpoint Arena
          </span>
        </div>

        {status.kind === 'working' && (
          <div className="text-center py-10">
            <Loader2 size={22} className="mx-auto text-emerald-400 animate-spin" />
            <p className="text-gray-400 text-sm mt-4">Opening your design review…</p>
          </div>
        )}

        {status.kind === 'needs-name' && (
          <div className="space-y-4">
            <div>
              <p className="text-gray-600 text-xs font-mono uppercase tracking-widest mb-1">
                Launched from your PLM
              </p>
              <h1 className="text-white text-2xl font-bold">Who is opening this review?</h1>
              <p className="text-gray-600 text-sm mt-2">
                Your name is shown to the other reviewers in the session.
              </p>
            </div>
            <div>
              <label
                className="block text-[10px] font-mono font-bold text-gray-600 uppercase tracking-widest mb-2"
                htmlFor="launch-name"
              >
                Your name
              </label>
              <input
                id="launch-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveName()}
                placeholder="e.g. Alex Chen"
                maxLength={40}
                autoFocus
                className="w-full bg-white/5 border border-white/10 text-white rounded-xl px-4 py-3 text-sm outline-none focus:border-white/30 placeholder:text-gray-700 transition-colors"
              />
            </div>
            <button
              onClick={saveName}
              disabled={!name.trim()}
              className="w-full text-sm font-bold py-3 rounded-xl bg-white hover:bg-gray-100 text-gray-900 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Continue
            </button>
            <button
              onClick={() => navigate('/', { replace: true })}
              className="w-full text-xs font-mono text-gray-600 hover:text-gray-300 transition-colors"
            >
              Go to lobby
            </button>
          </div>
        )}

        {status.kind === 'error' && (
          <div className="space-y-5">
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle size={14} className="text-red-400" />
                <p className="text-[10px] font-mono font-bold text-red-300 uppercase tracking-widest">
                  Launch link not opened
                </p>
              </div>
              {/* Fixed copy from launchParams.ts / MSG. The raw query string is
                  never rendered: it is attacker-controlled text. */}
              <p className="text-gray-300 text-sm leading-relaxed">{status.message}</p>
            </div>
            <button
              onClick={() => navigate('/', { replace: true })}
              className="w-full flex items-center justify-center gap-2 text-sm font-bold py-3 rounded-xl bg-white hover:bg-gray-100 text-gray-900 transition-colors"
            >
              <Box size={14} /> Go to lobby
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default LaunchPage;
