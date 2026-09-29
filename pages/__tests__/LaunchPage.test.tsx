// Tests for the PLM launch deep link page (T5.3).
//
// What is pinned here, in the order the page decides it:
//
//   1. a link that matches the deployment's configured PLM connector creates a
//      NEW review and hands the resolved document over in router state
//   2. the review id is a random uuid, NOT derived from the document (the
//      adapter's roomHint is a label — using it as an id would make rooms
//      guessable by anyone who can see the document)
//   3. a link for a different PLM than the one configured is refused
//   4. an unavailable config is refused (fail-safe: never resolve against a guess)
//   5. a credential in the query string is stripped from the address bar and
//      never reaches the resolved state or the DOM
//
// The adapters are the real ones: resolveLaunchContext is pure, so nothing about
// the resolution is mocked. Only /api/public-config is stubbed.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useParams } from 'react-router-dom';
import LaunchPage from '../LaunchPage';
import { ConfigProvider } from '../../lib/config/ConfigContext';
import { resetPublicConfigCache } from '../../lib/config/publicConfig.ts';

const OS_DOC = 'a1b2c3d4e5f60718293a4b5c';
const OS_WS = 'fffffffffffffffffffffffe';
const OS_EL = '000000000000000000000001';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CONFIG_PATH = '/api/public-config';

function configWith(plm: { provider: string; baseUrl?: string }) {
  return {
    plm,
    capture: { provider: 'mock' },
    turn: { provider: 'cloudflare' },
    db: { provider: 'supabase' },
    notifications: [{ provider: 'teams' }],
    modelImport: { provider: 'onshape' },
  };
}

const ONSHAPE_CONFIG = configWith({
  provider: 'onshape',
  baseUrl: 'https://cad.onshape.com',
});
const TEAMCENTER_CONFIG = configWith({
  provider: 'teamcenter',
  baseUrl: 'https://tc.example.com',
});

type ConfigResponse = { ok: boolean; status?: number; body?: unknown } | Error;

function stubConfig(configResponse: ConfigResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== CONFIG_PATH) return { ok: false, status: 404, json: async () => ({}) };
      if (configResponse instanceof Error) throw configResponse;
      return {
        ok: configResponse.ok,
        status: configResponse.status ?? 200,
        json: async () => configResponse.body,
      };
    }),
  );
}

/** Stands in for ReviewSetupPage: reports where the launch landed and with what. */
const SetupProbe: React.FC = () => {
  const { reviewId } = useParams<{ reviewId: string }>();
  const location = useLocation();
  const state = location.state as {
    plmLaunch?: {
      source: string;
      doc: { id: string; workspaceId?: string; elementId?: string };
    };
  } | null;
  return (
    <div>
      <span data-testid="setup-path">{location.pathname}</span>
      <span data-testid="review-id">{reviewId ?? ''}</span>
      <span data-testid="launch-source">{state?.plmLaunch?.source ?? 'none'}</span>
      <span data-testid="launch-doc">{state?.plmLaunch?.doc.id ?? 'none'}</span>
      <span data-testid="launch-workspace">{state?.plmLaunch?.doc.workspaceId ?? ''}</span>
      <span data-testid="launch-element">{state?.plmLaunch?.doc.elementId ?? ''}</span>
      <span data-testid="has-state">{String(state !== null)}</span>
    </div>
  );
};

function renderLaunch(search: string, configResponse: ConfigResponse) {
  stubConfig(configResponse);
  render(
    <MemoryRouter initialEntries={[`/launch${search}`]}>
      <ConfigProvider>
        <Routes>
          <Route path="/launch" element={<LaunchPage />} />
          <Route path="/review/:reviewId/setup" element={<SetupProbe />} />
          <Route path="/" element={<div data-testid="lobby">lobby</div>} />
        </Routes>
      </ConfigProvider>
    </MemoryRouter>,
  );
}

/** An identity with a name, so the page does not stop at the name prompt. */
function signIn(name = 'Alex Chen') {
  localStorage.setItem('vp_user', JSON.stringify({ name, color: '#4F8EF7' }));
}

const ONSHAPE_LINK = `?plmSource=onshape&plmDoc=${OS_DOC}&plmWorkspace=${OS_WS}&plmElement=${OS_EL}`;

