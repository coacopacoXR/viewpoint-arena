// Runs the api/*.ts Vercel functions outside Vercel.
//
// The handlers are written against @vercel/node's request/response helpers
// (req.query, req.body, res.status().json(), res.redirect()). Vercel supplies
// those; plain Node does not. This module supplies exactly the subset the
// handlers in this repo use, so the SAME files serve three runtimes:
//
//   - Vercel (unchanged, this module is not involved),
//   - the self-hosted `api` container (server/api-server.ts),
//   - `npm run dev` (the Vite plugin in vite.config.ts).
//
// Routing mirrors Vercel's filesystem routing: /api/onshape/me -> api/onshape/me.ts.
// Files and folders starting with `_` are private helpers on Vercel and are
// never routable here either.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Vercel's default body limit for parsed bodies. */
const MAX_PARSED_BODY_BYTES = 4.5 * 1024 * 1024;

/** One path segment of a routable handler: lowercase words and dashes only. */
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A Vercel dynamic-route file: `[param].ts`.
 *
 * The only routing this app needs beyond literal paths is `/api/models/<hash>`,
 * where the last segment is a SHA-256 the filesystem has no file for. Vercel
 * matches that with a sibling named `[hash].ts`; the shim has to match it the
 * same way or the route works in one deployment shape and 404s in the other.
 */
const DYNAMIC_FILE_RE = /^\[([A-Za-z_][A-Za-z0-9_]*)\]\.ts$/;

type Handler = (req: unknown, res: unknown) => unknown;

interface HandlerModule {
  default?: unknown;
  handler?: unknown;
  config?: { api?: { bodyParser?: boolean } };
}

export interface ApiShimOptions {
  /** Absolute path of the api/ directory. */
  apiDir: string;
  /** How to import a handler file (tsx's import in Node, ssrLoadModule in Vite). */
  importModule: (absPath: string) => Promise<HandlerModule>;
  /** Where errors are reported. Defaults to console.error. */
  log?: (...args: unknown[]) => void;
}

export type ShimRequest = IncomingMessage & {
  query: Record<string, string | string[]>;
  body: unknown;
  cookies: Record<string, string>;
};

export type ShimResponse = ServerResponse & {
  status: (code: number) => ShimResponse;
  json: (body: unknown) => ShimResponse;
  send: (body: unknown) => ShimResponse;
  redirect: (statusOrUrl: number | string, url?: string) => ShimResponse;
};

/** A handler file plus the path parameters its `[name].ts` segments captured. */
export interface ResolvedRoute {
  file: string;
  params: Record<string, string>;
}

/**
 * The route for a URL path, or null when the path is not routable.
 *
 * Never resolves outside apiDir: every segment must match SEGMENT_RE, which
 * excludes `..`, `_private`, dots, percent signs and encoded separators — so
 * the segments are safe to hand to `resolve` before any filesystem check, and
 * a path parameter can never carry a separator into a filename.
 *
 * A file named for the exact path wins over a `[param].ts` sibling, which is
 * Vercel's own precedence and what lets `api/models.ts` answer POST /api/models
 * while `api/models/[hash].ts` answers GET /api/models/<hash>.
 */
