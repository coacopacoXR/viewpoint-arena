import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  OnshapePLMAdapter,
  createOnshapeAuthContext,
  destroyOnshapeAuthContext,
} from './onshape.ts';

// The shared contract suite runs against MockPLMAdapter, and the live Onshape
// run needs sandbox credentials it cannot have in CI — which left the real
// adapter with no executed coverage at all. These tests stub global fetch so
// the adapter's request construction and response mapping are exercised for
// real, without credentials.

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OnshapePLMAdapter', () => {
  it('sends the bearer token and maps documents to PLMDocumentRef', async () => {
    const fetchSpy = stubFetch(() =>
      json({
        items: [
          { id: 'doc1', defaultWorkspace: { id: 'ws1' } },
          { id: 'doc2' },
        ],
      }),
    );
    const auth = createOnshapeAuthContext('tok-abc');
    const docs = await new OnshapePLMAdapter().listDocuments(auth);

    expect(docs).toEqual([
      { id: 'doc1', workspaceId: 'ws1' },
      { id: 'doc2', workspaceId: undefined },
    ]);

    const url = String(fetchSpy.mock.calls[0][0]);
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect(url).toContain('/api/v9/documents');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-abc');
    destroyOnshapeAuthContext(auth);
  });

  it('never puts the access token in the URL', async () => {
    const fetchSpy = stubFetch(() => json({ items: [] }));
    const auth = createOnshapeAuthContext('super-secret-token');
    await new OnshapePLMAdapter().listDocuments(auth);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).not.toContain('super-secret-token');
    destroyOnshapeAuthContext(auth);
  });

  it('surfaces a 404 as a document-not-found error', async () => {
    stubFetch(() => json({}, 404));
    const auth = createOnshapeAuthContext('tok');
    await expect(
      new OnshapePLMAdapter().getElement(auth, { id: 'missing', workspaceId: 'ws' }),
    ).rejects.toThrow(/not found/i);
    destroyOnshapeAuthContext(auth);
  });

  it('fails loudly rather than silently on a non-OK response', async () => {
    stubFetch(() => json({}, 500));
    const auth = createOnshapeAuthContext('tok');
    await expect(new OnshapePLMAdapter().listDocuments(auth)).rejects.toThrow(/500/);
    destroyOnshapeAuthContext(auth);
  });

  it('rejects a session reference that was destroyed', async () => {
    stubFetch(() => json({ items: [] }));
    const auth = createOnshapeAuthContext('tok');
    destroyOnshapeAuthContext(auth);
    await expect(new OnshapePLMAdapter().listDocuments(auth)).rejects.toThrow(
      /invalid or expired session/,
    );
  });

  it('does not expose the raw token on the auth context', () => {
    const auth = createOnshapeAuthContext('leaky-token');
    expect(JSON.stringify(auth)).not.toContain('leaky-token');
    destroyOnshapeAuthContext(auth);
  });
});
