// Tests for the browser-side Onshape API wrappers (lib/onshape.ts).
//
// The ids these functions put on the wire come from a URL that a PLM system — or
// a person with a text editor — supplied. Interpolated raw, an id containing `&`
// silently adds a parameter to the request, and one containing `#` truncates it.
// Every id now goes through URLSearchParams, and these tests pin that: the URL
// must carry exactly the parameters the caller meant, with the original value
// recoverable by the server.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { listOnshapeElements, importOnshapeModel } from '../onshape.ts';

function stubFetch(handler: (url: string) => Response) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The query of a request URL, parsed the way the serverless handler parses it. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('listOnshapeElements', () => {
  it('encodes an id containing & so it cannot inject a parameter', async () => {
    const { urls } = stubFetch(() => json({ items: [], allTypes: [] }));

    await listOnshapeElements('doc&admin=1', 'ws&x=2');

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('d=doc%26admin%3D1');
    expect(urls[0]).toContain('w=ws%26x%3D2');
    // The server sees two parameters with the original values — not four.
    const params = paramsOf(urls[0]);
    expect([...params.keys()].sort()).toEqual(['d', 'w']);
    expect(params.get('d')).toBe('doc&admin=1');
    expect(params.get('w')).toBe('ws&x=2');
    expect(params.get('admin')).toBeNull();
  });

  it('encodes # and + rather than letting them end the query', async () => {
    const { urls } = stubFetch(() => json({ items: [], allTypes: [] }));

    await listOnshapeElements('doc#frag', 'ws+plus');

    const params = paramsOf(urls[0]);
    expect(params.get('d')).toBe('doc#frag');
    expect(params.get('w')).toBe('ws+plus');
    expect(urls[0]).not.toContain('#frag');
  });

  it('returns the elements the endpoint sent', async () => {
    stubFetch(() =>
      json({
        items: [{ id: 'e1', name: 'Bracket', type: 'PARTSTUDIO' }],
        allTypes: ['PARTSTUDIO', 'DRAWING'],
      }),
    );

    const result = await listOnshapeElements('d1', 'w1');
    expect(result.items).toEqual([{ id: 'e1', name: 'Bracket', type: 'PARTSTUDIO' }]);
    expect(result.allTypes).toEqual(['PARTSTUDIO', 'DRAWING']);
  });
});

describe('importOnshapeModel', () => {
  it('encodes every id in the translation request', async () => {
    // A 500 ends the flow immediately: this test is about the request URL, not
    // about the polling loop.
    const { urls } = stubFetch(() => new Response('kaboom', { status: 500 }));

    await expect(
      importOnshapeModel('d&inject=1', 'w&inject=2', 'e&inject=3', 'ASSEMBLY'),
    ).rejects.toThrow(/500/);

    expect(urls).toHaveLength(1);
    const params = paramsOf(urls[0]);
    expect([...params.keys()].sort()).toEqual(['d', 'e', 'type', 'w']);
    expect(params.get('d')).toBe('d&inject=1');
    expect(params.get('w')).toBe('w&inject=2');
    expect(params.get('e')).toBe('e&inject=3');
    expect(params.get('type')).toBe('ASSEMBLY');
    expect(params.get('inject')).toBeNull();
  });

  it('encodes the translation, document and data ids it is handed back', async () => {
    const { urls } = stubFetch((url) => {
      if (url.startsWith('/api/onshape/translate?')) return json({ id: 'tr&1' });
      if (url.startsWith('/api/onshape/translate-status')) {
        return json({ state: 'DONE', documentId: 'do&c', dataId: 'da&ta' });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const file = await importOnshapeModel('d1', 'w1', 'e1', 'PARTSTUDIO');

    expect(file).toBeInstanceOf(File);
    expect(urls).toHaveLength(3);

    const status = paramsOf(urls[1]);
    expect([...status.keys()]).toEqual(['id']);
    expect(status.get('id')).toBe('tr&1');

    const download = paramsOf(urls[2]);
    expect([...download.keys()].sort()).toEqual(['dataId', 'did']);
    expect(download.get('did')).toBe('do&c');
    expect(download.get('dataId')).toBe('da&ta');
  }, 15000);
});
