import { z } from 'zod';

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const envVarName = z
  .string()
  .min(1, 'env var name must not be empty')
  .refine((v) => ENV_VAR_NAME_RE.test(v), {
    message: 'env var name must be UPPER_SNAKE_CASE',
  })
  .refine((v) => !v.startsWith('VITE_'), {
    message:
      'VITE_-prefixed names are inlined into the client bundle by Vite; secrets must never use VITE_ prefix',
  });

// Deliberately public, client-visible env names.
//
// Almost every credential must stay out of the client bundle, which is what
// `envVarName` enforces. The Supabase pair is the documented exception in
// docs/plan/01-architecture-and-master-config.md §3: the anon key is designed
// to be embedded in client code, with access control enforced by Postgres Row
// Level Security rather than by keeping the key secret. The browser therefore
// has to be able to read both, so they keep the VITE_ prefix.
//
// Do NOT reuse this for anything else. If a new field needs it, it almost
// certainly belongs server-side instead.
const publicEnvVarName = z
  .string()
  .min(1, 'env var name must not be empty')
  .refine((v) => ENV_VAR_NAME_RE.test(v), {
    message: 'env var name must be UPPER_SNAKE_CASE',
  });

const onshapePlm = z.object({
  provider: z.literal('onshape'),
  baseUrl: z.string().url('plm.baseUrl must be a URL'),
  clientIdEnv: envVarName,
  clientSecretEnv: envVarName,
});

const teamcenterPlm = z.object({
  provider: z.literal('teamcenter'),
  baseUrl: z.string().url('plm.baseUrl must be a URL'),
  usernameEnv: envVarName,
  passwordEnv: envVarName,
});

// 'none' is the "we have no PLM we support, or we don't want one connected"
// deployment: install.sh offers it as `none-manual-upload`. It carries no *Env
// fields because there is nothing to authenticate, and it pairs with
// modelImport 'genericGltf'. /api/health omits a connector whose provider is
// 'none' rather than reporting it as failing — a deployment that deliberately
// has no PLM is not a degraded deployment.
const noPlm = z.object({ provider: z.literal('none') });

const plmSchema = z.discriminatedUnion('provider', [
  onshapePlm,
  teamcenterPlm,
  noPlm,
]);

const captureSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('mock') }),
  z.object({
    provider: z.literal('local'),
    serviceUrl: z.string().url('capture.serviceUrl must be a URL'),
  }),
  z.object({
    provider: z.literal('openai'),
    model: z.string().min(1, 'capture.model is required'),
    apiKeyEnv: envVarName,
  }),
  z.object({
    provider: z.literal('anthropic'),
    model: z.string().min(1, 'capture.model is required'),
    apiKeyEnv: envVarName,
  }),
  z.object({
    provider: z.literal('ollamaDirect'),
    baseUrl: z.string().url('capture.baseUrl must be a URL'),
    model: z.string().min(1, 'capture.model is required'),
  }),
]);

const cloudflareTurn = z.object({
  provider: z.literal('cloudflare'),
  tokenIdEnv: envVarName,
  apiTokenEnv: envVarName,
});

const selfHostedCoturnTurn = z.object({
  provider: z.literal('selfHostedCoturn'),
  host: z.string().min(1, 'turn.host is required'),
  port: z.number().int().positive('turn.port must be a positive integer'),
  sharedSecretEnv: envVarName,
  // Optional: a different hostname for the api container's STUN health probe.
  // When the api container runs inside Docker, the public `host` (e.g.
  // 'localhost') resolves to the api container itself, not to coturn. The
  // bundled coturn service is reachable by its compose service name on the
  // backend network, so install.sh writes probeHost: 'coturn' for that case.
  // The ICE URLs handed to browsers always use `host`, never `probeHost`.
  probeHost: z.string().min(1).optional(),
});

const turnSchema = z.discriminatedUnion('provider', [
  cloudflareTurn,
  selfHostedCoturnTurn,
]);

const dbSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('supabase'),
    // publicEnvVarName, not envVarName — see the comment on publicEnvVarName.
    urlEnv: publicEnvVarName,
    anonKeyEnv: publicEnvVarName,
    // Optional: the PostgREST root as the SERVER reaches it, for /api/health
    // only (e.g. 'http://rest:3000/' in the bundled Docker stack). Probed
    // exactly as given. Needed because the public URL the browser uses is
    // often unreachable from inside the api container (`localhost` there is
    // the container itself). Not a secret, and never sent to the browser.
    probeUrl: z.string().url('db.probeUrl must be a URL').optional(),
    // Optional: the PostgREST root the SERVER reads and writes through, as
    // distinct from the one it merely probes (e.g. 'http://rest:3000/' in the
    // bundled Docker stack). Used by lib/ai/settingsStore.ts, which talks to
    // app_settings with a service-role token; absent means db.probeUrl, and
    // absent too means `<public URL>/rest/v1/`. A separate field rather than
    // reusing probeUrl because the two answers can legitimately differ: a
    // deployment may probe a health endpoint through one path and be told to
    // send privileged writes through another (a read replica, a private
    // gateway). Not a secret, and never sent to the browser.
    serverUrl: z.string().url('db.serverUrl must be a URL').optional(),
  }),
]);

