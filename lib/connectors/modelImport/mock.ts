// MockModelImportAdapter — deterministic implementation for contract tests.
//
// Mirrors the validation behaviour of the real adapters (extension check for
// uploads, PLM-ref requirement for the Onshape path) so the shared contract
// suite can assert error paths without live infrastructure.

import type {
  ModelImportAdapter,
  ModelImportResult,
  ModelImportSource,
} from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

// Minimal valid GLB header — enough to prove the adapter returns a Blob of
// the right MIME type without shipping a real 3D model in the test suite.
const MINIMAL_GLB = new Uint8Array([
  0x67, 0x6c, 0x54, 0x46, // magic: glTF
  0x02, 0x00, 0x00, 0x00, // version: 2
  0x0c, 0x00, 0x00, 0x00, // total length: 12
]);

const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.fbx', '.stl'];

export class MockModelImportAdapter implements ModelImportAdapter {
  async translate(
    source: ModelImportSource,
    format: 'gltf',
  ): Promise<ModelImportResult> {
    if (format !== 'gltf') {
      throw new Error(`modelImport/mock: unsupported format: ${format}`);
    }

    if (source.kind === 'upload') {
      const ext = source.file.name
        .toLowerCase()
        .slice(source.file.name.lastIndexOf('.'));
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        throw new Error(
          `modelImport/mock: unsupported file type: ${ext}`,
        );
      }
      return {
        blob: new Blob([MINIMAL_GLB], { type: 'model/gltf-binary' }),
      };
    }

    // PLM source — return a deterministic mock URL.
    const ref = source.ref;
    return { url: `mock://model/${ref.id}.glb` };
  }

  /** Nothing external to reach; see GenericUploadModelImportAdapter.healthCheck. */
  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true, detail: HEALTH_DETAILS.selfContained };
  }
}
