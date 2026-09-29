// Server-only model file storage.
//
// docs/plan/14-rooms-models-admin-ai.md §"File storage". A model file is
// CONTENT-ADDRESSED: its SHA-256 hex digest is that file's identity everywhere
// — in the URL that serves it (/api/models/<hash>), in the MODEL_CHANGE message
// a room now sends instead of the bytes, and in a curated review's asset. Two
// consequences the rest of this module leans on:
//
//   * a download is cacheable for ever, because a name cannot outlive the
//     content it names;
//   * `put` is idempotent, so uploading a file the store already holds costs
//     nothing and stores no second copy — which is also what makes the same
//     revision uploaded from three browsers converge on one object.
//
// Nothing here imports three.js, a worker, React or the config loader: it is
// pulled in by api/models.ts and api/models/[hash].ts, and by nothing the
// browser bundles. The client side talks to /api/models only.

import type { Readable } from 'node:stream';
import type { ModelStorageConfig } from '../config/schema.ts';
import { LocalModelStore } from './localModelStore.ts';
import { SupabaseModelStore } from './supabaseModelStore.ts';

// Re-exported so a handler has one import for the whole storage surface. These
// live in ./hash.ts because the two implementations below need them too, and an
// implementation importing this module back would be a cycle.
export { MODEL_HASH_RE, isModelHash, sha256Hex } from './hash.ts';

if (typeof process === 'undefined' || !process.versions.node) {
  throw new Error(
    'lib/storage is server-only. The browser reaches model files through /api/models/<hash>.',
  );
}

/** What the uploader knows about a file. `size` is not here: the bytes decide it. */
export interface ModelUploadMeta {
  fileName: string;
  contentType: string;
  /** ISO-8601. Recorded rather than read back from mtime, so it survives a copy. */
  uploadedAt: string;
}

/** What a store records about an object, and what `head` answers with. */
export interface ModelMeta extends ModelUploadMeta {
  size: number;
}

/** What `put` answers with: enough to build the reference clients sync by. */
export interface ModelRef {
  hash: string;
  size: number;
}

/** What `list` answers with, per object: its address and everything recorded about it. */
export interface ModelListEntry extends ModelMeta {
  hash: string;
}

export interface ModelStore {
  /**
   * Store `bytes` under their own hash. Idempotent: putting the same bytes
   * twice leaves one object. The size recorded and returned is
   * `bytes.byteLength`, never a caller's claim — the hash was computed over
   * these bytes, so they are the only authority on how long they are.
   */
  put(bytes: Uint8Array, meta: ModelUploadMeta): Promise<ModelRef>;

  /**
   * The object's bytes as a stream, or null when the store has no such object.
   * A stream rather than a buffer: the ceiling on a model file is 200 MB, far
   * too much to hold in the api container's heap once per download.
   */
  get(hash: string): Promise<Readable | null>;

  /** The recorded metadata, or null when the store has no such object. */
  head(hash: string): Promise<ModelMeta | null>;

  /**
   * Every object the store holds, described by its sidecar, sorted by hash.
   *
   * The database only knows about a file once a design review points at it, so
   * a model imported in a plain session has no revision row and no curation
   * asset — and without a listing of storage itself the admin console cannot
   * show it, which means it cannot be deleted either and the volume only grows.
   * This is the one operation that answers from storage rather than from a
   * caller's hash.
   *
   * Sorted so two calls over an unchanged store answer the same thing: neither
   * a directory read nor a bucket listing has an order of its own. An object
   * whose sidecar is missing or unreadable is left out, exactly as `head`
   * leaves it out — the store cannot describe it, so there is nothing to show.
   */
  list(): Promise<ModelListEntry[]>;

  /**
   * Remove the object and its sidecar. Returns true when something was removed,
   * false when the hash was not stored. A hash that does not match MODEL_HASH_RE
   * is treated as absent (false), not as an error — the admin console calls
   * this after checking references, and a bad hash means "nothing to do".
   */
  delete(hash: string): Promise<boolean>;
}

/**
 * Which project URL the supabase provider talks to.
 *
 * `SUPABASE_URL` first, so an operator can point storage at a different project
 * than the database; `VITE_SUPABASE_URL` next, because that is the one variable
 * every Supabase deployment already sets and this provider IS the hosted-
 * Supabase case. Deliberately not a config field: the storage block names the
 * bucket and the key, and a third URL field for the one deployment shape that
 * already carries the value in its environment is one more thing to keep in
 * sync by hand.
 */
export function resolveSupabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  return url && url.trim() !== '' ? url.replace(/\/+$/, '') : undefined;
}

/**
 * The store this deployment configured.
 *
 * Built per request rather than held in a module-level singleton: it is a
 * couple of string comparisons, and a singleton would keep a service-role key
 * referenced inside the api process for as long as the container runs —
 * including after an operator rotated it.
 *
 * Throws when the supabase provider is missing its key or its project URL.
 * Failing here rather than handing back a store that 500s on first use is the
 * difference between an operator reading "X is not set" in the api log and
 * reading an opaque storage error.
 */
export function createModelStore(
  storage: ModelStorageConfig,
  env: NodeJS.ProcessEnv = process.env,
): ModelStore {
  if (storage.provider === 'local') {
    return new LocalModelStore(storage.dir);
  }

  const serviceRoleKey = env[storage.serviceRoleKeyEnv];
  if (!serviceRoleKey) {
    throw new Error(
      `modelStorage.provider is 'supabase' but ${storage.serviceRoleKeyEnv} is not set`,
    );
  }
  const url = resolveSupabaseUrl(env);
  if (!url) {
    throw new Error(
      "modelStorage.provider is 'supabase' but neither SUPABASE_URL nor VITE_SUPABASE_URL is set",
    );
  }
  return new SupabaseModelStore({ url, bucket: storage.bucket, serviceRoleKey });
}
