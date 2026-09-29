// OnshapeModelImportAdapter — wraps the existing api/onshape/translate*.ts
// three-step flow (start → poll → download) behind the ModelImportAdapter
// interface. This is a reorganization: the request shapes and polling logic
// are preserved from the existing endpoints, not redesigned.
//
// The adapter calls the browser-reachable Vercel endpoints
// (/api/onshape/translate, /api/onshape/translate-status,
// /api/onshape/translate-download) rather than the Onshape API directly.
// This keeps the adapter browser-safe — no OAuth tokens in its arguments.

import type {
  ModelImportAdapter,
  ModelImportResult,
  ModelImportSource,
} from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

export interface OnshapeModelImportOpts {
  /** Override for globalThis.fetch — for testing only. */
  fetchFn?: typeof globalThis.fetch;
  /** Polling interval in ms. Defaults to 2000 (matches existing browser flow). */
  pollIntervalMs?: number;
}

export class OnshapeModelImportAdapter implements ModelImportAdapter {
  private _fetch: typeof globalThis.fetch;
  private _pollIntervalMs: number;

  constructor(opts?: OnshapeModelImportOpts) {
    this._fetch =
      opts?.fetchFn ?? globalThis.fetch.bind(globalThis);
    this._pollIntervalMs = opts?.pollIntervalMs ?? 2000;
  }

  async translate(
    source: ModelImportSource,
    format: 'gltf',
  ): Promise<ModelImportResult> {
    if (source.kind !== 'plm') {
      throw new Error(
        'modelImport/onshape: source must be a PLM reference (kind: "plm")',
      );
    }
    if (format !== 'gltf') {
      throw new Error(
        `modelImport/onshape: unsupported format: ${format}`,
      );
    }

    const ref = source.ref;
    if (!ref.workspaceId || !ref.elementId) {
      throw new Error(
        'modelImport/onshape: ref requires workspaceId and elementId',
      );
    }

    // Step 1: Start translation — mirrors api/onshape/translate.ts.
    // The existing endpoint requires the element type; default to PARTSTUDIO
    // since the adapter doesn't have a way to detect it without an extra API
    // call. A future enhancement could query the element type first.
    const elementType = 'PARTSTUDIO';
    const startUrl =
      `/api/onshape/translate` +
      `?d=${encodeURIComponent(ref.id)}` +
      `&w=${encodeURIComponent(ref.workspaceId)}` +
      `&e=${encodeURIComponent(ref.elementId)}` +
      `&type=${elementType}`;

    const startResp = await this._fetch(startUrl);
    if (!startResp.ok) {
      throw new Error(
        `modelImport/onshape: translation start failed (${startResp.status})`,
      );
    }
    const startData = (await startResp.json()) as { id?: string };
    if (!startData.id) {
      throw new Error('modelImport/onshape: translation returned no id');
    }
    const translationId = startData.id;

    // Step 2: Poll status — mirrors api/onshape/translate-status.ts.
    let docId = ref.id;
    let dataId: string | undefined;
    const maxPolls = 60;

    for (let i = 0; i < maxPolls; i++) {
      if (this._pollIntervalMs > 0) {
        await new Promise((r) => setTimeout(r, this._pollIntervalMs));
      }

      const statusResp = await this._fetch(
        `/api/onshape/translate-status?id=${encodeURIComponent(translationId)}`,
      );
      if (!statusResp.ok) {
        throw new Error(
          `modelImport/onshape: status check failed (${statusResp.status})`,
        );
      }
      const status = (await statusResp.json()) as {
        state: string;
        documentId?: string;
        dataId?: string;
        failureReason?: string;
      };

      if (status.state === 'DONE') {
        docId = status.documentId || ref.id;
        dataId = status.dataId;
        break;
      }
      if (status.state === 'FAILED') {
        throw new Error(
          `modelImport/onshape: translation failed: ${status.failureReason || 'unknown'}`,
        );
      }
      if (i === maxPolls - 1) {
        throw new Error('modelImport/onshape: translation timed out');
      }
    }

    if (!dataId) {
      throw new Error('modelImport/onshape: translation done but no data id');
    }

    // Step 3: Return the download URL — mirrors api/onshape/translate-download.ts.
    // The browser fetches this URL to get the GLB binary.
    const url =
      `/api/onshape/translate-download` +
      `?did=${encodeURIComponent(docId)}` +
      `&dataId=${encodeURIComponent(dataId)}`;

    return { url };
  }

  /**
   * Is the translate route this adapter drives deployed and answering?
   *
   * It probes with NO query parameters, which is the point: the handler
   * validates `d`/`w`/`e`/`type` first and answers 400 (or 401 from its auth
   * wrapper), so the probe proves the route exists and ran without starting a
   * translation. Starting a real GLTF export on every health poll would queue
   * work on the customer's Onshape tenant and cost minutes.
   *
   * Only the status code is read. The 400 body and any auth detail are
   * discarded, and the detail is a fixed phrase — no route path, no document id
   * and no upstream text reaches the response.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    let status: number;
    try {
      const response = await this._fetch('/api/onshape/translate');
      status = response.status;
    } catch {
      return { ok: false, detail: HEALTH_DETAILS.unreachable };
    }
    if (status === 404) {
      return { ok: false, detail: HEALTH_DETAILS.routeUnavailable };
    }
    if (status >= 500) {
      return { ok: false, detail: HEALTH_DETAILS.upstreamError };
    }
    return { ok: true, detail: HEALTH_DETAILS.routeReachable };
  }
}
