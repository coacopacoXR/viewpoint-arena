// The one thing the sign-in page has to ask GoTrue before it can render: may
// this deployment create accounts?
//
// The browser asks /auth/v1/settings directly because supabase-js has no method
// for it, and the answer decides whether the "Create an account" switch is
// offered at all. The endpoint is public — it wants the anon key as an `apikey`
// header, the same key the client already sends with every request, and returns
// no secrets (external providers, mail settings, disable_signup).
//
// On the self-hosted stack VITE_SUPABASE_URL is the site origin and nginx
// rewrites /auth/v1/settings to GoTrue's own /settings; on Supabase cloud it is
// the project's origin and the same path is served there. With no URL
// configured the path stays relative, which is the self-hosted shape.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function authSettingsUrl(): string {
  const base = SUPABASE_URL ? SUPABASE_URL.replace(/\/+$/, '') : '';
  return `${base}/auth/v1/settings`;
}

export interface GoTrueSettings {
  /** True when GoTrue refuses new sign-ups. */
  disableSignup: boolean;
}

/**
 * The settings, or null when they could not be read — an unreachable service, a
 * non-OK status, or an SPA fallback answering 200 with HTML (the same trap
 * /api/public-config has; the content-type is checked before parsing).
 *
 * Callers treat null as "sign-up is not offered": guessing the other way would
 * hand out a button that 403s on every locked-down deployment.
 */
export async function fetchGoTrueSettings(): Promise<GoTrueSettings | null> {
  try {
    const response = await fetch(authSettingsUrl(), {
      headers: ANON_KEY ? { apikey: ANON_KEY } : undefined,
    });
    if (!response.ok) return null;
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
    const body = (await response.json()) as { disable_signup?: unknown };
    return { disableSignup: body.disable_signup !== false };
  } catch {
    return null;
  }
}
