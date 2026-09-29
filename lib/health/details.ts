// The fixed `detail` vocabulary for connector health checks.
//
// Not enforced at runtime — lib/health/sanitize.ts is the enforcement point,
// and it accepts anything matching its shape rule — but every adapter in this
// repo takes its wording from here, so one situation is described one way
// across all of them and an operator can grep a dashboard for a single phrase.
//
// Every value MUST survive sanitize.ts's shape rule: lowercase words of
// letters and digits, joined by single spaces or hyphens, no '.', ':' or '/'.
// lib/health/__tests__/details.test.ts asserts that, so a phrase added here
// that would be silently dropped from the response fails the build instead of
// quietly never appearing.

export const HEALTH_DETAILS = {
  /** Nothing external to reach — the mock and local-upload connectors. */
  selfContained: 'no external dependency',
  /** The upstream answered. */
  reachable: 'upstream reachable',
  /** The upstream refused, timed out on the network, or did not resolve. */
  unreachable: 'upstream unreachable',
  /** The upstream answered with a client/server error. */
  upstreamError: 'upstream returned an error',
  /** The check exceeded its own deadline. */
  timedOut: 'health check timed out',
  /** The env vars this connector needs are empty or absent. */
  notConfigured: 'credentials not configured',
  /** The env vars this connector needs are present. */
  configured: 'credentials configured',
  /** The upstream rejected the credentials. */
  rejected: 'credentials rejected',
  /** A configured value is not usable — an unparseable URL, for instance. */
  configInvalid: 'configuration invalid',
  /** The adapter is a stub; see its own doc comment for what replaces it. */
  notImplemented: 'not implemented',
  /** The adapter has no healthCheck, so nothing can be claimed either way. */
  notReported: 'health check unavailable',
  /** Our own serverless proxy for a cloud capture provider answered. */
  proxyReachable: 'extraction proxy reachable',
  /** Our own serverless proxy did not answer, or has no key. */
  proxyUnavailable: 'extraction proxy unavailable',
  /** The configured model is present on the model host. */
  modelAvailable: 'model available',
  /** The model host answered but the configured model is not pulled. */
  modelMissing: 'model missing',
  /** The app route this adapter depends on answered. */
  routeReachable: 'route reachable',
  /** The app route this adapter depends on did not answer. */
  routeUnavailable: 'route unavailable',
  /** healthCheck threw. The reason is in the server log, never here. */
  checkFailed: 'health check failed',
  /** The newest database backup is within twice the backup interval. */
  backupRecent: 'recent backup found',
  /** The newest database backup is older than twice the backup interval. */
  backupStale: 'last backup is older than expected',
  /** No database backup exists yet, or the backup folder cannot be read. */
  backupMissing: 'no backup found',
} as const;

export type HealthDetail = (typeof HEALTH_DETAILS)[keyof typeof HEALTH_DETAILS];
