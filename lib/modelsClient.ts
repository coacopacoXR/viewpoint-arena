// The browser's end of /api/models.
//
// Two directions, and both trade bytes for a hash:
//
//   * `uploadModelFile` posts the ORIGINAL bytes of the file the user picked
//     and comes back with its SHA-256. That hash is what goes on the room
//     socket and into a curated review — never the bytes, which is what the
//     50 MB sharing cap used to be working around.
//   * `fetchModelFile` turns a hash someone else sent back into a File the
//     existing loaders can parse, so a late joiner and a person who was there
//     from the first minute render byte-identical geometry.
//
// A third is the same download for a DIFFERENT ENCODING of the same file:
// `fetchDerivedModelFile` collects the GLB convert-service tessellated from a
// stored CAD file, and `probeDerivedGlb` is the poll the importer waits on while
// that happens. Both are addressed by the source's hash, because the source hash
// is the only identity that travels — see ModelRepresentation in
// lib/scene/roomScene.ts for why which of the two a room loads is the importer's
// decision and not each client's.
//
// The upload uses XMLHttpRequest rather than fetch because upload progress is
// the one thing fetch still cannot report, and a 200 MB CAD import with no
// progress bar looks like a hang. The download uses fetch, because that is the
// direction where the browser's own HTTP cache does the work: the response is
// `public, max-age=31536000, immutable`, so a second ask for the same hash
// never reaches the network at all.

import { INVALID_FILE_TYPE_MESSAGE, MAX_MODEL_FILE_BYTES, modelFileMime } from '../utils/modelFormats';

/** Where both directions go. Same-origin, so the front-door cookie rides along. */
export const MODELS_ENDPOINT = '/api/models';

export function modelDownloadUrl(hash: string): string {
  return `${MODELS_ENDPOINT}/${hash}`;
}

/**
 * Where the GLB convert-service tessellated from a stored CAD file is served.
 *
 * Named by the SOURCE's hash rather than by one of its own: a derivative has no
 * identity of its worth keeping, and the source hash is the address that already
 * travels on the room socket and in a curated review. See
 * api/models/[hash]/derived/glb.ts.
 */
export function derivedModelDownloadUrl(hash: string): string {
  return `${MODELS_ENDPOINT}/${hash}/derived/glb`;
}

/**
 * The name a derivative is handed to the loaders under.
 *
 * Not cosmetic. utils/modelLoader.ts dispatches on the EXTENSION, so a GLB
 * arriving as `bracket.step` would be fed to OpenCascade in a Web Worker and
 * fail on bytes that are already triangles. It also decides the up-axis:
 * `.step` is Z-up and gets tipped −90° about X, while the derivative came out
 * of gltfpack Y-up and must not be. Renaming is therefore what makes "parse it
 * with the existing glTF path" true.
 *
 * The base name is kept, so the tree's root row reads the same whichever
 * encoding was loaded and `lineFromFileName` still names the line after the
 * file the user actually picked.
 */
export function derivedGlbFileName(fileName: string): string {
  const base = fileName.replace(/\.[^/.]+$/, '');
  return `${base === '' ? fileName : base}.glb`;
}

/** What POST /api/models answers with. */
export interface ModelUploadResult {
  hash: string;
  size: number;
  fileName: string;
  /**
   * What the server said about converting this file, and the whole of the
   * importer's decision about which representation the room will load:
   * 'pending' means a conversion has started and is worth waiting for,
   * 'unavailable' means there never will be one — no convert-service
   * configured (the default), or a mesh that needs no tessellation — so the
   * browser's own reader is the only path.
   *
   * Optional and defaulted: an api that has not been updated answers without
   * it, and "no derivative" is the only thing such an api can mean.
   */
  derived?: 'pending' | 'unavailable';
}

// ─── Messages ───────────────────────────────────────────────────────────────
//
// Written out rather than built from a status code, because these land in the
// import status area of the model tree where a person reads them. A code like
// `storage_unavailable` is what the api says; this is what it means.

export const MODEL_UPLOAD_NETWORK_MESSAGE =
  'Could not reach the server to store this model, so other participants would not be able to see it. Check the connection and import it again.';

export const MODEL_STORAGE_UNAVAILABLE_MESSAGE =
  'Model storage is not available on this server, so the file cannot be shared with the room. An administrator has to configure it.';

export const MODEL_LOCKED_MESSAGE =
  'This deployment is password-protected and this session is not through the door yet. Unlock it and import the model again.';

