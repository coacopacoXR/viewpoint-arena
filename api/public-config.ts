import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../lib/config/loadConfig.ts';
import { redactConfig } from '../lib/config/redact.ts';

export async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const config = await loadConfig();
    const publicConfig = redactConfig(config);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json(publicConfig);
  } catch (err) {
    // Deliberately does NOT return the error message. loadConfig fails with
    // text that names the missing variable and connector ("plm.clientSecretEnv
    // 'ONSHAPE_CLIENT_SECRET' is not set") — useful in server logs, but this
    // is an unauthenticated public endpoint whose entire purpose is to emit no
    // *Env names. Returning err.message would leak the deployment's internal
    // env var names to any caller whenever the deploy is misconfigured.
    console.error('[public-config] failed to load config:', err);
    res.status(500).json({ error: 'config_not_available' });
  }
}

export default handler;
