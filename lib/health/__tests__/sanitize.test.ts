// The leak boundary for GET /api/health.
//
// /api/health is unauthenticated, so every string it emits is public. These
// tests are the reason lib/health/sanitize.ts is an allowlist rather than a
// denylist: each case below is a shape a denylist would have to anticipate, and
// the shape rule rejects all of them for one reason — it is not a short
// lowercase phrase.

import { describe, it, expect } from 'vitest';
import { safeDetail, safeProvider, MAX_DETAIL_LENGTH } from '../sanitize.ts';
import { HEALTH_DETAILS } from '../details.ts';

// Planted values. Everything here is fictional, and deliberately shaped like
// the real thing: a bearer token, a connection string, a webhook URL.
const SECRETS = {
  ONSHAPE_CLIENT_SECRET: 'Jx7Qm2Vp9Ld4Rt6Yw1Zk8Nb3Hg5Fc0Sa', // gitleaks:allow (fake test value)
  TEAMS_WEBHOOK_URL:
    'https://acme.webhook.office.com/webhookb2/1a2b3c4d/IncomingWebhook/5e6f7a8b',
  DATABASE_URL: 'postgres://viewpoint:hunter2@db.internal.acme:5432/viewpoint',
  CAPTURE_SHARED_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', // gitleaks:allow (fake test value)
};

describe('safeDetail — the shape rule', () => {
  it('passes the fixed vocabulary every adapter uses', () => {
    for (const phrase of Object.values(HEALTH_DETAILS)) {
      expect(safeDetail(phrase, {}), `dropped its own vocabulary: ${phrase}`).toBe(
        phrase,
      );
    }
  });

  it('drops an env var NAME', () => {
    expect(safeDetail('ONSHAPE_CLIENT_SECRET is not set', SECRETS)).toBeUndefined();
    expect(safeDetail('missing CF_TURN_API_TOKEN', SECRETS)).toBeUndefined();
    expect(safeDetail('VITE_SUPABASE_ANON_KEY', SECRETS)).toBeUndefined();
  });

  it('drops a resolved env VALUE even when it is all lowercase', () => {
    // The shape rule alone would pass this: no uppercase, no punctuation. The
    // value check is what catches it, which is why `env` is a parameter.
    expect(
      safeDetail('the webhook is acme.webhook.office.com', SECRETS),
    ).toBeUndefined();
    expect(safeDetail(SECRETS.CAPTURE_SHARED_SECRET, SECRETS)).toBeUndefined();
    expect(safeDetail(`bearer ${SECRETS.ONSHAPE_CLIENT_SECRET}`, SECRETS)).toBeUndefined();
  });

  it('drops a URL, a hostname and a host:port', () => {
    expect(safeDetail('https://cad.onshape.com refused', SECRETS)).toBeUndefined();
    expect(safeDetail('capture-service:8080 unreachable', SECRETS)).toBeUndefined();
    expect(safeDetail('db.internal.acme', SECRETS)).toBeUndefined();
    expect(safeDetail('GET /api/v9/documents failed', SECRETS)).toBeUndefined();
  });

  it('drops an upstream error body', () => {
    expect(
      safeDetail('OpenAI said: {"error":{"message":"Incorrect API key"}}', SECRETS),
    ).toBeUndefined();
    expect(
      safeDetail('ECONNREFUSED 127.0.0.1:11434 while fetching /api/chat', SECRETS),
    ).toBeUndefined();
    expect(safeDetail('Error: spawn ENOENT', SECRETS)).toBeUndefined();
  });

  it('drops quoted model output, and documents what prose alone cannot be', () => {
    expect(
      safeDetail('parse failed near "{"cards": [{"title": "Weld"', SECRETS),
    ).toBeUndefined();
    expect(safeDetail('model said: RISK — the weld will crack', SECRETS)).toBeUndefined();

    // The honest limit of a shape rule, pinned so nobody over-trusts it: plain
    // lowercase English is indistinguishable from a plain lowercase detail, so a
    // transcript fragment with no punctuation WOULD pass. That is why adapters
    // take their wording from HEALTH_DETAILS instead of composing sentences, and
    // why capture-service never returns model output at all (errors.py). The
    // sanitiser is the last line, not the only one.
    expect(safeDetail('the weld will crack before yield', SECRETS)).toBe(
      'the weld will crack before yield',
    );
  });

  it('drops non-strings, empties and anything over the cap', () => {
    expect(safeDetail(undefined, SECRETS)).toBeUndefined();
    expect(safeDetail(null, SECRETS)).toBeUndefined();
    expect(safeDetail(42, SECRETS)).toBeUndefined();
    expect(safeDetail({ ok: true }, SECRETS)).toBeUndefined();
    expect(safeDetail('', SECRETS)).toBeUndefined();
    expect(safeDetail('   ', SECRETS)).toBeUndefined();
    expect(safeDetail('a'.repeat(MAX_DETAIL_LENGTH + 1), SECRETS)).toBeUndefined();
    expect(safeDetail('a'.repeat(MAX_DETAIL_LENGTH), SECRETS)).toBe(
      'a'.repeat(MAX_DETAIL_LENGTH),
    );
  });

  it('flattens newlines so a detail cannot forge a log line', () => {
    expect(safeDetail('upstream\nreachable', SECRETS)).toBe('upstream reachable');
    expect(safeDetail('upstream\r\n  reachable\t!', SECRETS)).toBeUndefined();
  });

  it('does not drop short ordinary env values', () => {
    // PORT, CI and friends are not secrets; matching on them would discard
    // legitimate details for no gain. The threshold is what keeps the value
    // check from being a source of false negatives.
    expect(safeDetail('upstream reachable', { PORT: '8080', CI: 'true' })).toBe(
      'upstream reachable',
    );
  });
});

describe('safeProvider', () => {
  it('passes the schema literals', () => {
    for (const provider of [
      'onshape',
      'teamcenter',
      'none',
      'mock',
      'local',
      'openai',
      'anthropic',
      'ollamaDirect',
      'cloudflare',
      'selfHostedCoturn',
      'supabase',
      'genericGltf',
      'teams',
    ]) {
      expect(safeProvider(provider)).toBe(provider);
    }
  });

  it('replaces anything else, so a config value is never echoed raw', () => {
    expect(safeProvider('https://evil.example')).toBe('unknown');
    expect(safeProvider('ONSHAPE_CLIENT_SECRET')).toBe('unknown');
    expect(safeProvider(undefined)).toBe('unknown');
    expect(safeProvider(7)).toBe('unknown');
  });
});
