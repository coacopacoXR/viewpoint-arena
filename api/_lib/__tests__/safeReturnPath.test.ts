// Tests for the OAuth return-path validator (T5.3 security fix).
//
// The check this replaces was `returnTo.startsWith('/')`, which accepts
// `//evil.com` and `/\evil.com` — both of which browsers resolve as ANOTHER
// HOST, turning the Onshape callback into an open redirect that carries a
// freshly-minted OAuth session with it. These tests pin the unit and then the
// two handlers that use it, so a regression fails at the level a reviewer would
// recognise.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeReturnPath } from '../safeReturnPath.ts';

describe('safeReturnPath', () => {
  it('keeps a same-origin path, query and fragment', () => {
    expect(safeReturnPath('/room/abc?x=1')).toBe('/room/abc?x=1');
    expect(safeReturnPath('/')).toBe('/');
    expect(safeReturnPath('/review/1234/setup')).toBe('/review/1234/setup');
    expect(safeReturnPath('/tracker#top')).toBe('/tracker#top');
  });

  it('keeps a PLM launch path, which is the case this fix must not break', () => {
    const launch = '/launch?plmSource=onshape&plmDoc=a1b2c3d4e5f60718293a4b5c&plmElement=fffffffffffffffffffffffe';
    expect(safeReturnPath(launch)).toBe(launch);
  });

  it('rejects the two slash-prefixed spellings of "another host"', () => {
    expect(safeReturnPath('//evil.com')).toBe('/');
    expect(safeReturnPath('/\\evil.com')).toBe('/');
    expect(safeReturnPath('//evil.com/launch?plmDoc=x')).toBe('/');
    expect(safeReturnPath('/\\/evil.com')).toBe('/');
  });

  it('rejects an absolute URL, a scheme and a backslash anywhere', () => {
    expect(safeReturnPath('https://evil.com')).toBe('/');
    expect(safeReturnPath('http://evil.com/room/1')).toBe('/');
    expect(safeReturnPath('javascript:alert(1)')).toBe('/');
    expect(safeReturnPath('JaVaScRiPt:alert(1)')).toBe('/');
    expect(safeReturnPath('\\evil.com')).toBe('/');
    expect(safeReturnPath('\\\evil.com')).toBe('/');
    expect(safeReturnPath('/room/1\\2')).toBe('/');
    expect(safeReturnPath('data:text/html,<script>alert(1)</script>')).toBe('/');
  });

  it('rejects control characters, raw and percent-encoded', () => {
    // A CR or LF in a Location header is response splitting.
    expect(safeReturnPath('/%0d%0aSet-Cookie')).toBe('/');
    expect(safeReturnPath('/%0d%0aX-Injected:1')).toBe('/');
    expect(safeReturnPath('/room\r\nSet-Cookie: x=1')).toBe('/');
    expect(safeReturnPath('/room%00')).toBe('/');
    expect(safeReturnPath('/%7f')).toBe('/');
  });

  it('rejects empty and non-string input', () => {
    expect(safeReturnPath('')).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath(null)).toBe('/');
    expect(safeReturnPath(123)).toBe('/');
    expect(safeReturnPath(['/', '//evil.com'])).toBe('/');
    expect(safeReturnPath({ toString: () => '/room/1' })).toBe('/');
  });

  it('never returns anything that is not "/" or a same-origin path', () => {
    const hostile = [
      '//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com',
      'javascript:alert(1)', '/%0d%0aSet-Cookie', '', '   ', '/ /x',
    ];
    for (const value of hostile) {
      const out = safeReturnPath(value);
      expect(out === '/' || out.startsWith('/'), `${JSON.stringify(value)} -> ${out}`).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect(out.includes('\\')).toBe(false);
      expect(new URL(out, 'http://x').origin).toBe('http://x');
    }
  });
});

// ─── Handler level ───────────────────────────────────────────────────────────
//
// The unit can be right and the handler can still redirect off-site, so both
// handlers are driven end to end: the callback for the redirect it emits, and
// auth-start for the value it stores in the state cookie (validation on the way
// in, so a hostile `return` never survives the round-trip).

const VALID_OS_DOC = 'a1b2c3d4e5f60718293a4b5c';

function stateCookie(returnTo: string, state = 'state-xyz'): string {
  return Buffer.from(JSON.stringify({ state, returnTo })).toString('base64url');
}

