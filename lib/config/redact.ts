import { identityOf, modelStorageOf, type IdentityMethod, type ViewpointConfig } from './schema.ts';

export interface PublicConfig {
  /** The absolute origin browsers use to reach this deployment, or absent. */
  publicUrl?: string;
  plm: { provider: string; baseUrl?: string };
  capture: { provider: string; model?: string; baseUrl?: string };
  turn: { provider: string };
  db: { provider: string };
  /**
   * Enough for the app to render the right door: which mode this deployment
   * uses, which sign-in methods to offer buttons for, and whether a person
   * with no account may still be admitted as a guest.
   *
   * ALWAYS present, including when the config omits the block entirely —
   * absent and `{ mode: 'none' }` describe the same deployment, and a client
   * that had to handle both would grow a second copy of that rule. Never
   * carries a provider's client id, its env var NAMES, or any URL: which
   * tenant an org signs in through is deployment internals, and the browser
   * reaches the provider through this deployment's own /auth/v1/ redirect
   * rather than by calling the provider itself.
   */
  identity: {
    mode: 'none' | 'accounts' | 'sso';
    methods: IdentityMethod[];
    allowGuests: boolean;
  };
  notifications: { provider: string }[];
  modelImport: { provider: string };
  /**
   * Only the provider. Where model bytes live — a directory on the api
   * container's volume, a Supabase bucket name — is deployment internals, and
   * the browser reaches them through this deployment's own /api/models/<hash>
   * rather than by calling the store itself. The service-role key env name
   * never appears here either, for the same reason no other *Env field does.
   */
  modelStorage: { provider: string };
}

// Allowlist-based redactor: only fields explicitly listed below survive into
// the public response. This is the security boundary — a denylist would
// silently leak any field added to the schema later.
//
// What the browser needs to know:
//   - which provider is active per connector category (render the right UI)
//   - non-secret connection details the browser calls directly (base URLs,
//     model names)
//
// What must NOT leak:
//   - any *Env field name (even the deliberately-public Supabase pair —
//     the endpoint exposes neither env var names nor their resolved values)
//   - any resolved secret value
//   - any identity provider's client id, tenant or realm URL
export function redactConfig(config: ViewpointConfig): PublicConfig {
  const plm: PublicConfig['plm'] = { provider: config.plm.provider };
  if ('baseUrl' in config.plm) plm.baseUrl = config.plm.baseUrl;

  const capture: PublicConfig['capture'] = { provider: config.capture.provider };
  if ('model' in config.capture) capture.model = config.capture.model;
  // capture.baseUrl is only present for 'ollamaDirect', which is the one
  // capture mode where the browser calls the model host itself (LAN-only, no
  // proxy, no API key — that is the entire point of the mode). It is a network
  // address, not a credential, so it belongs on the allowlist. Note the
  // contrast with capture.serviceUrl for 'local', which stays off it because
  // that path goes through the Vercel proxy.
  if ('baseUrl' in config.capture) capture.baseUrl = config.capture.baseUrl;

  const identity = identityOf(config);
  const publicIdentity: PublicConfig['identity'] =
    identity.mode === 'none'
      ? { mode: 'none', methods: [], allowGuests: false }
      : {
          mode: identity.mode,
          // A copy, not the config's own array: the response is serialised
          // straight away, but handing out a reference to the parsed config
          // would let a later caller mutate what the next redaction returns.
          methods: [...identity.methods],
          allowGuests: identity.allowGuests,
        };

  const result: PublicConfig = {
    plm,
    capture,
    turn: { provider: config.turn.provider },
    db: { provider: config.db.provider },
    identity: publicIdentity,
    notifications: config.notifications.map((n) => ({ provider: n.provider })),
    modelImport: { provider: config.modelImport.provider },
    modelStorage: { provider: modelStorageOf(config).provider },
  };
  if (config.publicUrl) result.publicUrl = config.publicUrl;
  return result;
}
