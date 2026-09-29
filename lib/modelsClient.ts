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
// The upload uses XMLHttpRequest rather than fetch because upload progress is
// the one thing fetch still cannot report, and a 200 MB CAD import with no
// progress bar looks like a hang. The download uses fetch, because that is the
// direction where the browser's own HTTP cache does the work: the response is
// `public, max-age=31536000, immutable`, so a second ask for the same hash
// never reaches the network at all.

import { INVALID_FILE_TYPE_MESSAGE, modelFileMime } from '../utils/modelFormats';

/** Where both directions go. Same-origin, so the front-door cookie rides along. */
export const MODELS_ENDPOINT = '/api/models';

export function modelDownloadUrl(hash: string): string {
  return `${MODELS_ENDPOINT}/${hash}`;
}

/** What POST /api/models answers with. */
export interface ModelUploadResult {
  hash: string;
  size: number;
  fileName: string;
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
  if (status === 413) return 'File too large to share with the room (maximum 200MB).';
  if (status === 415) return INVALID_FILE_TYPE_MESSAGE;
  if (status === 401 || status === 403) return MODEL_LOCKED_MESSAGE;
  if (status === 503) return MODEL_STORAGE_UNAVAILABLE_MESSAGE;
  return MODEL_UPLOAD_NETWORK_MESSAGE;
}

/**
 * Read a failure's `error` code without assuming the body is JSON.
 *
 * A half-configured proxy or an SPA fallback answers an /api path with 200 and
 * HTML — see lib/connectors/capture/extract.ts, which had to learn the same
 * thing. A bare `response.json()` there throws a SyntaxError that says nothing
 * about what actually went wrong.
 */
async function readErrorCode(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as Record<string, unknown>).error;
      if (typeof code === 'string') return code;
    }
  } catch {
    // Not JSON: an HTML error page from something in front of the api.
  }
  return null;
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
      resolveUpload({ hash: body.hash, size: body.size, fileName: file.name });
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
 */
const MAX_CACHED_MODELS = 3;

/** hash → the in-flight or finished download. Oldest first, for eviction. */
const modelFileCache = new Map<string, Promise<File>>();

/** Drop everything cached. Called on a room change and by tests. */
export function clearModelFileCache(): void {
  modelFileCache.clear();
}

/** How many models are held in memory. Tests, and nothing else. */
export function modelFileCacheSize(): number {
  return modelFileCache.size;
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
  const cached = modelFileCache.get(hash);
  if (cached) {
    // Re-insert so the map's order stays oldest-first, which is what the
    // eviction below relies on.
    modelFileCache.delete(hash);
    modelFileCache.set(hash, cached);
    return cached;
  }

  // Cached as the promise, not as its result: the room server replays the
  // current model to a new connection at the same moment a live MODEL_CHANGE
  // can arrive, and two downloads of the same 200 MB file for one room is the
  // exact waste this exists to prevent.
  const pending = download(hash, fileName);
  modelFileCache.set(hash, pending);
  // A failure must not be cached, or the model would stay broken for the rest
  // of the session even after the server came back.
  pending.catch(() => {
    if (modelFileCache.get(hash) === pending) modelFileCache.delete(hash);
  });

  while (modelFileCache.size > MAX_CACHED_MODELS) {
    const oldest = modelFileCache.keys().next();
    if (oldest.done) break;
    modelFileCache.delete(oldest.value);
  }

  return pending;
}

async function download(hash: string, fileName: string): Promise<File> {
  let response: Response;
  try {
    response = await fetch(modelDownloadUrl(hash));
  } catch {
    throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
  }
  if (!response.ok) {
    // The code is read for the log; the message a person sees is the same one
    // either way, because "404" and "the file is gone from the server" are the
    // same fact and only the second one is actionable.
    const code = await readErrorCode(response);
    console.error(`[modelsClient] download of ${hash} failed: ${response.status} ${code ?? ''}`);
    throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
  }
  const blob = await response.blob();
  // An HTML body with a 200 is the SPA fallback answering an /api path, which
  // is what `vite preview` does for every route and what a proxy that lost the
  // /api location does too. Handing that to parseModelFile would produce a
  // three.js error about a corrupt glTF, which sends whoever is debugging it
  // looking at the model instead of at the deployment.
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    console.error(`[modelsClient] /api/models answered with HTML for ${hash}`);
    throw new Error(MODEL_DOWNLOAD_FAILED_MESSAGE);
  }
  // The name comes from the reference that was broadcast, not from
  // Content-Disposition: parseModelFile dispatches on the extension, and the
  // sender is the one who knows what they called it.
  return new File([blob], fileName, { type: modelFileMime(fileName) });
}
