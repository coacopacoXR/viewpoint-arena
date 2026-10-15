// The deployment half of model file storage (plan 14, batch BA).
//
// Three files have to agree for an import to survive: nginx has to let a 200 MB
// body through without spooling it, compose has to give the api container a
// volume that outlives it, and the api image has to create that volume's mount
// point with an owner the runtime user can write to. Each of the three fails
// silently in a different way — a bare 413 from a proxy, every model vanishing
// on the next upgrade, and an EACCES that surfaces as a 500 on the first import
// after an install — and none of them is visible to a unit test of the handler.
//
// Same shape as nginxCaptureTemplate.test.ts: read the files, assert the
// directives, because nginx and Dockerfile syntax is not code vitest can run.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { DEFAULT_MODEL_STORAGE_DIR } from '../../lib/config/schema.ts';

const REPO_ROOT = join(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

interface ComposeService {
  ports?: string[];
  volumes?: string[];
  networks?: string[];
  environment?: Record<string, string>;
}

const APP_CONF = read('deploy/nginx/app.conf');
const API_DOCKERFILE = read('deploy/api.Dockerfile');
const COMPOSE_TEXT = read('docker-compose.yml');
const COMPOSE = loadYaml(COMPOSE_TEXT) as {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
};

/** nginx has no `#` escapes and nothing here puts a `#` in a string. */
function withoutComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');
}

const APP_CONF_CODE = withoutComments(APP_CONF);