export function resolveRoute(apiDir: string, pathname: string): ResolvedRoute | null {
  if (!pathname.startsWith('/api/')) return null;
  const segments = pathname.slice('/api/'.length).split('/');
  if (segments.length === 0 || !segments.every((s) => SEGMENT_RE.test(s))) return null;
  const root = resolve(apiDir);

  const literal = resolve(root, ...segments) + '.ts';
  if (literal.startsWith(root + sep) && existsSync(literal)) {
    return { file: literal, params: {} };
  }

  // The trailing segment may be a path parameter. Only the last one, and only
  // one level deep: that is all this app routes on, and supporting Vercel's
  // full grammar (optional, catch-all, nested dynamics) here would be code
  // nothing calls.
  const parent = segments.length > 1 ? resolve(root, ...segments.slice(0, -1)) : root;
  if (!parent.startsWith(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    // No such directory (or it is a file, not a directory): nothing to match.
    return null;
  }
  const value = segments[segments.length - 1];
  // Sorted so two dynamic siblings in one folder resolve the same way every
  // time rather than in whatever order the filesystem lists them.
  for (const entry of entries.sort()) {
    const match = DYNAMIC_FILE_RE.exec(entry);
    if (!match) continue;
    return { file: resolve(parent, entry), params: { [match[1]]: value } };
  }
  return null;
}

/**
 * The handler file for a URL path, or null when the path is not a routable
 * handler. The path parameters are dropped — use resolveRoute when they matter.
 */
export function resolveHandlerPath(apiDir: string, pathname: string): string | null {
  return resolveRoute(apiDir, pathname)?.file ?? null;
}

export function parseQuery(search: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  return cookies;
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering but keep draining, so the 413 can actually be sent;
        // destroying the socket here would leave the client with a bare reset.
        chunks.length = 0;
        rejectBody(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

/** Parses a body the way Vercel does: JSON, urlencoded, text, else a Buffer. */
export function parseBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    return JSON.parse(raw.toString('utf8')) as unknown;
  }
  if (type === 'application/x-www-form-urlencoded') {
    return parseQuery(new URLSearchParams(raw.toString('utf8')));
  }
  if (type.startsWith('text/')) return raw.toString('utf8');
  return raw;
}

function decorateResponse(res: ServerResponse): ShimResponse {
  const r = res as ShimResponse;
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.json = (body: unknown) => {
    if (!r.getHeader('Content-Type')) {
      r.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    r.end(JSON.stringify(body));
    return r;
  };
  r.send = (body: unknown) => {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      if (!r.getHeader('Content-Type')) r.setHeader('Content-Type', 'application/octet-stream');
      r.end(body);
    } else if (typeof body === 'object' && body !== null) {
      r.json(body);
    } else {
      if (!r.getHeader('Content-Type')) r.setHeader('Content-Type', 'text/html; charset=utf-8');
      r.end(body === undefined ? '' : String(body));
    }
    return r;
  };
  r.redirect = (statusOrUrl: number | string, url?: string) => {
    const code = typeof statusOrUrl === 'number' ? statusOrUrl : 307;
    const location = typeof statusOrUrl === 'string' ? statusOrUrl : (url ?? '/');
    r.statusCode = code;
    r.setHeader('Location', location);
    r.end();
    return r;
  };
  return r;
}

function sendError(res: ServerResponse, code: number, error: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // An oversized upload may still be arriving; close once this is sent.
  if (code === 413) res.setHeader('Connection', 'close');
  res.end(JSON.stringify({ error }));
}

/**
 * Returns a request handler. It answers every /api/* request (404 JSON for an
 * unknown route, never the SPA) and returns false for anything else so the
 * caller can pass it on.
 */
export function createApiShim(options: ApiShimOptions) {
  const log = options.log ?? ((...args: unknown[]) => console.error(...args));

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return false;

    const route = resolveRoute(options.apiDir, url.pathname);
    if (!route) {
      sendError(res, 404, 'not_found');
      return true;
    }
    const file = route.file;

    let mod: HandlerModule;
    try {
      mod = await options.importModule(file);
    } catch (err) {
      log(`[api] failed to load ${url.pathname}:`, err);
      sendError(res, 500, 'internal_error');
      return true;
    }
    const fn = (typeof mod.default === 'function' ? mod.default : mod.handler) as
      | Handler
      | undefined;
    if (typeof fn !== 'function') {
      log(`[api] ${url.pathname} exports no handler`);
      sendError(res, 500, 'internal_error');
      return true;
    }

    const shimReq = req as ShimRequest;
    // Path parameters last, so `/api/models/<hash>?hash=something-else` serves
    // what the PATH named. Vercel puts both in req.query and leaves a collision
    // undefined; the path is the part the router already matched on, so it is
    // the one worth believing.
    shimReq.query = { ...parseQuery(url.searchParams), ...route.params };
    shimReq.cookies = parseCookieHeader(req.headers.cookie);
    shimReq.body = undefined;

    // bodyParser: false means the handler reads the raw stream itself
    // (api/capture/local.ts forwards a 200 MB multipart upload untouched).
    const parse = mod.config?.api?.bodyParser !== false;
    if (parse && req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        const raw = await readBody(req, MAX_PARSED_BODY_BYTES);
        shimReq.body = parseBody(raw, req.headers['content-type']);
      } catch (err) {
        if (err instanceof BodyTooLargeError) sendError(res, 413, 'body_too_large');
        else sendError(res, 400, 'invalid_body');
        return true;
      }
    }

    const shimRes = decorateResponse(res);
    try {
      await fn(shimReq, shimRes);
    } catch (err) {
      // The message can name env vars or upstream detail; it goes to the log,
      // never to the caller.
      log(`[api] ${req.method} ${url.pathname} threw:`, err);
      sendError(res, 500, 'internal_error');
      return true;
    }
    if (!res.writableEnded && !res.headersSent) {
      // A handler that returned without answering would otherwise hang.
      log(`[api] ${req.method} ${url.pathname} returned without a response`);
      sendError(res, 500, 'internal_error');
    }
    return true;
  };
}

/** The repo's api/ directory relative to a project root. */
export function apiDirFor(root: string): string {
  return join(root, 'api');
}
