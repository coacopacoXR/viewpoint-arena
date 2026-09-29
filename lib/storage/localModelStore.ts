// The `local` model store: one directory, one file per hash.
//
// This is the default provider and the one the Docker install runs — a named
// volume (`models-data`) mounted at /data/models on the `api` service, so an
// upgrade that recreates the container does not take every room's model with it.
//
// Layout, flat:
//
//     <dir>/<sha256>          the bytes, and nothing but the bytes
//     <dir>/<sha256>.json     the sidecar (lib/storage/sidecar.ts)
//
// Flat is enough because the name is a 64-char content address: there are no
// collisions to shard around and no subdirectory tree for a listing to walk —
// `list()` is one `readdirSync` of this directory. It also means the ONLY thing
// that decides a path is a value MODEL_HASH_RE accepted, which is what makes a
// request for `/api/models/../../etc/passwd` unreach this module at all — and it
// is checked again here so a future caller that forgot the api's validation
// still cannot escape `dir`.

import { randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { compareModelHashes, isModelHash, sha256Hex } from './hash.ts';
import { SIDECAR_SUFFIX, buildSidecar, parseSidecar, sidecarName } from './sidecar.ts';
import type {
  ModelListEntry,
  ModelMeta,
  ModelRef,
  ModelStore,
  ModelUploadMeta,
} from './modelStore.ts';

export class LocalModelStore implements ModelStore {
  constructor(private readonly dir: string) {}

  async put(bytes: Uint8Array, meta: ModelUploadMeta): Promise<ModelRef> {
    const hash = sha256Hex(bytes);
    const size = bytes.byteLength;

    mkdirSync(this.dir, { recursive: true });
    const objectPath = join(this.dir, hash);
    const sidecarPath = join(this.dir, sidecarName(hash));

    // Idempotent. Content-addressed means an object already here IS these
    // bytes, so there is nothing to write and nothing that could differ —
    // which is what lets three browsers upload the same revision and land one
    // object, and lets a retried upload after a dropped connection be free.
    if (existsSync(objectPath) && existsSync(sidecarPath)) {
      return { hash, size };
    }

    // Sidecar first. A crash between the two writes then leaves metadata with
    // no object, `get` answers null, and the api answers 404 — the same answer
    // it gives for a file nobody uploaded. The other order would leave bytes
    // nothing can describe, which reads as a working store that serves a file
    // with no name and no size.
    if (!existsSync(sidecarPath)) {
      this.writeAtomic(sidecarPath, buildSidecar(meta, size));
    }
    if (!existsSync(objectPath)) {
      this.writeAtomic(objectPath, bytes);
    }
    return { hash, size };
  }

  async get(hash: string): Promise<Readable | null> {
    if (!isModelHash(hash)) return null;
    const path = join(this.dir, hash);
    if (!existsSync(path)) return null;
    return createReadStream(path);
  }

  async head(hash: string): Promise<ModelMeta | null> {
    if (!isModelHash(hash)) return null;
    const path = join(this.dir, sidecarName(hash));
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      // Gone between the existsSync and the read (a concurrent cleanup, a
      // volume that just went away). Treated as absent, not as an error.
      return null;
    }
    return parseSidecar(raw);
  }

  /**
   * The directory's sidecars, each answered with the metadata it holds.
   *
   * Sidecars rather than objects: `<hash>.json` is the only name in here that
   * can describe a file, and the bytes beside it can say nothing about
   * themselves. Listing them is also what makes the state a crash mid-`put`
   * leaves — a sidecar with no object yet — visible to an admin, instead of
   * being something only a `du` on the volume would ever turn up.
   */
  async list(): Promise<ModelListEntry[]> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      // Nothing has been put yet, so the directory does not exist; or the
      // volume went away. Either way there is nothing to describe, and an empty
      // listing is the same answer `head` gives for an absent object.
      return [];
    }

    const entries: ModelListEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(SIDECAR_SUFFIX)) continue;
      const hash = name.slice(0, -SIDECAR_SUFFIX.length);
      // Leaves out the object itself, a temp file from a write still in flight,
      // and any other name that is not a content address. `head` makes the same
      // check again before it builds a path.
      if (!isModelHash(hash)) continue;
      // Null for a sidecar that went away between the two reads, or one that
      // does not parse: a file the store cannot describe is not one this
      // listing can show.
      const meta = await this.head(hash);
      if (meta) entries.push({ hash, ...meta });
    }
    return entries.sort((a, b) => compareModelHashes(a.hash, b.hash));
  }

  async delete(hash: string): Promise<boolean> {
    if (!isModelHash(hash)) return false;
    const objectPath = join(this.dir, hash);
    const sidecarPath = join(this.dir, sidecarName(hash));
    let removed = false;
    if (existsSync(objectPath)) {
      rmSync(objectPath);
      removed = true;
    }
    if (existsSync(sidecarPath)) {
      rmSync(sidecarPath);
      removed = true;
    }
    return removed;
  }

  /**
   * Write to a temp file in the SAME directory and rename over the destination.
   *
   * Two reasons, and both are about a reader that arrives mid-write:
   *
   *   1. `rename` within one filesystem is atomic, so a concurrent `get` sees
   *      either no object or a complete one — never the first 40 MB of a
   *      200 MB STEP file, which a three.js loader would report as a corrupt
   *      model rather than as a half-written one.
   *   2. The destination path only ever exists complete, so a crash cannot
   *      leave a truncated object that every later `put` of the same hash
   *      skips as "already stored".
   *
   * The temp name carries the pid and random bytes because two api requests for
   * the same file can be in flight at once, and one rename winning over a
   * partial temp from the other would resurrect it.
   */
  private writeAtomic(dest: string, contents: Uint8Array | string): void {
    const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, contents);
      renameSync(tmp, dest);
    } catch (err) {
      // Nothing else knows this temp file's name, so nothing else would ever
      // remove it; a directory of orphaned .tmp files is how a volume quietly
      // fills up. `force` because the write may have failed before creating it.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Already gone. The original error below is the one worth throwing.
      }
      throw err;
    }
  }
}
