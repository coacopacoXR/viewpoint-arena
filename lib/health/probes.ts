// Server-side health probes for the three connectors that have no adapter.
//
// All three are deliberate, and none is a gap to be "fixed" by inventing an
// adapter:
//
//  * `capture.provider: 'local'` — the browser-side LocalCaptureProvider is
//    T4.4 and does not exist yet. What /api/health needs is not a provider, it
//    is an answer to "is capture-service up", which only a SERVER-side probe
//    can give: capture-service sits on an internal compose network with no
//    published port (see docker-compose.yml), so a browser cannot reach it and
//    must not be able to. This probe runs in the api/health function, which can.
//
//  * `db` — docs/plan/02-connector-adapters.md §6 says data persistence is
//    "not a new adapter, just a config swap", because lib/supabase.ts already
//    works against hosted or self-hosted Postgres unchanged. Building an
//    adapter for something that is already portable is the abstraction the plan
//    explicitly declines, so the health check lives here instead.
//
//  * `identity` — docs/plan/13-identity.md makes sign-in a deployment choice
//    over an off-the-shelf service (Supabase Auth), not a connector with
//    interchangeable third-party implementations. There is nothing to adapt:
//    the only question /api/health can usefully answer is whether that one
//    service answers, and it does so on an internal compose network the
//    browser cannot reach, so again the probe has to be server-side.
//
// All three are SERVER-ONLY. They read credentials out of the environment and
// send them upstream, which is exactly what a browser-reachable module must
// never do.

import type { HealthCheckResult } from './types.ts';
import { HEALTH_DETAILS } from './details.ts';

type FetchFn = typeof globalThis.fetch;

/**
 * The header capture-service requires once CAPTURE_SHARED_SECRET is set.
 *
 * Must match AUTH_HEADER in capture-service/capture_service/auth.py. There is
 * no shared module format between the two runtimes, so
 * capture-service/tests/test_typescript_parity.py is where the pair is pinned.
 */
export const CAPTURE_AUTH_HEADER = 'X-Capture-Token';

/**
 * The env var holding the capture-service shared secret.
 *
 * A fixed name rather than a config field: capture-service owns it (it is that
 * service's own CAPTURE_ variable, read from the same generated .env), and
 * capture.serviceUrl in the schema has no *Env sibling to hang it on. Both
 * sides of the connection read the one name install.sh generated.
 */
export const CAPTURE_SHARED_SECRET_ENV = 'CAPTURE_SHARED_SECRET';

export interface ProbeOptions {
  fetchFn?: FetchFn;
  signal?: AbortSignal;
}

function fetchFnOf(options: ProbeOptions): FetchFn {
  return options.fetchFn ?? globalThis.fetch.bind(globalThis);
}

/**
 * Is capture-service up, and does it accept our shared secret?
 *
 * GET /health on capture-service performs no I/O and never loads a model, so
 * this is safe to poll. The shared secret is sent when one is configured —
 * capture-service requires it on every route once CAPTURE_SHARED_SECRET is set,
 * /health included, because that body names the Ollama host and model.
 *
 * A 401 is reported as `credentials rejected` and nothing else: the service's
 * reply body is not read, so no upstream text and no part of the secret can be
 * echoed. The URL is never included either — in a self-hosted deployment it is
 * an internal container name, and /api/health is unauthenticated.
 */
export async function probeCaptureService(
  serviceUrl: string,
  options: ProbeOptions & {
    env?: Record<string, string | undefined>;
  } = {},
): Promise<HealthCheckResult> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const secret = env[CAPTURE_SHARED_SECRET_ENV];

  let url: URL;
  try {
    url = new URL(serviceUrl);
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.configInvalid };
  }
  // Capture-service mounts its routes at the root. A configured serviceUrl with
  // a path would 404 for a reason that has nothing to do with health.
  url.pathname = '/health';
  url.search = '';

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (secret) headers[CAPTURE_AUTH_HEADER] = secret;

  let response: Response;
  try {
    response = await fetchFnOf(options)(url.toString(), {
      headers,
      signal: options.signal,
    });
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.unreachable };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: HEALTH_DETAILS.rejected };
  }
  if (response.status === 404) {
    return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
  }
  if (!response.ok) {
    return { ok: false, detail: HEALTH_DETAILS.upstreamError };
  }

  // Reading `status` distinguishes "the service answered" from "something else
  // on that port answered 200" — an SPA fallback returns HTML with no status
  // field, and under `vite preview` every /api/* route does exactly that.
  const body = (await response.json().catch(() => null)) as {
    status?: unknown;
  } | null;
  if (body?.status !== 'ok') {
    return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
  }
  return { ok: true, detail: HEALTH_DETAILS.reachable };
}

export interface DatabaseProbeOptions extends ProbeOptions {
  /** Env var NAME holding the project URL, from db.urlEnv. */
  urlEnv: string;
  /** Env var NAME holding the anon key, from db.anonKeyEnv. */
  anonKeyEnv: string;
  /**
   * From db.probeUrl: the PostgREST root as this server reaches it, probed as
   * given instead of `<project URL>/rest/v1/`.
   */
  probeUrl?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Is the database reachable, and does the anon key work?
 *
 * One request: GET the PostgREST root with the anon key. A 2xx proves both that
 * the host answered and that the key was accepted; a 401/403 separates "the
 * database is up and the key is wrong" from "the database is down", which are
 * different fixes and the two an installer most often needs told apart.
 *
 * The anon key is client-safe by design (docs/plan/01-architecture-and-master-config.md
 * §3 — access control is Postgres Row Level Security, not key secrecy), so
 * sending it is not the risk here. Echoing it would still be wrong, and neither
 * it nor its env var name nor the project URL appears in any detail: the values
 * are read, used, and dropped.
 */
export async function probeDatabase(
  options: DatabaseProbeOptions,
): Promise<HealthCheckResult> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const url = env[options.urlEnv];
  const anonKey = env[options.anonKeyEnv];

