// Tests for ConfigContext — the client-side config wiring added by T3.7.
//
// The fail-safe is the point of this file. Every "config unavailable" path
// (rejected fetch, non-OK response, HTML body from an SPA fallback, malformed
// JSON, no provider mounted at all) must resolve to FALLBACK_PROVIDERS — the
// providers the app hardcoded before the context existed — and must never
// throw. A deployment without viewpoint.config.ts has to behave exactly like
// the app did before this ticket.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ConfigProvider, useConnectorConfig, FALLBACK_PROVIDERS } from '../ConfigContext.tsx';
import { resetPublicConfigCache } from '../publicConfig.ts';

// What /api/public-config returns for a deployment that picked different
// providers than the fallbacks, so "read from config" is distinguishable from
// "fell back".
const fetchedConfig = {
  plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com' },
  capture: { provider: 'mock' },
  turn: { provider: 'selfHostedCoturn' },
  db: { provider: 'supabase' },
  notifications: [{ provider: 'teams' }],
  modelImport: { provider: 'genericGltf' },
};

const Probe: React.FC = () => {
  const cfg = useConnectorConfig();
  return (
    <div>
      <span data-testid="plm">{cfg.plm}</span>
      <span data-testid="capture">{cfg.capture}</span>
      <span data-testid="turn">{cfg.turn}</span>
      <span data-testid="db">{cfg.db}</span>
      <span data-testid="modelImport">{cfg.modelImport}</span>
      <span data-testid="notifications">{cfg.notifications.join(',')}</span>
      <span data-testid="loading">{String(cfg.loading)}</span>
      <span data-testid="available">{String(cfg.available)}</span>
      <span data-testid="error">{cfg.error ?? ''}</span>
    </div>
  );
};

/** Stubs global fetch to answer /api/public-config with `response`. */
function stubConfigEndpoint(response: { ok: boolean; status?: number; body?: unknown } | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return {
      ok: response.ok,
      status: response.status ?? 200,
      json: async () => response.body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Blocks until every mounted provider has settled, so assertions never race. */
async function waitUntilSettled(): Promise<void> {
  await waitFor(() => {
    const flags = screen.getAllByTestId('loading').map((n) => n.textContent);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((flag) => flag === 'false')).toBe(true);
  });
}

describe('ConfigContext', () => {
  beforeEach(() => {
    resetPublicConfigCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetPublicConfigCache();
  });

  it('exposes the fetched provider for every connector category', async () => {
    stubConfigEndpoint({ ok: true, body: fetchedConfig });

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(screen.getByTestId('available').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe('');
    expect(screen.getByTestId('plm').textContent).toBe('onshape');
    expect(screen.getByTestId('capture').textContent).toBe('mock');
    expect(screen.getByTestId('turn').textContent).toBe('selfHostedCoturn');
    expect(screen.getByTestId('db').textContent).toBe('supabase');
    expect(screen.getByTestId('modelImport').textContent).toBe('genericGltf');
    expect(screen.getByTestId('notifications').textContent).toBe('teams');
  });

  it('fetches once for many consumers', async () => {
    const fetchMock = stubConfigEndpoint({ ok: true, body: fetchedConfig });

    render(
      <ConfigProvider>
        <Probe />
        <Probe />
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/public-config');
    expect(screen.getAllByTestId('plm').map((n) => n.textContent)).toEqual([
      'onshape',
      'onshape',
      'onshape',
    ]);
  });

  it('fetches once across separately mounted providers', async () => {
    const fetchMock = stubConfigEndpoint({ ok: true, body: fetchedConfig });

    const first = render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();
    first.unmount();

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the fallbacks while the fetch is still in flight', () => {
    // Never resolves: the UI has to be usable during the wait, not blank.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('available').textContent).toBe('false');
    expect(screen.getByTestId('plm').textContent).toBe(FALLBACK_PROVIDERS.plm);
    expect(screen.getByTestId('notifications').textContent).toBe(
      FALLBACK_PROVIDERS.notifications.join(','),
    );
  });

  it('exposes an error state without throwing when the fetch rejects', async () => {
    stubConfigEndpoint(new TypeError('network down'));

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(screen.getByTestId('available').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe(
      'Failed to fetch public config: network down',
    );
    // The fail-safe: every category resolves to the pre-config provider.
    expect(screen.getByTestId('plm').textContent).toBe(FALLBACK_PROVIDERS.plm);
    expect(screen.getByTestId('capture').textContent).toBe(FALLBACK_PROVIDERS.capture);
    expect(screen.getByTestId('turn').textContent).toBe(FALLBACK_PROVIDERS.turn);
    expect(screen.getByTestId('db').textContent).toBe(FALLBACK_PROVIDERS.db);
    expect(screen.getByTestId('modelImport').textContent).toBe(FALLBACK_PROVIDERS.modelImport);
    expect(screen.getByTestId('notifications').textContent).toBe(
      FALLBACK_PROVIDERS.notifications.join(','),
    );
  });

  it('exposes an error state on a non-OK response', async () => {
    stubConfigEndpoint({ ok: false, status: 500 });

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(screen.getByTestId('available').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe(
      'Public config endpoint returned 500',
    );
    expect(screen.getByTestId('plm').textContent).toBe(FALLBACK_PROVIDERS.plm);
  });

  it('treats an HTML body from an SPA fallback as unavailable', async () => {
    // `vite preview` answers unknown paths with index.html and a 200, which is
    // what local dev and the e2e run hit. response.json() throws.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })),
    );

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(screen.getByTestId('available').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toContain('Unexpected token');
    expect(screen.getByTestId('plm').textContent).toBe(FALLBACK_PROVIDERS.plm);
  });

  it('treats a JSON body that is not a config as unavailable', async () => {
    // A proxy or half-finished deploy could return valid JSON with no providers.
    // Reading config.plm.provider off that would throw inside render.
    stubConfigEndpoint({ ok: true, body: { unexpected: true } });

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(screen.getByTestId('available').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe(
      'Public config response did not match the expected shape',
    );
    expect(screen.getByTestId('plm').textContent).toBe(FALLBACK_PROVIDERS.plm);
    expect(screen.getByTestId('modelImport').textContent).toBe(FALLBACK_PROVIDERS.modelImport);
  });

  it('accepts a config with no notification providers', async () => {
    stubConfigEndpoint({ ok: true, body: { ...fetchedConfig, notifications: [] } });

    render(
      <ConfigProvider>
        <Probe />
      </ConfigProvider>,
    );
    await waitUntilSettled();

    expect(screen.getByTestId('available').textContent).toBe('true');
    expect(screen.getByTestId('notifications').textContent).toBe('');
  });

  it('falls back instead of throwing when no provider is mounted', () => {
    render(<Probe />);

    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('available').textContent).toBe('false');
    expect(screen.getByTestId('plm').textContent).toBe(FALLBACK_PROVIDERS.plm);
    expect(screen.getByTestId('capture').textContent).toBe(FALLBACK_PROVIDERS.capture);
    expect(screen.getByTestId('turn').textContent).toBe(FALLBACK_PROVIDERS.turn);
    expect(screen.getByTestId('db').textContent).toBe(FALLBACK_PROVIDERS.db);
    expect(screen.getByTestId('modelImport').textContent).toBe(FALLBACK_PROVIDERS.modelImport);
    expect(screen.getByTestId('notifications').textContent).toBe(
      FALLBACK_PROVIDERS.notifications.join(','),
    );
  });
});
