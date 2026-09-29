// Server-side access to app_settings (plan 14, batch BF).
//
// The admin console's AI section writes through here and the AI router reads
// through here, and neither goes near the browser's Supabase client. That is not
// a stylistic choice: app_settings is the one table in
// docs/supabase-schema.sql with Row Level Security enabled and NO policies, plus
// an explicit revoke for anon and authenticated, so the key the bundle already
// carries cannot read it, write it, or count its rows. The only way in is a
// service-role JWT, which only this server can mint
// (api/_lib/serviceRole.ts signs one with JWT_SECRET).
//
// Two rules this module exists to keep:
//
//   1. SECRETS ARE WRITE-ONLY. `readSetting` returns `{ set, last4, unreadable }`
//      for the credential and never the credential, so there is no code path by
//      which /api/admin/ai can put a key in a response body. The router needs
//      the plaintext and gets it from `openSettingSecret`, a separate function
//      whose name says what it does and whose result must never be serialised.
//   2. A MISSING OR UNREACHABLE STORE IS NOT AN ERROR. `readSetting` resolves to
//      null when there is no row, no JWT_SECRET, no database or no network, and
//      the caller falls back to viewpoint.config.ts and then to the built-in
//      stack. An installation that has never opened the AI section must behave
//      exactly as it did before this table existed — including an installation
//      whose database is down, which should lose capture to a cloud key it never
//      configured, not to a settings read that threw.
//
// SERVER ONLY: this module holds a credential-reading function and imports the
// service-role minter, whose own guard throws outside Node.

import { loadConfig } from '../config/loadConfig.ts';
import { getServiceRoleToken } from '../../api/_lib/serviceRole.ts';
import { decryptSecret, secretTail, SecretBoxError, encryptSecret } from './secretBox.ts';

type FetchFn = typeof globalThis.fetch;

/** The table this module reads and writes. One row per setting. */
const TABLE = 'app_settings';

/**
 * PostgREST will not answer a request whose Accept it cannot satisfy, and its
 * 406 body is prose. Naming the type keeps the failure modes we do handle (404,
 * 401, an HTML page from something that is not PostgREST) the only ones left.
 */
const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

export interface SettingsStoreOptions {
  /** Test seam. Also lets a caller pin the config instead of loading it. */
  fetchFn?: FetchFn;
  /** Test seam: skip config resolution and talk to this PostgREST root. */
  serverUrl?: string;
  /** Test seam: skip the service-role minter. */
  token?: string | null;
  env?: Record<string, string | undefined>;
}

/**
 * The PostgREST root the SERVER reads and writes through.
 *
 * db.serverUrl, else db.probeUrl (both are the root as this container reaches
 * it, e.g. http://rest:3000/ in the bundled stack), else the public project URL
 * with PostgREST's /rest/v1/ prefix — which is the shape hosted Supabase uses.
 *
 * Returns null rather than throwing: no db block, no URL in the environment and
 * no configured root all mean "this deployment has no settings store", and every
 * caller treats that as "use the config default".
 */
export async function resolveSettingsServerUrl(
  options: SettingsStoreOptions = {},
): Promise<string | null> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  let config;
  try {
    config = await loadConfig();
  } catch {
    return null;
  }
  if (config.db.provider !== 'supabase') return null;

  const explicit = config.db.serverUrl ?? config.db.probeUrl;
  if (explicit) return withTrailingSlash(explicit);

  const publicUrl = env[config.db.urlEnv];
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

/** The row as PostgREST returns it. Column names, not camelCase. */
interface SettingsRow {
  key?: unknown;
  value?: unknown;
  secret?: unknown;
  updated_at?: unknown;
  updated_by?: unknown;
}

/** What a caller may safely be given about the credential. */
export interface SecretStatus {
  /** True when a ciphertext is stored, readable or not. */
  set: boolean;
  /** The last four characters, or '' when there is nothing safe to show. */
  last4: string;
  /**
   * True when a ciphertext is stored but could not be opened — which happens
   * when JWT_SECRET has been rotated since it was written. The screen says so
   * and asks for the key again instead of showing a tail it cannot compute.
   */
  unreadable: boolean;
}

