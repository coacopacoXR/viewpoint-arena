// IntegrationsPanel connector selection (T3.7).
//
// The panel used to hardcode TeamcenterPLMAdapter and TeamsNotifyAdapter. It now
// reads the active provider from ConfigContext. Two things are asserted here:
//
//   1. SELECTION  — plm.provider decides whether the Teamcenter integration is
//      offered, notifications decides whether Teams is offered. Asserted on the
//      rendered DOM, not on internal state.
//   2. FAIL-SAFE  — when /api/public-config cannot be reached the panel renders
//      exactly the integrations it rendered before it was config-aware. A
//      missing config must never blank the panel or throw.
//
// Adapter behaviour is out of scope: the isConfigured() probes are answered with
// 404 so every section renders its "not configured" state, which still names the
// integration.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import IntegrationsPanel from '../IntegrationsPanel';
import { ConfigProvider, useConnectorConfig } from '../../../lib/config/ConfigContext';
import { resetPublicConfigCache } from '../../../lib/config/publicConfig.ts';

const CONFIG_PATH = '/api/public-config';

// A deployment that differs from the fallbacks wherever it can, so "read the
// config" is never confusable with "fell back".
const baseConfig = {
  plm: { provider: 'teamcenter', baseUrl: 'https://tc.example.com' },
  capture: { provider: 'mock' },
  turn: { provider: 'cloudflare' },
  db: { provider: 'supabase' },
  notifications: [{ provider: 'teams' }],
  modelImport: { provider: 'onshape' },
};

type ConfigResponse = { ok: boolean; status?: number; body?: unknown } | Error;

function stubFetch(configResponse: ConfigResponse) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === CONFIG_PATH) {
      if (configResponse instanceof Error) throw configResponse;
      return {
        ok: configResponse.ok,
        status: configResponse.status ?? 200,
        json: async () => configResponse.body,
      };
    }
    // HEAD /api/notify/teams and HEAD /api/teamcenter/login from isConfigured().
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// Renders alongside the panel so a test can prove the config fetch really
// settled (and really failed) — otherwise a fail-safe assertion could pass
// vacuously because nothing was ever fetched.
const ConfigProbe: React.FC = () => {
  const cfg = useConnectorConfig();
  return (
    <div>
      <span data-testid="cfg-loading">{String(cfg.loading)}</span>
      <span data-testid="cfg-error">{cfg.error ?? ''}</span>
    </div>
  );
};

/** Tab-bar button for an integration, or null when the config removed it. */
function tabButton(label: string) {
  // Anchored on the icon so section buttons whose names also contain the label
  // ("Post Session Summary to Teams") never match.
  return screen.queryByRole('button', { name: new RegExp(`^[^A-Za-z]*${label}$`) });
}

// Each section renders a "Checking configuration…" branch first, then settles on
// the not-configured branch (the adapter probes are answered with 404). Waiting
// for the settled text keeps the assertions off a node React is about to
// replace; the heading is then stable and can be asserted synchronously.
const TEAMS_NOT_CONFIGURED =
  'Teams is not configured. Ask your administrator to set TEAMS_WEBHOOK_URL on the server.';
const TEAMCENTER_NOT_CONFIGURED =
  'Teamcenter is not configured. Ask your administrator to set TC_BASE_URL, TC_USERNAME, and TC_PASSWORD on the server.';

async function expectTeamsSectionRendered(): Promise<void> {
  await screen.findByText(TEAMS_NOT_CONFIGURED);
  expect(screen.getByText('Microsoft Teams')).toBeInTheDocument();
}

async function expectTeamcenterSectionRendered(): Promise<void> {
  await screen.findByText(TEAMCENTER_NOT_CONFIGURED);
  expect(screen.getByText('Teamcenter PLM')).toBeInTheDocument();
}

function renderPanel(configResponse: ConfigResponse) {
  const fetchMock = stubFetch(configResponse);
  render(
    <ConfigProvider>
      <ConfigProbe />
      <IntegrationsPanel session={null} items={[]} onClose={() => {}} />
    </ConfigProvider>,
  );
  return fetchMock;
}

async function settleConfig(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('cfg-loading').textContent).toBe('false'));
}

