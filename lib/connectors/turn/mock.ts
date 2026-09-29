// MockTurnAdapter — deterministic implementation for contract tests.

import type { TurnAdapter } from './types.ts';
import type { HealthCheckResult } from '../../health/types.ts';
import { HEALTH_DETAILS } from '../../health/details.ts';

export class MockTurnAdapter implements TurnAdapter {
  private _servers: RTCIceServer[];
  shouldFail = false;

  constructor(servers?: RTCIceServer[]) {
    this._servers = servers ?? [
      { urls: 'stun:stun.example.com' },
      {
        urls: 'turn:turn.example.com:3478',
        username: 'mock-user',
        credential: 'mock-cred',
      },
    ];
  }

  async getIceServers(): Promise<RTCIceServer[]> {
    if (this.shouldFail) {
      throw new Error('mock turn failure');
    }
    return this._servers;
  }

  /**
   * Mirrors `shouldFail` without calling getIceServers().
   *
   * Not delegating matters: the real adapter's ICE servers carry a username
   * and credential, and a health check that fetched them just to see whether
   * the call worked would put a credential one careless `detail` away from an
   * unauthenticated response. The contract suite and /api/health's degraded
   * path both drive this through `shouldFail`.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    if (this.shouldFail) {
      return { ok: false, detail: HEALTH_DETAILS.checkFailed };
    }
    return { ok: true, detail: HEALTH_DETAILS.selfContained };
  }
}
