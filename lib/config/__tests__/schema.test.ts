import { describe, it, expect } from 'vitest';
import { configSchema, defineConfig, identityOf, modelStorageOf, DEFAULT_MODEL_STORAGE_DIR } from '../schema.ts';
import type { ViewpointConfig } from '../schema.ts';

const validOnshapeConfig: ViewpointConfig = {
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
    urlEnv: 'VITE_SUPABASE_URL',
    anonKeyEnv: 'VITE_SUPABASE_ANON_KEY',
  },
  notifications: [{ provider: 'teams', webhookUrlEnv: 'TEAMS_WEBHOOK_URL' }],
  modelImport: { provider: 'onshape' },
};

describe('configSchema', () => {
  it('accepts a valid onshape config', () => {
    const result = configSchema.safeParse(validOnshapeConfig);
    expect(result.success).toBe(true);
  });

  it('accepts a valid teamcenter config', () => {
    const config: ViewpointConfig = {
      ...validOnshapeConfig,
      plm: {
        provider: 'teamcenter',
        baseUrl: 'https://tc.example.com',
        usernameEnv: 'TC_USERNAME',
        passwordEnv: 'TC_PASSWORD',
      },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('rejects missing required fields for onshape plm', () => {
    const bad = {
      ...validOnshapeConfig,
      plm: {
        provider: 'onshape',
        baseUrl: 'https://cad.onshape.com',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/clientIdEnv/);
      expect(msg).toMatch(/clientSecretEnv/);
    }
  });

  it('rejects missing required fields for teamcenter plm', () => {
    const bad = {
      ...validOnshapeConfig,
      plm: {
        provider: 'teamcenter',
        baseUrl: 'https://tc.example.com',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/usernameEnv/);
      expect(msg).toMatch(/passwordEnv/);
    }
  });

  it('rejects VITE_-prefixed env var names', () => {
    const bad = {
      ...validOnshapeConfig,
      plm: {
        provider: 'onshape',
        baseUrl: 'https://cad.onshape.com',
        clientIdEnv: 'VITE_ONSHAPE_CLIENT_ID',
        clientSecretEnv: 'ONSHAPE_CLIENT_SECRET',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/VITE_/);
    }
  });

  it('rejects non-UPPER_SNAKE_CASE env var names', () => {
    const bad = {
      ...validOnshapeConfig,
      plm: {
        provider: 'onshape',
        baseUrl: 'https://cad.onshape.com',
        clientIdEnv: 'onshape_client_id',
        clientSecretEnv: 'ONSHAPE_CLIENT_SECRET',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/UPPER_SNAKE_CASE/);
    }
  });

  it('rejects invalid provider discriminator', () => {
    const bad = {
      ...validOnshapeConfig,
      plm: {
        provider: 'unknown',
        baseUrl: 'https://cad.onshape.com',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('defineConfig returns the config when valid', () => {
    const result = defineConfig(validOnshapeConfig);
    expect(result).toEqual(validOnshapeConfig);
  });

  it('defineConfig throws when invalid', () => {
    expect(() =>
      defineConfig({
        ...validOnshapeConfig,
        plm: {
          provider: 'onshape',
          baseUrl: 'https://cad.onshape.com',
        } as ViewpointConfig['plm'],
      }),
    ).toThrow();
  });

  it('accepts openai capture provider with apiKeyEnv', () => {
    const config: ViewpointConfig = {
      ...validOnshapeConfig,
      capture: {
        provider: 'openai',
        model: 'gpt-4',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('rejects openai capture provider missing apiKeyEnv', () => {
    const bad = {
      ...validOnshapeConfig,
      capture: {
        provider: 'openai',
        model: 'gpt-4',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/apiKeyEnv/);
    }
  });

  it('accepts selfHostedCoturn turn provider', () => {
    const config: ViewpointConfig = {
      ...validOnshapeConfig,
      turn: {
        provider: 'selfHostedCoturn',
        host: 'turn.example.com',
        port: 3478,
        sharedSecretEnv: 'COTURN_SHARED_SECRET',
      },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('rejects cloudflare turn missing required env fields', () => {
    const bad = {
      ...validOnshapeConfig,
      turn: {
        provider: 'cloudflare',
      },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/tokenIdEnv/);
      expect(msg).toMatch(/apiTokenEnv/);
    }
  });

  // The VITE_ rule is deliberately asymmetric: the Supabase pair is the one
  // documented public exception (anon key + Row Level Security), every other
  // credential must stay out of the client bundle. Pin both directions so the
  // exception cannot quietly widen.
  it('allows VITE_ prefixes on the public Supabase db fields', () => {
    expect(() => configSchema.parse(validOnshapeConfig)).not.toThrow();
  });

  it('still rejects a VITE_ prefix on a server-side credential', () => {
    const leaky = {
      ...validOnshapeConfig,
      plm: { ...validOnshapeConfig.plm, clientSecretEnv: 'VITE_ONSHAPE_CLIENT_SECRET' },
    };
    expect(() => configSchema.parse(leaky)).toThrow(/VITE_/);
  });

  it('rejects a VITE_ prefix on a notification webhook', () => {
    const leaky = {
      ...validOnshapeConfig,
      notifications: [{ provider: 'teams' as const, webhookUrlEnv: 'VITE_TEAMS_WEBHOOK_URL' }],
    };
    expect(() => configSchema.parse(leaky)).toThrow(/VITE_/);
  });

  it('accepts a config with publicUrl set to an absolute origin', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'https://arena.acme.com',
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('accepts a config with publicUrl as an IP origin', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'https://192.168.1.50',
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('accepts a config with publicUrl including a non-standard port', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'https://192.168.1.50:8443',
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('accepts a config without publicUrl (it is optional)', () => {
    expect(configSchema.safeParse(validOnshapeConfig).success).toBe(true);
  });

  it('rejects publicUrl with a path', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'https://arena.acme.com/app',
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/path|query|fragment/);
    }
  });

  it('rejects publicUrl with a query string', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'https://arena.acme.com?foo=bar',
    };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('rejects publicUrl with a fragment', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'https://arena.acme.com#section',
    };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('rejects a non-URL publicUrl', () => {
    const config = {
      ...validOnshapeConfig,
      publicUrl: 'not-a-url',
    };
    expect(configSchema.safeParse(config).success).toBe(false);
  });
});

// ─── identity (docs/plan/13-identity.md) ────────────────────────────────────
//
// The block is OPTIONAL and absent means mode 'none', so the first guarantee to
// pin is that nothing written before identity existed stops validating. The
// rest pin the two rules that keep a deployment from configuring a sign-in
// page it cannot actually serve: a mode must be backed by the methods it needs,
// and every external provider named must have the env var NAMES its client
// id/secret live in.

describe('configSchema — identity', () => {
  it('accepts a config with no identity block at all', () => {
    const parsed = configSchema.parse(validOnshapeConfig);
    expect(parsed.identity).toBeUndefined();
    // Absent and { mode: 'none' } describe the same deployment, and identityOf
    // is the one place that says so.
    expect(identityOf(parsed)).toEqual({ mode: 'none' });
  });

  it('accepts identity: { mode: "none" }', () => {
    const config = { ...validOnshapeConfig, identity: { mode: 'none' } };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('accepts accounts with the password method', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: false },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it("rejects accounts that does not offer 'password'", () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['azure'], azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' } },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/must include 'password'/);
    }
  });

  it('rejects an empty methods list', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: [], allowGuests: false },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/at least one sign-in method/);
    }
  });

  it('defaults allowGuests to false', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['password'] },
    };
    const parsed = configSchema.parse(config);
    expect(parsed.identity).toEqual({
      mode: 'accounts',
      methods: ['password'],
      allowGuests: false,
    });
  });

  it('accepts allowGuests: true (an outside supplier admitted by the host)', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: true },
    };
    expect(configSchema.parse(config).identity).toMatchObject({ allowGuests: true });
  });

  it('rejects a non-boolean allowGuests', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: 'yes' },
    };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('accepts sso with one external provider and its env var names', () => {
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['azure'],
        allowGuests: false,
        azure: {
          clientIdEnv: 'AZURE_CLIENT_ID',
          secretEnv: 'AZURE_CLIENT_SECRET',
          tenantUrl: 'https://login.microsoftonline.com/acme-tenant-id',
        },
      },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it("accepts azure with no tenantUrl (Microsoft's common endpoint)", () => {
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['azure'],
        allowGuests: false,
        azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' },
      },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('rejects a non-URL azure tenantUrl', () => {
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['azure'],
        allowGuests: false,
        azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET', tenantUrl: 'acme.onmicrosoft.com' },
      },
    };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('accepts sso combining password with an external provider', () => {
    // The plan's "staff via SSO plus a few external suppliers on local
    // accounts" case: methods carries both, and mode says which is the door.
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['password', 'google'],
        allowGuests: true,
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET' },
      },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('rejects sso with no external provider at all', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'sso', methods: ['password'], allowGuests: false },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(
        /at least one of azure, google, keycloak or saml/,
      );
    }
  });

  it('accepts sso with only saml, which needs no env sub-block', () => {
    // A SAML provider is registered through the admin API afterwards, so there
    // is no client id/secret pair for .env to hold at config time.
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'sso', methods: ['saml'], allowGuests: false },
    };
    expect(configSchema.safeParse(config).success).toBe(true);
  });

  it('rejects a listed provider whose env sub-block is missing', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'sso', methods: ['keycloak'], allowGuests: false },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/identity\.keycloak is missing/);
      // The issue is anchored on the missing block, not on the whole identity.
      expect(result.error.issues.some((i) => i.path.join('.') === 'identity.keycloak')).toBe(true);
    }
  });

  it('names every missing provider sub-block, not just the first', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'sso', methods: ['azure', 'google'], allowGuests: false },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('identity.azure');
      expect(paths).toContain('identity.google');
    }
  });

  it('rejects keycloak without realmUrl', () => {
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['keycloak'],
        allowGuests: false,
        keycloak: { clientIdEnv: 'KEYCLOAK_CLIENT_ID', secretEnv: 'KEYCLOAK_CLIENT_SECRET' },
      },
    };
    const result = configSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/realmUrl/);
    }
  });

  it('rejects a VITE_-prefixed identity client id or secret', () => {
    // The rule the whole schema exists to enforce: VITE_ names are inlined into
    // the browser bundle, and an SSO client secret in a bundle is a public
    // secret that lets anyone impersonate this deployment to the IdP.
    const leakyId = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['azure'],
        allowGuests: false,
        azure: { clientIdEnv: 'VITE_AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' },
      },
    };
    expect(() => configSchema.parse(leakyId)).toThrow(/VITE_/);

    const leakySecret = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['google'],
        allowGuests: false,
        google: { clientIdEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'VITE_GOOGLE_CLIENT_SECRET' },
      },
    };
    expect(() => configSchema.parse(leakySecret)).toThrow(/VITE_/);
  });

  it('rejects a non-UPPER_SNAKE_CASE identity env var name', () => {
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'accounts',
        methods: ['password'],
        allowGuests: false,
        azure: { clientIdEnv: 'azure_client_id', secretEnv: 'AZURE_CLIENT_SECRET' },
      },
    };
    expect(() => configSchema.parse(config)).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('accepts identity.probeUrl and rejects a non-URL one', () => {
    const good = {
      ...validOnshapeConfig,
      identity: {
        mode: 'accounts',
        methods: ['password'],
        allowGuests: false,
        probeUrl: 'http://auth:9999/health',
      },
    };
    expect(configSchema.safeParse(good).success).toBe(true);

    // Same rule as db.probeUrl, which is what makes it safe to hand the value
    // straight to new URL() in lib/health/probes.ts. A relative path is the
    // realistic mistake: it parses as no URL at all.
    const bad = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: false, probeUrl: '/health' },
    };
    const result = configSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/identity\.probeUrl must be a URL/);
    }
  });

  it('rejects an unknown method', () => {
    const config = {
      ...validOnshapeConfig,
      identity: { mode: 'accounts', methods: ['password', 'okta'], allowGuests: false },
    };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('rejects an unknown mode', () => {
    const config = { ...validOnshapeConfig, identity: { mode: 'ldap' } };
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it('strips a provider block from identity: { mode: "none" }', () => {
    // 'none' means no identity service is in front of the app at all. The
    // discriminated union picks the { mode: 'none' } branch, whose object
    // strips unknown keys — so a hand-edited block that says none while naming
    // an Azure client id cannot reach redactConfig, checkEnvVars or the
    // installer's profile logic. What the parse output carries is the whole
    // of what any reader may act on.
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'none',
        azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' },
      },
    };
    const parsed = configSchema.parse(config);
    expect(parsed.identity).toEqual({ mode: 'none' });
  });

  it('defineConfig accepts a full sso identity block', () => {
    const config = {
      ...validOnshapeConfig,
      identity: {
        mode: 'sso',
        methods: ['azure', 'keycloak'],
        allowGuests: true,
        azure: {
          clientIdEnv: 'AZURE_CLIENT_ID',
          secretEnv: 'AZURE_CLIENT_SECRET',
          tenantUrl: 'https://login.microsoftonline.com/acme',
        },
        keycloak: {
          clientIdEnv: 'KEYCLOAK_CLIENT_ID',
          secretEnv: 'KEYCLOAK_CLIENT_SECRET',
          realmUrl: 'https://keycloak.acme.com/realms/acme',
        },
        probeUrl: 'http://auth:9999/health',
      },
    };
    expect(() => defineConfig(config as ViewpointConfig)).not.toThrow();
  });
});

