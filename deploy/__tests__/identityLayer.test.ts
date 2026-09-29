// deploy/__tests__/identityLayer.test.ts
//
// The identity layer: GoTrue (`auth`), its one-shot database preparation
// (`auth-init`), the nginx route at /auth/v1/, and the two SQL files that give
// supabase_auth_admin a password. docs/plan/13-identity.md, batch AX.
//
// Every failure mode these tests exist to catch is SILENT at install time:
//
//   * a GoTrue env var with the wrong name is ignored, not rejected — so the
//     container starts, /api/health says the identity connector is up, and
//     sign-in fails in a browser with an error that does not name the variable.
//   * a GoTrue boolean set to an EMPTY string is a boot crash, not a default:
//     envconfig applies a field's default only when the variable is unset.
//   * `auth` on `backend` alone cannot be reached by nginx-proxy (which lives
//     only on `edge`), and cannot reach an SSO provider's token endpoint
//     (backend is internal:true, with no route off the host).
//   * deploy/db/roles.sql runs ONLY on a fresh data volume, so an existing
//     install switched over to identity gets a role with no password unless
//     auth-init.sql covers it.
//
// Like databaseLayer.test.ts, these parse the config files as text.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

const REPO_ROOT = join(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function withoutComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

/**
 * The executable part of a SQL file, with whole-line `--` comments stripped.
 *
 * These files carry long headers quoting the statements they deliberately do
 * NOT run, so asserting against the raw text matches prose as well as SQL.
 */
function sqlOnly(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*--.*$/, ''))
    .join('\n');
}

const PROXY_CODE = withoutComments(read('deploy/nginx/proxy.conf'));
const COMPOSE_TEXT = read('docker-compose.yml');
const COMPOSE = loadYaml(COMPOSE_TEXT) as {
  services: Record<string, Record<string, unknown>>;
};
const ROLES_SQL = sqlOnly(read('deploy/db/roles.sql'));
const AUTH_INIT_TEXT = read('deploy/db/auth-init.sql');
const AUTH_INIT_SQL = sqlOnly(AUTH_INIT_TEXT);
const INSTALL_SH = read('install.sh');

const AUTH_ENV = COMPOSE.services.auth.environment as Record<string, string>;
const AUTH_INIT = COMPOSE.services['auth-init'];
// Batch AZ: the room server verifies the same token GoTrue signs, and the
// schema grows the one table that is not open to everybody.
const PARTYKIT_ENV = COMPOSE.services.partykit.environment as Record<string, string>;
const SCHEMA_SQL = sqlOnly(read('docs/supabase-schema.sql'));

