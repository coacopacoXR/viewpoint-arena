// The AI section of the admin console (plan 14, BF).
//
// One card per job — transcription, cards, summary — each choosing its own
// provider, because a company may transcribe locally and summarise in the
// cloud, or the reverse.
//
// The form is driven entirely by lib/ai/providers.ts. Which providers a
// dropdown offers, which inputs appear, which one of them is a credential and
// which model names to suggest all come from the descriptor, so adding a
// provider there is the whole change: this file has no second list of providers
// or fields to drift out of step with the router.
//
// ── THE ONE RULE ────────────────────────────────────────────────────────────
// A key goes up and never comes down. The read API answers with
// { set, last4, unreadable } and this file renders that status. There is no
// state here capable of holding a stored credential, and the only secret ever
// put on the wire is one an administrator typed into a box during this session.
//
// Nothing here reads a build-time environment variable either. Which provider a
// deployment ends up using is the server's answer (inUse), not something the
// bundle should know — one build is served to every browser, so it cannot hold
// the difference between "configured" and "default".

import React, { useEffect, useState } from 'react';
import {
  AI_JOBS,
  AI_JOB_LABELS,
  describeInUse,
  isAbsoluteHttpUrl,
  providerById,
  providersForJob,
  requiresSecret,
  type AiField,
  type AiJob,
  type AiProviderDescriptor,
  type AiProviderId,
  type AiSettingSource,
} from '../../lib/ai/providers';

// ─── The wire contract ───────────────────────────────────────────────────────
//
// Redeclared rather than imported: api/admin/ai.ts exports these shapes but
// also imports @vercel/node and the settings store, none of which belongs in a
// browser bundle. Exported from here so a test can type its fixtures against
// the contract instead of against a guess.

/** What GET reports about a job's stored credential. Never the credential. */
export interface AiSecretStatus {
  set: boolean;
  last4: string;
  unreadable: boolean;
}

export interface AiSavedSetting {
  /** Null when a row exists that this version of the app cannot read. */
  provider: AiProviderId | null;
  /** Non-secret field values only. */
  fields: Record<string, string>;
  secret: AiSecretStatus;
  unusable: boolean;
  updatedAt: string;
  updatedBy: string;
}

/** The setting the router will actually use, and where it came from. */
export interface AiInUse {
  provider: AiProviderId;
  source: AiSettingSource;
  model: string | null;
  /** True when the provider wants a credential and none is stored. */
  missingSecret: boolean;
}

export interface AiJobView {
  job: AiJob;
  saved: AiSavedSetting | null;
  inUse: AiInUse;
  inUseLabel: string;
}

export interface AiAdminAiResponse {
  /** False when this deployment has no reachable settings store. */
  available: boolean;
  jobs: AiJobView[];
}

/** PUT answers with the row it wrote (null after a reset) and the resolution. */
export interface AiWriteResponse {
  ok?: boolean;
  job?: AiJob;
  saved?: AiSavedSetting | null;
  inUse?: AiInUse;
  error?: string;
  field?: string;
}

/** POST /test answers 200 for both outcomes; `reason` is written for a human. */
export interface AiTestResponse {
  ok?: boolean;
  job?: AiJob;
  ms?: number;
  code?: string;
  reason?: string;
  error?: string;
  field?: string;
}

/**
 * How the section reaches the API.
 *
 * AdminPage passes its token-bearing fetch in accounts/sso mode. In passphrase
 * mode the admin cookie rides along on a plain same-origin request, so the
 * default below is the correct one and the component stays free of supabase.
 */
export type AiRequest = (path: string, init?: RequestInit) => Promise<Response>;

const sameOrigin: AiRequest = (path, init) => fetch(path, init);

const GET_PATH = '/api/admin/ai';
const TEST_PATH = '/api/admin/ai/test';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const INPUT_CLASS =
  'w-full text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white placeholder:text-gray-600 focus:outline-none focus:border-white/30 disabled:opacity-50';

const NO_SECRET: AiSecretStatus = { set: false, last4: '', unreadable: false };

// ─── Draft state ─────────────────────────────────────────────────────────────

/** What an administrator has typed but not yet saved. */
interface Draft {
  provider: AiProviderId;
  /** Non-secret field values, keyed by the descriptor's field name. */
  fields: Record<string, string>;
  /** The key typed into the box. '' means "keep whatever is stored". */
  secret: string;
}

