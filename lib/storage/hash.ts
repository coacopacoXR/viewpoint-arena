// The content address, and the shape it is allowed to have.
//
// Split out from lib/storage/modelStore.ts so the two store implementations can
// use it without importing the module that imports THEM — a cycle that would
// only work by accident of hoisting order.

import { createHash } from 'node:crypto';

/**
 * A stored object's identity: 64 lower-case hex chars, and nothing else.
 *
 * The api validates a request path against this before a store ever sees it,
 * and the stores check it again on the way in. That double check is what makes
 * `<dir>/<hash>` unforgeable — no separator, no dot, no `..` can appear in a
 * value that matches, so a path built from one cannot leave the directory.
 */
export const MODEL_HASH_RE = /^[0-9a-f]{64}$/;

export function isModelHash(value: unknown): value is string {
  return typeof value === 'string' && MODEL_HASH_RE.test(value);
}

/** The file's identity, computed from its bytes rather than from its name. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash order, for a listing.
 *
 * Neither a directory read nor a bucket listing has an order of its own, so
 * `list()` sorts by this and two calls over an unchanged store answer the same
 * thing. Hex digits compare the same as their characters, so a plain string
 * comparison is the numeric one.
 */
export function compareModelHashes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
