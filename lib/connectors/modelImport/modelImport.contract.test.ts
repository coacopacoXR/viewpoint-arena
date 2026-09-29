// Shared ModelImportAdapter contract test suite.
//
// Any ModelImportAdapter implementation — MockModelImportAdapter,
// OnshapeModelImportAdapter (nightly with live creds),
// GenericUploadModelImportAdapter, or a corp's custom adapter — can be run
// through this suite by calling runModelImportContractTests() with a setup
// function that produces the adapter and test data.
//
// The suite asserts REAL behaviour, not just that methods exist:
//   - return shapes match the interface types (url or blob, not both empty)
//   - unsupported file types produce errors
//   - no adapter method accepts or returns a raw credential

import { describe, it, expect } from 'vitest';
import type {
  ModelImportAdapter,
  ModelImportResult,
  ModelImportSource,
} from './types.ts';
import { MockModelImportAdapter } from './mock.ts';

// Field names that must never appear in adapter arguments or return values.
const CREDENTIAL_FIELD_RE =
  /\b(password|passwd|secret|apiKey|api_key|access_token|refresh_token|client_secret|token|credential)\b/i;

function assertNoCredentialFields(obj: unknown, path = 'root'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (CREDENTIAL_FIELD_RE.test(key)) {
      throw new Error(
        `Credential field "${key}" found at ${path}.${key} — adapter interface must not expose raw credentials`,
      );
    }
    if (typeof value === 'object' && value !== null) {
      assertNoCredentialFields(value, `${path}.${key}`);
    }
  }
}

function assertNoCredentialValues(obj: unknown, path = 'root'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    if (obj.length > 40 && !obj.startsWith('http') && !obj.startsWith('/')) {
      const hexLike = /^[0-9a-f]{32,}$/i.test(obj);
      const base64Like = /^[A-Za-z0-9+/=]{32,}$/.test(obj);
      if (hexLike || base64Like) {
        throw new Error(
          `Possible raw credential value at ${path} (length ${obj.length}) — adapter must not return raw credentials`,
        );
      }
    }
    return;
  }
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoCredentialValues(item, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    assertNoCredentialValues(value, `${path}.${key}`);
  }
}

export interface ModelImportContractSetup {
  adapter: ModelImportAdapter;
  /** A source that should succeed (valid PLM ref or valid upload file). */
  validSource: ModelImportSource;
  /** A source that should fail (e.g. unsupported file type). */
  errorSource: ModelImportSource;
}

export function runModelImportContractTests(
  name: string,
  setup: () =>
    | ModelImportContractSetup
    | Promise<ModelImportContractSetup>,
): void {
  describe(`ModelImportAdapter contract: ${name}`, () => {
    let ctx: ModelImportContractSetup;

    it('translate returns a result with either url or blob set', async () => {
      ctx = await setup();
      const result: ModelImportResult = await ctx.adapter.translate(
        ctx.validSource,
        'gltf',
      );

      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();

      const hasUrl =
        result.url !== undefined && typeof result.url === 'string' && result.url.length > 0;
      const hasBlob =
        result.blob !== undefined && result.blob instanceof Blob && result.blob.size > 0;

      expect(hasUrl || hasBlob).toBe(true);

      // No credential fields in the return value.
      assertNoCredentialFields(result, 'translate.result');
      assertNoCredentialValues(result, 'translate.result');
    });

    it('translate throws on an unsupported source', async () => {
      ctx ??= await setup();
      await expect(
        ctx.adapter.translate(ctx.errorSource, 'gltf'),
      ).rejects.toThrow();
    });

    it('translate does not accept or return credentials', async () => {
      ctx ??= await setup();

      // The source argument must not contain credential-shaped fields.
      assertNoCredentialFields(ctx.validSource, 'translate.source');
      assertNoCredentialFields(ctx.errorSource, 'translate.errorSource');

      // The return value must not contain credential-shaped fields.
      const result = await ctx.adapter.translate(ctx.validSource, 'gltf');
      assertNoCredentialFields(result, 'translate.result');
      assertNoCredentialValues(result, 'translate.result');
    });
  });
}

// ─── Run against MockModelImportAdapter (regular CI path) ────────────────

// Minimal valid GLB header for constructing test File objects.
const MINIMAL_GLB_BYTES = new Uint8Array([
  0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00,
]);

describe('ModelImportAdapter contract suite', () => {
  runModelImportContractTests('MockModelImportAdapter', () => {
    const validGlb = new File([MINIMAL_GLB_BYTES], 'bracket.glb', {
      type: 'model/gltf-binary',
    });
    const unsupportedFile = new File([''], 'model.xyz', {
      type: 'application/octet-stream',
    });

    return {
      adapter: new MockModelImportAdapter(),
      validSource: { kind: 'upload', file: validGlb },
      errorSource: { kind: 'upload', file: unsupportedFile },
    };
  });
});
