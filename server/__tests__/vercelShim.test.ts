// @vitest-environment node
//
// The shim is what runs api/*.ts outside Vercel (self-hosted `api` container
// and `npm run dev`). These tests drive it over a real HTTP server, since the
// behaviour that matters — routing, body parsing, streaming, error hiding — is
// all at the HTTP layer.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  createApiShim,
  parseBody,
  parseCookieHeader,
  parseQuery,
  resolveHandlerPath,
  resolveRoute,
  type ShimRequest,
  type ShimResponse,
} from '../vercelShim.ts';

type Mod = {
  default?: (req: ShimRequest, res: ShimResponse) => unknown;
  config?: { api?: { bodyParser?: boolean } };
};

// Handlers are plain objects keyed by file; the filesystem only has to hold
// empty files so routing can see them.
const HANDLERS: Record<string, Mod> = {
  'echo.ts': {
    default: (req, res) => {
      res.status(200).json({
        method: req.method,
        query: req.query,
        body: req.body,
        cookies: req.cookies,
      });
    },
  },
  'nested/deep.ts': { default: (_req, res) => res.status(201).send('deep') },
  'redirect.ts': { default: (_req, res) => res.redirect(302, '/somewhere') },
  'throws.ts': {
    default: () => {
      throw new Error('SECRET_ENV_NAME is not set');
    },
  },
  'silent.ts': { default: () => undefined },
  'raw.ts': {
    config: { api: { bodyParser: false } },
    default: async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.status(200).json({ bytes: Buffer.concat(chunks).length, body: req.body ?? null });
    },
  },
  '_private.ts': { default: (_req, res) => res.status(200).send('leak') },
  // A literal file and a dynamic sibling in the same folder, which is the shape
  // /api/models has: POST /api/models is api/models.ts, GET /api/models/<hash>
  // is api/models/[hash].ts.
  'models.ts': { default: (_req, res) => res.status(200).send('literal') },
  'models/[hash].ts': {
    default: (req, res) => res.status(200).json({ query: req.query }),
  },
};

