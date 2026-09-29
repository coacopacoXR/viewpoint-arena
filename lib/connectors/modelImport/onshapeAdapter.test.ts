// Direct unit tests for OnshapeModelImportAdapter with stubbed fetch.
//
// The shared contract suite runs against MockModelImportAdapter, and the live
// Onshape run needs sandbox credentials it cannot have in CI — which left the
// real adapter with no executed coverage at all. These tests stub global fetch
// so the adapter's request construction and response mapping are exercised for
// real, without credentials.
//
// Pattern mirrors lib/connectors/plm/onshapeAdapter.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OnshapeModelImportAdapter } from './onshape.ts';

function stubFetch(
  handler: (url: string, init: RequestInit) => Response,
) {
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

describe('OnshapeModelImportAdapter', () => {
  it('builds the translate-start URL with document, workspace, and element IDs', async () => {
    let callCount = 0;
    const fetchSpy = stubFetch(() => {
      callCount++;
      if (callCount === 1) return json({ id: 'txn-1' });
      return json({ state: 'DONE', documentId: 'doc-1', dataId: 'data-1' });
    });

    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });
    await adapter.translate(
      {
        kind: 'plm',
        ref: { id: 'doc1', workspaceId: 'ws1', elementId: 'elem1' },
      },
      'gltf',
    );

    const startUrl = String(fetchSpy.mock.calls[0][0]);
    expect(startUrl).toContain('/api/onshape/translate');
    expect(startUrl).toContain('d=doc1');
    expect(startUrl).toContain('w=ws1');
    expect(startUrl).toContain('e=elem1');
    expect(startUrl).toContain('type=PARTSTUDIO');
  });

  it('polls translate-status until DONE and returns the download URL', async () => {
    let pollCount = 0;
    stubFetch((url) => {
      if (url.includes('/api/onshape/translate?')) {
        return json({ id: 'txn-2' });
      }
      if (url.includes('/api/onshape/translate-status')) {
        pollCount++;
        if (pollCount < 3) {
          return json({ state: 'IN_PROGRESS' });
        }
        return json({
          state: 'DONE',
          documentId: 'doc-9',
          dataId: 'data-9',
        });
      }
      return json({}, 404);
    });

    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });
    const result = await adapter.translate(
      {
        kind: 'plm',
        ref: { id: 'doc1', workspaceId: 'ws1', elementId: 'elem1' },
      },
      'gltf',
    );

    expect(result.url).toBeDefined();
    expect(result.url).toContain('/api/onshape/translate-download');
    expect(result.url).toContain('did=doc-9');
    expect(result.url).toContain('dataId=data-9');
    expect(pollCount).toBe(3);
  });

  it('throws when translation start returns a non-OK status', async () => {
    stubFetch(() => json({ error: 'bad request' }, 400));

    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });
    await expect(
      adapter.translate(
        {
          kind: 'plm',
          ref: { id: 'doc1', workspaceId: 'ws1', elementId: 'elem1' },
        },
        'gltf',
      ),
    ).rejects.toThrow(/translation start failed \(400\)/);
  });

  it('throws when translation status reports FAILED', async () => {
    let callCount = 0;
    stubFetch(() => {
      callCount++;
      if (callCount === 1) return json({ id: 'txn-3' });
      return json({ state: 'FAILED', failureReason: 'mesh too complex' });
    });

    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });
    await expect(
      adapter.translate(
        {
          kind: 'plm',
          ref: { id: 'doc1', workspaceId: 'ws1', elementId: 'elem1' },
        },
        'gltf',
      ),
    ).rejects.toThrow(/mesh too complex/);
  });

  it('throws when ref is missing workspaceId or elementId', async () => {
    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });

    await expect(
      adapter.translate(
        { kind: 'plm', ref: { id: 'doc1' } },
        'gltf',
      ),
    ).rejects.toThrow(/workspaceId and elementId/);
  });

  it('throws when source is an upload instead of a PLM ref', async () => {
    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });
    const file = new File([''], 'model.glb', { type: 'model/gltf-binary' });

    await expect(
      adapter.translate({ kind: 'upload', file }, 'gltf'),
    ).rejects.toThrow(/PLM reference/);
  });

  it('never puts the document ID in a credential-shaped position', async () => {
    let callCount = 0;
    const fetchSpy = stubFetch(() => {
      callCount++;
      if (callCount === 1) return json({ id: 'txn-4' });
      return json({ state: 'DONE', documentId: 'doc-1', dataId: 'data-1' });
    });

    const adapter = new OnshapeModelImportAdapter({ pollIntervalMs: 0 });
    const result = await adapter.translate(
      {
        kind: 'plm',
        ref: { id: 'doc1', workspaceId: 'ws1', elementId: 'elem1' },
      },
      'gltf',
    );

    // The result URL is a relative path, not a credential.
    expect(result.url).toMatch(/^\/api\//);
    // No fetch call URL contains anything that looks like a raw token.
    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toMatch(/Bearer/i);
    }
  });
});