describe('api/onshape/callback.ts', () => {
  beforeEach(() => {
    process.env.ONSHAPE_CLIENT_ID = 'test-client-id';
    process.env.ONSHAPE_CLIENT_SECRET = 'test-client-secret';
    // The token exchange has to succeed for the handler to reach the redirect.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: 'at-123',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'rt-123',
          }),
          { status: 200 },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.ONSHAPE_CLIENT_ID;
    delete process.env.ONSHAPE_CLIENT_SECRET;
  });

  async function runCallback(returnTo: string): Promise<string> {
    const { default: handler } = await import('../../onshape/callback.ts');
    const redirects: Array<[number, string]> = [];
    const res = {
      setHeader: () => res,
      status: () => res,
      send: () => res,
      json: () => res,
      redirect: (code: number, location: string) => {
        redirects.push([code, location]);
      },
    } as never;
    const req = {
      query: { code: 'auth-code', state: 'state-xyz' },
      headers: { cookie: `vp_onshape_oauth=${stateCookie(returnTo)}` },
    };
    await handler(req as never, res);
    expect(redirects).toHaveLength(1);
    return redirects[0][1];
  }

  it('redirects to / for a protocol-relative returnTo', async () => {
    expect(await runCallback('//evil.com')).toBe('/');
  });

  it('redirects to / for a backslash host', async () => {
    expect(await runCallback('/\\evil.com')).toBe('/');
  });

  it('redirects to / for an absolute URL and for a header injection', async () => {
    expect(await runCallback('https://evil.com/room/1')).toBe('/');
    expect(await runCallback('/%0d%0aSet-Cookie:%20vp=1')).toBe('/');
  });

  it('still redirects to a legitimate launch path', async () => {
    const launch = `/launch?plmSource=onshape&plmDoc=${VALID_OS_DOC}`;
    expect(await runCallback(launch)).toBe(launch);
  });

  it('redirects to / when the stored returnTo is missing', async () => {
    expect(await runCallback('')).toBe('/');
  });
});

describe('api/onshape/auth-start.ts', () => {
  beforeEach(() => {
    process.env.ONSHAPE_CLIENT_ID = 'test-client-id';
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.ONSHAPE_CLIENT_ID;
  });

  /** Runs the handler and unpacks the returnTo it stored in the state cookie. */
  async function storedReturnTo(query: Record<string, string>): Promise<string> {
    const { default: handler } = await import('../../onshape/auth-start.ts');
    let cookie = '';
    const res = {
      status: () => res,
      json: () => res,
      send: () => res,
      setHeader: (name: string, value: string) => {
        if (name === 'Set-Cookie') cookie = String(value);
      },
      redirect: () => res,
    } as never;
    handler({ query, headers: {} } as never, res);
    const payload = cookie.split(';')[0].replace('vp_onshape_oauth=', '');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      returnTo: string;
    };
    return parsed.returnTo;
  }

  it('stores / rather than a hostile return target', async () => {
    expect(await storedReturnTo({ return: '//evil.com' })).toBe('/');
    expect(await storedReturnTo({ return: '/\\evil.com' })).toBe('/');
    expect(await storedReturnTo({ return: 'https://evil.com' })).toBe('/');
    expect(await storedReturnTo({ return: '/%0d%0aSet-Cookie' })).toBe('/');
  });

  it('stores a legitimate launch path unchanged', async () => {
    const launch = `/launch?plmSource=onshape&plmDoc=${VALID_OS_DOC}&plmElement=fffffffffffffffffffffffe`;
    expect(await storedReturnTo({ return: launch })).toBe(launch);
  });

  it('defaults to / when no return parameter is given', async () => {
    expect(await storedReturnTo({})).toBe('/');
  });

  it('ignores a return parameter that is not a single string', async () => {
    // Vercel hands back string[] for a repeated query parameter.
    const { default: handler } = await import('../../onshape/auth-start.ts');
    let cookie = '';
    const res = {
      status: () => res,
      json: () => res,
      send: () => res,
      setHeader: (name: string, value: string) => {
        if (name === 'Set-Cookie') cookie = String(value);
      },
      redirect: () => res,
    } as never;
    handler({ query: { return: ['/room/1', '//evil.com'] }, headers: {} } as never, res);
    const payload = cookie.split(';')[0].replace('vp_onshape_oauth=', '');
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      returnTo: string;
    };
    expect(parsed.returnTo).toBe('/');
  });
});