/** Pull one location block out of proxy.conf, braces and all. */
function locationBlock(header: string): string {
  const start = PROXY_CODE.indexOf(header);
  expect(start, `${header} not found in proxy.conf`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = PROXY_CODE.indexOf('{', start); i < PROXY_CODE.length; i++) {
    if (PROXY_CODE[i] === '{') depth++;
    else if (PROXY_CODE[i] === '}') {
      depth--;
      if (depth === 0) return PROXY_CODE.slice(start, i);
    }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

// ─── docker-compose.yml — the two services ──────────────────────────────────

describe('docker-compose.yml — auth and auth-init', () => {
  it('defines both, and puts both behind the identity profile', () => {
    expect(COMPOSE.services.auth).toBeDefined();
    expect(AUTH_INIT).toBeDefined();
    // The profile is what makes a default install unchanged: no auth container,
    // no extra image pulled, nothing else different. install.sh adds `identity`
    // to COMPOSE_PROFILES only when the operator chose accounts or sso.
    expect(COMPOSE.services.auth.profiles).toEqual(['identity']);
    expect(AUTH_INIT.profiles).toEqual(['identity']);
  });

  it('publishes no ports on either service', () => {
    // Browsers reach GoTrue through nginx-proxy at /auth/v1/, same origin as
    // everything else. A published 9999 would be an unauthenticated auth API on
    // the network with no rate limit in front of it — nginx-proxy's
    // limit_req_zone is the control that stops a password-spraying loop.
    expect(COMPOSE.services.auth.ports).toBeUndefined();
    expect(AUTH_INIT.ports).toBeUndefined();
  });

  it('uses pinned image tags with overridable defaults', () => {
    expect(COMPOSE.services.auth.image).toMatch(
      /supabase\/gotrue:\$\{GOTRUE_IMAGE_TAG:-v2\.197\.0\}/,
    );
    // auth-init reuses the database image on purpose: an install that already
    // pulled supabase/postgres pulls nothing new for identity.
    expect(AUTH_INIT.image).toBe(COMPOSE.services.db.image);
  });

  it('puts auth on BOTH backend and edge', () => {
    const networks = COMPOSE.services.auth.networks as string[];
    // backend: the database is only there.
    expect(networks).toContain('backend');
    // edge: nginx-proxy is only there, so this is what makes /auth/v1/ work at
    // all — the same reason rest and realtime are on both. It is also the
    // outbound route to an SSO provider's token endpoint, and backend is
    // internal:true with no route off the host.
    expect(networks).toContain('edge');
  });

  it('keeps auth-init on backend only', () => {
    // It talks to db and exits. Nothing needs to reach it, and it has no reason
    // to be able to reach the internet.
    expect(AUTH_INIT.networks).toEqual(['backend']);
  });

  it('waits for auth-init to COMPLETE successfully, and for db to be healthy', () => {
    const deps = COMPOSE.services.auth.depends_on as Record<
      string,
      { condition: string }
    >;
    // service_healthy would be wrong here: auth-init has no healthcheck, it has
    // an exit code. `completed_successfully` is what makes `auth` wait for the
    // password and the schema rather than racing them and restart-looping.
    expect(deps['auth-init'].condition).toBe('service_completed_successfully');
    expect(deps.db.condition).toBe('service_healthy');
  });

  it('makes auth-init a one-shot that is not restarted', () => {
    // unless-stopped on a container whose job is to exit would fight the
    // completed_successfully condition above: a restarted container is not a
    // completed one.
    expect(AUTH_INIT.restart).toBe('no');
    expect(AUTH_INIT.depends_on).toEqual({ db: { condition: 'service_healthy' } });
  });

  it('runs auth-init.sql through psql as supabase_admin, with ON_ERROR_STOP', () => {
    // entrypoint, not command: the image's ENTRYPOINT is docker-entrypoint.sh,
    // which would otherwise try to start a second Postgres server.
    expect(AUTH_INIT.command).toBeUndefined();
    const entrypoint = AUTH_INIT.entrypoint as string[];
    expect(entrypoint[0]).toBe('psql');
    expect(entrypoint).toContain('ON_ERROR_STOP=1');
    expect(entrypoint).toContain('supabase_admin');
    expect(entrypoint).toContain('/auth-init.sql');
    expect(entrypoint).toContain('db');
    expect(AUTH_INIT.volumes).toContain('./deploy/db/auth-init.sql:/auth-init.sql:ro');
    // The script reads the password through a `\set` backtick, which needs the
    // variable in the environment, and psql needs it to authenticate.
    const env = AUTH_INIT.environment as Record<string, string>;
    expect(env.POSTGRES_PASSWORD).toBeDefined();
    expect(env.PGPASSWORD).toBeDefined();
  });

  it('healthchecks auth on GoTrue\'s own /health', () => {
    const test = (COMPOSE.services.auth.healthcheck as { test: string[] }).test;
    expect(test.join(' ')).toContain('http://localhost:9999/health');
    // /health is unauthenticated and performs no I/O, and wget is BusyBox's
    // from the image's alpine base — so --spider is enough and needs no token.
    expect(test.join(' ')).toContain('--spider');
  });

  it('leaves nginx-proxy independent of auth', () => {
    // nginx-proxy must start with the identity profile off, and must not wait
    // on the auth container when it is on. The resolver + variable pattern in
    // proxy.conf is what makes that safe.
    const deps = COMPOSE.services['nginx-proxy'].depends_on as string[];
    expect(deps).not.toContain('auth');
    expect(deps).not.toContain('auth-init');
  });
});

// ─── docker-compose.yml — GoTrue's environment ──────────────────────────────
//
// Names verified against supabase/auth at tag v2.197.0, in
// internal/conf/configuration.go, internal/conf/saml.go and example.env. The
// prefix rule that makes them unintuitive: envconfig builds
// GOTRUE_<parent>_<field>, and a field carrying an `envconfig:"X"` tag ALSO
// accepts bare X — so API_EXTERNAL_URL works and GOTRUE_API_EXTERNAL_URL is
// silently ignored, while GOTRUE_DB_DATABASE_URL works and GOTRUE_DATABASE_URL
// does not.

describe('docker-compose.yml — GoTrue environment', () => {
  it('sets the five variables GoTrue treats as mandatory', () => {
    // Each is `required:"true"` in configuration.go; a missing one is a
    // logrus.Fatalf at boot, i.e. a restart-looping container.
    expect(AUTH_ENV.GOTRUE_DB_DRIVER).toBe('postgres');
    expect(AUTH_ENV.GOTRUE_DB_DATABASE_URL).toMatch(
      /^postgres:\/\/supabase_auth_admin:\$\{POSTGRES_PASSWORD:-\}@db:5432\/postgres$/,
    );
    expect(AUTH_ENV.GOTRUE_JWT_SECRET).toBe('${JWT_SECRET:-}');
    expect(AUTH_ENV.GOTRUE_SITE_URL).toBeDefined();
    expect(AUTH_ENV.API_EXTERNAL_URL).toBeDefined();
  });

  it('uses the UNPREFIXED API_EXTERNAL_URL, not GOTRUE_API_EXTERNAL_URL', () => {
    // The trap this exists to catch: the prefixed spelling looks right, is
    // accepted by compose, is ignored by GoTrue, and then kills the container
    // with "required key API_EXTERNAL_URL missing value".
    expect(AUTH_ENV).not.toHaveProperty('GOTRUE_API_EXTERNAL_URL');
    expect(AUTH_ENV.API_EXTERNAL_URL).toMatch(/\/auth\/v1$/);
  });

  it('derives both public URLs from one PUBLIC_URL, so a non-443 port survives', () => {
    // GoTrue builds its own redirect and callback URLs from these. The Host
    // header nginx-proxy forwards carries no port, so an install on a
    // non-standard HTTPS_PORT would otherwise generate URLs that do not
    // resolve. install.sh writes PUBLIC_URL from the hostname + port answers.
    expect(AUTH_ENV.GOTRUE_SITE_URL).toBe('${PUBLIC_URL:-https://localhost}');
    expect(AUTH_ENV.API_EXTERNAL_URL).toBe(
      '${PUBLIC_URL:-https://localhost}/auth/v1',
    );
    expect(AUTH_ENV.GOTRUE_URI_ALLOW_LIST).toBe('${PUBLIC_URL:-https://localhost}');
    expect(AUTH_ENV.GOTRUE_EXTERNAL_AZURE_REDIRECT_URI).toBe(
      '${PUBLIC_URL:-https://localhost}/auth/v1/callback',
    );
    expect(AUTH_ENV.GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI).toBe(
      '${PUBLIC_URL:-https://localhost}/auth/v1/callback',
    );
    expect(AUTH_ENV.GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI).toBe(
      '${PUBLIC_URL:-https://localhost}/auth/v1/callback',
    );
  });

  it('signs with the same JWT secret PostgREST and Realtime verify', () => {
    // The whole point of running GoTrue instead of writing a login: one secret,
    // so a token from /auth/v1/token is accepted by /rest/v1/ with no glue, and
    // RLS can use auth.uid() without a second trust boundary.
    const rest = COMPOSE.services.rest.environment as Record<string, string>;
    const realtime = COMPOSE.services.realtime.environment as Record<string, string>;
    expect(AUTH_ENV.GOTRUE_JWT_SECRET).toBe(rest.PGRST_JWT_SECRET);
    expect(AUTH_ENV.GOTRUE_JWT_SECRET).toBe(realtime.API_JWT_SECRET);
    expect(AUTH_ENV.GOTRUE_JWT_EXP).toBe('3600');
    expect(AUTH_ENV.GOTRUE_JWT_AUD).toBe('authenticated');
    expect(AUTH_ENV.GOTRUE_JWT_DEFAULT_GROUP_NAME).toBe('authenticated');
    expect(AUTH_ENV.GOTRUE_JWT_ADMIN_ROLES).toBe('service_role');
  });

  it('gives EVERY boolean an explicit true/false default, never an empty one', () => {
    // The single most likely footgun in this service. envconfig applies a
    // field's own default only when the variable is UNSET; one that is set but
    // empty is parsed, ParseBool("") fails, and the container dies at boot
    // instead of turning the feature off. `${VAR:-}` is therefore a bug here,
    // not a harmless omission.
    const booleans = [
      'GOTRUE_DISABLE_SIGNUP',
      'GOTRUE_EXTERNAL_EMAIL_ENABLED',
      'GOTRUE_MAILER_AUTOCONFIRM',
      'GOTRUE_EXTERNAL_AZURE_ENABLED',
      'GOTRUE_EXTERNAL_GOOGLE_ENABLED',
      'GOTRUE_EXTERNAL_KEYCLOAK_ENABLED',
      'GOTRUE_SAML_ENABLED',
    ];
    for (const name of booleans) {
      const value = AUTH_ENV[name];
      expect(value, `${name} is missing`).toBeDefined();
      expect(value, `${name} would crash GoTrue at boot`).not.toMatch(/:-\}$/);
      expect(value, `${name} is not a boolean default`).toMatch(
        /^(true|false)$|:-(true|false)\}$/,
      );
    }
    // And the numbers, which fail ParseInt("") the same way.
    expect(AUTH_ENV.GOTRUE_JWT_EXP).toMatch(/^\d+$/);
    expect(AUTH_ENV.GOTRUE_API_PORT).toBe('9999');
  });

  it('leaves SAML off by default', () => {
    // SAML is the one provider GoTrue validates AT BOOT: enabled with an
    // unusable private key is a fatal configuration error, not an unused
    // feature. So the flag defaults to false and the key to empty, and the
    // installer writes both as TODO(operator) for a SAML answer.
    expect(AUTH_ENV.GOTRUE_SAML_ENABLED).toBe('${GOTRUE_SAML_ENABLED:-false}');
    expect(AUTH_ENV.GOTRUE_SAML_PRIVATE_KEY).toBe('${GOTRUE_SAML_PRIVATE_KEY:-}');
  });

  it('configures all three OIDC providers with GoTrue\'s own field names', () => {
    // _CLIENT_ID, _SECRET, _REDIRECT_URI, _URL, _ENABLED — and KEYCLOAK as one
    // word. An empty client id or secret is inert: GoTrue validates a provider
    // when a request starts its flow, not at boot.
    for (const provider of ['AZURE', 'GOOGLE', 'KEYCLOAK']) {
      const prefix = `GOTRUE_EXTERNAL_${provider}_`;
      expect(AUTH_ENV[`${prefix}ENABLED`]).toBe(`\${${prefix}ENABLED:-false}`);
      expect(AUTH_ENV[`${prefix}CLIENT_ID`]).toBeDefined();
      expect(AUTH_ENV[`${prefix}SECRET`]).toBeDefined();
      expect(AUTH_ENV[`${prefix}REDIRECT_URI`]).toBeDefined();
    }
    expect(AUTH_ENV.GOTRUE_EXTERNAL_AZURE_URL).toBe('${AZURE_TENANT_URL:-}');
    expect(AUTH_ENV.GOTRUE_EXTERNAL_KEYCLOAK_URL).toBe('${KEYCLOAK_REALM_URL:-}');
  });

  it('does NOT set GOTRUE_EXTERNAL_GOOGLE_URL, which v2.197 ignores', () => {
    // Google always resolves through OIDC discovery against a fixed issuer;
    // setting the variable only produces a warning in the log, which reads like
    // a misconfiguration to the operator who set it.
    expect(AUTH_ENV).not.toHaveProperty('GOTRUE_EXTERNAL_GOOGLE_URL');
  });

  it('does not use the two names that look right and are silently ignored', () => {
    // GOTRUE_DATABASE_URL: the working names are GOTRUE_DB_DATABASE_URL and
    // bare DATABASE_URL. GOTRUE_DB_NAMESPACE: the working names are
    // GOTRUE_DB_DBB_NAMESPACE and bare DB_NAMESPACE, and the default `auth` is
    // what deploy/db/auth-init.sql creates — so it is simply not set.
    expect(AUTH_ENV).not.toHaveProperty('GOTRUE_DATABASE_URL');
    expect(AUTH_ENV).not.toHaveProperty('GOTRUE_DB_NAMESPACE');
    expect(AUTH_ENV).not.toHaveProperty('GOTRUE_LOGGING_LEVEL');
  });

  it('puts no secret in a place the browser can read', () => {
    // The auth service reads its credentials from the environment, and the app
    // image's build args are the only values that reach the client bundle. No
    // GoTrue variable may travel that way.
    const appArgs = (COMPOSE.services.app.build as { args: Record<string, string> })
      .args;
    for (const name of Object.keys(AUTH_ENV)) {
      expect(appArgs, `${name} reached the app build args`).not.toHaveProperty(name);
    }
    expect(Object.keys(appArgs).every((k) => k.startsWith('VITE_'))).toBe(true);
  });
});

