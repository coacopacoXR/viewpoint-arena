// The name and the place of a DERIVED object: a file this app computed from a
// stored one, addressed by the SOURCE's hash rather than by its own.
//
// Both providers agree on the layout, the way sidecar.ts makes them agree on
// `<hash>.json` beside `<hash>`:
//
//     local      <dir>/derived/<sourceHash>.glb
//     supabase   derived/<sourceHash>.glb   (same bucket)
//
// Under a `derived/` prefix rather than beside the objects for two reasons. It
// keeps `list()` honest without it having to know what a derivative looks
// like — a listing walks sidecars, and there is no sidecar in here. And it means
// the ONE directory that decides a path is still a value MODEL_HASH_RE accepted:
// the prefix is a constant, so nothing a caller supplied reaches a filesystem
// path except the hash.
//
// Split out from modelStore.ts for the reason hash.ts and sidecar.ts were: the
// two implementations import it, and importing modelStore.ts back at runtime
// would be a cycle.

import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DerivedKind } from './modelStore.ts';

/** The subdirectory (and bucket prefix) every derivative lives under. */
export const DERIVED_DIR = 'derived';

/** Every derivative a store can hold. Adding one means adding a suffix here. */
export const DERIVED_KINDS: readonly DerivedKind[] = ['glb'];

/** Extension a derivative is stored under, per kind. */
export const DERIVED_SUFFIX: Record<DerivedKind, string> = { glb: '.glb' };

/**
 * The Content-Type a derivative is served with, per kind.
 *
 * `model/gltf-binary` is what utils/modelFormats.ts says a `.glb` is and what
 * convert-service answers with (convert_service/gltf.py GLB_CONTENT_TYPE), so
 * the bytes a browser fetches are described the same way whichever side made
 * them.
 */
export const DERIVED_CONTENT_TYPE: Record<DerivedKind, string> = {
  glb: 'model/gltf-binary',
};

/** The object's name inside DERIVED_DIR: `<sourceHash>.glb`. */
export function derivedName(sourceHash: string, kind: DerivedKind): string {
  return `${sourceHash}${DERIVED_SUFFIX[kind]}`;
}

/** The local store's filesystem path for a derivative. */
export function derivedFilePath(dir: string, sourceHash: string, kind: DerivedKind): string {
  return join(dir, DERIVED_DIR, derivedName(sourceHash, kind));
}

/**
 * The supabase store's object key for a derivative.
 *
 * Forward slashes on every platform, because a Storage key is a URL path and not
 * a filesystem path: `join` would hand Windows separators to a bucket that has
 * no idea what to do with them, and the object would be stored under a name
 * nothing could read back.
 */
export function derivedKey(sourceHash: string, kind: DerivedKind): string {
  return `${DERIVED_DIR}/${derivedName(sourceHash, kind)}`;
}

/**
 * Whether `putDerived` was handed a stream rather than bytes.
 *
 * Duck-typed on `pipe` rather than checked with `instanceof Uint8Array`: the
 * positive test is the one that decides how the value is written, and a Buffer,
 * a plain Uint8Array and a subclass of either all fail `pipe` the same way.
 */
export function isReadableStream(value: Uint8Array | Readable): value is Readable {
  return typeof (value as Readable).pipe === 'function';
}

/**
 * A stream as one buffer, for a provider whose upload takes a single body.
 *
 * Only derivatives go through here, and only on that provider: Supabase Storage's
 * REST upload is one request with the object in it, so there is nothing to stream
 * into. What it holds is the compressed output of a conversion — hundreds of
 * kilobytes for an assembly whose STEP file is megabytes — not the source.
 */
export async function bufferStream(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
