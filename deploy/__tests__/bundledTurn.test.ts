// deploy/__tests__/bundledTurn.test.ts
//
// The bundled coturn service and the install.sh changes that wire it up.
// These tests parse docker-compose.yml and install.sh as text to pin the
// invariants that matter: the coturn service has the right profile, publishes
// the right ports, uses --use-auth-secret; --defaults writes a turn block with
// probeHost 'coturn' and never provider 'cloudflare'; poll_health uses
// --resolve; exit code 4 is the "stack did not answer" path.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { load as loadYaml } from 'js-yaml';

const REPO_ROOT = join(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

const COMPOSE_TEXT = read('docker-compose.yml');
const COMPOSE = loadYaml(COMPOSE_TEXT) as {
  services: Record<string, Record<string, unknown>>;
};
const INSTALL_SH = read('install.sh');

// ─── docker-compose.yml — coturn service ──────────────────────────────────

describe('docker-compose.yml — bundled coturn service', () => {
  it('has a coturn service', () => {
    expect(COMPOSE.services.coturn).toBeDefined();
  });

  it('coturn has the "turn" profile', () => {
    const profiles = COMPOSE.services.coturn.profiles as string[];
    expect(profiles).toContain('turn');
  });

  it('coturn publishes 3478 on both udp and tcp', () => {
    const ports = COMPOSE.services.coturn.ports as string[];
    expect(ports).toContain('3478:3478/udp');
    expect(ports).toContain('3478:3478/tcp');
  });

  it('coturn publishes the relay port range as udp', () => {
    const ports = COMPOSE.services.coturn.ports as string[];
    const relayRange = ports.find((p: string) => p.includes('49160') && p.includes('49200'));
    expect(relayRange).toBeDefined();
    expect(relayRange).toMatch(/\/udp$/);
  });

  it('coturn uses --use-auth-secret in its command', () => {
    // The command is a YAML block scalar passed to sh -c.
    const command = COMPOSE.services.coturn.command as string[];
    const fullCommand = command.join(' ');
    expect(fullCommand).toContain('--use-auth-secret');
    // The secret goes into the generated config file, never on the command
    // line, where any process listing in the container would show it.
    expect(fullCommand).toContain('echo "static-auth-secret=');
    expect(fullCommand).not.toContain('--static-auth-secret');
  });

  it('coturn denies each private/loopback peer range on its own line', () => {
    // coturn rejects a comma-separated denied-peer-ip ("Wrong address
    // format") and then drops the whole deny list. Found on the live run.
    const fullCommand = (COMPOSE.services.coturn.command as string[]).join(' ');
    expect(fullCommand).not.toMatch(/denied-peer-ip=[^\s"]*,/);
    expect(fullCommand).toContain('echo "denied-peer-ip=$$r"');
    for (const range of ['127.0.0.0-127.255.255.255', '10.0.0.0-10.255.255.255', '192.168.0.0-192.168.255.255']) {
      expect(fullCommand).toContain(range);
    }
  });

  it('coturn is on both edge and backend networks', () => {
    const networks = COMPOSE.services.coturn.networks as string[];
    expect(networks).toContain('edge');
    expect(networks).toContain('backend');
  });

  it('coturn has a memory limit', () => {
    const deploy = COMPOSE.services.coturn.deploy as Record<string, unknown>;
    const resources = deploy.resources as Record<string, unknown>;
    const limits = resources.limits as Record<string, string>;
    expect(limits.memory).toBeDefined();
  });

  it('coturn image tag is overridable via COTURN_IMAGE_TAG', () => {
    const image = COMPOSE.services.coturn.image as string;
    expect(image).toMatch(/coturn\/coturn:\$\{COTURN_IMAGE_TAG:-/);
  });
});

// ─── docker-compose.yml — api env_file optional ───────────────────────────

describe('docker-compose.yml — api env_file is optional', () => {
  it('api env_file uses the long form with required: false', () => {
    // `docker compose config` must work on a fresh clone before install.sh
    // has written .env. The short form `env_file: - .env` is mandatory by
    // default and fails if the file is missing.
    const envFile = COMPOSE.services.api.env_file as Array<
      string | { path: string; required?: boolean }
    >;
    expect(envFile).toBeDefined();
    expect(envFile.length).toBeGreaterThan(0);
    const entry = envFile[0];
    expect(typeof entry).toBe('object');
    expect((entry as { path: string }).path).toBe('.env');
    expect((entry as { required: boolean }).required).toBe(false);
  });
});

// ─── docker-compose.yml — ollama no longer publishes ports ────────────────

describe('docker-compose.yml — ollama publishes no ports', () => {
  it('ollama has no ports entry (clashes with native Ollama on 11434)', () => {
    expect(COMPOSE.services.ollama.ports).toBeUndefined();
  });
});

// ─── install.sh — --defaults writes bundled TURN with probeHost ───────────

describe('install.sh — --defaults TURN output', () => {
  // install.sh refuses to run on native Windows by design.
  const RUNS_INSTALLER = process.platform !== 'win32';

  it.skipIf(!RUNS_INSTALLER)(
    '--defaults writes a turn block with provider selfHostedCoturn and probeHost coturn',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'vp-turn-'));
      try {
        execFileSync(
          'bash',
          [join(REPO_ROOT, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
          { stdio: 'pipe' },
        );
        const config = readFileSync(join(dir, 'viewpoint.config.ts'), 'utf8');
        expect(config).toContain("provider: 'selfHostedCoturn'");
        expect(config).toContain("probeHost: 'coturn'");
        expect(config).not.toContain("provider: 'cloudflare'");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!RUNS_INSTALLER)(
    '--defaults writes COTURN_SHARED_SECRET and TURN_EXTERNAL_IP to .env',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'vp-turn-'));
      try {
        execFileSync(
          'bash',
          [join(REPO_ROOT, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
          { stdio: 'pipe' },
        );
        const env = readFileSync(join(dir, '.env'), 'utf8');
        expect(env).toMatch(/^COTURN_SHARED_SECRET=[a-f0-9]{64}$/m);
        expect(env).toMatch(/^TURN_EXTERNAL_IP=$/m);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!RUNS_INSTALLER)(
    '--defaults writes localhost as PUBLIC_HOSTNAME (not arena.local)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'vp-turn-'));
      try {
        execFileSync(
          'bash',
          [join(REPO_ROOT, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
          { stdio: 'pipe' },
        );
        const env = readFileSync(join(dir, '.env'), 'utf8');
        expect(env).toMatch(/^PUBLIC_HOSTNAME=localhost$/m);
        expect(env).not.toContain('arena.local');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

// ─── install.sh — poll_health uses --resolve ──────────────────────────────

describe('install.sh — poll_health', () => {
  it('uses --resolve to pin the hostname to 127.0.0.1', () => {
    expect(INSTALL_SH).toContain('--resolve');
    expect(INSTALL_SH).toContain('127.0.0.1');
  });

  it('returns exit code 4 when the stack never answers', () => {
    // The poll_health function must return 4 (not 0) when the budget expires.
    const pollFn = /poll_health\(\)\s*\{[\s\S]*?\n\}/.exec(INSTALL_SH);
    expect(pollFn).not.toBeNull();
    expect(pollFn![0]).toContain('return 4');
  });
});

// ─── install.sh — exit codes in usage() ───────────────────────────────────

describe('install.sh — exit codes', () => {
  it('documents exit codes 4 and 5 in usage()', () => {
    const usageFn = /usage\(\)\s*\{[\s\S]*?\n\}/.exec(INSTALL_SH);
    expect(usageFn).not.toBeNull();
    expect(usageFn![0]).toMatch(/4\s+the stack did not answer/);
    expect(usageFn![0]).toMatch(/5\s+a port/);
  });
});

// ─── install.sh — compose_up detects port clashes ─────────────────────────

describe('install.sh — compose_up port clash detection', () => {
  it('checks for "ports are not available" and "address already in use"', () => {
    const composeUpFn = /compose_up\(\)\s*\{[\s\S]*?\n\}/.exec(INSTALL_SH);
    expect(composeUpFn).not.toBeNull();
    expect(composeUpFn![0]).toContain('ports are not available');
    expect(composeUpFn![0]).toContain('address already in use');
    expect(composeUpFn![0]).toContain('exit 5');
  });
});
