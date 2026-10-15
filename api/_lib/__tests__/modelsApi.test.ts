// @vitest-environment node
//
// /api/models end to end: the real handlers, the real shim (so the dynamic
// `[hash].ts` route is exercised the way the api container resolves it), the
// real local store on a temp directory, over a real HTTP socket. No fake
// request or response objects — what is asserted is what a browser would see.
//
// The only things substituted are the upload ceiling and convert-service. 200 MB
// is the real limit and a test that posted 201 MB to prove the refusal would be
// slower and hungrier than the code it checks, so MAX_MODEL_UPLOAD_BYTES is
// mocked down to 64 and the streaming rejection runs on a body of 100 bytes.
// convert-service is a second real HTTP server on its own port rather than a
// stubbed global fetch, because the derived route's tests also fetch from the api
// over the same global — and because a real socket is the only way to see the
// headers the api actually sends it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiShim } from '../../../server/vercelShim.ts';
import { LocalModelStore } from '../../../lib/storage/localModelStore.ts';
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

// ─── A convert-service to point the api at ──────────────────────────────────
//
// Real HTTP on its own port, driven by `convertRespond`. The GLB it answers with
// is deliberately not GLB_BYTES: a test that could not tell a served derivative
// from a served source would pass on a route that fetched the wrong object.
const CONVERT_SECRET = 'convert-FAKE-shared-secret';
const CONVERTED_GLB = Buffer.concat([
  Buffer.from('glTF', 'ascii'),
  Buffer.from([0x02, 0x00, 0x00, 0x00]),
  Buffer.alloc(20, 0x5a),
]);

interface ConvertRequest {
  path: string | undefined;
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const convertRequests: ConvertRequest[] = [];
/** What the next conversion answers with. Reset per test. */
type ConvertAnswer = { status: number; body?: Buffer; code?: string };
let convertRespond: (request: number) => ConvertAnswer | Promise<ConvertAnswer> = () => ({
  status: 200,
  body: CONVERTED_GLB,
});

function resetConvertService(): void {
  convertRequests.length = 0;
  convertRespond = () => ({ status: 200, body: CONVERTED_GLB });
}

let fixtureDir: string;
let modelsDir: string;
let server: Server;
let base: string;
let convertServer: Server;
let convertBase: string;

const STORED_HASH = hashPassword('front-door');

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vp-models-api-'));
  modelsDir = mkdtempSync(join(tmpdir(), 'vp-models-data-'));

  // Empty files at the three routable paths, so the shim's resolver finds them
  // and importModule can hand back the real modules instead. `[hash]` is both a
  // handler file and a directory holding handlers under it, which is the shape
  // Vercel's own routing reads.
  mkdirSync(join(fixtureDir, 'models', '[hash]', 'derived'), { recursive: true });
  writeFileSync(join(fixtureDir, 'models.ts'), '');
  writeFileSync(join(fixtureDir, 'models', '[hash].ts'), '');
  writeFileSync(join(fixtureDir, 'models', '[hash]', 'derived', 'glb.ts'), '');

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
  // Left UNSET here on purpose. "No convert-service configured" is the default an
  // existing install and every Vercel deployment has, so it is what every test
  // outside the derived-GLB block runs against; the block that needs one sets it.
  delete process.env.CONVERT_SERVICE_URL;
  delete process.env.CONVERT_SHARED_SECRET;

  const upload = await import('../../models.ts');
  const download = await import('../../models/[hash].ts');
  const derivedGlb = await import('../../models/[hash]/derived/glb.ts');

