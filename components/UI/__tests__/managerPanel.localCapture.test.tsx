// ManagerPanel — structure and config-driven rendering.
//
// The recording UI moved to RecordingControls (tested in
// RecordingControls.test.tsx) which reads from RecordingContext. Without a
// RecordingProvider above the panel, RecordingControls renders nothing — so
// the panel itself is free of recording state and these tests focus on the
// panel structure: header, tabs, and the fact that no recording UI leaks
// through regardless of the capture provider.
//
// Config is driven through the real ConfigProvider with /api/public-config
// stubbed, the same way integrationsPanel.config.test.tsx does it, so "read
// the config" is never confusable with "fell back to the default provider".

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import ManagerPanel from '../ManagerPanel';
import {
  ConfigProvider,
  useConnectorConfig,
} from '../../../lib/config/ConfigContext';
import { resetPublicConfigCache } from '../../../lib/config/publicConfig.ts';

const CONFIG_PATH = '/api/public-config';

/** The tabs that must be there whatever the capture provider is. */
const EXISTING_TABS = ['Actions', 'Notes', 'Curated', 'Capture', 'Comments', 'Chat'];

function publicConfigBody(captureProvider: string) {
  return {
    plm: { provider: 'none' },
    capture: { provider: captureProvider },
    turn: { provider: 'cloudflare' },
    db: { provider: 'supabase' },
    notifications: [],
    modelImport: { provider: 'genericGltf' },
  };
}

function stubConfigFetch(response: unknown | Error) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CONFIG_PATH) {
        if (response instanceof Error) throw response;
        return { ok: true, status: 200, json: async () => response };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
}

// Renders alongside the panel so a test can prove the config fetch really
// settled — otherwise the "no section" assertions could pass vacuously because
// nothing was ever fetched.
const ConfigProbe: React.FC = () => {
  const cfg = useConnectorConfig();
  return (
    <div>
      <span data-testid="cfg-available">{String(cfg.available)}</span>
      <span data-testid="cfg-capture">{cfg.capture}</span>
    </div>
  );
};

async function renderPanel(captureProvider: string): Promise<void> {
  stubConfigFetch(publicConfigBody(captureProvider));
  render(
    <ConfigProvider>
      <ConfigProbe />
      <ManagerPanel />
    </ConfigProvider>,
  );
  // `available` is true only when the body really came from the endpoint, so a
  // fallback to 'mock' cannot be mistaken for a configured 'mock' deployment.
  await waitFor(() =>
    expect(screen.getByTestId('cfg-available').textContent).toBe('true'),
  );
  await waitFor(() =>
    expect(screen.getByTestId('cfg-capture').textContent).toBe(captureProvider),
  );
}

function expectExistingTabsIntact(): void {
  for (const tab of EXISTING_TABS) {
    expect(
      screen.queryByRole('button', { name: new RegExp(`^${tab}`) }),
      `the ${tab} tab should still be rendered`,
    ).not.toBeNull();
  }
}

describe('ManagerPanel — structure', () => {
  beforeEach(() => {
    resetPublicConfigCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['mock', 'openai', 'anthropic', 'ollamaDirect'])(
    'renders no recording UI when capture.provider is "%s"',
    async (provider) => {
      await renderPanel(provider);

      // RecordingControls renders nothing without a RecordingProvider, so no
      // recording text or buttons appear regardless of the provider.
      expect(screen.queryByText('Post-meeting summary')).toBeNull();
      expect(screen.queryByText('local capture')).toBeNull();
      expect(
        screen.queryByRole('button', { name: /start recording/i }),
      ).toBeNull();
      expectExistingTabsIntact();
      expect(screen.getByText('Manager')).toBeInTheDocument();
    },
  );

  it('renders the panel structure when capture.provider is "local"', async () => {
    await renderPanel('local');

    // The recording UI lives in RecordingControls (RecordingControls.test.tsx),
    // which renders nothing without a RecordingProvider. The panel itself
    // keeps its header, tabs, and layout.
    expect(screen.getByText('Manager')).toBeInTheDocument();
    expectExistingTabsIntact();
  });

  it('renders the panel structure when the config endpoint is unreachable', async () => {
    // The documented fail-safe: config unavailable means "behave as before",
    // which for this panel means no recorder.
    stubConfigFetch(new Error('network down'));
    render(
      <ConfigProvider>
        <ConfigProbe />
        <ManagerPanel />
      </ConfigProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('cfg-available').textContent).toBe('false'),
    );

    expect(screen.getByTestId('cfg-capture').textContent).toBe('mock');
    expect(screen.queryByText('Post-meeting summary')).toBeNull();
    expectExistingTabsIntact();
  });
});
