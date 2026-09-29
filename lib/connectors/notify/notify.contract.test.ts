// Shared NotificationSinkAdapter contract test suite.
//
// Any NotificationSinkAdapter implementation can be run through this suite
// by calling runNotifyContractTests() with a setup function that produces
// the adapter and test fixtures.

import { describe, it, expect } from 'vitest';
import type { NotificationSinkAdapter } from './types.ts';
import type { TrackerSession, TrackerItem } from '../../supabase.ts';
import { MockNotificationSink } from './mock.ts';

const CREDENTIAL_FIELD_RE =
  /\b(password|passwd|secret|apiKey|api_key|access_token|refresh_token|client_secret|webhook_url|webhookUrl)\b/i;

function assertNoCredentialFields(obj: unknown, path = 'root'): void {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') return;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (CREDENTIAL_FIELD_RE.test(key)) {
      throw new Error(
        `Credential field "${key}" found at ${path}.${key}`,
      );
    }
    if (typeof value === 'object' && value !== null) {
      assertNoCredentialFields(value, `${path}.${key}`);
    }
  }
}

export interface NotifyContractSetup {
  adapter: NotificationSinkAdapter;
  session: TrackerSession;
  items: TrackerItem[];
  item: TrackerItem;
}

export function runNotifyContractTests(
  name: string,
  setup: () => NotifyContractSetup | Promise<NotifyContractSetup>,
): void {
  describe(`NotificationSinkAdapter contract: ${name}`, () => {
    let ctx: NotifyContractSetup;

    it('has a non-empty string id', async () => {
      ctx = await setup();
      expect(typeof ctx.adapter.id).toBe('string');
      expect(ctx.adapter.id.length).toBeGreaterThan(0);
    });

    it('postSession returns { ok: boolean }', async () => {
      ctx ??= await setup();
      const result = await ctx.adapter.postSession(ctx.session, ctx.items);
      expect(typeof result.ok).toBe('boolean');
      if (result.error !== undefined) {
        expect(typeof result.error).toBe('string');
      }
      assertNoCredentialFields(result, 'postSession.result');
    });

    it('postItem returns { ok: boolean }', async () => {
      ctx ??= await setup();
      const result = await ctx.adapter.postItem(ctx.item);
      expect(typeof result.ok).toBe('boolean');
      if (result.error !== undefined) {
        expect(typeof result.error).toBe('string');
      }
      assertNoCredentialFields(result, 'postItem.result');
    });

    it('error messages do not contain credential-shaped values', async () => {
      ctx ??= await setup();
      // Force a failure if the adapter supports it
      if ('shouldFail' in ctx.adapter) {
        (ctx.adapter as MockNotificationSink).shouldFail = true;
      }
      const result = await ctx.adapter.postSession(ctx.session, ctx.items);
      if (result.error) {
        expect(result.error).not.toMatch(CREDENTIAL_FIELD_RE);
      }
    });
  });
}

// Run the contract suite against MockNotificationSink.
describe('NotificationSinkAdapter contract suite', () => {
  const mockSession: TrackerSession = {
    id: 'sess-1',
    room_id: 'room-1',
    title: 'Test Review',
    ended_at: '2026-01-15T10:00:00Z',
    created_at: '2026-01-15T09:00:00Z',
    participant_count: 3,
    model_name: 'Test Model',
    labels: {},
  };

  const mockItem: TrackerItem = {
    id: 'item-1',
    session_id: 'sess-1',
    type: 'ACTION',
    title: 'Test Action',
    description: 'A test action item',
    priority: 'High',
    status: 'Open',
    assignee: 'alice',
    due_date: '2026-02-01',
    component_reference: 'Bracket A',
    department: 'Mech',
    agent_id: 'agent-1',
    source_message_ids: [],
    affected_requirement_ids: [],
    impact: null,
    mitigation_strategy: null,
    design_driver: null,
    tradeoff_analysis: null,
    created_at: '2026-01-15T09:00:00Z',
    updated_at: '2026-01-15T09:00:00Z',
  };

  runNotifyContractTests('MockNotificationSink', () => ({
    adapter: new MockNotificationSink(),
    session: mockSession,
    items: [mockItem],
    item: mockItem,
  }));
});