// ─── deploy/nginx/proxy.conf — /auth/v1/ ────────────────────────────────────

describe('deploy/nginx/proxy.conf — /auth/v1/', () => {
  const block = locationBlock('location /auth/v1/ {');

  it('resolves the upstream per request, like /rest/v1/', () => {
    // The pattern proxyUpstreams.test.ts enforces for every upstream: a literal
    // proxy_pass pins the IP nginx saw when IT started, so any `compose up`
    // that recreated auth but not nginx-proxy would leave sign-in answering
    // 502 until the proxy was restarted by hand. It is also what lets nginx
    // start with the identity profile off.
    expect(block).toContain('resolver 127.0.0.11');
    expect(block).toContain('set $auth_upstream http://auth:9999;');
    expect(block).toMatch(/proxy_pass\s+\$auth_upstream;/);
  });

  it('strips the /auth/v1 prefix with an explicit rewrite', () => {
    // With a variable in proxy_pass nginx does NOT replace the matched prefix,
    // so without this every request would reach GoTrue as "/" whatever the
    // path. GoTrue mounts its routes at the root.
    expect(block).toContain('rewrite ^/auth/v1/(.*)$ /$1 break;');
  });

  it('forwards the client address and the original scheme', () => {
    // GoTrue records the client IP for its own rate limits and builds redirect
    // URLs from the scheme, so both have to survive the proxy hop.
    expect(block).toContain('proxy_set_header   X-Real-IP         $remote_addr;');
    expect(block).toContain('proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;');
    expect(block).toContain('proxy_set_header   X-Forwarded-Proto $scheme;');
  });

  it('sits above the catch-all location', () => {
    const authAt = PROXY_CODE.indexOf('location /auth/v1/ {');
    const catchAllAt = PROXY_CODE.lastIndexOf('location / {');
    expect(authAt).toBeGreaterThan(0);
    expect(catchAllAt).toBeGreaterThan(0);
    expect(authAt).toBeLessThan(catchAllAt);
  });

  it('rate-limits the token endpoint at 10r/m with a burst of 10', () => {
    // Sign-in is the one place in this stack where an unauthenticated caller
    // can attempt a password guess, so it gets a much tighter zone than
    // capture's 30r/m.
    expect(PROXY_CODE).toMatch(
      /limit_req_zone \$auth_token_limit_key zone=auth_token:10m rate=10r\/m;/,
    );
    expect(block).toMatch(/limit_req\s+zone=auth_token burst=10 nodelay;/);
    // 429 rather than nginx's default 503, so a client can tell "too many
    // attempts, slow down" from "the auth service is down".
    expect(block).toMatch(/limit_req_status\s+429;/);
  });

  it('limits ONLY the token endpoint, not the rest of the sign-in flow', () => {
    // The zone is keyed on a map whose default branch is the empty string, and
    // nginx applies no limit at all to an empty key. Without that, /settings,
    // /authorize, /callback and /logout — all part of ONE ordinary sign-in —
    // would share a 10/minute bucket with the password attempts and a single
    // SSO redirect could be throttled.
    // Keyed on $request_uri: the location's rewrite turns $uri into "/token"
    // BEFORE limit_req runs, so a $uri-keyed map never matched and the limit
    // did nothing (12 bad logins in a row all went through, found live).
    expect(PROXY_CODE).not.toContain('map $uri $auth_token_limit_key');
    const mapStart = PROXY_CODE.indexOf('map $request_uri $auth_token_limit_key {');
    expect(mapStart).toBeGreaterThan(0);
    const mapBlock = PROXY_CODE.slice(mapStart, PROXY_CODE.indexOf('}', mapStart));
    expect(mapBlock).toMatch(/default\s+"";/);
    expect(mapBlock).toContain(String.raw`~^/auth/v1/token(/|\?|$)`);
    expect(mapBlock).toMatch(/\$binary_remote_addr;/);
    expect(mapBlock).not.toContain('/auth/v1/callback');
    expect(mapBlock).not.toContain('/auth/v1/settings');
  });
});

