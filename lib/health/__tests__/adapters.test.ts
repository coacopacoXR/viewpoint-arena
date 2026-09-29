// Every adapter implements healthCheck(), and every one of them obeys the three
// rules written on PLMAdapter.healthCheck: never reject, never leak, stay cheap.
//
// This is a table-driven test over the whole adapter set on purpose. The
// interfaces declare healthCheck as OPTIONAL — so that a corp's existing adapter
// keeps compiling — which means nothing in the type system forces an
// implementation to exist or behave. T5.2 says "implement it for every adapter";
// this file is what makes that a checked property instead of an intention, and
// it fails when somebody adds an adapter without one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeDetail } from '../sanitize.ts';
import { HEALTH_DETAILS } from '../details.ts';
import type { HealthCheckResult } from '../types.ts';

import { MockPLMAdapter } from '../../connectors/plm/mock.ts';
import { OnshapePLMAdapter } from '../../connectors/plm/onshape.ts';
import { TeamcenterPLMAdapter } from '../../connectors/plm/teamcenter.ts';
import { MockCaptureProvider } from '../../connectors/capture/mock.ts';
import { OpenAICaptureProvider } from '../../connectors/capture/openai.ts';
import { AnthropicCaptureProvider } from '../../connectors/capture/anthropic.ts';
import { OllamaDirectCaptureProvider } from '../../connectors/capture/ollamaDirect.ts';
import { CloudflareTurnAdapter } from '../../connectors/turn/cloudflare.ts';
import { SelfHostedCoturnAdapter } from '../../connectors/turn/selfHostedCoturn.ts';
import { MockTurnAdapter } from '../../connectors/turn/mock.ts';
import { TeamsNotifyAdapter } from '../../connectors/notify/teams.ts';
import { MockNotificationSink } from '../../connectors/notify/mock.ts';
import { OnshapeModelImportAdapter } from '../../connectors/modelImport/onshape.ts';
import { GenericUploadModelImportAdapter } from '../../connectors/modelImport/genericUpload.ts';
import { MockModelImportAdapter } from '../../connectors/modelImport/mock.ts';

interface AdapterCase {
  name: string;
  make: () => { healthCheck?: () => Promise<HealthCheckResult> };
}

const ADAPTERS: AdapterCase[] = [
  { name: 'MockPLMAdapter', make: () => new MockPLMAdapter() },
  { name: 'OnshapePLMAdapter', make: () => new OnshapePLMAdapter() },
  { name: 'TeamcenterPLMAdapter', make: () => new TeamcenterPLMAdapter() },
  { name: 'MockCaptureProvider', make: () => new MockCaptureProvider() },
  { name: 'OpenAICaptureProvider', make: () => new OpenAICaptureProvider() },
  { name: 'AnthropicCaptureProvider', make: () => new AnthropicCaptureProvider() },
  {
    name: 'OllamaDirectCaptureProvider',
    make: () =>
      new OllamaDirectCaptureProvider({
        baseUrl: 'http://ollama.internal:11434',
        model: 'deepseek-r1:7b',
      }),
  },
  {
    name: 'CloudflareTurnAdapter',
    make: () =>
      new CloudflareTurnAdapter({
        tokenIdEnv: 'CF_TURN_TOKEN_ID',
        apiTokenEnv: 'CF_TURN_API_TOKEN',
        env: { CF_TURN_TOKEN_ID: 'token-id', CF_TURN_API_TOKEN: 'api-token' },
      }),
  },
  {
    name: 'SelfHostedCoturnAdapter',
    make: () =>
      new SelfHostedCoturnAdapter({
        host: 'turn.example',
        port: 3478,
        sharedSecretEnv: 'COTURN_SHARED_SECRET',
        env: { COTURN_SHARED_SECRET: 'coturn-secret' },
        // Unreachable, like every network in this suite.
        probe: async () => {
          throw new Error('network down');
        },
      }),
  },
  { name: 'MockTurnAdapter', make: () => new MockTurnAdapter() },
  { name: 'TeamsNotifyAdapter', make: () => new TeamsNotifyAdapter() },
  { name: 'MockNotificationSink', make: () => new MockNotificationSink() },
  { name: 'OnshapeModelImportAdapter', make: () => new OnshapeModelImportAdapter() },
  { name: 'GenericUploadModelImportAdapter', make: () => new GenericUploadModelImportAdapter() },
  { name: 'MockModelImportAdapter', make: () => new MockModelImportAdapter() },
];

