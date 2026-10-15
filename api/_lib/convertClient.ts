// The api's client for convert-service (task 03a's service, task 03b's caller).
//
// One call: POST the CAD file as the raw request body, read the GLB back as a
// stream. The service is a function with an HTTP shape — see
// convert-service/README.md §2 — so there is nothing here but the three things a
// caller has to get right:
//
//   * WHERE it is, from CONVERT_SERVICE_URL, reduced to an origin for the reason
//     lib/ai/router.ts's builtinBaseUrl gives: a configured path would be glued
//     in front of `/convert` and 404, and a configured query string is exactly
//     where a token lands in an outbound request log.
//   * HOW it is addressed: `X-File-Name` names the upload and picks the reader,
//     `X-Convert-Token` carries the shared secret. Both strings are pinned by
//     convert-service's own tests, so they are a contract rather than a
//     convention — auth.py AUTH_HEADER, main.py FILE_NAME_HEADER.
//   * WHAT a failure is: one code from convert_service/errors.py, forwarded
//     verbatim because that vocabulary is ours and carries no content, or one of
//     the three codes below when the service never answered at all.
//
// SECURITY. The secret is read from this container's own environment and goes in
// exactly one header; it never reaches a browser, a response body or a log line.
// The uploaded FILENAME is client text, so it is sent (the reader needs the
// extension) and never logged — the same rule convert-service applies to it.
// Error bodies are parsed for a code and for nothing else, and only when they
// declare themselves JSON and are small, so a proxy's HTML 502 cannot arrive in
// an exception message.

import { Readable } from 'node:stream';

/** Where the service is. Unset or blank means this deployment has no server-side conversion. */
export const CONVERT_SERVICE_URL_ENV = 'CONVERT_SERVICE_URL';
/** The shared secret. Blank means the service has authentication off. */
export const CONVERT_SHARED_SECRET_ENV = 'CONVERT_SHARED_SECRET';

/** convert_service/auth.py AUTH_HEADER. */
export const CONVERT_AUTH_HEADER = 'X-Convert-Token';
/** convert_service/main.py FILE_NAME_HEADER. */
export const CONVERT_FILE_NAME_HEADER = 'X-File-Name';
/** The three counts convert-service answers with (main.py). Read for the log only. */
export const CONVERT_PART_COUNT_HEADER = 'X-Part-Count';
export const CONVERT_TRIANGLE_COUNT_HEADER = 'X-Triangle-Count';
export const CONVERT_MS_HEADER = 'X-Convert-Ms';

/** The path convert-service mounts its one route on. */
const CONVERT_PATH = '/convert';

/**
 * This side's deadline for one conversion, and deliberately NOT the service's.
 *
 * convert-service kills a job at CONVERT_TIMEOUT_S (900 by default) and answers
 * 504 `convert_timeout`; nginx's `proxy_read_timeout` for /api/models is also
 * 900s. With this set to the same 900, a timeout in the api log would have three
 * possible authors and three different fixes, and nothing in the log would say
 * which happened. Two minutes of headroom means an abort here is always ours, and
 * a 504 from the service is always its own — which is why the reason below is
 * CONVERT_CLIENT_TIMEOUT rather than the service's `convert_timeout`.
 *
 * Covers the whole exchange, sending 200 MB included, because AbortSignal has one
 * clock and an upload that stalls is as much a hung conversion as a tessellation
 * that does.
 */
export const CONVERT_REQUEST_TIMEOUT_MS = 780_000;

/** Reasons this module invents. Every other one is convert-service's own code. */
export const CONVERT_UNREACHABLE = 'convert_unreachable';
export const CONVERT_CLIENT_TIMEOUT = 'convert_client_timeout';
export const CONVERT_BAD_RESPONSE = 'convert_bad_response';
/** The catch-all, for a status whose body carried no usable code. */
export const CONVERT_ERROR = 'convert_error';

/**
 * A code from convert-service's failure taxonomy: lower-case words and
 * underscores, and nothing else.
 *
 * The service guarantees this shape, but the guarantee is on the other side of a
 * network and a reason ends up in a JSON body a browser renders. Bounded to 64
 * characters so a hostile or broken upstream cannot make this module echo an
 * arbitrary-length string back to a caller.
 */
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** How much of an error body is worth parsing before giving up on it. */
const MAX_ERROR_BODY_BYTES = 4096;