export const MODEL_DOWNLOAD_FAILED_MESSAGE =
  'Could not download the model the room is looking at. It may have been removed from the server; ask whoever imported it to do so again.';

/**
 * The status a failed upload came back with, as something worth showing.
 *
 * Unknown codes fall through to the network message: the api only ever answers
 * with short machine codes, and repeating one of those to a person who just
 * wanted to look at a bracket is not an explanation.
 */
export function describeUploadFailure(status: number): string {
  // 413 is the api's MAX_MODEL_UPLOAD_BYTES saying no, which is the same ceiling
  // the picker enforces — read from the shared constant so the two cannot drift
  // and leave this message promising a size the server refuses.
  if (status === 413) {
    return `File too large to share with the room (maximum ${MAX_MODEL_FILE_BYTES / (1024 * 1024)}MB).`;
  }
  if (status === 415) return INVALID_FILE_TYPE_MESSAGE;
  if (status === 401 || status === 403) return MODEL_LOCKED_MESSAGE;
  if (status === 503) return MODEL_STORAGE_UNAVAILABLE_MESSAGE;
  return MODEL_UPLOAD_NETWORK_MESSAGE;
}

/**
 * Read a response body as one of our JSON objects, or null when it is not one.
 *
 * A half-configured proxy or an SPA fallback answers an /api path with 200 and
 * HTML — see lib/connectors/capture/extract.ts, which had to learn the same
 * thing. A bare `response.json()` there throws a SyntaxError that says nothing
 * about what actually went wrong.
 */
async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON: an HTML error page from something in front of the api.
  }
  return null;
}

/** A failure's `error` code, for the log. Null when the body did not carry one. */
async function readErrorCode(response: Response): Promise<string | null> {
  const code = (await readJsonBody(response))?.error;
  return typeof code === 'string' ? code : null;
}

// ─── Upload ─────────────────────────────────────────────────────────────────

/**
 * Store `file` on the server and return its content address.
 *
 * `onProgress` is called with a fraction between 0 and 1 as the body goes out,
 * and never after the request settles. Rejects with an Error whose message is
 * already fit to show the user — the caller has nothing to translate.
 */
export function uploadModelFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<ModelUploadResult> {
  return new Promise((resolveUpload, rejectUpload) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', MODELS_ENDPOINT);
    xhr.responseType = 'json';
    // Percent-encoded on the way out and decoded by the handler: an HTTP header
    // value is ISO-8859-1, and a part number with an umlaut or a CJK character
    // would otherwise arrive as mojibake and be served back that way for ever,
    // since the name is stored in the object's sidecar.
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));

    xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
      if (event.lengthComputable && onProgress && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        rejectUpload(new Error(describeUploadFailure(xhr.status)));
        return;
      }
      const body = xhr.response as Partial<ModelUploadResult> | null;
      // A 200 that is not our JSON is the SPA fallback answering an /api path,
      // which happens under `vite preview` and behind a misconfigured proxy.
      // Saying "the server answered with something we could not read" beats
      // handing the caller an undefined hash to broadcast to the room.
      if (!body || typeof body.hash !== 'string' || typeof body.size !== 'number') {
        rejectUpload(new Error(MODEL_UPLOAD_NETWORK_MESSAGE));
        return;
      }
      onProgress?.(1);
      // `derived` is passed through only when the api said 'pending': that is the
      // one answer that asks the importer to wait, and every other value —
      // 'unavailable', or nothing at all from an api that has not been updated —
      // means "tessellate it yourself", which is what an absent field already
      // means to the caller.
      resolveUpload({
        hash: body.hash,
        size: body.size,
        fileName: file.name,
        derived: body.derived === 'pending' ? 'pending' : 'unavailable',
      });
    });

    // 'error' is a network-level failure; 'timeout' cannot happen (no timeout is
    // set) but a 200 MB upload on a slow link is exactly the case where a
    // caller would want to distinguish them, so both say the same useful thing.
    xhr.addEventListener('error', () => rejectUpload(new Error(MODEL_UPLOAD_NETWORK_MESSAGE)));
    xhr.addEventListener('abort', () => rejectUpload(new Error(MODEL_UPLOAD_NETWORK_MESSAGE)));

    xhr.send(file);
  });
}

// ─── Download ───────────────────────────────────────────────────────────────

