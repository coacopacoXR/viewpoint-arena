import type {
  PLMAdapter,
  PLMAuthContext,
  PLMDocumentRef,
  PLMElement,
} from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';
import { isGenericPlmId } from './launchParams.ts';

// In-memory catalogue the mock uses to respond to lookups. Kept small and
// deterministic so contract tests can assert exact shapes.
const MOCK_DOCS: Array<PLMDocumentRef & { name: string }> = [
  { id: 'mock-doc-1', workspaceId: 'mock-ws-1', name: 'Mock Bracket' },
  { id: 'mock-doc-2', workspaceId: 'mock-ws-2', name: 'Mock Housing' },
];

const MOCK_ELEMENTS: Record<string, PLMElement[]> = {
  'mock-doc-1': [
    { id: 'mock-elem-1a', name: 'Bracket Part Studio', type: 'PARTSTUDIO' },
    { id: 'mock-elem-1b', name: 'Bracket Assembly', type: 'ASSEMBLY' },
  ],
  'mock-doc-2': [
    { id: 'mock-elem-2a', name: 'Housing Part Studio', type: 'PARTSTUDIO' },
  ],
};

// Minimal valid GLB: header only (version 2, 12-byte header + 0-byte JSON
// chunk placeholder). Enough to prove the adapter returns a Blob of the
// right MIME type without shipping a real 3D model in the test suite.
const MINIMAL_GLB = new Uint8Array([
  0x67, 0x6c, 0x54, 0x46, // magic: glTF
  0x02, 0x00, 0x00, 0x00, // version: 2
  0x0c, 0x00, 0x00, 0x00, // total length: 12
]);

export class PLMNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PLMNotFoundError';
  }
}

export class MockPLMAdapter implements PLMAdapter {
  authStartPath = '/api/mock/auth-start';

  async listDocuments(_auth: PLMAuthContext): Promise<PLMDocumentRef[]> {
    return MOCK_DOCS.map(({ id, workspaceId }) => ({ id, workspaceId }));
  }

  async getElement(
    _auth: PLMAuthContext,
    ref: PLMDocumentRef,
  ): Promise<PLMElement> {
    const elements = MOCK_ELEMENTS[ref.id];
    if (!elements) {
      throw new PLMNotFoundError(`Document not found: ${ref.id}`);
    }
    if (ref.elementId) {
      const el = elements.find((e) => e.id === ref.elementId);
      if (!el) {
        throw new PLMNotFoundError(
          `Element not found: ${ref.elementId} in ${ref.id}`,
        );
      }
      return el;
    }
    return elements[0];
  }

  async exportGeometry(
    _auth: PLMAuthContext,
    ref: PLMDocumentRef,
    _format: 'gltf',
  ): Promise<Blob> {
    if (!MOCK_ELEMENTS[ref.id]) {
      throw new PLMNotFoundError(`Document not found: ${ref.id}`);
    }
    return new Blob([MINIMAL_GLB], { type: 'model/gltf-binary' });
  }

  async resolveLaunchContext(
    query: Record<string, string>,
  ): Promise<{ roomHint: string; doc: PLMDocumentRef } | null> {
    if (query.plmSource !== 'mock') return null;
    const docId = query.plmDoc;
    // Shape check before the catalogue lookup, matching the real adapters: a
    // caller must not be able to tell "rejected as malformed" from "not in the
    // catalogue", and the id is never echoed unless it passed.
    if (!docId || !isGenericPlmId(docId)) return null;
    const doc = MOCK_DOCS.find((d) => d.id === docId);
    if (!doc) return null;
    return {
      // A label only, never a room id — see PLMAdapter.resolveLaunchContext.
      roomHint: `mock-room-${doc.id}`,
      doc: { id: doc.id, workspaceId: doc.workspaceId },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    // The mock reads an in-module catalogue, so there is nothing that can be
    // down. Reporting ok unconditionally is the honest answer, and it is what
    // makes a default install's /api/health green with zero accounts.
    return { ok: true, detail: HEALTH_DETAILS.selfContained };
  }
}
