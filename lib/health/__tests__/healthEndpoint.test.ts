// GET /api/health — the endpoint's own contract.
//
// The aggregation logic is tested against hand-built checks in
// aggregate.test.ts. What is tested here is the part only the handler can get
// wrong: the HTTP surface. Status codes, the cache header, method handling, and
// the config-did-not-load path — the one place a leak is most likely, because
// loadConfig's error message names the missing env var.
//
// Only loadConfig is mocked. The aggregator runs for real, driven by a stubbed
// global fetch and a stubbed environment, so these tests fail if the handler and
// the aggregator stop fitting together.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { ViewpointConfig } from '../../config/schema.ts';
import type { HealthReport } from '../types.ts';

vi.mock('../../config/loadConfig.ts', async (importOriginal) => ({
  // Keeps the real defaultConfigPath: the path is what one test asserts on.
  ...(await importOriginal<typeof import('../../config/loadConfig.ts')>()),
  loadConfig: vi.fn(),
}));

const CONFIG: ViewpointConfig = {
  plm: { provider: 'none' },
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
  notifications: [],
  modelImport: { provider: 'genericGltf' },
};

/** The environment in which every connector in CONFIG can report ok. */
const HEALTHY_ENV = {
  CF_TURN_TOKEN_ID: 'token-id-value',
  CF_TURN_API_TOKEN: 'api-token-value',
  VITE_SUPABASE_URL: 'https://acme.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key-value',
};

function httpResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

/** A fetch stub that answers by URL, so two probes can disagree. */
function routingFetch(routes: Array<[RegExp, number, unknown?]>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string) => {
    const url = String(input);
    calls.push(url);
    for (const [pattern, status, body] of routes) {
      if (pattern.test(url)) return httpResponse(status, body);
    }
    return httpResponse(404);
  });
  return { fn: fn as unknown as typeof globalThis.fetch, calls };
}

interface FakeResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
}

