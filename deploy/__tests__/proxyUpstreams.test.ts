// Every upstream in both nginx configs must be resolved per request.
//
// A literal `proxy_pass http://<service>:<port>` makes nginx resolve the name
// once, when nginx starts, and keep that IP. Found on the first live Docker
// run: re-running install.sh recreated `app` (new IP) but not nginx-proxy, and
// the whole site answered 502 until nginx-proxy was restarted by hand.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

function code(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

describe.each(['deploy/nginx/proxy.conf', 'deploy/nginx/app.conf'])('%s', (file) => {
  const conf = code(file);

  it('has no proxy_pass to a literal host (every upstream is a variable)', () => {
    const literal = conf.match(/proxy_pass\s+https?:\/\/[^\s;]+;/g) ?? [];
    expect(literal).toEqual([]);
  });

  it('declares a Docker DNS resolver wherever it proxies', () => {
    const passes = (conf.match(/proxy_pass\s/g) ?? []).length;
    const resolvers = (conf.match(/resolver\s+127\.0\.0\.11/g) ?? []).length;
    expect(passes).toBeGreaterThan(0);
    expect(resolvers).toBeGreaterThanOrEqual(1);
  });
});