/** A resolved CONVERT_SERVICE_URL, and the secret to present with it. */
export interface ConvertTarget {
  /** Origin only — no path, no query. See the module header. */
  url: string;
  /** Empty string when CONVERT_SHARED_SECRET is unset: the service has auth off. */
  secret: string;
}

/**
 * A conversion that produced no GLB.
 *
 * `reason` is a code, never a message, because the api puts it in a response body
 * and a browser shows it. `message` is this repo's own prose about the failure —
 * provider, status, one of the three codes above — and is safe to log, but it is
 * still never sent anywhere.
 */
export class ConvertFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConvertFailure';
  }
}

/** The counts a conversion reported, for the one log line that says it worked. */
export interface ConvertedGlb {
  /** The GLB, as a node stream the caller can hand straight to a store. */
  body: Readable;
  partCount: number | null;
  triangleCount: number | null;
  convertMs: number | null;
}

export interface ConvertOptions {
  /** Injectable for tests; defaults to process.env at call time. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to CONVERT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * The service this deployment configured, or null when it configured none.
 *
 * Null is the DEFAULT and the common case: an install that never built the image,
 * and every Vercel deployment, has no CONVERT_SERVICE_URL and gets no
 * server-side conversion, with nothing else about the upload path changed. So an
 * address that will not parse is also null rather than a throw — a misconfigured
 * optional service should cost an operator one log line, not every CAD import.
 */
export function resolveConvertTarget(
  env: NodeJS.ProcessEnv = process.env,
): ConvertTarget | null {
  const configured = env[CONVERT_SERVICE_URL_ENV]?.trim() ?? '';
  if (configured === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    console.error(
      `[convert] ${CONVERT_SERVICE_URL_ENV} is not a valid URL; server-side conversion is off`,
    );
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `[convert] ${CONVERT_SERVICE_URL_ENV} must be an http or https URL; server-side conversion is off`,
    );
    return null;
  }
  return {
    url: parsed.origin,
    // Stripped, because a secret pasted into a compose file picks up a trailing
    // newline often enough that sending it verbatim would be a 401 on every
    // conversion. convert_service/auth.py strips its side the same way.
    secret: env[CONVERT_SHARED_SECRET_ENV]?.trim() ?? '',
  };
}

/** The headers one conversion request carries. Split out so a test can pin them. */
export function convertHeaders(target: ConvertTarget, fileName: string): Record<string, string> {
  const headers: Record<string, string> = {
    // The extension is what picks the reader, so the name has to travel even
    // though nothing here stores or echoes it.
    [CONVERT_FILE_NAME_HEADER]: headerSafeFileName(fileName),
  };
  // Omitted rather than sent empty when no secret is configured: an empty
  // X-Convert-Token is a header a proxy may drop, and a service with auth off
  // ignores it either way.
  if (target.secret !== '') headers[CONVERT_AUTH_HEADER] = target.secret;
  return headers;
}

/**
 * A file name that can travel in an HTTP header value.
 *
 * A header value is ISO-8859-1, and undici REFUSES one rather than approximating
 * it: `fetch` throws a TypeError on any character above U+00FF, before a byte is
 * sent. Without this, every conversion of a file named 支架.step or
 * "Assembly — Rev B.step" would fail with `convert_error` and an operator would be
 * left looking at a service that works. Characters that cannot be encoded become
 * underscores — the substitution api/_lib/models.ts's contentDisposition already
 * makes for the ASCII half of a stored name.
 *
 * What that costs is a label and nothing else. convert-service reads the EXTENSION
 * to pick a reader, and every extension it accepts is ASCII, so the reader is
 * always right; it reads the base name to name the glTF scene's root node, which
 * is the top row of a model tree. Per-part identity is positional — buildSceneTree
 * in utils/modelLoader.ts assigns `userData.nodeId` by walking the tree — so a
 * transliterated root name moves no pin, renames no part and hides nothing.
 */
export function headerSafeFileName(fileName: string): string {
  return fileName.replace(/[^\x20-\x7e\xa0-\xff]/g, '_');
}

/**
 * Tessellate one CAD file and answer with its GLB.
 *
 * The bytes go in the request body untouched — no multipart, no base64 — because
 * that is the shape convert-service reads and because wrapping 200 MB in a form
 * encoding would copy it for nothing. The GLB comes back as a STREAM rather than a
 * buffer: the caller writes it to storage as it arrives.
 *
 * Every way this can fail is a ConvertFailure carrying a code, so a caller can put
 * the reason in a response without first deciding whether the message is safe.
 */
