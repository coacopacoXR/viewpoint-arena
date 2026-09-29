import { defineConfig } from './lib/config/schema.ts';

export default defineConfig({
  plm: {
    provider: 'onshape',
    baseUrl: 'https://cad.onshape.com',
    clientIdEnv: 'ONSHAPE_CLIENT_ID',
    clientSecretEnv: 'ONSHAPE_CLIENT_SECRET',
  },
  capture: {
    provider: 'mock',
  },
  turn: {
    provider: 'selfHostedCoturn',
    host: 'localhost',
    port: 3478,
    sharedSecretEnv: 'COTURN_SHARED_SECRET',
    // When the api container runs inside Docker, the public host (e.g.
    // 'localhost') resolves to the api container itself, not to coturn.
    // probeHost is the compose service name the api uses for its STUN health
    // probe on the backend network. Omit it when the api runs outside Docker.
    probeHost: 'coturn',
  },
  db: {
    provider: 'supabase',
    // These two intentionally keep the VITE_ prefix: the browser must read
    // them. The Supabase anon key is client-safe by design, with access
    // control enforced by Row Level Security in Postgres. Every other
    // credential below is server-side only and must never use VITE_.
    urlEnv: 'VITE_SUPABASE_URL',
    anonKeyEnv: 'VITE_SUPABASE_ANON_KEY',
    // Two optional SERVER-SIDE addresses, neither of which reaches a browser:
    //
    //   probeUrl   the PostgREST root /api/health probes. Needed because the
    //              public URL is often unreachable from inside the api container
    //              (`localhost` there is the container itself). install.sh writes
    //              `probeUrl: 'http://rest:3000/'` for a bundled database.
    //   serverUrl  the PostgREST root the server reads and writes PRIVILEGED data
    //              through — today, app_settings, which holds the AI credentials
    //              an administrator saves and which Row Level Security hides from
    //              the anon key (docs/plan/14-rooms-models-admin-ai.md batch BF).
    //              Absent means probeUrl, and absent too means
    //              `<public URL>/rest/v1/`. A separate field because the two
    //              answers can legitimately differ: a deployment may probe one
    //              path and be told to send privileged writes through another.
    //
    //     probeUrl: 'http://rest:3000/',
    //     serverUrl: 'http://rest:3000/',
  },
  // How people sign in — docs/plan/13-identity.md. The block is OPTIONAL and
  // 'none' is the default, so a config with no identity block at all means
  // exactly this: names are typed in the lobby and self-asserted, with the
  // optional shared front-door password as the only gate.
  identity: { mode: 'none' },
  // 'accounts' puts email + password on this install (the bundled GoTrue
  // service, compose profile `identity`, at /auth/v1/):
  //
  //   identity: {
  //     mode: 'accounts',
  //     methods: ['password'],
  //     allowGuests: false,
  //     probeUrl: 'http://auth:9999/health',
  //   },
  //
  // 'sso' borrows the company's identity provider. methods may also carry
  // 'password' alongside a provider, for the staff-via-SSO-plus-a-few-external-
  // suppliers case; every provider listed except 'saml' needs its sub-block
  // naming the env vars that hold its client id and secret. 'saml' has none:
  // its provider record is registered through the GoTrue admin API afterwards.
  //
  //   identity: {
  //     mode: 'sso',
  //     methods: ['azure'],
  //     allowGuests: true,
  //     azure: {
  //       clientIdEnv: 'AZURE_CLIENT_ID',
  //       secretEnv: 'AZURE_CLIENT_SECRET',
  //       tenantUrl: 'https://login.microsoftonline.com/<tenant>',
  //     },
  //     probeUrl: 'http://auth:9999/health',
  //   },
  //
  // The provider's redirect URI is <publicUrl>/auth/v1/callback, and sign-in
  // fails with a redirect_uri mismatch until the provider has it registered.
  notifications: [{ provider: 'teams', webhookUrlEnv: 'TEAMS_WEBHOOK_URL' }],
  modelImport: { provider: 'onshape' },
  // Where imported 3D model FILES live — docs/plan/14-rooms-models-admin-ai.md
  // §"File storage". Optional: absent means exactly the block below, which is
  // the `models-data` volume docker-compose.yml mounts on the api service. A
  // model is stored under its own SHA-256 and everything else (the room socket,
  // a curated review, the URL that serves it) refers to that hash, never to the
  // bytes.
  modelStorage: { provider: 'local', dir: '/data/models' },
  //
  // A hosted deployment with no volume to write to uses a Supabase Storage
  // bucket instead. The key is the SERVICE-ROLE one, which bypasses Row Level
  // Security, so it is read by the api only and must never carry a VITE_
  // prefix — the schema refuses one:
  //
  //   modelStorage: {
  //     provider: 'supabase',
  //     bucket: 'review-models',
  //     serviceRoleKeyEnv: 'MODEL_STORAGE_SERVICE_ROLE_KEY',
  //   },
  //
  // The project URL comes from SUPABASE_URL, or VITE_SUPABASE_URL when that is
  // not set; neither is named here because both are already in every Supabase
  // deployment's environment.
});