// ─── The database role ──────────────────────────────────────────────────────

describe('deploy/db — supabase_auth_admin', () => {
  it('roles.sql sets the password on a FRESH volume', () => {
    // Mounted into docker-entrypoint-initdb.d/init-scripts/, which the image
    // runs only when the data volume is empty. It sorts after the image's own
    // 00000000000001-auth-schema.sql, which is what CREATEs the role, so the
    // ALTER can rely on it existing.
    expect(ROLES_SQL).toMatch(
      /ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';/,
    );
    expect(ROLES_SQL).toMatch(/ALTER USER authenticator WITH PASSWORD :'pgpass';/);
  });

  it('auth-init.sql sets the same password on an EXISTING volume', () => {
    // The gap this file exists to close: an install that switches identity on
    // later never re-runs roles.sql, so without this GoTrue gets a role it
    // cannot log in with and restart-loops against a healthy database.
    expect(AUTH_INIT_SQL).toMatch(
      /ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';/,
    );
    expect(AUTH_INIT_SQL).toMatch(/\\set pgpass `echo "\$POSTGRES_PASSWORD"`/);
  });

  it('auth-init.sql makes sure the auth schema exists and is owned by the role', () => {
    // GoTrue's own first migration creates auth.users INSIDE the schema and
    // never creates the schema itself, and it runs every migration on every
    // start — so both the existence and the ownership have to be right before
    // the container comes up.
    expect(AUTH_INIT_SQL).toMatch(
      /CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;/,
    );
    expect(AUTH_INIT_SQL).toMatch(/ALTER SCHEMA auth OWNER TO supabase_auth_admin;/);
  });

  it('auth-init.sql is idempotent — safe on every `up`, fresh volume included', () => {
    // It runs on every start with the profile on, so anything that would fail
    // the second time is a bug. IF NOT EXISTS / ALTER are; a bare CREATE is not.
    expect(AUTH_INIT_SQL).not.toMatch(/^\s*CREATE SCHEMA auth\s*;/m);
    // The role is created by the image, and re-creating it here would either
    // fail or, worse, succeed with different attributes than the image's own
    // NOINHERIT CREATEROLE LOGIN NOREPLICATION.
    expect(AUTH_INIT_SQL).not.toMatch(/CREATE (USER|ROLE)/);
    expect(AUTH_INIT_SQL).toMatch(/GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;/);
  });

  it('explains in its header why it is not part of roles.sql', () => {
    // The next person to read this will ask exactly that, and the answer (fresh
    // volume vs existing volume) is the whole reason the file exists.
    expect(AUTH_INIT_TEXT).toMatch(/roles\.sql/);
    expect(AUTH_INIT_TEXT).toMatch(/fresh/i);
    expect(AUTH_INIT_TEXT).toMatch(/existing/i);
  });
});

