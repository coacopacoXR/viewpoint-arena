import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewDraft } from '../reviewSetupStore';

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockMaybeSingle = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
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

import {
  saveCuration,
  loadCuration,
  listRecentCurations,
  getCurationSummary,
} from '../curationsRepo';

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
    labels: {},
    listed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('curationsRepo — listed column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── rowToDraft ──────────────────────────────────────────────────────────

  it('rowToDraft preserves listed: false', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'Hidden',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        requirements: [],
        team: [],
        labels: {},
        listed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.listed).toBe(false);
  });

  it('rowToDraft preserves listed: true', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'Visible',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        requirements: [],
        team: [],
        labels: {},
        listed: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.listed).toBe(true);
  });

  it('rowToDraft defaults listed to true when the field is absent', async () => {
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'Old install',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // no listed, no requirements, no team, no labels
      },
      error: null,
    });
    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle });

    const draft = await loadCuration('rev-1');
    expect(draft).not.toBeNull();
    expect(draft!.listed).toBe(true);
  });

  // ─── draftToRow ──────────────────────────────────────────────────────────

  it('draftToRow writes the listed flag', async () => {
    const draft = baseDraft({ listed: false });
    await saveCuration(draft);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const row = mockUpsert.mock.calls[0][0];
    expect(row.listed).toBe(false);
  });

  it('draftToRow writes listed: true', async () => {
    const draft = baseDraft({ listed: true });
    await saveCuration(draft);
    const row = mockUpsert.mock.calls[0][0];
    expect(row.listed).toBe(true);
  });

  // ─── listRecentCurations sends the filter ────────────────────────────────

  it('listRecentCurations sends .eq(listed, true)', async () => {
    // `.eq` answers with itself: listRecentCurations chains a second filter
    // (`.eq('archived', false)`) on the way to `.order`, and this test is about
    // the `listed` one — see curationsRepo.archived.test.ts for the other.
    const afterEq = { eq: mockEq, order: mockOrder };
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({ data: [], error: null });

    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue(afterEq);
    mockOrder.mockReturnValue(afterOrder);

    await listRecentCurations(8);

    expect(mockEq).toHaveBeenCalledWith('listed', true);
    expect(mockOrder).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(mockLimit).toHaveBeenCalledWith(8);
  });

  it('still lists reviews on a database that has no listed column yet', async () => {
    // An install that has not re-applied docs/supabase-schema.sql gets
    // "column review_curations.listed does not exist" (42703) for the whole
    // query. Returning [] there would empty the lobby of every saved review
    // over a flag that database has never heard of. Such a database has not
    // heard of `archived` either, so both filtered attempts come back 42703 and
    // the third — no filters, no `listed` column — is the one that answers.
    const failingLimit = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column review_curations.listed does not exist' },
    });
    const failing = { eq: mockEq, order: vi.fn().mockReturnValue({ limit: failingLimit }) };
    mockSelectChain
      .mockReturnValueOnce(failing)               // listed + archived
      .mockReturnValueOnce(failing)               // listed on its own
      .mockReturnValueOnce({ order: mockOrder }); // neither

    mockEq.mockReturnValue(failing);
    mockOrder.mockReturnValue({ limit: mockLimit });
    mockLimit.mockResolvedValue({
      data: [{
        id: 'rev-old', title: 'From before the column', description: '',
        viewpoints: [], pins: [], agenda: [],
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
      }],
      error: null,
    });

    const list = await listRecentCurations(8);

    expect(failingLimit).toHaveBeenCalledTimes(2);  // it did try both filters first
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('rev-old');
  });

  // ─── getCurationSummary / loadCuration do NOT filter on listed ───────────

  it('getCurationSummary does not send a listed filter', async () => {
    const afterIdEq = { maybeSingle: mockMaybeSingle };
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'Hidden',
        description: '',
        viewpoints: [],
        pins: [],
        agenda: [],
        listed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });

    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue(afterIdEq);

    const summary = await getCurationSummary('rev-1');

    expect(summary).not.toBeNull();
    expect(summary!.title).toBe('Hidden');
    // eq was called exactly once — with 'id', not 'listed'.
    expect(mockEq).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith('id', 'rev-1');
  });

  it('loadCuration does not send a listed filter', async () => {
    const afterIdEq = { maybeSingle: mockMaybeSingle };
    mockMaybeSingle.mockResolvedValue({
      data: {
        id: 'rev-1',
        title: 'Link-only',
        description: '',
        asset: { modelType: 'headphones', references: [] },
        viewpoints: [],
        pins: [],
        agenda: [],
        listed: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      error: null,
    });

    mockSelectChain.mockReturnValue({ eq: mockEq });
    mockEq.mockReturnValue(afterIdEq);

    const draft = await loadCuration('rev-1');

    expect(draft).not.toBeNull();
    expect(draft!.listed).toBe(false);
    expect(mockEq).toHaveBeenCalledTimes(1);
    expect(mockEq).toHaveBeenCalledWith('id', 'rev-1');
  });
});
