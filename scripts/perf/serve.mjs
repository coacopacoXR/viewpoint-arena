#!/usr/bin/env node
// scripts/perf/serve.mjs
//
// The one server the perf benchmark runs against: `dist/` over HTTP, with /api/*
// handled in-process by the repo's own Vercel shim.
//
// Why this exists rather than `vite preview`: an import does not reach the
// renderer without going through the model store. components/UI/SceneTree.tsx
// uploads the picked file to POST /api/models and keeps only the content hash;
// lib/scene/useSceneModelLoader.ts then downloads the bytes back from
// /api/models/<hash>. Under `vite preview` both of those are answered by the SPA
// fallback with index.html, lib/modelsClient.ts reads that as "the server could
// not be reached", and the import stops before it ever parses anything — so a
// benchmark on `vite preview` would have no model to measure. Production puts
// nginx in front of both; this puts them in one process instead, which is the
// same topology without the container.
//
// Run through tsx, which is what lets the .ts shim and its handlers load:
//   node --import tsx scripts/perf/serve.mjs
//
// Storage is pointed at a scratch directory under the already-gitignored
// perf/fixtures/ via VIEWPOINT_CONFIG (lib/config/loadConfig.ts reads that
// environment variable as the whole config, JSON-encoded). Set here rather than
// left to viewpoint.config.ts because that file is per-deployment and gitignored:
// a benchmark whose numbers depend on whether the operator happens to have one
// is not a repeatable benchmark. It is set unconditionally for the same reason —
// a local config pointing model storage at a Supabase bucket would quietly send
// the fixture off the machine, which the default install promises not to do.

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(REPO_ROOT, 'dist');
const STORE_DIR = join(REPO_ROOT, 'perf', 'fixtures', 'api-models');
const PORT = Number(process.env.PERF_PORT ?? 4173);

// A whole config, because configSchema requires every block: a partial one fails
// validation and api/_lib/models.ts answers 503 storage_unavailable, which is
// the failure that makes an import stop before it parses anything.
//
// Every block is set to the variant that needs nothing from the machine. The db
// block has no 'none' provider, so it names env vars and they are filled with
// dummies below — which is safe because lib/supabase.ts reads the Supabase URL
// that Vite inlined at build time, and `vite build` ran in its own process
// without these. `supabaseConfigured` is therefore false in the browser whatever
// this says, and pages/RoomPage.tsx takes its no-database path. The names
// deliberately avoid the VITE_ prefix so scripts/check-public-env.mjs has nothing
// to say about this file.
process.env.PERF_TURN_SHARED_SECRET ??= 'not-a-secret-perf-benchmark-only';
process.env.PERF_DB_URL ??= 'http://127.0.0.1:9/';
process.env.PERF_DB_ANON_KEY ??= 'not-a-key';
process.env.VIEWPOINT_CONFIG = JSON.stringify({
  plm: { provider: 'none' },
  capture: { provider: 'mock' },
  turn: {
    provider: 'selfHostedCoturn',
    host: 'localhost',
    port: 3478,
    sharedSecretEnv: 'PERF_TURN_SHARED_SECRET',
  },
  db: { provider: 'supabase', urlEnv: 'PERF_DB_URL', anonKeyEnv: 'PERF_DB_ANON_KEY' },
  notifications: [],
  modelImport: { provider: 'genericGltf' },
  modelStorage: { provider: 'local', dir: STORE_DIR },
});
mkdirSync(STORE_DIR, { recursive: true });

const { apiDirFor, createApiShim } = await import(
  pathToFileURL(join(REPO_ROOT, 'server', 'vercelShim.ts')).href
);
const handleApi = createApiShim({
  apiDir: apiDirFor(REPO_ROOT),
  importModule: (file) => import(pathToFileURL(file).href),
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/**
 * A path inside dist/, or null.
 *
 * Checked by prefix on the resolved path rather than by rejecting '..' in the
 * URL: this server only ever binds to a benchmark run on a developer's machine,
 * but a path traversal in a script committed to the repo is a path traversal
 * wherever somebody later points it.
 */
function staticFileFor(pathname) {
  const decoded = decodeURIComponent(pathname);
  const full = resolve(join(DIST, decoded));
  if (full !== DIST && !full.startsWith(DIST + sep)) return null;
  if (existsSync(full) && statSync(full).isDirectory()) return join(full, 'index.html');
  return full;
}

function sendFile(res, file, status = 200) {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': statSync(file).size });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://localhost:${PORT}`).pathname;

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    handleApi(req, res)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
      })
      .catch((err) => {
        console.error('[perf-serve] api error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
    return;
  }

  const wanted = staticFileFor(pathname);
  if (wanted && existsSync(wanted) && !statSync(wanted).isDirectory()) {
    sendFile(res, wanted);
    return;
  }

  // SPA fallback: a client-side route like /room/abc is not a file, and the app
  // reads the address itself once index.html has booted.
  const index = join(DIST, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`dist/index.html is missing — run \`npm run build\` before scripts/perf/serve.mjs`);
    return;
  }
  sendFile(res, index);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[perf-serve] http://localhost:${PORT}  (dist ${DIST}, model store ${STORE_DIR})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
