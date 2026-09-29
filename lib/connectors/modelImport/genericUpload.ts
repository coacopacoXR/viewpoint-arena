// GenericUploadModelImportAdapter — formalizes the existing generic GLTF/GLB
// loading path in utils/modelLoader.ts as a first-class "no PLM" mode.
//
// This adapter reuses utils/modelLoader.ts for validation (supported
// extensions, size limit) rather than duplicating that logic. The actual
// THREE.js parsing (parseModelFile) is left to the caller — the adapter's
// job is to validate the file and return it as a Blob through the
// ModelImportAdapter interface.

import type {
  ModelImportAdapter,
  ModelImportResult,
  ModelImportSource,
} from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';
import { validateModelFile } from '../../../utils/modelLoader.ts';

export class GenericUploadModelImportAdapter implements ModelImportAdapter {
  async translate(
    source: ModelImportSource,
    format: 'gltf',
  ): Promise<ModelImportResult> {
    if (source.kind !== 'upload') {
      throw new Error(
        'modelImport/genericUpload: source must be a file upload (kind: "upload")',
      );
    }
    if (format !== 'gltf') {
      throw new Error(
        `modelImport/genericUpload: unsupported format: ${format}`,
      );
    }

    // Reuse the validation logic from utils/modelLoader.ts — same extension
    // check and size limit as the direct upload path.
    const validationError = validateModelFile(source.file);
    if (validationError) {
      throw new Error(validationError);
    }

    const arrayBuffer = await source.file.arrayBuffer();
    const blob = new Blob([arrayBuffer], {
      type: source.file.type || 'model/gltf-binary',
    });

    return { blob };
  }

  /**
   * Always ok, and that is a real statement rather than a stub: this mode reads
   * a File the user picked and validates it locally. There is no PLM, no
   * network call and no credential, so nothing can be down. It is what makes a
   * `plm: none` / `modelImport: genericGltf` install report a green /api/health
   * with zero external accounts.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true, detail: HEALTH_DETAILS.selfContained };
  }
}
