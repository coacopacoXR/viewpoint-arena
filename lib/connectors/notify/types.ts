// NotificationSinkAdapter interface — see docs/plan/02-connector-adapters.md §4.
//
// Every notification destination (Teams, Teamcenter, Jira, email, …) implements
// this interface. A shared contract test suite (notify.contract.test.ts)
// asserts the behavioural guarantees so any implementation — ours or a corp's —
// can be verified against the same checks.

import type { TrackerSession, TrackerItem } from '../../supabase.ts';
import type { HealthCheckResult } from '../../health/types.ts';

export interface NotificationSinkAdapter {
  /** Stable identifier for this sink — e.g. 'teams', 'teamcenter', 'jira'. */
  id: string;

  /**
   * Post a full session summary (session header + all tracker items).
   *
   * Must never accept or return a raw credential (webhook URL, API key, etc.).
   */
  postSession(
    session: TrackerSession,
    items: TrackerItem[],
  ): Promise<{ ok: boolean; error?: string }>;

  /** Post a single tracker item. */
  postItem(item: TrackerItem): Promise<{ ok: boolean; error?: string }>;

  /**
   * Is this sink usable right now? Called by GET /api/health, which reports
   * one entry per ENABLED sink keyed by `id`.
   *
   * Optional; every adapter in this repo implements it. Must never reject, and
   * must not post anything: a health check that sends a real notification to a
   * team's channel would make the endpoint unusable. Check configuration and
   * reachability only. `detail` must stay free of credentials, env var names
   * and hostnames — see the full rules on PLMAdapter.healthCheck in
   * lib/connectors/plm/types.ts. A webhook URL is a bearer credential, so it
   * must never appear here even partially.
   */
  healthCheck?(): Promise<HealthCheckResult>;
}