/**
 * How many downloaded models are kept in memory.
 *
 * Small on purpose: a model file can be 200 MB, and a File holds its bytes, so
 * this bound is a memory bound rather than a count. Three covers the case the
 * cache exists for — switching back to the revision that was on screen a moment
 * ago — and the HTTP cache, which the immutable response header unlocks, covers
 * everything beyond it at the cost of a cache lookup instead of a download.
 *
 * A source file and its derivative are two entries against this one bound, which
 * is right rather than generous: they are two sets of bytes, and a room that
 * switched a model from one to the other is exactly the case where holding both
 * costs memory for nothing.
 */
const MAX_CACHED_MODELS = 3;

/**
 * cache key → the in-flight or finished download. Oldest first, for eviction.
 *
 * Keyed by the source hash for the file that was uploaded, and by
 * `derivedCacheKey` for the GLB converted from it. A model hash is 64 hex
 * characters, so a key holding a colon cannot be one — the two can never
 * collide, and asking for one never answers with the other's bytes.
 */
const modelFileCache = new Map<string, Promise<File>>();

/** The key a source file's derivative is cached under. */
const DERIVED_KEY_SUFFIX = ':derived-glb';

function derivedCacheKey(hash: string): string {
  return `${hash}${DERIVED_KEY_SUFFIX}`;
}

/** Drop everything cached. Called on a room change and by tests. */
export function clearModelFileCache(): void {
  modelFileCache.clear();
}

/** How many models are held in memory. Tests, and nothing else. */
export function modelFileCacheSize(): number {
  return modelFileCache.size;
}

/**
 * One cache entry, shared by the source download and the derivative's.
 *
 * Cached as the PROMISE, not as its result: the room server replays the current
 * model to a new connection at the same moment a live MODEL_CHANGE can arrive,
 * and two downloads of the same 200 MB file for one room is the exact waste this
 * exists to prevent.
 */
function cachedFile(key: string, produce: () => Promise<File>): Promise<File> {
  const cached = modelFileCache.get(key);
  if (cached) {
    // Re-insert so the map's order stays oldest-first, which is what the
    // eviction below relies on.
    modelFileCache.delete(key);
    modelFileCache.set(key, cached);
    return cached;
  }

  const pending = produce();
  modelFileCache.set(key, pending);
  // A failure must not be cached, or the model would stay broken for the rest
  // of the session even after the server came back.
  pending.catch(() => {
    if (modelFileCache.get(key) === pending) modelFileCache.delete(key);
  });

  while (modelFileCache.size > MAX_CACHED_MODELS) {
    const oldest = modelFileCache.keys().next();
    if (oldest.done) break;
    modelFileCache.delete(oldest.value);
  }

  return pending;
}

/**
 * The File for a hash somebody else sent, parsed by nothing — the caller hands
 * it to utils/modelLoader.ts exactly as it would a file the user picked.
 *
 * The PARSED model is deliberately not what gets cached. parseModelFile returns
 * a three.js Group that the caller attaches to a scene graph, and an Object3D
 * has one parent: sharing a parsed model between the main view and the split
 * view, or between two MODEL_CHANGE messages that resolve out of order, would
 * have one of them silently move or dispose what the other is rendering. The
 * bytes are safe to share; the scene graph is not.
 */
export async function fetchModelFile(hash: string, fileName: string): Promise<File> {
  return cachedFile(hash, () => download(modelDownloadUrl(hash), fileName));
}

/**
 * The GLB convert-service tessellated from the file `hash` names.
 *
 * The other half of `fetchModelFile`, for a reference that says
 * `representation: 'derived-glb'` — and it has to be the SAME half the importer
 * used, down to the bytes, because the two trees OpenCascade can produce from
 * one source file have different node ids and a pin names a node id. Same
 * cache, same eviction, same HTML guard; only the URL and the name differ.
 *
 * The name is derivedGlbFileName's, not the caller's: the caller knows the
 * source as `bracket.step`, and handing that to parseModelFile would send GLB
 * bytes to the CAD reader.
 */
export async function fetchDerivedModelFile(hash: string, fileName: string): Promise<File> {
  return cachedFile(derivedCacheKey(hash), () => receiveDerived(hash, fileName));
}

/**
 * A receiver's download of the derivative, waiting out a 202.
 *
 * The importer only broadcasts 'derived-glb' once the GLB exists, but the api
 * keeps its jobs in memory and starts a fresh conversion when asked for a
 * derivative it no longer has, so a late joiner can be answered "pending" for a
 * file the room is already looking at. Reading that 202's JSON as a GLB would
 * end in a corrupt-glTF error; falling back to the source would give this client
 * a different tree from everyone else. So it waits, as the importer did, and
 * only a conversion that failed or a route that will never have one is an error.
 */
