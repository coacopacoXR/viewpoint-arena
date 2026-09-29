// Moving a curated review's model out of the row and into storage.
//
// A curation saved before models were stored by hash carries the file itself,
// base64-encoded, inside `review_curations.asset` — a jsonb column. That is the
// thing this migration removes: a 40 MB STEP file became a 53 MB string in a
// database column, was read back into every browser that opened the review, and
// could not be shared with a room at all because the socket had its own, much
// smaller, cap.
//
// It runs ONCE per curation, on a load path, and is safe to call on anything:
//
//   * an asset that already has a `modelHash` is returned as it is and NOTHING
//     is uploaded — the check comes first, so a page reload, a realtime echo
//     and a second curator opening the same review all cost one property test;
//   * an asset with no file in it is returned as it is;
//   * a failure to upload is reported in the result rather than thrown, because
//     this is called while somebody is waiting for their review to open. The
//     asset comes back unchanged, the legacy bytes stay where they were so the
//     model still renders, and the next load tries again.
//
// The uploader is a parameter so a test can count calls without a network. The
// default is the real one.

import { uploadModelFile } from './modelsClient';
import { modelFileMime } from '../utils/modelFormats';
import type { ReviewAsset } from './reviewSetupStore';

/** What an uploader has to hand back. Matches lib/modelsClient.ts's result. */
export interface StoredModel {
  hash: string;
  size: number;
  fileName: string;
}

export type UploadModel = (file: File) => Promise<StoredModel>;

export interface CurationAssetMigration {
  /** The asset to use from here on. Unchanged unless `migrated` is true. */
  asset: ReviewAsset;
  /** True when the asset changed and the new version is worth writing back. */
  migrated: boolean;
  /**
   * Set when there were bytes to move and the move failed. The asset is
   * returned as it was, so the model still renders from the inline copy; the
   * caller decides whether to say anything.
   */
  error?: string;
}

const NOT_MIGRATED: Omit<CurationAssetMigration, 'asset'> = { migrated: false };

/**
 * The asset with its model in storage rather than inline.
 *
 * On success the returned asset has `modelHash` and `importedFileName` and NO
 * `importedFileBase64` key at all — removed, not set to undefined, so a caller
 * that spreads it into a row cannot carry the blob along by accident and a
 * `'importedFileBase64' in asset` check answers the truth.
 */
export async function migrateCurationAsset(
  asset: ReviewAsset,
  upload: UploadModel = (file) => uploadModelFile(file),
): Promise<CurationAssetMigration> {
  // Already stored by hash. Dropping a stale inline copy if one is somehow
  // beside it is still a change worth saving, but it must not trigger an
  // upload: the hash is the record, and re-uploading on every load would put a
  // 40 MB POST in front of everybody who opens the review.
  if (asset.modelHash) {
    if (!asset.importedFileBase64) return { asset, ...NOT_MIGRATED };
    const { importedFileBase64: _stale, ...withoutBlob } = asset;
    return { asset: withoutBlob, migrated: true };
  }

  const base64 = asset.importedFileBase64;
  const fileName = asset.importedFileName;
  // Nothing to move: a preset model, or a row whose blob was stripped before it
  // was ever saved and which therefore has no file at all.
  if (!base64 || !fileName) return { asset, ...NOT_MIGRATED };

  const bytes = decodeBase64(base64);
  if (!bytes) {
    return {
      asset,
      ...NOT_MIGRATED,
      error: 'The stored model is not readable base64, so it cannot be moved into model storage.',
    };
  }

  // The name carries the extension, and the extension is what
  // utils/modelLoader.ts dispatches on — on the server, which validates it
  // against the same list, and on every client that later parses the download.
  const file = new File([bytes], fileName, { type: modelFileMime(fileName) });

  try {
    const stored = await upload(file);
    const { importedFileBase64: _moved, ...rest } = asset;
    return {
      asset: {
        ...rest,
        modelType: 'imported',
        modelHash: stored.hash,
        importedFileName: fileName,
      },
      migrated: true,
    };
  } catch (err) {
    // Not rethrown: see the header. The inline copy is still in the asset we
    // return, so the review opens with its model on screen and the migration is
    // simply attempted again on the next load.
    return {
      asset,
      ...NOT_MIGRATED,
      error: err instanceof Error ? err.message : 'The model could not be uploaded.',
    };
  }
}

/**
 * base64 → bytes, or null when it is not base64.
 *
 * `atob` throws on anything it cannot decode, and a truncated blob in a jsonb
 * column — a row written by an older version, or a paste that hit a length
 * limit — is exactly what a migration has to expect. Refusing it here leaves
 * the asset untouched rather than uploading garbage under a hash that would
 * then be the review's permanent record of its own model.
 */
function decodeBase64(base64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
