// GET /api/models/<hash> — serve one stored model file, by its content address.
//
// The hash IS the cache key, which is why the response is `immutable` for a
// year: bytes stored under a SHA-256 can never change without the URL changing
// with them. Every client in a room, and every later room that reviews the same
// revision, can then keep what it already downloaded — which is what makes
// "switch back to Rev A" instant instead of another 200 MB.
//
// The file is `[hash].ts`, Vercel's dynamic-route name: server/vercelShim.ts
// resolves /api/models/<anything> to it and puts the segment in req.query.hash.
// On Vercel the platform does the same thing natively, so one file serves both.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isModelHash } from '../../lib/storage/modelStore.ts';
import { contentDisposition, requestIsAllowed, resolveModelStore } from '../_lib/models.ts';

/** A content-addressed object never changes, so it can be cached for a year. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Gate first, like the upload: an unadmitted connection gets nothing that
  // belongs to the room, and the model is the room's subject matter.
  if (!requestIsAllowed(req)) {
    res.status(401).json({ error: 'locked' });
    return;
  }

  const raw = req.query.hash;
  const hash = Array.isArray(raw) ? raw[0] : raw;
  // 64 lower-case hex characters, or nothing. This is the check that makes a
  // traversal unreachable: a value that matches contains no separator, no dot
  // and no escape, so `<dir>/<hash>` cannot leave the store's directory even
  // though the hash arrived in a URL path. Anything else is a 400 rather than a
  // 404, because "not a hash" and "no such model" are different mistakes and a
  // client that produced the first one has a bug worth seeing.
  if (!isModelHash(hash)) {
    res.status(400).json({ error: 'bad_hash' });
    return;
  }

  const store = await resolveModelStore();
  if (!store) {
    res.status(503).json({ error: 'storage_unavailable' });
    return;
  }

  // head before get: the sidecar carries the name and the length, and a store
  // with metadata but no object (a crash between the two writes) must answer
  // 404 rather than serve a body it cannot describe.
  const meta = await store.head(hash);
  if (!meta) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = await store.get(hash);
  if (!body) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // octet-stream, not the format's own MIME: a browser that navigates here
  // directly should download the file, never try to render it, and nosniff
  // closes the guess-the-type path as well. Clients that parse it dispatch on
  // the file name in Content-Disposition, exactly as they did on the File the
  // importer picked.
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(meta.size));
  res.setHeader('Cache-Control', CACHE_CONTROL);
  res.setHeader('ETag', `"${hash}"`);
  res.setHeader('Content-Disposition', contentDisposition(meta.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200);

  if (req.method === 'HEAD') {
    body.destroy();
    res.end();
    return;
  }

  // Sent now, before the first byte of the body. server/vercelShim.ts treats a
  // handler that returns with neither headers nor a finished response as one
  // that forgot to answer, and answers 500 for it — which is right for every
  // other route, and wrong for this one, where the response is a stream that
  // outlives the handler's return. Flushing also starts the body moving while
  // the store is still reading, instead of after.
  res.flushHeaders();

  body.on('error', (err: Error) => {
    // Headers are already out, so there is no status left to send. Ending the
    // response is what stops the client waiting on a body that will not finish;
    // a truncated download fails its own parse, which is the visible symptom.
    console.error('[api/models] streaming failed:', err);
    res.end();
  });
  body.pipe(res);
}
