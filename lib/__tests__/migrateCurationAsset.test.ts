// The one-time move of a curated review's model out of the database row and into
// storage.
//
// The case that matters most is the one that must NOT happen: an upload on a
// load path that does not need one. This runs every time a review is opened, by
// whoever opens it, so a missing "already migrated" check would put a 40 MB POST
// in front of every participant of every review on every page load.

import { describe, expect, it, vi } from 'vitest';
import { migrateCurationAsset, type StoredModel, type UploadModel } from '../migrateCurationAsset';
import { IDENTITY_TRANSFORM, type ReviewAsset } from '../reviewSetupStore';

const BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
const BASE64 = btoa(String.fromCharCode(...BYTES));
const HASH = 'a1'.repeat(32);
const NAME = 'bracket.glb';

const STORED: StoredModel = { hash: HASH, size: BYTES.byteLength, fileName: NAME };

function legacyAsset(overrides: Partial<ReviewAsset> = {}): ReviewAsset {
  return {
    modelType: 'imported',
    importedFileName: NAME,
    importedFileBase64: BASE64,
    references: [{ id: 'r1', name: 'Spec sheet', url: 'https://example.com/spec.pdf' }],
    transform: { ...IDENTITY_TRANSFORM, scale: 2 },
    ...overrides,
  };
}

/** An uploader that records what it was given, and can be made to fail. */
function uploader(failure?: Error) {
  const files: File[] = [];
  const upload = vi.fn(async (file: File): Promise<StoredModel> => {
    files.push(file);
    if (failure) throw failure;
    return STORED;
  });
  const asUploader: UploadModel = upload;
  return { files, upload, asUploader };
}

describe('migrateCurationAsset', () => {
  it('uploads the inline bytes once and returns the asset with a hash', async () => {
    const { files, asUploader } = uploader();
    const result = await migrateCurationAsset(legacyAsset(), asUploader);

    expect(files).toHaveLength(1);
    expect(result.migrated).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.asset.modelHash).toBe(HASH);
    expect(result.asset.importedFileName).toBe(NAME);
    expect(result.asset.modelType).toBe('imported');
  });

  it('uploads a File the loaders can actually parse', async () => {
    const { files, asUploader } = uploader();
    await migrateCurationAsset(legacyAsset({ importedFileName: 'bracket.step' }), asUploader);

    const file = files[0];
    if (!file) throw new Error('nothing was uploaded');
    // The extension is what utils/modelLoader.ts dispatches on, so a name that
    // lost it would download fine and parse into nothing.
    expect(file.name).toBe('bracket.step');
    expect(file.type).toBe('model/step');
    expect(file.size).toBe(BYTES.byteLength);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
  });

  it('drops the base64 key rather than setting it to undefined', async () => {
    const { asUploader } = uploader();
    const result = await migrateCurationAsset(legacyAsset(), asUploader);
    // `in`, not a truthiness check: a key set to undefined still travels through
    // a spread into the row that gets saved, which is the thing being removed.
    expect('importedFileBase64' in result.asset).toBe(false);
    expect(JSON.stringify(result.asset)).not.toContain('importedFileBase64');
  });

  it('keeps everything else the curator set', async () => {
    const { asUploader } = uploader();
    const result = await migrateCurationAsset(legacyAsset(), asUploader);
    expect(result.asset.references).toEqual([
      { id: 'r1', name: 'Spec sheet', url: 'https://example.com/spec.pdf' },
    ]);
    expect(result.asset.transform).toEqual({ ...IDENTITY_TRANSFORM, scale: 2 });
  });

  it('does nothing, and uploads nothing, when the asset already has a hash', async () => {
    const { files, upload, asUploader } = uploader();
    const asset = legacyAsset();
    delete asset.importedFileBase64;
    asset.modelHash = HASH;

    const result = await migrateCurationAsset(asset, asUploader);

    expect(upload).not.toHaveBeenCalled();
    expect(files).toHaveLength(0);
    expect(result.migrated).toBe(false);
    expect(result.asset).toBe(asset);
  });

  it('drops a stale inline copy sitting beside a hash, without uploading', async () => {
    // Both present should be impossible, but the hash is the record and the blob
    // is what would be saved into a jsonb column — so the blob goes and nothing
    // is uploaded, because uploading on every load is the expensive mistake.
    const { upload, asUploader } = uploader();
    const result = await migrateCurationAsset(legacyAsset({ modelHash: HASH }), asUploader);

    expect(upload).not.toHaveBeenCalled();
    expect(result.migrated).toBe(true);
    expect(result.asset.modelHash).toBe(HASH);
    expect('importedFileBase64' in result.asset).toBe(false);
  });

  it('does nothing for a preset model, which was never a file', async () => {
    const { upload, asUploader } = uploader();
    const asset: ReviewAsset = { modelType: 'headphones', references: [] };
    const result = await migrateCurationAsset(asset, asUploader);
    expect(upload).not.toHaveBeenCalled();
    expect(result.migrated).toBe(false);
    expect(result.asset).toBe(asset);
  });

  it('does nothing for a row whose blob was stripped and which has no hash', async () => {
    // Every curation saved before the migration looks like this: curationsRepo
    // stripped the blob on write, so the row records modelType 'imported' and a
    // name with no file behind either. There is nothing to move, and inventing a
    // hash would point the review at an object that does not exist.
    const { upload, asUploader } = uploader();
    const asset: ReviewAsset = { modelType: 'imported', importedFileName: NAME, references: [] };
    const result = await migrateCurationAsset(asset, asUploader);
    expect(upload).not.toHaveBeenCalled();
    expect(result.migrated).toBe(false);
    expect(result.asset).toBe(asset);
  });

  it('leaves the asset alone when the upload fails, and says why', async () => {
    const { asUploader } = uploader(new Error('Could not reach the server to store this model.'));
    const asset = legacyAsset();
    const result = await migrateCurationAsset(asset, asUploader);

    // Not thrown: this runs while somebody waits for their review to open. The
    // inline copy stays, so the model still renders, and the next load retries.
    expect(result.migrated).toBe(false);
    expect(result.asset).toBe(asset);
    expect(result.asset.importedFileBase64).toBe(BASE64);
    expect(result.error).toMatch(/could not reach the server/i);
  });

  it('refuses base64 it cannot decode, rather than storing garbage under a hash', async () => {
    const { upload, asUploader } = uploader();
    const result = await migrateCurationAsset(
      legacyAsset({ importedFileBase64: 'not!valid!base64!' }),
      asUploader,
    );
    // A hash is for ever: uploading a truncated blob would make it the review's
    // permanent record of its own model.
    expect(upload).not.toHaveBeenCalled();
    expect(result.migrated).toBe(false);
    expect(result.error).toMatch(/not readable base64/i);
  });

  it('defaults to the real uploader, so a call site never has to name one', () => {
    // The second parameter exists for tests; every production call site passes
    // one argument. Asserting the arity keeps that from silently changing.
    expect(migrateCurationAsset.length).toBe(1);
  });
});
