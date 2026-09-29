// Shared plumbing for the two /api/models routes.
//
// A model file is uploaded once and served by its SHA-256 for ever after, so
// these two handlers are the only place the app touches model BYTES over HTTP.
// Everything else — the room socket, a curated review's asset, a late joiner
// catching up — carries the hash.
//
// SECURITY. Two values arrive from the caller and neither is trusted:
//
//   * the file NAME, which is stored in the sidecar and later sent back out in
//     a Content-Disposition header. It is decoded, stripped of control
//     characters and separators, and length-capped before it is kept, so it can
//     neither inject a header nor be mistaken for a path.
//   * the HASH in the download path, which is checked against MODEL_HASH_RE
//     before a store ever sees it. That single check is what makes a request
//     for `/api/models/../../etc/passwd` impossible to express: 64 lower-case
//     hex characters contain no separator, no dot and no escape.
//
// The store's own key (a Supabase service-role key) is read inside
// lib/storage and never appears in a response or in the log line below.

import type { VercelRequest } from '@vercel/node';
import { loadConfig } from '../../lib/config/loadConfig.ts';
import { modelStorageOf } from '../../lib/config/schema.ts';
import { createModelStore, type ModelStore } from '../../lib/storage/modelStore.ts';
import { modelFileExtension, SUPPORTED_EXTENSIONS } from '../../utils/modelFormats.ts';
import { requestIsUnlocked } from './accessControl.ts';

/**
 * The upload ceiling, and the one the whole model pipeline agrees on:
 * utils/modelFormats.ts allows a 200 MB CAD assembly, nginx's
 * `client_max_body_size` for /api/models is 200m, and the room socket no longer
 * carries bytes at all — so nothing else in the path is a smaller door.
 *
 * Vercel's own serverless body limit is 4.5 MB and cannot be raised, so a
 * hosted deployment can only upload up to that; the self-hosted Docker stack,
 * which is where 200 MB CAD files actually arrive, has no such limit.
 */
export const MAX_MODEL_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * How long a file name we are willing to record. Below every filesystem's 255
 * BYTE limit even if the name is entirely four-byte characters, and a name this
 * long is already a paste from a PDM system rather than something a person
 * reads in a model tree.
 */
const MAX_FILE_NAME_LENGTH = 200;

/**
 * The store this deployment configured, or null when it cannot be built.
 *
 * Null rather than a throw: the reason (a config that will not parse, a missing
 * service-role key) belongs in the server log, and the caller belongs to a
 * browser that should learn only "storage is not available". Same split as
 * api/capture/_proxyShared.ts's resolveServiceUrl.
 */
export async function resolveModelStore(): Promise<ModelStore | null> {
  try {
    const config = await loadConfig();
    return createModelStore(modelStorageOf(config));
  } catch (err) {
    console.error('[api/models] storage is not available:', err);
    return null;
  }
}

/**
 * Whether this request may pass through the front door.
 *
 * Both routes are held to it, including the download. A model file is the
 * geometry a room is reviewing — a supplier's unreleased bracket, say — and
 * `relay()` in party/room.server.ts already treats room content as something an
 * unadmitted connection does not get. Serving the same bytes to anyone who can
 * reach the origin would undo that by another door. On an install with no
 * front-door password this is true for every request, exactly as elsewhere.
 */
export function requestIsAllowed(req: VercelRequest): boolean {
  return requestIsUnlocked(req);
}

/**
 * The uploaded file's name, from a header the client percent-encoded.
 *
 * Encoded because an HTTP header value is ISO-8859-1: a name with a umlaut or a
 * CJK part number would otherwise arrive as mojibake, and the mojibake is what
 * would then be served back in Content-Disposition. Null when the header is
 * absent, undecodable, or leaves nothing usable behind.
 */
export function fileNameFromHeader(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return sanitizeFileName(decoded);
}

/**
 * A name made safe to store and to put back in a response header.
 *
 * Control characters go first: CR and LF in a header value is response
 * splitting, and a name is echoed into Content-Disposition on every download.
 * Separators become underscores and leading dots go, so the value cannot read
 * as a path even to something that later builds one out of it. What is left is
 * a label, which is all a file name is here — the object's address is its hash.
 */
export function sanitizeFileName(name: string): string | null {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
  return cleaned === '' ? null : cleaned;
}

/** Whether this is one of the formats utils/modelLoader.ts can actually read. */
export function isSupportedModelFile(fileName: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(modelFileExtension(fileName));
}

/**
 * A Content-Disposition that survives a non-ASCII name.
 *
 * Both forms on purpose: `filename*` (RFC 5987) is what a modern browser reads
 * and the only one that can carry the real characters, while the plain
 * `filename` is what an older client or a curl script sees. The ASCII fallback
 * has quotes and non-printables replaced, because it sits inside a quoted
 * string and a stray `"` would end it early.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