describe('LaunchPage', () => {
  beforeEach(() => {
    resetPublicConfigCache();
    localStorage.clear();
    signIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetPublicConfigCache();
    localStorage.clear();
  });

  // ─── Happy path ───────────────────────────────────────────────────────────

  it('creates a new review and passes the resolved document in router state', async () => {
    renderLaunch(ONSHAPE_LINK, { ok: true, body: ONSHAPE_CONFIG });

    await screen.findByTestId('review-id');
    expect(screen.getByTestId('launch-source').textContent).toBe('onshape');
    expect(screen.getByTestId('launch-doc').textContent).toBe(OS_DOC);
    expect(screen.getByTestId('launch-workspace').textContent).toBe(OS_WS);
    expect(screen.getByTestId('launch-element').textContent).toBe(OS_EL);
    expect(screen.getByTestId('setup-path').textContent).toBe(
      `/review/${screen.getByTestId('review-id').textContent}/setup`,
    );
  });

  it('gives the review a random uuid, not one derived from the document', async () => {
    renderLaunch(ONSHAPE_LINK, { ok: true, body: ONSHAPE_CONFIG });
    await screen.findByTestId('review-id');
    const first = screen.getByTestId('review-id').textContent ?? '';
    cleanup();
    resetPublicConfigCache();

    renderLaunch(ONSHAPE_LINK, { ok: true, body: ONSHAPE_CONFIG });
    await screen.findByTestId('review-id');
    const second = screen.getByTestId('review-id').textContent ?? '';

    for (const id of [first, second]) {
      expect(id).toMatch(UUID_RE);
      // Not the document, not the adapter's roomHint, not a substring of either.
      expect(id).not.toContain(OS_DOC);
      expect(id).not.toBe(`onshape-${OS_DOC}`);
      expect(id).not.toContain('onshape');
    }
    // Two launches of the same document are two different rooms.
    expect(first).not.toBe(second);
  });

  it('resolves a Teamcenter link when the deployment is configured for Teamcenter', async () => {
    renderLaunch('?plmSource=teamcenter&plmDoc=tc-doc-1&plmWorkspace=Rev.A', {
      ok: true,
      body: TEAMCENTER_CONFIG,
    });

    await screen.findByTestId('review-id');
    expect(screen.getByTestId('review-id').textContent).toMatch(UUID_RE);
    expect(screen.getByTestId('launch-source').textContent).toBe('teamcenter');
    expect(screen.getByTestId('launch-doc').textContent).toBe('tc-doc-1');
  });

  // ─── Refusals ─────────────────────────────────────────────────────────────

  it('refuses a link for a different PLM than the deployment is configured for', async () => {
    renderLaunch('?plmSource=teamcenter&plmDoc=tc-doc-1', { ok: true, body: ONSHAPE_CONFIG });

    await screen.findByText(/cannot open a link from Teamcenter/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go to lobby/i })).toBeInTheDocument();
  });

  it('refuses an Onshape link on a Teamcenter deployment', async () => {
    renderLaunch(ONSHAPE_LINK, { ok: true, body: TEAMCENTER_CONFIG });

    await screen.findByText(/cannot open a link from Onshape/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
  });

  it('refuses when the config is unavailable rather than resolving against a fallback', async () => {
    renderLaunch(ONSHAPE_LINK, new TypeError('network down'));

    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
    // The fallback provider is 'teamcenter': had the page used it, an Onshape
    // link would have been refused as a mismatch instead. Either way it must not
    // navigate, and the message must not blame the wrong connector.
    expect(screen.queryByText(/network down/i)).not.toBeInTheDocument();
  });

  it('refuses when the endpoint returns HTML from an SPA fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      })),
    );
    render(
      <MemoryRouter initialEntries={[`/launch${ONSHAPE_LINK}`]}>
        <ConfigProvider>
          <Routes>
            <Route path="/launch" element={<LaunchPage />} />
            <Route path="/review/:reviewId/setup" element={<SetupProbe />} />
          </Routes>
        </ConfigProvider>
      </MemoryRouter>,
    );

    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
  });

  it('refuses a deployment whose PLM provider is "none"', async () => {
    renderLaunch(ONSHAPE_LINK, {
      ok: true,
      body: configWith({ provider: 'none' }),
    });

    await screen.findByText(/not connected to a PLM/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
  });

  it('waits for the config instead of resolving against the loading fallback', async () => {
    // Never settles: the page must sit on its working state, not decide.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(
      <MemoryRouter initialEntries={['/launch?plmSource=teamcenter&plmDoc=tc-doc-1']}>
        <ConfigProvider>
          <Routes>
            <Route path="/launch" element={<LaunchPage />} />
            <Route path="/review/:reviewId/setup" element={<SetupProbe />} />
          </Routes>
        </ConfigProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/opening your design review/i)).toBeInTheDocument();
    // Give a wrong answer time to appear if the page guessed: the fallback
    // provider is teamcenter, which matches this link, so a guess would navigate.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
  });

  it('rejects a malformed link without rendering the query string', async () => {
    renderLaunch('?plmSource=onshape&plmDoc=../../etc/passwd', {
      ok: true,
      body: ONSHAPE_CONFIG,
    });

    await screen.findByText(/document id in this launch link is not valid/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('../../etc/passwd');
    expect(body).not.toContain('plmSource');
    expect(body).not.toContain('plmDoc');
  });

  it('rejects an unknown PLM source', async () => {
    renderLaunch('?plmSource=solidworks&plmDoc=whatever', {
      ok: true,
      body: ONSHAPE_CONFIG,
    });

    await screen.findByText(/does not support/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('solidworks');
  });

  it('sends the user to the lobby from the error state', async () => {
    renderLaunch('?plmSource=onshape', { ok: true, body: ONSHAPE_CONFIG });

    fireEvent.click(await screen.findByRole('button', { name: /go to lobby/i }));
    expect(await screen.findByTestId('lobby')).toBeInTheDocument();
  });

  // ─── Credentials ──────────────────────────────────────────────────────────

  it('strips a token out of the address bar and never resolves with it', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderLaunch(`${ONSHAPE_LINK}&token=super-secret-token`, {
      ok: true,
      body: ONSHAPE_CONFIG,
    });

    await screen.findByTestId('review-id');
    expect(replaceState).toHaveBeenCalled();
    const rewritten = String(replaceState.mock.calls[0][2]);
    expect(rewritten).not.toContain('token');
    expect(rewritten).not.toContain('super-secret-token');
    expect(rewritten).toContain(`plmDoc=${OS_DOC}`);

    // The launch still worked, and the secret appears nowhere in the state or
    // the DOM.
    expect(screen.getByTestId('launch-doc').textContent).toBe(OS_DOC);
    expect(document.body.textContent).not.toContain('super-secret-token');
  });

  it('leaves the address bar alone when there is no credential to strip', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderLaunch(ONSHAPE_LINK, { ok: true, body: ONSHAPE_CONFIG });

    await screen.findByTestId('review-id');
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('refuses a link whose only content is a credential', async () => {
    renderLaunch('?token=super-secret-token', { ok: true, body: ONSHAPE_CONFIG });

    await screen.findByText(/does not say which PLM system/i);
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('super-secret-token');
  });

  // ─── Identity ─────────────────────────────────────────────────────────────

  it('asks for a name and keeps the launch parameters instead of bouncing to the lobby', async () => {
    localStorage.clear();
    renderLaunch(ONSHAPE_LINK, { ok: true, body: ONSHAPE_CONFIG });

    const input = (await screen.findByLabelText(/your name/i)) as HTMLInputElement;
    expect(screen.queryByTestId('review-id')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lobby')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Sam Rivera' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    await screen.findByTestId('review-id');
    expect(screen.getByTestId('launch-source').textContent).toBe('onshape');
    expect(screen.getByTestId('launch-doc').textContent).toBe(OS_DOC);
    expect(screen.getByTestId('launch-workspace').textContent).toBe(OS_WS);
    expect(JSON.parse(localStorage.getItem('vp_user') ?? '{}').name).toBe('Sam Rivera');
  });

  it('does not ask for a name when the link itself is invalid', async () => {
    localStorage.clear();
    renderLaunch('?plmSource=onshape&plmDoc=nope', { ok: true, body: ONSHAPE_CONFIG });

    await screen.findByText(/document id in this launch link is not valid/i);
    expect(screen.queryByLabelText(/your name/i)).not.toBeInTheDocument();
  });

  it('leaves the launch page once it has navigated, and does not mint a second review', async () => {
    renderLaunch(ONSHAPE_LINK, { ok: true, body: ONSHAPE_CONFIG });

    await screen.findByTestId('review-id');
    expect(screen.queryByText(/opening your design review/i)).not.toBeInTheDocument();
    const reviewId = screen.getByTestId('review-id').textContent;
    // Let any stray effect or re-render run: the review id must not change, or a
    // user would land in a different room than the one they were sent to.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('review-id').textContent).toBe(reviewId);
  });
});
