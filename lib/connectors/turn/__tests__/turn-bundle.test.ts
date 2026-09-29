// Tests that no TURN credential value appears in anything the client bundle
// can hold statically. VITE_TURN_CREDENTIAL was the old footgun: it shipped
// the TURN password in every visitor's JS. This test ensures it stays gone.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..');

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.vercel',
  '.partykit',
  'test-results',
  'playwright-report',
  '.qwen-tasks',
]);

function isTestFile(path: string): boolean {
  const p = path.split(sep).join('/');
  return (
    p.includes('/__tests__/') ||
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.startsWith('e2e/') ||
    p.includes('/e2e/')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXTS.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

describe('TURN credential bundle safety', () => {
  it('VITE_TURN_CREDENTIAL does not appear in any client-side source file', () => {
    // Exclude check-public-env.mjs: it necessarily contains the very patterns
    // it hunts for (same self-exclusion the script itself applies).
    const sourceFiles = walk(ROOT).filter(
      (f) =>
        !isTestFile(relative(ROOT, f)) &&
        !relative(ROOT, f).includes('check-public-env'),
    );

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (content.includes('VITE_TURN_CREDENTIAL')) {
        violations.push(relative(ROOT, file).split(sep).join('/'));
      }
    }

    expect(violations).toEqual([]);
  });

  it('no source file reads TURN credentials from import.meta.env', () => {
    const sourceFiles = walk(ROOT).filter(
      (f) =>
        !isTestFile(relative(ROOT, f)) &&
        !relative(ROOT, f).includes('check-public-env'),
    );

    const turnEnvPattern = /import\.meta[^;]*env[^;]*TURN/i;
    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, 'utf8');
      if (turnEnvPattern.test(content)) {
        violations.push(relative(ROOT, file).split(sep).join('/'));
      }
    }

    expect(violations).toEqual([]);
  });
});
