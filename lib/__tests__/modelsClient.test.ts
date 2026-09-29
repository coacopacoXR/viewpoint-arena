// @vitest-environment node
//
// The browser's half of model storage.
//
// What matters here is the CACHE, because it is the thing that stands between a
// room and re-downloading a 200 MB assembly: the room server replays the
// current model to every new connection, so a reload, a reconnect and a second
// participant all ask for the same hash within seconds of each other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_DOWNLOAD_FAILED_MESSAGE,
  MODELS_ENDPOINT,
  clearModelFileCache,
  describeUploadFailure,
  fetchModelFile,
  modelDownloadUrl,
  modelFileCacheSize,
  uploadModelFile,
} from '../modelsClient';
import { INVALID_FILE_TYPE_MESSAGE } from '../../utils/modelFormats';

const BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
const HASH = 'a1'.repeat(32);

// ─── A stand-in for XMLHttpRequest ─────────────────────────────────────────
//
// Node has no XHR, and uploadModelFile uses one on purpose: reporting upload
// progress is the one thing fetch still cannot do, and a 200 MB import with no
// progress bar looks like a hang.

interface FakeXhr {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  progress: Array<{ loaded: number; total: number }>;
}

class FakeXMLHttpRequest {
  /** One record per request, for asserting what went out. */
  static sent: FakeXhr[] = [];
  /** The instances themselves, for driving a progress event at one of them. */
  static instances: FakeXMLHttpRequest[] = [];
  static reply: { status: number; response: unknown } = { status: 200, response: null };
  static failNetwork = false;

  status = 0;
  responseType = '';
  response: unknown = null;

  private record: FakeXhr = { method: '', url: '', headers: {}, body: null, progress: [] };
  private listeners: Record<string, () => void> = {};
  private uploadListeners: Record<string, (event: ProgressEvent) => void> = {};

  readonly upload = {
    addEventListener: (type: string, cb: (event: ProgressEvent) => void) => {
      this.uploadListeners[type] = cb;
    },
  };

  constructor() {
    FakeXMLHttpRequest.sent.push(this.record);
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.record.method = method;
    this.record.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.record.headers[name] = value;
  }

  addEventListener(type: string, cb: () => void) {
    this.listeners[type] = cb;
  }

  send(body: unknown) {
    this.record.body = body;
    // Asynchronously, the way a browser does: the caller's promise handlers must
    // not run inside send().
    setTimeout(() => {
      if (FakeXMLHttpRequest.failNetwork) {
        this.listeners.error?.();
        return;
      }
      this.status = FakeXMLHttpRequest.reply.status;
      this.response = FakeXMLHttpRequest.reply.response;
      this.listeners.load?.();
    }, 0);
  }

  /** Drive a progress event, as the browser would during the upload. */
  reportProgress(loaded: number, total: number) {
    const event = { loaded, total, lengthComputable: true } as ProgressEvent;
    this.record.progress.push({ loaded, total });
    this.uploadListeners.progress?.(event);
  }
}

function fileOf(name: string, bytes: Uint8Array = BYTES): File {
  return new File([bytes], name, { type: 'model/gltf-binary' });
}

beforeEach(() => {
  FakeXMLHttpRequest.sent = [];
  FakeXMLHttpRequest.instances = [];
  FakeXMLHttpRequest.reply = { status: 200, response: null };
  FakeXMLHttpRequest.failNetwork = false;
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
  clearModelFileCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearModelFileCache();
});