let dir: string;
let server: Server;
let base: string;
const logged: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vp-shim-'));
  mkdirSync(join(dir, 'nested'));
  mkdirSync(join(dir, '_lib'));
  mkdirSync(join(dir, 'models'));
  for (const name of Object.keys(HANDLERS)) writeFileSync(join(dir, name), '');
  writeFileSync(join(dir, '_lib', 'helper.ts'), '');
  writeFileSync(join(dir, 'noexport.ts'), '');

  const handle = createApiShim({
    apiDir: dir,
    importModule: async (file) => {
      const rel = file.slice(dir.length + 1).split('\\').join('/');
      return (HANDLERS[rel] ?? {}) as never;
    },
    log: (...args) => logged.push(args.map(String).join(' ')),
  });
  server = createServer((req, res) => {
    void handle(req, res).then((handled) => {
      if (!handled) res.end('NOT-API');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('routing', () => {
  it('maps /api/<file> and nested paths to handler files', async () => {
    expect((await fetch(`${base}/api/echo`)).status).toBe(200);
    const deep = await fetch(`${base}/api/nested/deep`);
    expect(deep.status).toBe(201);
    expect(await deep.text()).toBe('deep');
  });

  it('answers unknown /api paths with a JSON 404, never falling through', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('never routes private files or folders (leading underscore)', async () => {
    expect((await fetch(`${base}/api/_private`)).status).toBe(404);
    expect((await fetch(`${base}/api/_lib/helper`)).status).toBe(404);
  });

  it('rejects traversal and encoded separators', async () => {
    for (const p of ['/api/..%2Fpackage', '/api/nested/..%2F..%2Fx', '/api/a%5Cb']) {
      expect((await fetch(`${base}${p}`)).status, p).toBe(404);
    }
    // %2e%2e is normalised to `..` by the URL parser, so this is the path /x:
    // not an API path at all, passed on to the SPA like any other page.
    expect(await (await fetch(`${base}/api/%2e%2e/x`)).text()).toBe('NOT-API');
    expect(resolveHandlerPath(dir, '/api/../echo')).toBeNull();
    expect(resolveHandlerPath(dir, '/api/Echo')).toBeNull();
  });

  it('passes non-/api requests on untouched', async () => {
    expect(await (await fetch(`${base}/room/abc`)).text()).toBe('NOT-API');
    expect(await (await fetch(`${base}/apix`)).text()).toBe('NOT-API');
  });
});

// ─── Dynamic routes ─────────────────────────────────────────────────────────
//
// /api/models/<hash> is the first path in this app whose last segment is not a
// file name. Vercel matches it with a `[param].ts` sibling; if the shim does
// not, the route works in one deployment shape and 404s in the other, and the
// failure is invisible until somebody imports a model on a self-hosted install.

describe('dynamic routes', () => {
  const HASH = 'a'.repeat(64);

  it('routes a trailing segment to a [param].ts sibling and passes it in query', async () => {
    const res = await fetch(`${base}/api/models/${HASH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ query: { hash: HASH } });
  });

  it('prefers a literal file over a dynamic sibling', async () => {
    // api/models.ts and api/models/[hash].ts both exist, so POST /api/models
    // must reach the literal one — Vercel's own precedence, and the reason a
    // collection route and its item route can live side by side.
    expect(await (await fetch(`${base}/api/models`)).text()).toBe('literal');
    expect(resolveRoute(dir, '/api/models')).toEqual({
      file: join(dir, 'models.ts'),
      params: {},
    });
  });

  it('reports the resolved file and parameter for a dynamic match', () => {
    expect(resolveRoute(dir, `/api/models/${HASH}`)).toEqual({
      file: join(dir, 'models', '[hash].ts'),
      params: { hash: HASH },
    });
    expect(resolveHandlerPath(dir, `/api/models/${HASH}`)).toBe(
      join(dir, 'models', '[hash].ts'),
    );
  });

  it('lets the path parameter win over a query string of the same name', async () => {
    const res = await fetch(`${base}/api/models/${HASH}?hash=${'b'.repeat(64)}`);
    const body = (await res.json()) as { query: Record<string, string> };
    // The router matched on the path, so the path is the part worth believing;
    // a query string is caller-supplied and unexamined.
    expect(body.query.hash).toBe(HASH);
  });

  it('keeps other query parameters', async () => {
    const res = await fetch(`${base}/api/models/${HASH}?v=2`);
    const body = (await res.json()) as { query: Record<string, string> };
    expect(body.query).toEqual({ hash: HASH, v: '2' });
  });

  it('does not match a dynamic segment in the middle of a path', async () => {
    // Only the LAST segment is a parameter. Anything deeper has no handler, and
    // inventing one would mean guessing which folder a `[param].ts` belongs to.
    expect((await fetch(`${base}/api/models/${HASH}/extra`)).status).toBe(404);
    expect(resolveRoute(dir, `/api/models/${HASH}/extra`)).toBeNull();
  });

  it('still refuses traversal and anything a segment may not contain', () => {
    // The segment rule runs BEFORE the directory scan, so no value that reaches
    // a `[param].ts` handler can carry a separator, a dot or a percent sign —
    // which is what makes `<dir>/<hash>` in the local store unreachable by a
    // path an attacker chose.
    for (const path of [
      '/api/models/..%2Fsecret',
      '/api/models/%2e%2e',
      '/api/models/a%5Cb',
      '/api/models/.hidden',
      '/api/models/UPPER',
      '/api/_lib/helper',
      '/api/nested/..%2Fmodels',
    ]) {
      expect(resolveRoute(dir, path), path).toBeNull();
    }
    expect(resolveHandlerPath(dir, '/api/models/../echo')).toBeNull();
  });

  it('does not route a private file even through a dynamic match', async () => {
    expect((await fetch(`${base}/api/_private`)).status).toBe(404);
  });
});

describe('request helpers', () => {
  it('parses query strings, keeping repeated keys as arrays', async () => {
    const res = await fetch(`${base}/api/echo?a=1&b=x&b=y&c=${encodeURIComponent('a&b')}`);
    const body = (await res.json()) as { query: unknown };
    expect(body.query).toEqual({ a: '1', b: ['x', 'y'], c: 'a&b' });
  });

  it('parses JSON, urlencoded and text bodies', async () => {
    const json = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    });
    expect(((await json.json()) as { body: unknown }).body).toEqual({ n: 1 });

    const form = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'k=v&k=w',
    });
    expect(((await form.json()) as { body: unknown }).body).toEqual({ k: ['v', 'w'] });

    expect(parseBody(Buffer.from('hi'), 'text/plain')).toBe('hi');
    expect(parseBody(Buffer.alloc(0), 'application/json')).toBeUndefined();
  });

  it('answers malformed JSON with 400, not a crash', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });

  it('parses cookies', async () => {
    const res = await fetch(`${base}/api/echo`, { headers: { cookie: 'a=1; b=hello%20there' } });
    expect(((await res.json()) as { cookies: unknown }).cookies).toEqual({ a: '1', b: 'hello there' });
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('leaves the stream unread when a handler disables the body parser', async () => {
    const payload = Buffer.alloc(6 * 1024 * 1024, 7); // above the parsed-body limit
    const res = await fetch(`${base}/api/raw`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: payload.length, body: null });
  });

  it('rejects a parsed body over the limit with 413', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '"' + 'x'.repeat(5 * 1024 * 1024) + '"',
    });
    expect(res.status).toBe(413);
  });

  it('parseQuery handles an empty search', () => {
    expect(parseQuery(new URLSearchParams(''))).toEqual({});
  });
});

describe('response helpers and failures', () => {
  it('redirect sets status and Location', async () => {
    const res = await fetch(`${base}/api/redirect`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/somewhere');
  });

  it('hides a thrown error from the caller and logs it', async () => {
    const res = await fetch(`${base}/api/throws`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: 'internal_error' }));
    expect(text).not.toContain('SECRET_ENV_NAME');
    expect(logged.some((l) => l.includes('SECRET_ENV_NAME'))).toBe(true);
  });

  it('answers 500 rather than hanging when a handler never responds', async () => {
    const res = await fetch(`${base}/api/silent`);
    expect(res.status).toBe(500);
  });

  it('answers 500 when a file exports no handler', async () => {
    expect((await fetch(`${base}/api/noexport`)).status).toBe(500);
  });
});
