import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsert = vi.fn();
const mockSingle = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'tracker_sessions') {
        return {
          insert: mockInsert,
        };
      }
      if (table === 'tracker_items') {
        return {
          insert: vi.fn().mockResolvedValue({ error: null }),
        };
      }
      return {};
    },
  },
}));

import { flushSessionToTracker } from '../trackerBridge';

describe('trackerBridge — labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('copies labels onto the session row', async () => {
    mockInsert.mockReturnValue({
      select: () => ({
        single: mockSingle.mockResolvedValue({
          data: { id: 'sess-1' },
          error: null,
        }),
      }),
    });

    await flushSessionToTracker({
      roomId: 'room-1',
      insightCards: [{
        id: 'ic-1',
        type: 'RISK',
        title: 'Test',
        description: '',
        agentId: 'SYS.OP',
        timestamp: Date.now(),
        sourceMessageIds: [],
        details: { priority: 'High', status: 'Open' },
      }],
      participantCount: 3,
      modelName: 'GPT-4o',
      labels: { product: 'Headphones', phase: 'Concept' },
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row.labels).toEqual({ product: 'Headphones', phase: 'Concept' });
  });

  it('defaults labels to {} when not provided', async () => {
    mockInsert.mockReturnValue({
      select: () => ({
        single: mockSingle.mockResolvedValue({
          data: { id: 'sess-2' },
          error: null,
        }),
      }),
    });

    await flushSessionToTracker({
      roomId: 'room-1',
      insightCards: [{
        id: 'ic-1',
        type: 'ACTION',
        title: 'Test',
        description: '',
        agentId: 'ENG.UNIT',
        timestamp: Date.now(),
        sourceMessageIds: [],
        details: { priority: 'Medium', status: 'Open' },
      }],
      participantCount: 2,
      modelName: null,
    });

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const row = mockInsert.mock.calls[0][0];
    expect(row.labels).toEqual({});
  });
});
