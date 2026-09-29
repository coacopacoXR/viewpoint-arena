// Tests for lib/auditRepo.ts — listAuditEvents maps rows, returns [] on
// error, and reports the undefined-table case as its own state.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockSelectChain = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: mockSelectChain,
    }),
  },
  supabaseConfigured: true,
}));

import { listAuditEvents } from '../auditRepo';

describe('auditRepo — listAuditEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps rows and returns them as ok', async () => {
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({
      data: [
        {
          id: 1,
          at: '2026-09-23T09:14:00Z',
          action: 'admitted',
          room_id: '7E685187-abcd',
          actor_name: 'Robin',
          actor_id: 'host-1',
          subject_name: 'Maria',
          subject_id: 'guest-1',
          detail: '',
        },
      ],
      error: null,
    });
    mockSelectChain.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue(afterOrder);

    const result = await listAuditEvents();

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.events).toHaveLength(1);
      expect(result.events[0].action).toBe('admitted');
      expect(result.events[0].actor_name).toBe('Robin');
      expect(result.events[0].subject_name).toBe('Maria');
    }
  });

  it('returns ok with empty array on a generic error', async () => {
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({
      data: null,
      error: { code: '42P01', message: 'relation "audit_events" does not exist' },
    });
    mockSelectChain.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue(afterOrder);

    const result = await listAuditEvents();

    // 42P01 is the undefined-table code — distinct from a generic error.
    expect(result.status).toBe('not_configured');
  });

  it('returns ok with empty array on a non-table error', async () => {
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'insufficient privilege' },
    });
    mockSelectChain.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue(afterOrder);

    const result = await listAuditEvents();

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.events).toEqual([]);
    }
  });

  it('reports undefined table as not_configured', async () => {
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({
      data: null,
      error: { code: '42P01', message: 'undefined_table' },
    });
    mockSelectChain.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue(afterOrder);

    const result = await listAuditEvents();

    expect(result.status).toBe('not_configured');
  });
});
