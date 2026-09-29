// Browser-side wrappers for the /api/onshape/* serverless functions.
// All requests use credentials: 'include' so the HTTP-only OAuth cookies
// are sent automatically.

export interface OnshapeUser {
  name?: string;
  email?: string;
  image?: string;
  id?: string;
}

export interface OnshapeDocument {
  id: string;
  name: string;
  modifiedAt: string;
  createdAt: string;
  thumbnail?: string;
  defaultWorkspaceId?: string;
  defaultWorkspaceName?: string;
}

export interface OnshapeElement {
  id: string;
  name: string;
  type: 'ASSEMBLY' | 'PARTSTUDIO';
  thumbnail?: string;
}

async function api<T>(path: string): Promise<T | { status: number; error: string }> {
  const resp = await fetch(path, { credentials: 'include' });
  if (!resp.ok) {
    let body: { error?: string } | null = null;
    try { body = await resp.json(); } catch { /* ignore */ }
    return { status: resp.status, error: body?.error || resp.statusText };
  }
  return (await resp.json()) as T;
}

export async function getCurrentOnshapeUser(): Promise<OnshapeUser | null> {
  const result = await api<OnshapeUser>('/api/onshape/me');
  if ('error' in result) return null;
  return result;
}

/**
 * Like getCurrentOnshapeUser but exposes the failure reason for diagnostic UI.
 * Tagged union so callers can narrow safely on `ok`.
 */
export type OnshapeUserResult =
  | { ok: true; user: OnshapeUser }
  | { ok: false; status: number; error: string };

export async function getCurrentOnshapeUserWithStatus(): Promise<OnshapeUserResult> {
  const result = await api<OnshapeUser>('/api/onshape/me');
  if ('error' in result) return { ok: false as const, status: result.status, error: result.error };
  return { ok: true as const, user: result };
}

export type OnshapeDocFilter = 'recent' | 'mine' | 'shared' | 'public';

const FILTER_VALUES: Record<OnshapeDocFilter, string> = {
  recent: '5',
  mine: '0',
  shared: '2',
  public: '4',
};

export async function listOnshapeDocuments(
  query?: string,
  filter: OnshapeDocFilter = 'recent',
): Promise<{ items: OnshapeDocument[]; error?: string }> {
  const params = new URLSearchParams({ filter: FILTER_VALUES[filter] });
  if (query) params.set('q', query);
  const result = await api<{ items: OnshapeDocument[] }>(`/api/onshape/documents?${params.toString()}`);
  if ('error' in result) return { items: [], error: result.error };
  return { items: result.items };
}

export async function listOnshapeElements(
  documentId: string,
  workspaceId: string,
): Promise<{ items: OnshapeElement[]; allTypes: string[] }> {
  // URLSearchParams, not interpolation: these ids come from a URL a PLM system
  // (or a person) supplied, and a raw `&`, `#` or space in one of them would
  // otherwise truncate the query or add a parameter the caller never asked for.
  const params = new URLSearchParams({ d: documentId, w: workspaceId });
  const result = await api<{ items: OnshapeElement[]; allTypes?: string[] }>(
    `/api/onshape/elements?${params.toString()}`,
  );
  if ('error' in result) return { items: [], allTypes: [] };
  return { items: result.items, allTypes: result.allTypes ?? [] };
}

/**
 * Imports an Onshape element as a GLB File. Orchestrates the three-step
 * translation flow in the browser so each underlying serverless function
 * stays well under Vercel's 60s ceiling — works even for large assemblies
 * that take minutes to translate.
 *
 * Calls `onProgress(state)` at each phase so the UI can show what's
 * happening: 'starting' → 'translating' → 'downloading'.
 */
