// CloudflareTurnAdapter — server-side implementation of TurnAdapter.
//
// Exchanges the Cloudflare TURN API token for short-lived ICE servers.
// Refactored from the existing api/turn-credentials.ts: the env var NAMES
// (tokenIdEnv, apiTokenEnv) come from the config layer rather than being
// hardcoded, but the Cloudflare API call itself is unchanged.
//
// This module is server-only — it reads process.env. It must never be
// imported by browser-reachable code.

import type { TurnAdapter } from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error(
    'cloudflare.ts is server-only. Import from api/* handlers, not client code.',
  );
}

export interface CloudflareTurnOpts {
  /** Name of the env var holding the TURN token ID (e.g. 'CF_TURN_TOKEN_ID'). */
  tokenIdEnv: string;
  /** Name of the env var holding the TURN API token (e.g. 'CF_TURN_API_TOKEN'). */
  apiTokenEnv: string;
  /** Override for process.env — for testing only. */
  env?: Record<string, string | undefined>;
}

export class CloudflareTurnAdapter implements TurnAdapter {
  private _tokenIdEnv: string;
  private _apiTokenEnv: string;
  private _env: Record<string, string | undefined>;

  constructor(opts: CloudflareTurnOpts) {
    this._tokenIdEnv = opts.tokenIdEnv;
    this._apiTokenEnv = opts.apiTokenEnv;
    this._env = opts.env ?? process.env;
  }

  async getIceServers(): Promise<RTCIceServer[]> {
    const tokenId = this._env[this._tokenIdEnv];
    const apiToken = this._env[this._apiTokenEnv];

    if (!tokenId || !apiToken) {
      throw new Error(
        `turn/cloudflare: ${this._tokenIdEnv} and ${this._apiTokenEnv} must be set`,
      );
    }

    const cf = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${tokenId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );

    if (!cf.ok) {
      throw new Error(`turn/cloudflare: API returned ${cf.status}`);
    }

    const data = (await cf.json()) as { iceServers?: RTCIceServer[] };
    if (!data?.iceServers) {
      throw new Error('turn/cloudflare: unexpected response shape');
    }

    return data.iceServers;
  }

  /**
   * Are both TURN credentials present? Presence only — no API call.
   *
   * Calling getIceServers() to check health would mint a real credential
   * against Cloudflare's METERED TURN API on every poll, and the minted
   * username/credential pair would be sitting in the return path of an
   * unauthenticated endpoint. Both are disqualifying, so this reports what can
   * be known for free.
   *
   * The detail names no variable: WHICH of the two is missing is deployment
   * internals, and the server log is where an operator looks. Say the pair is
   * incomplete and they will find it in the config.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const tokenId = this._env[this._tokenIdEnv];
    const apiToken = this._env[this._apiTokenEnv];
    if (!tokenId || !apiToken) {
      return { ok: false, detail: HEALTH_DETAILS.notConfigured };
    }
    return { ok: true, detail: HEALTH_DETAILS.configured };
  }
}
