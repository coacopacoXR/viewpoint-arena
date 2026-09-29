// Tests for the access gate: the useAccessGate hook and the AccessGate wrapper.
//
// The hook fetches GET /api/access and exposes { required, unlocked, loading }.
// The wrapper renders children when unlocked and the fallback when not.
// When the endpoint is unreachable or returns HTML (SPA fallback), the hook
// resolves to { required: false, unlocked: true } — fail-open.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { useAccessGate, resetAccessGateForTests } from '../useAccessGate.ts';
import { AccessGate } from '../AccessGate.tsx';

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

describe('useAccessGate', () => {
  beforeEach(() => {
    // The gate state is module-level (one per page, shared by the wrapper
    // and the gate screen), so each test starts from a clean slate.
    resetAccessGateForTests();
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves to required=true, unlocked=false when the server says so', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: true, unlocked: false }));
    const { result } = renderHook(() => useAccessGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(true);
    expect(result.current.unlocked).toBe(false);
  });

  it('resolves to required=false when no password is configured', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: false, unlocked: true }));
    const { result } = renderHook(() => useAccessGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(false);
    expect(result.current.unlocked).toBe(true);
  });

  it('fails open when the endpoint returns HTML (SPA fallback)', async () => {
    vi.stubGlobal('fetch', mockFetchHtml());
    const { result } = renderHook(() => useAccessGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(false);
    expect(result.current.unlocked).toBe(true);
  });

  it('fails open when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', mockFetchFail());
    const { result } = renderHook(() => useAccessGate());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.required).toBe(false);
    expect(result.current.unlocked).toBe(true);
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

    const { result } = renderHook(() => useAccessGate());
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

    const { result } = renderHook(() => useAccessGate());
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    let err: string | null = null;
    await act(async () => {
      err = await result.current.submit('wrong');
    });
    expect(err).toBe('Wrong password.');
  });
});

describe('AccessGate', () => {
  beforeEach(() => {
    // Without this the module-level state (and the "already fetched" flag)
    // survives from the hook tests above, so the wrapper renders last test's
    // answer and never asks the server again.
    resetAccessGateForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders children when not required', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: false, unlocked: true }));

    render(
      <AccessGate fallback={<div data-testid="gate-a">GATE</div>}>
        <div data-testid="content-a">CONTENT</div>
      </AccessGate>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('content-a')).toBeTruthy();
      expect(screen.queryByTestId('gate-a')).toBeNull();
    });
  });

  it('renders the fallback when required and not unlocked', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: true, unlocked: false }));

    render(
      <AccessGate fallback={<div data-testid="gate-b">GATE</div>}>
        <div data-testid="content-b">CONTENT</div>
      </AccessGate>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('gate-b')).toBeTruthy();
      expect(screen.queryByTestId('content-b')).toBeNull();
    });
  });

  it('renders children when required and unlocked', async () => {
    vi.stubGlobal('fetch', mockFetchJson({ required: true, unlocked: true }));

    render(
      <AccessGate fallback={<div data-testid="gate-c">GATE</div>}>
        <div data-testid="content-c">CONTENT</div>
      </AccessGate>,
    );

    await vi.waitFor(() => {
      expect(screen.getByTestId('content-c')).toBeTruthy();
      expect(screen.queryByTestId('gate-c')).toBeNull();
    });
  });
});