// ─── install.sh — the identity profile ──────────────────────────────────────

describe('install.sh — identity wiring', () => {
  it('adds the identity profile in .env only when identity is not none', () => {
    // Both places have to agree: render_env writes COMPOSE_PROFILES (what a
    // plain `docker compose up` later uses) and compose_files builds the
    // --profile arguments for the installer's own `up`. A mismatch means the
    // installer starts auth and the operator's next `docker compose up` does
    // not, or the reverse.
    expect(INSTALL_SH).toMatch(
      /\[\[ "\$A_IDENTITY" != 'none' \]\] && profiles\+=\(identity\)/,
    );
    expect(INSTALL_SH).toMatch(/if \[\[ "\$A_IDENTITY" != 'none' \]\]; then\s+PROFILES\+=\(identity\)/);
  });

  it('does not ask for a front-door password once identity is on', () => {
    // docs/plan/13-identity.md: signing in IS the front door. The question is
    // inside the identity-is-none branch, and the else branch says out loud why
    // it was skipped rather than silently not asking.
    const askAt = INSTALL_SH.indexOf(
      "ask_secret 'Front-door password for the whole app",
    );
    expect(askAt).toBeGreaterThan(0);
    const before = INSTALL_SH.lastIndexOf(`if [[ "$A_IDENTITY" == 'none' ]]; then`, askAt);
    expect(before).toBeGreaterThan(0);
    expect(INSTALL_SH).toMatch(/signing in is the door/);
  });

  it('writes PUBLIC_URL, which GoTrue needs for its own redirect URLs', () => {
    expect(INSTALL_SH).toMatch(/printf 'PUBLIC_URL=%s\\n' "\$A_PUBLIC_URL"/);
  });

  it('writes the chosen provider\'s ENABLED flag', () => {
    // Without it GoTrue ignores the client id and secret entirely and the
    // provider simply is not offered.
    expect(INSTALL_SH).toContain("enabled_var='GOTRUE_EXTERNAL_AZURE_ENABLED'");
    expect(INSTALL_SH).toContain("enabled_var='GOTRUE_EXTERNAL_GOOGLE_ENABLED'");
    expect(INSTALL_SH).toContain("enabled_var='GOTRUE_EXTERNAL_KEYCLOAK_ENABLED'");
    expect(INSTALL_SH).toMatch(/printf '%s=true\\n' "\$enabled_var"/);
  });

  it('refuses to write an sso config whose provider details are missing', () => {
    // validate_answers is the reason an installer cannot produce a config the
    // schema would reject, or one that validates and then fails at sign-in.
    expect(INSTALL_SH).toMatch(/needs a client id \(\$\{A_CLIENT_ID_ENV\}\)/);
    expect(INSTALL_SH).toMatch(/needs a client secret \(\$\{A_SECRET_ENV\}\)/);
    expect(INSTALL_SH).toMatch(/needs identity\.keycloak\.realmUrl/);
  });

  it('leaves the SAML variables as TODO(operator) rather than guessing', () => {
    // A SAML provider is an IdP metadata document registered through the
    // GoTrue admin API afterwards. The installer cannot do that, so it says so
    // and marks the two variables, instead of writing values that would crash
    // the container at boot.
    expect(INSTALL_SH).toMatch(/todo_var 'GOTRUE_SAML_ENABLED'/);
    expect(INSTALL_SH).toMatch(/todo_var 'GOTRUE_SAML_PRIVATE_KEY'/);
  });

  it('always writes an identity block, including for the none answer', () => {
    // An explicit { mode: 'none' } records the decision instead of leaving a
    // reader to wonder whether the block is absent because there are no
    // accounts or because the install predates the question.
    expect(INSTALL_SH).toContain(`identity_block="  identity: { mode: 'none' },"`);
    expect(INSTALL_SH).toMatch(/\$\{identity_block\}/);
    // And /api/health can only reach the identity service by its compose name.
    expect(INSTALL_SH).toContain(`probeUrl: 'http://auth:9999/health',`);
  });

  it('tells the operator the redirect URI to register with the provider', () => {
    // The failure this prevents — a redirect_uri mismatch — surfaces in a
    // browser as an error from the identity provider that looks nothing like a
    // missing installer step.
    expect(INSTALL_SH).toMatch(/\$\{A_PUBLIC_URL\}\/auth\/v1\/callback/);
  });
});

