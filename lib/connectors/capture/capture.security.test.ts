// Credential-isolation tests for the AI capture path (T4.5/T4.6, re-pointed by
// plan 14 batch BF).
//
// The rule from docs/plan/02-connector-adapters.md §2 is absolute: "API key
// server-side only … never call these directly from the browser with a key".
// The runtime tests assert what the providers SEND; these assert what the
// browser-reachable modules CONTAIN, so a future contributor cannot add a key
// parameter, an env read or an Authorization header without a red test.
//
// Same approach as lib/connectors/turn/__tests__/turn-bundle.test.ts and
// lib/connectors/plm/teamcenter.security.test.ts: scan committed source.
//
// WHAT MOVED. The keyholder used to be api/capture/extract.ts, and
// capture-service's shared secret lived in api/capture/_proxyShared.ts. Batch BF
// deleted _proxyShared.ts and put BOTH behind lib/ai/router.ts, which now makes
// every upstream call the app makes; keys AT REST moved to lib/ai/settingsStore.ts
// and lib/ai/secretBox.ts. So the two server-side describe blocks below were
// re-pointed at those files rather than dropped, and every property they asserted
// is still asserted — against the module that now holds the secret:
//
//   * the credential is read from process.env (or from the encrypted store);
//   * it is sent only in an upstream request header, and only when one is set;
//   * it is never interpolated into a `res.…` statement, nor is a serviceUrl,
//     upstream text or an `err.message`;
//   * nothing unbounded reaches a log line.
//
// The endpoints keep the response-side half of that contract, so they are still
// scanned: api/capture/extract.ts writes the body, and sendJobError in
// api/capture/_request.ts is the only thing that turns a router failure into one.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Modules the Vite client bundle can reach. None of them may touch a key. */
const BROWSER_MODULES = [
  'lib/connectors/capture/types.ts',
  'lib/connectors/capture/mock.ts',
  'lib/connectors/capture/extractionPrompt.ts',
  'lib/connectors/capture/parseInsightCards.ts',
  'lib/connectors/capture/extractClient.ts',
  'lib/connectors/capture/openai.ts',
  'lib/connectors/capture/anthropic.ts',
  'lib/connectors/capture/ollamaDirect.ts',
  // T4.4: the recording provider. Same rule, different secret — the browser must
  // never hold capture-service's shared token, so this module may not read an env
  // var or set an auth header either.
  'lib/connectors/capture/local.ts',
  'lib/useMeetingRecorder.ts',
];

/**
 * The AI modules the admin console's browser half imports (plan 14, BF).
 *
 * Same rule as BROWSER_MODULES with ONE deliberate difference: these MAY contain
 * the identifier `apiKey`, because lib/ai/providers.ts describes an admin FORM
 * FIELD of that name — the password input an administrator pastes a key into,
 * whose label, placeholder and help text all have to reach the browser for the
 * form to render. The NAME of a field is not a credential. That is why these get
 * their own describe block instead of joining BROWSER_MODULES, whose assertions
 * forbid the word outright: adding them there would either fail on a form label
 * or force that block to allow `apiKey` everywhere, which is the weaker rule.
 *
 * Everything else is asserted just as strictly, and the assertion that matters
 * most is the import one: none of these may import ./router, ./settingsStore or
 * ./secretBox, because those are the modules that read a credential and hold the
 * encryption key, and an import is what would pull them into the bundle.
 */
const AI_BROWSER_MODULES = [
  'lib/ai/providers.ts',
  'lib/ai/webhookContract.ts',
  'lib/ai/summaryPrompt.ts',
];

/** Writes the response, so it is where an echo would happen. */
const SERVER_MODULE = 'api/capture/extract.ts';

/** The shared request helpers, including sendJobError — the only thing that turns a router failure into a body. */
const REQUEST_MODULE = 'api/capture/_request.ts';

/** The one module allowed to hold a credential and call an upstream. */
const ROUTER_MODULE = 'lib/ai/router.ts';