function draftFrom(view: AiJobView): Draft {
  // An unusable row is reported, not adopted: prefilling values this version
  // cannot parse would present them as though they were what is running.
  const saved = view.saved !== null && !view.saved.unusable ? view.saved : null;
  return {
    provider: saved?.provider ?? view.inUse.provider,
    fields: { ...(saved?.fields ?? {}) },
    secret: '',
  };
}

function viewAfterWrite(previous: AiJobView, data: AiWriteResponse): AiJobView {
  const inUse = data.inUse ?? previous.inUse;
  return {
    job: previous.job,
    saved: data.saved ?? null,
    inUse,
    // PUT answers with the resolution, not with the sentence GET built.
    // describeInUse is the same function the server called, so the line stays
    // truthful without a second round trip — which would also overwrite the
    // two cards the administrator is not looking at.
    inUseLabel: describeInUse(previous.job, inUse.provider, inUse.model, inUse.source),
  };
}

/** The field values that travel in `fields`. The credential never does. */
function nonSecretFields(
  descriptor: AiProviderDescriptor,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of descriptor.fields) {
    if (field.name === descriptor.secretField) continue;
    const value = (values[field.name] ?? '').trim();
    // Blank optionals are dropped rather than sent as '': the stored row then
    // records what was actually decided, and a field added later is not
    // silently pinned to an empty string.
    if (value !== '') out[field.name] = value;
  }
  return out;
}

// ─── Client-side checks ──────────────────────────────────────────────────────

/**
 * The first URL field whose value is not an absolute http(s) address, or null.
 *
 * The only check this form makes before saving. Everything else — a required
 * field left blank, a model name that does not exist, a key the provider
 * refuses — is the server's call, and copying its rules here would only create
 * a second place for them to go stale. Empty values are left alone for the same
 * reason: whether blank is acceptable depends on `required`, which the server
 * already enforces.
 *
 * isAbsoluteHttpUrl is imported, not rewritten: parseAiJobSetting applies the
 * same predicate before it accepts a setting, so the form and the endpoint
 * agree by construction. A local spelling that drifted would let an
 * administrator press Save, get no error, and see nothing change.
 */
