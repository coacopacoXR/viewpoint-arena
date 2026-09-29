// Validation for the OAuth `return` / `returnTo` parameter shared by
// api/onshape/auth-start.ts and api/onshape/callback.ts.
//
// WHY THIS EXISTS. An OAuth callback redirects the browser to a URL it was
// handed before the round-trip, which makes it an open-redirect primitive. The
// check it replaces was `returnTo.startsWith('/')`, and that accepts
//
//   //evil.com      browsers resolve a leading `//` as a protocol-relative URL
//   /\evil.com      and treat `\` as `/` in a special-scheme URL, so this is
//                   the same thing to Chrome, Firefox and Safari
//
// both of which send the user — and their fresh OAuth session — to another
// host. The PLM launch deep link (T5.3) widens the exposure, because the
// return path now routinely carries a /launch?... URL that an attacker can
// craft and hand to a victim inside their own PLM.
//
// So only a same-origin PATH is ever acceptable. Everything else becomes '/'.
// The value is validated on the way IN (auth-start, before it is stored in the
// state cookie) and again on the way OUT (callback, before the redirect), so a
// cookie forged or written by an older version of this code cannot redirect
// off-site either.

/** C0 controls plus DEL. A CR or LF here is a header-injection attempt. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** The base is arbitrary; only "did the origin survive?" is asked of it. */
const SAME_ORIGIN_BASE = 'http://x';

export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '/';
  // Must be a path, not an absolute URL, not a scheme (`javascript:`), not
  // protocol-relative.
  if (!value.startsWith('/')) return '/';
  // `//host` and `/\host` are the two spellings of "another host" that still
  // start with a slash. Rejected explicitly rather than left to the URL parse
  // below, because a future edit to that parse must not silently reopen them.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (value.includes('\\')) return '/';
  if (CONTROL_CHARS_RE.test(value)) return '/';
  // Percent-encoded CR/LF (`/%0d%0aSet-Cookie: …`) survives the checks above but
  // is decoded by proxies and by res.redirect() consumers, so decode first and
  // re-test. A malformed escape sequence throws; the raw value is then what
  // ships, and it has already passed the same test.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // leave `decoded` as the raw value
  }
  if (CONTROL_CHARS_RE.test(decoded)) return '/';
  // Final belt: whatever this is, it must parse to the same origin as the base.
  let url: URL;
  try {
    url = new URL(value, SAME_ORIGIN_BASE);
  } catch {
    return '/';
  }
  if (url.origin !== SAME_ORIGIN_BASE) return '/';
  return value;
}
