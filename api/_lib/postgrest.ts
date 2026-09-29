// Service-role PostgREST helper for admin endpoints.
//
// The admin console's Reviews and Models sections need to query tables the
// browser's anon key cannot reach (review_members, model_revisions) and to
// write through RLS guards that only a service-role token bypasses. This
// module resolves the PostgREST root the server talks to and mints the
// Authorization header, so the endpoints do not each repeat the plumbing.
//
// SERVER ONLY: imports getServiceRoleToken, whose own guard throws outside
// Node.

import { loadConfig } from '../../lib/config/loadConfig.ts';
import { getServiceRoleToken } from './serviceRole.ts';

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

/**
 * The PostgREST root this server reaches. Null when there is no database or
 * no URL to talk to — the caller treats that as "the store is unavailable".
 *
 * The same resolution lib/ai/settingsStore.ts uses, inlined here so the admin
 * endpoints do not import from the AI module.
 */
export async function resolvePostgrestUrl(): Promise<string | null> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return null;
  }
  if (config.db.provider !== 'supabase') return null;

  const explicit = config.db.serverUrl ?? config.db.probeUrl;
  if (explicit) return withTrailingSlash(explicit);

  const publicUrl = process.env[config.db.urlEnv];
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    url.pathname = '/rest/v1/';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function withTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * A fetch against PostgREST with the service-role token attached. Null when
 * the store is unreachable (no database, no JWT_SECRET): the caller answers
 * 503 rather than 500, which is what an operator can act on.
 */
export async function postgrestFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const base = await resolvePostgrestUrl();
  if (!base) return null;

  const token = getServiceRoleToken();
  if (!token) return null;

  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        apikey: token,
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    // Unreachable — the URL is internal to the deploy. Logged without detail.
    console.error('[postgrest] could not reach the database');
    return null;
  }
}
