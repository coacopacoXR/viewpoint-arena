// The nginx half of local capture (T4.4), re-pointed at the api by batch BF of
// docs/plan/14-rooms-models-admin-ai.md.
//
// deploy/nginx/app.conf is not code that vitest can execute, and a mistake in it
// fails in the one place nobody is looking: inside a container, at request time,
// during an installation. Three specific mistakes are worth a red test because
// each one is silent until it isn't:
//
//   1. a capture location landing BELOW `location /api/` in the file, where a
//      reader (or a future edit) will assume the 501 block answers it;
//   2. a LITERAL upstream hostname, which makes nginx refuse to start whenever
//      that service is not resolvable yet — i.e. during its own build;
//   3. a capture route going back to capture-service directly, which would
//      silently override the per-job provider an administrator chose, because
//      nginx would have picked the AI before the api ever saw the request.
//
// The Dockerfile and compose assertions are here for the same reason: the
// template only works if all three files agree.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';

const REPO_ROOT = join(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

interface ComposeService {
  ports?: string[];
  networks?: string[];
  environment?: Record<string, string>;
  build?: { context?: string };
}

const APP_CONF = read('deploy/nginx/app.conf');
const DOCKERFILE = read('deploy/app.Dockerfile');
const COMPOSE_TEXT = read('docker-compose.yml');
const COMPOSE = loadYaml(COMPOSE_TEXT) as { services: Record<string, ComposeService> };

/**
 * nginx has no `#` escapes and nothing in this file puts a `#` inside a string,
 * so stripping comments is a line-prefix operation.
 */
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

const CAPTURE_HEADER = 'location = /api/capture/local {';
const CAPTURE_BLOCK = blockOf(APP_CONF_CODE, CAPTURE_HEADER);

/** Collapses runs of whitespace so directive assertions read naturally. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

const CAPTURE_CODE = flat(CAPTURE_BLOCK);

// ─── The location block ─────────────────────────────────────────────────────

describe('deploy/nginx/app.conf — /api/capture/local', () => {
  it('exists, and appears ABOVE the /api/ block that would otherwise answer it', () => {
    const captureAt = APP_CONF_CODE.indexOf(CAPTURE_HEADER);
    const apiAt = APP_CONF_CODE.indexOf('location /api/ {');

    expect(captureAt).toBeGreaterThan(0);
    expect(apiAt).toBeGreaterThan(0);
    // `location = …` wins on nginx's own matching rules regardless of order, but
    // the file is read by people: a capture block buried under the 501 block
    // reads as if /api/* still swallows everything.
    expect(captureAt).toBeLessThan(apiAt);
  });

  it('is POST-only', () => {
    expect(CAPTURE_CODE).toContain('limit_except POST { deny all; }');
  });

  it('resolves the upstream at request time through a VARIABLE, not a literal host', () => {
    // A literal `proxy_pass http://api:8787` is resolved when nginx parses the
    // config, so the app container refuses to start whenever `api` is not
    // resolvable yet — which is the whole of its own build window.
    expect(CAPTURE_CODE).toContain('resolver 127.0.0.11');
    expect(CAPTURE_CODE).toContain('set $capture_upstream http://api:8787;');
    expect(CAPTURE_CODE).not.toMatch(/proxy_pass\s+http:\/\//);
  });

  it('goes to the api, not straight to capture-service', () => {
    // The point of batch BF: nginx must not be the layer that decides which AI
    // handles a recording, because a deployment now chooses per job from the admin
    // console. A bypass here would silently ignore that choice for audio.
    expect(CAPTURE_CODE).toContain('http://api:8787');
    expect(CAPTURE_CODE).not.toContain('capture-service');
    // No URI part on proxy_pass: server/vercelShim.ts routes on the path as it
    // arrived, so `proxy_pass $upstream/api/capture/local` and
    // `proxy_pass $upstream/capture` would both be wrong in different ways.
    expect(CAPTURE_CODE).toMatch(/proxy_pass \$capture_upstream;/);
  });

  it('does NOT add the capture-service secret — the api does that now', () => {
    // The secret moved with the routing: lib/ai/router.ts adds X-Capture-Token
    // from the api container's own environment. Leaving the header here would mean
    // two layers adding it and a secret in a container that no longer needs one.
    expect(CAPTURE_CODE).not.toContain('X-Capture-Token');
    expect(CAPTURE_CODE).not.toContain('CAPTURE_SHARED_SECRET');
  });

  it('allows an upload as large as the service default, and streams it', () => {
    // DEFAULT_MAX_UPLOAD_BYTES in capture-service/capture_service/config.py is
    // 209715200, exactly 200m. nginx must not be the layer that rejects a
    // legitimate recording first.
    const match = /client_max_body_size\s+(\d+)([km]?);/.exec(CAPTURE_CODE);
    expect(match, 'no client_max_body_size in the capture block').not.toBeNull();
    const value = Number(match?.[1]);
    const unit = match?.[2];
    const bytes =
      unit === 'k' ? value * 1024 : unit === 'm' ? value * 1024 * 1024 : value;
    expect(bytes).toBeGreaterThanOrEqual(209_715_200);
    // A 200 MiB body must not be spooled into the app container, which has no
    // volume for it.
    expect(CAPTURE_CODE).toContain('proxy_request_buffering off;');
  });

  it('waits long enough for a transcription plus a local extraction', () => {
    expect(CAPTURE_CODE).toContain('proxy_read_timeout 900s;');
    expect(CAPTURE_CODE).toContain('proxy_send_timeout 900s;');
  });
});

// ─── /api/capture/transcribe (T4.7) ────────────────────────────────────────

const TRANSCRIBE_HEADER = 'location = /api/capture/transcribe {';
const TRANSCRIBE_BLOCK = blockOf(APP_CONF_CODE, TRANSCRIBE_HEADER);
const TRANSCRIBE_CODE = flat(TRANSCRIBE_BLOCK);

describe('deploy/nginx/app.conf — /api/capture/transcribe', () => {
  it('exists, and appears ABOVE the /api/ block', () => {
    const transcribeAt = APP_CONF_CODE.indexOf(TRANSCRIBE_HEADER);
    const apiAt = APP_CONF_CODE.indexOf('location /api/ {');
    expect(transcribeAt).toBeGreaterThan(0);
    expect(transcribeAt).toBeLessThan(apiAt);
  });

  it('appears ABOVE /api/capture/local (both are exact-match, order is for readers)', () => {
    const transcribeAt = APP_CONF_CODE.indexOf(TRANSCRIBE_HEADER);
    const captureAt = APP_CONF_CODE.indexOf(CAPTURE_HEADER);
    expect(transcribeAt).toBeLessThan(captureAt);
  });

  it('is POST-only', () => {
    expect(TRANSCRIBE_CODE).toContain('limit_except POST { deny all; }');
  });

  it('resolves the upstream at request time through a VARIABLE, to the api', () => {
    expect(TRANSCRIBE_CODE).toContain('resolver 127.0.0.11');
    expect(TRANSCRIBE_CODE).toContain('set $transcribe_upstream http://api:8787;');
    expect(TRANSCRIBE_CODE).toMatch(/proxy_pass \$transcribe_upstream;/);
    // This is the path that used to make it impossible to choose a provider for
    // audio at all: nginx had already picked capture-service before the api saw
    // anything. It must not go back.
    expect(TRANSCRIBE_CODE).not.toContain('capture-service');
    expect(TRANSCRIBE_CODE).not.toMatch(/proxy_pass\s+http:\/\//);
  });

  it('does NOT add the capture-service secret — the api does that now', () => {
    expect(TRANSCRIBE_CODE).not.toContain('X-Capture-Token');
    expect(TRANSCRIBE_CODE).not.toContain('CAPTURE_SHARED_SECRET');
  });

  it('has a smaller body limit than /api/capture/local (chunks, not full meetings)', () => {
    const match = /client_max_body_size\s+(\d+)([km]?);/.exec(TRANSCRIBE_CODE);
    expect(match, 'no client_max_body_size in the transcribe block').not.toBeNull();
    const value = Number(match?.[1]);
    const unit = match?.[2];
    const bytes =
      unit === 'k' ? value * 1024 : unit === 'm' ? value * 1024 * 1024 : value;
    // 10m for a chunk; well under the 200m for a full meeting.
    expect(bytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    expect(bytes).toBeLessThan(209_715_200);
  });

  it('has shorter timeouts than /api/capture/local (Whisper only, no LLM)', () => {
    expect(TRANSCRIBE_CODE).toContain('proxy_read_timeout 120s;');
    expect(TRANSCRIBE_CODE).toContain('proxy_send_timeout 120s;');
  });
});

// ─── Substitution ───────────────────────────────────────────────────────────

describe('deploy/nginx/app.conf — envsubst surface', () => {
  it('has NO placeholder, because the secret it used to carry moved to the api', () => {
    // Matched against the RAW file, comments included: envsubst does not know what
    // a comment is, so every ${...} anywhere in here is substituted. This used to
    // assert exactly one — ${CAPTURE_SHARED_SECRET} — for the X-Capture-Token
    // header. Both capture paths now go to the api, which adds that header from its
    // own environment, so a placeholder here would render a secret into a config
    // that nothing reads.
    expect(APP_CONF.match(/\$\{[^}]*\}/g) ?? []).toEqual([]);
  });

  it('keeps using nginx runtime variables, which the filter must not eat', () => {
    for (const variable of [
      '$uri',
      '$host',
      '$proxy_add_x_forwarded_for',
      '$http_x_forwarded_proto',
    ]) {
      expect(APP_CONF_CODE).toContain(variable);
    }
  });
});

describe('deploy/app.Dockerfile — the template is rendered at start-up', () => {
  it('installs app.conf as a TEMPLATE, not as a finished conf.d file', () => {
    expect(DOCKERFILE).toContain(
      'COPY deploy/nginx/app.conf /etc/nginx/templates/default.conf.template',
    );
    // A conf.d copy would mean the secret had to be present at BUILD time, i.e.
    // baked into a layer and readable from `docker history`.
    expect(DOCKERFILE).not.toContain(
      'COPY deploy/nginx/app.conf /etc/nginx/conf.d/default.conf',
    );
  });

  it('restricts substitution to CAPTURE_* so nginx variables survive', () => {
    expect(DOCKERFILE).toContain('ENV NGINX_ENVSUBST_FILTER=^CAPTURE_');
  });

  it('no longer declares the capture secret, because nothing in app.conf reads it', () => {
    // The inverse of what this used to assert. Defining a credential in an image
    // whose config no longer references it is not neutral: it shows up in
    // `docker exec app env` and in the image's config, and invites the next person
    // to "fix" a capture problem by pointing nginx back at capture-service.
    expect(DOCKERFILE).not.toMatch(/ENV\s+CAPTURE_SHARED_SECRET/);
  });

  it('removes the base image default site', () => {
    expect(DOCKERFILE).toContain('RUN rm -f /etc/nginx/conf.d/default.conf');
  });
});

describe('docker-compose.yml — the capture routes are served by api', () => {
  it('gives app no environment at all, so the secret is not where nothing reads it', () => {
    // `app` is nginx serving a static build; the only variable it ever carried was
    // the capture secret for the header it no longer adds. capture-service and
    // whisper still take it, and they are the two services that check it.
    const app = COMPOSE.services.app;
    expect(app).toBeDefined();
    expect(app.environment).toBeUndefined();
  });

  it('tells api where the built-in stack is, so "Built-in" works for any capture.provider', () => {
    // lib/ai/router.ts reads CAPTURE_SERVICE_URL first and falls back to
    // capture.serviceUrl from viewpoint.config.ts. Without this, an install that
    // chose a cloud provider in install.sh and then picked "Built-in" for
    // transcription in the admin console would have no address to reach.
    const api = COMPOSE.services.api;
    expect(api.environment?.CAPTURE_SERVICE_URL).toBe(
      '${CAPTURE_SERVICE_URL:-http://capture-service:8080}',
    );
  });

  it('still gives capture-service and app no published port', () => {
    // The whole isolation argument in the compose header comment rests on this:
    // the browser reaches capture-service through `app` and `api`, never directly.
    expect(COMPOSE.services.app.ports).toBeUndefined();
    expect(COMPOSE.services.api.ports).toBeUndefined();
    expect(COMPOSE.services['capture-service'].ports).toBeUndefined();
    expect(COMPOSE.services.whisper.ports).toBeUndefined();
  });

  it('keeps api on the internal backend network where capture-service lives', () => {
    expect(COMPOSE.services.api.networks).toContain('backend');
    expect(COMPOSE.services.app.networks).toContain('backend');
    expect(COMPOSE.services['capture-service'].networks).toContain('backend');
  });
});

// ─── /api/capture/summary (BF) ─────────────────────────────────────────────
//
// The third AI job. Its own location exists for one reason — the generic /api/
// block's 300s read timeout would cut off a whole-meeting summary running on a
// small model on CPU, which is the exact configuration the built-in stack ships.

describe('deploy/nginx/app.conf — /api/capture/summary', () => {
  const SUMMARY_HEADER = 'location = /api/capture/summary {';
  const SUMMARY_CODE = flat(blockOf(APP_CONF_CODE, SUMMARY_HEADER));

  it('exists, above the /api/ block that would otherwise answer it', () => {
    const summaryAt = APP_CONF_CODE.indexOf(SUMMARY_HEADER);
    const apiAt = APP_CONF_CODE.indexOf('location /api/ {');
    expect(summaryAt).toBeGreaterThan(0);
    expect(apiAt).toBeGreaterThan(0);
    expect(summaryAt).toBeLessThan(apiAt);
  });

  it('is POST-only, goes to the api, and carries no secret', () => {
    expect(SUMMARY_CODE).toContain('limit_except POST { deny all; }');
    expect(SUMMARY_CODE).toContain('set $summary_upstream http://api:8787;');
    expect(SUMMARY_CODE).toMatch(/proxy_pass \$summary_upstream;/);
    expect(SUMMARY_CODE).not.toContain('X-Capture-Token');
  });

  it('waits as long as /api/capture/local, not as long as a poll', () => {
    expect(SUMMARY_CODE).toContain('proxy_read_timeout 900s;');
    expect(SUMMARY_CODE).toContain('proxy_send_timeout 900s;');
  });

  it('carries no audio, so it gets the small body limit', () => {
    const match = /client_max_body_size\s+(\d+)([km]?);/.exec(SUMMARY_CODE);
    expect(match, 'no client_max_body_size in the summary block').not.toBeNull();
    const bytes =
      match?.[2] === 'k'
        ? Number(match?.[1]) * 1024
        : match?.[2] === 'm'
          ? Number(match?.[1]) * 1024 * 1024
          : Number(match?.[1]);
    expect(bytes).toBeLessThan(209_715_200);
  });
});

// ─── The access-check subrequest ────────────────────────────────────────────
//
// Every capture location is held to the front-door password through
// `auth_request /_access_check`. That subrequest broke whole-meeting captures
// the day it landed, in a way no small test caught.

describe('deploy/nginx/app.conf — /_access_check', () => {
  const ACCESS_CHECK = flat(blockOf(APP_CONF_CODE, 'location = /_access_check {'));

  it('does not apply a body-size limit to a body it never forwards', () => {
    // nginx checks the PARENT request's declared size against the SUBREQUEST
    // location's client_max_body_size, and `proxy_pass_request_body off` does
    // not exempt it. With the 1m default, posting a recording gave:
    //   "client intended to send too large body ... subrequest /_access_check"
    //   "auth request unexpected status: 413"
    // which nginx reports to the browser as a 500. Live-transcript chunks are
    // ~200 KB so they kept working, and only longer meetings failed — it read
    // as an intermittent capture bug (found 2026-09-23).
    expect(ACCESS_CHECK).toContain('client_max_body_size 0;');
  });

  it('is internal, and never forwards the request body', () => {
    expect(ACCESS_CHECK).toContain('internal;');
    expect(ACCESS_CHECK).toContain('proxy_pass_request_body off;');
  });

  it.each([
    'location = /api/capture/local {',
    'location = /api/capture/transcribe {',
    'location = /api/capture/summary {',
  ])('guards %s', (header) => {
    // Still worth asserting even though the api now enforces the same rule itself:
    // this is the door that refuses a 200 MiB upload BEFORE it is forwarded.
    expect(flat(blockOf(APP_CONF_CODE, header))).toContain('auth_request /_access_check;');
  });
});