// ── Identity ─────────────────────────────────────────────────────────────────
//
// docs/plan/13-identity.md: how people get into a deployment is a per-
// deployment CHOICE, not a feature that is either present or absent from the
// code. 'none' is what ships today (names typed in the lobby, self-asserted,
// with an optional shared front-door password). 'accounts' and 'sso' put a real
// identity provider in front of the app — Supabase Auth (GoTrue) in the
// self-hosted stack, the same project's Auth on Supabase cloud.
//
// The whole block is OPTIONAL and an absent block means { mode: 'none' }, so
// every config written before identity existed still validates unchanged. Both
// readers (lib/config/redact.ts, lib/health/aggregate.ts) normalise absent to
// 'none' rather than the schema forcing a value into configs that never asked
// for one: a hand-written config stays exactly what its author wrote.

/**
 * Every sign-in method the app can offer.
 *
 * 'password' is a local account (email + password held by GoTrue). The rest
 * are external identity providers. 'saml' is the one method with no env vars
 * here: a SAML provider is registered through the admin API afterwards
 * (GoTrue stores it in auth.saml_providers), so it needs no client id/secret
 * pair in the deployment's .env.
 */
const identityMethod = z.enum([
  'password',
  'azure',
  'google',
  'keycloak',
  'saml',
]);

export type IdentityMethod = z.infer<typeof identityMethod>;

/** The two external providers whose config is a plain client id/secret pair. */
const ssoCredentials = z.object({
  clientIdEnv: envVarName,
  secretEnv: envVarName,
});

const azureSso = ssoCredentials.extend({
  // e.g. https://login.microsoftonline.com/<tenant-id>. Optional: without it
  // GoTrue uses Microsoft's common (multi-tenant) endpoint, which is the right
  // default for an org that has not pinned a tenant.
  tenantUrl: z.string().url('identity.azure.tenantUrl must be a URL').optional(),
});

const googleSso = ssoCredentials;

const keycloakSso = ssoCredentials.extend({
  // The realm URL, e.g. https://keycloak.acme.com/realms/acme. GoTrue reads
  // the OIDC discovery document from it, and there is no sensible default for
  // a self-hosted Keycloak — hence required, unlike Azure's tenantUrl.
  realmUrl: z.string().url('identity.keycloak.realmUrl must be a URL'),
});

const identityNone = z.object({ mode: z.literal('none') });

const identityEnabled = z.object({
  mode: z.enum(['accounts', 'sso']),
  methods: z
    .array(identityMethod)
    .min(1, 'identity.methods must name at least one sign-in method'),
  // When true, a person with no account on this deployment can still knock on
  // a room and be admitted by the host as a named guest — which is what keeps
  // a review with an outside supplier possible on a locked-down install.
  allowGuests: z.boolean().default(false),
  azure: azureSso.optional(),
  google: googleSso.optional(),
  keycloak: keycloakSso.optional(),
  // Optional: the identity service's /health URL as the SERVER reaches it, for
  // /api/health only — exactly the role db.probeUrl plays. Needed because
  // publicUrl (https://arena.acme.com) is not reachable from inside the api
  // container: `localhost` there is the container itself. Absent means the
  // bundled GoTrue service on the compose network (DEFAULT_AUTH_PROBE_URL in
  // lib/health/probes.ts). Not a secret, and never sent to the browser.
  probeUrl: z.string().url('identity.probeUrl must be a URL').optional(),
  // Optional: the GoTrue admin base URL as the SERVER reaches it, for the
  // People endpoints in /admin (batch BD). The api container calls GoTrue's
  // /admin/users with a service-role token. Absent means the bundled GoTrue
  // service on the compose network (http://auth:9999). Not a secret — it is a
  // Docker-internal address — and never sent to the browser.
  adminUrl: z.string().url('identity.adminUrl must be a URL').optional(),
});

/** The providers that need a sub-block naming their env vars. 'saml' does not. */
const SSO_METHODS_WITH_CONFIG = ['azure', 'google', 'keycloak'] as const;

const identitySchema = z
  .discriminatedUnion('mode', [identityNone, identityEnabled])
  // 'accounts' IS email + password on this install, so a config that says
  // accounts but offers no password method describes a door with no handle.
  // 'sso' may ALSO include 'password' (staff via SSO plus a few external
  // suppliers on local accounts), which is why this is not symmetric.
  .refine((identity) => identity.mode !== 'accounts' || identity.methods.includes('password'), {
    message: "identity.mode 'accounts' must include 'password' in identity.methods",
    path: ['methods'],
  })
  // 'sso' without a single external provider would be a sign-in page with
  // nothing on it. 'password' alone is the 'accounts' mode, not this one.
  .refine(
    (identity) =>
      identity.mode !== 'sso' ||
      SSO_METHODS_WITH_CONFIG.some((m) => identity.methods.includes(m)) ||
      identity.methods.includes('saml'),
    {
      message:
        "identity.mode 'sso' must include at least one of azure, google, keycloak or saml in identity.methods",
      path: ['methods'],
    },
  )
  // A listed provider with no sub-block has no client id or secret to
  // authenticate with, and the failure would surface at sign-in time as an
  // opaque redirect error rather than at config load. 'saml' is exempt: its
  // provider record is registered through the admin API, not through env vars.
  .superRefine((identity, ctx) => {
    if (identity.mode === 'none') return;
    for (const method of SSO_METHODS_WITH_CONFIG) {
      if (!identity.methods.includes(method) || identity[method] !== undefined) continue;
      ctx.addIssue({
        code: 'custom',
        message:
          `identity.methods lists '${method}' but identity.${method} is missing — ` +
          `it names the env vars holding that provider's client id and secret`,
        path: [method],
      });
    }
  });