/** Keys at rest: the encrypted column, and the box that seals it. */
const SETTINGS_STORE_MODULE = 'lib/ai/settingsStore.ts';
const SECRET_BOX_MODULE = 'lib/ai/secretBox.ts';

function read(relativePath: string): string {
  return readFileSync(join(__dirname, '..', '..', '..', relativePath), 'utf8');
}

/**
 * Removes comments before scanning: these modules deliberately SAY "no apiKey
 * option", "no process.env", and naming the pattern in prose is the point of
 * the comment. Only code should be able to fail these assertions.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // The [^:] guard keeps `https://…` inside string literals from matching.
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Non-empty, trimmed lines of code — for the per-line assertions below. */
function lines(relativePath: string): string[] {
  return code(read(relativePath))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

describe('capture credential isolation — browser modules', () => {
  it.each(BROWSER_MODULES)('%s never reads an environment variable', (file) => {
    const source = code(read(file));
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
  });

  it.each(BROWSER_MODULES)('%s never mentions an API key', (file) => {
    const source = code(read(file));
    // Identifier spellings only. The English phrase "API key" is allowed —
    // these modules have to be able to SAY "there is no API key here".
    expect(source).not.toMatch(/apiKey|api_key|x-api-key/i);
    expect(source).not.toMatch(/bearer/i);
    expect(source).not.toMatch(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  });

  it.each(BROWSER_MODULES)('%s never sets an auth header', (file) => {
    const source = code(read(file));
    expect(source).not.toMatch(/authorization/i);
  });

  it.each(BROWSER_MODULES)('%s never names a VITE_ variable', (file) => {
    // Redundant with scripts/check-public-env.mjs for secret-shaped names, but
    // this catches a plain VITE_ read too, and it fails with the file named.
    expect(code(read(file))).not.toMatch(/VITE_[A-Z0-9_]+/);
  });

  it.each(BROWSER_MODULES)('%s does not import the server-side handler', (file) => {
    const source = code(read(file));
    expect(source).not.toMatch(/from\s+['"][^'"]*\bapi\/capture\//);
    expect(source).not.toMatch(/import\s*\(\s*['"][^'"]*\bapi\/capture\//);
  });

  it('the cloud clients address a same-origin relative endpoint only', () => {
    const client = code(read('lib/connectors/capture/extractClient.ts'));
    expect(client).toContain("'/api/capture/extract'");
    expect(client).not.toMatch(/https:\/\/api\.(openai|anthropic)\.com/);
  });

  it('the two cloud providers contain no vendor URL at all', () => {
    // The browser must not even know which host holds the key.
    for (const file of ['lib/connectors/capture/openai.ts', 'lib/connectors/capture/anthropic.ts']) {
      expect(code(read(file))).not.toMatch(/https?:\/\//);
    }
  });

  it('the browser client no longer names a provider, in a request or in a message', () => {
    // Which AI answered is not the browser's business. A `provider` field in the
    // request would be a second place the decision is made, and a vendor name in
    // an error message would be a claim this module cannot verify.
    const client = code(read('lib/connectors/capture/extractClient.ts'));
    expect(client).toContain('JSON.stringify({ transcript, context })');
    expect(client).not.toMatch(/provider\s*:/);
    expect(client).not.toMatch(/api\.(openai|anthropic)\.com/i);
    expect(client).toContain("const WHERE = 'capture/extract'");
  });

  it('ollamaDirect has no credential because the mode has none', () => {
    const source = code(read('lib/connectors/capture/ollamaDirect.ts'));
    // It talks straight to the LAN host from config, never through our proxy,
    // so there is no server-side keyholder in this path at all.
    expect(source).not.toContain('/api/capture/extract');
    expect(source).toContain('/api/chat');
  });
});

describe('AI credential isolation — the browser-safe AI modules', () => {
  it.each(AI_BROWSER_MODULES)('%s never reads an environment variable', (file) => {
    // A process.env read here would be a credential the bundle can reach, and an
    // import.meta.env read would be one Vite inlines at build time — which is
    // worse, because it lands in the shipped JS whether or not anyone reads it.
    const source = code(read(file));
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/import\s*\.\s*meta\s*\.\s*env/);
    expect(source).not.toMatch(/VITE_[A-Z0-9_]+/);
  });

  it.each(AI_BROWSER_MODULES)('%s never names the encryption key', (file) => {
    // JWT_SECRET is the input material lib/ai/secretBox.ts derives the settings
    // encryption key from. A browser module that so much as mentions the name is
    // a browser module somebody intended to read it.
    expect(code(read(file))).not.toMatch(/JWT_SECRET/);
  });

  it.each(AI_BROWSER_MODULES)('%s does not import a module that holds a credential', (file) => {
    // THIS is the assertion that keeps the encryption key and the
    // credential-reading function out of the bundle. router.ts makes the
    // upstream calls, settingsStore.ts opens the sealed column and secretBox.ts
    // derives the key; an import of any of them — static or dynamic — drags the
    // whole chain, including node:crypto, into the client build.
    const source = code(read(file));
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"][^'"]*(router|settingsStore|secretBox)/);
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"][^'"]*\bapi\//);
    expect(source).not.toMatch(/['"]node:/);
  });

  it.each(AI_BROWSER_MODULES)('%s never sets an auth header value', (file) => {
    // `Bearer` and `Authorization` have no legitimate business in a form
    // descriptor or a prompt builder. (lib/ai/providers.ts does carry the string
    // 'X-Api-Key' — as the PLACEHOLDER of the webhook provider's header-name
    // field, i.e. an example of what an administrator might type. That is a
    // label, not a header this module sets, so it is asserted separately below.)
    const source = code(read(file));
    expect(source).not.toMatch(/authorization/i);
    expect(source).not.toMatch(/Bearer/);
  });

  it('the webhook contract and the summary prompt contain no URL at all', () => {
    // Neither module has any reason to name a host: the webhook's URL is a stored
    // setting and the summary prompt is prose. A scheme here would be an upstream
    // address baked into the bundle.
    for (const file of ['lib/ai/webhookContract.ts', 'lib/ai/summaryPrompt.ts']) {
      expect(code(read(file))).not.toMatch(/https?:\/\//);
    }
  });

  it('providers.ts carries no upstream URL — only form placeholders', () => {
    const source = code(read('lib/ai/providers.ts'));
    // The three URLs in this file are the examples an administrator reads while
    // filling a form in (`https://contoso.openai.azure.com`,
    // `https://gateway.acme.com/v1`, `https://ai.acme.com/viewpoint`), each on a
    // `placeholder:` line. Blank those and there is no scheme left anywhere in
    // the module, so the bundle still cannot learn which host holds the key.
    const withoutPlaceholders = source.replace(/placeholder:\s*'[^']*'/g, "placeholder: ''");
    expect(withoutPlaceholders).not.toMatch(/https?:\/\//);
    // The one identifier this block allows, and the reason it has its own block:
    // `apiKey` is the NAME of a password field, not a value.
    expect(source).toContain("name: 'apiKey'");
    expect(source).toContain("kind: 'password'");
  });

  it.each(AI_BROWSER_MODULES)('%s never names a vendor API host', (file) => {
    // The hosts lib/ai/router.ts calls. If one of them appears in a module the
    // browser imports, the bundle knows where the deployment's AI lives and a
    // future contributor is one fetch away from calling it directly.
    const source = code(read(file));
    expect(source).not.toMatch(/api\.openai\.com/);
    expect(source).not.toMatch(/api\.anthropic\.com/);
    expect(source).not.toMatch(/generativelanguage\.googleapis\.com/);
    expect(source).not.toMatch(/openai\.azure\.com\/openai/);
  });

  it('the webhook contract never echoes a response body into a reason', () => {
    // Rule 2 of that module's own header: a webhook's error text can quote the
    // request, which contains the transcript. The reasons it hands back are an
    // enum from our own vocabulary, so an admin screen can show one.
    const source = code(read('lib/ai/webhookContract.ts'));
    expect(source).toContain("'not_json'");
    expect(source).toContain("'bad_cards'");
    expect(source).toContain("'bad_summary'");
    expect(source).toContain("'bad_segments'");
    // The refusal carries a reason and, at most, the strict parser's own enum —
    // never `err.message`, which quotes the payload it rejected.
    expect(source).not.toMatch(/\.message/);
  });
});

describe('capture credential isolation — the endpoints that write the response', () => {
  it('the extraction endpoint holds no credential at all any more', () => {
    // Stronger than the property this block used to assert. The keyholder moved
    // to lib/ai/router.ts, so api/capture/extract.ts must now contain no env
    // read, no key, no vendor URL and no auth header: there is nothing in it to
    // leak, which is the only durable guarantee against a future edit adding a
    // `res.json({ debug: apiKey })`.
    const source = code(read(SERVER_MODULE));
    expect(source).not.toMatch(/process\s*\.\s*env/);
    expect(source).not.toMatch(/apiKey|api_key/i);
    expect(source).not.toMatch(/authorization|bearer/i);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    // It hands the whole try block to the router and the whole catch to
    // sendJobError, so there is exactly one place a failure becomes a body.
    expect(source).toContain("sendJobError(res, err, 'extract')");
  });

  it.each([SERVER_MODULE, REQUEST_MODULE])(
    '%s never interpolates a value into a response',
    (file) => {
      const source = code(read(file));
      // Every statement that writes to the response. Error CODE strings are
      // allowed to contain words like "transcript" (that is what
      // 'empty_transcript' is); the transcript VARIABLE, the request, the
      // upstream body, a credential and any err.message are not. `jobError.reason`
      // is allowed because it is an enum from the parser's closed vocabulary,
      // while a parser message quotes the model output, which quotes the
      // transcript. The runtime leak tests in extractEndpoint.test.ts assert the
      // same property on actual response bodies.
      const responses = source.match(/\bres\s*\.[^;]*;/g) ?? [];
      // extract.ts writes a body on every validation and success path; _request.ts
      // writes four (the gate, the two readCaptureBody failures and sendJobError).
      // The bound is what proves the regex below is actually looking at something.
      expect(responses.length).toBeGreaterThan(3);
      for (const statement of responses) {
        expect(statement).not.toMatch(/apiKey|apiKeyEnv/);
        expect(statement).not.toMatch(/upstreamBody/);
        expect(statement).not.toMatch(/userPrompt/);
        expect(statement).not.toMatch(/\.message/);
        expect(statement).not.toMatch(/\bsecret\b/i);
        expect(statement).not.toMatch(/serviceUrl/);
        expect(statement).not.toMatch(/\breq\b/);
        // The word `transcript` may appear only as the NAME of a rejected field
        // (`fields: ['transcript']`), never as a value: naming the field is what
        // tells a client which key to fix, and echoing the value would echo the
        // meeting.
        expect(statement.replace(/'transcript'/g, '')).not.toMatch(/\btranscript\b/);
      }
    },
  );

  it('sendJobError answers from the closed vocabulary and nothing else', () => {
    const source = code(read(REQUEST_MODULE));
    // A code, an optional parser reason enum, and the numeric extras the router
    // explicitly marked safe. There is no fourth channel, which is what makes it
    // safe to hand this function an error it did not construct.
    expect(source).toContain('error: jobError.code');
    expect(source).toContain('body.reason = jobError.reason');
    expect(source).toContain('Object.entries(jobError.extras)');
    // The provider that answered is NOT in the body: which AI a deployment
    // resolved is the admin console's answer to give, not a field a browser can
    // depend on.
    expect(source).not.toMatch(/body\.provider/);
    // A client hang-up is logged by code only. An abort that surfaces as some
    // other error type carries a stack, and a stack can quote the request.
    expect(source).toContain('the client disconnected');
  });

  it('the access gate runs before the body is read', () => {
    // These routes spend something and attach the deployment's own credential
    // for every caller, so an unadmitted caller must not get as far as a
    // validation error that describes what they sent.
    const source = code(read(SERVER_MODULE));
    expect(source).toContain('if (!enforceCaptureAccess(req, res)) return;');

    // Ordered from the handler, not from the top of the file: the import list
    // names both functions before either is called.
    const handler = source.indexOf('export async function handler');
    expect(handler).toBeGreaterThan(-1);
    const gate = source.indexOf('enforceCaptureAccess', handler);
    const body = source.indexOf('const body =', handler);
    expect(gate).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body);

    // HEAD is gated too: the probe reports whether this deployment has a working
    // AI behind it, which is worth a password. And it answers from the resolution
    // alone, so the gate has to come first there as well.
    const head = source.indexOf("req.method === 'HEAD'", handler);
    expect(head).toBeGreaterThan(-1);
    const probeGate = source.indexOf('enforceCaptureAccess', head);
    const resolution = source.indexOf('describeResolution(', head);
    expect(probeGate).toBeGreaterThan(head);
    expect(resolution).toBeGreaterThan(head);
    expect(probeGate).toBeLessThan(resolution);
  });
});

describe('AI credential isolation — lib/ai/router.ts is the only keyholder', () => {
  it('reads the credential from the environment, by the configured name', () => {
    const source = code(read(ROUTER_MODULE));
    // `env` is always `options.env ?? process.env`, so the key comes from this
    // container's own environment and there is no default credential anywhere.
    expect(source).toMatch(/process\.env as Record<string, string \| undefined>/);
    expect(source).toContain('env[capture.apiKeyEnv] ?? null');
    // capture-service's shared secret, via the constant lib/health/probes.ts
    // exports so the name stays pinned in one place and capture-service's parity
    // test still covers it.
    expect(source).toContain('CAPTURE_SHARED_SECRET_ENV');
    expect(source).toContain('env[CAPTURE_SHARED_SECRET_ENV]');
    // A stored key comes from the encrypted column, through the one function
    // whose name says what it does.
    expect(source).toContain('openSettingSecret(key, storeOptions)');
  });

  it('sends a credential only in an upstream request header', () => {
    const source = code(read(ROUTER_MODULE));
    expect(source).toContain('Authorization: `Bearer ${requireSecret(job)}`');
    expect(source).toContain("'x-api-key': requireSecret(job)");
    expect(source).toContain("'api-key': requireSecret(job)");
    expect(source).toContain("'x-goog-api-key': requireSecret(job)");
    expect(source).toContain('headers[CAPTURE_AUTH_HEADER] = secret');

    // And that is EVERY use. Each line that touches a resolved credential must
    // be a header assignment or requireSecret's own guard: a credential that
    // turned up in a URL would be in every access log, proxy log and error
    // message between here and the provider, and one that turned up in a thrown
    // message would be one careless `err.message` away from a browser.
    const credentialLines = lines(ROUTER_MODULE).filter((line) =>
      /requireSecret\(job\)|job\.secret/.test(line),
    );
    expect(credentialLines.length).toBeGreaterThan(8);
    for (const line of credentialLines) {
      expect(line, `credential outside a header: ${line}`).toMatch(
        // The last two alternatives are not loopholes, they are the two other
        // legitimate things a resolved credential is for:
        //   * `return [job.secret, …]` is redactionList handing the credential to
        //     logExcerpt so it can be STRUCK from upstream text before that text is
        //     logged. A vendor echoes a bad key back in its 401 body, so this is the
        //     line that keeps our own key out of our own log.
        //   * `secrets` is that list arriving at logExcerpt's parameter.
        /Authorization\s*:|'[a-z-]*api-key'\s*:|headers\[|job\.secret\s*&&|job\.secret\s*\?|return \[job\.secret|secrets: Array<string \| null \| undefined>/,
      );
    }
    // A credential inside a URL literal is the specific mistake this rules out:
    // it would land in every access log, proxy log and error message between here
    // and the provider. (Gemini accepts a key as a query parameter, which is why
    // the assertion is worth making rather than assuming.)
    expect(source).not.toMatch(/https?:\/\/[^`\n]*\$\{[^}\n]*(secret|requireSecret)/i);
  });

  it('sends a credential only when one is configured', () => {
    const source = code(read(ROUTER_MODULE));
    // An empty shared secret means capture-service has authentication off, so the
    // header is omitted rather than sent empty — an empty header is rejected as a
    // bad token rather than read as "authentication off".
    expect(source).toContain("if (secret.trim() !== '') headers[CAPTURE_AUTH_HEADER] = secret;");
    // A webhook header needs both halves: a name with no value would send an
    // empty credential, and a value with no name has nowhere to go.
    expect(source).toContain('if (name && job.secret) headers[name] = job.secret;');
    // An OpenAI-compatible gateway on a private network authenticates by address,
    // so its key is optional and the header is built conditionally.
    expect(source).toContain('job.secret ? { Authorization: `Bearer ${job.secret}` } : {}');
    // A provider that needs a credential and has none is refused HERE, with a
    // code, rather than sent unauthenticated and reported as an upstream 401
    // whose body would be logged.
    expect(source).toContain("throw new AiJobError('capture_not_configured', 503, job.provider");
  });

  it('cannot write a response at all', () => {
    // The structural guarantee behind every assertion in this block: the module
    // that holds the credential is not a module that can put one in a body. Only
    // the endpoints write responses, and they are scanned above.
    expect(code(read(ROUTER_MODULE))).not.toMatch(/\bres\s*\./);
  });

  it('logs upstream text only as a bounded, whitespace-flattened, redacted excerpt', () => {
    const source = code(read(ROUTER_MODULE));
    expect(source).toContain('const MAX_LOG_EXCERPT = 300;');
    expect(source).toContain('flat.slice(0, MAX_LOG_EXCERPT)');
    // Flattening is not cosmetic: a value containing newlines could otherwise
    // forge extra log lines, and an upstream body is exactly where such a value
    // would come from.
    expect(source).toContain("redacted.split(/\\s+/).join(' ')");
    // Redaction happens BEFORE the bound, and that order is the point: bounding
    // first would let a key that appears late in a long body survive the cut, and
    // flattening first would let a key split across a newline survive the match.
    // The credential being struck is ours — a vendor's 401 for a bad key reads
    // "Incorrect API key provided: sk-…", i.e. it echoes what we sent.
    expect(source).toContain("redacted.split(value).join('<redacted>')");
    expect(source.indexOf("redacted.split(value).join('<redacted>')")).toBeLessThan(
      source.indexOf("redacted.split(/\\s+/).join(' ')"),
    );
    // The excerpt is the ONLY route by which upstream text reaches a log, and it
    // is a log and never a response: logExcerpt has no return value.
    expect(source).toMatch(
      /function logExcerpt\(\s*where: string,\s*text: string,\s*secrets: Array<string \| null \| undefined> = \[\],\s*\): void/,
    );
    expect(source).toContain(
      'logExcerpt(`${job.provider} ${where} returned ${response.status}`, text, redactionList(job, options))',
    );
  });

  it('never puts a credential in a log line', () => {
    // lib/ai/router.ts does not build a logged string out of a credential in the
    // first place, so the property to assert is that every console call site is
    // free of them.
    //
    // The three sites that report OUR bugs (the settings-read, the secret-open and
    // asAiJobError's fallback) render the thrown value through boundedError(),
    // which caps it at MAX_ERROR_EXCERPT. Bounded rather than dropped, because a
    // stack trace is the useful part of an unexpected error; capped because an
    // upstream client that throws `new Error(JSON.stringify(payload))` would
    // otherwise put the meeting in the log.
    const source = code(read(ROUTER_MODULE));
    expect(source).toContain('const MAX_ERROR_EXCERPT = 2000;');
    expect(source).toContain('text.length <= MAX_ERROR_EXCERPT');
    // No console call site passes a raw thrown value any more.
    expect(source).not.toMatch(/console\.error\([^)]*,\s*err\s*\)/);

    const consoleLines = lines(ROUTER_MODULE).filter((line) => /console\./.test(line));
    expect(consoleLines.length).toBeGreaterThan(3);
    for (const line of consoleLines) {
      expect(line, `credential in a log line: ${line}`).not.toMatch(
        // `apiKey(?!Env)`: the config field `capture.apiKeyEnv` holds a VARIABLE
        // NAME, and naming the variable an operator has to go and set is the whole
        // point of that log line — install.sh writes the same name into
        // viewpoint.config.ts in this container. A field that holds a name is not a
        // credential; a field that holds a key is, and it is `apiKey` bare.
        /requireSecret|job\.secret|apiKey(?!Env)|Bearer|x-api-key|api-key|CAPTURE_SHARED_SECRET/,
      );
      // A forwarded message is the leak this guards: AiJobError's message is ours
      // by construction, but a parser's or a provider's quotes what it rejected.
      expect(line).not.toMatch(/\.message/);
    }
  });

  it('builds a thrown message out of its own vocabulary only', () => {
    const source = code(read(ROUTER_MODULE));
    // `ai/<provider>: <code> (<note>)` — a provider id, a code from the closed
    // vocabulary, and at most a note this module wrote itself. No transcript, no
    // upstream text, no credential, which is what makes it safe for sendJobError
    // to log the message and safe for a future endpoint to forward it.
    expect(source).toMatch(/super\(`ai\/\$\{provider\}: \$\{code\}/);
    // The reason a parse failure reports is the parser's enum, never its message.
    expect(source).toContain('if (err instanceof CaptureExtractionError)');
    expect(source).toContain('reason: err.reason');
  });

  it('refuses a stored URL that is not an absolute http(s) one', () => {
    // A setting can have been written by an older version, by a script or by an
    // operator with a SQL client, and `fetch('file:///etc/passwd')` from a
    // container is not a hypothetical.
    const source = code(read(ROUTER_MODULE));
    expect(source).toContain("parsed.protocol !== 'http:' && parsed.protocol !== 'https:'");
    expect(source).toContain('function requireHttpUrl(job: ResolvedJob, name: string): string');
  });
});

describe('AI credential isolation — keys at rest', () => {
  it('secretBox refuses to run outside Node and exports a greppable marker', () => {
    const source = read(SECRET_BOX_MODULE);
    // Same shape as api/_lib/serviceRole.ts: a module-level guard that throws on
    // import in a browser, plus a marker string a build test greps dist/ for to
    // prove the module was tree-shaken out. If the string appears in a bundle,
    // the ability to read every stored credential shipped with it.
    expect(source).toMatch(/if \(typeof process === 'undefined' \|\| !process\.versions\.node\)/);
    expect(source).toContain('throw new Error(');
    expect(source).toContain("export const _SECRET_BOX_MARKER = '__SECRET_BOX_SERVER_ONLY__';");
  });

  it('secretBox fails closed and never echoes its input', () => {
    const source = code(read(SECRET_BOX_MODULE));
    // Deriving a key from an empty string would produce a key that is the same on
    // every unconfigured install — i.e. a public key — and would look like
    // working encryption right up to the moment the database leaked.
    expect(source).toContain("throw new SecretBoxError('no_secret_configured')");
    // The message names a reason and nothing else: for decryptSecret the input is
    // a database row and for encryptSecret it is a live API key, and either would
    // end up in a server log.
    expect(source).toMatch(/super\(`secretBox: \$\{reason\}`\)/);
    expect(source).not.toMatch(/console\./);
    // The derived key is separated from the JWT-signing use of the same material,
    // so leaking one says nothing about the other.
    expect(source).toContain("hkdfSync('sha256'");
    expect(source).toContain('SECRET_BOX_INFO');
  });

  it('settingsStore is server-only by import, and cannot write a response', () => {
    const source = code(read(SETTINGS_STORE_MODULE));
    // settingsStore.ts has no guard or marker of its own, so the property that
    // keeps it out of a browser is that BOTH of its secret-touching imports throw
    // on import outside Node: api/_lib/serviceRole.ts (which signs a service-role
    // JWT) and lib/ai/secretBox.ts (which derives the encryption key). Importing
    // this module from client code therefore cannot succeed — though note there
    // is no settingsStore marker for a build test to grep dist/ for, only
    // secretBox's.
    expect(source).toContain("from '../../api/_lib/serviceRole.ts'");
    expect(source).toContain("from './secretBox.ts'");
    expect(source).not.toMatch(/\bres\s*\./);
    expect(source).not.toMatch(/https?:\/\/[^']*\$\{/);
  });

  it('settingsStore reports a stored credential and never returns it', () => {
    const source = code(read(SETTINGS_STORE_MODULE));
    // Rule 1 of that module's own header. `readSetting` answers
    // `{ set, last4, unreadable }`, so there is no code path by which
    // /api/admin/ai can put a key in a response body; the plaintext comes from
    // `openSettingSecret`, a separate function whose name says what it does and
    // whose result must never be serialised.
    expect(source).toContain('secret: statusOf(ciphertextOf(row))');
    expect(source).toContain('unreadable');
    expect(source).toContain('last4: secretTail(decryptSecret(ciphertext))');
    // Exactly two calls to decryptSecret: the tail above, and openSettingSecret.
    const decrypts = source.match(/decryptSecret\(/g) ?? [];
    expect(decrypts).toHaveLength(2);
    expect(source).toContain('return decryptSecret(ciphertext);');
  });

  it('settingsStore refuses to store a secret it cannot seal', () => {
    const source = code(read(SETTINGS_STORE_MODULE));
    // No JWT_SECRET means nothing can be sealed, and a plaintext credential in a
    // database that is backed up is worse than a save that failed.
    expect(source).toContain('ciphertext = encryptSecret(input.secret.trim())');
    expect(source).toContain('refusing to store a secret with no encryption key');
    // A form that always sends its inputs cannot silently re-encrypt '' over a
    // real key: an empty string clears the column rather than sealing it.
    expect(source).toContain("input.secret.trim() === ''");
    // Deleting asks for nothing back, which is what stops PostgREST echoing the
    // row it just deleted — the row that carries the ciphertext.
    expect(source).toContain("headers: { Prefer: 'return=minimal' }");
  });

  it('settingsStore never logs a credential or an echoed row', () => {
    for (const line of lines(SETTINGS_STORE_MODULE).filter((l) => /console\./.test(l))) {
      expect(line, `credential in a log line: ${line}`).not.toMatch(
        /ciphertext|plaintext|decryptSecret|encryptSecret|input\.secret|\.message/,
      );
      // The only interpolation allowed is a status code. A refused write's BODY
      // is never read at all: PostgREST echoes the row it refused, and that row
      // carries the ciphertext.
      expect(line).not.toMatch(/\$\{(?!\s*response\.status\s*\})/);
    }
  });

  it('the settings store is unavailable rather than fatal when no token can be minted', () => {
    const source = code(read(SETTINGS_STORE_MODULE));
    // No JWT_SECRET means no service-role token means no privileged database
    // access at all. Every reader treats that as "use the configured default", so
    // an installation that has never opened the admin console's AI section
    // behaves exactly as it did before the table existed. This is also why
    // extractEndpoint.test.ts leaves JWT_SECRET unset and needs no store mocking.
    expect(source).toContain('getServiceRoleToken()');
    expect(source).toContain('no service-role token; the settings store is unavailable');
    expect(source).toMatch(/if \(!token\)/);
    // A store that cannot be reached is not an error either: fetch's own message
    // is dropped because it embeds the URL, which on a self-hosted install is an
    // internal container name.
    expect(source).toContain('could not reach the settings store');
  });
});