  if (!url || !anonKey) {
    return { ok: false, detail: HEALTH_DETAILS.notConfigured };
  }

  let endpoint: URL;
  try {
    if (options.probeUrl) {
      endpoint = new URL(options.probeUrl);
    } else {
      endpoint = new URL(url);
      endpoint.pathname = '/rest/v1/';
      endpoint.search = '';
    }
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.configInvalid };
  }

  let response: Response;
  try {
    response = await fetchFnOf(options)(endpoint.toString(), {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: options.signal,
    });
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.unreachable };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: HEALTH_DETAILS.rejected };
  }
  if (response.status === 404) {
    return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
  }
  if (!response.ok) {
    return { ok: false, detail: HEALTH_DETAILS.upstreamError };
  }
  return { ok: true, detail: HEALTH_DETAILS.reachable };
}

/**
 * Where the bundled identity service (Supabase Auth / GoTrue) answers, as the
 * api container reaches it: docker-compose.yml's `auth` service on the
 * backend network, reachable by its compose service name.
 *
 * Used when the config sets no identity.probeUrl. It is NOT derived from
 * config.publicUrl, for the same reason db.probeUrl exists: the public URL
 * (https://arena.acme.com) points back at nginx-proxy from inside a container,
 * where it either does not resolve at all or resolves to the wrong thing.
 */
export const DEFAULT_AUTH_PROBE_URL = 'http://auth:9999/health';

/**
 * Is the identity service up?
 *
 * GET /health on GoTrue performs no I/O and needs no token, so this is safe to
 * poll from an unauthenticated endpoint. Unlike capture-service's /health,
 * GoTrue's body carries no `status` field (it answers with name/version/
 * description), so the HTTP status alone is the answer: a 200 from anything
 * else on that port would have to be an HTTP server that is not GoTrue, and
 * nginx-proxy answers 502 rather than 200 when the service is down.
 *
 * No credential is sent and none is echoed. The URL never appears in a detail:
 * for a self-hosted deployment it is an internal container name, and
 * /api/health is unauthenticated.
 */
export async function probeAuthService(
  probeUrl: string,
  options: ProbeOptions = {},
): Promise<HealthCheckResult> {
  let endpoint: URL;
  try {
    endpoint = new URL(probeUrl);
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.configInvalid };
  }

  let response: Response;
  try {
    response = await fetchFnOf(options)(endpoint.toString(), {
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.unreachable };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, detail: HEALTH_DETAILS.rejected };
  }
  if (response.status === 404) {
    return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
  }
  if (!response.ok) {
    return { ok: false, detail: HEALTH_DETAILS.upstreamError };
  }
  return { ok: true, detail: HEALTH_DETAILS.reachable };
}

// ─── Backups ─────────────────────────────────────────────────────────────────

/** What probeBackups needs from the file system, injectable for tests. */
export interface BackupFs {
  readdir(dir: string): Promise<string[]>;
  mtimeMs(path: string): Promise<number>;
}

const nodeBackupFs: BackupFs = {
  async readdir(dir) {
    const fs = await import('node:fs/promises');
    return fs.readdir(dir);
  },
  async mtimeMs(path) {
    const fs = await import('node:fs/promises');
    return (await fs.stat(path)).mtimeMs;
  },
};

/** The file names deploy/backup/backup.sh writes, and only those. */
export const BACKUP_FILE_PATTERN = /^db-\d{8}-\d{6}\.sql\.gz$/;

/**
 * Whether the install is backing itself up (batch BY).
 *
 * Reads the backup folder the `db-backup` service writes (mounted read-only on the
 * api) and looks at the newest `db-*.sql.gz`: ok when it is younger than
 * `maxAgeHours` (twice the interval, so one late run is not an alarm), degraded
 * when it is older or when there is none. Never reports a path or a file name —
 * the details are the fixed sentences in HEALTH_DETAILS.
 */
export async function probeBackups(
  dir: string,
  maxAgeHours: number,
  options: { fs?: BackupFs; now?: () => number } = {},
): Promise<HealthCheckResult> {
  const fs = options.fs ?? nodeBackupFs;
  const now = (options.now ?? Date.now)();
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => BACKUP_FILE_PATTERN.test(name));
  } catch {
    return { ok: false, detail: HEALTH_DETAILS.backupMissing };
  }
  if (names.length === 0) return { ok: false, detail: HEALTH_DETAILS.backupMissing };
  let newest = 0;
  for (const name of names) {
    try {
      newest = Math.max(newest, await fs.mtimeMs(`${dir.replace(/\/+$/, '')}/${name}`));
    } catch {
      // A file removed between the listing and the stat is simply not the newest.
    }
  }
  if (newest === 0) return { ok: false, detail: HEALTH_DETAILS.backupMissing };
  const ageHours = (now - newest) / 3_600_000;
  return ageHours <= maxAgeHours
    ? { ok: true, detail: HEALTH_DETAILS.backupRecent }
    : { ok: false, detail: HEALTH_DETAILS.backupStale };
}
