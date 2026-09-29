// ModelImportAdapter interface — see docs/plan/02-connector-adapters.md §5.
//
// Every model-import implementation (Onshape, generic upload, mock) implements
// this interface. A shared contract test suite (modelImport.contract.test.ts)
// asserts the behavioural guarantees so any implementation — ours or a corp's —
// can be verified against the same checks.

import type { PLMDocumentRef } from '../plm/types.ts';
import type { HealthCheckResult } from '../../health/types.ts';

/**
 * Discriminated union for the two import modes:
 * - PLM-backed: the adapter fetches and translates a document from a PLM system.
 * - Upload: the user provides a file directly (no PLM).
 */
export type ModelImportSource =
  | { kind: 'plm'; ref: PLMDocumentRef }
  | { kind: 'upload'; file: File };

/**
 * Result of a model import. Exactly one of `url` or `blob` is set:
 * - `url`: a server-side URL the caller can fetch to retrieve the GLB.
 * - `blob`: the raw GLB bytes, ready for the caller to consume.
 */
export interface ModelImportResult {
  url?: string;
  blob?: Blob;
}

export interface ModelImportAdapter {
  /**
   * Import a 3D model from the given source in the requested format.
   *
   * Must never accept or return a raw credential (password, API key, OAuth
   * token). Implementations map the source to whatever server-side state they
   * need to authenticate upstream calls.
   */
  translate(
    source: ModelImportSource,
    format: 'gltf',
  ): Promise<ModelImportResult>;

  /**
   * Is this connector usable right now? Called by GET /api/health.
   *
   * Optional; every adapter in this repo implements it. Must never reject, and
   * must not start a translation: a health check that queues a real CAD export
   * would be slow, may cost money upstream, and would be indistinguishable
   * from a user's import. `detail` must stay free of credentials, env var
   * names and hostnames — see the full rules on PLMAdapter.healthCheck in
   * lib/connectors/plm/types.ts.
   */
  healthCheck?(): Promise<HealthCheckResult>;
}