// ─── The compose file still describes a default install accurately ──────────

describe('docker-compose.yml — a default install is unchanged', () => {
  it('adds no service that is not behind a profile', () => {
    // Every service without a `profiles:` entry starts on a plain
    // `docker compose up`. Identity must not be one of them.
    const alwaysOn = Object.entries(COMPOSE.services)
      .filter(([, service]) => service.profiles === undefined)
      .map(([name]) => name)
      .sort();
    expect(alwaysOn).toEqual([
      'api',
      'app',
      'capture-service',
      'db',
      // Batch BY: backups are on by default, on purpose — an install that had to be
      // opted into backing itself up is one that loses data first.
      'db-backup',
      'nginx-proxy',
      'partykit',
      'realtime',
      'rest',
    ]);
  });

  it('documents the identity profile in the profiles block at the top', () => {
    expect(COMPOSE_TEXT).toMatch(/^#\s+identity\s+/m);
  });

  it('keeps auth out of the host-published port list', () => {
    const published = Object.entries(COMPOSE.services)
      .filter(([, service]) => service.ports !== undefined)
      .map(([name]) => name)
      .sort();
    expect(published).not.toContain('auth');
    expect(published).not.toContain('auth-init');
  });
});

// ─── Batch AZ: the room server trusts signed names ──────────────────────────
//
// docs/plan/13-identity.md, part 3. Two things can go wrong here and both are
// silent: a room server that is never told the mode keeps relaying typed names
// on a deployment where those names are supposed to be proven, and a secret
// that reaches the browser bundle stops being a secret. Neither is visible in
// a running stack — the room works, people see each other, sign-in works — so
// the wiring is pinned here instead.

describe('docker-compose.yml — the room server and identity', () => {
  it('tells the partykit container which mode this install has', () => {
    // Room code runs inside workerd in that container and cannot read
    // viewpoint.config.ts, so the mode has to travel through the environment
    // and on through deploy/partykit-entrypoint.sh's --var.
    expect(PARTYKIT_ENV.IDENTITY_MODE).toBe('${IDENTITY_MODE:-none}');
  });

  it('defaults to none, so an install that never set it behaves as before', () => {
    // The failure this prevents is a room server that verifies nothing and
    // says nothing about it on an install where the operator believes names
    // are proven.
    expect(PARTYKIT_ENV.IDENTITY_MODE).toMatch(/:-none\}$/);
  });

  it('gives the room server the same secret GoTrue signs with', () => {
    // One secret, one trust boundary: the token the browser already holds is
    // the proof, and the room server needs no call to the auth service.
    const rest = COMPOSE.services.rest.environment as Record<string, string>;
    expect(PARTYKIT_ENV.JWT_SECRET).toBe(AUTH_ENV.GOTRUE_JWT_SECRET);
    expect(PARTYKIT_ENV.JWT_SECRET).toBe(rest.PGRST_JWT_SECRET);
  });

  it('keeps partykit out of the identity profile', () => {
    // The room server runs on EVERY install, including one with no auth
    // container at all, so it has to behave correctly with IDENTITY_MODE
    // absent as well as with it set to 'none'.
    expect(COMPOSE.services.partykit.profiles).toBeUndefined();
  });

  it('gives the secret no route into the client bundle', () => {
    // The app image's build args are the only values Vite inlines into the
    // shipped JavaScript, so nothing JWT-shaped may be one of them.
    const appArgs = (COMPOSE.services.app.build as { args: Record<string, string> }).args;
    expect(Object.keys(appArgs).some((name) => name.includes('JWT'))).toBe(false);
    expect(Object.keys(appArgs).some((name) => name.includes('IDENTITY_MODE'))).toBe(false);
  });
});