async function receiveDerived(hash: string, fileName: string): Promise<File> {
  let wait = DERIVED_RECEIVE_FIRST_POLL_MS;
  for (;;) {
    const probe = await probeDerivedGlb(hash, fileName);
    if (probe.status === 'ready') return probe.file;
    if (probe.status !== 'pending') throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 1.5, DERIVED_RECEIVE_MAX_POLL_MS);
  }
}

const DERIVED_RECEIVE_FIRST_POLL_MS = 2_000;
const DERIVED_RECEIVE_MAX_POLL_MS = 5_000;

/** What one ask for a source file's derived GLB came back with. */
export type DerivedGlbProbe =
  /** The derivative is stored, and here it is. */
  | { status: 'ready'; file: File }
  /** A conversion is running. Ask again. */
  | { status: 'pending' }
  /** A conversion ran and produced nothing. `reason` is the api's code, or null. */
  | { status: 'failed'; reason: string | null }
  /** There never will be one. Tessellate in the browser instead. */
  | { status: 'unavailable' };

/**
 * One poll of the derived GLB, as the importer's wait loop asks it.
 *
 * A GET rather than a HEAD, and that is the whole design: every poll before the
 * derivative exists answers 202 with a few bytes of JSON, and the ONE poll that
 * finds it ready downloads the GLB — which is the bytes the caller wanted
 * anyway. A HEAD probe would have cost a second transfer of the same file, and
 * could not have read a failure's `reason` because a HEAD has no body.
 *
 * Never throws. Every answer that is not 'pending' is an instruction to fall
 * back, and the importer is holding the source file, so there is always a model
 * to be had: a network blip, a locked deployment, a source that has gone and an
 * api that answered with HTML all read as 'unavailable' rather than as an
 * exception the caller has to catch. 'failed' is kept apart from those only so
 * the log can say which it was.
 */
export async function probeDerivedGlb(hash: string, fileName: string): Promise<DerivedGlbProbe> {
  const url = derivedModelDownloadUrl(hash);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return { status: 'unavailable' };
  }

  if (response.status === 202) return { status: 'pending' };

  if (!response.ok) {
    const body = await readJsonBody(response);
    // The route's own vocabulary: `{ status: 'failed', reason }` and
    // `{ status: 'unavailable' }`. Anything else — `{ error: 'not_found' }` for
    // a source nobody stored, a 401 from the gate, a 503 from storage — is a
    // fact about the deployment rather than about the conversion, and means the
    // same thing to the caller: there is no derivative to wait for.
    const status = body?.status;
    if (status === 'failed') {
      const reason = body?.reason;
      console.error(`[modelsClient] conversion of ${hash} failed: ${typeof reason === 'string' ? reason : '?'}`);
      return { status: 'failed', reason: typeof reason === 'string' ? reason : null };
    }
    console.error(`[modelsClient] no derivative for ${hash}: ${response.status} ${String(status ?? body?.error ?? '')}`);
    return { status: 'unavailable' };
  }

  // The same guard download() keeps, for the same reason: `vite preview` and a
  // proxy that lost its /api location both answer 200 with index.html, and a
  // three.js error about a corrupt glTF would send whoever is debugging it
  // looking at the model instead of at the deployment.
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    console.error(`[modelsClient] ${url} answered with HTML`);
    return { status: 'unavailable' };
  }

  const blob = await response.blob();
  const glbName = derivedGlbFileName(fileName);
  return { status: 'ready', file: new File([blob], glbName, { type: modelFileMime(glbName) }) };
}

async function download(url: string, fileName: string): Promise<File> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
  }
  if (!response.ok) {
    // The code is read for the log; the message a person sees is the same one
    // either way, because "404" and "the file is gone from the server" are the
    // same fact and only the second one is actionable.
    const code = await readErrorCode(response);
    console.error(`[modelsClient] download of ${url} failed: ${response.status} ${code ?? ''}`);
    throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
  }
  const blob = await response.blob();
  // An HTML body with a 200 is the SPA fallback answering an /api path, which
  // is what `vite preview` does for every route and what a proxy that lost the
  // /api location does too. Handing that to parseModelFile would produce a
  // three.js error about a corrupt glTF, which sends whoever is debugging it
  // looking at the model instead of at the deployment.
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    console.error(`[modelsClient] ${url} answered with HTML`);
    throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
  }
  // The name comes from the reference that was broadcast, not from
  // Content-Disposition: parseModelFile dispatches on the extension, and the
  // sender is the one who knows what they called it.
  return new File([blob], fileName, { type: modelFileMime(fileName) });
}
