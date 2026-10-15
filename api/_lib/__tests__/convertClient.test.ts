// @vitest-environment node
//
// The api's half of the contract convert-service's own tests pin on its side:
// the two request header names, the one route, the failure codes, and the rule
// that nothing but a code ever comes back out. What is NOT here is a real
// conversion — that is convert-service/tests/test_conversion.py's job, in an
// image with OpenCascade in it.
//
// fetch is injected rather than stubbed globally, because a stubbed global fetch
// in this repo would also intercept the requests a test makes of the api itself.

import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  CONVERT_AUTH_HEADER,
  CONVERT_BAD_RESPONSE,
  CONVERT_CLIENT_TIMEOUT,
  CONVERT_ERROR,
  CONVERT_FILE_NAME_HEADER,
  CONVERT_MS_HEADER,
  CONVERT_PART_COUNT_HEADER,
  CONVERT_REQUEST_TIMEOUT_MS,
  CONVERT_SERVICE_URL_ENV,
  CONVERT_SHARED_SECRET_ENV,
  CONVERT_TRIANGLE_COUNT_HEADER,
  CONVERT_UNREACHABLE,
  ConvertFailure,
  convertHeaders,
  convertToGlb,
  headerSafeFileName,
  resolveConvertTarget,
} from '../convertClient.ts';

const SERVICE = 'http://convert-service:8080';
const SECRET = 'convert-FAKE-shared-secret';
const TARGET = { url: SERVICE, secret: SECRET };

/** A stand-in for the GLB convert-service answers with: magic, version, padding. */
const GLB = Buffer.concat([
  Buffer.from('glTF', 'ascii'),
  Buffer.from([0x02, 0x00, 0x00, 0x00]),
  Buffer.alloc(16, 0x21),
]);

const STEP = Buffer.from('ISO-10303-21;\nHEADER;\n', 'ascii');
// ASCII, so the assertions below read as the value on the wire. A name a header
// cannot carry has its own test under convertHeaders.
const STEP_NAME = 'bracket-rev-b.step';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

/** A convert-service that answers `response` and records what it was sent. */
function fakeService(response: () => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? Buffer.from(init.body as Uint8Array) : null,
    });
    return response();
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function okResponse(): Response {
  return new Response(new Uint8Array(GLB), {
    status: 200,
    headers: {
      'Content-Type': 'model/gltf-binary',
      [CONVERT_PART_COUNT_HEADER]: '9',
      [CONVERT_TRIANGLE_COUNT_HEADER]: '636',
      [CONVERT_MS_HEADER]: '2700',
    },
  });
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Every failure convert_service/errors.py defines, with the status it uses. */
const SERVICE_FAILURES: Array<[number, string]> = [
  [400, 'empty_upload'],
  [401, 'unauthorized'],
  [413, 'upload_too_large'],
  [415, 'unsupported_format'],
  [422, 'convert_unreadable'],
  [422, 'convert_empty'],
  [500, 'convert_crashed'],
  [500, 'internal_error'],
  [503, 'engine_unavailable'],
  [504, 'convert_timeout'],
];

describe('resolveConvertTarget', () => {
  it('is null when CONVERT_SERVICE_URL is unset, which is the default', () => {
    // The whole of a Vercel deployment's experience, and of any install that never
    // built the image: no address, no conversion, and nothing else changed.
    expect(resolveConvertTarget({})).toBeNull();
    expect(resolveConvertTarget({ [CONVERT_SERVICE_URL_ENV]: '' })).toBeNull();
    expect(resolveConvertTarget({ [CONVERT_SERVICE_URL_ENV]: '   ' })).toBeNull();
  });

  it('reads the address and the secret from the two documented variables', () => {
    expect(
      resolveConvertTarget({
        [CONVERT_SERVICE_URL_ENV]: SERVICE,
        [CONVERT_SHARED_SECRET_ENV]: SECRET,
      }),
    ).toEqual({ url: SERVICE, secret: SECRET });
  });

  it('reduces the address to an origin, dropping a path and a query', () => {
    // A configured PATH would be glued in front of `/convert` and 404, which this
    // module would then report as an unreachable service; a configured QUERY is
    // where a token lands, and from there into this container's outbound request
    // log. install.sh accepts any absolute http(s) URL, so both are reachable.
    const target = resolveConvertTarget({
      [CONVERT_SERVICE_URL_ENV]: 'http://convert.internal:9000/convert?token=abc',
    });
    expect(target?.url).toBe('http://convert.internal:9000');
  });

  it('strips whitespace from the secret, the way the service strips its own', () => {
    // A secret pasted into a compose file picks up a trailing newline often enough
    // that sending it verbatim would be a 401 on every conversion.
    expect(
      resolveConvertTarget({
        [CONVERT_SERVICE_URL_ENV]: SERVICE,
        [CONVERT_SHARED_SECRET_ENV]: `  ${SECRET}\n`,
      })?.secret,
    ).toBe(SECRET);
  });

  it('treats an address it cannot use as no address, and says which variable', () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      for (const bad of ['not a url', 'ftp://convert-service:8080', 'file:///etc/passwd']) {
        expect(resolveConvertTarget({ [CONVERT_SERVICE_URL_ENV]: bad }), bad).toBeNull();
      }
    } finally {
      spy.mockRestore();
    }
    expect(logged).toHaveLength(3);
    // The variable name is what an operator has to go and fix.
    for (const line of logged) expect(line).toContain(CONVERT_SERVICE_URL_ENV);
    // …and the value is not: an address can carry a token in its query string.
    expect(logged.join('\n')).not.toContain('token=');
  });

  it('means authentication is off when no secret is configured', () => {
    // Empty rather than absent, because convert-service reads an empty
    // CONVERT_SHARED_SECRET as "no authentication" and this has to agree.
    expect(resolveConvertTarget({ [CONVERT_SERVICE_URL_ENV]: SERVICE })?.secret).toBe('');
  });
});

