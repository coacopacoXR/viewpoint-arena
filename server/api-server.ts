// The self-hosted API runtime: serves api/*.ts over plain HTTP.
//
// Started by deploy/api.Dockerfile as `node --import tsx server/api-server.ts`.
// tsx is what lets Node load the handlers' TypeScript and their `.js`-suffixed
// relative imports. nginx in the `app` container proxies /api/* here, so the
// browser still sees one same-origin site.
//
// Reads viewpoint.config.ts and secrets from its working directory and
// environment, exactly as the Vercel functions do.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { apiDirFor, createApiShim } from './vercelShim.ts';

const port = Number(process.env.API_PORT ?? 8787);
const host = process.env.API_HOST ?? '0.0.0.0';
const root = resolve(process.env.API_ROOT ?? process.cwd());

const handle = createApiShim({
  apiDir: apiDirFor(root),
  importModule: (file) => import(pathToFileURL(file).href),
});

const server = createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    // One structured line per request; no query string, which can carry ids.
    const path = (req.url ?? '').split('?')[0];
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - started,
      }),
    );
  });
  // Liveness for the container healthcheck: "is this process serving". Not
  // /api/health, which answers 503 whenever any connector is degraded and
  // would make Docker restart a perfectly healthy API server.
  if (req.url === '/healthz') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
    return;
  }
  handle(req, res)
    .then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })
    .catch((err: unknown) => {
      console.error('[api] unhandled:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
});

// Long enough for a capture upload + transcription (api/capture/local.ts waits
// up to 15 minutes for capture-service).
server.requestTimeout = 16 * 60 * 1000;
server.headersTimeout = 60 * 1000;

server.listen(port, host, () => {
  console.log(`[api] listening on http://${host}:${port} (root ${root})`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
