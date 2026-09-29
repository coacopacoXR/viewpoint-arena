// The leak boundary for GET /api/health.
//
// /api/health is unauthenticated: an IT dashboard polls it, and so does
// install.sh, and neither can be made to log in first. That makes every string
// in its response public. The endpoint reports per-connector status only, and
// this module is what makes "only" true — it is the single place a `detail`
// passes through on the way out, so an adapter author cannot leak by accident
// and a third-party adapter cannot leak at all.
//
// The strategy is ALLOWLIST, not denylist. A denylist of known-bad substrings
// ('://', 'Bearer ', env var names…) silently passes whatever nobody thought
// of, and the thing nobody thought of is the one that ships. Instead a detail
// survives only if it looks like a short lowercase English phrase — which is
// the only shape any of the HEALTH_DETAILS constants have. Everything else is
// DROPPED: the connector's status is still reported, the wording is not.
//
// What the shape rule excludes by construction:
//   - env var NAMES        UPPER_SNAKE_CASE has uppercase and underscores
//   - URLs / hostnames     no ':', '/', '.', '?' or '=' may appear
//   - host:port            no ':' and no '.'
//   - upstream error bodies  quoted text, capitalised sentences, JSON, stacks
//   - credentials          near-universally contain uppercase, digits runs,
//                          '=', '+' or '/' (base64), or are pasted URLs
//
// On top of the shape rule there is a value check against the resolved
// environment, because a genuinely all-lowercase secret (a webhook path, a
// passphrase) would satisfy the shape rule. That is defence in depth, not the
// primary gate — and it is why `env` is injectable, so tests can prove it
// works instead of trusting it.

/** Longest detail that survives. Every constant in HEALTH_DETAILS is far shorter. */
export const MAX_DETAIL_LENGTH = 120;

/**
 * A short lowercase phrase: letters and digits in words, joined by single
 * spaces or hyphens, starting with a letter. Anchored at both ends so a
 * trailing URL or a leading env var name cannot ride along inside an
 * otherwise-fine string.
 */
const SAFE_DETAIL_RE = /^[a-z][a-z0-9]*(?:[ -][a-z0-9]+)*$/;

/** Provider names are camelCase literals from the config schema ('ollamaDirect'). */
const SAFE_PROVIDER_RE = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Short env values are skipped by the value check. `PORT=8080`, `HOME=/x` and
 * `CI=true` are not secrets, and matching on them would drop legitimate
 * details for no gain. Real credentials are far longer than this.
 */
const MIN_ENV_VALUE_LENGTH = 8;

/**
 * Return a detail that is safe to publish, or undefined if it must be dropped.
 *
 * Never throws. A detail that fails any check is discarded silently: the
 * connector's status is the information that matters, and an operator who
 * needs more reads the server log, which is where the adapter should have put
 * it in the first place.
 *
 * @param detail What the adapter returned. May be anything.
 * @param env    Resolved environment, for the value check. Defaults to
 *               process.env; injectable so tests do not depend on the
 *               machine they run on.
 */
export function safeDetail(
  detail: unknown,
  env: Record<string, string | undefined> = typeof process === 'undefined'
    ? {}
    : (process.env as Record<string, string | undefined>),
): string | undefined {
  if (typeof detail !== 'string') return undefined;

  // Flatten first: a newline in a detail could forge a line in a log that
  // concatenates them, and the shape rule below rejects '\n' anyway. Flattening
  // before checking means "word\nword" is treated as the phrase it looks like
  // rather than passing a control character through.
  const flat = detail.replace(/\s+/g, ' ').trim();
  if (flat.length === 0 || flat.length > MAX_DETAIL_LENGTH) return undefined;
  if (!SAFE_DETAIL_RE.test(flat)) return undefined;

  const lowered = flat.toLowerCase();
  for (const value of Object.values(env)) {
    if (typeof value !== 'string') continue;
    if (value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (lowered.includes(value.toLowerCase())) return undefined;
  }

  return flat;
}

/**
 * Return a provider name that is safe to publish, or 'unknown'.
 *
 * The config schema already constrains providers to a literal union, so this
 * only ever fires on a hand-edited config that somehow parsed — but the
 * provider string is echoed straight into a public response, and echoing
 * unvalidated input is how a config value becomes a leak.
 */
export function safeProvider(provider: unknown): string {
  return typeof provider === 'string' && SAFE_PROVIDER_RE.test(provider)
    ? provider
    : 'unknown';
}
