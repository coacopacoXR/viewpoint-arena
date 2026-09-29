import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../_lib/adminAuth.ts';
import {
  AI_JOBS,
  aiSettingKey,
  describeInUse,
  isAiProviderId,
  parseAiJobSetting,
  providerById,
  requiresSecret,
  type AiJob,
  type AiProviderId,
} from '../../lib/ai/providers.ts';
import {
  deleteSetting,
  openSettingSecret,
  probeSettingsStore,
  readSetting,
  writeSetting,
  type SecretStatus,
  type StoredSetting,
} from '../../lib/ai/settingsStore.ts';
import { describeResolution, resolveJob, validateSubmittedSetting } from '../../lib/ai/router.ts';

/**
 * GET/PUT /api/admin/ai — the AI section of the admin console (plan 14, BF).
 *
 * Three jobs, one setting each. Behind requireAdmin, which in identity.mode
 * 'none' is the passphrase cookie and in 'accounts'/'sso' is an app_metadata.role
 * of 'admin' — so this works in every mode the console does, including a LAN
 * install with no directory.
 *
 * ── THE ONE RULE THIS ENDPOINT EXISTS TO KEEP ────────────────────────────────
 * A secret goes IN and never comes OUT. GET reports `{ set, last4, unreadable }`
 * for the credential of each job; the value itself is read only by
 * lib/ai/settingsStore.openSettingSecret, which the router calls when it is about
 * to put the key in an upstream header. There is no code path from a stored
 * ciphertext to a response body here, and the read helper this file uses returns a
 * type that has no field capable of holding one.
 *
 * Everything else in a response is already public knowledge or already the
 * admin's own input: a provider id, a model name, an endpoint URL they typed.
 */

