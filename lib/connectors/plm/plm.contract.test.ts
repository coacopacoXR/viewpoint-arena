// Shared PLMAdapter contract test suite.
//
// Any PLMAdapter implementation — MockPLMAdapter, OnshapePLMAdapter (nightly
// with live creds), TeamcenterPLMAdapter (T3.2), or a corp's custom adapter —
// can be run through this suite by calling runPLMContractTests() with a
// setup function that produces the adapter and a valid auth context.
//
// The suite asserts REAL behaviour, not just that methods exist:
//   - return shapes match the interface types
//   - missing documents produce errors
//   - no adapter method accepts or returns a raw credential
//   - resolveLaunchContext validates a launch link's ids instead of echoing
//     them, so a hand-edited URL cannot inject a path or a query parameter

import { describe, it, expect } from 'vitest';
import type {
  PLMAdapter,
  PLMAuthContext,
  PLMDocumentRef,
} from './types.ts';
import { MockPLMAdapter } from './mock.ts';

// Field names that must never appear in PLMAuthContext or in adapter return
// values. Covers the credential shapes across all planned PLM providers.
const CREDENTIAL_FIELD_RE =
  /\b(password|passwd|secret|apiKey|api_key|access_token|refresh_token|client_secret|token|credential)\b/i;

function assertNoCredentialFields(obj: unknown, path = 'root'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (CREDENTIAL_FIELD_RE.test(key)) {
      throw new Error(
        `Credential field "${key}" found at ${path}.${key} — adapter interface must not expose raw credentials`,
      );
    }
    if (typeof value === 'object' && value !== null) {
      assertNoCredentialFields(value, `${path}.${key}`);
    }
  }
}

function assertNoCredentialValues(obj: unknown, path = 'root'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string') {
    // Heuristic: flag strings that look like base64/hex tokens (>40 chars,
    // high entropy). Skip short strings and URLs.
    if (obj.length > 40 && !obj.startsWith('http') && !obj.startsWith('/')) {
      const hexLike = /^[0-9a-f]{32,}$/i.test(obj);
      const base64Like = /^[A-Za-z0-9+/=]{32,}$/.test(obj);
      if (hexLike || base64Like) {
        throw new Error(
          `Possible raw credential value at ${path} (length ${obj.length}) — adapter must not return raw credentials`,
        );
      }
    }
    return;
  }
  if (typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoCredentialValues(item, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    assertNoCredentialValues(value, `${path}.${key}`);
  }
}

export interface PLMContractSetup {
  adapter: PLMAdapter;
  auth: PLMAuthContext;
  /** A document ref known to NOT exist, for error-path tests. */
  missingRef: PLMDocumentRef;
  /** A document ref known to exist, for happy-path tests. */
  existingRef: PLMDocumentRef;
  /** The `plmSource` value this adapter answers to. */
  launchSource: string;
  /** A document id this adapter resolves for `launchSource` — the positive control. */
  launchDocId: string;
}