export async function convertToGlb(
  target: ConvertTarget,
  bytes: Uint8Array,
  fileName: string,
  options: ConvertOptions = {},
): Promise<ConvertedGlb> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? CONVERT_REQUEST_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetchFn(`${target.url}${CONVERT_PATH}`, {
      method: 'POST',
      headers: convertHeaders(target, fileName),
      body: bytes,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Our own deadline first: undici wraps the abort in a `fetch failed` whose
    // `cause` is the TimeoutError, so the name has to be looked for one level down.
    if (isTimeoutAbort(err)) {
      throw new ConvertFailure(
        CONVERT_CLIENT_TIMEOUT,
        `convert-service did not answer within ${timeoutMs} ms`,
      );
    }
    // The message can carry a hostname or a socket error. Logged, not forwarded:
    // the caller gets a code.
    console.error('[convert] could not reach convert-service:', describe(err));
    throw new ConvertFailure(CONVERT_UNREACHABLE, 'convert-service could not be reached');
  }

  if (!res.ok) {
    const reason = await reasonFromResponse(res);
    console.error(`[convert] convert-service answered ${res.status} (${reason})`);
    throw new ConvertFailure(reason, `convert-service answered HTTP ${res.status}`);
  }
  if (!res.body) {
    // A 200 with no body is not something convert-service can produce; a proxy in
    // front of it can, and serving an empty GLB would be worse than failing.
    throw new ConvertFailure(CONVERT_BAD_RESPONSE, 'convert-service answered 200 with no body');
  }

  return {
    body: Readable.from(webStreamChunks(res.body)),
    partCount: headerCount(res, CONVERT_PART_COUNT_HEADER),
    triangleCount: headerCount(res, CONVERT_TRIANGLE_COUNT_HEADER),
    convertMs: headerCount(res, CONVERT_MS_HEADER),
  };
}

/**
 * The failure code an error response carried, or CONVERT_ERROR.
 *
 * Read defensively on purpose: this body comes from whatever CONVERT_SERVICE_URL
 * points at, which is normally convert-service and occasionally a proxy answering
 * for it. Only a small `application/json` body is parsed, and only its `error`
 * field is kept, and only when it looks like a code — so nothing an upstream put
 * in a body can reach a caller through this module.
 */
async function reasonFromResponse(res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return CONVERT_ERROR;
  let text: string;
  try {
    text = await res.text();
  } catch {
    return CONVERT_ERROR;
  }
  if (text.length > MAX_ERROR_BODY_BYTES) return CONVERT_ERROR;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed?.error === 'string' && ERROR_CODE_RE.test(parsed.error)
      ? parsed.error
      : CONVERT_ERROR;
  } catch {
    return CONVERT_ERROR;
  }
}

/** Whether an error is this side's deadline expiring, one level of wrapping down. */
function isTimeoutAbort(err: unknown): boolean {
  const candidate = err as { name?: unknown; cause?: { name?: unknown } } | null;
  return (
    candidate?.name === 'TimeoutError' ||
    (candidate?.cause as { name?: unknown } | undefined)?.name === 'TimeoutError'
  );
}

/** One of the count headers as a number, or null when it is absent or not one. */
function headerCount(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Bounded, and one level of `cause` deep, because this is a value this module did
 * not construct.
 *
 * The cause is the useful half: undici reports every socket failure as a bare
 * "fetch failed" and puts the actual reason — DNS, connection refused, a TLS
 * handshake — in the error it wraps, and an operator told only
 * `convert_unreachable` cannot tell a stopped container from a wrong hostname.
 * Bounded because a socket error can quote a URL, and this module reduces
 * CONVERT_SERVICE_URL to an origin before it is ever fetched, so what a cause can
 * carry here is a host and a port.
 */
function describe(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  const detailed =
    cause instanceof Error ? `${text} (${cause.name}: ${cause.message})` : text;
  return detailed.length > 300 ? `${detailed.slice(0, 300)}…` : detailed;
}

/**
 * A web ReadableStream as the async iterable `Readable.from` wants.
 *
 * Written out rather than cast, for the reason lib/storage/supabaseModelStore.ts
 * gives for the same helper there: `Readable.fromWeb` takes node:stream/web's
 * ReadableStream and a `fetch` Response carries the DOM-lib one. Reading it
 * ourselves also keeps the conversion honest about backpressure, since
 * `Readable.from` pulls.
 */
async function* webStreamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
