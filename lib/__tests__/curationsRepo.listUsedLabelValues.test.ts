import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLimit = vi.fn();
const mockOrder = vi.fn(() => ({ limit: mockLimit }));
const mockSelect = vi.fn(() => ({ order: mockOrder }));

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({ select: mockSelect }),
  },
  supabaseConfigured: true,
}));

import { listUsedLabelValues } from '../curationsRepo';

describe('listUsedLabelValues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects distinct values per field id, ignores empty strings, sorts alphabetically', async () => {
    mockLimit.mockResolvedValue({
      data: [
        { labels: { product: 'Headphones', phase: 'Concept' } },
        { labels: { product: 'Bicycle', phase: 'Concept' } },
        { labels: { product: 'Headphones', phase: 'Detail' } },
        { labels: { product: '', phase: 'Review' } },
      ],
      error: null,
    });

    const result = await listUsedLabelValues();

    expect(result).toEqual({
      product: ['Bicycle', 'Headphones'],
      phase: ['Concept', 'Detail', 'Review'],
    });
  });

  it('a review with no labels does not break it', async () => {
    mockLimit.mockResolvedValue({
      data: [
        { labels: null },
        { labels: undefined },
        { labels: {} },
        { labels: { product: 'A' } },
      ],
      error: null,
    });

    const result = await listUsedLabelValues();

    expect(result).toEqual({ product: ['A'] });
  });

  it('returns an empty map when there are no rows', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null });

    const result = await listUsedLabelValues();

    expect(result).toEqual({});
  });

  it('falls back when the labels column does not exist (42703)', async () => {
    mockLimit
      .mockResolvedValueOnce({
        data: null,
        error: { code: '42703', message: 'column does not exist' },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'rev-1' }],
        error: null,
      });

    const result = await listUsedLabelValues();

    expect(result).toEqual({});
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});
