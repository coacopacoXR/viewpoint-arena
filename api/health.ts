// GET  /api/health — per-connector health for the whole deployment
// HEAD /api/health — status only, for a load balancer or a container probe
//
// One URL for an IT dashboard and for install.sh's "prove the config actually
// resolves" step (docs/plan/06-deployment-and-installation.md §2 step 8,
// docs/plan/05-observability-and-metrics.md §1).
//
// UNAUTHENTICATED by design — a dashboard that had to log in first would not be
// polled, and an installer cannot authenticate against a stack it is still
// bringing up. That is why the response carries per-connector STATUS ONLY:
//
//   * no credential, and no env var NAME — a name tells an attacker which
//     variable to look for and is deployment internals besides;
//   * no upstream error body — an LLM or PLM error can quote the request, and
//     for capture that request contains a meeting transcript;
//   * no internal hostname or URL — capture.serviceUrl is a container name on a
//     network that deliberately has no published port.
//
// lib/health/sanitize.ts enforces all three at the single exit point, so an
// adapter that gets it wrong loses its `detail` rather than leaking it.
//
// A failing connector makes the report `ok: false` and the status 503. It does
// NOT make the endpoint fail: the body always carries every enabled connector,
// because "which one is down" is the entire value of the response.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig, resolveConfigSource } from '../lib/config/loadConfig.ts';
import { aggregateHealth } from '../lib/health/aggregate.ts';

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // A cached health response is a lie about the present. no-store, not
  // no-cache: an intermediate proxy must not keep a copy to serve the next
  // poller while the deployment is actually down.
  res.setHeader('Cache-Control', 'no-store');

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    // The message names the missing env var and connector, which is exactly
    // what an operator needs and exactly what this endpoint must not publish —
    // so it goes to the log and the caller gets a fixed code. Same split as
    // api/public-config.ts.
    console.error('[health] config did not load:', err);
    res.status(503).json({
      ok: false,
      connectors: {},
      error: 'config_not_available',
    });
    return;
  }

  // aggregateHealth never throws: every check is isolated and bounded, so this
  // resolves to a complete report whatever state the deployment is in.
  const report = await aggregateHealth(config);

  // 503 when anything is degraded. Standard for a probe, and it is what lets
  // install.sh tell "ready" from "up but not ready" without parsing the body —
  // though it parses the body anyway, to say WHICH connector is not ready.
  res.status(report.ok ? 200 : 503).json({
    ...report,
    configSource: resolveConfigSource(),
  });
}

export default handler;