export async function importOnshapeModel(
  documentId: string,
  workspaceId: string,
  elementId: string,
  type: 'ASSEMBLY' | 'PARTSTUDIO',
  onProgress?: (state: 'starting' | 'translating' | 'downloading', elapsedSec: number) => void,
): Promise<File> {
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 1000);

  // 1) Kick off translation.
  onProgress?.('starting', elapsed());
  const startParams = new URLSearchParams({
    d: documentId, w: workspaceId, e: elementId, type,
  });
  const startResp = await fetch(
    `/api/onshape/translate?${startParams.toString()}`,
    { credentials: 'include' },
  );
  if (!startResp.ok) {
    const text = await startResp.text();
    if (text.includes('No visible parts')) {
      throw new Error(
        type === 'ASSEMBLY'
          ? 'This assembly has no visible instances. Add some parts to the assembly in Onshape, then try again.'
          : "This part studio is empty (or all parts are hidden). Model a part or unhide what's there, then try again.",
      );
    }
    if (startResp.status === 401 || startResp.status === 403) {
      throw new Error('Your Onshape session expired or the document moved. Reopen the picker to refresh.');
    }
    throw new Error(`Onshape import failed (${startResp.status}). ${text.slice(0, 200)}`);
  }
  const { id: translationId } = await startResp.json() as { id: string };

  // 2) Poll status. Backoff a bit: fast at first, then slower for big jobs.
  let documentIdOut = '';
  let dataId = '';
  const POLL_INTERVALS = [800, 1500, 1500, 2500, 2500, 4000]; // becomes 5000 thereafter
  let pollIdx = 0;
  // Cap at 10 minutes of polling — covers very large assemblies. Onshape
  // will eventually return FAILED on its own; this is just a guard.
  const POLL_DEADLINE_MS = 10 * 60 * 1000;
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVALS[pollIdx] ?? 5000));
    pollIdx++;
    onProgress?.('translating', elapsed());
    const sResp = await fetch(
      `/api/onshape/translate-status?${new URLSearchParams({ id: translationId }).toString()}`,
      { credentials: 'include' },
    );
    if (!sResp.ok) {
      const text = await sResp.text();
      throw new Error(`Onshape status check failed: ${text.slice(0, 200)}`);
    }
    const status = await sResp.json() as { state: string; documentId?: string; dataId?: string; failureReason?: string };
    if (status.state === 'DONE') {
      if (!status.documentId || !status.dataId) throw new Error('Translation finished but no file id returned');
      documentIdOut = status.documentId;
      dataId = status.dataId;
      break;
    }
    if (status.state === 'FAILED') {
      const reason = status.failureReason || 'Unknown failure';
      if (reason.includes('No visible parts')) {
        throw new Error(
          type === 'ASSEMBLY'
            ? 'This assembly has no visible instances. Add some parts to the assembly in Onshape, then try again.'
            : "This part studio is empty (or all parts are hidden). Model a part or unhide what's there, then try again.",
        );
      }
      throw new Error(reason);
    }
    if (Date.now() - startedAt > POLL_DEADLINE_MS) {
      throw new Error('Onshape translation took longer than 10 minutes — try a smaller model.');
    }
  }

  // 3) Download the GLB.
  onProgress?.('downloading', elapsed());
  const dlParams = new URLSearchParams({ did: documentIdOut, dataId });
  const dlResp = await fetch(
    `/api/onshape/translate-download?${dlParams.toString()}`,
    { credentials: 'include' },
  );
  if (!dlResp.ok) {
    const text = await dlResp.text();
    throw new Error(`Onshape download failed (${dlResp.status}). ${text.slice(0, 200)}`);
  }
  const blob = await dlResp.blob();
  return new File([blob], `onshape-${elementId}.glb`, { type: 'model/gltf-binary' });
}

/** @deprecated kept for compatibility — use importOnshapeModel */
export const fetchOnshapeGltf = importOnshapeModel;

export function startOnshapeSignIn(returnTo: string = window.location.pathname + window.location.search) {
  const url = `/api/onshape/auth-start?return=${encodeURIComponent(returnTo)}`;
  window.location.href = url;
}

export async function signOutOnshape(): Promise<void> {
  await fetch('/api/onshape/sign-out', { method: 'POST', credentials: 'include' });
}