/** What GET reports for one job. */
export interface SavedJobView {
  /** Null when a row exists that this version of the app cannot read. */
  provider: AiProviderId | null;
  /** Non-secret field values only. Never contains a credential. */
  fields: Record<string, string>;
  secret: SecretStatus;
  /** True when a row exists but could not be parsed — the screen says so. */
  unusable: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** What GET reports about the setting the router will actually use. */
export interface InUseView {
  job: AiJob;
  saved: SavedJobView | null;
  inUse: {
    provider: AiProviderId;
    source: 'settings' | 'config' | 'default';
    model: string | null;
    /** True when the provider wants a credential and none is stored. */
    missingSecret: boolean;
  };
  /** The one-line sentence rendered under the card. */
  inUseLabel: string;
}

function savedViewOf(job: AiJob, stored: StoredSetting): SavedJobView {
  const parsed = parseAiJobSetting(job, stored.value);
  if (parsed === null) {
    // A row an older version wrote, or a provider that no longer does this job.
    // Reported rather than silently dropped: an admin looking at a screen that
    // says "default" while a row says otherwise has no way to find the discrepancy.
    return {
      provider: null,
      fields: {},
      secret: stored.secret,
      unusable: true,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
    };
  }
  return {
    provider: parsed.provider,
    fields: parsed.fields,
    secret: stored.secret,
    unusable: false,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

async function viewOf(job: AiJob): Promise<InUseView> {
  const stored = await readSetting(aiSettingKey(job));
  const resolved = describeResolution(await resolveJob(job));
  return {
    job,
    saved: stored === null ? null : savedViewOf(job, stored),
    inUse: resolved,
    inUseLabel: describeInUse(job, resolved.provider, resolved.model, resolved.source),
  };
}

interface AiRequestBody {
  job?: unknown;
  provider?: unknown;
  fields?: unknown;
  /** The credential in the clear, or null to remove it. Omitted means unchanged. */
  secret?: unknown;
  /** Delete the row, so the job resolves from config and then from built-in. */
  reset?: unknown;
}

function isAiJob(value: unknown): value is AiJob {
  return typeof value === 'string' && (AI_JOBS as readonly string[]).includes(value);
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  if (req.method === 'GET') {
    // Probed separately from the rows: "no setting saved" and "no database to
    // save one in" look identical per job, and only the second is a fault the
    // operator has to be told about.
    const available = await probeSettingsStore();
    const jobs: InUseView[] = [];
    for (const job of AI_JOBS) {
      jobs.push(await viewOf(job));
    }
    res.status(200).json({ available, jobs });
    return;
  }

  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = (req.body ?? {}) as AiRequestBody;
  if (!isAiJob(body.job)) {
    res.status(400).json({ error: 'invalid_body', fields: ['job'] });
    return;
  }
  const job = body.job;
  const key = aiSettingKey(job);

  if (body.reset === true) {
    const deleted = await deleteSetting(key);
    if (!deleted) {
      res.status(503).json({ error: 'settings_unavailable' });
      return;
    }
    res.status(200).json({ ok: true, job, saved: null, inUse: (await viewOf(job)).inUse });
    return;
  }

  if (!isAiProviderId(body.provider)) {
    res.status(400).json({ error: 'invalid_provider' });
    return;
  }
  const provider = body.provider;
  const descriptor = providerById(provider);
  if (descriptor === null || !descriptor.jobs.includes(job)) {
    // Refused here rather than at the next meeting: an admin who saves
    // "Anthropic for transcription" and finds out during a review has lost the
    // thing this screen is for.
    res.status(400).json({ error: 'invalid_provider' });
    return;
  }

  const setting = validateSubmittedSetting(job, { provider, fields: body.fields });
  if (setting === null) {
    res.status(400).json({ error: 'invalid_body', fields: ['provider', 'fields'] });
    return;
  }

  // The credential. Three spellings, because a form that posts its inputs
  // straight through is the common case and refusing it would only teach people
  // to write custom submission code:
  //   * `secret` present — that is the value (null or '' clears it);
  //   * the provider's own secret field arrived inside `fields` — take it from
  //     there, and parseAiJobSetting has already kept it out of the stored value;
  //   * neither — leave whatever is stored alone.
  const submitted = readSubmittedSecret(body, descriptor.secretField);

  if (requiresSecret(provider) && submitted === undefined) {
    const existing = await openSettingSecret(key);
    if (existing === null) {
      // A provider that needs a key, with no key typed and none stored. Saving
      // this would produce a setting that fails at the first real request with a
      // 503 the admin would have to come back here to diagnose. An
      // openai-compatible gateway or a webhook with no header value is NOT this
      // case: both are complete without a credential.
      res.status(400).json({ error: 'secret_required', field: descriptor.secretField });
      return;
    }
  }

  const written = await writeSetting(key, {
    value: { provider: setting.provider, fields: setting.fields },
    secret: submitted,
    updatedBy: admin.sub,
  });
  if (!written) {
    // Includes the case where there is no JWT_SECRET to seal a key with: the
    // store refuses to write a plaintext credential, which is the right answer
    // and one the operator has to hear.
    res.status(503).json({ error: 'settings_unavailable' });
    return;
  }

  const view = await viewOf(job);
  res.status(200).json({ ok: true, job, saved: view.saved, inUse: view.inUse });
}

/**
 * The credential a PUT carried, or undefined for "leave the stored one alone".
 *
 * Trimmed but otherwise untouched: a key with a trailing newline from a paste is a
 * key, and a key that is only whitespace is not.
 */
function readSubmittedSecret(
  body: AiRequestBody,
  secretField: string | null,
): string | null | undefined {
  if (body.secret !== undefined) {
    if (body.secret === null) return null;
    if (typeof body.secret !== 'string') return null;
    const trimmed = body.secret.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (secretField === null) return undefined;
  const fields = body.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return undefined;
  const carried = (fields as Record<string, unknown>)[secretField];
  if (typeof carried !== 'string') return undefined;
  const trimmed = carried.trim();
  return trimmed === '' ? undefined : trimmed;
}

export default handler;