// Values an adapter must never put in a detail. Planted in the environment so
// safeDetail's value check has something to find, and shaped like the real
// thing so the shape rule is exercised against realistic strings.
const FORBIDDEN_ENV = {
  ONSHAPE_CLIENT_SECRET: 'Jx7Qm2Vp9Ld4Rt6Yw1Zk8Nb3Hg5Fc0Sa', // gitleaks:allow (fake test value)
  TEAMS_WEBHOOK_URL: 'https://acme.webhook.office.com/webhookb2/1a2b3c4d',
  CF_TURN_API_TOKEN: 'v2.token.value.9f8e7d6c5b4a',
  CAPTURE_SHARED_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', // gitleaks:allow (fake test value)
};

describe('every adapter implements healthCheck', () => {
  it.each(ADAPTERS.map((a) => [a.name, a] as const))('%s has one', (_name, adapter) => {
    expect(typeof adapter.make().healthCheck).toBe('function');
  });
});

/** Adapters whose healthCheck performs a network call. */
const NETWORK_DEPENDENT = new Set([
  'OnshapePLMAdapter',
  'TeamcenterPLMAdapter',
  'OpenAICaptureProvider',
  'AnthropicCaptureProvider',
  'OllamaDirectCaptureProvider',
  'TeamsNotifyAdapter',
  'OnshapeModelImportAdapter',
]);

describe('healthCheck never rejects', () => {
  beforeEach(() => {
    // The worst case an adapter can face: every network call fails. A health
    // check that propagated this would take /api/health down with it, and with
    // it the report on every OTHER connector.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof globalThis.fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ADAPTERS.map((a) => [a.name, a] as const))(
    '%s resolves with a result instead of throwing when the network is down',
    async (_name, adapter) => {
      const result = await adapter.make().healthCheck?.();
      expect(result).toBeDefined();
      expect(typeof result?.ok).toBe('boolean');
    },
  );

  it.each(
    ADAPTERS.filter((a) => NETWORK_DEPENDENT.has(a.name)).map((a) => [a.name, a] as const),
  )('%s reports ok:false rather than ok:true when its upstream is gone', async (_name, adapter) => {
    // Only for adapters that actually reach something. CloudflareTurnAdapter and
    // the mocks answer from configuration or from nothing at all, and reporting
    // those as failed when the network is down would be a lie in the other
    // direction.
    const result = await adapter.make().healthCheck?.();
    expect(result?.ok).toBe(false);
  });
});


describe('healthCheck details survive sanitisation unchanged', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ status: 'ok', models: [{ name: 'deepseek-r1:7b' }], definitions: {} }),
        }) as unknown as Response,
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(ADAPTERS.map((a) => [a.name, a] as const))(
    '%s returns a detail the endpoint can actually publish',
    async (_name, adapter) => {
      const result = await adapter.make().healthCheck?.();
      expect(result).toBeDefined();
      if (result?.detail === undefined) return;

      // If safeDetail drops it, the phrase never reaches an operator and the
      // adapter is silently less useful than it looks. Failing here is the
      // point: wording is part of the contract.
      expect(
        safeDetail(result.detail, FORBIDDEN_ENV),
        `detail was not publishable: ${JSON.stringify(result.detail)}`,
      ).toBe(result.detail);

      // And it must be a phrase from the shared vocabulary, not prose composed
      // per adapter — one situation, one description, everywhere.
      expect(Object.values(HEALTH_DETAILS)).toContain(result.detail);
    },
  );
});

describe('the shared vocabulary', () => {
  it('every HEALTH_DETAILS phrase is publishable', () => {
    // A phrase added to details.ts that safeDetail would drop is worse than no
    // phrase at all: every adapter using it would report a status with no
    // explanation and nobody would know why.
    for (const [key, phrase] of Object.entries(HEALTH_DETAILS)) {
      expect(safeDetail(phrase, FORBIDDEN_ENV), `${key} is not publishable`).toBe(
        phrase,
      );
    }
  });

  it('has no duplicate wording', () => {
    const phrases = Object.values(HEALTH_DETAILS);
    expect(new Set(phrases).size).toBe(phrases.length);
  });
});

