import { describe, it, expect, vi, afterEach } from 'vitest';

// Commit 1db12fa let an operator point the app at any TURN provider via
// VITE_TURN_URL/USERNAME/CREDENTIAL. T3.4 had to delete those, because Vite
// inlined the credential into the client bundle. The capability was restored
// server-side in api/turn-credentials.ts; these tests pin that it works and
// that the Cloudflare path still takes over when it is not configured.

function makeRes() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    setHeader: () => {},
    status(code: number) {
      state.status = code;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  };
  return { res, state };
}

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('TURN static override', () => {
  it('returns the operator-supplied TURN server when all three vars are set', async () => {
    process.env.TURN_URL = 'turn:turn.example.org:3478,turns:turn.example.org:5349';
    process.env.TURN_USERNAME = 'user1';
    process.env.TURN_CREDENTIAL = 'pass1';

    const { default: handler } = await import('../../../api/turn-credentials.ts');
    const { res, state } = makeRes();
    await handler({} as never, res as never);

    expect(state.status).toBe(200);
    const servers = (state.body as { iceServers: Array<{ urls: string | string[] }> }).iceServers;
    const turn = servers.find((s) => Array.isArray(s.urls));
    expect(turn).toMatchObject({
      urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'],
      username: 'user1',
      credential: 'pass1',
    });
  });

  it('ignores a partially configured override rather than emitting a broken server', async () => {
    process.env.TURN_URL = 'turn:turn.example.org:3478';
    delete process.env.TURN_USERNAME;
    delete process.env.TURN_CREDENTIAL;
    delete process.env.CF_TURN_TOKEN_ID;
    delete process.env.CF_TURN_API_TOKEN;

    const { default: handler } = await import('../../../api/turn-credentials.ts');
    const { res, state } = makeRes();
    await handler({} as never, res as never);

    // Falls through to the Cloudflare path, which is unconfigured here.
    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: 'turn_not_configured' });
  });
});

describe('TURN via self-hosted coturn', () => {
  const COTURN_CONFIG = {
    turn: { provider: 'selfHostedCoturn', host: 'turn.example.org', port: 3478, sharedSecretEnv: 'COTURN_SECRET' },
  };

  it('mints a coturn REST credential when the config selects selfHostedCoturn', async () => {
    delete process.env.TURN_URL;
    process.env.COTURN_SECRET = 'coturn-shared-secret';
    vi.doMock('../../config/loadConfig.ts', () => ({ loadConfig: async () => COTURN_CONFIG }));

    const { default: handler } = await import('../../../api/turn-credentials.ts');
    const { res, state } = makeRes();
    await handler({} as never, res as never);

    expect(state.status).toBe(200);
    const body = JSON.stringify(state.body);
    expect(body).toContain('turn:turn.example.org:3478?transport=udp');
    // A derived credential, never the secret or its variable name.
    expect(body).not.toContain('coturn-shared-secret');
    expect(body).not.toContain('COTURN_SECRET');
  });

  it('answers turn_not_configured when the coturn secret is missing', async () => {
    delete process.env.TURN_URL;
    delete process.env.COTURN_SECRET;
    vi.doMock('../../config/loadConfig.ts', () => ({ loadConfig: async () => COTURN_CONFIG }));

    const { default: handler } = await import('../../../api/turn-credentials.ts');
    const { res, state } = makeRes();
    await handler({} as never, res as never);

    expect(state.status).toBe(500);
    expect(state.body).toEqual({ error: 'turn_not_configured' });
  });
});
