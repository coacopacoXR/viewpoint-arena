// Exchanges the server-side Cloudflare TURN API token for a short-lived ICE
// servers config that's safe to ship to the browser. Called once per boardroom
// session.
//
// Reads env var NAMES from the master config (viewpoint.config.ts) when
// available, falling back to the conventional defaults CF_TURN_TOKEN_ID /
// CF_TURN_API_TOKEN. The actual VALUES are resolved from process.env
// server-side and never reach the client bundle.
//
// Cloudflare's response already includes both STUN and TURN entries with
// ephemeral username/credential, formatted for RTCPeerConnection.iceServers,
// so the client just passes it through verbatim.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CloudflareTurnAdapter } from '../lib/connectors/turn/cloudflare.ts';
import { SelfHostedCoturnAdapter } from '../lib/connectors/turn/selfHostedCoturn.ts';

const DEFAULT_TOKEN_ID_ENV = 'CF_TURN_TOKEN_ID';
const DEFAULT_API_TOKEN_ENV = 'CF_TURN_API_TOKEN';

type TurnPlan =
  | { provider: 'cloudflare'; tokenIdEnv: string; apiTokenEnv: string }
  | { provider: 'selfHostedCoturn'; host: string; port: number; sharedSecretEnv: string };

// Which TURN provider the master config selected. Without a loadable config,
// the conventional Cloudflare env names, exactly as before.
async function resolveTurnPlan(): Promise<TurnPlan> {
  try {
    const { loadConfig } = await import('../lib/config/loadConfig.ts');
    const config = await loadConfig();
    if (config.turn.provider === 'cloudflare') {
      return {
        provider: 'cloudflare',
        tokenIdEnv: config.turn.tokenIdEnv,
        apiTokenEnv: config.turn.apiTokenEnv,
      };
    }
    return {
      provider: 'selfHostedCoturn',
      host: config.turn.host,
      port: config.turn.port,
      sharedSecretEnv: config.turn.sharedSecretEnv,
    };
  } catch {
    // Config not available — fall back to defaults.
  }
  return { provider: 'cloudflare', tokenIdEnv: DEFAULT_TOKEN_ID_ENV, apiTokenEnv: DEFAULT_API_TOKEN_ENV };
}

// Static override for a non-Cloudflare TURN provider (self-hosted coturn, or
// any vendor). Commit 1db12fa deliberately added this capability through
// VITE_TURN_* vars; T3.4 had to remove those because Vite inlined the
// credential into the client bundle. The capability itself is still wanted, so
// it lives here instead: same three values, server-side names, resolved per
// request and returned as ready-made iceServers. The credential is minted into
// the response body the browser needs, but is never baked into the bundle.
function staticOverride(): RTCIceServerLike[] | null {
  const urls = process.env.TURN_URL;
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (!urls || !username || !credential) return null;
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: urls.split(',').map((u) => u.trim()).filter(Boolean),
      username,
      credential,
    },
  ];
}

interface RTCIceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const override = staticOverride();
  if (override) {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).json({ iceServers: override });
    return;
  }

  const plan = await resolveTurnPlan();

  if (plan.provider === 'selfHostedCoturn') {
    if (!process.env[plan.sharedSecretEnv]) {
      res.status(500).json({ error: 'turn_not_configured' });
      return;
    }
    const iceServers = await new SelfHostedCoturnAdapter(plan).getIceServers();
    // Well under the credential's 24 h lifetime, same as the Cloudflare path.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).json({ iceServers });
    return;
  }

  const { tokenIdEnv, apiTokenEnv } = plan;

  if (!process.env[tokenIdEnv] || !process.env[apiTokenEnv]) {
    res.status(500).json({ error: 'turn_not_configured' });
    return;
  }

  try {
    const adapter = new CloudflareTurnAdapter({ tokenIdEnv, apiTokenEnv });
    const iceServers = await adapter.getIceServers();

    // Short browser cache so quick re-mounts of the boardroom don't hammer the
    // Cloudflare API — but well under the 24h TTL.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).json({ iceServers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never forward raw upstream bodies — they may contain credential echoes.
    if (message.includes('API returned')) {
      res.status(502).json({ error: 'cf_api_error' });
    } else {
      res.status(500).json({ error: 'fetch_failed' });
    }
  }
}
