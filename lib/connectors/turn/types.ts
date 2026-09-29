// TurnAdapter interface — see docs/plan/02-connector-adapters.md §3.
//
// Every TURN provider (Cloudflare, self-hosted coturn, …) implements this
// interface. A shared contract test suite (turn.contract.test.ts) asserts
// the behavioural guarantees.

import type { HealthCheckResult } from '../../health/types.ts';

export interface TurnAdapter {
  /**
   * Return ICE servers configured for RTCPeerConnection.
   *
   * Implementations mint short-lived credentials server-side. The returned
   * array is safe to pass directly to RTCPeerConnection's iceServers config.
   */
  getIceServers(): Promise<RTCIceServer[]>;

  /**
   * Is this connector usable right now? Called by GET /api/health.
   *
   * Optional; every adapter in this repo implements it. Must never reject, and
   * `detail` must stay free of credentials, env var names and hostnames — see
   * the full rules on PLMAdapter.healthCheck in lib/connectors/plm/types.ts.
   *
   * A TURN health check must NOT mint credentials: getIceServers() spends
   * quota (Cloudflare's TURN API is metered) and produces a value that would
   * be a credential if it ever reached the response. Check configuration and
   * reachability only.
   */
  healthCheck?(): Promise<HealthCheckResult>;
}