  const handle = createApiShim({
    apiDir: fixtureDir,
    importModule: async (file) => {
      const route = relative(fixtureDir, file).split(sep).join('/');
      if (route === 'models.ts') return upload;
      if (route === 'models/[hash].ts') return download;
      if (route === 'models/[hash]/derived/glb.ts') return derivedGlb;
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

  convertServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      convertRequests.push({
        path: req.url,
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      // Awaited so a test can hold a conversion open and watch the route answer 202
      // while it runs, which is the state a participant actually polls through.
      void Promise.resolve(convertRespond(convertRequests.length)).then((answer) => {
        if (answer.code !== undefined) {
          res.writeHead(answer.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: answer.code }));
          return;
        }
        res.writeHead(answer.status, {
          'Content-Type': 'model/gltf-binary',
          'X-Part-Count': '9',
          'X-Triangle-Count': '636',
          'X-Convert-Ms': '42',
        });
        res.end(answer.body ?? Buffer.alloc(0));
      });
    });
  });
  await new Promise<void>((resolve) => convertServer.listen(0, '127.0.0.1', () => resolve()));
  convertBase = `http://127.0.0.1:${(convertServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // `close` waits for open connections, and undici keeps the ones it fetched over
  // alive; a stream body left unread would otherwise hold teardown until vitest
  // gave up on the file.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // The api holds a keep-alive connection to this server for as long as a
  // conversion may run.
  convertServer.closeAllConnections();
  await new Promise<void>((resolve) => convertServer.close(() => resolve()));
  delete process.env.VIEWPOINT_CONFIG;
  delete process.env.ACCESS_PASSWORD_HASH;
  delete process.env.CONVERT_SERVICE_URL;
  delete process.env.CONVERT_SHARED_SECRET;
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(modelsDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.ACCESS_PASSWORD_HASH;
  delete process.env.CONVERT_SERVICE_URL;
  delete process.env.CONVERT_SHARED_SECRET;
  resetConvertService();
});

/** Point the api at the fake convert-service, for the tests that need one. */
function withConvertService(): void {
  process.env.CONVERT_SERVICE_URL = convertBase;
  process.env.CONVERT_SHARED_SECRET = CONVERT_SECRET;
}

/**
 * Poll the derived route until it stops saying 202, or give up.
 *
 * Polling the route rather than awaiting a job is the point: the client has
 * nothing but this endpoint, so "eventually 200" has to be a property of the
 * endpoint and not of a test reaching into the api's process.
 */
async function derivedSettled(hash: string, init: { cookie?: string } = {}): Promise<Response> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const res = await fetch(`${base}/api/models/${hash}/derived/glb`, {
      headers: init.cookie ? { cookie: init.cookie } : {},
    });
    if (res.status !== 202) return res;
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the derived route never left 202');
}

interface UploadResult {
  hash: string;
  size: number;
  fileName: string;
  /** 'pending' when a conversion was started, 'unavailable' when none could be. */
  derived: string;
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
    expect(body).toEqual({
      hash: GLB_HASH,
      size: GLB_BYTES.byteLength,
      fileName: 'bracket.glb',
      // A mesh has nothing to tessellate, so no conversion is started for it — and
      // this install has no convert-service configured either, which is the
      // default every existing deployment has.
      derived: 'unavailable',
    });
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

// ─── The derived GLB ────────────────────────────────────────────────────────
//
// A derivative is served under its SOURCE's hash, so the identity a room carries
// is the only identity there is. What is worth a red test here is the four states
// a participant can find one in, and the fact that the upload which starts a
// conversion is not waiting for it.

describe('GET /api/models/<hash>/derived/glb', () => {
  /** Distinct bytes per test: the job table is process state, keyed by hash. */
  function stepFor(label: string): { bytes: Buffer; name: string } {
    return {
      bytes: Buffer.concat([
        Buffer.from(`ISO-10303-21;${label}`, 'ascii'),
        Buffer.alloc(8, 0x0a),
      ]),
      name: `${label}.step`,
    };
  }

  async function uploadStep(step: { bytes: Buffer; name: string }): Promise<UploadResult> {
    const res = await upload(step.bytes, step.name);
    expect(res.status, `uploading ${step.name}`).toBe(200);
    return (await res.json()) as UploadResult;
  }

  it('answers 404 unavailable on an install with no convert-service', async () => {
    // The default: CONVERT_SERVICE_URL is unset, so nothing was started at upload
    // and nothing ever will be. The client's own WebAssembly reader is the path.
    const posted = await uploadStep(stepFor('no-service'));
    expect(posted.derived).toBe('unavailable');

    const res = await fetch(`${base}/api/models/${posted.hash}/derived/glb`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(convertRequests).toHaveLength(0);
  });

  it('answers 202 pending while a conversion is running, and does not let it be cached', async () => {
    withConvertService();
    // Held open, so 202 is observed rather than raced past.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    convertRespond = async () => {
      await gate;
      return { status: 200, body: CONVERTED_GLB };
    };
    try {
      const posted = await uploadStep(stepFor('held-open'));
      expect(posted.derived).toBe('pending');

      const res = await fetch(`${base}/api/models/${posted.hash}/derived/glb`);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'pending' });
      // A 404 is heuristically cacheable and a 202 is not, but the client polls
      // this URL until it changes, so saying so explicitly is what stops an
      // intermediary freezing the answer at "not ready yet".
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      release();
    }
  });

  it('serves the GLB once the conversion has finished', async () => {
    withConvertService();
    const posted = await uploadStep(stepFor('served'));

    const res = await derivedSettled(posted.hash);

    expect(res.status).toBe(200);
    // The derivative, and not the source: the two are different bytes here on
    // purpose, so a route that fetched the wrong object would fail.
    expect(Buffer.from(await res.arrayBuffer())).toEqual(CONVERTED_GLB);
  });

  it('serves it as an immutable object named for its SOURCE', async () => {
    withConvertService();
    const posted = await uploadStep(stepFor('headers'));

    const res = await derivedSettled(posted.hash);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('model/gltf-binary');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // The ETag names the source hash and the kind, because a derivative has no hash
    // of its own — and that pair is exactly what decides its contents.
    expect(res.headers.get('etag')).toBe(`"${posted.hash}-glb"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-length')).toBe(String(CONVERTED_GLB.byteLength));
    // No Content-Disposition: the source's name would end in `.step` on GLB bytes,
    // and a derivative has no name of its own to offer.
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('answers HEAD with the headers and no body', async () => {
    withConvertService();
    const posted = await uploadStep(stepFor('head-request'));
    expect((await derivedSettled(posted.hash)).status).toBe(200);

    const res = await fetch(`${base}/api/models/${posted.hash}/derived/glb`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(CONVERTED_GLB.byteLength));
    expect(res.headers.get('etag')).toBe(`"${posted.hash}-glb"`);
    expect(await res.text()).toBe('');
  });

  it('answers 404 failed with convert-service’s own code', async () => {
    withConvertService();
    convertRespond = () => ({ status: 422, code: 'convert_unreadable' });
    const posted = await uploadStep(stepFor('unreadable'));

    const res = await derivedSettled(posted.hash);

    // Forwarded verbatim: that vocabulary is ours, carries no content, and
    // utils/cadImport.ts already has a sentence for each of its codes.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 'failed', reason: 'convert_unreadable' });
  });

  it('answers 404 failed with the timeout convert-service itself reported', async () => {
    withConvertService();
    // The service's 504 is forwarded as its own code. The api's separate, SHORTER
    // deadline reports `convert_client_timeout` instead, so the two are never
    // confused in a log — that distinction is unit-tested in convertClient.test.ts.
    convertRespond = () => ({ status: 504, code: 'convert_timeout' });
    const posted = await uploadStep(stepFor('service-timeout'));

    const res = await derivedSettled(posted.hash);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 'failed', reason: 'convert_timeout' });
  });

  it('sends convert-service the file, its name and the shared secret', async () => {
    withConvertService();
    const step = stepFor('on-the-wire');
    const posted = await uploadStep(step);
    const settledResponse = await derivedSettled(posted.hash);
    expect(settledResponse.status).toBe(200);
    await settledResponse.body?.cancel();

    expect(convertRequests).toHaveLength(1);
    const sent = convertRequests[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/convert');
    // The raw body is the file: no multipart and no base64 around it.
    expect(sent.body).toEqual(step.bytes);
    expect(sent.headers['x-file-name']).toBe(step.name);
    // Added server-side from this container's own environment, and the header name
    // convert-service's auth middleware reads.
    expect(sent.headers['x-convert-token']).toBe(CONVERT_SECRET);
  });

  it('never puts the shared secret in a response', async () => {
    withConvertService();
    convertRespond = () => ({ status: 401, code: 'unauthorized' });
    const posted = await uploadStep(stepFor('secret-leak'));

    const res = await derivedSettled(posted.hash);
    const text = await res.text();
    expect(text).not.toContain(CONVERT_SECRET);
    expect(JSON.parse(text) as unknown).toEqual({
      status: 'failed',
      reason: 'unauthorized',
    });
  });

  it('starts a conversion for a stored file this process has no job for', async () => {
    withConvertService();
    // Written straight to the store rather than uploaded through the api, which is
    // what an api restart mid-conversion leaves behind: the source is safe, the
    // derivative never arrived, and nothing in memory knows a job was running.
    const step = stepFor('recovered');
    const direct = new LocalModelStore(modelsDir);
    const ref = await direct.put(step.bytes, {
      fileName: step.name,
      contentType: 'model/step',
      uploadedAt: '2026-10-15T09:00:00.000Z',
    });

    const first = await fetch(`${base}/api/models/${ref.hash}/derived/glb`);
    expect(first.status).toBe(202);
    await first.body?.cancel();

    const res = await derivedSettled(ref.hash);
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(convertRequests).toHaveLength(1);
  });

  it('answers 404 for a hash nobody stored, and converts nothing for it', async () => {
    withConvertService();
    const res = await fetch(`${base}/api/models/${UNKNOWN_HASH}/derived/glb`);
    // The source route's own vocabulary: no such model. Checking this before
    // starting anything is what stops the route being a way to set convert-service
    // working on a hash that is not in the store.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(convertRequests).toHaveLength(0);
  });

  it('answers 404 unavailable for a stored mesh file, which needs no conversion', async () => {
    withConvertService();
    // Stored directly, so no upload started a job for it: what decides whether
    // there is anything to derive is the STORED file's format, and a mesh has
    // nothing for convert-service to read.
    const mesh = Buffer.concat([Buffer.from('solid mesh', 'ascii'), Buffer.alloc(8, 0x0b)]);
    const ref = await new LocalModelStore(modelsDir).put(mesh, {
      fileName: 'already-a-mesh.obj',
      contentType: 'application/octet-stream',
      uploadedAt: '2026-10-15T09:00:00.000Z',
    });

    const res = await fetch(`${base}/api/models/${ref.hash}/derived/glb`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 'unavailable' });
    expect(convertRequests).toHaveLength(0);
    // …while the source itself still serves, which is the point: an install with
    // no conversion is not an install with no model.
    expect((await fetch(`${base}/api/models/${ref.hash}`)).status).toBe(200);
  });

  it('answers 400 for a segment that routes but is not a hash', async () => {
    withConvertService();
    for (const bad of ['not-a-hash', 'deadbeef', UNKNOWN_HASH.slice(0, 63), `${UNKNOWN_HASH}0`]) {
      const res = await fetch(`${base}/api/models/${bad}/derived/glb`);
      expect(res.status, bad).toBe(400);
      expect(await res.json(), bad).toEqual({ error: 'bad_hash' });
    }
    expect(convertRequests).toHaveLength(0);
  });

  it('answers a traversal attempt with 404, and never reaches the store', async () => {
    // The shim's segment rule rejects `%` and `.`, so an encoded separator is not
    // routable at all and no store ever builds a path out of it. `…/glb/extra`
    // routes fine as segments and simply has no handler under it.
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e', `${UNKNOWN_HASH}/derived/glb/extra`]) {
      const res = await fetch(`${base}/api/models/${bad}/derived/glb`);
      expect(res.status, bad).toBe(404);
    }
  });

  it('refuses a method that is neither GET nor HEAD', async () => {
    const res = await fetch(`${base}/api/models/${UNKNOWN_HASH}/derived/glb`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('the access gate', () => {
  it('refuses all three routes with 401 when the front door is locked', async () => {
    process.env.ACCESS_PASSWORD_HASH = STORED_HASH;

    const post = await upload(GLB_BYTES, 'bracket.glb');
    expect(post.status).toBe(401);
    expect(await post.json()).toEqual({ error: 'locked' });

    const get = await fetch(`${base}/api/models/${GLB_HASH}`);
    expect(get.status).toBe(401);
    expect(await get.json()).toEqual({ error: 'locked' });

    // A derivative is the same geometry in a different encoding, so serving it to
    // an unadmitted caller would undo the gate by another door.
    const derived = await fetch(`${base}/api/models/${GLB_HASH}/derived/glb`);
    expect(derived.status).toBe(401);
    expect(await derived.json()).toEqual({ error: 'locked' });
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

    const derivedRefused = await fetch(`${base}/api/models/${GLB_HASH}/derived/glb`, {
      headers: { cookie: 'vp_access=not-the-token' },
    });
    expect(derivedRefused.status).toBe(401);
  });

  it('stays open on an install with no front-door password', async () => {
    // The pre-existing behaviour: an install that chose to stay open is not
    // locked out by a route that was added later.
    process.env.ACCESS_PASSWORD_HASH = '';
    const res = await upload(GLB_BYTES, 'bracket.glb');
    expect(res.status).toBe(200);
  });
});
