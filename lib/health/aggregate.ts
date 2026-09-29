// /api/health's aggregation core — see docs/plan/05-observability-and-metrics.md §1.
//
// SERVER-ONLY. It constructs CloudflareTurnAdapter (which reads process.env)
// and sends credentials upstream, so it must never be imported by
// browser-reachable code. Client code reads lib/config/publicConfig.ts.
//
// Three guarantees this module exists to provide, in the order they matter:
//
//  1. NOTHING LEAKS. Every `detail` passes through safeDetail() on the way out,
//     and every `provider` through safeProvider(). An adapter that returns an
//     env var name, a URL or an upstream error body has it dropped — the status
//     survives, the wording does not. This is the boundary, not a convention.
//  2. ONE BAD CONNECTOR CANNOT FAIL THE ENDPOINT. Each check is isolated: a
//     throw becomes `degraded`, a hang becomes `degraded` after a deadline, and
//     the rest still report. The report always contains every enabled
//     connector.
//  3. DISABLED MEANS OMITTED. A connector the deployment did not enable — an
//     empty notifications list, or `plm: none` — is absent from the report, not
//     present and failing. An org that deliberately runs with no PLM has a
//     healthy deployment.

import type { ViewpointConfig } from '../config/schema.ts';
import type {
  ConnectorHealth,
  HealthCheckResult,
  HealthReport,
} from './types.ts';
import { HEALTH_DETAILS } from './details.ts';
import { safeDetail, safeProvider } from './sanitize.ts';
import {
  DEFAULT_AUTH_PROBE_URL,
  probeAuthService,
  probeBackups,
  probeCaptureService,
  probeDatabase,
  type ProbeOptions,
} from './probes.ts';

import { OnshapePLMAdapter } from '../connectors/plm/onshape.ts';
import { TeamcenterPLMAdapter } from '../connectors/plm/teamcenter.ts';
import { MockCaptureProvider } from '../connectors/capture/mock.ts';
import { OpenAICaptureProvider } from '../connectors/capture/openai.ts';
import { AnthropicCaptureProvider } from '../connectors/capture/anthropic.ts';
import { OllamaDirectCaptureProvider } from '../connectors/capture/ollamaDirect.ts';
import { CloudflareTurnAdapter } from '../connectors/turn/cloudflare.ts';
import { SelfHostedCoturnAdapter } from '../connectors/turn/selfHostedCoturn.ts';
import { TeamsNotifyAdapter } from '../connectors/notify/teams.ts';
import { OnshapeModelImportAdapter } from '../connectors/modelImport/onshape.ts';

if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error(
    'lib/health/aggregate.ts is server-only. Import lib/config/publicConfig.ts in client code instead.',
  );
}

type FetchFn = typeof globalThis.fetch;

/**
 * Per-check deadline.
 *
 * Short, because the endpoint is polled: install.sh loops on it until the
 * deployment is ready and an IT dashboard hits it on an interval. A connector
 * that hangs must cost this long and no longer, and must not be able to hold
 * the whole response open.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 8_000;

export interface HealthDeps {
  /** Injected in tests; defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
  /** Injected in tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Per-connector deadline in ms. */
  timeoutMs?: number;
}

/** A connector slot in the report, plus the sink id for notification entries. */
type Slot = keyof HealthReport['connectors'];

/**
 * One connector's pending check.
 *
 * Exported because it is the seam the tests use: `buildChecks` turns a config
 * into these, and `aggregateChecks` runs them through the timeout, the catch-all
 * and the sanitiser. Tests construct their own Checks — including ones that
 * throw, hang, and try to leak — so those paths are exercised against the real
 * aggregation code rather than a copy of it.
 */
export interface Check {
  slot: Slot;
  /** Set only for notifications, which report one entry per enabled sink. */
  sinkId?: string;
  provider: string;
  run: (options: ProbeOptions) => Promise<HealthCheckResult | undefined>;
}

/**
 * Aggregate a health report for whichever connectors this config enables.
 *
 * Never throws and never rejects: a config that parses but cannot be checked
 * yields a full report of `degraded` entries, which is more useful to an
 * operator than a 500 with no body.
 */
