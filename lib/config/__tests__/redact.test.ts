import { describe, it, expect } from 'vitest';
import { redactConfig } from '../redact.ts';
import type { ViewpointConfig } from '../schema.ts';

const fullSecretConfig: ViewpointConfig = {
  plm: {
    provider: 'onshape',
    baseUrl: 'https://cad.onshape.com',
    clientIdEnv: 'ONSHAPE_CLIENT_ID',
    clientSecretEnv: 'ONSHAPE_CLIENT_SECRET',
  },
  capture: {
    provider: 'openai',
    model: 'gpt-4',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  turn: {
    provider: 'cloudflare',
    tokenIdEnv: 'CF_TURN_TOKEN_ID',
    apiTokenEnv: 'CF_TURN_API_TOKEN',
  },
  db: {
    provider: 'supabase',
    urlEnv: 'VITE_SUPABASE_URL',
    anonKeyEnv: 'VITE_SUPABASE_ANON_KEY',
  },
  notifications: [{ provider: 'teams', webhookUrlEnv: 'TEAMS_WEBHOOK_URL' }],
  modelImport: { provider: 'onshape' },
};

describe('redactConfig', () => {
  it('strips all *Env key names and *Env values from the serialized output', () => {
    const result = redactConfig(fullSecretConfig);
    const json = JSON.stringify(result);

    // No key ending in "Env" anywhere in the output.
    const envKeys = json.match(/"[A-Za-z]*Env"/g);
    expect(envKeys).toBeNull();

    // No env var NAME (the value of any *Env field) appears anywhere.
    const allEnvNames = [
      'ONSHAPE_CLIENT_ID',
      'ONSHAPE_CLIENT_SECRET',
      'OPENAI_API_KEY',
      'CF_TURN_TOKEN_ID',
      'CF_TURN_API_TOKEN',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      'TEAMS_WEBHOOK_URL',
    ];
    for (const name of allEnvNames) {
      expect(json).not.toContain(name);
    }
  });

  it('does not leak a newly added secret field (proves allowlist, not denylist)', () => {
    // Simulate a future contributor adding a secret-bearing field to the PLM
    // connector. An allowlist redactor ignores unknown fields by construction;
    // a denylist would silently pass it through.
    const configWithNewSecret = {
      ...fullSecretConfig,
      plm: {
        ...fullSecretConfig.plm,
        signingKeyEnv: 'ONSHAPE_SIGNING_KEY',
        signingSecretEnv: 'ONSHAPE_SIGNING_SECRET',
      },
    } as unknown as ViewpointConfig;

    const result = redactConfig(configWithNewSecret);
    const json = JSON.stringify(result);

    expect(json).not.toContain('signingKeyEnv');
    expect(json).not.toContain('signingSecretEnv');
    expect(json).not.toContain('ONSHAPE_SIGNING_KEY');
    expect(json).not.toContain('ONSHAPE_SIGNING_SECRET');

    // Only the allowlisted plm fields survive.
    expect(Object.keys(result.plm).sort()).toEqual(['baseUrl', 'provider']);
  });

  it('includes only allowlisted fields', () => {
    const result = redactConfig(fullSecretConfig);

    expect(result.plm).toEqual({
      provider: 'onshape',
      baseUrl: 'https://cad.onshape.com',
    });
    expect(result.capture).toEqual({ provider: 'openai', model: 'gpt-4' });
    expect(result.turn).toEqual({ provider: 'cloudflare' });
    expect(result.db).toEqual({ provider: 'supabase' });
    expect(result.notifications).toEqual([{ provider: 'teams' }]);
    expect(result.modelImport).toEqual({ provider: 'onshape' });
  });

  it('includes capture model for providers that have one, omits for those that do not', () => {
    const mockCapture: ViewpointConfig = {
      ...fullSecretConfig,
      capture: { provider: 'mock' },
    };
    expect(redactConfig(mockCapture).capture).toEqual({ provider: 'mock' });

    const localCapture: ViewpointConfig = {
      ...fullSecretConfig,
      capture: {
        provider: 'local',
        serviceUrl: 'http://localhost:8000',
      },
    };
    // serviceUrl is not on the allowlist — the browser does not call
    // capture-service directly; it goes through the Vercel proxy.
    expect(redactConfig(localCapture).capture).toEqual({ provider: 'local' });
  });

  it('exposes capture.baseUrl for ollamaDirect, and still no key name', () => {
    // ollamaDirect is the one capture mode where the browser calls the model
    // host itself (LAN-only, no proxy, no API key), so the base URL has to
    // reach it. It is a network address, not a credential.
    const ollamaCapture: ViewpointConfig = {
      ...fullSecretConfig,
      capture: {
        provider: 'ollamaDirect',
        baseUrl: 'http://ollama.internal:11434',
        model: 'deepseek-r1:7b',
      },
    };
    const result = redactConfig(ollamaCapture);

    expect(result.capture).toEqual({
      provider: 'ollamaDirect',
      baseUrl: 'http://ollama.internal:11434',
      model: 'deepseek-r1:7b',
    });
    expect(JSON.stringify(result)).not.toMatch(/"[A-Za-z]*Env"/);
  });

  it('never exposes capture.apiKeyEnv even though the browser needs the model', () => {
    const result = redactConfig(fullSecretConfig);
    const json = JSON.stringify(result);

    expect(result.capture).toEqual({ provider: 'openai', model: 'gpt-4' });
    expect(json).not.toContain('apiKeyEnv');
    expect(json).not.toContain('OPENAI_API_KEY');
  });

  it('passes publicUrl through when present', () => {
    const config: ViewpointConfig = {
      ...fullSecretConfig,
      publicUrl: 'https://arena.acme.com',
    };
    const result = redactConfig(config);
    expect(result.publicUrl).toBe('https://arena.acme.com');
  });

  it('omits publicUrl when the config does not set it', () => {
    const result = redactConfig(fullSecretConfig);
    expect(result.publicUrl).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('publicUrl');
  });

  it('passes publicUrl through for an IP-based origin', () => {
    const config: ViewpointConfig = {
      ...fullSecretConfig,
      publicUrl: 'https://192.168.1.50',
    };
    const result = redactConfig(config);
    expect(result.publicUrl).toBe('https://192.168.1.50');
  });
});

// ─── identity ───────────────────────────────────────────────────────────────
//
// The browser needs to know WHICH door to render: the mode, the methods to put
// a button on, and whether "join as a guest" is offered. Everything else in the
// block — the env var NAMES holding an SSO client id and secret, the tenant or
// realm URL, the server-side probe URL — is deployment internals.

describe('redactConfig — identity', () => {
  it('reports mode none when the config has no identity block', () => {
    // Absent and { mode: 'none' } are the same deployment, and the client is
    // given one shape to branch on rather than having to handle both.
    const result = redactConfig(fullSecretConfig);
    expect(result.identity).toEqual({ mode: 'none', methods: [], allowGuests: false });
  });

  it('reports mode none for an explicit identity: { mode: "none" }', () => {
    const result = redactConfig({ ...fullSecretConfig, identity: { mode: 'none' } });
    expect(result.identity).toEqual({ mode: 'none', methods: [], allowGuests: false });
  });

  it('exposes accounts with its methods and allowGuests', () => {
    const result = redactConfig({
      ...fullSecretConfig,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: true },
    });
    expect(result.identity).toEqual({
      mode: 'accounts',
      methods: ['password'],
      allowGuests: true,
    });
  });

  it('exposes nothing but mode, methods and allowGuests for an sso config', () => {
    const result = redactConfig({
      ...fullSecretConfig,
      identity: {
        mode: 'sso',
        methods: ['password', 'azure', 'keycloak'],
        allowGuests: false,
        azure: {
          clientIdEnv: 'AZURE_CLIENT_ID',
          secretEnv: 'AZURE_CLIENT_SECRET',
          tenantUrl: 'https://login.microsoftonline.com/acme-tenant-id',
        },
        keycloak: {
          clientIdEnv: 'KEYCLOAK_CLIENT_ID',
          secretEnv: 'KEYCLOAK_CLIENT_SECRET',
          realmUrl: 'https://keycloak.acme.com/realms/acme',
        },
        probeUrl: 'http://auth:9999/health',
      },
    });

    expect(result.identity).toEqual({
      mode: 'sso',
      methods: ['password', 'azure', 'keycloak'],
      allowGuests: false,
    });
    expect(Object.keys(result.identity).sort()).toEqual(['allowGuests', 'methods', 'mode']);
  });

  it('never exposes an SSO client id env NAME, its secret env NAME, or a tenant/realm URL', () => {
    // The point of the allowlist: the NAME of the variable holding a client id
    // tells an attacker which variable to look for in a leaked .env, and the
    // tenant URL names the org's identity provider. Neither is needed to draw
    // a "Sign in with Microsoft" button.
    const result = redactConfig({
      ...fullSecretConfig,
      identity: {
        mode: 'sso',
        methods: ['azure', 'google', 'keycloak'],
        allowGuests: false,
        azure: {
          clientIdEnv: 'AZURE_CLIENT_ID',
          secretEnv: 'AZURE_CLIENT_SECRET',
          tenantUrl: 'https://login.microsoftonline.com/acme-tenant-id',
        },
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET' },
        keycloak: {
          clientIdEnv: 'KEYCLOAK_CLIENT_ID',
          secretEnv: 'KEYCLOAK_CLIENT_SECRET',
          realmUrl: 'https://keycloak.acme.com/realms/acme',
        },
      },
    });
    const json = JSON.stringify(result);

    for (const name of [
      'AZURE_CLIENT_ID',
      'AZURE_CLIENT_SECRET',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'KEYCLOAK_CLIENT_ID',
      'KEYCLOAK_CLIENT_SECRET',
    ]) {
      expect(json, `leaked the env var name ${name}`).not.toContain(name);
    }
    expect(json).not.toContain('login.microsoftonline.com');
    expect(json).not.toContain('keycloak.acme.com');
    expect(json).not.toContain('acme-tenant-id');
    // No key ending in Env anywhere in the response, identity included.
    expect(json).not.toMatch(/"[A-Za-z]*Env"/);
    expect(json).not.toContain('clientIdEnv');
    expect(json).not.toContain('secretEnv');
  });

  it('never exposes identity.probeUrl', () => {
    // The probe URL is how the SERVER reaches GoTrue — a compose-internal
    // hostname on a network that publishes no port, exactly like
    // capture.serviceUrl and db.probeUrl, neither of which is allowlisted.
    const result = redactConfig({
      ...fullSecretConfig,
      identity: {
        mode: 'accounts',
        methods: ['password'],
        allowGuests: false,
        probeUrl: 'http://auth:9999/health',
      },
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('probeUrl');
    expect(json).not.toContain('auth:9999');
  });

  it('hands out a copy of methods, not the parsed config array', () => {
    const config: ViewpointConfig = {
      ...fullSecretConfig,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: false },
    };
    const result = redactConfig(config);
    result.identity.methods.push('saml');
    expect(config.identity).toMatchObject({ methods: ['password'] });
  });
});

describe('redactConfig — modelStorage', () => {
  it('exposes the provider and nothing else', () => {
    const result = redactConfig({
      ...fullSecretConfig,
      modelStorage: {
        provider: 'supabase',
        bucket: 'review-models',
        serviceRoleKeyEnv: 'MODEL_STORAGE_SERVICE_ROLE_KEY',
      },
    });
    expect(result.modelStorage).toEqual({ provider: 'supabase' });
  });

  it('never leaks the bucket, the key, or the NAME of the variable holding it', () => {
    const json = JSON.stringify(
      redactConfig({
        ...fullSecretConfig,
        modelStorage: {
          provider: 'supabase',
          bucket: 'review-models',
          serviceRoleKeyEnv: 'MODEL_STORAGE_SERVICE_ROLE_KEY',
        },
      }),
    );
    expect(json).not.toContain('review-models');
    expect(json).not.toContain('serviceRoleKeyEnv');
    expect(json).not.toContain('MODEL_STORAGE_SERVICE_ROLE_KEY');
    // A service-role key bypasses Row Level Security entirely; its env var name
    // is the one an operator would grep for, so it is worth pinning separately
    // from the generic "no *Env key survives" assertion above.
    expect(json).not.toMatch(/"[A-Za-z]*Env"/);
  });

  it('never leaks the local directory, which is a path inside the api container', () => {
    const json = JSON.stringify(
      redactConfig({
        ...fullSecretConfig,
        modelStorage: { provider: 'local', dir: '/data/models' },
      }),
    );
    expect(json).not.toContain('/data/models');
    expect(json).toContain('"modelStorage":{"provider":"local"}');
  });

  it('reports the default provider when the config has no modelStorage block', () => {
    // An absent block means the local volume, so a client that renders storage
    // state has one answer rather than two shapes to handle.
    expect(redactConfig(fullSecretConfig).modelStorage).toEqual({ provider: 'local' });
  });
});
