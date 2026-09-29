// The browser bundle must not be able to reach the modules that hold a
// credential — proven from the import graph rather than from a built dist/.
//
// Grepping dist/ for a marker string is the other way to test this, and it is a
// weaker test: CI runs `npm test` before `npm run build`, so a dist-grep either
// skips or reads a stale artefact from the last local build. Walking the imports
// from the browser's own entry point works on a fresh clone with nothing built,
// and it names the exact chain that leaked rather than reporting a string found
// somewhere in a megabyte of minified output.
//
// What is forbidden, and why each one is:
//
//   lib/ai/secretBox.ts     derives an AES key from JWT_SECRET. In a bundle it is
//                           the ability to read every stored credential, given the
//                           ciphertext — and the ciphertext is in a database the
//                           browser already has an anon key for.
//   lib/ai/settingsStore.ts mints nothing itself but imports the service-role
//                           signer and exposes openSettingSecret, the one function
//                           that returns a key in the clear.
//   lib/ai/router.ts        holds every upstream endpoint and reads credentials
//                           from the environment.
//   api/**                  the handlers. Not bundleable at all — they import
//                           @vercel/node and node: builtins — but a stray import
//                           would fail the build in a way that reads as a Vite
//                           problem rather than as "you just put a handler in the
//                           client graph".
//
// lib/ai/providers.ts and lib/ai/webhookContract.ts are the two lib/ai modules a
// browser DOES import: the admin form renders from the descriptors, and the
// webhook shapes are documentation of a contract. Neither reads an environment
// variable, holds a credential or names a vendor endpoint, and
// lib/connectors/capture/capture.security.test.ts asserts that as text.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The browser's entry point. Everything reachable from here can be bundled. */
const ENTRY = 'index.tsx';

/** Modules that must never be reachable from the entry point. */
const FORBIDDEN = [
  'lib/ai/secretBox.ts',
  'lib/ai/settingsStore.ts',
  'lib/ai/router.ts',
  'api/_lib/serviceRole.ts',
];

/**
 * Any path under these roots is server-only by definition.
 *
 * `party/` is the room server: a separate workerd bundle with its own environment
 * (IDENTITY_MODE, JWT_SECRET), reached from the browser only through a WebSocket.
 * The browser takes its MESSAGE TYPES from there with `import type`, which the
 * bundler erases — so a value import from party/ would be a real leak, and this is
 * the assertion that catches one.
 */
const FORBIDDEN_ROOTS = ['api/', 'server/', 'party/', 'capture-service/'];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** A static import/export-from, or a dynamic import(). */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Bare package specifiers, which are not files in this repository. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Resolve a relative specifier to a repository path.
 *
 * This codebase writes its TypeScript imports with an explicit `.ts` extension
 * (allowImportingTsExtensions), so the common case is the specifier itself. The
 * extensionless and directory-index cases are handled because a handful of older
 * browser-side imports omit them.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (!SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
    candidates.push(join(base, `index.ts`), join(base, `index.tsx`));
  }
  for (const candidate of candidates) {
    // isFile(), not existsSync(): `from './components'` resolves to a DIRECTORY,
    // and a directory in the graph makes every later readFileSync throw EISDIR.
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function importsOf(file: string): string[] {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    // Type-only imports are erased by the bundler and never appear in dist/. They
    // have to be erased here too, or the graph grows edges Vite will not follow —
    // `import type server from '../../party/room.server'` is how the browser gets
    // the room server's message types, and party/ is a separate workerd bundle
    // that legitimately reads its own environment.
    .replace(/^\s*(?:import|export)\s+type\s[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
    // …and so is an inline `import('…').SomeType` in a type annotation, which is
    // the spelling components/Scene/ViewpointCanvas.tsx uses for the room server's
    // presence type. A real lazy load is `await import('…')` with nothing but a
    // closing paren before the next token, so requiring the `.` keeps the two
    // distinguishable.
    .replace(/\bimport\s*\(\s*['"][^'"]+['"]\s*\)\s*\./g, 'TYPE_ONLY_IMPORT.');

  const specifiers: string[] = [];
  for (const match of code.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (!isRelative(specifier)) continue;
    const resolved = resolveSpecifier(file, specifier);
    if (resolved !== null) specifiers.push(resolved);
  }
  return specifiers;
}

/** Every file reachable from the entry point, as repo-relative POSIX paths. */
function reachableFrom(entry: string): Set<string> {
  const start = resolve(REPO_ROOT, entry);
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of importsOf(file)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return new Set([...seen].map((file) => relative(REPO_ROOT, file).split(sep).join('/')));
}

describe('the browser bundle cannot reach a credential', () => {
  const reachable = reachableFrom(ENTRY);

  it('actually walked a graph, rather than failing to find the entry point', () => {
    // A guard against this test passing vacuously: if the entry point moved and
    // the walk found nothing, every assertion below would be trivially true.
    expect(reachable.has(ENTRY)).toBe(true);
    expect(reachable.size).toBeGreaterThan(50);
    expect([...reachable].some((file) => file.startsWith('components/'))).toBe(true);
    expect([...reachable].some((file) => file.startsWith('pages/'))).toBe(true);
  });

  it.each(FORBIDDEN)('does not reach %s', (file) => {
    expect(reachable.has(file)).toBe(false);
  });

  it.each(FORBIDDEN_ROOTS)('does not reach anything under %s', (root) => {
    const leaked = [...reachable].filter((file) => file.startsWith(root));
    expect(leaked).toEqual([]);
  });

  it('does reach the AI descriptor module, which is the one the admin form renders from', () => {
    // Positive control for the two assertions above: lib/ai/providers.ts IS in the
    // graph (pages/AdminPage.tsx imports the AI section, which imports it), so the
    // walk is reaching into lib/ai and the forbidden list is doing real work
    // rather than naming files nothing would ever import.
    expect(reachable.has('lib/ai/providers.ts')).toBe(true);
  });

  it('has no reachable module that reads a server-side environment variable', () => {
    // import.meta.env is the browser's own mechanism and is fine; process.env in a
    // bundled module is either a leak or a build failure waiting to happen.
    const offenders: string[] = [];
    for (const file of reachable) {
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/process\s*\.\s*env/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