export function runPLMContractTests(
  name: string,
  setup: () => PLMContractSetup | Promise<PLMContractSetup>,
): void {
  describe(`PLMAdapter contract: ${name}`, () => {
    let ctx: PLMContractSetup;

    it('setup produces a valid adapter and auth context', async () => {
      ctx = await setup();
      expect(ctx.adapter).toBeDefined();
      expect(typeof ctx.adapter.authStartPath).toBe('string');
      expect(ctx.adapter.authStartPath.length).toBeGreaterThan(0);
      expect(ctx.auth).toBeDefined();
      expect(typeof ctx.auth.sessionRef).toBe('string');

      // PLMAuthContext must not have credential-shaped fields.
      assertNoCredentialFields(ctx.auth, 'PLMAuthContext');
    });

    it('listDocuments returns an array of PLMDocumentRef with id strings', async () => {
      ctx ??= await setup();
      const docs = await ctx.adapter.listDocuments(ctx.auth);
      expect(Array.isArray(docs)).toBe(true);
      expect(docs.length).toBeGreaterThan(0);
      for (const doc of docs) {
        expect(typeof doc.id).toBe('string');
        expect(doc.id.length).toBeGreaterThan(0);
        if (doc.workspaceId !== undefined) {
          expect(typeof doc.workspaceId).toBe('string');
        }
        if (doc.elementId !== undefined) {
          expect(typeof doc.elementId).toBe('string');
        }
      }
      // No credential fields in the return value.
      assertNoCredentialFields(docs, 'listDocuments.result');
      assertNoCredentialValues(docs, 'listDocuments.result');
    });

    it('getElement returns a PLMElement with id, name, and type', async () => {
      ctx ??= await setup();
      const el = await ctx.adapter.getElement(ctx.auth, ctx.existingRef);
      expect(typeof el.id).toBe('string');
      expect(el.id.length).toBeGreaterThan(0);
      expect(typeof el.name).toBe('string');
      expect(typeof el.type).toBe('string');
      assertNoCredentialFields(el, 'getElement.result');
      assertNoCredentialValues(el, 'getElement.result');
    });

    it('getElement throws on a missing document', async () => {
      ctx ??= await setup();
      await expect(
        ctx.adapter.getElement(ctx.auth, ctx.missingRef),
      ).rejects.toThrow();
    });

    it('exportGeometry returns a Blob for a valid document', async () => {
      ctx ??= await setup();
      const refWithElement = {
        ...ctx.existingRef,
        elementId: ctx.existingRef.elementId || 'mock-elem-1a',
      };
      const blob = await ctx.adapter.exportGeometry(
        ctx.auth,
        refWithElement,
        'gltf',
      );
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });

    it('exportGeometry throws on a missing document', async () => {
      ctx ??= await setup();
      await expect(
        ctx.adapter.exportGeometry(ctx.auth, ctx.missingRef, 'gltf'),
      ).rejects.toThrow();
    });

    it('resolveLaunchContext returns null for an unrecognized source', async () => {
      ctx ??= await setup();
      const result = await ctx.adapter.resolveLaunchContext({
        plmSource: 'unknown-system',
        plmDoc: 'whatever',
      });
      expect(result).toBeNull();
    });

    it('resolveLaunchContext does not accept or return credentials', async () => {
      ctx ??= await setup();
      // Even when called with query params that look credential-like, the
      // adapter must not echo them back or leak them in the result.
      const result = await ctx.adapter.resolveLaunchContext({
        plmSource: ctx.launchSource,
        plmDoc: ctx.launchDocId,
        token: 'should-not-appear',
        password: 'should-not-appear',
      });
      if (result) {
        assertNoCredentialFields(result, 'resolveLaunchContext.result');
        assertNoCredentialValues(result, 'resolveLaunchContext.result');
      }
      expect(JSON.stringify(result ?? null)).not.toContain('should-not-appear');
    });

    it('resolveLaunchContext resolves a well-formed launch link', async () => {
      ctx ??= await setup();
      // Positive control for the injection test below: without it, an adapter
      // that returned null for everything would pass that test vacuously.
      const result = await ctx.adapter.resolveLaunchContext({
        plmSource: ctx.launchSource,
        plmDoc: ctx.launchDocId,
      });
      expect(result).not.toBeNull();
      expect(result?.doc.id).toBe(ctx.launchDocId);
      expect(typeof result?.roomHint).toBe('string');
    });

    it('resolveLaunchContext never returns a path-traversal or URL-injection id', async () => {
      ctx ??= await setup();
      // A launch URL is attacker-editable — anyone can hand-edit one, and the
      // link template lives in a customer's PLM console. An id that could break
      // out of a path or inject a query parameter must never come back out of
      // the adapter, because callers build Onshape URLs and reference links
      // from doc.id. Every source is probed, not just this adapter's own: an
      // adapter must reject a link addressed to a different PLM outright.
      const injected = [
        '../../x',
        'a?b=c',
        'a/b',
        '%2F',
        '..%2F..%2Fetc%2Fpasswd',
        'x#fragment',
        'a\\b',
        'a b',
        'https://evil.example/x',
        'a'.repeat(200),
      ];
      for (const source of ['mock', 'onshape', 'teamcenter']) {
        for (const id of injected) {
          const result = await ctx.adapter.resolveLaunchContext({
            plmSource: source,
            plmDoc: id,
          });
          if (result === null) continue;
          expect(result.doc.id).not.toBe(id);
          expect(result.doc.id).not.toContain(id);
          // Whatever survives must be a plain opaque id: no separator, no
          // percent-escape, no whitespace, no scheme.
          expect(result.doc.id).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
          expect(result.roomHint).not.toContain(id);
          if (result.doc.workspaceId !== undefined) {
            expect(result.doc.workspaceId).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
          }
          if (result.doc.elementId !== undefined) {
            expect(result.doc.elementId).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
          }
        }
      }
    });

    it('resolveLaunchContext rejects an injected workspace or element id', async () => {
      ctx ??= await setup();
      // The document id is the obvious target, so it is the one a caller
      // validates first. The other two end up in the same URLs.
      for (const key of ['plmWorkspace', 'plmElement'] as const) {
        const result = await ctx.adapter.resolveLaunchContext({
          plmSource: ctx.launchSource,
          plmDoc: ctx.launchDocId,
          [key]: '../../etc/passwd',
        });
        if (result === null) continue;
        const resolved = key === 'plmWorkspace' ? result.doc.workspaceId : result.doc.elementId;
        expect(resolved).not.toBe('../../etc/passwd');
        expect(resolved ?? '').toMatch(/^[A-Za-z0-9_.-]{0,128}$/);
      }
    });
  });
}

// Run the contract suite against MockPLMAdapter — this is the regular CI path.
// The Onshape adapter runs through the same suite in the nightly live-adapter
// job (needs sandbox credentials). T3.2's Teamcenter adapter will plug in
// here the same way.
describe('PLMAdapter contract suite', () => {
  runPLMContractTests('MockPLMAdapter', () => ({
    adapter: new MockPLMAdapter(),
    auth: { sessionRef: 'mock-session' },
    missingRef: { id: 'nonexistent-doc-xyz' },
    existingRef: { id: 'mock-doc-1', workspaceId: 'mock-ws-1' },
    launchSource: 'mock',
    launchDocId: 'mock-doc-1',
  }));
});
