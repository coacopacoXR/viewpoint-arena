// /api/health aggregation: which connectors are reported, what happens when one
// fails, and — the part that matters most — that nothing leaks.
//
// docs/plan/05-observability-and-metrics.md §1 sets the contract: a check per
// ENABLED connector, disabled ones omitted rather than failed, and one bad
// connector must not take the endpoint down with it.

import { describe, it, expect } from 'vitest';
import {
  aggregateHealth,
  aggregateChecks,
  buildChecks,
  type Check,
} from '../aggregate.ts';
import { HEALTH_DETAILS } from '../details.ts';
import { probeCaptureService, CAPTURE_AUTH_HEADER, DEFAULT_AUTH_PROBE_URL } from '../probes.ts';
import type { ViewpointConfig } from '../../config/schema.ts';
import { GenericUploadModelImportAdapter } from '../../connectors/modelImport/genericUpload.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Only the fields the health code reads; avoids depending on a fetch global. */
function httpResponse(
  status: number,
  body?: unknown,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function fetchReturning(response: Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

const BASE_CONFIG: ViewpointConfig = {
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

/** An environment in which every connector in BASE_CONFIG can report ok. */
const HEALTHY_ENV: Record<string, string> = {
  CF_TURN_TOKEN_ID: 'token-id-value',
  CF_TURN_API_TOKEN: 'api-token-value',
  VITE_SUPABASE_URL: 'https://acme.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key-value',
};

// ─── Which connectors are reported ──────────────────────────────────────────

describe('aggregateHealth — connector selection', () => {
  it('reports every enabled connector and omits the disabled ones', async () => {
    const { fn } = fetchReturning(httpResponse(200, { status: 'ok' }));
    const report = await aggregateHealth(BASE_CONFIG, {
      env: HEALTHY_ENV,
      fetchFn: fn,
    });

    // plm 'none' and notifications [] are deliberately absent, not present and
    // failing: a deployment that answered "no PLM" to install.sh is not broken.
    expect(Object.keys(report.connectors).sort()).toEqual([
      'capture',
      'db',
      'modelImport',
      'turn',
    ]);
    expect(report.connectors.plm).toBeUndefined();
    expect(report.connectors.notifications).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it('reports one entry per enabled notification sink, keyed by sink id', async () => {
    const { fn } = fetchReturning(httpResponse(200, { status: 'ok' }));
    const report = await aggregateHealth(
      {
        ...BASE_CONFIG,
        notifications: [{ provider: 'teams', webhookUrlEnv: 'TEAMS_WEBHOOK_URL' }],
      },
      { env: HEALTHY_ENV, fetchFn: fn },
    );

    expect(report.connectors.notifications).toBeDefined();
    expect(Object.keys(report.connectors.notifications ?? {})).toEqual(['teams']);
    expect(report.connectors.notifications?.teams.provider).toBe('teams');
  });

  it('maps every provider the schema allows onto a check', () => {
    const cases: Array<[ViewpointConfig, string, string]> = [
      [{ ...BASE_CONFIG, plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com', clientIdEnv: 'ONSHAPE_CLIENT_ID', clientSecretEnv: 'ONSHAPE_CLIENT_SECRET' } }, 'plm', 'onshape'],
      [{ ...BASE_CONFIG, plm: { provider: 'teamcenter', baseUrl: 'https://tc.example', usernameEnv: 'TC_USERNAME', passwordEnv: 'TC_PASSWORD' } }, 'plm', 'teamcenter'],
      [{ ...BASE_CONFIG, capture: { provider: 'local', serviceUrl: 'http://capture-service:8080' } }, 'capture', 'local'],
      [{ ...BASE_CONFIG, capture: { provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' } }, 'capture', 'openai'],
      [{ ...BASE_CONFIG, capture: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKeyEnv: 'ANTHROPIC_API_KEY' } }, 'capture', 'anthropic'],
      [{ ...BASE_CONFIG, capture: { provider: 'ollamaDirect', baseUrl: 'http://ollama.internal:11434', model: 'deepseek-r1:7b' } }, 'capture', 'ollamaDirect'],
      [{ ...BASE_CONFIG, turn: { provider: 'selfHostedCoturn', host: 'turn.example', port: 3478, sharedSecretEnv: 'COTURN_SHARED_SECRET' } }, 'turn', 'selfHostedCoturn'],
      [{ ...BASE_CONFIG, modelImport: { provider: 'onshape' } }, 'modelImport', 'onshape'],
    ];

    for (const [config, slot, provider] of cases) {
      const checks = buildChecks(config, { env: HEALTHY_ENV });
      const found = checks.find((c) => c.slot === slot);
      expect(found, `no ${slot} check for ${provider}`).toBeDefined();
      expect(found?.provider).toBe(provider);
    }

    // And the one provider that produces nothing at all.
    expect(buildChecks(BASE_CONFIG, { env: HEALTHY_ENV }).some((c) => c.slot === 'plm')).toBe(false);
  });
});

// ─── One bad connector must not fail the endpoint ───────────────────────────

describe('aggregateHealth — failure isolation', () => {
  it('reports a failing connector as degraded and still reports every other one', async () => {
    const { fn } = fetchReturning(httpResponse(200, { status: 'ok' }));
    const report = await aggregateHealth(
      {
        ...BASE_CONFIG,
        // coturn with no secret in the environment: degraded, not thrown.
        turn: {
          provider: 'selfHostedCoturn',
          host: 'turn.example',
          port: 3478,
          sharedSecretEnv: 'COTURN_SHARED_SECRET',
        },
      },
      { env: HEALTHY_ENV, fetchFn: fn },
    );

    expect(report.ok).toBe(false);
    expect(report.connectors.turn).toEqual({
      provider: 'selfHostedCoturn',
      status: 'degraded',
      detail: HEALTH_DETAILS.notConfigured,
    });
    // The point of the ticket: the rest of the report survived.
    expect(report.connectors.capture?.status).toBe('ok');
    expect(report.connectors.db?.status).toBe('ok');
    expect(report.connectors.modelImport?.status).toBe('ok');
  });

  it('turns a throwing check into degraded and leaves the others alone', async () => {
    const checks: Check[] = [
      {
        slot: 'plm',
        provider: 'onshape',
        run: async () => {
          throw new Error('ONSHAPE_CLIENT_SECRET exploded at https://cad.onshape.com');
        },
      },
      { slot: 'capture', provider: 'mock', run: async () => ({ ok: true, detail: HEALTH_DETAILS.selfContained }) },
    ];

    const connectors = await aggregateChecks(checks, { env: HEALTHY_ENV });

    expect(connectors.plm).toEqual({
      provider: 'onshape',
      status: 'degraded',
      detail: HEALTH_DETAILS.checkFailed,
    });
    expect(connectors.capture?.status).toBe('ok');
  });

  it('bounds a hanging check with the deadline instead of hanging the report', async () => {
    const checks: Check[] = [
      {
        slot: 'db',
        provider: 'supabase',
        run: () => new Promise<never>(() => {
          /* never settles: a connector whose host black-holes packets */
        }),
      },
      { slot: 'capture', provider: 'mock', run: async () => ({ ok: true }) },
    ];

    const started = Date.now();
    const connectors = await aggregateChecks(checks, { env: HEALTHY_ENV, timeoutMs: 25 });

    expect(connectors.db).toEqual({
      provider: 'supabase',
      status: 'degraded',
      detail: HEALTH_DETAILS.timedOut,
    });
    expect(connectors.capture?.status).toBe('ok');
    // Generous ceiling: the assertion is that the deadline fired, not that the
    // timer is precise, and a slow CI box must not make this flaky.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('treats a missing or malformed healthCheck result as "not verified"', async () => {
    const checks: Check[] = [
      { slot: 'plm', provider: 'onshape', run: async () => undefined },
      { slot: 'turn', provider: 'cloudflare', run: async () => ({ detail: 'ok' } as never) },
    ];

    const connectors = await aggregateChecks(checks, { env: HEALTHY_ENV });

    // Neither may be reported as ok: nothing was verified. Claiming ok for an
    // adapter that answered with garbage is how a dashboard goes green on a
    // broken deployment.
    expect(connectors.plm?.status).toBe('degraded');
    expect(connectors.plm?.detail).toBe(HEALTH_DETAILS.notReported);
    expect(connectors.turn?.status).toBe('degraded');
  });

  it('never rejects, whatever a check does', async () => {
    const checks: Check[] = [
      { slot: 'plm', provider: 'none', run: () => Promise.reject(new Error('nope')) },
      { slot: 'db', provider: 'supabase', run: async () => { throw new TypeError('x'); } },
    ];
    await expect(aggregateChecks(checks, { env: {} })).resolves.toBeDefined();
  });
});

const PLANTED_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // gitleaks:allow (fake test value)

// ─── The no-leak guarantee ──────────────────────────────────────────────────

describe('aggregateHealth — no leak', () => {
  // Values planted in both the environment and the adapters' details. If any of
  // these strings appears in the serialised report, the endpoint has leaked.
  const PLANTED = {
    ONSHAPE_CLIENT_SECRET: 'Jx7Qm2Vp9Ld4Rt6Yw1Zk8Nb3Hg5Fc0Sa', // gitleaks:allow (fake test value)
    TEAMS_WEBHOOK_URL: 'https://acme.webhook.office.com/webhookb2/1a2b3c4d',
    CAPTURE_SHARED_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', // gitleaks:allow (fake test value)
    VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon', // gitleaks:allow (fake test value)
    VITE_SUPABASE_URL: 'https://acme.supabase.co',
    CF_TURN_API_TOKEN: 'v2.token.value.9f8e7d6c5b4a',
  };

  it('publishes no credential, env var name, upstream body or internal hostname', async () => {
    // Every check tries to leak in a different way: an env var name, a resolved
    // secret, a URL, an internal container hostname, an upstream error body and
    // a base64 token.
    const checks: Check[] = [
      { slot: 'plm', provider: 'onshape', run: async () => ({ ok: false, detail: 'ONSHAPE_CLIENT_SECRET is not set' }) },
      { slot: 'capture', provider: 'local', run: async () => ({ ok: false, detail: `token ${PLANTED.CAPTURE_SHARED_SECRET} rejected` }) },
      { slot: 'turn', provider: 'cloudflare', run: async () => ({ ok: false, detail: 'POST https://rtc.live.cloudflare.com/v1/turn/keys failed' }) },
      { slot: 'db', provider: 'supabase', run: async () => ({ ok: false, detail: PLANTED.VITE_SUPABASE_ANON_KEY }) },
      { slot: 'modelImport', provider: 'onshape', run: async () => ({ ok: false, detail: 'capture-service:8080 refused the connection' }) },
      { slot: 'notifications', sinkId: 'teams', provider: 'teams', run: async () => ({ ok: false, detail: `webhook ${PLANTED.TEAMS_WEBHOOK_URL} returned 429` }) },
    ];

    const connectors = await aggregateChecks(checks, { env: PLANTED });
    const serialized = JSON.stringify(connectors);

    for (const [name, value] of Object.entries(PLANTED)) {
      expect(serialized, `leaked the value of ${name}`).not.toContain(value);
      expect(serialized, `leaked the name ${name}`).not.toContain(name);
    }
    expect(serialized).not.toContain('://');
    expect(serialized).not.toContain('capture-service');
    expect(serialized).not.toContain('cloudflare.com');
    expect(serialized).not.toContain('webhook.office.com');
    expect(serialized).not.toContain('429');
    // The STATUS survived every drop, which is the whole trade: an operator
    // still learns that each connector is degraded, just not why in prose.
    expect(connectors.plm?.status).toBe('degraded');
    expect(connectors.notifications?.teams.status).toBe('degraded');
  });

  it('replaces an unsanitised provider string instead of echoing it', async () => {
    // The provider is echoed straight into a public response, so it goes through
    // safeProvider as well — a hand-edited config must not become an injection
    // point. Checked on its own because two checks on one slot would overwrite
    // each other in the report.
    const connectors = await aggregateChecks(
      [
        {
          slot: 'db',
          provider: 'https://evil.example/ONSHAPE_CLIENT_SECRET',
          run: async () => ({ ok: true }),
        },
      ],
      { env: {} },
    );

    expect(connectors.db?.provider).toBe('unknown');
    expect(JSON.stringify(connectors)).not.toContain('evil.example');
    expect(JSON.stringify(connectors)).not.toContain('ONSHAPE_CLIENT_SECRET');
  });

  it('sends the capture-service secret upstream but never into the report', async () => {
    const { fn, calls } = fetchReturning(httpResponse(200, { status: 'ok' }));
    const result = await probeCaptureService('http://capture-service:8080', {
      env: { CAPTURE_SHARED_SECRET: PLANTED_SECRET },
      fetchFn: fn,
    });

    expect(result).toEqual({ ok: true, detail: HEALTH_DETAILS.reachable });
    // The header is what makes the request authorised…
    expect((calls[0].init?.headers as Record<string, string>)[CAPTURE_AUTH_HEADER]).toBe(
      PLANTED_SECRET,
    );
    // …and the URL it was sent to is the internal container name, which is why
    // the RESULT must not carry it.
    expect(JSON.stringify(result)).not.toContain('capture-service');
  });
});

// ─── The two probe-based connectors ─────────────────────────────────────────

describe('capture.provider local — capture-service probe', () => {
  const config: ViewpointConfig = {
    ...BASE_CONFIG,
    capture: { provider: 'local', serviceUrl: 'http://capture-service:8080' },
  };

  it('is ok when the service answers 200 with status ok', async () => {
    const { fn, calls } = fetchReturning(httpResponse(200, { status: 'ok', service: 'capture-service' }));
    const report = await aggregateHealth(config, {
      env: { ...HEALTHY_ENV, CAPTURE_SHARED_SECRET: 'x'.repeat(64) },
      fetchFn: fn,
    });

    expect(report.connectors.capture).toEqual({
      provider: 'local',
      status: 'ok',
      detail: HEALTH_DETAILS.reachable,
    });
    expect(calls[0].url).toContain('/health');
  });

  it('is degraded, not failed, when the shared secret is rejected', async () => {
    const { fn } = fetchReturning(httpResponse(401, { error: 'unauthorized' }));
    const report = await aggregateHealth(config, {
      env: { ...HEALTHY_ENV, CAPTURE_SHARED_SECRET: 'wrong' },
      fetchFn: fn,
    });

    expect(report.connectors.capture?.status).toBe('degraded');
    expect(report.connectors.capture?.detail).toBe(HEALTH_DETAILS.rejected);
    expect(report.ok).toBe(false);
  });

  it('is degraded when something that is not capture-service answers 200', async () => {
    // The SPA-fallback trap: a 200 whose body has no `status: "ok"`. Under
    // `vite preview` every /api/* route answers exactly like this.
    const { fn } = fetchReturning(httpResponse(200, '<!doctype html><title>App</title>'));
    const report = await aggregateHealth(config, { env: HEALTHY_ENV, fetchFn: fn });
    expect(report.connectors.capture?.detail).toBe(HEALTH_DETAILS.routeUnavailable);
  });

  it('is degraded when the service cannot be reached at all', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed for http://capture-service:8080/health');
    }) as unknown as typeof globalThis.fetch;
    const report = await aggregateHealth(config, { env: HEALTHY_ENV, fetchFn: fn });
    expect(report.connectors.capture).toEqual({
      provider: 'local',
      status: 'degraded',
      detail: HEALTH_DETAILS.unreachable,
    });
  });

  it('is degraded when capture.serviceUrl is not a URL', async () => {
    const { fn } = fetchReturning(httpResponse(200, { status: 'ok' }));
    const report = await aggregateHealth(
      { ...BASE_CONFIG, capture: { provider: 'local', serviceUrl: 'not a url' } },
      { env: HEALTHY_ENV, fetchFn: fn },
    );
    expect(report.connectors.capture?.detail).toBe(HEALTH_DETAILS.configInvalid);
  });
});

describe('db connector', () => {
  it('is ok when the database answers and accepts the anon key', async () => {
    const { fn, calls } = fetchReturning(httpResponse(200, { definitions: {} }));
    const report = await aggregateHealth(BASE_CONFIG, { env: HEALTHY_ENV, fetchFn: fn });

    expect(report.connectors.db).toEqual({
      provider: 'supabase',
      status: 'ok',
      detail: HEALTH_DETAILS.reachable,
    });
    expect((calls[0].init?.headers as Record<string, string>).apikey).toBe(
      HEALTHY_ENV.VITE_SUPABASE_ANON_KEY,
    );
  });

  it('probes db.probeUrl as given when set, never the public URL', async () => {
    // The bundled Docker stack: the browser's URL is https://localhost, which
    // inside the api container is the container itself.
    const { fn, calls } = fetchReturning(httpResponse(200, { definitions: {} }));
    const report = await aggregateHealth(
      { ...BASE_CONFIG, db: { ...BASE_CONFIG.db, probeUrl: 'http://rest:3000/' } },
      { env: HEALTHY_ENV, fetchFn: fn },
    );
    expect(report.connectors.db?.status).toBe('ok');
    expect(String(calls[0].url)).toBe('http://rest:3000/');
  });

  it('separates "database down" from "key rejected"', async () => {
    const rejected = await aggregateHealth(BASE_CONFIG, {
      env: HEALTHY_ENV,
      fetchFn: fetchReturning(httpResponse(401, { message: 'invalid api key' })).fn,
    });
    expect(rejected.connectors.db?.detail).toBe(HEALTH_DETAILS.rejected);

    const down = await aggregateHealth(BASE_CONFIG, {
      env: HEALTHY_ENV,
      fetchFn: (async () => { throw new TypeError('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch,
    });
    expect(down.connectors.db?.detail).toBe(HEALTH_DETAILS.unreachable);
  });

  it('is degraded when the database variables are empty', async () => {
    // This is the state install.sh leaves a --defaults install in, and the
    // reason it reports degraded rather than failing to start.
    const { fn } = fetchReturning(httpResponse(200, {}));
    const report = await aggregateHealth(BASE_CONFIG, {
      env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
      fetchFn: fn,
    });
    expect(report.connectors.db).toEqual({
      provider: 'supabase',
      status: 'degraded',
      detail: HEALTH_DETAILS.notConfigured,
    });
  });
});

// ─── The identity connector (docs/plan/13-identity.md) ──────────────────────

describe('identity connector', () => {
  /** GoTrue's real /health body: no `status` field, unlike capture-service's. */
  const GOTRUE_HEALTH = {
    version: '2.197.0',
    name: 'GoTrue',
    description: 'GoTrue is a secure and easy way to authenticate users',
  };

  it('is omitted entirely when the config has no identity block', () => {
    expect(buildChecks(BASE_CONFIG, { env: HEALTHY_ENV }).some((c) => c.slot === 'identity')).toBe(
      false,
    );
  });

  it("reports mode 'none' as ok with no external dependency, and makes no request", async () => {
    // A deployment that answered "no accounts" to install.sh is not degraded.
    // Reporting it degraded would fail install.sh's health poll (exit 3) on a
    // stack that is exactly as ready as it was configured to be.
    const { fn, calls } = fetchReturning(httpResponse(200, GOTRUE_HEALTH));
    const report = await aggregateHealth(
      { ...BASE_CONFIG, identity: { mode: 'none' } },
      { env: HEALTHY_ENV, fetchFn: fn },
    );

    expect(report.connectors.identity).toEqual({
      provider: 'none',
      status: 'ok',
      detail: HEALTH_DETAILS.selfContained,
    });
    // Only the db probe ran; nothing was sent to an identity service.
    expect(calls.map((c) => String(c.url))).toEqual(['https://acme.supabase.co/rest/v1/']);
    expect(report.ok).toBe(true);
  });

  it('probes the bundled GoTrue service by default when accounts is on', async () => {
    const { fn, calls } = fetchReturning(httpResponse(200, GOTRUE_HEALTH));
    const report = await aggregateHealth(
      {
        ...BASE_CONFIG,
        identity: { mode: 'accounts', methods: ['password'], allowGuests: false },
      },
      { env: HEALTHY_ENV, fetchFn: fn },
    );

    expect(report.connectors.identity).toEqual({
      provider: 'accounts',
      status: 'ok',
      detail: HEALTH_DETAILS.reachable,
    });
    expect(calls.map((c) => String(c.url))).toContain(DEFAULT_AUTH_PROBE_URL);
  });

  it('probes identity.probeUrl as given when set, never the public URL', async () => {
    // Same reason db.probeUrl exists: inside the api container the public URL
    // is the container itself, so probing it says nothing about GoTrue.
    const { fn, calls } = fetchReturning(httpResponse(200, GOTRUE_HEALTH));
    const report = await aggregateHealth(
      {
        ...BASE_CONFIG,
        publicUrl: 'https://arena.acme.com',
        identity: {
          mode: 'sso',
          methods: ['azure'],
          allowGuests: false,
          azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' },
          probeUrl: 'http://auth:9999/health',
        },
      },
      { env: HEALTHY_ENV, fetchFn: fn },
    );

    expect(report.connectors.identity?.status).toBe('ok');
    expect(report.connectors.identity?.provider).toBe('sso');
    expect(calls.map((c) => String(c.url))).toContain('http://auth:9999/health');
    expect(calls.map((c) => String(c.url))).not.toContain('https://arena.acme.com/auth/v1/health');
  });

  it('accepts a 200 whose body carries no status field', async () => {
    // capture-service's /health is checked for `status: 'ok'` because an SPA
    // fallback answers 200 with HTML. GoTrue's body has no such field, so
    // requiring one would report a perfectly healthy identity service as
    // degraded on every poll.
    const { fn } = fetchReturning(httpResponse(200, GOTRUE_HEALTH));
    const report = await aggregateHealth(
      { ...BASE_CONFIG, identity: { mode: 'accounts', methods: ['password'], allowGuests: false } },
      { env: HEALTHY_ENV, fetchFn: fn },
    );
    expect(report.connectors.identity?.status).toBe('ok');
  });

  it('is degraded when the identity service is down, and the rest of the report survives', async () => {
    const report = await aggregateHealth(
      { ...BASE_CONFIG, identity: { mode: 'accounts', methods: ['password'], allowGuests: false } },
      {
        env: HEALTHY_ENV,
        fetchFn: (async (url: string) => {
          if (String(url).includes('/rest/v1/')) return httpResponse(200, { definitions: {} });
          throw new TypeError('fetch failed for http://auth:9999/health');
        }) as unknown as typeof globalThis.fetch,
      },
    );

    expect(report.ok).toBe(false);
    expect(report.connectors.identity).toEqual({
      provider: 'accounts',
      status: 'degraded',
      detail: HEALTH_DETAILS.unreachable,
    });
    expect(report.connectors.db?.status).toBe('ok');
    expect(report.connectors.capture?.status).toBe('ok');
  });

  it('separates an upstream error from a missing route', async () => {
    const config: ViewpointConfig = {
      ...BASE_CONFIG,
      identity: { mode: 'accounts', methods: ['password'], allowGuests: false },
    };

    const errored = await aggregateHealth(config, {
      env: HEALTHY_ENV,
      fetchFn: (async (url: string) =>
        String(url).includes('/rest/v1/')
          ? httpResponse(200, { definitions: {} })
          : httpResponse(500, { msg: 'Internal Server Error' })) as unknown as typeof globalThis.fetch,
    });
    expect(errored.connectors.identity?.detail).toBe(HEALTH_DETAILS.upstreamError);

    // A 502 from nginx-proxy when the `identity` compose profile is off but the
    // config says accounts is the misconfiguration this distinguishes.
    const missing = await aggregateHealth(config, {
      env: HEALTHY_ENV,
      fetchFn: (async (url: string) =>
        String(url).includes('/rest/v1/')
          ? httpResponse(200, { definitions: {} })
          : httpResponse(404)) as unknown as typeof globalThis.fetch,
    });
    expect(missing.connectors.identity?.detail).toBe(HEALTH_DETAILS.routeUnavailable);
  });

  it('publishes no probe URL and no env var name', async () => {
    const { fn } = fetchReturning(httpResponse(200, GOTRUE_HEALTH));
    const report = await aggregateHealth(
      {
        ...BASE_CONFIG,
        identity: {
          mode: 'sso',
          methods: ['azure'],
          allowGuests: false,
          azure: { clientIdEnv: 'AZURE_CLIENT_ID', secretEnv: 'AZURE_CLIENT_SECRET' },
          probeUrl: 'http://auth:9999/health',
        },
      },
      {
        env: { ...HEALTHY_ENV, AZURE_CLIENT_ID: 'the-client-id', AZURE_CLIENT_SECRET: 'the-secret' },
        fetchFn: fn,
      },
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('auth:9999');
    expect(serialized).not.toContain('AZURE_CLIENT_ID');
    expect(serialized).not.toContain('AZURE_CLIENT_SECRET');
    expect(serialized).not.toContain('://');
  });
});

// ─── The genericGltf shortcut ───────────────────────────────────────────────

describe('modelImport genericGltf', () => {
  it('reports exactly what the adapter itself would report', async () => {
    // aggregate.ts does not construct GenericUploadModelImportAdapter, because
    // importing it pulls utils/modelLoader.ts — and therefore THREE plus four
    // model loaders — into a serverless health endpoint. That shortcut is only
    // safe while the two answers agree, so this pins them together.
    const fromAdapter = await new GenericUploadModelImportAdapter().healthCheck();
    const { fn } = fetchReturning(httpResponse(200, {}));
    const report = await aggregateHealth(BASE_CONFIG, { env: HEALTHY_ENV, fetchFn: fn });

    expect(report.connectors.modelImport).toEqual({
      provider: 'genericGltf',
      status: fromAdapter.ok ? 'ok' : 'degraded',
      detail: fromAdapter.detail,
    });
  });
});
