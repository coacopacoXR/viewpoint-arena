// Parsing and validation for the PLM launch deep link (T5.3).
//
// A PLM system opens a review with
//   https://<host>/launch?plmSource=onshape&plmDoc=<id>&plmWorkspace=<id>&plmElement=<id>
//
// Every value in that query string is attacker-influenced: anyone can hand-edit
// a link, and the template itself lives in a customer's PLM admin console. So
// the ids are validated HERE, before any adapter sees them and before any URL
// is built out of them, and each adapter repeats the check inside
// resolveLaunchContext for a corp that calls the adapter directly.
//
// NO CREDENTIALS, BY DESIGN. A launch link authenticates with the PLM session
// the browser already holds (Onshape: the HttpOnly OAuth cookies). This module
// has no notion of a token parameter — parseLaunchParams only ever reads the
// four keys in LAUNCH_PARAM_KEYS — and stripCredentialParams removes
// credential-shaped keys from the address bar so a token pasted into a link
// cannot survive into history, a bookmark, a server log or a Referer header.

import type { PLMDocumentRef } from './types.ts';

/** The only query keys a launch link may carry. Anything else is ignored. */
export const LAUNCH_PARAM_KEYS = [
  'plmSource',
  'plmDoc',
  'plmWorkspace',
  'plmElement',
] as const;

export type LaunchSource = 'onshape' | 'teamcenter' | 'mock';

const LAUNCH_SOURCES: readonly string[] = ['onshape', 'teamcenter', 'mock'];

/** Human-readable name per source, for UI copy. Never interpolated into a URL. */
export const PLM_SOURCE_LABELS: Record<LaunchSource, string> = {
  onshape: 'Onshape',
  teamcenter: 'Teamcenter',
  mock: 'Mock PLM',
};

// Onshape document / workspace / element ids are 24 lowercase hex characters
// (MongoDB ObjectIds). Nothing else is an Onshape id, so this is both a
// validation and a proof that the value cannot carry `/`, `?`, `#`, `\` or a
// percent-escape into a URL we build from it.
const ONSHAPE_ID_RE = /^[0-9a-f]{24}$/;

// Teamcenter UIDs and the mock catalogue's ids are opaque strings. The allowed
// set is deliberately narrow: alphanumerics plus `_`, `.`, `-`. That excludes
// every character that is structural in a path or a query string, so a
// path-traversal (`../../x`), an injected parameter (`a?b=c`) or an encoded
// separator (`%2F`, which URLSearchParams has already decoded to `/`) can
// never pass. The 128-char cap keeps an oversized value out of logs and UI.
const GENERIC_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// Credential-shaped keys. Never read, never forwarded, removed from the address
// bar. Compared case-insensitively because a PLM template may capitalise them.
const CREDENTIAL_PARAM_KEYS = new Set([
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'api_key',
  'apikey',
  'secret',
  'client_secret',
  'password',
  'credential',
  'authorization',
]);

/** Error copy. Fixed strings: none of them may echo the rejected input. */
const ERR = {
  unreadable: 'This launch link could not be read.',
  missingSource: 'This launch link does not say which PLM system it came from.',
  unknownSource: 'This launch link names a PLM system this app does not support.',
  missingDoc: 'This launch link does not name a document.',
  badDoc: 'The document id in this launch link is not valid.',
  badWorkspace: 'The workspace id in this launch link is not valid.',
  badElement: 'The element id in this launch link is not valid.',
} as const;

export type LaunchParams =
  | { source: LaunchSource; doc: PLMDocumentRef }
  | { error: string };

export interface PLMLaunch {
  source: LaunchSource;
  doc: PLMDocumentRef;
}

export function isLaunchError(result: LaunchParams): result is { error: string } {
  return 'error' in result;
}

function isLaunchSource(value: string): value is LaunchSource {
  return LAUNCH_SOURCES.includes(value);
}

/** Onshape's 24-hex id shape. Exported for the adapter's own re-check. */
export function isOnshapeId(id: string): boolean {
  return ONSHAPE_ID_RE.test(id);
}

/** The opaque-id shape Teamcenter and the mock catalogue use. */
export function isGenericPlmId(id: string): boolean {
  return GENERIC_ID_RE.test(id);
}

