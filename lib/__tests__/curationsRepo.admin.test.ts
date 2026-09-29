// Tests for the admin-screen additions to curationsRepo:
//   - listAllCurations: every review, no `listed` filter
//   - setCurationListed: updates only the `listed` column for a given id

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockSelectChain = vi.fn();
const mockEq = vi.fn();
const mockUpdate = vi.fn();
const mockUpdateEq = vi.fn();

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: mockSelectChain,
      update: mockUpdate,
      eq: mockEq,
    }),
  },
  supabaseConfigured: true,
}));

import { listAllCurations, setCurationListed } from '../curationsRepo';

describe('curationsRepo — admin additions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── listAllCurations ──────────────────────────────────────────────────────

  it('listAllCurations sends no listed filter', async () => {
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({ data: [], error: null });

    mockSelectChain.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue(afterOrder);

    await listAllCurations(100);

    // select was called (chain started), order was called, limit was called.
    // eq was NOT called — no listed filter, no id filter.
    expect(mockSelectChain).toHaveBeenCalled();
    expect(mockOrder).toHaveBeenCalledWith('updated_at', { ascending: false });
    expect(mockLimit).toHaveBeenCalledWith(100);
    expect(mockEq).not.toHaveBeenCalled();
  });

  it('listAllCurations still works on a database with no listed column', async () => {
    // PostgREST rejects the whole request for an unknown column in the SELECT
    // list, not only in a filter — so naming `listed` is itself enough to fail
    // on an install that has not re-applied docs/supabase-schema.sql. Giving up
    // would show the admin an empty install.
    const failingLimit = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column review_curations.listed does not exist' },
    });
    const legacyLimit = vi.fn().mockResolvedValue({
      data: [{
        id: 'rev-old', title: 'From before the column', description: '',
        viewpoints: [], pins: [], agenda: [],
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
      }],
      error: null,
    });
    mockSelectChain
      .mockReturnValueOnce({ order: vi.fn().mockReturnValue({ limit: failingLimit }) })
      .mockReturnValueOnce({ order: vi.fn().mockReturnValue({ limit: legacyLimit }) });

    const list = await listAllCurations(100);

    expect(failingLimit).toHaveBeenCalled();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('rev-old');
    expect(list[0].listed).toBe(true); // no column means nothing is hidden
  });

  it('listAllCurations returns both listed and link-only reviews', async () => {
    const afterOrder = { limit: mockLimit };
    mockLimit.mockResolvedValue({
      data: [
        {
          id: 'rev-1', title: 'Listed', description: '',
          viewpoints: [], pins: [], agenda: [], listed: true,
          created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
        },
        {
          id: 'rev-2', title: 'Link-only', description: '',
          viewpoints: [], pins: [], agenda: [], listed: false,
          created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
        },
      ],
      error: null,
    });

    mockSelectChain.mockReturnValue({ order: mockOrder });
    mockOrder.mockReturnValue(afterOrder);

    const list = await listAllCurations();

    expect(list).toHaveLength(2);
    expect(list[0].listed).toBe(true);
    expect(list[1].listed).toBe(false);
  });

  // ─── setCurationListed ─────────────────────────────────────────────────────

  it('setCurationListed updates only the listed column for the given id', async () => {
    mockUpdate.mockReturnValue({ eq: mockUpdateEq });
    mockUpdateEq.mockResolvedValue({ error: null });

    const ok = await setCurationListed('rev-42', false);

    expect(ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ listed: false });
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'rev-42');
  });

  it('setCurationListed returns false on error', async () => {
    mockUpdate.mockReturnValue({ eq: mockUpdateEq });
    mockUpdateEq.mockResolvedValue({ error: { message: 'fail' } });

    const ok = await setCurationListed('rev-1', true);

    expect(ok).toBe(false);
  });
});
