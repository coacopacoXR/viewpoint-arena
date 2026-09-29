// Tests for the admin gate: the useAdminGate hook.
//
// Same shape as the front-door access gate tests, but the fail-safe direction
// is opposite: when the endpoint is unreachable or returns HTML, the admin
// screen stays LOCKED (required: true, unlocked: false) rather than failing
// open. The admin screen can delete other people's reviews.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAdminGate, resetAdminGateForTests } from '../useAdminGate.ts';

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function mockFetchHtml() {
  return vi.fn(async () =>
    new Response('<!DOCTYPE html><html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }),
  );
}

function mockFetchFail() {
  return vi.fn(async () => { throw new Error('network error'); });
}

describe('useAdminGate', () => {
  beforeEach(() => {
    // Module-level state (one per page, shared by the wrapper and the form)
    // survives across tests — reset it every time.
    resetAdminGateForTests();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves to required=true, unlocked=false when the server says so', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: true, unlocked: false }));
    const { result } = renderHook(() => useAdminGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(true);
    expect(result.current.unlocked).toBe(false);
  });

  it('resolves to required=false when no passphrase is configured', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: false, unlocked: true }));
    const { result } = renderHook(() => useAdminGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(false);
    expect(result.current.unlocked).toBe(true);
  });

  it('stays LOCKED when the endpoint returns HTML (SPA fallback)', async () => {
    // The opposite of the front door: an unreachable or HTML-serving endpoint
    // means the admin screen stays locked, not open.
    vi.stubGlobal('fetch', mockFetchHtml());
    const { result } = renderHook(() => useAdminGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(true);
    expect(result.current.unlocked).toBe(false);
  });

  it('stays LOCKED when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', mockFetchFail());
    const { result } = renderHook(() => useAdminGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(true);
    expect(result.current.unlocked).toBe(false);
  });

  it('submit returns null on success and flips unlocked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return new Response(JSON.stringify({ unlocked: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ required: true, unlocked: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const { result } = renderHook(() => useAdminGate());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    let err: string | null = null;
    await act(async () => {
      err = await result.current.submit('correct');
    });
    expect(err).toBeNull();
    expect(result.current.unlocked).toBe(true);
  });

  it('submit returns an error string on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'wrong_password' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ required: true, unlocked: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const { result } = renderHook(() => useAdminGate());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    let err: string | null = null;
    await act(async () => {
      err = await result.current.submit('wrong');
    });
    expect(err).toBe('Wrong passphrase.');
  });
});