function fakeRes(): { res: never; captured: FakeResponse } {
  const captured: FakeResponse = { statusCode: null, headers: {}, body: undefined };
  const res = {
    setHeader: (name: string, value: string) => {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    status: (code: number) => {
      captured.statusCode = code;
      return res;
    },
    json: (body: unknown) => {
      captured.body = body;
      return res;
    },
    end: () => res,
  };
  return { res: res as never, captured };
}

let loadConfig: Mock;

beforeEach(async () => {
  vi.clearAllMocks();
  loadConfig = vi.mocked((await import('../../config/loadConfig.ts')).loadConfig);
  loadConfig.mockResolvedValue(CONFIG);
  for (const [name, value] of Object.entries(HEALTHY_ENV)) {
    vi.stubEnv(name, value);
  }
  vi.stubGlobal(
    'fetch',
    routingFetch([[/\/rest\/v1\/$/, 200, { definitions: {} }]]).fn,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function call(method: string): Promise<FakeResponse> {
  const { handler } = await import('../../../api/health.ts');
  const { res, captured } = fakeRes();
  await handler({ method } as never, res);
  return captured;
}

describe('GET /api/health', () => {
  it('returns 200 and the full report when every enabled connector is ok', async () => {
    const captured = await call('GET');
    const body = captured.body as HealthReport;

    expect(captured.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    // plm 'none' and notifications [] are OMITTED, not present and failing: a
    // deployment that told install.sh "no PLM" is not a degraded deployment.
    expect(body.connectors.plm).toBeUndefined();
    expect(body.connectors.notifications).toBeUndefined();
    expect(Object.keys(body.connectors).sort()).toEqual([
      'capture',
      'db',
      'modelImport',
      'turn',
    ]);
    expect(body.connectors.capture).toEqual({
      provider: 'mock',
      status: 'ok',
      detail: 'no external dependency',
    });
  });

  it('returns 503 but the COMPLETE report when a connector is degraded', async () => {
    // The requirement that matters most: a failing connector must not fail the
    // endpoint. 503 is the right status for a probe, and the body must still
    // name every connector — otherwise an operator knows something is wrong and
    // not what.
    vi.stubEnv('CF_TURN_API_TOKEN', '');
    const captured = await call('GET');
    const body = captured.body as HealthReport;

    expect(captured.statusCode).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.connectors.turn).toEqual({
      provider: 'cloudflare',
      status: 'degraded',
      detail: 'credentials not configured',
    });
    expect(body.connectors.capture?.status).toBe('ok');
    expect(body.connectors.db?.status).toBe('ok');
    expect(body.connectors.modelImport?.status).toBe('ok');
  });

  it('reports a degraded PLM without disturbing the other connectors', async () => {
    loadConfig.mockResolvedValue({
      ...CONFIG,
      plm: {
        provider: 'teamcenter',
        baseUrl: 'https://tc.internal.acme',
        usernameEnv: 'TC_USERNAME',
        passwordEnv: 'TC_PASSWORD',
      },
    });
    // The Teamcenter login route 404s — i.e. api/teamcenter/* is not deployed.
    vi.stubGlobal(
      'fetch',
      routingFetch([
        [/\/api\/teamcenter\/login$/, 404],
        [/\/rest\/v1\/$/, 200, { definitions: {} }],
      ]).fn,
    );

    const captured = await call('GET');
    const body = captured.body as HealthReport;

    expect(captured.statusCode).toBe(503);
    expect(body.connectors.plm).toEqual({
      provider: 'teamcenter',
      status: 'degraded',
      detail: 'route unavailable',
    });
    // The internal Teamcenter hostname never reaches the response.
    expect(JSON.stringify(body)).not.toContain('tc.internal.acme');
    expect(body.connectors.db?.status).toBe('ok');
  });

  it('is never cached', async () => {
    const captured = await call('GET');
    // no-store, not no-cache: a cached health response is a lie about the
    // present, and an intermediate proxy must not serve a stale "ok" while the
    // deployment is down.
    expect(captured.headers['cache-control']).toBe('no-store');
  });

  it('lets loadConfig choose the source (VIEWPOINT_CONFIG, else the root file)', async () => {
    await call('GET');

    // No argument on purpose: an explicit path would bypass VIEWPOINT_CONFIG,
    // which is the only way a Vercel deploy gets a config at all. That the
    // no-argument default is the ABSOLUTE root path (not lib/config/) is
    // pinned in lib/config/__tests__/loadConfigPath.test.ts.
    expect(loadConfig).toHaveBeenCalledWith();
  });

  it('accepts HEAD and rejects anything else', async () => {
    const head = await call('HEAD');
    expect(head.statusCode).toBe(200);

    const post = await call('POST');
    expect(post.statusCode).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect(post.body).toEqual({ error: 'method_not_allowed' });
  });

  it('publishes nothing from the environment', async () => {
    const captured = await call('GET');
    const serialized = JSON.stringify(captured.body);

    for (const [name, value] of Object.entries(HEALTHY_ENV)) {
      expect(serialized, `leaked the value of ${name}`).not.toContain(value);
      expect(serialized, `leaked the name ${name}`).not.toContain(name);
    }
    expect(serialized).not.toContain('supabase.co');
    expect(serialized).not.toContain('://');
  });
});

describe('GET /api/health — identity', () => {
  it('adds an identity entry when the config enables accounts', async () => {
    loadConfig.mockResolvedValue({
      ...CONFIG,
      identity: {
        mode: 'accounts',
        methods: ['password'],
        allowGuests: false,
        probeUrl: 'http://auth:9999/health',
      },
    });
    vi.stubGlobal(
      'fetch',
      routingFetch([
        [/\/rest\/v1\/$/, 200, { definitions: {} }],
        [/^http:\/\/auth:9999\/health$/, 200, { name: 'GoTrue', version: '2.197.0' }],
      ]).fn,
    );

    const captured = await call('GET');
    const body = captured.body as HealthReport;

    expect(captured.statusCode).toBe(200);
    expect(body.connectors.identity).toEqual({
      provider: 'accounts',
      status: 'ok',
      detail: 'upstream reachable',
    });
    // The internal compose hostname never reaches an unauthenticated caller.
    expect(JSON.stringify(body)).not.toContain('auth:9999');
  });

  it('answers 503 when identity is configured but the service is down', async () => {
    // The install.sh case that matters: the config says accounts, the compose
    // profile was never enabled, so nginx answers 502 for /auth/v1/ and the
    // operator is told WHICH connector is not ready.
    loadConfig.mockResolvedValue({
      ...CONFIG,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: false },
    });
    vi.stubGlobal(
      'fetch',
      routingFetch([
        [/\/rest\/v1\/$/, 200, { definitions: {} }],
        [/^http:\/\/auth:9999\/health$/, 502],
      ]).fn,
    );

    const captured = await call('GET');
    const body = captured.body as HealthReport;

    expect(captured.statusCode).toBe(503);
    expect(body.connectors.identity?.status).toBe('degraded');
    expect(body.connectors.db?.status).toBe('ok');
  });

  it('omits identity when the config has no identity block', async () => {
    const captured = await call('GET');
    expect((captured.body as HealthReport).connectors.identity).toBeUndefined();
  });
});

describe('GET /api/health — the config did not load', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns a fixed code and never the loader’s message', async () => {
    // loadConfig fails with text naming the missing variable — exactly what an
    // operator needs and exactly what an unauthenticated caller must not get.
    // The same split api/public-config.ts makes.
    loadConfig.mockRejectedValue(
      new Error(
        "Missing required environment variables:\n  - plm.clientSecretEnv 'ONSHAPE_CLIENT_SECRET' is not set",
      ),
    );

    const captured = await call('GET');
    const serialized = JSON.stringify(captured.body);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({
      ok: false,
      connectors: {},
      error: 'config_not_available',
    });
    expect(serialized).not.toContain('ONSHAPE_CLIENT_SECRET');
    expect(serialized).not.toMatch(/Env/);
    expect(serialized).not.toContain('Missing required environment variables');

    // The reason still reaches the operator, through the server log.
    expect(console.error).toHaveBeenCalled();
    const logged = (console.error as Mock).mock.calls
      .flatMap((c) => c.map(String))
      .join(' ');
    expect(logged).toContain('ONSHAPE_CLIENT_SECRET');
  });

  it('reports an invalid config the same way, without the zod issues', async () => {
    loadConfig.mockRejectedValue(
      new Error("Invalid viewpoint config:\n  - plm.baseUrl: plm.baseUrl must be a URL"),
    );

    const captured = await call('GET');

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toEqual({
      ok: false,
      connectors: {},
      error: 'config_not_available',
    });
    expect(JSON.stringify(captured.body)).not.toContain('baseUrl');
  });
});
