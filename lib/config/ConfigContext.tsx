// ConfigContext — the client-side entry point to viewpoint.config.ts.
//
// Fetches the redacted public config once at startup (lib/config/publicConfig.ts
// caches the promise, so N consumers cost 1 request) and exposes the ACTIVE
// PROVIDER per connector category. Components read it to decide WHICH connector
// to offer instead of hardcoding an adapter import.
//
// FAIL-SAFE — the requirement this file exists to satisfy:
// If /api/public-config is unreachable (local dev with no viewpoint.config.ts, a
// misconfigured deploy, an SPA-fallback 200 that returns HTML, or a body that
// does not match PublicConfig) the context resolves to FALLBACK_PROVIDERS, which
// are exactly the providers the app hardcoded before this file existed. So
// "config unavailable" means "behave as before", never "no providers
// configured". Nothing here throws, the error is reported as state, and
// useConnectorConfig() is safe to call even with no ConfigProvider mounted.

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { fetchPublicConfig } from './publicConfig.ts';
import type { PublicConfig } from './publicConfig.ts';

export interface ConnectorConfig {
  /** The redacted config, or null whenever it is unavailable. */
  config: PublicConfig | null;
  /** True until the first fetch settling. */
  loading: boolean;
  /** Why the config is unavailable, or null when it loaded. Never thrown. */
  error: string | null;
  /** True only when `config` actually came from the endpoint. */
  available: boolean;
  /** The absolute origin browsers use to reach this deployment, or absent. */
  publicUrl: string | undefined;
  plm: string;
  capture: string;
  turn: string;
  db: string;
  modelImport: string;
  /** Notification providers are a list — a deployment may enable several. */
  notifications: string[];
}

// Mirrors the hardcoded choices this context replaced. Changing an entry here
// changes what the app renders when the config endpoint is missing, so each one
// must stay equal to the pre-config behaviour of the component that reads it:
//   plm           'teamcenter'  IntegrationsPanel constructed TeamcenterPLMAdapter
//   notifications ['teams']     IntegrationsPanel constructed TeamsNotifyAdapter
//   modelImport   'onshape'     ReviewSetupPage always offered the Onshape import
//   capture       'mock'        DialogueEngine constructs MockCaptureProvider
//   turn          'cloudflare'  api/turn-credentials.ts default provider
//   db            'supabase'    lib/supabase.ts is the only database client
export const FALLBACK_PROVIDERS = {
  plm: 'teamcenter',
  capture: 'mock',
  turn: 'cloudflare',
  db: 'supabase',
  modelImport: 'onshape',
  notifications: ['teams'],
} as const;

// The endpoint is unauthenticated and its body is only ever produced by
// redactConfig(), but a proxy, an SPA fallback or a half-finished deploy can
// still hand back something else. Anything that does not match the shape is
// treated as "unavailable" so a malformed body can never blank the UI.
function isPublicConfig(value: unknown): value is PublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const hasProvider = (x: unknown): boolean =>
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { provider?: unknown }).provider === 'string';
  if (!hasProvider(v.plm)) return false;
  if (!hasProvider(v.capture)) return false;
  if (!hasProvider(v.turn)) return false;
  if (!hasProvider(v.db)) return false;
  if (!hasProvider(v.modelImport)) return false;
  return Array.isArray(v.notifications) && v.notifications.every(hasProvider);
}

interface LoadState {
  config: PublicConfig | null;
  loading: boolean;
  error: string | null;
}

function resolve(state: LoadState): ConnectorConfig {
  const c = state.config;
  return {
    config: c,
    loading: state.loading,
    error: state.error,
    available: c !== null,
    publicUrl: c?.publicUrl,
    plm: c?.plm.provider ?? FALLBACK_PROVIDERS.plm,
    capture: c?.capture.provider ?? FALLBACK_PROVIDERS.capture,
    turn: c?.turn.provider ?? FALLBACK_PROVIDERS.turn,
    db: c?.db.provider ?? FALLBACK_PROVIDERS.db,
    modelImport: c?.modelImport.provider ?? FALLBACK_PROVIDERS.modelImport,
    notifications: c
      ? c.notifications.map((n) => n.provider)
      : [...FALLBACK_PROVIDERS.notifications],
  };
}

// Used when a component renders with no ConfigProvider above it (tests, Storybook
// style harnesses, or a mount order mistake). Falls back rather than throwing.
const UNPROVIDED: ConnectorConfig = resolve({
  config: null,
  loading: false,
  error: null,
});

const ConfigContext = createContext<ConnectorConfig>(UNPROVIDED);

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<LoadState>({
    config: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let active = true;
    // Two-arg .then so a rejected fetch is always handled here: an unhandled
    // rejection would surface as a console error on every misconfigured deploy.
    fetchPublicConfig().then(
      (config) => {
        if (!active) return;
        if (isPublicConfig(config)) {
          setState({ config, loading: false, error: null });
        } else {
          setState({
            config: null,
            loading: false,
            error: 'Public config response did not match the expected shape',
          });
        }
      },
      (err: unknown) => {
        if (!active) return;
        setState({
          config: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo(() => resolve(state), [state]);

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
};

export function useConnectorConfig(): ConnectorConfig {
  return useContext(ConfigContext);
}
