// @vitest-environment node
//
// The partykit container once passed `--host` and `--no-open`, neither of
// which `partykit dev` accepts, so the CLI exited with "unknown option" and the
// container could never start. Nothing noticed: no test runs the image and
// Docker is not available everywhere this suite runs. This pins every flag the
// container starts with to the installed CLI's own --help.
//
// The flags moved out of the Dockerfile's CMD and into
// deploy/partykit-entrypoint.sh when the room server needed `--var` values
// that only exist at run time. The point of the test is the flags, wherever
// they are written, so it reads them from there now.

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

function dockerfile(): string {
  return readFileSync(join(repoRoot, 'deploy/partykit.Dockerfile'), 'utf8');
}

function cmdArgs(): string[] {
  const line = dockerfile().split(/\r?\n/).find((l) => l.startsWith('CMD '));
  if (!line) throw new Error('deploy/partykit.Dockerfile has no CMD line');
  return JSON.parse(line.slice(4)) as string[];
}

/** The entrypoint the CMD runs, which is where the flags live. */
function entrypoint(): string {
  return readFileSync(join(repoRoot, 'deploy/partykit-entrypoint.sh'), 'utf8');
}

/** Every flag the entrypoint can hand to `partykit dev`. */
function entrypointFlags(): string[] {
  const flags = new Set<string>();
  for (const match of entrypoint().matchAll(/(--[a-z][a-z-]*)/g)) {
    if (match[1] === '--no-install') continue; // npx's own flag, not partykit's
    flags.add(match[1]);
  }
  return [...flags];
}

function devHelp(): string {
  const bin = join(repoRoot, 'node_modules/partykit/dist/bin.mjs');
  return execFileSync(process.execPath, [bin, 'dev', '--help'], { encoding: 'utf8' });
}

describe('deploy/partykit.Dockerfile', () => {
  it('starts the container through the entrypoint script', () => {
    expect(cmdArgs()).toEqual(['/app/deploy/partykit-entrypoint.sh']);
  });

  it('makes the entrypoint executable in the image', () => {
    // COPY does not carry an executable bit from a Windows checkout.
    expect(dockerfile()).toMatch(/chmod \+x .*partykit-entrypoint\.sh/);
  });
});

describe('deploy/partykit-entrypoint.sh', () => {
  it('runs `partykit dev`', () => {
    expect(entrypoint()).toMatch(/exec npx --no-install partykit dev/);
  });

  it('uses only flags the installed partykit dev accepts', () => {
    const help = devHelp();
    const flags = entrypointFlags();
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      expect(help, `partykit dev does not accept ${flag}`).toMatch(
        new RegExp(`(^|[\\s,])${flag}(?=[\\s,<]|$)`, 'm'),
      );
    }
  }, 30_000);

  it('passes the room server its variables, since workerd has no container env', () => {
    // Without --var, `process.env.ANON_KEY` inside party/room.server.ts is
    // empty no matter how the container is configured, and the audit log
    // records nothing while looking correctly wired from the outside.
    const script = entrypoint();
    expect(script).toMatch(/--var ANON_KEY=/);
    expect(script).toMatch(/--var REST_URL=/);
    // Identity (batch AZ): the mode, and the secret the room server verifies a
    // signed-in person's access token with. Missing either is silent in exactly
    // the same way — a room that works, with names nobody proved.
    expect(script).toMatch(/--var IDENTITY_MODE=/);
    expect(script).toMatch(/--var JWT_SECRET=/);
  });

  it('omits a variable that is not set rather than passing an empty one', () => {
    const script = entrypoint();
    expect(script).toMatch(/if \[ -n "\$ANON_KEY" \]/);
    expect(script).toMatch(/if \[ -n "\$REST_URL" \]/);
    // An empty IDENTITY_MODE would look like a mode to the room server, and an
    // empty JWT_SECRET would verify nothing while looking configured.
    expect(script).toMatch(/if \[ -n "\$IDENTITY_MODE" \]/);
    expect(script).toMatch(/if \[ -n "\$JWT_SECRET" \]/);
  });
});
