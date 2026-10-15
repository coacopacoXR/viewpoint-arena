// POST /api/models — store a model file, answer with its content address.
//
// The body is the RAW BYTES: not base64, not multipart, not JSON. Base64 is
// what this route replaces — a 200 MB STEP file became a 267 MB string that the
// room server then held in memory and replayed to every connection, and the
// socket's 50 MB cap existed only because of it. Bytes in, `{ hash, size,
// fileName, derived }` out, and from then on every part of the app that needs
// this model passes the hash around instead.
//
// The name travels in `X-File-Name`, percent-encoded, because a header value is
// ISO-8859-1 and part names are not always ASCII.
//
// `derived` is the one field that is not about the bytes just stored: a CAD file
// also sets off a server-side tessellation (api/_lib/derivedJobs.ts) whose GLB is
// collected later from /api/models/<hash>/derived/glb. It is a promise about work
// that has started, never a wait for it — 'pending' when a conversion is going,
// 'unavailable' when this deployment has no convert-service or the file is a mesh
// that needs none.
//
// On Vercel the platform's own 4.5 MB body limit applies and cannot be raised;
// the self-hosted stack, where the big CAD files actually arrive, is limited by
// MAX_MODEL_UPLOAD_BYTES and nginx's matching `client_max_body_size`.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BodyTooLargeError, readRawBodyLimited } from './_lib/rawBody.ts';
import {
  MAX_MODEL_UPLOAD_BYTES,
  fileNameFromHeader,
  isSupportedModelFile,
  requestIsAllowed,
  resolveModelStore,
} from './_lib/models.ts';
import { startDerivedGlb } from './_lib/derivedJobs.ts';
import type { ModelRef } from '../lib/storage/modelStore.ts';
import { modelFileMime } from '../utils/modelFormats.ts';

export const config = {
  // The body is up to 200 MB of binary. Letting the platform parse it would
  // rebuild it as a string or a qs object; disabled, the stream is read here
  // and hashed as it arrived.
  api: { bodyParser: false },
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Gate before anything else, and before the body is read: a locked-out caller
  // gets the same answer as every other endpoint gives it, and does not get to
  // make this process buffer 200 MB on the way.
  if (!requestIsAllowed(req)) {
    res.status(401).json({ error: 'locked' });
    return;
  }

  // Resolved before the body too. A deployment whose storage is misconfigured
  // should say so without first accepting an upload it cannot keep.
  const store = await resolveModelStore();
  if (!store) {
    res.status(503).json({ error: 'storage_unavailable' });
    return;
  }

  const fileName = fileNameFromHeader(req.headers['x-file-name']);
  if (!fileName) {
    res.status(400).json({ error: 'missing_file_name' });
    return;
  }
  if (!isSupportedModelFile(fileName)) {
    // 415 rather than 400: the request is well formed, this is a format no
    // reader in utils/modelLoader.ts can open. The client already refuses these
    // at the file picker, so reaching here means a scripted or stale caller.
    res.status(415).json({ error: 'unsupported_file_type' });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await readRawBodyLimited(req, MAX_MODEL_UPLOAD_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // The client may still be sending. Closing after the answer is what turns
      // "413 then a hang" into "413 then a closed socket".
      res.setHeader('Connection', 'close');
      res.status(413).json({ error: 'file_too_large', maxBytes: err.limit });
      return;
    }
    console.error('[api/models] failed to read the upload:', err);
    res.status(400).json({ error: 'invalid_body' });
    return;
  }

  if (bytes.byteLength === 0) {
    res.status(400).json({ error: 'empty_body' });
    return;
  }

  let ref: ModelRef;
  try {
    ref = await store.put(bytes, {
      fileName,
      contentType: modelFileMime(fileName),
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    // The message can name a directory or a bucket. It goes to the log, and the
    // caller gets a code it can show next to "try again".
    console.error('[api/models] failed to store the upload:', err);
    res.status(500).json({ error: 'storage_error' });
    return;
  }

  // Started, NOT awaited, and outside the try above: a 200 MB assembly takes
  // minutes to tessellate and the person importing it is owed an answer now, and
  // a conversion that cannot start is not a reason to report the upload — which
  // succeeded — as a storage failure.
  //
  // `derived` says what to expect: 'pending' for a CAD file on a deployment that
  // runs convert-service, 'unavailable' for everything else, which is every mesh
  // upload and every install that never configured the service (the default, and
  // the whole of a Vercel deployment's experience). The GLB is collected later
  // from /api/models/<hash>/derived/glb, and the source hash stays the only
  // identity this upload produced.
  const derived = startDerivedGlb(store, ref.hash, fileName, { bytes });
  res.status(200).json({ hash: ref.hash, size: ref.size, fileName, derived });
}
