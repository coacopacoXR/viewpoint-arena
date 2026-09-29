// Shared TurnAdapter contract test suite.
//
// Any TurnAdapter implementation can be run through this suite by calling
// runTurnContractTests() with a setup function that produces the adapter.

import { describe, it, expect } from 'vitest';
import type { TurnAdapter } from './types.ts';
import { MockTurnAdapter } from './mock.ts';

export interface TurnContractSetup {
  adapter: TurnAdapter;
}

export function runTurnContractTests(
  name: string,
  setup: () => TurnContractSetup | Promise<TurnContractSetup>,
): void {
  describe(`TurnAdapter contract: ${name}`, () => {
    let ctx: TurnContractSetup;

    it('getIceServers returns an array of RTCIceServer', async () => {
      ctx = await setup();
      const servers = await ctx.adapter.getIceServers();
      expect(Array.isArray(servers)).toBe(true);
      expect(servers.length).toBeGreaterThan(0);
      for (const server of servers) {
        // urls is required and must be a string or array of strings
        expect(
          typeof server.urls === 'string' || Array.isArray(server.urls),
        ).toBe(true);
        if (typeof server.urls === 'string') {
          expect(server.urls.length).toBeGreaterThan(0);
        }
        if (server.username !== undefined) {
          expect(typeof server.username).toBe('string');
        }
        if (server.credential !== undefined) {
          expect(typeof server.credential).toBe('string');
        }
      }
    });

    it('getIceServers returns servers with valid URL schemes', async () => {
      ctx ??= await setup();
      const servers = await ctx.adapter.getIceServers();
      for (const server of servers) {
        const urls = Array.isArray(server.urls)
          ? server.urls
          : [server.urls];
        for (const url of urls) {
          expect(url).toMatch(/^(stun|turn|turns):/);
        }
      }
    });
  });
}

// Run the contract suite against MockTurnAdapter.
describe('TurnAdapter contract suite', () => {
  runTurnContractTests('MockTurnAdapter', () => ({
    adapter: new MockTurnAdapter(),
  }));
});