describe('convertHeaders', () => {
  it('uses the two header names convert-service pins on its side', () => {
    // auth.py AUTH_HEADER and main.py FILE_NAME_HEADER. The two runtimes share no
    // module format, so the string is the contract and each side's test pins it.
    expect(CONVERT_AUTH_HEADER).toBe('X-Convert-Token');
    expect(CONVERT_FILE_NAME_HEADER).toBe('X-File-Name');
    expect(convertHeaders(TARGET, 'bracket.step')).toEqual({
      'X-File-Name': 'bracket.step',
      'X-Convert-Token': SECRET,
    });
  });

  it('omits the token header entirely when no secret is configured', () => {
    // Omitted rather than sent empty: an empty credential header is one a proxy
    // may drop, and a service with authentication off ignores it either way.
    expect(convertHeaders({ url: SERVICE, secret: '' }, 'bracket.step')).toEqual({
      'X-File-Name': 'bracket.step',
    });
  });

  it('encodes a name a header value cannot carry, rather than letting fetch throw', () => {
    // A header value is ISO-8859-1 and undici REFUSES one character above U+00FF
    // instead of approximating it, so an unencoded em dash or CJK part name would
    // fail the conversion before a byte was sent. Latin-1 itself survives: ü is
    // U+00FC, and it is what reaches the service.
    expect(headerSafeFileName('Bügel — Rev B.step')).toBe('Bügel _ Rev B.step');
    expect(headerSafeFileName('支架.step')).toBe('__.step');
    // Control characters go too, including the two that would be header injection.
    expect(headerSafeFileName('a\r\nX-Evil: 1.step')).toBe('a__X-Evil: 1.step');
    // The extension always survives, because it is what picks the reader.
    for (const name of ['支架.step', 'Bügel — Rev B.stp', 'a\u0007b.iges']) {
      expect(headerSafeFileName(name)).toMatch(/\.(step|stp|iges)$/);
    }
  });

  it('sends the encoded name, so the wire never carries what undici would refuse', async () => {
    const { fetchFn, calls } = fakeService(okResponse);
    await convertToGlb(TARGET, STEP, '支架.step', { fetchFn });
    expect(calls[0]?.headers[CONVERT_FILE_NAME_HEADER]).toBe('__.step');
  });
});

describe('the api-side deadline', () => {
  it('is shorter than the service’s own, so the two timeouts stay distinguishable', () => {
    // convert-service kills a job at CONVERT_TIMEOUT_S (900 by default) and nginx's
    // proxy_read_timeout for /api/models is also 900s. Equal deadlines would leave
    // a 504 in the api log with three possible authors and three different fixes.
    const CONVERT_SERVICE_TIMEOUT_S = 900;
    const NGINX_PROXY_READ_TIMEOUT_S = 900;
    expect(CONVERT_REQUEST_TIMEOUT_MS).toBeLessThan(CONVERT_SERVICE_TIMEOUT_S * 1000);
    expect(CONVERT_REQUEST_TIMEOUT_MS).toBeLessThan(NGINX_PROXY_READ_TIMEOUT_S * 1000);
    // …and not so much shorter that a legitimate long conversion is cut off first.
    expect(CONVERT_REQUEST_TIMEOUT_MS).toBeGreaterThan(CONVERT_SERVICE_TIMEOUT_S * 1000 * 0.5);
  });
});