export async function aggregateHealth(
  config: ViewpointConfig,
  deps: HealthDeps = {},
): Promise<HealthReport> {
  const connectors = await aggregateChecks(buildChecks(config, deps), deps);
  return { ok: allOk(connectors), connectors };
}

/**
 * Run a list of checks concurrently and shape the result.
 *
 * Split out from aggregateHealth so the deadline, the catch-all and the
 * sanitiser can be tested with hand-built checks. Concurrency matters: the
 * checks are independent, and running them in sequence would let one 8s timeout
 * delay every connector behind it.
 */
export async function aggregateChecks(
  checks: Check[],
  deps: HealthDeps = {},
): Promise<HealthReport['connectors']> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const probeOptions: ProbeOptions = { fetchFn: deps.fetchFn };

  const settled = await Promise.all(
    checks.map(async (check) => ({
      check,
      result: await runCheck(check, probeOptions, timeoutMs),
    })),
  );

  const connectors: HealthReport['connectors'] = {};
  const notifications: Record<string, ConnectorHealth> = {};

  for (const { check, result } of settled) {
    const entry = toConnectorHealth(check.provider, result, deps.env);
    if (check.slot === 'notifications') {
      // A sink with no id cannot be keyed, and collapsing two sinks onto one
      // key would hide a failure behind whichever resolved last.
      if (check.sinkId) notifications[check.sinkId] = entry;
    } else {
      connectors[check.slot] = entry;
    }
  }

  if (Object.keys(notifications).length > 0) {
    connectors.notifications = notifications;
  }

  return connectors;
}

/**
 * True when every reported connector — including every notification sink — is
 * ok. An empty report is ok: a deployment with nothing enabled has nothing
 * failing, and reporting `ok: false` for it would make install.sh wait forever
 * on a stack that is as ready as it is ever going to be.
 */
function allOk(connectors: HealthReport['connectors']): boolean {
  for (const value of Object.values(connectors)) {
    if (!value) continue;
    if (isConnectorHealth(value)) {
      if (value.status !== 'ok') return false;
    } else {
      for (const sink of Object.values(value)) {
        if (sink.status !== 'ok') return false;
      }
    }
  }
  return true;
}

function isConnectorHealth(
  value: ConnectorHealth | Record<string, ConnectorHealth>,
): value is ConnectorHealth {
  return typeof (value as ConnectorHealth).status === 'string';
}

function toConnectorHealth(
  provider: unknown,
  result: HealthCheckResult,
  env: Record<string, string | undefined> | undefined,
): ConnectorHealth {
  const entry: ConnectorHealth = {
    provider: safeProvider(provider),
    status: result.ok ? 'ok' : 'degraded',
  };
  // The one and only exit. Nothing reaches the response without passing here.
  const detail = safeDetail(result.detail, env);
  if (detail !== undefined) entry.detail = detail;
  return entry;
}

/**
 * Run one check inside a deadline and a catch-all.
 *
 * The race is what bounds a hanging connector: adapters' healthCheck() takes no
 * AbortSignal (the interface stays simple for third-party implementations), so
 * the deadline has to be imposed from outside. Probes that DO accept a signal
 * get one, so the underlying fetch is actually cancelled rather than left
 * running behind a response that already went out.
 */
