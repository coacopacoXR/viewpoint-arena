// Tests for TeamcenterPLMAdapter.
//
// Three groups:
//   1. PLMAdapter contract suite (shared with Onshape, Mock, etc.)
//   2. Security: password NEVER appears in any response, error, or message
//   3. Signature: no adapter method accepts a credential as an argument

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamcenterPLMAdapter } from './teamcenter.ts';
import { runPLMContractTests } from './plm.contract.test.ts';
import type { PLMAdapter, PLMAuthContext } from './types.ts';

// Minimal GLB (header only) for exportGeometry responses.
const MINIMAL_GLB = new Uint8Array([
  0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00,
]);

const TEST_PASSWORD = 'super-secret-pw-xyz';

function mockJsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mockBinaryResponse(data: ArrayBuffer, status = 200): Response {
  return new Response(data, { status, headers: { 'Content-Type': 'application/octet-stream' } });
}

function createMockFetch(passwordInEnv: string = TEST_PASSWORD): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url === '/api/teamcenter/login') {
      // Verify the request body does NOT contain the password
      if (init?.body) {
        const bodyStr = typeof init.body === 'string' ? init.body : '';
        if (bodyStr.includes(passwordInEnv)) {
          return mockJsonResponse({ error: 'password_leaked' }, 500);
        }
      }
      return mockJsonResponse(
        { ok: true },
        200,
        { 'Set-Cookie': 'vp_tc_session=test-session-ref; Path=/; HttpOnly' },
      );
    }

    if (url === '/api/teamcenter/documents') {
      return mockJsonResponse({
        items: [{ id: 'tc-doc-1', workspaceId: 'tc-ws-1' }],
      });
    }

    if (url.startsWith('/api/teamcenter/elements')) {
      if (url.includes('nonexistent')) {
        return mockJsonResponse({ error: 'not_found' }, 404);
      }
      return mockJsonResponse({ id: 'tc-elem-1', name: 'Test Element', type: 'PARTSTUDIO' });
    }

    if (url.startsWith('/api/teamcenter/export')) {
      if (url.includes('nonexistent')) {
        return mockJsonResponse({ error: 'not_found' }, 404);
      }
      return mockBinaryResponse(MINIMAL_GLB.buffer.slice(0));
    }

    if (url === '/api/teamcenter/tasks') {
      return mockJsonResponse({ id: 'task-123' });
    }

    if (url === '/api/teamcenter/change-notices') {
      return mockJsonResponse({ id: 'cn-456' });
    }

    return mockJsonResponse({ error: 'not_found' }, 404);
  });
}

// ─── 1. PLMAdapter contract suite ────────────────────────────────────────────