describe('install.sh — IDENTITY_MODE', () => {
  it('writes the mode for every answer, none included', () => {
    expect(INSTALL_SH).toMatch(/printf 'IDENTITY_MODE=%s\\n' "\$A_IDENTITY"/);
    // Written before the case rather than inside a branch, so the 'none'
    // answer cannot forget it and leave the container on a default nobody
    // chose.
    const writtenAt = INSTALL_SH.indexOf("printf 'IDENTITY_MODE=%s");
    const caseAt = INSTALL_SH.indexOf('case "$A_IDENTITY" in', writtenAt);
    expect(writtenAt).toBeGreaterThan(0);
    expect(caseAt).toBeGreaterThan(writtenAt);
  });

  it('says which secret the room server verifies with, and that it is server-only', () => {
    // The next operator to read the generated .env should not have to work out
    // where JWT_SECRET went or wonder whether a VITE_ copy is needed.
    expect(INSTALL_SH).toMatch(/JWT_SECRET from section 1/);
    expect(INSTALL_SH).toMatch(/no VITE_ spelling/);
  });
});

describe('docs/supabase-schema.sql — review_participants', () => {
  /** The create-table statement, so assertions do not match other tables. */
  function tableBody(): string {
    const start = SCHEMA_SQL.indexOf('create table if not exists review_participants');
    expect(start, 'review_participants is not created in the schema').toBeGreaterThan(-1);
    return SCHEMA_SQL.slice(start, SCHEMA_SQL.indexOf(');', start));
  }

  /** Every create policy statement aimed at this table. */
  function policies(): string[] {
    return SCHEMA_SQL.match(/create policy[^;]*on review_participants[^;]*/g) ?? [];
  }

  it('creates the table idempotently, because install.sh re-applies this file', () => {
    // The file is mounted into the database's first boot AND piped through
    // psql -v ON_ERROR_STOP=1 on every install.sh run, so a bare CREATE would
    // abort the whole load the second time.
    expect(SCHEMA_SQL).toMatch(/create table if not exists review_participants \(/);
    expect(tableBody()).not.toMatch(/create table review_participants \(/);
    expect(tableBody()).toMatch(/primary key \(review_id, user_id\)/);
    expect(SCHEMA_SQL).toMatch(
      /create index if not exists review_participants_user_idx/,
    );
  });

  it('keys the row on auth.uid() rather than on an id the client sends', () => {
    // This is what makes the table safe to write from a browser: the column
    // default is the caller's own authenticated id, so there is no row
    // anybody can write for anybody else.
    expect(tableBody()).toMatch(/user_id uuid not null default auth\.uid\(\)/);
    expect(tableBody()).toMatch(/role text not null default 'participant'/);
    expect(tableBody()).toMatch(/first_joined_at timestamptz not null default now\(\)/);
    expect(tableBody()).toMatch(/last_joined_at timestamptz not null default now\(\)/);
  });

  it('turns RLS on and keys every policy on auth.uid()', () => {
    expect(SCHEMA_SQL).toMatch(
      /alter table review_participants enable row level security/,
    );
    for (const command of ['select', 'insert', 'update']) {
      expect(policies().some((p) => p.includes(`for ${command} to authenticated`))).toBe(true);
    }
    // select/update compare with `using`, insert with `with check`, and all
    // three ask the same question: is this your row?
    expect(SCHEMA_SQL.match(/user_id = auth\.uid\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('gives the anon role no policy at all', () => {
    // The anon key is published in the browser bundle. With RLS on and no
    // policy for `anon`, it can read no row here — which is the point: who took
    // part in a commercially sensitive design review is not public, and this is
    // the one table in the schema that is not open.
    expect(policies()).toHaveLength(3);
    for (const policy of policies()) {
      expect(policy).toContain('to authenticated');
      expect(policy).not.toContain('anon');
      expect(policy).not.toContain('public');
      expect(policy).not.toContain('using (true)');
    }
    // No delete either: a participant row is a record, not something the app
    // removes. RLS with no policy denies it.
    expect(policies().some((p) => p.includes('for delete'))).toBe(false);
  });

  it('drops each policy before creating it, so a re-run cannot fail', () => {
    for (const name of ['select', 'insert', 'update']) {
      expect(SCHEMA_SQL).toContain(
        `drop policy if exists "own review participants ${name}" on review_participants;`,
      );
      expect(SCHEMA_SQL).toContain(
        `create policy "own review participants ${name}" on review_participants`,
      );
    }
  });

  it('has no foreign key to review_curations', () => {
    // An ad-hoc session has a room id and no curation row. A key would refuse
    // exactly the write that makes the lobby's list useful, so the join happens
    // in a second query and a missing title renders as "Session <short id>".
    expect(tableBody()).not.toMatch(/references/);
  });
});