describe('specific adapter behaviour', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('CloudflareTurnAdapter checks configuration without minting a credential', async () => {
    // getIceServers() spends Cloudflare's metered TURN quota and returns a
    // username/credential pair. A health check must do neither.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new CloudflareTurnAdapter({
      tokenIdEnv: 'CF_TURN_TOKEN_ID',
      apiTokenEnv: 'CF_TURN_API_TOKEN',
      env: { CF_TURN_TOKEN_ID: 'token-id', CF_TURN_API_TOKEN: 'api-token' },
    });

    await expect(adapter.healthCheck()).resolves.toEqual({
      ok: true,
      detail: HEALTH_DETAILS.configured,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CloudflareTurnAdapter reports missing credentials without naming them', async () => {
    const adapter = new CloudflareTurnAdapter({
      tokenIdEnv: 'CF_TURN_TOKEN_ID',
      apiTokenEnv: 'CF_TURN_API_TOKEN',
      env: { CF_TURN_TOKEN_ID: 'token-id' },
    });
    const result = await adapter.healthCheck();

    expect(result).toEqual({ ok: false, detail: HEALTH_DETAILS.notConfigured });
    expect(JSON.stringify(result)).not.toContain('CF_TURN_API_TOKEN');
  });

  it('SelfHostedCoturnAdapter reports a missing secret without probing or naming it', async () => {
    const probe = vi.fn(async () => true);
    const adapter = new SelfHostedCoturnAdapter({
      host: 'turn.example',
      port: 3478,
      sharedSecretEnv: 'COTURN_SHARED_SECRET',
      env: {},
      probe,
    });
    const result = await adapter.healthCheck();
    expect(result).toEqual({ ok: false, detail: HEALTH_DETAILS.notConfigured });
    expect(probe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('COTURN_SHARED_SECRET');
  });

  it('SelfHostedCoturnAdapter is ok only when coturn answers the STUN probe', async () => {
    const make = (up: boolean) =>
      new SelfHostedCoturnAdapter({
        host: 'turn.example',
        port: 3478,
        sharedSecretEnv: 'S',
        env: { S: 'x' },
        probe: async () => up,
      });
    await expect(make(true).healthCheck()).resolves.toEqual({ ok: true, detail: HEALTH_DETAILS.reachable });
    await expect(make(false).healthCheck()).resolves.toEqual({ ok: false, detail: HEALTH_DETAILS.unreachable });
  });

  it('OllamaDirectCaptureProvider accepts an untagged configured model', async () => {
    // Ollama lists pulled tags; a config naming the bare model resolves to
    // :latest. Reporting that as "model missing" would call a working
    // deployment broken.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'deepseek-r1:latest' }] }),
        }) as unknown as Response,
      ),
    );
    const adapter = new OllamaDirectCaptureProvider({
      baseUrl: 'http://ollama.internal:11434',
      model: 'deepseek-r1',
    });
    await expect(adapter.healthCheck()).resolves.toEqual({
      ok: true,
      detail: HEALTH_DETAILS.modelAvailable,
    });
  });

  it('OllamaDirectCaptureProvider reports a missing model, without the host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'llama3.1:8b' }] }) }) as unknown as Response,
      ),
    );
    const adapter = new OllamaDirectCaptureProvider({
      baseUrl: 'http://ollama.internal:11434',
      model: 'deepseek-r1:7b',
    });
    const result = await adapter.healthCheck();

    expect(result).toEqual({ ok: false, detail: HEALTH_DETAILS.modelMissing });
    expect(JSON.stringify(result)).not.toContain('ollama.internal');
  });

  it('TeamsNotifyAdapter checks configuration without posting to the channel', async () => {
    // A health check that sent a real card would put a test message in a team's
    // channel on every poll.
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method });
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }),
    );

    const result = await new TeamsNotifyAdapter().healthCheck();

    expect(result).toEqual({ ok: true, detail: HEALTH_DETAILS.configured });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('HEAD');
  });

  it('TeamcenterPLMAdapter reports an undeployed read path as degraded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    );
    const result = await new TeamcenterPLMAdapter().healthCheck();

    expect(result).toEqual({ ok: false, detail: HEALTH_DETAILS.routeUnavailable });
    // The explanatory message listDocuments() throws — which names files and a
    // ticket — must not become a health detail.
    expect(JSON.stringify(result)).not.toContain('api/teamcenter');
    expect(JSON.stringify(result)).not.toContain('T3.2');
  });

  it('MockTurnAdapter and MockNotificationSink mirror their failure switch', async () => {
    const turn = new MockTurnAdapter();
    turn.shouldFail = true;
    await expect(turn.healthCheck()).resolves.toEqual({
      ok: false,
      detail: HEALTH_DETAILS.checkFailed,
    });

    const sink = new MockNotificationSink();
    sink.shouldFail = true;
    await expect(sink.healthCheck()).resolves.toEqual({
      ok: false,
      detail: HEALTH_DETAILS.checkFailed,
    });
  });
});
