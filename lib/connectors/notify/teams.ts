// TeamsNotifyAdapter — browser-safe client implementing NotificationSinkAdapter.
//
// All Teams webhook posts go through the server-side Vercel function at
// /api/notify/teams. The webhook URL lives in server-side process.env
// (TEAMS_WEBHOOK_URL) and NEVER reaches this module. No method accepts a
// credential as an argument.
//
// The card-building logic was relocated from the old lib/teamsIntegration.ts
// into api/notify/teams.ts (server-side). This module just sends the raw
// session/items data to the server endpoint.

import type { NotificationSinkAdapter } from './types.ts';
import type { TrackerSession, TrackerItem } from '../../supabase.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

type FetchFn = typeof globalThis.fetch;

export class TeamsNotifyAdapter implements NotificationSinkAdapter {
  id = 'teams';

  private _fetch: FetchFn;

  constructor(fetchFn?: FetchFn) {
    this._fetch = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async postSession(
    session: TrackerSession,
    items: TrackerItem[],
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this._fetch('/api/notify/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'session',
          session,
          items,
          origin: typeof window !== 'undefined' ? window.location.origin : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const serverError = (data as { error?: string }).error;
        return {
          ok: false,
          error: serverError ?? `Teams notification failed (${res.status})`,
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async postItem(item: TrackerItem): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this._fetch('/api/notify/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'item',
          item,
          origin: typeof window !== 'undefined' ? window.location.origin : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const serverError = (data as { error?: string }).error;
        return {
          ok: false,
          error: serverError ?? `Teams notification failed (${res.status})`,
        };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Check whether the Teams integration is configured on the server. */
  async isConfigured(): Promise<boolean> {
    try {
      const res = await this._fetch('/api/notify/teams', { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Is the Teams sink usable? Configuration check only — it never posts.
   *
   * A health check that sent a real card would put a test message in a team's
   * channel on every poll, which is the fastest way to get the integration
   * switched off. api/notify/teams.ts answers HEAD with 200 when the webhook
   * URL is set server-side and 503 when it is not, so configuration is knowable
   * without sending anything.
   *
   * The webhook URL is a bearer credential and never appears here: only the
   * status code is read, and the detail is a fixed phrase. The URL itself stays
   * in server-side process.env, which is the whole reason this adapter posts
   * through api/notify/teams.ts instead of calling Teams directly.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    let status: number;
    try {
      const response = await this._fetch('/api/notify/teams', {
        method: 'HEAD',
      });
      status = response.status;
    } catch {
      return { ok: false, detail: HEALTH_DETAILS.unreachable };
    }
    if (status === 200) return { ok: true, detail: HEALTH_DETAILS.configured };
    if (status === 404) return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
    if (status === 503) return { ok: false, detail: HEALTH_DETAILS.notConfigured };
    if (status >= 500) return { ok: false, detail: HEALTH_DETAILS.upstreamError };
    return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
  }
}