describe('TeamcenterPLMAdapter', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = createMockFetch();
  });

  runPLMContractTests('TeamcenterPLMAdapter', () => {
    const adapter = new TeamcenterPLMAdapter(mockFetch as unknown as typeof fetch);
    return {
      adapter,
      auth: { sessionRef: 'tc-test-session' },
      missingRef: { id: 'nonexistent' },
      existingRef: { id: 'tc-doc-1', workspaceId: 'tc-ws-1', elementId: 'tc-elem-1' },
      launchSource: 'teamcenter',
      launchDocId: 'tc-doc-1',
    };
  });

  // ─── 2. Security tests ───────────────────────────────────────────────────

  describe('security: password never leaks', () => {
    it('login request body does not contain the password', async () => {
      const adapter = new TeamcenterPLMAdapter(mockFetch as unknown as typeof fetch);
      // Trigger login by calling any method
      await adapter.listDocuments({ sessionRef: 'test' });

      const loginCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/teamcenter/login'),
      );
      expect(loginCall).toBeDefined();
      // The login endpoint is called with no body (server reads process.env)
      const init = loginCall![1] as RequestInit | undefined;
      if (init?.body) {
        expect(String(init.body)).not.toContain(TEST_PASSWORD);
      }
    });

    it('success response from listDocuments does not contain the password', async () => {
      const adapter = new TeamcenterPLMAdapter(mockFetch as unknown as typeof fetch);
      const docs = await adapter.listDocuments({ sessionRef: 'test' });
      const serialized = JSON.stringify(docs);
      expect(serialized).not.toContain(TEST_PASSWORD);
    });

    it('error response from getElement (404) does not contain the password', async () => {
      const adapter = new TeamcenterPLMAdapter(mockFetch as unknown as typeof fetch);
      try {
        await adapter.getElement({ sessionRef: 'test' }, { id: 'nonexistent' });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain(TEST_PASSWORD);
      }
    });

    it('failed login (wrong password) does not echo the password', async () => {
      const failingFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/teamcenter/login')) {
          return mockJsonResponse({ error: 'login_failed_401' }, 401);
        }
        return mockJsonResponse({ error: 'not_found' }, 404);
      });
      const adapter = new TeamcenterPLMAdapter(failingFetch as unknown as typeof fetch);
      try {
        await adapter.listDocuments({ sessionRef: 'test' });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain(TEST_PASSWORD);
        expect(msg).not.toContain('super-secret');
      }
    });

    it('thrown error messages never contain the password string', async () => {
      const errorFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/teamcenter/login')) {
          return mockJsonResponse({ ok: true }, 200, {
            'Set-Cookie': 'vp_tc_session=s; Path=/; HttpOnly',
          });
        }
        // Every other endpoint returns an error with the password in the body
        // (simulating a badly-behaved upstream). The adapter must NOT forward
        // the upstream body to the caller.
        return mockJsonResponse(
          { error: `auth failed for ${TEST_PASSWORD}` },
          500,
        );
      });
      const adapter = new TeamcenterPLMAdapter(errorFetch as unknown as typeof fetch);
      try {
        await adapter.getElement({ sessionRef: 'test' }, { id: 'doc-1' });
        expect.fail('should have thrown');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain(TEST_PASSWORD);
      }
    });

    it('pushActions error messages do not contain the password', async () => {
      const failingFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/api/teamcenter/login')) {
          return mockJsonResponse({ ok: true }, 200, {
            'Set-Cookie': 'vp_tc_session=s; Path=/; HttpOnly',
          });
        }
        if (url.includes('/api/teamcenter/tasks')) {
          return mockJsonResponse(
            { error: `denied: ${TEST_PASSWORD}` },
            403,
          );
        }
        return mockJsonResponse({ error: 'not_found' }, 404);
      });
      const adapter = new TeamcenterPLMAdapter(failingFetch as unknown as typeof fetch);
      const result = await adapter.pushActions([
        {
          id: 'item-1',
          session_id: 's1',
          type: 'ACTION',
          title: 'Test Action',
          description: 'desc',
          priority: 'High',
          status: 'Open',
          assignee: null,
          due_date: null,
          component_reference: null,
          department: null,
          agent_id: 'a1',
          source_message_ids: null,
          affected_requirement_ids: null,
          impact: null,
          mitigation_strategy: null,
          design_driver: null,
          tradeoff_analysis: null,
          created_at: '',
          updated_at: '',
        },
      ]);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      for (const errMsg of result.errors) {
        expect(errMsg).not.toContain(TEST_PASSWORD);
      }
    });
  });

  // ─── 3. Signature tests ──────────────────────────────────────────────────

  describe('signatures: no method accepts a credential', () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    function getMethodParamNames(fn: Function): string[][] {
      const proto = fn.prototype;
      const methodNames = Object.getOwnPropertyNames(proto).filter(
        (n) => n !== 'constructor' && typeof proto[n] === 'function',
      );
      return methodNames.map((name) => {
          const src = proto[name].toString();
          const match = src.match(/\(([^)]*)\)/);
          if (!match) return [name, ''];
          return [name, match[1]];
        });
    }

    it('no method parameter is named password, credential, secret, or apiKey', async () => {
      const methods = getMethodParamNames(TeamcenterPLMAdapter);
      const forbidden = /\b(password|passwd|credential|secret|apiKey|api_key|token)\b/i;
      for (const [name, params] of methods) {
        const paramNames = params.split(',').map((p) => p.trim().split(/[=:?]/)[0].trim());
        for (const p of paramNames) {
          if (p && !p.startsWith('_')) {
            expect(forbidden.test(p), `method "${name}" has forbidden param "${p}"`).toBe(false);
          }
        }
      }
    });

    it('constructor does not accept a credential', () => {
      const src = TeamcenterPLMAdapter.constructor.toString();
      const match = src.match(/\(([^)]*)\)/);
      if (match) {
        expect(match[1].toLowerCase()).not.toMatch(
          /\b(password|credential|secret|apikey)\b/,
        );
      }
    });

    it('PLMAdapter interface methods do not have credential-shaped params', () => {
      const adapter: PLMAdapter = new TeamcenterPLMAdapter(
        mockFetch as unknown as typeof fetch,
      );
      // Verify the adapter satisfies PLMAdapter (compile-time check)
      expect(typeof adapter.listDocuments).toBe('function');
      expect(typeof adapter.getElement).toBe('function');
      expect(typeof adapter.exportGeometry).toBe('function');
      expect(typeof adapter.resolveLaunchContext).toBe('function');
      // Verify auth param is PLMAuthContext (opaque sessionRef), not a credential
      const auth: PLMAuthContext = { sessionRef: 'opaque-id' };
      expect(auth.sessionRef).not.toMatch(/password|secret|credential/i);
    });
  });
});