export interface StoredSetting {
  key: string;
  /** The non-secret half, exactly as stored. Callers validate it themselves. */
  value: unknown;
  secret: SecretStatus;
  updatedAt: string;
  updatedBy: string;
}

async function storeFetch(
  options: SettingsStoreOptions,
  path: string,
  init: RequestInit,
): Promise<Response | null> {
  const serverUrl = options.serverUrl ?? (await resolveSettingsServerUrl(options));
  if (serverUrl === null) return null;

  const token =
    options.token !== undefined ? options.token : getServiceRoleToken();
  if (!token) {
    // No JWT_SECRET: the deployment cannot sign a service-role token, so it has
    // no privileged database access at all. Logged without the reason's detail
    // because there is nothing sensitive to say and nothing an operator can do
    // from a browser.
    console.error('[settingsStore] no service-role token; the settings store is unavailable');
    return null;
  }

  const doFetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  try {
    return await doFetch(`${serverUrl}${path}`, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        apikey: token,
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    // Unreachable. fetch's own message is dropped: it embeds the URL, which on a
    // self-hosted install is an internal container name.
    console.error('[settingsStore] could not reach the settings store');
    return null;
  }
}

async function readRow(
  key: string,
  options: SettingsStoreOptions,
): Promise<SettingsRow | null> {
  const response = await storeFetch(
    options,
    `${TABLE}?key=eq.${encodeURIComponent(key)}&select=key,value,secret,updated_at,updated_by`,
    { method: 'GET' },
  );
  if (response === null || !response.ok) return null;

  let rows: unknown;
  try {
    rows = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (typeof row !== 'object' || row === null) return null;
  return row as SettingsRow;
}

function ciphertextOf(row: SettingsRow): string | null {
  return typeof row.secret === 'string' && row.secret !== '' ? row.secret : null;
}

function statusOf(ciphertext: string | null): SecretStatus {
  if (ciphertext === null) return { set: false, last4: '', unreadable: false };
  try {
    return { set: true, last4: secretTail(decryptSecret(ciphertext)), unreadable: false };
  } catch (err) {
    // Only this module's own failure is expected. Anything else is still
    // reported as unreadable rather than propagated: a row we cannot open must
    // not stop the admin screen from rendering the other two jobs.
    if (!(err instanceof SecretBoxError)) {
      console.error('[settingsStore] unexpected failure opening a stored secret');
    }
    return { set: true, last4: '', unreadable: true };
  }
}

/**
 * Read one setting. Null means "there is nothing stored" — no row, no store, no
 * database — and every caller falls back from there.
 *
 * The credential is reported, never returned.
 */
export async function readSetting(
  key: string,
  options: SettingsStoreOptions = {},
): Promise<StoredSetting | null> {
  const row = await readRow(key, options);
  if (row === null) return null;
  return {
    key,
    value: row.value ?? {},
    secret: statusOf(ciphertextOf(row)),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : '',
  };
}

/**
 * The stored credential in the clear, for the router and the test-connection
 * endpoint only. Null when there is none, or when what is stored cannot be
 * opened with this deployment's JWT_SECRET.
 *
 * NEVER serialise the result. It exists so a server-side call can put the key in
 * an Authorization header; the moment it reaches a response body, a log line or
 * the browser it has defeated the encryption this module exists to provide.
 */
export async function openSettingSecret(
  key: string,
  options: SettingsStoreOptions = {},
): Promise<string | null> {
  const row = await readRow(key, options);
  const ciphertext = row === null ? null : ciphertextOf(row);
  if (ciphertext === null) return null;
  try {
    return decryptSecret(ciphertext);
  } catch {
    console.error('[settingsStore] a stored secret could not be opened; treating it as absent');
    return null;
  }
}

/**
 * Whether the store can be reached at all.
 *
 * Distinct from readSetting, which answers null both for "no such row" and for
 * "no database". The admin screen needs the difference: a job with nothing saved
 * and a working store says "using the default", while the same job with no store
 * says "this deployment cannot save AI settings", which is a thing an operator has
 * to be told rather than left to infer from a Save button that does nothing.
 *
 * Reads one column of at most one row. It is a reachability probe, not a query.
 */
export async function probeSettingsStore(
  options: SettingsStoreOptions = {},
): Promise<boolean> {
  const response = await storeFetch(options, `${TABLE}?select=key&limit=1`, {
    method: 'GET',
  });
  return response !== null && response.ok;
}

/**
 * Delete one setting, so a job goes back to being resolved from config and then
 * from the built-in stack.
 *
 * Returns true when the row is gone — including when it was never there, because
 * "reset this job" has the same meaning either way and an admin who presses it
 * twice should not be told the second press failed.
 */
export async function deleteSetting(
  key: string,
  options: SettingsStoreOptions = {},
): Promise<boolean> {
  const response = await storeFetch(options, `${TABLE}?key=eq.${encodeURIComponent(key)}`, {
    method: 'DELETE',
    // The row being deleted carries the ciphertext. Asking for nothing back is
    // what stops PostgREST echoing it into a response body.
    headers: { Prefer: 'return=minimal' },
  });
  if (response === null) return false;
  if (!response.ok) {
    console.error(`[settingsStore] the settings store refused the delete: ${response.status}`);
    return false;
  }
  return true;
}

export interface WriteSettingInput {
  /** The non-secret half. Stored verbatim as jsonb. */
  value: unknown;
  /**
   * The credential to store, in the clear. OMITTED keeps whatever is already
   * stored (the admin form leaves a password input blank to mean "unchanged");
   * `null` clears it; an empty string clears it too, so a form that always sends
   * its inputs cannot silently re-encrypt '' over a real key.
   */
  secret?: string | null;
  /** Who wrote it — the admin's account id, or 'passphrase'. */
  updatedBy: string;
}

/**
 * Write one setting. Returns false when nothing could be stored, and does not
 * throw: an admin screen that cannot save says so, and a router that cannot read
 * falls back.
 *
 * Keeping an existing credential means reading its ciphertext and writing it
 * back unchanged, rather than omitting the column and relying on PostgREST's
 * upsert to leave it alone. One extra read per save — an admin action, not a hot
 * path — buys behaviour that does not depend on how a given PostgREST version
 * treats a column absent from an ON CONFLICT payload.
 */
export async function writeSetting(
  key: string,
  input: WriteSettingInput,
  options: SettingsStoreOptions = {},
): Promise<boolean> {
  let ciphertext: string | null;
  if (input.secret === undefined) {
    const row = await readRow(key, options);
    ciphertext = row === null ? null : ciphertextOf(row);
  } else if (input.secret === null || input.secret.trim() === '') {
    ciphertext = null;
  } else {
    try {
      ciphertext = encryptSecret(input.secret.trim());
    } catch {
      // No JWT_SECRET, so nothing can be sealed. Refuse the write rather than
      // storing the key in the clear: a plaintext credential in a database that
      // is backed up is worse than a save that failed.
      console.error('[settingsStore] refusing to store a secret with no encryption key');
      return false;
    }
  }

  const body = {
    key,
    value: input.value ?? {},
    secret: ciphertext,
    updated_at: new Date().toISOString(),
    updated_by: input.updatedBy,
  };

  const response = await storeFetch(options, TABLE, {
    method: 'POST',
    // merge-duplicates turns the POST into an upsert on the primary key, so a
    // second save of the same job updates the row instead of failing on it.
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(body),
  });
  if (response === null) return false;
  if (!response.ok) {
    // The body is not read: PostgREST echoes the row it refused, and that row
    // carries the ciphertext (and would carry a plaintext secret if the write
    // ever arrived unsealed).
    console.error(`[settingsStore] the settings store refused the write: ${response.status}`);
    return false;
  }
  return true;
}