describe('IntegrationsPanel connector selection', () => {
  beforeEach(() => {
    resetPublicConfigCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetPublicConfigCache();
  });

  // ─── Fail-safe ────────────────────────────────────────────────────────────

  it('renders every integration it rendered before when the config fetch rejects', async () => {
    renderPanel(new TypeError('network down'));

    // Offered immediately, before the fetch has settled.
    expect(tabButton('Teams')).toBeInTheDocument();
    expect(tabButton('SharePoint')).toBeInTheDocument();
    expect(tabButton('Teamcenter')).toBeInTheDocument();

    await settleConfig();
    expect(screen.getByTestId('cfg-error').textContent).toBe(
      'Failed to fetch public config: network down',
    );

    // Still offered after the failure — a missing config is "behave as before",
    // not "no providers configured".
    expect(tabButton('Teams')).toBeInTheDocument();
    expect(tabButton('SharePoint')).toBeInTheDocument();
    expect(tabButton('Teamcenter')).toBeInTheDocument();

    // And the sections themselves render, not just the tab bar.
    await expectTeamsSectionRendered();
    fireEvent.click(tabButton('Teamcenter')!);
    await expectTeamcenterSectionRendered();
  });

  it('renders every integration when the endpoint returns HTML from an SPA fallback', async () => {
    // `vite preview` (and any static host without the API deployed) answers
    // /api/public-config with index.html and a 200, so response.json() throws.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === CONFIG_PATH
          ? {
              ok: true,
              status: 200,
              json: async () => {
                throw new SyntaxError('Unexpected token <');
              },
            }
          : { ok: false, status: 404, json: async () => ({}) },
      ),
    );

    render(
      <ConfigProvider>
        <ConfigProbe />
        <IntegrationsPanel session={null} items={[]} onClose={() => {}} />
      </ConfigProvider>,
    );
    await settleConfig();

    expect(screen.getByTestId('cfg-error').textContent).toContain('Unexpected token');
    expect(tabButton('Teams')).toBeInTheDocument();
    expect(tabButton('SharePoint')).toBeInTheDocument();
    expect(tabButton('Teamcenter')).toBeInTheDocument();
    await expectTeamsSectionRendered();
  });

  it('renders every integration with no ConfigProvider mounted at all', async () => {
    stubFetch({ ok: false, status: 404 });
    render(<IntegrationsPanel session={null} items={[]} onClose={() => {}} />);

    expect(tabButton('Teams')).toBeInTheDocument();
    expect(tabButton('SharePoint')).toBeInTheDocument();
    expect(tabButton('Teamcenter')).toBeInTheDocument();
    await expectTeamsSectionRendered();
  });

  // ─── Selection ────────────────────────────────────────────────────────────

  it('offers the Teamcenter integration when plm.provider is teamcenter', async () => {
    renderPanel({ ok: true, body: baseConfig });
    await settleConfig();

    expect(tabButton('Teamcenter')).toBeInTheDocument();
    fireEvent.click(tabButton('Teamcenter')!);

    await expectTeamcenterSectionRendered();
  });

  it('does not offer the Teamcenter integration when plm.provider is onshape', async () => {
    renderPanel({
      ok: true,
      body: { ...baseConfig, plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com' } },
    });
    await settleConfig();

    // Present before the config lands, gone after it does.
    await waitFor(() => expect(tabButton('Teamcenter')).not.toBeInTheDocument());
    expect(screen.queryByText('Teamcenter PLM')).not.toBeInTheDocument();

    // The rest of the panel is untouched by the PLM choice.
    expect(tabButton('Teams')).toBeInTheDocument();
    expect(tabButton('SharePoint')).toBeInTheDocument();
    await expectTeamsSectionRendered();
  });

  it('does not offer Teams when the config lists no teams notification provider', async () => {
    renderPanel({ ok: true, body: { ...baseConfig, notifications: [] } });
    await settleConfig();

    await waitFor(() => expect(tabButton('Teams')).not.toBeInTheDocument());
    expect(screen.queryByText('Microsoft Teams')).not.toBeInTheDocument();

    // Teams was the default tab: the panel must switch to an offered tab rather
    // than show an empty content area.
    expect(tabButton('SharePoint')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Write tracker items to a SharePoint list via Microsoft Graph API.',
      ),
    ).toBeInTheDocument();
    expect(tabButton('Teamcenter')).toBeInTheDocument();
  });

  it('keeps offering SharePoint, which no config field selects', async () => {
    renderPanel({
      ok: true,
      body: {
        ...baseConfig,
        plm: { provider: 'onshape', baseUrl: 'https://cad.onshape.com' },
        notifications: [],
      },
    });
    await settleConfig();

    expect(tabButton('SharePoint')).toBeInTheDocument();
    expect(
      await screen.findByText(
        'Write tracker items to a SharePoint list via Microsoft Graph API.',
      ),
    ).toBeInTheDocument();
  });
});
