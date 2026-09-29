// Shared vocabulary for connector health — see docs/plan/05-observability-and-metrics.md §1.
//
// This module is types only. Every adapter interface imports HealthCheckResult
// from here, and none of them may pull a runtime dependency into a browser
// bundle through it.

/**
 * What an adapter's `healthCheck()` resolves to.
 *
 * `detail` is OPTIONAL and CONSTRAINED. It is published on an unauthenticated
 * endpoint, so lib/health/sanitize.ts drops any detail that is not a short
 * lowercase phrase: an adapter that puts an env var name, a URL, a hostname or
 * an upstream error body in `detail` does not leak it — the detail simply does
 * not appear. Take the wording from lib/health/details.ts's HEALTH_DETAILS and
 * it survives; write anything else and it is discarded.
 *
 * `healthCheck()` must never reject and must never throw. Report failure as
 * `{ ok: false }`. The aggregator guards anyway, because a third-party adapter
 * will not have read this comment.
 */
export interface HealthCheckResult {
  ok: boolean;
  detail?: string;
}

/**
 * Per-connector status on the wire.
 *
 * Only two values, deliberately. A connector is either working or it is not,
 * and "not" is always `degraded` — never `error`/`critical`, because one
 * unreachable notification sink must not read like a dead deployment. The
 * endpoint itself stays up and returns the whole report either way.
 */
export type ConnectorStatus = 'ok' | 'degraded';

/** One connector's entry in the report. `provider` is the config's own value. */
export interface ConnectorHealth {
  provider: string;
  status: ConnectorStatus;
  /** Present only when the adapter supplied a detail that passed sanitisation. */
  detail?: string;
}

/**
 * The whole report.
 *
 * Every field is optional because a connector the deployment did not enable is
 * OMITTED, not reported as failing (docs/plan/05-observability-and-metrics.md
 * §1). `notifications` is keyed by sink id, since a deployment may enable
 * several, and is absent when none are enabled.
 */
export interface HealthReport {
  /** True only when every reported connector is `ok`. */
  ok: boolean;
  connectors: {
    plm?: ConnectorHealth;
    capture?: ConnectorHealth;
    turn?: ConnectorHealth;
    db?: ConnectorHealth;
    /**
     * Sign-in for this deployment. Absent when the config has no identity
     * block at all; present and `ok` with "no external dependency" when the
     * deployment deliberately runs with mode 'none', because that is a
     * complete answer about a real dependency (there is none), not a gap.
     */
    identity?: ConnectorHealth;
    modelImport?: ConnectorHealth;
    /** The install's own database backups (deploy/backup), when the api can see them. */
    backup?: ConnectorHealth;
    notifications?: Record<string, ConnectorHealth>;
  };
  /**
   * A fixed code, present only when the report could not be built at all (the
   * master config would not load). Never an error message: loadConfig's
   * messages name env vars, which is exactly what this endpoint must not
   * publish. The reason goes to the server log.
   */
  error?: 'config_not_available';
}
