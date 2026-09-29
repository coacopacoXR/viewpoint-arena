// @vitest-environment node
//
// The factory is where a config mistake becomes either a legible line in the
// api log or a 500 nobody can diagnose, so it fails loudly and early.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelStore, resolveSupabaseUrl } from '../modelStore.ts';
import { LocalModelStore } from '../localModelStore.ts';
import { SupabaseModelStore } from '../supabaseModelStore.ts';

const BYTES = new Uint8Array([1, 2, 3]);

describe('createModelStore', () => {
  it('builds a local store over the configured directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-store-'));
    try {
      const store = createModelStore({ provider: 'local', dir });
      expect(store).toBeInstanceOf(LocalModelStore);
      const ref = await store.put(BYTES, {
        fileName: 'a.glb',
        contentType: 'model/gltf-binary',
        uploadedAt: '2026-09-24T09:00:00.000Z',
      });
      expect((await store.head(ref.hash))?.fileName).toBe('a.glb');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a supabase store from the key env var and the project URL', () => {
    const store = createModelStore(
      { provider: 'supabase', bucket: 'review-models', serviceRoleKeyEnv: 'MODEL_STORAGE_KEY' },
      { MODEL_STORAGE_KEY: 'sk', VITE_SUPABASE_URL: 'https://proj.supabase.co' },
    );
    expect(store).toBeInstanceOf(SupabaseModelStore);
  });

  it('names the missing variable when the service-role key is absent', () => {
    expect(() =>
      createModelStore(
        { provider: 'supabase', bucket: 'b', serviceRoleKeyEnv: 'MODEL_STORAGE_KEY' },
        { VITE_SUPABASE_URL: 'https://proj.supabase.co' },
      ),
    ).toThrow(/MODEL_STORAGE_KEY is not set/);
  });

  it('says so when there is no project URL to talk to', () => {
    expect(() =>
      createModelStore(
        { provider: 'supabase', bucket: 'b', serviceRoleKeyEnv: 'MODEL_STORAGE_KEY' },
        { MODEL_STORAGE_KEY: 'sk' },
      ),
    ).toThrow(/SUPABASE_URL/);
  });
});

describe('resolveSupabaseUrl', () => {
  it('prefers SUPABASE_URL, so storage can be a different project from the db', () => {
    expect(
      resolveSupabaseUrl({
        SUPABASE_URL: 'https://storage.supabase.co',
        VITE_SUPABASE_URL: 'https://db.supabase.co',
      }),
    ).toBe('https://storage.supabase.co');
  });

  it('falls back to the one variable every Supabase deployment already sets', () => {
    expect(resolveSupabaseUrl({ VITE_SUPABASE_URL: 'https://db.supabase.co' })).toBe(
      'https://db.supabase.co',
    );
  });

  it('strips trailing slashes and treats blank as absent', () => {
    expect(resolveSupabaseUrl({ SUPABASE_URL: 'https://db.supabase.co///' })).toBe(
      'https://db.supabase.co',
    );
    expect(resolveSupabaseUrl({ SUPABASE_URL: '   ' })).toBeUndefined();
    expect(resolveSupabaseUrl({})).toBeUndefined();
  });
});
