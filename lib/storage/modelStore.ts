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
// A store also holds DERIVATIVES: files computed from a stored one and keyed by
// the SOURCE's hash, so the content address above stays the only identity that
// travels anywhere. See DerivedKind below and ./derived.ts for the layout.
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

/**
 * A file this app COMPUTED from a stored one: the meshopt-compressed GLB that
 * convert-service tessellates a STEP/IGES/BREP upload into (task 03b).
 *
 * A derivative is addressed by its SOURCE's hash, never by its own, and that is
 * the whole of its design. The source hash is the identity that travels on the
 * room socket and in a curated review's asset, so a derivative keyed on anything
 * else would be a second address for one model — and a re-conversion, after an
 * operator raised a tessellation setting say, would orphan every reference a room
 * already holds. Keyed on the source, it replaces in place and nothing downstream
 * has to hear about it.
 */
export type DerivedKind = 'glb';

/**
 * What a store records about a derivative, and what `headDerived` answers with.
 *
 * Only the size, because everything else a caller wants is already known: the
 * kind is in the request, the source is the key, and a derivative has no name of
 * its own to record. `size` is 0 when a provider can hold the object but cannot
 * report its length, which callers read as "unknown" rather than as "empty".
 */
export interface DerivedMeta {
  size: number;
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
   *
   * Derivatives are NOT listed. They are not model files: nothing imports one,
   * nothing references one by hash, and an admin console that showed them would
   * show the same assembly twice and offer to delete a cache the source could
   * always rebuild.
   */
  list(): Promise<ModelListEntry[]>;

  /**
   * Remove the object, its sidecar and every derivative of it. Returns true when
   * something was removed, false when the hash was not stored. A hash that does
   * not match MODEL_HASH_RE is treated as absent (false), not as an error — the
   * admin console calls this after checking references, and a bad hash means
   * "nothing to do".
   *
   * Derivatives go with their source rather than surviving it: a GLB named for a
   * hash the store no longer holds is unreachable through every route, so
   * leaving it behind is disk no console can reclaim, and `delete` is the only
   * place that knows the two belong together.
   */
  delete(hash: string): Promise<boolean>;

  /**
   * Store a derivative of `sourceHash`, replacing any earlier one.
   *
   * Not idempotent the way `put` is, and that follows from the key: `<hash>.glb`
   * is named for the SOURCE, so a second conversion is a replacement rather than
   * a duplicate. Skipping it because something is already there would pin every
   * room to whatever an older convert-service produced, with no way to ask for a
   * better one.
   *
   * Accepts a stream as well as bytes, because the thing being stored is the body
   * of an HTTP response from convert-service. Writing it as it arrives is what
   * keeps a large assembly's GLB out of the api container's heap; a provider that
   * cannot stream an upload buffers it, and says so where it does.
   *
   * Throws when `sourceHash` is not a content address: the object's name is built
   * from it, so this is the check that keeps `derived/<hash>.glb` inside the
   * store, and it is a caller bug rather than a user-facing condition.
   */
  putDerived(sourceHash: string, kind: DerivedKind, bytes: Uint8Array | Readable): Promise<void>;

  /** The derivative's bytes as a stream, or null when there is none. */
  getDerived(sourceHash: string, kind: DerivedKind): Promise<Readable | null>;

  /** The derivative's size, or null when there is none. */
  headDerived(sourceHash: string, kind: DerivedKind): Promise<DerivedMeta | null>;
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
