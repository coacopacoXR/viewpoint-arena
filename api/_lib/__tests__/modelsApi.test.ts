// @vitest-environment node
//
// /api/models end to end: the real handlers, the real shim (so the dynamic
// `[hash].ts` route is exercised the way the api container resolves it), the
// real local store on a temp directory, over a real HTTP socket. No fake
// request or response objects — what is asserted is what a browser would see.
//
// The only thing substituted is the upload ceiling: 200 MB is the real limit
// and a test that posted 201 MB to prove the refusal would be slower and hungrier
// than the code it checks. MAX_MODEL_UPLOAD_BYTES is mocked down to 64 so the
// streaming rejection runs on a body of 100 bytes instead.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiShim } from '../../../server/vercelShim.ts';
import { sha256Hex } from '../../../lib/storage/hash.ts';
import { hashPassword, signToken } from '../accessControl.ts';

vi.mock('../models.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../models.ts')>()),
  MAX_MODEL_UPLOAD_BYTES: 64,
}));

// A 40-byte stand-in for a GLB: the magic and version a real one starts with,
// then padding. Under the mocked 64-byte ceiling, over the "empty" floor.
const GLB_BYTES = Buffer.concat([
  Buffer.from('glTF', 'ascii'),
  Buffer.from([0x02, 0x00, 0x00, 0x00]),
  Buffer.alloc(32, 0x07),
]);
const GLB_HASH = sha256Hex(new Uint8Array(GLB_BYTES));
// Different bytes, so a different hash: the store is content-addressed and
// idempotent, so re-uploading GLB_BYTES under another name records nothing new
// and the first name stays the record. A test that wanted to see its own name
// come back has to upload its own file.
const STEP_BYTES = Buffer.concat([Buffer.from('ISO-10303-21;', 'ascii'), Buffer.alloc(24, 0x0a)]);
const STEP_HASH = sha256Hex(new Uint8Array(STEP_BYTES));
const STEP_NAME = 'Bügel — Rev B.step';
const OVERSIZED_BYTES = Buffer.alloc(100, 0x62);
/** 64 hex chars that nothing has ever stored. */
const UNKNOWN_HASH = '0'.repeat(64);

let fixtureDir: string;
let modelsDir: string;
let server: Server;
let base: string;

