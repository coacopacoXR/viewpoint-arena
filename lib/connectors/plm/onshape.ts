// Onshape PLMAdapter — reorganizes the existing api/onshape/* logic behind
// the PLMAdapter interface. Does NOT rewrite the OAuth flow or session
// handling; the HttpOnly-cookie pattern in api/_lib/onshape.ts is preserved
// exactly. Existing api/onshape/* endpoints are untouched.
//
// The adapter uses a server-side session store so that PLMAuthContext carries
// an opaque session ID rather than a raw OAuth token. A Vercel function (or
// any server-side caller) creates the context via createOnshapeAuthContext()
// after extracting the access token through the existing cookie-based auth.

import type {
  PLMAdapter,
  PLMAuthContext,
  PLMDocumentRef,
  PLMElement,
} from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';
import { isOnshapeId } from './launchParams.ts';

const ONSHAPE_API = 'https://cad.onshape.com';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

interface SessionData {
  accessToken: string;
  createdAt: number;
}

const sessions = new Map<string, SessionData>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

/**
 * Create a PLMAuthContext from a server-side access token.
 *
 * Callers (Vercel functions) obtain the token through the existing
 * HttpOnly-cookie flow in api/_lib/onshape.ts (getAuthedToken), then pass
 * it here. The returned context carries an opaque session ID — never the
 * raw token — so it is safe to pass through the PLMAdapter interface.
 */
export function createOnshapeAuthContext(accessToken: string): PLMAuthContext {
  purgeExpired();
  // globalThis.crypto, not node:crypto. This module is imported by the
  // browser-side launch page (pages/LaunchPage.tsx) as well as by server code,
  // and a `node:` specifier would land in the client bundle. randomUUID() is
  // present in every runtime this repo targets (Node 19+, all evergreen
  // browsers), and the rest of the app already calls it unguarded.
  const id = globalThis.crypto.randomUUID();
  sessions.set(id, { accessToken, createdAt: Date.now() });
  return { sessionRef: id };
}

/** Remove a session. Call when the user signs out. */
export function destroyOnshapeAuthContext(auth: PLMAuthContext): void {
  sessions.delete(auth.sessionRef);
}

function getToken(auth: PLMAuthContext): string {
  const session = sessions.get(auth.sessionRef);
  if (!session) throw new Error('plm/onshape: invalid or expired session');
  return session.accessToken;
}

async function onshapeFetch(
  auth: PLMAuthContext,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getToken(auth);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Accept'))
    headers.set('Accept', 'application/json;charset=UTF-8;qs=0.09');
  const url = path.startsWith('http') ? path : `${ONSHAPE_API}${path}`;
  return fetch(url, { ...init, headers });
}

// Normalize Onshape's element type fields into a single uppercase string.
// This DUPLICATES api/onshape/elements.ts rather than importing it: that file
// is a Vercel handler, and importing it here would pull the serverless runtime
// into the adapter's import graph. The duplication is deliberate but dangerous
// — onshapeTypeDrift.test.ts fails if the two copies ever diverge.
export const TYPE_INT_TO_STR: Record<number, string> = {
  0: 'PARTSTUDIO',
  1: 'ASSEMBLY',
  2: 'DRAWING',
  3: 'BLOB',
  4: 'APPLICATION',
  5: 'TABLE',
  6: 'BILLOFMATERIALS',
  7: 'FEATURESTUDIO',
  8: 'PUBLICATIONITEM',
  9: 'VARIABLESTUDIO',
};

export function normalizeElementType(e: {
  elementType?: string;
  type?: string | number;
}): string {
  if (e.elementType) return e.elementType.toUpperCase().replace(/\s+/g, '');
  if (typeof e.type === 'string') return e.type.toUpperCase().replace(/\s+/g, '');
  if (typeof e.type === 'number') return TYPE_INT_TO_STR[e.type] ?? '';
  return '';
}

export class OnshapePLMAdapter implements PLMAdapter {
  authStartPath = '/api/onshape/auth-start';

  async listDocuments(auth: PLMAuthContext): Promise<PLMDocumentRef[]> {
    const resp = await onshapeFetch(
      auth,
      '/api/v9/documents?limit=20&filter=5',
    );
    if (!resp.ok) {
      throw new Error(
        `plm/onshape: listDocuments failed (${resp.status})`,
      );
    }
    const data = (await resp.json()) as {
      items: Array<{ id: string; defaultWorkspace?: { id: string } }>;
    };
    return (data.items || []).map((d) => ({
      id: d.id,
      workspaceId: d.defaultWorkspace?.id,
    }));
  }

  async getElement(
    auth: PLMAuthContext,
    ref: PLMDocumentRef,
  ): Promise<PLMElement> {
    if (!ref.workspaceId) {
      throw new Error('plm/onshape: getElement requires workspaceId');
    }
    const resp = await onshapeFetch(
      auth,
      `/api/v9/documents/d/${ref.id}/w/${ref.workspaceId}/elements`,
    );
    if (resp.status === 404) {
      throw new Error(`plm/onshape: document not found: ${ref.id}`);
    }
    if (!resp.ok) {
      throw new Error(
        `plm/onshape: getElement failed (${resp.status})`,
      );
    }
    const items = (await resp.json()) as Array<{
      id: string;
      name: string;
      elementType?: string;
      type?: string | number;
    }>;

    const normalized = items.map((e) => ({
      id: e.id,
      name: e.name,
      type: normalizeElementType(e),
    }));

    const usable = normalized.filter(
      (e) => e.type === 'ASSEMBLY' || e.type === 'PARTSTUDIO',
    );

    if (ref.elementId) {
      const match = usable.find((e) => e.id === ref.elementId);
      if (!match) {
        throw new Error(
          `plm/onshape: element not found: ${ref.elementId} in ${ref.id}`,
        );
      }
      return match;
    }
    if (usable.length === 0) {
      throw new Error(
        `plm/onshape: no usable elements in document ${ref.id}`,
      );
    }
    return usable[0];
  }