/** The body of a `location` block, matched by brace depth. */
function blockOf(code: string, header: string): string {
  const start = code.indexOf(header);
  expect(start, `no "${header}" block in app.conf`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after "${header}"`);
}

/** Collapses runs of whitespace so directive assertions read naturally. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function bodySizeBytes(code: string): number {
  const match = /client_max_body_size\s+(\d+)([km]?);/.exec(code);
  expect(match, 'no client_max_body_size in the block').not.toBeNull();
  const value = Number(match?.[1]);
  const unit = match?.[2];
  return unit === 'k' ? value * 1024 : unit === 'm' ? value * 1024 * 1024 : value;
}

const MODELS_HEADER = 'location /api/models {';
const MODELS_CODE = flat(blockOf(APP_CONF_CODE, MODELS_HEADER));

// ─── nginx ──────────────────────────────────────────────────────────────────

describe('deploy/nginx/app.conf — /api/models', () => {
  it('exists, and appears ABOVE the /api/ block that would otherwise answer it', () => {
    const modelsAt = APP_CONF_CODE.indexOf(MODELS_HEADER);
    const apiAt = APP_CONF_CODE.indexOf('location /api/ {');
    expect(modelsAt).toBeGreaterThan(0);
    expect(apiAt).toBeGreaterThan(0);
    // A prefix location wins on length, not on order, but the file is read by
    // people: a block buried under /api/ reads as if /api/ still answers this.
    expect(modelsAt).toBeLessThan(apiAt);
  });

  it('is a PREFIX location, so it answers the upload and the download alike', () => {
    // `location = /api/models` would match POST /api/models only, and every
    // GET /api/models/<hash> would fall through to /api/ — with its no-store
    // header and its 300s timeout, and no request-buffering setting.
    expect(MODELS_HEADER).not.toContain('=');
  });

  it('resolves the api upstream at request time through a VARIABLE', () => {
    // A literal hostname is resolved when nginx parses the config, so the app
    // container would refuse to start while `api` is down or still building.
    expect(MODELS_CODE).toContain('resolver 127.0.0.11');
    expect(MODELS_CODE).toContain('set $models_upstream http://api:8787;');
    expect(MODELS_CODE).toContain('proxy_pass $models_upstream;');
    expect(MODELS_CODE).not.toMatch(/proxy_pass\s+http:\/\/api/);
  });

  it('forwards the path unchanged, which is what carries the hash', () => {
    // A URI part on proxy_pass would replace the matched prefix and arrive at
    // the api as /api/models without the segment the route needs.
    expect(MODELS_CODE).toMatch(/proxy_pass \$models_upstream;/);
  });

  it('allows an upload as large as the handler does, and streams it', () => {
    expect(bodySizeBytes(MODELS_CODE)).toBeGreaterThanOrEqual(200 * 1024 * 1024);
    // The app container has no volume for a spooled 200 MiB body.
    expect(MODELS_CODE).toContain('proxy_request_buffering off;');
  });

  it('waits long enough for a large import and a large download', () => {
    expect(MODELS_CODE).toContain('proxy_read_timeout 900s;');
    expect(MODELS_CODE).toContain('proxy_send_timeout 900s;');
  });

  it('does NOT add the no-store header the /api/ block adds', () => {
    // add_header in a location replaces the inherited set, so a no-store here
    // would sit beside the handler's `public, max-age=31536000, immutable` and
    // a browser reading both would re-download the model on every reload —
    // which is the cost storing it by hash exists to remove.
    expect(MODELS_CODE).not.toContain('add_header Cache-Control');
    expect(flat(blockOf(APP_CONF_CODE, 'location /api/ {'))).toContain(
      'add_header Cache-Control "no-store" always;',
    );
  });

  it('adds no new envsubst placeholder', () => {
    // The stock nginx entrypoint substitutes every ${...} in the template, and
    // NGINX_ENVSUBST_FILTER is ^CAPTURE_. Anything else here would arrive at
    // nginx as a literal, which nginx reads as an unknown variable and refuses
    // to start on. The list is now empty: app.conf's one placeholder
    // (${CAPTURE_SHARED_SECRET}) went with the capture routes that used it.
    expect([...new Set(APP_CONF.match(/\$\{[^}]*\}/g) ?? [])]).toEqual([]);
  });

  it('also answers the derived-GLB route under a hash, with nothing new added', () => {
    // /api/models/<hash>/derived/glb is served by the same `api` container, so the
    // prefix location above covers it and needs no sibling block of its own. What
    // it must NOT do is fall through to /api/, whose 300s read timeout would cut
    // off a 200 MB download and whose `add_header Cache-Control "no-store"` would
    // sit beside the handler's `immutable` and make every participant re-fetch.
    expect(MODELS_HEADER).toBe('location /api/models {');
    expect(MODELS_CODE).toContain('proxy_read_timeout 900s;');
    expect(MODELS_CODE).not.toContain('add_header Cache-Control');
    // Nothing in the block matches on a path deeper than /api/models, so a new
    // sub-path cannot be caught by an exact or regex location written for another.
    expect(APP_CONF_CODE).not.toContain('location /api/models/');
  });
});

// ─── compose ────────────────────────────────────────────────────────────────

describe('docker-compose.yml — the models volume', () => {
  it('declares models-data at the top level', () => {
    expect(COMPOSE.volumes).toHaveProperty('models-data');
  });

  it('mounts it on the api service at the path the schema defaults to', () => {
    const api = COMPOSE.services.api;
    expect(api, 'compose has no api service').toBeDefined();
    expect(api.volumes).toContain(`models-data:${DEFAULT_MODEL_STORAGE_DIR}`);
    // The default is what every existing install gets: viewpoint.config.ts
    // written by install.sh has no modelStorage block, so modelStorageOf()
    // answers this directory and the volume has to be there.
    expect(DEFAULT_MODEL_STORAGE_DIR).toBe('/data/models');
  });

  it('mounts it read-write, and still mounts the config read-only', () => {
    const api = COMPOSE.services.api;
    expect(api.volumes).toContain('./viewpoint.config.ts:/app/viewpoint.config.ts:ro');
    // A `:ro` on the models volume would make every upload an EROFS 500.
    expect(
      api.volumes?.some((v) => v.startsWith('models-data:') && v.endsWith(':ro')),
    ).toBe(false);
  });

  it('still publishes no port for the api service', () => {
    // /api/models is reached through the app container's nginx like every other
    // api route; publishing 8787 would put model upload and download on the
    // network with no proxy in front of it.
    expect(COMPOSE.services.api.ports).toBeUndefined();
  });
});

// ─── compose: the api reaches convert-service ───────────────────────────────
//
// A CAD upload is tessellated by the api calling convert-service, so the api
// container has to be able to find it and be allowed to talk to it. Both halves
// fail quietly in a way no unit test can see: an address that is wrong makes every
// conversion `convert_unreachable` in a background job's log line, and a missing
// secret makes every one a 401 from a service that is up and healthy.

describe('docker-compose.yml — the api and convert-service', () => {
  it('gives the api the service address, defaulted to the compose service name', () => {
    // The same shape as CAPTURE_SERVICE_URL: a compose service name rather than a
    // deployment choice, so install.sh does not have to know it. Overridable,
    // because an operator may run convert-service somewhere else, and `-` rather than
    // `:-` so that an empty value in .env turns server-side conversion off.
    expect(COMPOSE.services.api.environment?.CONVERT_SERVICE_URL).toBe(
      '${CONVERT_SERVICE_URL-http://convert-service:8080}',
    );
  });

  it('gives the api the same shared secret convert-service requires', () => {
    expect(COMPOSE.services.api.environment?.CONVERT_SHARED_SECRET).toBe(
      '${CONVERT_SHARED_SECRET:-}',
    );
    expect(COMPOSE.services['convert-service'].environment?.CONVERT_SHARED_SECRET).toBe(
      '${CONVERT_SHARED_SECRET:-}',
    );
  });

  it('puts both on a network they share, and publishes no port for the service', () => {
    // The api reaches convert-service over `backend`, which is internal: true. The
    // service accepts arbitrary model files and runs a native kernel on them, so
    // reachability has to come from the network and the secret, not from a port
    // nobody can see.
    expect(COMPOSE.services.api.networks).toContain('backend');
    expect(COMPOSE.services['convert-service'].networks).toContain('backend');
    expect(COMPOSE.services['convert-service'].ports).toBeUndefined();
  });
});

// ─── the api image ──────────────────────────────────────────────────────────

describe('deploy/api.Dockerfile — the mount point exists and is writable', () => {
  it('creates the storage directory before switching to the runtime user', () => {
    const mkdir = API_DOCKERFILE.indexOf('RUN mkdir -p /data/models');
    const user = API_DOCKERFILE.indexOf('USER node');
    expect(mkdir).toBeGreaterThan(0);
    expect(user).toBeGreaterThan(0);
    expect(mkdir).toBeLessThan(user);
    // A fresh named volume inherits the ownership of the image's directory at
    // the mount point. Without the chown it arrives root-owned and the `node`
    // user cannot write to it.
    expect(API_DOCKERFILE).toContain('chown -R node:node /data');
  });

  it('copies utils/, which is where the accepted-extension list lives', () => {
    // api/models.ts refuses an upload whose extension is not in
    // utils/modelFormats.ts. Without the COPY the handler would fail to load at
    // request time — a 500 from the shim, not a build error.
    expect(API_DOCKERFILE).toContain('COPY utils ./utils');
  });

  it('still copies api, lib and server', () => {
    expect(API_DOCKERFILE).toContain('COPY api ./api');
    expect(API_DOCKERFILE).toContain('COPY lib ./lib');
    expect(API_DOCKERFILE).toContain('COPY server ./server');
  });
});

describe('the compose file still validates as text', () => {
  it('parses, and names the stack', () => {
    // A cheap guard on the edits above: `docker compose config -q` is the real
    // check and runs in CI, but a YAML syntax error should fail here first with
    // a line number rather than in a container.
    expect(COMPOSE_TEXT).toContain('name: viewpoint-arena');
    expect(Object.keys(COMPOSE.services).length).toBeGreaterThan(5);
  });
});