const STORED_HASH = hashPassword('front-door');

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vp-models-api-'));
  modelsDir = mkdtempSync(join(tmpdir(), 'vp-models-data-'));

  // Empty files at the two routable paths, so the shim's resolver finds them
  // and importModule can hand back the real modules instead.
  mkdirSync(join(fixtureDir, 'models'));
  writeFileSync(join(fixtureDir, 'models.ts'), '');
  writeFileSync(join(fixtureDir, 'models', '[hash].ts'), '');

  process.env.VIEWPOINT_CONFIG = JSON.stringify({
    plm: { provider: 'none' },
    capture: { provider: 'mock' },
    turn: {
      provider: 'selfHostedCoturn',
      host: 'localhost',
      port: 3478,
      sharedSecretEnv: 'COTURN_SHARED_SECRET',
    },
    db: {
      provider: 'supabase',
      urlEnv: 'VITE_SUPABASE_URL',
      anonKeyEnv: 'VITE_SUPABASE_ANON_KEY',
    },
    notifications: [],
    modelImport: { provider: 'genericGltf' },
    modelStorage: { provider: 'local', dir: modelsDir },
  });
  process.env.COTURN_SHARED_SECRET = 'test-secret';
  process.env.VITE_SUPABASE_URL = 'https://placeholder.supabase.test';
  process.env.VITE_SUPABASE_ANON_KEY = 'placeholder-anon-key';

  const upload = await import('../../models.ts');
  const download = await import('../../models/[hash].ts');

  const handle = createApiShim({
    apiDir: fixtureDir,
    importModule: async (file) => {
      const route = relative(fixtureDir, file).split(sep).join('/');
      if (route === 'models.ts') return upload;
      if (route === 'models/[hash].ts') return download;
      return {};
    },
  });

  server = createServer((req, res) => {
    void handle(req, res).then((handled) => {
      if (!handled) res.end('NOT-API');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.VIEWPOINT_CONFIG;
  delete process.env.ACCESS_PASSWORD_HASH;
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(modelsDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.ACCESS_PASSWORD_HASH;
});

interface UploadResult {
  hash: string;
  size: number;
  fileName: string;
}

async function upload(
  bytes: Buffer,
  fileName: string | null,
  init: { method?: string; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  // Percent-encoded, as the client sends it: an HTTP header value is
  // ISO-8859-1 and part names are not always ASCII.
  if (fileName !== null) headers['X-File-Name'] = encodeURIComponent(fileName);
  if (init.cookie) headers.cookie = init.cookie;
  return fetch(`${base}/api/models`, { method: init.method ?? 'POST', headers, body: bytes });
}

describe('POST /api/models', () => {
  it('stores the bytes and answers with the content address', async () => {
    const res = await upload(GLB_BYTES, 'bracket.glb');
    expect(res.status).toBe(200);
    const body = (await res.json()) as UploadResult;
    expect(body).toEqual({ hash: GLB_HASH, size: GLB_BYTES.byteLength, fileName: 'bracket.glb' });
    // The hash the client is told is the hash of the bytes it sent, computed on
    // the server — which is what makes it safe to broadcast to a room.
    expect(body.hash).toBe(sha256Hex(new Uint8Array(GLB_BYTES)));
  });

  it('writes the object and its sidecar to the configured store', async () => {
    await upload(GLB_BYTES, 'bracket.glb');
    const names = readdirSync(modelsDir).sort();
    expect(names).toContain(GLB_HASH);
    expect(names).toContain(`${GLB_HASH}.json`);
  });

  it('is idempotent: the same bytes a second time store one object', async () => {
    const first = (await (await upload(GLB_BYTES, 'bracket.glb')).json()) as UploadResult;
    const second = (await (await upload(GLB_BYTES, 'renamed-by-someone.glb')).json()) as UploadResult;
    expect(second.hash).toBe(first.hash);
    // One object, one sidecar — not a copy per upload, which is the difference
    // between a room that reviews one revision from five browsers and five
    // times the disk.
    expect(readdirSync(modelsDir).filter((n) => n === GLB_HASH)).toHaveLength(1);
  });

  it('keeps a name it was sent percent-encoded, including non-ASCII', async () => {
    const res = await upload(STEP_BYTES, STEP_NAME);
    expect(res.status).toBe(200);
    expect(((await res.json()) as UploadResult).fileName).toBe(STEP_NAME);
  });

  it('refuses an extension no reader can open, with 415', async () => {
    const res = await upload(GLB_BYTES, 'notes.zip');
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_file_type' });
  });

  it('refuses a native CAD file, which has no open-source reader', async () => {
    // Recognised only to be refused: the same list the browser's file picker
    // uses, so a scripted caller gets the same answer a person would.
    const res = await upload(GLB_BYTES, 'part.sldprt');
    expect(res.status).toBe(415);
  });

  it('accepts every format the importers accept, CAD included', async () => {
    for (const name of ['a.step', 'b.stp', 'c.iges', 'd.igs', 'e.brep', 'f.brp', 'g.obj', 'h.stl']) {
      const res = await upload(GLB_BYTES, name);
      expect(res.status, name).toBe(200);
    }
  });

  it('refuses a missing file name with 400', async () => {
    const res = await upload(GLB_BYTES, null);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_file_name' });
  });

  it('refuses a name that sanitises to nothing', async () => {
    // Leading dots are stripped so a name can never read as `.` or `..`, and a
    // name that is nothing but dots is therefore nothing at all.
    const res = await upload(GLB_BYTES, '...');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_file_name' });
  });

  it('refuses a header that is not valid percent-encoding', async () => {
    // A caller that forgot to encode is refused rather than stored under a name
    // that is half a byte sequence.
    const res = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'X-File-Name': '%%%' },
      body: GLB_BYTES,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_file_name' });
  });

  it('refuses an empty body with 400', async () => {
    const res = await upload(Buffer.alloc(0), 'empty.glb');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'empty_body' });
  });

  it('refuses a body over the limit with 413, and says what the limit was', async () => {
    const res = await upload(OVERSIZED_BYTES, 'too-big.glb');
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'file_too_large', maxBytes: 64 });
    // Nothing was stored for it.
    expect(readdirSync(modelsDir)).not.toContain(sha256Hex(new Uint8Array(OVERSIZED_BYTES)));
  });

  it('refuses a method that is not POST', async () => {
    const res = await fetch(`${base}/api/models`, { method: 'PUT', body: GLB_BYTES });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('GET /api/models/<hash>', () => {
  it('serves the stored bytes, and says they are the same file the client sent', async () => {
    await upload(GLB_BYTES, 'bracket.glb');
    const res = await fetch(`${base}/api/models/${GLB_HASH}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(GLB_BYTES);
  });

  it('marks the response cacheable for ever, because the URL is the content', async () => {
    await upload(GLB_BYTES, 'bracket.glb');
    const res = await fetch(`${base}/api/models/${GLB_HASH}`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${GLB_HASH}"`);
    // A content-addressed file cannot change, so a browser that has it never
    // needs to ask again — not even to revalidate.
    expect(res.headers.get('content-length')).toBe(String(GLB_BYTES.byteLength));
  });

  it('serves octet-stream with the original name, and never sniffs', async () => {
    await upload(STEP_BYTES, STEP_NAME);
    const res = await fetch(`${base}/api/models/${STEP_HASH}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    // RFC 5987 form is the only one that can carry the real characters.
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(STEP_NAME)}`);
    // …and the plain form has to survive a non-ASCII name without breaking out
    // of its quoted string.
    expect(disposition).toMatch(/filename="[^"]*"/);
    expect(disposition).not.toMatch(/filename="[^"]*"[^"]*"/);
  });

  it('answers 404 for a well-formed hash nothing stored', async () => {
    const res = await fetch(`${base}/api/models/${UNKNOWN_HASH}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 400 for a segment that routes but is not a hash', async () => {
    for (const bad of ['not-a-hash', 'deadbeef', GLB_HASH.slice(0, 63), `${GLB_HASH}0`]) {
      const res = await fetch(`${base}/api/models/${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json(), bad).toEqual({ error: 'bad_hash' });
    }
  });

  it('answers a traversal attempt with 404, and never reaches the store', async () => {
    // The shim's segment rule rejects `%` and `.` outright, so an encoded
    // separator is not routable at all: the request never becomes a hash, and
    // no store ever builds a path out of it. `not-a-route` is 404 for the same
    // reason — there is no handler for /api/models/<x>/<y>.
    for (const bad of ['..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e', `${GLB_HASH}/extra`]) {
      const res = await fetch(`${base}/api/models/${bad}`);
      expect(res.status, bad).toBe(404);
    }
    // Uppercase hex is a well-formed hash to a human and an unroutable segment
    // to the shim, so it is "no such route" rather than "bad hash". Either way
    // it is refused, and the store only ever sees a value MODEL_HASH_RE passed.
    expect((await fetch(`${base}/api/models/${GLB_HASH.toUpperCase()}`)).status).toBe(404);
    // A plain `..` is collapsed by the URL parser before routing, so it is not
    // an /api/models path at all and falls through to the SPA.
    expect(await (await fetch(`${base}/api/models/${GLB_HASH}/../../..`)).text()).toBe('NOT-API');
  });

  it('answers HEAD with the headers and no body', async () => {
    await upload(GLB_BYTES, 'bracket.glb');
    const res = await fetch(`${base}/api/models/${GLB_HASH}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(GLB_BYTES.byteLength));
    expect(res.headers.get('etag')).toBe(`"${GLB_HASH}"`);
    expect(await res.text()).toBe('');
  });

  it('refuses a method that is neither GET nor HEAD', async () => {
    const res = await fetch(`${base}/api/models/${GLB_HASH}`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('the access gate', () => {
  it('refuses both routes with 401 when the front door is locked', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;

    const post = await upload(GLB_BYTES, 'bracket.glb');
    expect(post.status).toBe(401);
    expect(await post.json()).toEqual({ error: 'locked' });

    const get = await fetch(`${base}/api/models/${GLB_HASH}`);
    expect(get.status).toBe(401);
    expect(await get.json()).toEqual({ error: 'locked' });
  });

  it('locks out a caller with a bad cookie, and lets a good one through', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;
    const refused = await upload(GLB_BYTES, 'bracket.glb', { cookie: 'vp_access=not-the-token' });
    expect(refused.status).toBe(401);

    const token = signToken(STORED_HASH, 'vp_access');
    const allowed = await upload(GLB_BYTES, 'bracket.glb', { cookie: `vp_access=${token}` });
    expect(allowed.status).toBe(200);
    const download = await fetch(`${base}/api/models/${GLB_HASH}`, {
      headers: { cookie: `vp_access=${token}` },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(GLB_BYTES);
  });

  it('stays open on an install with no front-door password', async () => {
    // The pre-existing behaviour: an install that chose to stay open is not
    // locked out by a route that was added later.
    process.env.ACCESS_PASSWORD_HASH = '';
    const res = await upload(GLB_BYTES, 'bracket.glb');
    expect(res.status).toBe(200);
  });
});