  async exportGeometry(
    auth: PLMAuthContext,
    ref: PLMDocumentRef,
    format: 'gltf',
  ): Promise<Blob> {
    if (format !== 'gltf') {
      throw new Error(`plm/onshape: unsupported format: ${format}`);
    }
    if (!ref.workspaceId || !ref.elementId) {
      throw new Error(
        'plm/onshape: exportGeometry requires workspaceId and elementId',
      );
    }

    // Determine element type to pick the right translation endpoint.
    const element = await this.getElement(auth, ref);
    const isAssembly = element.type === 'ASSEMBLY';
    const basePath = isAssembly
      ? `/api/v9/assemblies/d/${ref.id}/w/${ref.workspaceId}/e/${ref.elementId}/translations`
      : `/api/v9/partstudios/d/${ref.id}/w/${ref.workspaceId}/e/${ref.elementId}/translations`;

    // Start translation.
    const startResp = await onshapeFetch(auth, basePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        formatName: 'GLTF',
        storeInDocument: false,
        resolution: 'medium',
      }),
    });
    if (!startResp.ok) {
      throw new Error(
        `plm/onshape: translation start failed (${startResp.status})`,
      );
    }
    const handle = (await startResp.json()) as { id?: string };
    if (!handle.id) {
      throw new Error('plm/onshape: translation returned no id');
    }

    // Poll until done.
    const maxPolls = 60;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const statusResp = await onshapeFetch(
        auth,
        `/api/v9/translations/${handle.id}`,
      );
      if (!statusResp.ok) {
        throw new Error(
          `plm/onshape: translation status failed (${statusResp.status})`,
        );
      }
      const status = (await statusResp.json()) as {
        requestState: string;
        resultExternalDataIds?: string[];
        documentId?: string;
        failureReason?: string;
      };
      if (status.requestState === 'DONE') {
        const dataId = status.resultExternalDataIds?.[0];
        const docId = status.documentId || ref.id;
        if (!dataId) {
          throw new Error('plm/onshape: translation done but no data id');
        }
        const dlResp = await onshapeFetch(
          auth,
          `/api/v9/documents/d/${docId}/externaldata/${dataId}`,
        );
        if (!dlResp.ok) {
          throw new Error(
            `plm/onshape: download failed (${dlResp.status})`,
          );
        }
        const buf = await dlResp.arrayBuffer();
        return new Blob([buf], { type: 'model/gltf-binary' });
      }
      if (status.requestState === 'FAILED') {
        throw new Error(
          `plm/onshape: translation failed: ${status.failureReason || 'unknown'}`,
        );
      }
    }
    throw new Error('plm/onshape: translation timed out');
  }

  async resolveLaunchContext(
    query: Record<string, string>,
  ): Promise<{ roomHint: string; doc: PLMDocumentRef } | null> {
    if (query.plmSource !== 'onshape') return null;
    const docId = query.plmDoc;
    // Re-validate here even though lib/connectors/plm/launchParams.ts already
    // did: a corp wiring this adapter into its own launch handler must not
    // depend on that module having run first. An id that is not 24 hex chars
    // is rejected outright — never echoed back, never used to build a URL.
    if (!docId || !isOnshapeId(docId)) return null;
    const workspaceId = query.plmWorkspace;
    if (workspaceId && !isOnshapeId(workspaceId)) return null;
    const elementId = query.plmElement;
    if (elementId && !isOnshapeId(elementId)) return null;
    return {
      // A label only. See PLMAdapter.resolveLaunchContext: the caller must NOT
      // use this as a room id, because it is derived from a document id that
      // everyone with access to the document can see.
      roomHint: `onshape-${docId}`,
      doc: { id: docId, workspaceId, elementId },
    };
  }

  /**
   * Reachability of the Onshape API host, unauthenticated.
   *
   * Deliberately does NOT authenticate. A real check would need a session, and
   * /api/health is polled by an unauthenticated dashboard and by install.sh:
   * minting or reusing an OAuth session on every poll would spend a user's
   * token budget to answer "is the network path there". Any HTTP answer at all
   * — including 401 and 404 — means the host resolved and answered, which is
   * the only thing this can honestly claim without a credential.
   *
   * Probes the module's ONSHAPE_API constant rather than the config's
   * plm.baseUrl: this adapter does not take a base URL, and adding one is
   * T3.1's reorganisation, not a health check's business.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    try {
      // A network-level answer is the result; the body is never read, so no
      // upstream text can be repeated anywhere.
      const response = await fetch(`${ONSHAPE_API}/api/v9/documents`, {
        method: 'HEAD',
      });
      // 401/404 mean the host answered and we simply sent no credential, which
      // is the point of an unauthenticated probe. 5xx means Onshape itself is
      // unhealthy, which the deployment does want to see.
      if (response.status >= 500) {
        return { ok: false, detail: HEALTH_DETAILS.upstreamError };
      }
      return { ok: true, detail: HEALTH_DETAILS.reachable };
    } catch {
      // fetch's own message is dropped: it embeds the URL, and the URL is an
      // internal detail of this deployment.
      return { ok: false, detail: HEALTH_DETAILS.unreachable };
    }
  }
}
