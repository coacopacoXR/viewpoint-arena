// The metadata record that travels beside a stored model file.
//
// Both providers keep it in the same shape and in the same place relative to the
// object — `<hash>.json` next to `<hash>` — so a directory copied off the local
// volume and uploaded to a bucket (or the reverse) still describes itself. The
// bytes answer "what is this file"; the sidecar answers "what was it called and
// when did it arrive", which a content address cannot.

import type { ModelMeta, ModelUploadMeta } from './modelStore.ts';

export const SIDECAR_SUFFIX = '.json';

/** The sidecar's name inside the store, given the object's hash. */
export function sidecarName(hash: string): string {
  return `${hash}${SIDECAR_SUFFIX}`;
}

/**
 * The record to write. `size` comes from the caller's byte count, not from
 * `meta`: a store that recorded the length somebody claimed would serve a
 * Content-Length its own object contradicts.
 */
export function buildSidecar(meta: ModelUploadMeta, size: number): string {
  const record: ModelMeta = {
    fileName: meta.fileName,
    size,
    contentType: meta.contentType,
    uploadedAt: meta.uploadedAt,
  };
  return JSON.stringify(record);
}

/**
 * A sidecar back into metadata, or null when it is not one.
 *
 * Null rather than a throw: a truncated or hand-edited record means the store
 * cannot describe this object, and the api's answer to that is a 404 — the same
 * answer it gives for an object that was never there. Crashing the request
 * would turn one bad file into a 500 nobody could diagnose from the outside.
 */
export function parseSidecar(raw: string): ModelMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const { fileName, size, contentType, uploadedAt } = record;
  if (typeof fileName !== 'string' || fileName === '') return null;
  if (typeof contentType !== 'string' || contentType === '') return null;
  if (typeof uploadedAt !== 'string' || uploadedAt === '') return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  return { fileName, size, contentType, uploadedAt };
}