export function isValidPlmId(source: LaunchSource, id: string): boolean {
  return source === 'onshape' ? isOnshapeId(id) : isGenericPlmId(id);
}

/**
 * Parse and validate a launch link's query string.
 *
 * Returns the validated ids and nothing else: unknown keys are dropped, a
 * credential key is dropped, and the resolved `doc` contains only values that
 * passed the shape check for that source. An `error` is always a fixed string
 * from ERR — never the caller's input, because this text is rendered on screen
 * and ends up in support screenshots.
 */
export function parseLaunchParams(search: string): LaunchParams {
  const params = new URLSearchParams(search);

  const source = params.get('plmSource');
  if (!source) return { error: ERR.missingSource };
  if (!isLaunchSource(source)) return { error: ERR.unknownSource };

  const docId = params.get('plmDoc');
  if (!docId) return { error: ERR.missingDoc };
  if (!isValidPlmId(source, docId)) return { error: ERR.badDoc };

  const doc: PLMDocumentRef = { id: docId };

  const workspaceId = params.get('plmWorkspace');
  if (workspaceId) {
    if (!isValidPlmId(source, workspaceId)) return { error: ERR.badWorkspace };
    doc.workspaceId = workspaceId;
  }

  const elementId = params.get('plmElement');
  if (elementId) {
    if (!isValidPlmId(source, elementId)) return { error: ERR.badElement };
    doc.elementId = elementId;
  }

  return { source, doc };
}

/**
 * Remove credential-shaped parameters from a query string.
 *
 * Returns the input unchanged when there was nothing to strip, so the caller can
 * tell "leave the address bar alone" from "rewrite it".
 */
export function stripCredentialParams(search: string): string {
  const params = new URLSearchParams(search);
  let stripped = false;
  for (const key of [...params.keys()]) {
    if (CREDENTIAL_PARAM_KEYS.has(key.toLowerCase())) {
      params.delete(key);
      stripped = true;
    }
  }
  if (!stripped) return search;
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Rebuild a launch query string from validated ids.
 *
 * Used for the Onshape OAuth `returnTo`, which has to point back at /launch
 * rather than at the setup page — router state does not survive the redirect.
 * Only the four known keys are emitted, so a credential can never be
 * reconstructed into it even by a caller holding one.
 */
export function buildLaunchSearch(source: LaunchSource, doc: PLMDocumentRef): string {
  const params = new URLSearchParams({ plmSource: source, plmDoc: doc.id });
  if (doc.workspaceId) params.set('plmWorkspace', doc.workspaceId);
  if (doc.elementId) params.set('plmElement', doc.elementId);
  return `?${params.toString()}`;
}

/** The query record handed to PLMAdapter.resolveLaunchContext. */
export function launchQuery(launch: PLMLaunch): Record<string, string> {
  const query: Record<string, string> = {
    plmSource: launch.source,
    plmDoc: launch.doc.id,
  };
  if (launch.doc.workspaceId) query.plmWorkspace = launch.doc.workspaceId;
  if (launch.doc.elementId) query.plmElement = launch.doc.elementId;
  return query;
}

/**
 * The URL a launched document is recorded with in the review's references, or
 * undefined when none can be built honestly.
 *
 * Only ever assembled from ids this module already validated, and encoded again
 * here: the result is rendered into an `<a href>` and saved into the curation, so
 * it must not be able to become `javascript:` or point off the PLM's own host.
 *
 * Teamcenter gets NO url. The public config exposes plm.baseUrl but no document
 * path shape, and inventing one would produce a plausible link that 404s inside
 * a customer's own TC web client. Adding the real path would mean a new config
 * field. A named reference with no link is honest; a dead link is not.
 */
export function plmReferenceUrl(
  source: LaunchSource,
  doc: PLMDocumentRef,
): string | undefined {
  if (source !== 'onshape') return undefined;
  const base = `https://cad.onshape.com/documents/${encodeURIComponent(doc.id)}`;
  if (!doc.workspaceId) return base;
  const withWorkspace = `${base}/w/${encodeURIComponent(doc.workspaceId)}`;
  if (!doc.elementId) return withWorkspace;
  return `${withWorkspace}/e/${encodeURIComponent(doc.elementId)}`;
}
