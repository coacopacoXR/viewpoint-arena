// SelfHostedCoturnAdapter — ICE servers for an organisation's own coturn.
//
// Uses coturn's "TURN REST API" credential scheme (use-auth-secret /
// static-auth-secret in turnserver.conf), which is what coturn documents for
// exactly this case and what every WebRTC client understands:
//
//   username   = "<unix expiry>:<label>"
//   credential = base64( HMAC-SHA1( sharedSecret, username ) )
//
// coturn recomputes the HMAC with the same secret and rejects the pair once the
// expiry has passed, so the browser gets a credential that is useless tomorrow
// and the secret itself never leaves the server. Mirrors CloudflareTurnAdapter:
// the config names the env var, the value is read from process.env here.

import type { TurnAdapter } from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

/** Same lifetime Cloudflare's credentials get in cloudflare.ts. */
export const COTURN_CREDENTIAL_TTL_SECONDS = 86_400;

/** Label after the expiry in the username. Appears in coturn's logs only. */
const USERNAME_LABEL = 'viewpoint';

/** How long the health probe waits for a STUN answer. */
const STUN_PROBE_TIMEOUT_MS = 2_000;

export interface SelfHostedCoturnOpts {
  /** Hostname or IP browsers use to reach coturn (config turn.host). */
  host: string;
  /** coturn's listening port, normally 3478 (config turn.port). */
  port: number;
  /** NAME of the env var holding coturn's static-auth-secret. */
  sharedSecretEnv: string;
  /**
   * Optional: a different hostname for the health probe. When the api
   * container runs inside Docker, the public `host` (e.g. 'localhost') points
   * at the api container itself, not at coturn. The bundled coturn is
   * reachable by its compose service name on the backend network, so
   * install.sh sets probeHost to 'coturn' in that case. ICE URLs always use
   * `host`, never `probeHost`.
   */
  probeHost?: string;
  /** Override for process.env — for testing only. */
  env?: Record<string, string | undefined>;
  /** Clock override — for testing only. */
  now?: () => number;
  /** Reachability probe override — for testing only. */
  probe?: (host: string, port: number) => Promise<boolean>;
}

/** base64( HMAC-SHA1( secret, message ) ), via Web Crypto so no Node import. */
export async function turnRestCredential(secret: string, username: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(username)));
  let binary = '';
  for (const byte of sig) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Sends one STUN Binding Request (RFC 5389) over UDP and reports whether any
 * STUN answer came back. Every TURN server answers it without credentials, so
 * this proves "coturn is up and reachable on that port" without minting
 * anything. Node-only; imported lazily so this module stays bundle-safe.
 */
export async function stunReachable(host: string, port: number): Promise<boolean> {
  const dgram = await import('node:dgram');
  const { randomBytes } = await import('node:crypto');
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const request = Buffer.alloc(20);
    request.writeUInt16BE(0x0001, 0); // Binding Request
    request.writeUInt16BE(0, 2); // no attributes
    request.writeUInt32BE(0x2112a442, 4); // magic cookie
    randomBytes(12).copy(request, 8); // transaction id
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), STUN_PROBE_TIMEOUT_MS);
    socket.on('message', (msg) => {
      // A STUN success/error response for our transaction.
      done(msg.length >= 20 && msg.readUInt32BE(4) === 0x2112a442 && msg.subarray(8, 20).equals(request.subarray(8, 20)));
    });
    socket.on('error', () => done(false));
    socket.send(request, port, host, (err) => {
      if (err) done(false);
    });
  });
}

export class SelfHostedCoturnAdapter implements TurnAdapter {
  private readonly _host: string;
  private readonly _port: number;
  private readonly _sharedSecretEnv: string;
  private readonly _probeHost: string;
  private readonly _env: Record<string, string | undefined>;
  private readonly _now: () => number;
  private readonly _probe: (host: string, port: number) => Promise<boolean>;

  constructor(opts: SelfHostedCoturnOpts) {
    this._host = opts.host;
    this._port = opts.port;
    this._sharedSecretEnv = opts.sharedSecretEnv;
    this._probeHost = opts.probeHost ?? opts.host;
    this._env = opts.env ?? process.env;
    this._now = opts.now ?? Date.now;
    this._probe = opts.probe ?? stunReachable;
  }

  async getIceServers(): Promise<RTCIceServer[]> {
    const secret = this._env[this._sharedSecretEnv];
    if (!secret) {
      throw new Error(`turn/selfHostedCoturn: ${this._sharedSecretEnv} must be set`);
    }
    const expiry = Math.floor(this._now() / 1000) + COTURN_CREDENTIAL_TTL_SECONDS;
    const username = `${expiry}:${USERNAME_LABEL}`;
    const credential = await turnRestCredential(secret, username);
    const hostPort = `${this._host}:${this._port}`;
    return [
      { urls: `stun:${hostPort}` },
      {
        urls: [`turn:${hostPort}?transport=udp`, `turn:${hostPort}?transport=tcp`],
        username,
        credential,
      },
    ];
  }

  /**
   * Configured (the secret is set) and reachable (coturn answers a STUN
   * Binding Request). Never mints a credential, never names the env var or
   * the host in `detail`.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._env[this._sharedSecretEnv]) {
      return { ok: false, detail: HEALTH_DETAILS.notConfigured };
    }
    try {
      const up = await this._probe(this._probeHost, this._port);
      return up
        ? { ok: true, detail: HEALTH_DETAILS.reachable }
        : { ok: false, detail: HEALTH_DETAILS.unreachable };
    } catch {
      return { ok: false, detail: HEALTH_DETAILS.unreachable };
    }
  }
}