describe('configSchema — modelStorage', () => {
  it('is optional, so a config written before storage existed still validates', () => {
    const parsed = configSchema.parse(validOnshapeConfig);
    expect(parsed.modelStorage).toBeUndefined();
  });

  it('accepts the local provider with a directory', () => {
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: { provider: 'local', dir: '/srv/viewpoint/models' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts the supabase provider with a bucket and a key env var', () => {
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: {
        provider: 'supabase',
        bucket: 'review-models',
        serviceRoleKeyEnv: 'MODEL_STORAGE_SERVICE_ROLE_KEY',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a local provider with no directory', () => {
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: { provider: 'local' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('"modelStorage","dir"');
    }
  });

  it('rejects a local provider with an empty directory', () => {
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: { provider: 'local', dir: '' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/modelStorage\.dir is required/);
    }
  });

  it('rejects a supabase provider with no bucket', () => {
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: { provider: 'supabase', serviceRoleKeyEnv: 'MODEL_STORAGE_KEY' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/bucket/);
    }
  });

  it('rejects a VITE_-prefixed service-role key name', () => {
    // The service-role key bypasses Row Level Security entirely. A VITE_
    // spelling would be inlined into the bundle every visitor downloads, which
    // is the one thing the db block's deliberate exception must not become an
    // argument for.
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: {
        provider: 'supabase',
        bucket: 'review-models',
        serviceRoleKeyEnv: 'VITE_MODEL_STORAGE_KEY',
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/VITE_/);
    }
  });

  it('rejects a provider that is neither local nor supabase', () => {
    const result = configSchema.safeParse({
      ...validOnshapeConfig,
      modelStorage: { provider: 's3', bucket: 'b' },
    });
    expect(result.success).toBe(false);
  });

  it('modelStorageOf defaults an absent block to the compose volume path', () => {
    const config = configSchema.parse(validOnshapeConfig);
    expect(modelStorageOf(config)).toEqual({
      provider: 'local',
      dir: DEFAULT_MODEL_STORAGE_DIR,
    });
    // deploy/api.Dockerfile pre-creates this directory so the fresh named
    // volume inherits an owner the `node` user can write to; docker-compose.yml
    // mounts models-data at exactly the same path.
    expect(DEFAULT_MODEL_STORAGE_DIR).toBe('/data/models');
  });

  it('modelStorageOf hands back the configured block untouched', () => {
    const config = configSchema.parse({
      ...validOnshapeConfig,
      modelStorage: { provider: 'local', dir: '/mnt/models' },
    });
    expect(modelStorageOf(config)).toEqual({ provider: 'local', dir: '/mnt/models' });
  });

  it('modelStorageOf returns a fresh default each call, not a shared object', () => {
    const config = configSchema.parse(validOnshapeConfig);
    const first = modelStorageOf(config);
    const second = modelStorageOf(config);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
