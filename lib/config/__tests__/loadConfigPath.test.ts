// @vitest-environment node
//
// loadConfig() with no argument must read viewpoint.config.ts from the
// deployment root. Its old default was the bare './viewpoint.config.ts', which a
// dynamic import resolves against lib/config/loadConfig.ts — so it looked in
// lib/config/, never found the file, and every caller that relied on the default
// (public-config, turn-credentials, capture/extract) silently ran on fallbacks.
// Every other test mocks loadConfig, so this is the one that does a real import.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigPath, loadConfig } from '../loadConfig.ts';
import exampleConfig from '../../../viewpoint.config.example.ts';

const REQUIRED_ENV = [
  'ONSHAPE_CLIENT_ID',
  'ONSHAPE_CLIENT_SECRET',
  'COTURN_SHARED_SECRET',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'TEAMS_WEBHOOK_URL',
];

describe('loadConfig default path', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vp-config-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    for (const name of REQUIRED_ENV) vi.stubEnv(name, 'test-value');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves against the working directory, not lib/config/', () => {
    const path = defaultConfigPath();
    expect(path).toMatch(/^file:\/\//);
    expect(path.endsWith('/viewpoint.config.ts')).toBe(true);
    expect(path).not.toContain('lib/config/viewpoint.config.ts');
  });

  it('loads a real viewpoint.config.ts from the deployment root with no argument', async () => {
    // A marker the example does not contain, so a pass cannot come from some
    // other config file that happens to be lying around.
    const written = {
      ...exampleConfig,
      capture: { provider: 'local', serviceUrl: 'http://marker-host:8080' },
    };
    writeFileSync(
      join(root, 'viewpoint.config.ts'),
      `export default ${JSON.stringify(written)};\n`,
    );

    const config = await loadConfig();

    expect(config.capture).toEqual({
      provider: 'local',
      serviceUrl: 'http://marker-host:8080',
    });
  });

  it('fails when the deployment root has no config, rather than finding another', async () => {
    await expect(loadConfig()).rejects.toThrow(/Failed to load config/);
  });
});
