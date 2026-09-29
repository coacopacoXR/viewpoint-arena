// Reading a raw request body with a ceiling.
//
// api/capture/_proxyShared.ts reads a body with no limit of its own and lets
// nginx's `client_max_body_size` be the only ceiling — acceptable there because
// the bytes are forwarded untouched and the upstream enforces its own. A model
// upload is different: it is hashed and written to a volume, so the api has to
// be the layer that says "too big", and it has to say so BEFORE it has accepted
// 200 MB it cannot store.
//
// This mirrors server/vercelShim.ts's readBody, which already had to solve the
// same problem for parsed bodies: stop keeping chunks the moment the count goes
// over, but keep DRAINING the socket. Destroying the stream instead would leave
// the client with a bare connection reset and no idea what it did wrong.

import type { Readable } from 'node:stream';

/** The body went over the limit. Carries the limit so the caller can quote it. */
export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeded ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * The whole body as one buffer, or a BodyTooLargeError as soon as it is clear
 * the body is too big.
 *
 * Peak memory is the limit plus one chunk, not the length of the upload: a
 * client that announces 10 GB and starts sending it is refused at 200 MB, and
 * the rest is discarded as it arrives. The caller should still close the
 * connection after answering, since a determined client can keep writing.
 */
export function readRawBodyLimited(req: Readable, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk: Buffer) => {
      // Already refused: consume and drop, so the response can still be sent on
      // this socket. A promise settles once, so the later rejections are no-ops.
      if (refused) return;
      size += chunk.length;
      if (size > limit) {
        refused = true;
        // Release what was buffered: this body is not going to be stored, and
        // holding 200 MB while the client finishes sending is the exact waste
        // the streaming check exists to avoid.
        chunks.length = 0;
        rejectBody(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!refused) resolveBody(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (!refused) rejectBody(err);
    });
  });
}
