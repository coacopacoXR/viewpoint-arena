#!/usr/bin/env node
// scripts/check-public-env.mjs
//
// Guards against Vite's VITE_* inlining footgun: any env var prefixed with
// VITE_ is inlined into the shipped client JS at build time. A secret-shaped
// name (e.g. VITE_TC_PASSWORD) publishes that secret to every visitor.
// See docs/plan/03-security-and-secrets.md §2-§4.
//
// It scans COMMITTED SOURCE, not just env files. Env files are git-ignored and
// therefore absent in CI, so an env-file-only scan passes vacuously in exactly
// the place it is supposed to protect. Source is always present, and source is
// what an auditor reads.
//
// Pre-existing violations are baselined in KNOWN below: reported loudly, but
// not build-breaking, because fixing them is Phase 3 (server-side adapters).
// Anything NEW fails the build. The baseline only shrinks — if a KNOWN entry
// disappears, the script fails until it is removed from the list, so the
// baseline cannot silently go stale.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// VITE_-prefixed but legitimately public.
// The Supabase anon key is designed to be embedded in client code; access
// control lives in Postgres Row Level Security, not in key secrecy.
const ALLOWLIST = new Set(['VITE_SUPABASE_ANON_KEY']);

// Pre-existing violations, tracked as debt. Each must cite where it lives and
// what fixes it. Do not add to this list to silence a new finding.
// T3.3 and T3.4 resolved the two original entries (VITE_TEAMS_WEBHOOK_URL and
// VITE_TURN_CREDENTIAL). The map is now empty — any new finding fails the build.
const KNOWN = new Map([
]);

const SECRET_PATTERNS = [
  'PASSWORD', 'PASSWD', 'PWD', 'SECRET', 'TOKEN',
  'CREDENTIAL', 'CREDENTIALS', 'PRIVATE', 'API_KEY', 'APIKEY', 'AUTH',
  // A webhook URL is a bearer credential: whoever holds it can post to the
  // channel. Found by grepping the actual built bundle, where
  // VITE_TEAMS_WEBHOOK_URL was shipping to every visitor unflagged.
  'WEBHOOK',
];

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
// Test files are excluded: they legitimately contain secret-shaped names as
// negative-test fixtures ("assert this is rejected"), and nothing under a test
// path is ever bundled into the client app, which is the only thing this guard
// protects. Application source is never excluded.
function isTestFile(path) {
  const p = path.split(sep).join('/');
  return (
    p.includes('/__tests__/') ||
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.startsWith('e2e/') ||
    p.includes('/e2e/')
  );
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.vercel', '.partykit', 'test-results', 'playwright-report', '.qwen-tasks',
]);
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.example'];

const VITE_NAME_RE = /VITE_[A-Z0-9_]+/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

function isSecretShaped(name) {
  const upper = name.toUpperCase();
  if (!upper.startsWith('VITE_')) return false;
  if (ALLOWLIST.has(upper)) return false;
  return SECRET_PATTERNS.some((pat) => upper.includes(pat));
}

function main() {
  const root = resolve(process.argv[2] ?? '.');
  const found = new Map(); // name -> Set(file:line)

  // Exclude this script: it necessarily contains the very patterns it hunts for.
  const selfPath = fileURLToPath(import.meta.url);
  const sourceFiles = walk(root)
    .filter((f) => resolve(f) !== resolve(selfPath))
    .filter((f) => !isTestFile(relative(root, f)));
  for (const file of sourceFiles) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const m of line.match(VITE_NAME_RE) ?? []) {
        if (!isSecretShaped(m)) continue;
        if (!found.has(m)) found.set(m, new Set());
        found.get(m).add(`${relative(root, file).split(sep).join('/')}:${i + 1}`);
      }
    });
  }

  for (const rel of ENV_FILES) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    readFileSync(abs, 'utf8').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      if (isSecretShaped(key)) {
        if (!found.has(key)) found.set(key, new Set());
        found.get(key).add(`${rel}:${i + 1}`);
      }
    });
  }

  // Never pass vacuously.
  if (sourceFiles.length === 0) {
    console.error('check-public-env: FAIL - scanned 0 source files. Wrong working directory?');
    process.exit(1);
  }

  const isNew = [...found.keys()].filter((n) => !KNOWN.has(n));
  const stale = [...KNOWN.keys()].filter((n) => !found.has(n));

  for (const name of found.keys()) {
    if (!KNOWN.has(name)) continue;
    console.log(`check-public-env: KNOWN debt - ${name} (${KNOWN.get(name)})`);
    for (const loc of found.get(name)) console.log(`    at ${loc}`);
  }

  if (isNew.length > 0) {
    console.error('');
    console.error('ERROR: new secret-shaped VITE_* names detected.');
    console.error('');
    console.error('Vite inlines every VITE_-prefixed variable into the shipped client');
    console.error('bundle, so this value would be published to every visitor of the app.');
    console.error('');
    for (const name of isNew) {
      console.error(`  - ${name}`);
      for (const loc of found.get(name)) console.error(`      at ${loc}`);
    }
    console.error('');
    console.error('Fix: drop the VITE_ prefix and read it only in server-side code');
    console.error('(api/* or capture-service). If the name is genuinely public, like an');
    console.error('RLS-protected Supabase anon key, add it to ALLOWLIST in this script');
    console.error('with a comment saying why it is safe.');
    console.error('');
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error('');
    console.error('ERROR: baseline is stale. These are listed in KNOWN but no longer');
    console.error('appear in the codebase — remove them so the baseline keeps shrinking:');
    for (const name of stale) console.error(`  - ${name}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `check-public-env: OK - scanned ${sourceFiles.length} source file(s), ` +
    `${found.size} known issue(s), 0 new.`,
  );
}

main();
