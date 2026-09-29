// @vitest-environment node
//
// loadConfig() with VIEWPOINT_CONFIG set: the env var carries the whole config
// as JSON, so deployments without a filesystem (Vercel, serverless) can still
// be configured. These tests pin the precedence (env wins over file, explicit
// path wins over env), the error shapes (bad JSON, bad schema, missing secret
// env vars) and the guarantee that the raw value never leaks into an error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewpointConfig } from '../schema.ts';

const validConfig: ViewpointConfig = {
  plm: {
    provider: 'onshape',
    baseUrl: 'https://cad.onshape.com',
    clientIdEnv: 'ONSHAPE_CLIENT_ID',
    clientSecretEnv: 'ONSHAPE_CLIENT_SECRET',
  },
  capture: { provider: 'mock' },
  turn: {
    provider: 'cloudflare',
    tokenIdEnv: 'CF_TURN_TOKEN_ID',
    apiTokenEnv: 'CF_TURN_API_TOKEN',
  },
  db: {
    provider: 'supabase',
    urlEnv: 'SUPABASE_URL',
    anonKeyEnv: 'SUPABASE_ANON_KEY',
  },
  notifications: [{ provider: 'teams', webhookUrlEnv: 'TEAMS_WEBHOOK_URL' }],
  modelImport: { provider: 'onshape' },
};

const REQUIRED_ENV: Record<string, string> = {
  ONSHAPE_CLIENT_ID: 'id',
  ONSHAPE_CLIENT_SECRET: 'secret',
  CF_TURN_TOKEN_ID: 'token-id',
  CF_TURN_API_TOKEN: 'api-token',
  SUPABASE_URL: 'url',
  SUPABASE_ANON_KEY: 'anon-key',
  TEAMS_WEBHOOK_URL: 'webhook',
};

describe('loadConfig with VIEWPOINT_CONFIG', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(REQUIRED_ENV)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads config from the env var JSON when called with no argument', async () => {
    const json = JSON.stringify(validConfig);
    vi.stubEnv('VIEWPOINT_CONFIG', json);

    const { loadConfig } = await import('../loadConfig.ts');
    const config = await loadConfig();

    expect(config).toEqual(validConfig);
  });

  it('works even when no config file exists on disk', async () => {
    const json = JSON.stringify(validConfig);
    vi.stubEnv('VIEWPOINT_CONFIG', json);
    // Point cwd at an empty temp dir so no viewpoint.config.ts is found.
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'vp-envcfg-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    try {
      const { loadConfig } = await import('../loadConfig.ts');
      const config = await loadConfig();
      expect(config).toEqual(validConfig);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets an explicit file path win over the env var', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');

    const root = mkdtempSync(join(tmpdir(), 'vp-envcfg-'));
    const fileConfig: ViewpointConfig = {
      ...validConfig,
      capture: { provider: 'local', serviceUrl: 'http://file-host:8080' },
    };
    writeFileSync(
      join(root, 'viewpoint.config.ts'),
      `export default ${JSON.stringify(fileConfig)};\n`,
    );
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    // Env var has a DIFFERENT config — the explicit path must win.
    vi.stubEnv(
      'VIEWPOINT_CONFIG',
      JSON.stringify({
        ...validConfig,
        capture: { provider: 'local', serviceUrl: 'http://env-host:9090' },
      }),
    );

    try {
      const { loadConfig } = await import('../loadConfig.ts');
      const config = await loadConfig(pathToFileURL(join(root, 'viewpoint.config.ts')).href);
      expect(config.capture).toEqual({
        provider: 'local',
        serviceUrl: 'http://file-host:8080',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws a parse error for invalid JSON without leaking the raw value', async () => {
    // At the very START of the value: V8's JSON.parse message quotes the
    // first few characters of its input, so a marker further in would pass
    // even against code that forwards the parser's message.
    const marker = 'LEAK7';
    vi.stubEnv('VIEWPOINT_CONFIG', `${marker} is not json`);

    const { loadConfig } = await import('../loadConfig.ts');
    await expect(loadConfig()).rejects.toThrow(/Invalid VIEWPOINT_CONFIG: not valid JSON/);

    try {
      await loadConfig();
    } catch (err) {
      expect((err as Error).message).not.toContain(marker);
    }
  });

  it('throws the same schema error as the file path when the JSON fails validation', async () => {
    const bad = { ...validConfig, plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com' } };
    vi.stubEnv('VIEWPOINT_CONFIG', JSON.stringify(bad));

    const { loadConfig } = await import('../loadConfig.ts');
    await expect(loadConfig()).rejects.toThrow(/Invalid viewpoint config/);
    await expect(loadConfig()).rejects.toThrow(/clientIdEnv/);
  });

  it('runs checkEnvVars on the env-sourced config', async () => {
    // Config names ONSHAPE_CLIENT_SECRET, which we leave unset.
    vi.unstubAllEnvs();
    vi.stubEnv('VIEWPOINT_CONFIG', JSON.stringify(validConfig));
    // Stub everything EXCEPT ONSHAPE_CLIENT_SECRET.
    for (const [k, v] of Object.entries(REQUIRED_ENV)) {
      if (k !== 'ONSHAPE_CLIENT_SECRET') vi.stubEnv(k, v);
    }

    const { loadConfig } = await import('../loadConfig.ts');
    await expect(loadConfig()).rejects.toThrow(
      /plm\.clientSecretEnv 'ONSHAPE_CLIENT_SECRET' is not set/,
    );
  });
});

// An SSO provider whose client secret is missing fails at SIGN-IN time with an
// opaque redirect error, long after install.sh reported success. checkEnvVars
// walks every key ending in `Env` wherever it sits in the config, so the
// identity block's provider sub-blocks are covered by the same rule as plm's —
// which is worth pinning, because they are nested one level deeper than any
// other *Env field in the schema.
describe('checkEnvVars — identity', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [k, v] of Object.entries(REQUIRED_ENV)) vi.stubEnv(k, v);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const ssoConfig = {
    ...validConfig,
    identity: {
      mode: 'sso' as const,
      methods: ['azure' as const],
      allowGuests: false,
      azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' },
    },
  };

  it('loads when both identity variables are set', async () => {
    vi.stubEnv('AZURE_CLIENT_ID', 'the-client-id');
    vi.stubEnv('AZURE_CLIENT_SECRET', 'the-client-secret');
    vi.stubEnv('VIEWPOINT_CONFIG', JSON.stringify(ssoConfig));

    const { loadConfig } = await import('../loadConfig.ts');
    await expect(loadConfig()).resolves.toMatchObject({
      identity: { mode: 'sso', methods: ['azure'] },
    });
  });

  it('names the missing identity variable and its config path', async () => {
    vi.stubEnv('AZURE_CLIENT_ID', 'the-client-id');
    vi.stubEnv('AZURE_CLIENT_SECRET', '');
    vi.stubEnv('VIEWPOINT_CONFIG', JSON.stringify(ssoConfig));

    const { loadConfig } = await import('../loadConfig.ts');
    await expect(loadConfig()).rejects.toThrow(
      /identity\.azure\.secretEnv 'AZURE_CLIENT_SECRET' is not set/,
    );
  });
});
