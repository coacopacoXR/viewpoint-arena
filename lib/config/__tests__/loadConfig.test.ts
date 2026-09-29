import { describe, it, expect } from 'vitest';
import { validateConfig, checkEnvVars } from '../loadConfig.ts';
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

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    const result = validateConfig(validConfig);
    expect(result).toEqual(validConfig);
  });

  it('throws with clear error for invalid config', () => {
    const bad = {
      ...validConfig,
      plm: {
        provider: 'onshape',
        baseUrl: 'https://cad.onshape.com',
      },
    };
    expect(() => validateConfig(bad)).toThrow(/Invalid viewpoint config/);
    expect(() => validateConfig(bad)).toThrow(/clientIdEnv/);
  });
});

describe('checkEnvVars', () => {
  it('passes when all env vars are set', () => {
    const env = {
      ONSHAPE_CLIENT_ID: 'id',
      ONSHAPE_CLIENT_SECRET: 'secret',
      CF_TURN_TOKEN_ID: 'token-id',
      CF_TURN_API_TOKEN: 'api-token',
      SUPABASE_URL: 'url',
      SUPABASE_ANON_KEY: 'anon-key',
      TEAMS_WEBHOOK_URL: 'webhook',
    };
    expect(() => checkEnvVars(validConfig, env)).not.toThrow();
  });

  it('throws with specific message naming missing env var and connector', () => {
    const env = {
      ONSHAPE_CLIENT_ID: 'id',
      CF_TURN_TOKEN_ID: 'token-id',
      CF_TURN_API_TOKEN: 'api-token',
      SUPABASE_URL: 'url',
      SUPABASE_ANON_KEY: 'anon-key',
      TEAMS_WEBHOOK_URL: 'webhook',
    };
    expect(() => checkEnvVars(validConfig, env)).toThrow(
      /plm\.clientSecretEnv 'ONSHAPE_CLIENT_SECRET' is not set/,
    );
  });

  it('throws when multiple env vars are missing', () => {
    const env = {
      ONSHAPE_CLIENT_ID: 'id',
      ONSHAPE_CLIENT_SECRET: 'secret',
      SUPABASE_URL: 'url',
      SUPABASE_ANON_KEY: 'anon-key',
    };
    expect(() => checkEnvVars(validConfig, env)).toThrow(
      /CF_TURN_TOKEN_ID/,
    );
    expect(() => checkEnvVars(validConfig, env)).toThrow(
      /CF_TURN_API_TOKEN/,
    );
    expect(() => checkEnvVars(validConfig, env)).toThrow(
      /TEAMS_WEBHOOK_URL/,
    );
  });

  it('throws when env var is empty string', () => {
    const env = {
      ONSHAPE_CLIENT_ID: 'id',
      ONSHAPE_CLIENT_SECRET: '',
      CF_TURN_TOKEN_ID: 'token-id',
      CF_TURN_API_TOKEN: 'api-token',
      SUPABASE_URL: 'url',
      SUPABASE_ANON_KEY: 'anon-key',
      TEAMS_WEBHOOK_URL: 'webhook',
    };
    expect(() => checkEnvVars(validConfig, env)).toThrow(
      /plm\.clientSecretEnv 'ONSHAPE_CLIENT_SECRET' is not set/,
    );
  });

  it('checks nested array items (notifications)', () => {
    const config: ViewpointConfig = {
      ...validConfig,
      notifications: [
        { provider: 'teams', webhookUrlEnv: 'TEAMS_WEBHOOK_URL' },
      ],
    };
    const env = {
      ONSHAPE_CLIENT_ID: 'id',
      ONSHAPE_CLIENT_SECRET: 'secret',
      CF_TURN_TOKEN_ID: 'token-id',
      CF_TURN_API_TOKEN: 'api-token',
      SUPABASE_URL: 'url',
      SUPABASE_ANON_KEY: 'anon-key',
    };
    expect(() => checkEnvVars(config, env)).toThrow(
      /notifications\.0\.webhookUrlEnv 'TEAMS_WEBHOOK_URL' is not set/,
    );
  });
});