function invalidUrlField(
  descriptor: AiProviderDescriptor,
  values: Record<string, string>,
): AiField | null {
  for (const field of descriptor.fields) {
    if (field.kind !== 'url') continue;
    const value = (values[field.name] ?? '').trim();
    if (value === '') continue;
    if (!isAbsoluteHttpUrl(value)) return field;
  }
  return null;
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** Each code the API can answer with, as one sentence an operator can act on. */
function describeApiError(status: number, body: { error?: string; field?: string }): string {
  if (status === 401 || status === 403) return 'You do not have admin access.';
  if (status === 503 || body.error === 'settings_unavailable') {
    return 'AI settings cannot be saved on this deployment: it has no reachable settings store. Saving needs a database holding the settings table and a server secret to encrypt a key with.';
  }
  switch (body.error) {
    case 'invalid_provider':
      return 'That provider cannot do this job. Pick another from the list.';
    case 'secret_required':
      return 'This provider needs a key and none is stored. Type the key in, then save again.';
    case 'invalid_body':
      return 'These settings are incomplete or invalid. Check the fields and save again.';
    default:
      return `The server refused the request (HTTP ${status}).`;
  }
}

/**
 * What the credential box says when nothing is stored.
 *
 * `required` is requiresSecret(descriptor.id), never `field.required` and never
 * `secretField !== null`. A provider can support a credential and work without
 * one — openaiCompatible and webhook both do, because a model server on a
 * trusted network and an internal gateway that authenticates by address are the
 * main reason those two providers exist. Telling an administrator that one of
 * those is missing a key sends them to fix something that is not broken. It is
 * also the predicate the server computed inUse.missingSecret with, so the box
 * and the warning under the card cannot contradict each other.
 */
function secretPlaceholder(status: AiSecretStatus, field: AiField, required: boolean): string {
  if (status.unreadable) return 'Enter the key again';
  if (status.set) return 'Leave blank to keep the stored key';
  return field.placeholder ?? (required ? 'Required' : 'Optional');
}

function secretStatusLine(status: AiSecretStatus, required: boolean): string {
  if (status.unreadable) {
    return 'The stored key cannot be read with the secret on this server — enter it again.';
  }
  if (status.set) {
    // last4 is '' only when the store could not compute a tail it was happy to
    // show; saying "Key set" beats inventing four characters.
    return status.last4 === '' ? 'Key set' : `Key set · ends in …${status.last4}`;
  }
  return required
    ? 'No key is stored — one is required.'
    : 'No key is stored — it is optional for this provider.';
}

/** One decimal place: 1400 ms reads as "1.4 s", which is the precision a person comparing two providers can actually use. */
function seconds(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? (ms / 1000).toFixed(1) : '?';
}

function testOutcome(data: AiTestResponse): { ok: boolean; text: string } {
  if (data.ok === true) {
    return { ok: true, text: `Works — answered in ${seconds(data.ms)} s` };
  }
  // Verbatim. The server wrote this sentence for a human and already checked it
  // for keys, transcripts and upstream bodies; rewording it from `code`, or
  // adding to it here, would only create a second version to disagree with.
  return { ok: false, text: data.reason ?? 'The connection test did not succeed.' };
}

// ─── One field ───────────────────────────────────────────────────────────────

const AiFieldRow: React.FC<{
  job: AiJob;
  field: AiField;
  descriptor: AiProviderDescriptor;
  secretStatus: AiSecretStatus;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}> = ({ job, field, descriptor, secretStatus, value, disabled, onChange }) => {
  const isSecret = field.name === descriptor.secretField;
  // Not `secretField !== null`: see secretPlaceholder.
  const secretRequired = requiresSecret(descriptor.id);
  const id = `ai-input-${job}-${field.name}`;
  const listId = `${id}-models`;
  const fallbackModel = descriptor.defaultModel[job];

  const help =
    field.help ??
    (field.kind === 'model'
      ? `Pick a suggestion or type any model name${
          fallbackModel ? ` — blank uses ${fallbackModel}` : ''
        }. The list is only a starting point.`
      : undefined);

  return (
    <div data-field-name={field.name} className="space-y-1">
      <label
        htmlFor={id}
        className="block text-[10px] font-mono text-gray-500 uppercase tracking-wider"
      >
        {field.label}
      </label>

      {field.kind === 'model' ? (
        // A datalist rather than a select: a list of model names is stale the
        // week it is written, and a deployment behind its own gateway has names
        // this repo has never seen.
        <>
          <input
            id={id}
            data-testid={id}
            type="text"
            list={listId}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder ?? 'Any model name'}
            className={INPUT_CLASS}
          />
          <datalist id={listId}>
            {(descriptor.models[job] ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      ) : (
        <input
          id={id}
          data-testid={id}
          type={field.kind === 'password' ? 'password' : 'text'}
          // A credential box the browser offers to fill is a box that gets
          // filled with a login password from somewhere else.
          autoComplete={field.kind === 'password' ? 'off' : undefined}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            isSecret ? secretPlaceholder(secretStatus, field, secretRequired) : field.placeholder
          }
          className={INPUT_CLASS}
        />
      )}

      {isSecret && (
        <p className="text-[11px] leading-relaxed" data-testid={`ai-secret-status-${job}`}>
          <span
            className={
              secretStatus.set && !secretStatus.unreadable ? 'text-emerald-400' : 'text-gray-500'
            }
          >
            {secretStatusLine(secretStatus, secretRequired)}
          </span>
          {secretStatus.set && !secretStatus.unreadable && (
            <span className="text-gray-600"> Leave the box blank to keep it.</span>
          )}
        </p>
      )}

      {help && <p className="text-[11px] text-gray-600 leading-relaxed">{help}</p>}
    </div>
  );
};

// ─── One card ────────────────────────────────────────────────────────────────

const AiJobCard: React.FC<{
  job: AiJob;
  initial: AiJobView;
  request: AiRequest;
  /** False when this deployment has nowhere to save to. */
  writable: boolean;
}> = ({ job, initial, request, writable }) => {
  const [view, setView] = useState<AiJobView>(initial);
  // Seeded once from the load. The section never re-fetches, so this prop is
  // not going to change underneath the draft and re-seeding it would throw
  // away what the administrator has typed.
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const descriptor = providerById(draft.provider);
  // draft.provider only ever comes from providersForJob or from a row the
  // server already accepted, so this is the type system, not a state to
  // recover from. Above the JSX, below every hook.
  if (descriptor === null) return null;

  const secretStatus = view.saved?.secret ?? NO_SECRET;

  const setField = (name: string, value: string) => {
    setDraft((d) => ({ ...d, fields: { ...d.fields, [name]: value } }));
  };

  const changeProvider = (value: string) => {
    const next = providersForJob(job).find((p) => p.id === value);
    if (next === undefined) return;
    // A different provider has a different set of fields, and posting the old
    // values under names the new one does not have is how a row ends up half
    // written. The stored key is server-side and untouched by a dropdown, so
    // its status line stays exactly as the server reported it — which also
    // means switching provider and saving with a blank box keeps that key,
    // now sealed against the new provider. The box says so.
    setDraft({ provider: next.id, fields: {}, secret: '' });
    setResult(null);
    setError(null);
    setNotice(null);
  };

  const requestBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      job,
      provider: descriptor.id,
      fields: nonSecretFields(descriptor, draft.fields),
    };
    // Omitted, not sent as null: a blank box means "keep the key that is
    // stored", and null is how this API is told to delete it.
    const typed = draft.secret.trim();
    if (typed !== '') body.secret = typed;
    return body;
  };

  const urlProblem = (): string | null => {
    const bad = invalidUrlField(descriptor, draft.fields);
    return bad === null
      ? null
      : `${bad.label} must be a full web address, like https://example.com.`;
  };

  const handleSave = async () => {
    const blocked = urlProblem();
    if (blocked !== null) {
      setError(blocked);
      setNotice(null);
      return;
    }
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const res = await request(GET_PATH, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(requestBody()),
      });
      const data = (await res.json().catch(() => ({}))) as AiWriteResponse;
      if (!res.ok || data.ok !== true) {
        setError(describeApiError(res.status, data));
        return;
      }
      setView(viewAfterWrite(view, data));
      // The typed key is stored now. Blanking the box is what makes the
      // "leave blank to keep it" line true again.
      setDraft((d) => ({ ...d, secret: '' }));
      setNotice('Saved.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy('save');
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const res = await request(GET_PATH, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ job, reset: true }),
      });
      const data = (await res.json().catch(() => ({}))) as AiWriteResponse;
      if (!res.ok || data.ok !== true) {
        setError(describeApiError(res.status, data));
        return;
      }
      const next = viewAfterWrite(view, data);
      setView(next);
      // The row is gone, so the card shows what is running now instead of the
      // values that were just deleted.
      setDraft(draftFrom(next));
      setConfirmReset(false);
      setNotice('Reset — this job now uses the deployment default.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    const blocked = urlProblem();
    if (blocked !== null) {
      setError(blocked);
      setNotice(null);
      return;
    }
    setBusy('test');
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const res = await request(TEST_PATH, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(requestBody()),
      });
      const data = (await res.json().catch(() => ({}))) as AiTestResponse;
      if (!res.ok) {
        setError(describeApiError(res.status, data));
        return;
      }
      setResult(testOutcome(data));
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid={`ai-card-${job}`}
      className="bg-white/5 border border-white/10 rounded-xl px-4 py-4 space-y-3"
    >
      <h3 className="text-xs font-bold text-white">{AI_JOB_LABELS[job]}</h3>

      <div className="space-y-1">
        <label
          htmlFor={`ai-provider-${job}`}
          className="block text-[10px] font-mono text-gray-500 uppercase tracking-wider"
        >
          Provider
        </label>
        <select
          id={`ai-provider-${job}`}
          data-testid={`ai-provider-${job}`}
          value={draft.provider}
          disabled={busy !== null}
          onChange={(e) => changeProvider(e.target.value)}
          className="w-full text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-white/30 disabled:opacity-50"
        >
          {providersForJob(job).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {descriptor.help && (
          <p className="text-[11px] text-gray-500 leading-relaxed pt-0.5">{descriptor.help}</p>
        )}
      </div>

      {descriptor.fields.length > 0 && (
        <div className="space-y-3">
          {descriptor.fields.map((field) => {
            const isSecret = field.name === descriptor.secretField;
            return (
              <AiFieldRow
                key={field.name}
                job={job}
                field={field}
                descriptor={descriptor}
                secretStatus={secretStatus}
                value={isSecret ? draft.secret : (draft.fields[field.name] ?? '')}
                disabled={busy !== null}
                onChange={(next) =>
                  isSecret ? setDraft((d) => ({ ...d, secret: next })) : setField(field.name, next)
                }
              />
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={busy !== null || !writable}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white text-gray-900 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={handleTest}
          disabled={busy !== null}
          className="text-[10px] font-mono px-2 py-1 rounded border border-white/10 hover:border-white/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        {confirmReset ? (
          <>
            <button
              onClick={handleReset}
              disabled={busy !== null || !writable}
              className="text-[10px] font-mono px-2 py-1 rounded bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-50"
            >
              Confirm reset
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmReset(true)}
            disabled={busy !== null || !writable || view.saved === null}
            className="text-[10px] font-mono px-2 py-1 rounded text-gray-500 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Reset to default
          </button>
        )}
      </div>

      {busy === 'test' ? (
        <p className="text-gray-500 text-[11px]">Testing the connection…</p>
      ) : (
        result && (
          <p
            data-testid={`ai-test-result-${job}`}
            className={result.ok ? 'text-emerald-400 text-[11px]' : 'text-red-400 text-[11px]'}
          >
            {result.text}
          </p>
        )
      )}

      {error && (
        <p className="text-red-400 text-[11px]" data-testid={`ai-error-${job}`}>
          {error}
        </p>
      )}
      {notice && !error && <p className="text-emerald-400 text-[11px]">{notice}</p>}

      <div className="border-t border-white/10 pt-2 space-y-1">
        <p className="text-[11px] text-gray-500" data-testid={`ai-in-use-${job}`}>
          In use now: <span className="text-gray-300">{view.inUseLabel}</span>
        </p>
        {view.inUse.missingSecret && (
          <p className="text-amber-400 text-[11px]">
            The provider in use wants a key and none is stored, so this job will
            fail until one is saved here.
          </p>
        )}
        {view.saved?.unusable && (
          <p className="text-amber-400 text-[11px]">
            A setting is stored for this job that this version of the app cannot
            read, so it is being ignored. Saving here replaces it.
          </p>
        )}
      </div>
    </div>
  );
};

// ─── The section ─────────────────────────────────────────────────────────────

const AiHeading: React.FC = () => (
  <h2 className="text-sm font-bold font-mono text-gray-400 uppercase tracking-widest mb-4">
    AI
  </h2>
);

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; available: boolean; jobs: AiJobView[] };

const AiSettingsSection: React.FC<{ request?: AiRequest }> = ({ request }) => {
  const send = request ?? sameOrigin;
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    // One read when the section opens. Each card keeps itself current from its
    // own write's response, so there is nothing here worth polling for — and a
    // poll would re-seed a card someone is halfway through editing.
    let cancelled = false;
    void (async () => {
      try {
        const res = await send(GET_PATH);
        const data = (await res.json().catch(() => ({}))) as Partial<AiAdminAiResponse> & {
          error?: string;
        };
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', message: describeApiError(res.status, data) });
          return;
        }
        if (!cancelled) {
          setState({
            status: 'ready',
            available: data.available === true,
            jobs: Array.isArray(data.jobs) ? data.jobs : [],
          });
        }
      } catch {
        if (!cancelled) setState({ status: 'error', message: 'Could not reach the server.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [send]);

  if (state.status === 'loading') {
    return (
      <section>
        <AiHeading />
        <p className="text-gray-600 text-xs">Loading…</p>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section>
        <AiHeading />
        <p className="text-red-400 text-xs" data-testid="ai-load-error">
          {state.message}
        </p>
      </section>
    );
  }

  // AI_JOBS decides the order, and a job id this bundle has never heard of
  // cannot produce a card — the descriptors are what the form renders from.
  const byJob = new Map(state.jobs.map((j) => [j.job, j] as const));

  return (
    <section>
      <AiHeading />
      <p className="text-gray-500 text-xs leading-relaxed mb-4">
        Choose which AI does each job. Each job is set separately, so a
        deployment can transcribe on this server and summarise in the cloud.
        Keys are stored encrypted here and are never sent back to the browser.
      </p>

      {!state.available && (
        <div
          data-testid="ai-unavailable"
          className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3"
        >
          <p className="text-amber-300 text-xs leading-relaxed">
            AI settings cannot be saved on this deployment: it has no reachable
            settings store. Saving needs a database holding the settings table
            and a server secret to encrypt a key with — check that both are
            configured, then reload this page. Every job keeps running on what
            it resolves to now; the choices below are read-only.
          </p>
        </div>
      )}

      <div className="space-y-3">
        {AI_JOBS.map((job) => {
          const view = byJob.get(job);
          if (view === undefined) return null;
          return (
            <AiJobCard
              key={job}
              job={job}
              initial={view}
              request={send}
              writable={state.available}
            />
          );
        })}
      </div>
    </section>
  );
};

export default AiSettingsSection;
