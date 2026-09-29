import { describe, it, expect, vi } from 'vitest';
import { redactConfig } from '../redact.ts';
import type { ViewpointConfig } from '../schema.ts';

vi.mock('../loadConfig.ts', () => ({
  loadConfig: vi.fn(),
}));

const mockConfig: ViewpointConfig = {
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

describe('public-config endpoint', () => {
  it('returns only the redacted config', async () => {
    const { loadConfig } = await import('../loadConfig.ts');
    vi.mocked(loadConfig).mockResolvedValue(mockConfig);

    const json = JSON.stringify(redactConfig(mockConfig));

    expect(JSON.parse(json)).toEqual({
      plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com' },
      capture: { provider: 'mock' },
      turn: { provider: 'cloudflare' },
      db: { provider: 'supabase' },
      // mockConfig has no identity block, and the endpoint still answers with
      // one: mode 'none' is a decision the client can act on, not an absence
      // it has to special-case.
      identity: { mode: 'none', methods: [], allowGuests: false },
      notifications: [{ provider: 'teams' }],
      modelImport: { provider: 'onshape' },
      // mockConfig has no modelStorage block either, and the endpoint answers
      // with the default provider rather than an absence — same reasoning as
      // identity above.
      modelStorage: { provider: 'local' },
    });

    // No *Env key name in the output.
    expect(json).not.toMatch(/Env"/);
    // No env var name value in the output.
    expect(json).not.toContain('ONSHAPE_CLIENT_ID');
    expect(json).not.toContain('ONSHAPE_CLIENT_SECRET');
    expect(json).not.toContain('CF_TURN_TOKEN_ID');
    expect(json).not.toContain('CF_TURN_API_TOKEN');
    expect(json).not.toContain('VITE_SUPABASE_URL');
    expect(json).not.toContain('VITE_SUPABASE_ANON_KEY');
    expect(json).not.toContain('TEAMS_WEBHOOK_URL');
  });
});

describe('public-config error path', () => {
  it('never leaks env var names in the error response', async () => {
    // loadConfig fails with a message naming the missing variable. That text
    // must stay in server logs and never reach an unauthenticated caller.
    const { handler } = await import('../../../api/public-config.ts');
    vi.resetModules();

    const body: unknown[] = [];
    const res = {
      setHeader: () => {},
      status: () => res,
      json: (b: unknown) => {
        body.push(b);
        return res;
      },
    } as never;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadMod = await import('../loadConfig.ts');
    vi.spyOn(loadMod, 'loadConfig').mockRejectedValue(
      new Error("plm.clientSecretEnv 'ONSHAPE_CLIENT_SECRET' is not set"),
    );

    await handler({} as never, res);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/Env/);
    expect(serialized).not.toContain('ONSHAPE_CLIENT_SECRET');
    errSpy.mockRestore();
  });
});