describe('fetchModelFile', () => {
  function stubFetch(impl: () => Promise<Response>) {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('downloads a hash once and serves a second receive from the cache', async () => {
    const fetchMock = stubFetch(async () => new Response(BYTES, { status: 200 }));

    const first = await fetchModelFile(HASH, 'bracket.glb');
    const second = await fetchModelFile(HASH, 'bracket.glb');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(modelDownloadUrl(HASH));
    // The same File, not a copy: the point is that the bytes are not fetched
    // again, and holding one object is what makes that cheap.
    expect(second).toBe(first);
    expect(first.name).toBe('bracket.glb');
    expect(first.size).toBe(BYTES.byteLength);
    // The MIME comes from the name, because parseModelFile dispatches on the
    // extension and the download is deliberately served as octet-stream.
    expect(first.type).toBe('model/gltf-binary');
  });

  it('shares one download between two receives that arrive together', async () => {
    // The room server replays the current model to a new connection at the same
    // moment a live MODEL_CHANGE can land. Two 200 MB downloads for one room is
    // what caching the PROMISE rather than its result prevents.
    let release: ((value: Response) => void) | null = null;
    const fetchMock = stubFetch(
      () => new Promise<Response>((resolve) => { release = resolve; }),
    );

    const pending = Promise.all([
      fetchModelFile(HASH, 'bracket.glb'),
      fetchModelFile(HASH, 'bracket.glb'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release?.(new Response(BYTES, { status: 200 }));
    const [a, b] = await pending;
    expect(a).toBe(b);
  });

  it('does not cache a failure, so a later receive can succeed', async () => {
    let attempt = 0;
    const fetchMock = stubFetch(async () => {
      attempt += 1;
      return attempt === 1
        ? new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
        : new Response(BYTES, { status: 200 });
    });

    await expect(fetchModelFile(HASH, 'bracket.glb')).rejects.toThrow(
      MODEL_DOWNLOAD_FAILED_MESSAGE,
    );
    expect(modelFileCacheSize()).toBe(0);

    const file = await fetchModelFile(HASH, 'bracket.glb');
    expect(file.size).toBe(BYTES.byteLength);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network failure either', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchModelFile(HASH, 'bracket.glb')).rejects.toThrow(
      MODEL_DOWNLOAD_FAILED_MESSAGE,
    );
    expect(modelFileCacheSize()).toBe(0);
  });

  it('keeps a bounded number of models, evicting the oldest', async () => {
    stubFetch(async () => new Response(BYTES, { status: 200 }));
    const hashes = ['1', '2', '3', '4', '5'].map((n) => n.repeat(64));
    for (const hash of hashes) await fetchModelFile(hash, 'm.glb');
    // A model file can be 200 MB, so the bound is a memory bound: three is what
    // "switch back to the revision that was just on screen" needs, and the
    // browser's own immutable cache covers everything past it.
    expect(modelFileCacheSize()).toBe(3);
    // The newest survived; the oldest went.
    const fetchMock = vi.fn(async () => new Response(BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchModelFile(hashes[4] ?? '', 'm.glb');
    expect(fetchMock).not.toHaveBeenCalled();
    await fetchModelFile(hashes[0] ?? '', 'm.glb');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an /api path answered with HTML instead of a file', async () => {
    // `vite preview` answers every /api/* route with index.html, and so does a
    // proxy that lost the /api location. Passing that to parseModelFile would
    // produce a three.js error about a corrupt glTF and send whoever is
    // debugging it looking at the model instead of at the deployment.
    stubFetch(
      async () =>
        new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(fetchModelFile(HASH, 'bracket.glb')).rejects.toThrow(
      MODEL_DOWNLOAD_FAILED_MESSAGE,
    );
    expect(modelFileCacheSize()).toBe(0);
  });
});

describe('uploadModelFile', () => {
  it('posts the file to /api/models with its name percent-encoded', async () => {
    FakeXMLHttpRequest.reply = {
      status: 200,
      response: { hash: HASH, size: BYTES.byteLength, fileName: 'ignored.glb' },
    };
    const file = fileOf('Bügel — Rev B.step');
    const result = await uploadModelFile(file);

    expect(FakeXMLHttpRequest.sent).toHaveLength(1);
    const sent = FakeXMLHttpRequest.sent[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe(MODELS_ENDPOINT);
    // Encoded because an HTTP header value is ISO-8859-1 and part names are not
    // always ASCII; the handler decodes it and stores what was really meant.
    expect(sent?.headers['X-File-Name']).toBe(encodeURIComponent('Bügel — Rev B.step'));
    expect(sent?.body).toBe(file);
    // The name the caller gets back is the one they picked, not whatever the
    // server echoed: it is the name that goes into the broadcast reference.
    expect(result).toEqual({ hash: HASH, size: BYTES.byteLength, fileName: 'Bügel — Rev B.step' });
  });

  it('reports progress, and ends at 1', async () => {
    FakeXMLHttpRequest.reply = { status: 200, response: { hash: HASH, size: 4 } };
    const seen: number[] = [];
    const pending = uploadModelFile(fileOf('a.glb'), (fraction) => seen.push(fraction));
    // Driven at the instance, after it registered its listeners and before the
    // response arrives — the order a real upload happens in.
    FakeXMLHttpRequest.instances[0]?.reportProgress(2, 4);
    await pending;
    expect(seen).toEqual([0.5, 1]);
  });

  it('refuses a 200 whose body is not our JSON', async () => {
    // The SPA fallback answering an /api path: a 200, and HTML. Broadcasting an
    // undefined hash to the room would be worse than failing here.
    FakeXMLHttpRequest.reply = { status: 200, response: null };
    await expect(uploadModelFile(fileOf('a.glb'))).rejects.toThrow(/could not reach the server/i);
  });

  it('translates a 413 into the size message', async () => {
    FakeXMLHttpRequest.reply = { status: 413, response: { error: 'file_too_large' } };
    await expect(uploadModelFile(fileOf('a.glb'))).rejects.toThrow(/too large/i);
  });

  it('translates a network failure into something a person can act on', async () => {
    FakeXMLHttpRequest.failNetwork = true;
    await expect(uploadModelFile(fileOf('a.glb'))).rejects.toThrow(/could not reach the server/i);
  });
});

describe('describeUploadFailure', () => {
  it('maps each code the api can answer with', () => {
    expect(describeUploadFailure(413)).toMatch(/200MB/);
    expect(describeUploadFailure(415)).toBe(INVALID_FILE_TYPE_MESSAGE);
    expect(describeUploadFailure(401)).toMatch(/password-protected/);
    expect(describeUploadFailure(503)).toMatch(/storage is not available/i);
  });

  it('falls back to the network message for a code it does not know', () => {
    // The api only answers with short machine codes; showing one of those to a
    // person who wanted to look at a bracket is not an explanation.
    expect(describeUploadFailure(500)).toMatch(/could not reach the server/i);
    expect(describeUploadFailure(418)).toMatch(/could not reach the server/i);
  });
});
