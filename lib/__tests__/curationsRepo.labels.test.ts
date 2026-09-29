import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewDraft } from '../reviewSetupStore';

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockMaybeSingle = vi.fn();
const mockSelectChain = vi.fn();
const mockEq = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: mockSelectChain,
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
    team: [],
    labels: { product: 'Headphones', phase: 'Concept' },
    listed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('curationsRepo — labels column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draftToRow includes labels in the upsert payload', async () => {
    const draft = baseDraft();
    await saveCuration(draft);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const row = mockUpsert.mock.calls[0][0];
    expect(row.labels).toEqual({ product: 'Headphones', phase: 'Concept' });
  });

  it('rowToDraft defaults labels to {} when the column is absent', async () => {
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
        // no labels, no requirements, no team
      },
      error: null,
    });
    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.labels).toEqual({});
  });

  it('rowToDraft preserves labels when the column is present', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'With labels',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        requirements: [],
        team: [],
        labels: { product: 'Bicycle', variant: 'Mk I' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.labels).toEqual({ product: 'Bicycle', variant: 'Mk I' });
  });
});
