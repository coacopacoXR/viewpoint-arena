// @vitest-environment node
//
// The upload ceiling, on its own.
//
// What makes this worth a separate file from the handler tests is the one
// property a handler test cannot show: that a body over the limit is refused
// while it is STILL ARRIVING, rather than being buffered in full and judged
// afterwards. The difference is 200 MB of heap per abusive request — and the
// api container is the one process in the stack that also has to serve every
// other route.

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { BodyTooLargeError, readRawBodyLimited } from '../rawBody.ts';

/** A body of `totalBytes` delivered in `chunkBytes` pieces. */
function chunked(totalBytes: number, chunkBytes: number): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= totalBytes) {
        this.push(null);
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      this.push(Buffer.alloc(size, 0x61));
    },
  });
}

describe('readRawBodyLimited', () => {
  it('returns the whole body when it fits', async () => {
    const body = await readRawBodyLimited(chunked(100, 10), 100);
    expect(body.byteLength).toBe(100);
    expect(body.every((byte) => byte === 0x61)).toBe(true);
  });

  it('accepts a body exactly at the limit', async () => {
    // The check is `> limit`, not `>=`: a 200 MB file against a 200 MB ceiling
    // is the legitimate case the ceiling exists to allow.
    const body = await readRawBodyLimited(chunked(64, 16), 64);
    expect(body.byteLength).toBe(64);
  });

  it('rejects with BodyTooLargeError, and the error carries the limit', async () => {
    const err = await readRawBodyLimited(chunked(1000, 16), 64).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect((err as BodyTooLargeError).limit).toBe(64);
  });

  it('refuses as soon as the limit is passed, without waiting for the body to end', async () => {
    const req = new Readable({ read() {} });
    req.push(Buffer.alloc(64, 0x61)); // exactly at the ceiling
    req.push(Buffer.alloc(1, 0x62)); // one byte over it
    // Deliberately no push(null): the client is still sending. A reader that
    // buffered the body and judged it at 'end' would never settle, and this
    // test would time out rather than pass — which is the point.
    const err = await readRawBodyLimited(req, 64).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect(req.readableEnded).toBe(false);
  });

  it('keeps draining after refusing, so the 413 can still be written', async () => {
    const req = chunked(1024 * 1024, 64 * 1024);
    const drained = new Promise<void>((resolve) => req.on('end', () => resolve()));

    await expect(readRawBodyLimited(req, 64)).rejects.toBeInstanceOf(BodyTooLargeError);

    // Destroying the stream instead would leave the client with a bare
    // connection reset and no idea what it did wrong; the caller still owes it
    // a legible 413 on this socket.
    await drained;
    expect(req.readableEnded).toBe(true);
  });

  it('passes a stream error through', async () => {
    const req = new Readable({
      read() {
        this.destroy(new Error('socket hang up'));
      },
    });
    await expect(readRawBodyLimited(req, 1024)).rejects.toThrow(/socket hang up/);
  });

  it('resolves an empty body as an empty buffer, leaving that judgement to the caller', async () => {
    const body = await readRawBodyLimited(chunked(0, 16), 1024);
    expect(body.byteLength).toBe(0);
  });
});