async function runCheck(
  check: Check,
  probeOptions: ProbeOptions,
  timeoutMs: number,
): Promise<HealthCheckResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<HealthCheckResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, detail: HEALTH_DETAILS.timedOut });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      check.run({ ...probeOptions, signal: controller.signal }),
      deadline,
    ]);
    // An adapter that resolves to something that is not a result is treated as
    // "no answer" rather than trusted: `undefined` and a malformed object are
    // both possible from a third-party adapter.
    if (!result || typeof result.ok !== 'boolean') {
      return { ok: false, detail: HEALTH_DETAILS.notReported };
    }
    return result;
  } catch {
    // healthCheck is documented as never rejecting, and ours never does. This
    // is here for everybody else's adapters, and because "a broken health check
    // broke the health endpoint" is the one failure mode this module must not
    // have. The reason belongs in the server log, not in the response.
    return { ok: false, detail: HEALTH_DETAILS.checkFailed };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ─── Which check runs for which configured provider ─────────────────────────

/**
 * Providers whose health is a constant, and why they are not constructed here.
 *
 * Each of these adapters has a healthCheck() that returns exactly this, and a
 * test in lib/health/__tests__/aggregate.test.ts asserts the two agree so the
 * shortcut cannot drift from the adapter. They are not instantiated because
 * doing so would drag their import graph into a serverless health endpoint:
 * GenericUploadModelImportAdapter imports utils/modelLoader.ts, which imports
 * THREE and four model loaders at module scope — hundreds of kilobytes of
 * browser 3D code loaded on every health poll, for an adapter whose answer is
 * "nothing external to reach".
 */
const SELF_CONTAINED: Record<string, HealthCheckResult> = {
  genericGltf: { ok: true, detail: HEALTH_DETAILS.selfContained },
};

export function buildChecks(config: ViewpointConfig, deps: HealthDeps): Check[] {
  const checks: Check[] = [];
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const fetchFn = deps.fetchFn;

  // ── PLM ──────────────────────────────────────────────────────────────
  // 'none' is omitted entirely: a deployment that answered
  // "none-manual-upload" to install.sh has no PLM connector, and an absent
  // entry is how the report says so.
  if (config.plm.provider === 'onshape') {
    const adapter = new OnshapePLMAdapter();
    checks.push({
      slot: 'plm',
      provider: 'onshape',
      run: () => callHealthCheck(adapter),
    });
  } else if (config.plm.provider === 'teamcenter') {
    const adapter = new TeamcenterPLMAdapter(fetchFn);
    checks.push({
      slot: 'plm',
      provider: 'teamcenter',
      run: () => callHealthCheck(adapter),
    });
  }

  // ── Capture ──────────────────────────────────────────────────────────
  const capture = config.capture;
  if (capture.provider === 'mock') {
    const adapter = new MockCaptureProvider();
    checks.push({
      slot: 'capture',
      provider: 'mock',
      run: () => callHealthCheck(adapter),
    });
  } else if (capture.provider === 'openai' || capture.provider === 'anthropic') {
    const adapter =
      capture.provider === 'openai'
        ? new OpenAICaptureProvider({ fetchFn })
        : new AnthropicCaptureProvider({ fetchFn });
    checks.push({
      slot: 'capture',
      provider: capture.provider,
      run: () => callHealthCheck(adapter),
    });
  } else if (capture.provider === 'ollamaDirect') {
    checks.push({
      slot: 'capture',
      provider: 'ollamaDirect',
      // Constructed inside the check: the constructor validates baseUrl and
      // model and THROWS on a bad one. A malformed config must degrade this
      // connector, not the endpoint.
      run: () =>
        callHealthCheck(
          new OllamaDirectCaptureProvider({
            baseUrl: capture.baseUrl,
            model: capture.model,
            fetchFn,
          }),
        ),
    });
  } else if (capture.provider === 'local') {
    checks.push({
      slot: 'capture',
      provider: 'local',
      run: (options) =>
        probeCaptureService(capture.serviceUrl, { ...options, env }),
    });
  }

  // ── TURN ─────────────────────────────────────────────────────────────
  if (config.turn.provider === 'cloudflare') {
    const adapter = new CloudflareTurnAdapter({
      tokenIdEnv: config.turn.tokenIdEnv,
      apiTokenEnv: config.turn.apiTokenEnv,
      env,
    });
    checks.push({
      slot: 'turn',
      provider: 'cloudflare',
      run: () => callHealthCheck(adapter),
    });
  } else if (config.turn.provider === 'selfHostedCoturn') {
    const adapter = new SelfHostedCoturnAdapter({
      host: config.turn.host,
      port: config.turn.port,
      sharedSecretEnv: config.turn.sharedSecretEnv,
      probeHost: config.turn.probeHost,
      env,
    });
    checks.push({
      slot: 'turn',
      provider: 'selfHostedCoturn',
      run: () => callHealthCheck(adapter),
    });
  }

  // ── Database ─────────────────────────────────────────────────────────
  checks.push({
    slot: 'db',
    provider: config.db.provider,
    run: (options) =>
      probeDatabase({
        urlEnv: config.db.urlEnv,
        anonKeyEnv: config.db.anonKeyEnv,
        probeUrl: config.db.probeUrl,
        env,
        fetchFn: options.fetchFn,
        signal: options.signal,
      }),
  });

  // ── Identity ───────────────────────────────────────────────────────────
  // docs/plan/13-identity.md. Three cases, and the distinction between the
  // first two matters:
  //   * no identity block at all — the config predates identity, or its author
  //     deliberately wrote nothing. OMITTED, like plm 'none' and an empty
  //     notifications list: an absent entry is how this report says "this
  //     deployment did not enable that connector".
  //   * mode 'none' — an explicit choice, answered as ok with "no external
  //     dependency" (the modelImport 'genericGltf' answer). Signing in is not
  //     part of this deployment; that is a healthy state, not a degraded one,
  //     and reporting it degraded would make install.sh's health poll fail on
  //     a stack that is exactly as ready as it was configured to be.
  //   * mode 'accounts'/'sso' — probe the service that answers sign-in.
  const identity = config.identity;
  if (identity) {
    if (identity.mode === 'none') {
      checks.push({
        slot: 'identity',
        provider: 'none',
        run: async () => ({ ok: true, detail: HEALTH_DETAILS.selfContained }),
      });
    } else {
      checks.push({
        slot: 'identity',
        provider: identity.mode,
        run: (options) =>
          probeAuthService(identity.probeUrl ?? DEFAULT_AUTH_PROBE_URL, {
            fetchFn: options.fetchFn,
            signal: options.signal,
          }),
      });
    }
  }

  // ── Model import ─────────────────────────────────────────────────────
  const modelImport = config.modelImport.provider;
  if (SELF_CONTAINED[modelImport]) {
    checks.push({
      slot: 'modelImport',
      provider: modelImport,
      run: async () => SELF_CONTAINED[modelImport],
    });
  } else if (modelImport === 'onshape') {
    const adapter = new OnshapeModelImportAdapter({ fetchFn });
    checks.push({
      slot: 'modelImport',
      provider: 'onshape',
      run: () => callHealthCheck(adapter),
    });
  }

  // ── Backups (batch BY) ──────────────────────────────────────────────
  // Only where the install says where its backups are: the compose file mounts the
  // `db-backups` volume read-only on the api and sets BACKUP_STATUS_DIR. A deployment
  // that backs up some other way reports nothing here rather than a false alarm.
  const backupDir = env.BACKUP_STATUS_DIR?.trim();
  if (backupDir) {
    const hours = Number(env.BACKUP_INTERVAL_HOURS);
    const interval = Number.isFinite(hours) && hours > 0 ? hours : 24;
    checks.push({
      slot: 'backup',
      provider: 'local',
      run: () => probeBackups(backupDir, interval * 2),
    });
  }

  // ── Notifications ────────────────────────────────────────────────────
  // One entry per enabled sink, keyed by the adapter's own id. An empty list
  // adds nothing, so "no sinks enabled" is omitted rather than reported.
  config.notifications.forEach((notification, index) => {
    if (notification.provider !== 'teams') return;
    const adapter = new TeamsNotifyAdapter(fetchFn);
    checks.push({
      slot: 'notifications',
      // Falls back to the provider name if an adapter ever reports no id, so
      // two sinks can never collapse onto one key and hide a failure.
      sinkId: adapter.id || `teams-${index}`,
      provider: notification.provider,
      run: () => callHealthCheck(adapter),
    });
  });

  return checks;
}

/**
 * Call an adapter's healthCheck if it has one.
 *
 * `healthCheck` is OPTIONAL on every adapter interface, so a corp's custom
 * adapter compiled before this existed simply will not have it. That is
 * reported as `degraded` with "health check unavailable" — not as ok, because
 * nothing was verified, and not as a hard failure, because the connector may
 * well be working.
 */
async function callHealthCheck(
  adapter: { healthCheck?: () => Promise<HealthCheckResult> },
): Promise<HealthCheckResult> {
  if (typeof adapter.healthCheck !== 'function') {
    return { ok: false, detail: HEALTH_DETAILS.notReported };
  }
  return adapter.healthCheck();
}
