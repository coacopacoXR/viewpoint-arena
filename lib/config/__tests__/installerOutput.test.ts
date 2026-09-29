import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { configSchema, type ViewpointConfig } from '../schema.ts';

// install.sh refuses to run on native Windows by design.
const RUNS_INSTALLER = process.platform !== 'win32';

// The failure this guards against: install.sh writes a viewpoint.config.ts that
// lib/config/schema.ts then rejects, so the stack refuses to start and the
// operator has no idea why. The installer and the schema are edited by
// different people at different times, and nothing else couples them.
//
describe.skipIf(!RUNS_INSTALLER)('install.sh --defaults output', () => {
  it('writes a viewpoint.config.ts that passes the real zod schema', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vp-install-'));
    try {
      execFileSync(
        'bash',
        [
          join(repoRoot, 'install.sh'),
          '--defaults',
          '--configure-only',
          '--dir',
          dir,
          '-y',
        ],
        { stdio: 'pipe' },
      );

      const generated = readFileSync(join(dir, 'viewpoint.config.ts'), 'utf8');

      // The generated file imports defineConfig by a path relative to the
      // deployment directory, which does not resolve from a temp dir. Point it
      // at this repo so the object can actually be evaluated, and validate the
      // real thing rather than a re-typed copy of it.
      const rewritten = generated.replace(
        /from ['"].*schema\.ts['"]/,
        `from '${join(repoRoot, 'lib/config/schema.ts').split('\\').join('/')}'`,
      );
      const probe = join(dir, 'probe.ts');
      writeFileSync(probe, rewritten, 'utf8');

      // Evaluated indirectly: the assertion is that configSchema accepts it.
      const objectLiteral = rewritten.slice(
        rewritten.indexOf('defineConfig(') + 'defineConfig('.length,
        rewritten.lastIndexOf(')'),
      );
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const config = new Function(`return (${objectLiteral});`)() as unknown;

      expect(() => configSchema.parse(config)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a .env alongside it', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vp-install-'));
    try {
      execFileSync(
        'bash',
        [join(repoRoot, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
        { stdio: 'pipe' },
      );
      const env = readFileSync(join(dir, '.env'), 'utf8');
      expect(env.length).toBeGreaterThan(0);
      // Every VITE_-prefixed name it writes is inlined into the browser bundle,
      // so each one must be deliberately approved here, otherwise the installer
      // itself could plant a secret in the bundle. The Supabase pair is the
      // documented db exception; VITE_PARTYKIT_HOST is a public hostname the
      // browser must know to open its WebSocket (see deploy/app.Dockerfile).
      const PUBLIC_VITE_NAMES = [
        'VITE_SUPABASE_URL',
        'VITE_SUPABASE_ANON_KEY',
        'VITE_PARTYKIT_HOST',
      ];
      const viteNames = env.match(/^VITE_[A-Z0-9_]+/gm) ?? [];
      for (const name of viteNames) {
        expect(PUBLIC_VITE_NAMES).toContain(name);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!RUNS_INSTALLER)('install.sh — publicUrl', () => {
  it('--defaults writes publicUrl: \'https://localhost\'', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vp-install-puburl-'));
    try {
      execFileSync(
        'bash',
        [join(repoRoot, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
        { stdio: 'pipe' },
      );
      const config = readFileSync(join(dir, 'viewpoint.config.ts'), 'utf8');
      expect(config).toContain("publicUrl: 'https://localhost'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the port in publicUrl when HTTPS_PORT is not 443', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vp-install-puburl-'));
    try {
      execFileSync(
        'bash',
        [join(repoRoot, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
        { stdio: 'pipe', env: { ...process.env, HTTPS_PORT: '8443' } },
      );
      const config = readFileSync(join(dir, 'viewpoint.config.ts'), 'utf8');
      expect(config).toContain("publicUrl: 'https://localhost:8443'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!RUNS_INSTALLER)('install.sh — access control', () => {
  it('--defaults leaves both password hashes empty', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vp-install-access-'));
    try {
      execFileSync(
        'bash',
        [join(repoRoot, 'install.sh'), '--defaults', '--configure-only', '--dir', dir, '-y'],
        { stdio: 'pipe' },
      );
      const env = readFileSync(join(dir, '.env'), 'utf8');
      // Both hashes must be present as variable names.
      expect(env).toMatch(/^ACCESS_PASSWORD_HASH=/m);
      expect(env).toMatch(/^ADMIN_PASSPHRASE_HASH=/m);
      // --defaults leaves them empty (no value after the =).
      const accessLine = env.match(/^ACCESS_PASSWORD_HASH=(.*)$/m)?.[1] ?? 'MISSING';
      const adminLine = env.match(/^ADMIN_PASSPHRASE_HASH=(.*)$/m)?.[1] ?? 'MISSING';
      expect(accessLine).toBe('');
      expect(adminLine).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes salted hashes when passwords are provided via stdin', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const dir = mkdtempSync(join(tmpdir(), 'vp-install-access-'));
    try {
      // Drive the installer non-interactively by piping answers. The access
      // password prompts are the 4th and 5th ask_secret calls (after hostname,
      // TLS, and the access-control intro). --defaults is NOT used here because
      // it would skip the prompts entirely.
      //
      // Instead, set the answers via environment variables the script does not
      // read — we use a small wrapper that feeds answers through stdin.
      // Actually, the simplest approach: source the hash_password function and
      // call it directly.
      const hashOutput = execFileSync('bash', [
        '-c',
        `source '${join(repoRoot, 'install.sh')}' 2>/dev/null; hash_password 'test-pw'`,
      ], { encoding: 'utf8', input: '' }).trim();

      // Must be <16-hex>:<64-hex>. A COLON, not a '$': that is what
      // hash_password prints, what .env.example documents, and what
      // api/_lib/accessControl.ts parses ('$' is accepted there only so a hash
      // written by hand in the old shape still verifies).
      expect(hashOutput).toMatch(/^[0-9a-f]{16}:[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── identity ───────────────────────────────────────────────────────────────
//
// The coupling that matters is the same one this file already exists to guard:
// install.sh must write an identity block that lib/config/schema.ts accepts,
// and a .env whose variables docker-compose.yml actually reads. Nothing else
// connects the two, and the failure is silent until somebody tries to sign in.
//
// These tests SOURCE install.sh and call its render functions instead of
// running it, which is why they are not behind RUNS_INSTALLER: main() is what
// refuses to run on native Windows, and sourcing does not call main (the
// BASH_SOURCE guard at the bottom of the script). All they need is a bash.

const HAS_BASH = (() => {
  try {
    execFileSync('bash', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const REPO_ROOT = resolve(__dirname, '../../..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh').split('\\').join('/');

/**
 * The answers every case starts from: a self-hosted install on localhost with
 * the bundled database and coturn, no PLM, mock capture. Deliberately the shape
 * `--defaults` produces, so `identity` is the only thing under test.
 */
const BASE_ANSWERS: Record<string, string> = {
  A_HOSTNAME: 'localhost',
  A_PUBLIC_URL: 'https://localhost',
  A_TLS: 'self-signed',
  A_PLM: 'none',
  A_CAPTURE: 'mock',
  A_DB: 'bundled',
  A_TURN: 'bundled',
  A_NOTIFY: 'none',
  A_GPU: 'no',
  A_N8N: 'no',
  A_COTURN_HOST: 'localhost',
  A_COTURN_PORT: '3478',
  A_SUPABASE_URL: 'https://localhost',
  A_SUPABASE_ANON_KEY: 'anon-key',
  A_IDENTITY: 'none',
  S_ANON_KEY: 'anon-key',
  S_JWT_SECRET: 'jwt-secret',
  S_CAPTURE_SECRET: 'capture-secret',
  S_POSTGRES_PASSWORD: 'postgres-password',
  S_N8N_KEY: 'n8n-key',
  S_COTURN_SECRET: 'coturn-secret',
  S_SECRET_KEY_BASE: 'secret-key-base',
  S_REALTIME_DB_ENC_KEY: '1234567890123456',
};

/** Source install.sh, apply the answers, and print both generated files. */
function render(answers: Record<string, string>): { config: string; env: string } {
  const overrides = { ...BASE_ANSWERS, ...answers };
  const assign = Object.entries(overrides)
    .map(([name, value]) => `${name}='${value.replace(/'/g, `'\\''`)}'`)
    .join('\n');
  const script = [
    `source '${INSTALL_SH}' 2>/dev/null`,
    'eval "$VP_ANSWERS"',
    'echo "@@@CONFIG@@@"',
    'render_config',
    'echo "@@@ENV@@@"',
    'render_env',
  ].join('\n');

  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, VP_ANSWERS: assign },
  });

  const configStart = out.indexOf('@@@CONFIG@@@');
  const envStart = out.indexOf('@@@ENV@@@');
  expect(configStart, 'render_config produced nothing').toBeGreaterThanOrEqual(0);
  expect(envStart, 'render_env produced nothing').toBeGreaterThan(configStart);
  return {
    config: out.slice(configStart + '@@@CONFIG@@@'.length, envStart),
    env: out.slice(envStart + '@@@ENV@@@'.length),
  };
}

/**
 * Validate the generated file with the real schema and return what it parsed to.
 *
 * Throws if the installer wrote something lib/config/schema.ts rejects — which
 * is the failure this whole file exists to catch.
 *
 * node:vm rather than `new Function`: evaluating a config string is exactly
 * what @typescript-eslint/no-implied-eval exists to flag, and this batch adds
 * no lint suppressions of its own. The evaluated text is install.sh's output,
 * produced by this test — never anything a caller supplied.
 */
function parsedConfig(config: string): ViewpointConfig {
  const literal = config.slice(
    config.indexOf('defineConfig(') + 'defineConfig('.length,
    config.lastIndexOf(')'),
  );
  expect(
    literal.startsWith('{'),
    'the generated config is not a defineConfig({...}) call',
  ).toBe(true);
  const evaluated: unknown = runInNewContext(`(${literal})`, {}, { timeout: 5000 });
  return configSchema.parse(evaluated);
}

/** The COMPOSE_PROFILES line, as a list. */
function profiles(env: string): string[] {
  const line = env.match(/^COMPOSE_PROFILES=(.*)$/m)?.[1] ?? 'MISSING';
  return line.split(',').filter(Boolean);
}

/** One .env value, or null when the variable is not written at all. */
function envValue(env: string, name: string): string | null {
  const match = env.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1] : null;
}

describe.skipIf(!HAS_BASH)('install.sh — identity rendering', () => {
  it('writes identity: { mode: "none" } and no identity profile by default', () => {
    const { config, env } = render({});

    expect(config).toContain("identity: { mode: 'none' },");
    // The default install must run exactly the services it ran before identity
    // existed: no auth container, no extra image to pull.
    expect(profiles(env)).not.toContain('identity');
    expect(env).not.toContain('GOTRUE_DISABLE_SIGNUP');
    expect(env).not.toContain('AZURE_CLIENT_ID');
  });

  it('writes an accounts block the real schema accepts, and turns the profile on', () => {
    const { config, env } = render({
      A_IDENTITY: 'accounts',
      A_ALLOW_GUESTS: 'no',
      A_SIGNUP: 'only-added',
    });

    expect(parsedConfig(config).identity).toEqual({
      mode: 'accounts',
      methods: ['password'],
      allowGuests: false,
      probeUrl: 'http://auth:9999/health',
    });

    expect(profiles(env)).toContain('identity');
    expect(envValue(env, 'GOTRUE_DISABLE_SIGNUP')).toBe('true');
    // GoTrue needs the absolute public origin for its own redirect URLs, and
    // cannot derive it from a Host header that carries no port.
    expect(envValue(env, 'PUBLIC_URL')).toBe('https://localhost');
  });

  it('opens sign-up when the operator says anyone may create an account', () => {
    const { config, env } = render({
      A_IDENTITY: 'accounts',
      A_ALLOW_GUESTS: 'yes',
      A_SIGNUP: 'anyone',
    });
    expect(envValue(env, 'GOTRUE_DISABLE_SIGNUP')).toBe('false');
    expect(parsedConfig(config).identity).toMatchObject({ allowGuests: true });
  });

  it.each([
    ['azure', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'],
    ['google', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    ['keycloak', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET'],
  ])(
    'writes an sso/%s block the schema accepts, with the provider enabled',
    (method, idName, secretName) => {
      const { config, env } = render({
        A_IDENTITY: 'sso',
        A_IDENTITY_METHOD: method,
        A_ALLOW_GUESTS: 'yes',
        A_CLIENT_ID_ENV: idName,
        A_SECRET_ENV: secretName,
        A_SSO_CLIENT_ID: 'the-client-id',
        A_SSO_CLIENT_SECRET: 'the-client-secret',
        A_SSO_TENANT_URL: 'https://login.microsoftonline.com/acme',
        A_SSO_REALM_URL: 'https://keycloak.acme.com/realms/acme',
      });

      const identity = parsedConfig(config).identity;
      expect(identity).toMatchObject({ mode: 'sso', methods: [method], allowGuests: true });
      // The config NAMES the variables; their values live only in .env.
      expect(identity).toMatchObject({
        [method]: { clientIdEnv: idName, secretEnv: secretName },
      });

      expect(profiles(env)).toContain('identity');
      expect(envValue(env, idName)).toBe('the-client-id');
      expect(envValue(env, secretName)).toBe('the-client-secret');
      // Without the provider's own ENABLED flag GoTrue ignores the credentials
      // entirely and simply does not offer the button.
      expect(envValue(env, `GOTRUE_EXTERNAL_${method.toUpperCase()}_ENABLED`)).toBe('true');
      // The other two providers stay off.
      for (const other of ['AZURE', 'GOOGLE', 'KEYCLOAK']) {
        if (other === method.toUpperCase()) continue;
        expect(envValue(env, `GOTRUE_EXTERNAL_${other}_ENABLED`)).toBeNull();
      }
      // Sign-up is not closed on an SSO install: the first sign-in from the
      // provider is what creates the local account.
      expect(envValue(env, 'GOTRUE_DISABLE_SIGNUP')).toBeNull();
    },
  );

  it('writes the azure tenant url and the keycloak realm url to .env', () => {
    const azure = render({
      A_IDENTITY: 'sso',
      A_IDENTITY_METHOD: 'azure',
      A_ALLOW_GUESTS: 'no',
      A_CLIENT_ID_ENV: 'AZURE_CLIENT_ID',
      A_SECRET_ENV: 'AZURE_CLIENT_SECRET',
      A_SSO_CLIENT_ID: 'id',
      A_SSO_CLIENT_SECRET: 'secret',
      A_SSO_TENANT_URL: 'https://login.microsoftonline.com/acme-tenant',
    });
    expect(envValue(azure.env, 'AZURE_TENANT_URL')).toBe(
      'https://login.microsoftonline.com/acme-tenant',
    );
    expect(azure.config).toContain(
      "tenantUrl: 'https://login.microsoftonline.com/acme-tenant',",
    );

    const keycloak = render({
      A_IDENTITY: 'sso',
      A_IDENTITY_METHOD: 'keycloak',
      A_ALLOW_GUESTS: 'no',
      A_CLIENT_ID_ENV: 'KEYCLOAK_CLIENT_ID',
      A_SECRET_ENV: 'KEYCLOAK_CLIENT_SECRET',
      A_SSO_CLIENT_ID: 'id',
      A_SSO_CLIENT_SECRET: 'secret',
      A_SSO_REALM_URL: 'https://keycloak.acme.com/realms/acme',
    });
    expect(envValue(keycloak.env, 'KEYCLOAK_REALM_URL')).toBe(
      'https://keycloak.acme.com/realms/acme',
    );
    expect(keycloak.config).toContain("realmUrl: 'https://keycloak.acme.com/realms/acme',");
  });

  it('omits tenantUrl when the operator leaves it empty', () => {
    // Absent means GoTrue's own default, Microsoft's multi-tenant 'common'
    // endpoint. The schema allows the field to be optional precisely so that
    // the installer can express "use the default" instead of guessing a tenant.
    const { config } = render({
      A_IDENTITY: 'sso',
      A_IDENTITY_METHOD: 'azure',
      A_ALLOW_GUESTS: 'no',
      A_CLIENT_ID_ENV: 'AZURE_CLIENT_ID',
      A_SECRET_ENV: 'AZURE_CLIENT_SECRET',
      A_SSO_CLIENT_ID: 'id',
      A_SSO_CLIENT_SECRET: 'secret',
      A_SSO_TENANT_URL: '',
    });
    expect(config).not.toContain('tenantUrl');
    expect(() => parsedConfig(config)).not.toThrow();
  });

  it('writes saml with no provider sub-block and leaves SAML off as a TODO', () => {
    const { config, env } = render({
      A_IDENTITY: 'sso',
      A_IDENTITY_METHOD: 'saml',
      A_ALLOW_GUESTS: 'yes',
    });

    expect(parsedConfig(config).identity).toEqual({
      mode: 'sso',
      methods: ['saml'],
      allowGuests: true,
      probeUrl: 'http://auth:9999/health',
    });

    expect(profiles(env)).toContain('identity');
    // Empty, and marked: GoTrue validates SAML at boot, so a value nobody
    // checked would be a container that will not start rather than a feature
    // that stays unused.
    expect(envValue(env, 'GOTRUE_SAML_ENABLED')).toBe('');
    expect(envValue(env, 'GOTRUE_SAML_PRIVATE_KEY')).toBe('');
    expect(env).toMatch(/# TODO\(operator\):[^\n]*SAML provider is registered/);
  });

  it('marks an sso provider whose credentials were left blank as TODO(operator)', () => {
    // The installer cannot invent a client secret. What it must not do is write
    // a blank one silently, so the value appears in the summary of outstanding
    // items and the .env line explains itself.
    const { env } = render({
      A_IDENTITY: 'sso',
      A_IDENTITY_METHOD: 'google',
      A_ALLOW_GUESTS: 'no',
      A_CLIENT_ID_ENV: 'GOOGLE_CLIENT_ID',
      A_SECRET_ENV: 'GOOGLE_CLIENT_SECRET',
      A_SSO_CLIENT_ID: '',
      A_SSO_CLIENT_SECRET: '',
    });
    expect(envValue(env, 'GOOGLE_CLIENT_ID')).toBe('');
    expect(envValue(env, 'GOOGLE_CLIENT_SECRET')).toBe('');
    expect(env).toMatch(/# TODO\(operator\): identity\.google\.clientIdEnv/);
    expect(env).toMatch(/# TODO\(operator\): identity\.google\.secretEnv/);
  });

  it('never writes an identity credential under a VITE_ name', () => {
    // A VITE_ name is inlined into the browser bundle by Vite. An SSO client
    // secret in a bundle is a public secret: anyone could impersonate this
    // deployment to the identity provider.
    for (const answers of [
      {},
      { A_IDENTITY: 'accounts', A_ALLOW_GUESTS: 'no', A_SIGNUP: 'only-added' },
      {
        A_IDENTITY: 'sso',
        A_IDENTITY_METHOD: 'azure',
        A_ALLOW_GUESTS: 'no',
        A_CLIENT_ID_ENV: 'AZURE_CLIENT_ID',
        A_SECRET_ENV: 'AZURE_CLIENT_SECRET',
        A_SSO_CLIENT_ID: 'id',
        A_SSO_CLIENT_SECRET: 'secret',
        A_SSO_TENANT_URL: 'https://login.microsoftonline.com/common',
      },
    ]) {
      const { env } = render(answers);
      const viteNames = env.match(/^VITE_[A-Z0-9_]+/gm) ?? [];
      for (const name of viteNames) {
        expect(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_PARTYKIT_HOST']).toContain(
          name,
        );
      }
    }
  });
});
