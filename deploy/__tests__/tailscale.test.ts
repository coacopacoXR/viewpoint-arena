// deploy/__tests__/tailscale.test.ts
//
// The Tailscale option (docs/plan/19-trusted-address.md): a `tailscale` sidecar
// that gives the install a real address and certificate on the operator's
// tailnet. Pinned here: the service stays behind its profile and publishes no
// port; serve.json forwards exactly the app (443) and the room socket (8443) to
// nginx-proxy; install.sh asks for it, checks the answers, and writes an .env
// whose addresses all agree on the tailnet name.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

const REPO_ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const COMPOSE = loadYaml(read('docker-compose.yml')) as {
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
};
const SERVE = JSON.parse(read('deploy/tailscale/serve.json')) as {
  TCP: Record<string, { HTTPS?: boolean }>;
  Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
};
const INSTALL_SH = read('install.sh');

describe('docker-compose.yml — tailscale service', () => {
  const svc = COMPOSE.services.tailscale;

  it('exists only behind the "tailscale" profile', () => {
    expect(svc).toBeDefined();
    expect(svc.profiles).toEqual(['tailscale']);
  });

  it('publishes no port: it is reached over the tailnet, not through the host', () => {
    expect(svc.ports).toBeUndefined();
  });

  it('keeps its machine identity in a named volume and mounts serve.json read-only', () => {
    const volumes = svc.volumes as string[];
    expect(volumes).toContain('tailscale-state:/var/lib/tailscale');
    expect(volumes).toContain('./deploy/tailscale/serve.json:/config/serve.json:ro');
    expect(COMPOSE.volumes).toHaveProperty('tailscale-state');
  });

  it('reads the auth key and name from .env and serves with serve.json', () => {
    const env = svc.environment as Record<string, string>;
    expect(env.TS_AUTHKEY).toBe('${TS_AUTHKEY:-}');
    expect(env.TS_HOSTNAME).toBe('${TS_HOSTNAME:-viewpoint}');
    expect(env.TS_SERVE_CONFIG).toBe('/config/serve.json');
    expect(env.TS_STATE_DIR).toBe('/var/lib/tailscale');
  });

  it('sits on the edge network next to nginx-proxy and nowhere else', () => {
    expect(svc.networks).toEqual(['edge']);
  });
});

describe('deploy/tailscale/serve.json', () => {
  it('serves HTTPS on 443 and 8443 only', () => {
    expect(Object.keys(SERVE.TCP).sort()).toEqual(['443', '8443']);
    expect(SERVE.TCP['443'].HTTPS).toBe(true);
    expect(SERVE.TCP['8443'].HTTPS).toBe(true);
  });

  it('forwards the app and the room socket to nginx-proxy on the same ports', () => {
    expect(SERVE.Web['${TS_CERT_DOMAIN}:443'].Handlers['/'].Proxy).toBe('https+insecure://nginx-proxy:443');
    expect(SERVE.Web['${TS_CERT_DOMAIN}:8443'].Handlers['/'].Proxy).toBe('https+insecure://nginx-proxy:8443');
  });
});

describe('install.sh — the tailscale choice', () => {
  it('offers tailscale as a way to reach the install', () => {
    expect(INSTALL_SH).toMatch(/'tailscale\|a real address and certificate through Tailscale/);
  });

  it('adds the tailscale profile in both places profiles are listed', () => {
    expect(INSTALL_SH).toContain(`[[ "$A_TLS" == 'tailscale' ]] && profiles+=(tailscale)`);
    expect(INSTALL_SH).toContain('PROFILES+=(tailscale)');
  });

  // install.sh refuses to run on native Windows by design.
  const RUNS_INSTALLER = process.platform !== 'win32';

  function runWith(answers: string): { env: string; config: string; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ts-'));
    try {
      const output = execFileSync(
        'bash',
        [join(REPO_ROOT, 'install.sh'), '--configure-only', '--dir', dir, '-y'],
        // Everything after the Tailscale answers is Enter, i.e. the defaults.
        { input: answers + '\n'.repeat(80), stdio: 'pipe', encoding: 'utf8' },
      );
      return {
        env: readFileSync(join(dir, '.env'), 'utf8'),
        config: readFileSync(join(dir, 'viewpoint.config.ts'), 'utf8'),
        output,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(!RUNS_INSTALLER)('writes one address everywhere, and the key and profile', () => {
    const { env, config } = runWith('2\nviewpoint\nhttps://tail1a2b3c.ts.net/\ntskey-auth-TEST\n');
    expect(env).toMatch(/^PUBLIC_HOSTNAME=viewpoint\.tail1a2b3c\.ts\.net$/m);
    expect(env).toMatch(/^PUBLIC_URL=https:\/\/viewpoint\.tail1a2b3c\.ts\.net$/m);
    expect(env).toMatch(/^VITE_PARTYKIT_HOST=viewpoint\.tail1a2b3c\.ts\.net:8443$/m);
    expect(env).toMatch(/^VITE_SUPABASE_URL=https:\/\/viewpoint\.tail1a2b3c\.ts\.net$/m);
    expect(env).toMatch(/^TS_HOSTNAME=viewpoint$/m);
    expect(env).toMatch(/^TS_AUTHKEY=tskey-auth-TEST$/m);
    expect(env).toMatch(/^COMPOSE_PROFILES=.*\btailscale\b/m);
    expect(config).toContain("publicUrl: 'https://viewpoint.tail1a2b3c.ts.net'");
  });

  it.skipIf(!RUNS_INSTALLER)('refuses a tailnet name that is not a ts.net name', () => {
    expect(() => runWith('2\nviewpoint\nmycompany.com\ntskey-auth-TEST\n')).toThrow();
  });

  it.skipIf(!RUNS_INSTALLER)('refuses to go on without an auth key', () => {
    expect(() => runWith('2\nviewpoint\ntail1a2b3c.ts.net\n\n')).toThrow();
  });

  it.skipIf(!RUNS_INSTALLER)('--defaults is unchanged: no tailscale profile, no key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vp-ts-'));
    try {
      execFileSync('bash', [join(REPO_ROOT, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'], {
        stdio: 'pipe',
      });
      const env = readFileSync(join(dir, '.env'), 'utf8');
      expect(env).not.toMatch(/^TS_AUTHKEY=/m);
      expect(env).not.toMatch(/^COMPOSE_PROFILES=.*\btailscale\b/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
