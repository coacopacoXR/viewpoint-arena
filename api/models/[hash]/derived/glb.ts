// GET /api/models/<hash>/derived/glb — the GLB convert-service tessellated from
// a stored CAD file.
//
// A DERIVATIVE, served under its source's hash rather than its own, and that is
// the whole design: the source hash is the identity that travels on the room
// socket and in a curated review's asset, so a client that already knows a model
// can ask for the fast version of it without learning a second address. See
// DerivedKind in lib/storage/modelStore.ts.
//
// The four answers, and why each has the status it has:
//
//   200 + bytes   the derivative is stored. Cached `immutable` for a year, the
//                 way [hash].ts caches the source: the URL names a source hash
//                 and a kind, and the tessellation those two produce does not
//                 change, so a browser that has it never needs to ask again.
//   202 pending   a conversion is running, or one has just been started because
//                 this process had no record of one. The client polls; this is
//                 the answer that makes an api restart mid-conversion heal.
//   404 failed    the conversion ran and did not produce a GLB. `reason` is a
//                 code from convert_service/errors.py, forwarded verbatim
//                 because that vocabulary is ours and carries no content —
//                 `convert_unreadable` and `convert_timeout` are the two the
//                 browser already has sentences for (utils/cadImport.ts).
//   404 unavailable   nothing will ever derive one: no convert-service is
//                 configured, or the source is not a format it reads.
//
// SECURITY. The access gate and the hash validation [hash].ts applies run FIRST,
// in the same order, for the same reasons: a model is the geometry a room is
// reviewing, and a derivative of it is that geometry in a different encoding —
// serving it to anyone who could reach the origin would undo the gate by another
// door. The hash check is also what makes a traversal inexpressible, and the
// source is required to exist before any conversion is started, so this route
// cannot be used to set convert-service working on a hash nobody stored.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isModelHash } from '../../../../lib/storage/modelStore.ts';
import { DERIVED_CONTENT_TYPE } from '../../../../lib/storage/derived.ts';
import { requestIsAllowed, resolveModelStore } from '../../../_lib/models.ts';
import { derivedGlbStatus } from '../../../_lib/derivedJobs.ts';

/** A derivative is named by its source, so it is as immutable as the source is. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The kind this route serves, and the only one the store holds. */
const KIND = 'glb' as const;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  if (!requestIsAllowed(req)) {
    res.status(401).json({ error: 'locked' });
    return;
  }

  const raw = req.query.hash;
  const hash = Array.isArray(raw) ? raw[0] : raw;
  // 64 lower-case hex characters, or nothing — the check that makes
  // `derived/<hash>.glb` a path inside the store rather than out of it.
  if (!isModelHash(hash)) {
    res.status(400).json({ error: 'bad_hash' });
    return;
  }

  const store = await resolveModelStore();
  if (!store) {
    res.status(503).json({ error: 'storage_unavailable' });
    return;
  }

  const status = await derivedGlbStatus(store, hash);
  if (status.status !== 'ready') {
    // `not_found` keeps [hash].ts's own vocabulary: no such model, which is a
    // different mistake from "no derivative of it", and the client already has a
    // path for it. The other three are this route's.
    if (status.status === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // no-store, because a 404 is heuristically cacheable and a client that cached
    // "failed" would never learn that the retry after it succeeded. nginx's
    // /api/models location deliberately adds no Cache-Control of its own, so this
    // is the only header in the path that can say it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(status.status === 'pending' ? 202 : 404).json(status);
    return;
  }

  // head then get, the order [hash].ts uses: the head answers the length and
  // proves the derivative is there, and a store that lost it between the two
  // reads has to be a 404 rather than a body it cannot describe.
  const body = await store.getDerived(hash, KIND);
  if (!body) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // model/gltf-binary rather than the source's octet-stream: this response is
  // fetched by a loader, never navigated to, and nosniff closes the
  // guess-the-type path anyway. No Content-Disposition, because a derivative has
  // no name of its own — the source's would end in `.step` on GLB bytes.
  res.setHeader('Content-Type', DERIVED_CONTENT_TYPE[KIND]);
  // Omitted when the provider could not report a length (DerivedMeta.size 0), so
  // the body goes out chunked rather than announced as empty.
  if (status.size > 0) res.setHeader('Content-Length', String(status.size));
  res.setHeader('Cache-Control', CACHE_CONTROL);
  // Named for the SOURCE and the kind, not for the derivative's own bytes: it has
  // no hash of its own, and this is the pair that decides what it contains.
  res.setHeader('ETag', `"${hash}-${KIND}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200);

  if (req.method === 'HEAD') {
    body.destroy();
    res.end();
    return;
  }

  // Sent now, before the first byte of the body: server/vercelShim.ts treats a
  // handler that returns with neither headers nor a finished response as one that
  // forgot to answer, and answers 500 for it — right for every other route and
  // wrong for this one, where the response is a stream that outlives the return.
  res.flushHeaders();

  body.on('error', (err: Error) => {
    // Headers are already out, so there is no status left to send. Ending the
    // response is what stops the client waiting on a body that will not finish; a
    // truncated GLB fails its own parse, which is the visible symptom.
    console.error('[api/models] streaming a derivative failed:', err);
    res.end();
  });
  body.pipe(res);
}
