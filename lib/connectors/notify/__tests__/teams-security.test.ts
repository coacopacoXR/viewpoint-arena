// Security tests for the Teams notification adapter.
//
// Asserts that the webhook URL (a bearer credential) NEVER appears in any
// browser-reachable response or thrown error, including failure paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TrackerSession, TrackerItem } from '../../../supabase.ts';

const TEST_WEBHOOK = 'https://outlook.office.com/webhook/SECRET-ID-here';

const mockSession: TrackerSession = {
  id: 's1',
  room_id: 'r1',
  title: 'Test',
  ended_at: '2026-01-15T10:00:00Z',
  created_at: '2026-01-15T09:00:00Z',
  participant_count: 2,
  model_name: null,
  labels: {},
};

const mockItem: TrackerItem = {
  id: 'i1',
  session_id: 's1',
  type: 'ACTION',
  title: 'Fix bracket',
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
};

function createMockRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    _statusCode: 0,
    _body: null as unknown,
  };
  res.status.mockImplementation((code: number) => {
    res._statusCode = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

function createMockReq(
  method: string,
  body?: unknown,
): { method: string; body: unknown; headers: Record<string, string> } {
  return { method, body, headers: {} };
}

describe('Teams webhook URL security', () => {
  let originalWebhook: string | undefined;

  beforeEach(() => {
    originalWebhook = process.env.TEAMS_WEBHOOK_URL;
    process.env.TEAMS_WEBHOOK_URL = TEST_WEBHOOK;
  });

  afterEach(() => {
    if (originalWebhook === undefined) {
      delete process.env.TEAMS_WEBHOOK_URL;
    } else {
      process.env.TEAMS_WEBHOOK_URL = originalWebhook;
    }
    vi.restoreAllMocks();
  });

  it('success response does not contain the webhook URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('1', { status: 200 }),
    );

    const { default: handler } = await import('../../../../api/notify/teams.ts');
    const req = createMockReq('POST', {
      action: 'session',
      session: mockSession,
      items: [mockItem],
      origin: 'http://localhost',
    });
    const res = createMockRes();

    await handler(req as never, res as never);

    const body = JSON.stringify(res._body);
    expect(body).not.toContain(TEST_WEBHOOK);
    expect(res._statusCode).toBe(200);
  });

  it('webhook error response does not contain the webhook URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('forbidden', { status: 403 }),
    );

    const { default: handler } = await import('../../../../api/notify/teams.ts');
    const req = createMockReq('POST', {
      action: 'session',
      session: mockSession,
      items: [mockItem],
    });
    const res = createMockRes();

    await handler(req as never, res as never);

    const body = JSON.stringify(res._body);
    expect(body).not.toContain(TEST_WEBHOOK);
    expect(body).not.toContain('outlook.office.com');
  });

  it('network error response does not contain the webhook URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`fetch failed: ${TEST_WEBHOOK}`),
    );

    const { default: handler } = await import('../../../../api/notify/teams.ts');
    const req = createMockReq('POST', {
      action: 'item',
      item: mockItem,
    });
    const res = createMockRes();

    await handler(req as never, res as never);

    const body = JSON.stringify(res._body);
    expect(body).not.toContain(TEST_WEBHOOK);
    expect(body).not.toContain('outlook.office.com');
  });

  it('not-configured response does not leak the absence as a URL', async () => {
    delete process.env.TEAMS_WEBHOOK_URL;

    const { default: handler } = await import('../../../../api/notify/teams.ts');
    const req = createMockReq('POST', {
      action: 'session',
      session: mockSession,
      items: [mockItem],
    });
    const res = createMockRes();

    await handler(req as never, res as never);

    expect(res._statusCode).toBe(503);
    const body = JSON.stringify(res._body);
    expect(body).not.toContain(TEST_WEBHOOK);
  });

  it('HEAD response does not expose the webhook URL', async () => {
    const { default: handler } = await import('../../../../api/notify/teams.ts');
    const req = createMockReq('HEAD');
    const res = createMockRes();

    await handler(req as never, res as never);

    expect(res._statusCode).toBe(200);
    // HEAD should not have a JSON body with the URL
    const endCalls = res.end.mock.calls.flat().join('');
    expect(endCalls).not.toContain(TEST_WEBHOOK);
  });
});