describe('convertToGlb', () => {
  it('posts the bytes untouched to /convert and streams the GLB back', async () => {
    const { fetchFn, calls } = fakeService(okResponse);

    const converted = await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SERVICE}/convert`);
    expect(calls[0]?.method).toBe('POST');
    // The raw body is the file: no multipart, no base64, which is the shape
    // convert-service reads and the reason a 200 MB assembly is not copied twice.
    expect(calls[0]?.body).toEqual(STEP);
    expect(calls[0]?.headers[CONVERT_FILE_NAME_HEADER]).toBe(STEP_NAME);
    expect(calls[0]?.headers[CONVERT_AUTH_HEADER]).toBe(SECRET);

    expect(await readAll(converted.body)).toEqual(GLB);
    expect(converted.partCount).toBe(9);
    expect(converted.triangleCount).toBe(636);
    expect(converted.convertMs).toBe(2700);
  });

  it('forwards each of convert-service’s failure codes verbatim', async () => {
    // The codes are a contract, not messages: 03c maps convert_unreadable and
    // convert_timeout onto the sentences utils/cadImport.ts already shows.
    for (const [status, code] of SERVICE_FAILURES) {
      const { fetchFn } = fakeService(() => errorResponse(status, code));
      const failure = await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure, `${status} ${code}`).toBeInstanceOf(ConvertFailure);
      expect((failure as ConvertFailure).reason, `${status} ${code}`).toBe(code);
    }
  });

  it('answers CONVERT_ERROR for a status whose body carries no usable code', async () => {
    const bodies: Array<() => Response> = [
      // A proxy's HTML page, which is what stands between the api and the service
      // in a deployment that put one there.
      () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
      () => new Response('not json', { status: 500, headers: { 'Content-Type': 'application/json' } }),
      () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } }),
      () =>
        new Response(JSON.stringify({ error: 42 }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    ];
    for (const body of bodies) {
      const { fetchFn } = fakeService(body);
      const err = (await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
        () => null,
        (e: unknown) => e,
      )) as ConvertFailure;
      expect(err.reason).toBe(CONVERT_ERROR);
    }
  });

  it('refuses to echo an upstream string as a reason, however it is spelled', async () => {
    // A reason ends up in a JSON body a browser renders, so it is matched against
    // the shape of a code rather than trusted because it arrived in `error`.
    const planted = '"><img src=x onerror=alert(1)>'.toLowerCase();
    const { fetchFn } = fakeService(() =>
      new Response(JSON.stringify({ error: planted }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const err = (await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
      () => null,
      (e: unknown) => e,
    )) as ConvertFailure;
    expect(err.reason).toBe(CONVERT_ERROR);
    expect(err.message).not.toContain('onerror');
  });

  it('refuses a 200 with no body rather than storing an empty GLB', async () => {
    const { fetchFn } = fakeService(() => new Response(null, { status: 200 }));
    const err = (await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
      () => null,
      (e: unknown) => e,
    )) as ConvertFailure;
    expect(err.reason).toBe(CONVERT_BAD_RESPONSE);
  });

  it('reports an unreachable service as its own reason, with no detail forwarded', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      const fetchFn = vi.fn(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${SERVICE}`), { code: 'ECONNREFUSED' }),
        });
      }) as unknown as typeof fetch;

      const err = (await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
        () => null,
        (e: unknown) => e,
      )) as ConvertFailure;

      expect(err.reason).toBe(CONVERT_UNREACHABLE);
      // The caller gets a code; the socket detail is in the log and nowhere else.
      expect(err.message).not.toContain('ECONNREFUSED');
      expect(logged.join('\n')).toContain('ECONNREFUSED');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports this side’s deadline as its own reason, not the service’s', async () => {
    // CONVERT_CLIENT_TIMEOUT rather than `convert_timeout`: an abort here is the
    // api giving up, a 504 from the service is its subprocess having been killed,
    // and the fixes are different enough that the log has to tell them apart.
    for (const thrown of [
      new DOMException('The operation timed out', 'TimeoutError'),
      new TypeError('fetch failed', {
        cause: new DOMException('The operation timed out', 'TimeoutError'),
      }),
    ]) {
      const fetchFn = vi.fn(async () => {
        throw thrown;
      }) as unknown as typeof fetch;
      const err = (await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
        () => null,
        (e: unknown) => e,
      )) as ConvertFailure;
      expect(err.reason).toBe(CONVERT_CLIENT_TIMEOUT);
    }
  });

  it('gives the request a deadline at all', async () => {
    // Asserted through the signal rather than by waiting for one: a request with no
    // AbortSignal is a conversion that can hang an api worker for ever.
    let seen: AbortSignal | null = null;
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = (init?.signal as AbortSignal | undefined) ?? null;
      return okResponse();
    }) as unknown as typeof fetch;

    await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn, timeoutMs: 1234 });

    expect(seen).toBeInstanceOf(AbortSignal);
  });

  it('never puts the shared secret in a failure', async () => {
    for (const response of [
      () => errorResponse(401, 'unauthorized'),
      () => new Response('nope', { status: 500 }),
    ]) {
      const { fetchFn } = fakeService(response);
      const err = (await convertToGlb(TARGET, STEP, STEP_NAME, { fetchFn }).then(
        () => null,
        (e: unknown) => e,
      )) as ConvertFailure;
      expect(err.message).not.toContain(SECRET);
      expect(err.reason).not.toContain(SECRET);
    }
  });
});
