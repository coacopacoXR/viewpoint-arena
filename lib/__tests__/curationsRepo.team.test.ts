import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewDraft } from '../reviewSetupStore';

// Mock supabase before importing curationsRepo.
const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: mockSelect,
      upsert: mockUpsert,
      eq: mockEq,
    }),
  },
  supabaseConfigured: true,
}));

import { saveCuration, loadCuration } from '../curationsRepo';

function baseDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    reviewId: 'rev-1',
    title: 'Test',
    description: '',
    asset: { modelType: 'headphones', references: [] },
    viewpoints: [],
    pins: [],
    agenda: [],
    requirements: [],
    team: [{ id: 't1', name: 'Alice', role: 'Lead' }],
    labels: {},
    listed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('curationsRepo — team column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draftToRow includes team in the upsert payload', async () => {
    const draft = baseDraft();
    await saveCuration(draft);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const row = mockUpsert.mock.calls[0][0];
    expect(row.team).toEqual([{ id: 't1', name: 'Alice', role: 'Lead' }]);
  });

  it('rowToDraft defaults team to [] when the column is absent', async () => {
    // Simulate an old row without the team column.
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'Old',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // no requirements, no team
      },
      error: null,
    });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.team).toEqual([]);
    expect(draft!.requirements).toEqual([]);
  });

  it('rowToDraft preserves team when the column is present', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'With team',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        requirements: [],
        team: [{ id: 't2', name: 'Bob' }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.team).toEqual([{ id: 't2', name: 'Bob' }]);
  });
});