const teamsNotification = z.object({
  provider: z.literal('teams'),
  webhookUrlEnv: envVarName,
});

const notificationsSchema = z.array(
  z.discriminatedUnion('provider', [teamsNotification]),
);

const modelImportSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('onshape') }),
  z.object({ provider: z.literal('genericGltf') }),
]);

// ── Model file storage ───────────────────────────────────────────────────────
//
// docs/plan/14-rooms-models-admin-ai.md §"File storage". A model file is
// content-addressed: its SHA-256 is that file's identity in the room socket, in
// a curation's asset and in the URL that serves it. Nothing outside
// lib/storage/ knows where the bytes live, which is what lets the same app run
// off a volume on the api container (the Docker install) or off a Supabase
// Storage bucket (a hosted one).
//
// The block is OPTIONAL and absent means the local default below, so every
// config written before storage existed still validates unchanged. Readers call
// modelStorageOf() rather than repeating the fallback at each use site, exactly
// as identityOf() does for the identity block.

/**
 * Where the local provider writes, and the path docker-compose.yml mounts the
 * `models-data` volume at. Spelled out here because deploy/api.Dockerfile has
 * to pre-create the same directory: a fresh named volume inherits the owner of
 * the image's directory at the mount point, and the api container runs as
 * `node`, not root.
 */
export const DEFAULT_MODEL_STORAGE_DIR = '/data/models';

const modelStorageSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('local'),
    dir: z.string().min(1, 'modelStorage.dir is required'),
  }),
  z.object({
    provider: z.literal('supabase'),
    bucket: z.string().min(1, 'modelStorage.bucket is required'),
    // envVarName, not publicEnvVarName: a service-role key bypasses Row Level
    // Security entirely. Only the api reads it, and a VITE_ spelling would
    // inline it into the bundle every visitor downloads.
    serviceRoleKeyEnv: envVarName,
  }),
]);

export type ModelStorageConfig = z.infer<typeof modelStorageSchema>;

// The absolute origin browsers use to reach this deployment
// (e.g. 'https://arena.acme.com', 'https://192.168.1.50'). SharePanel uses it
// to build room URLs so a phone on the same network gets a scannable link
// instead of https://localhost/room/…. Optional: when absent, SharePanel falls
// back to window.location.origin. No path, query or fragment — the share link
// appends /room/<id> itself.
const publicUrlSchema = z
  .string()
  .url('publicUrl must be an absolute http(s) URL')
  .refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
    message: 'publicUrl must use http or https',
  })
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.pathname === '/' && u.search === '' && u.hash === '';
    } catch {
      return false;
    }
  }, { message: 'publicUrl must have no path, query or fragment' });

export const configSchema = z.object({
  publicUrl: publicUrlSchema.optional(),
  plm: plmSchema,
  capture: captureSchema,
  turn: turnSchema,
  db: dbSchema,
  identity: identitySchema.optional(),
  notifications: notificationsSchema,
  modelImport: modelImportSchema,
  modelStorage: modelStorageSchema.optional(),
});

export type ViewpointConfig = z.infer<typeof configSchema>;

/** The identity block. Optional on the config: absent means mode 'none'. */
export type IdentityConfig = ViewpointConfig['identity'];

/**
 * The identity block with its default applied.
 *
 * "Absent" and "{ mode: 'none' }" describe the same deployment — today's rules,
 * names typed in the lobby. Readers that branch on the mode call this instead
 * of repeating `?? { mode: 'none' }` at every use site, so the two cannot drift
 * apart.
 */
export function identityOf(config: ViewpointConfig): NonNullable<IdentityConfig> {
  return config.identity ?? { mode: 'none' };
}

/**
 * The model-storage block with its default applied.
 *
 * "Absent" and "{ provider: 'local', dir: '/data/models' }" describe the same
 * deployment: the volume docker-compose.yml already mounts on the api service.
 * A fresh object rather than a shared constant, so a caller that mutates what
 * it got back cannot change what the next caller sees.
 */
export function modelStorageOf(config: ViewpointConfig): ModelStorageConfig {
  return config.modelStorage ?? { provider: 'local', dir: DEFAULT_MODEL_STORAGE_DIR };
}

export function defineConfig(config: ViewpointConfig): ViewpointConfig {
  configSchema.parse(config);
  return config;
}
