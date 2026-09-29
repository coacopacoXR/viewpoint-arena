// The endpoint answers with a ReviewLine (camelCase); the client must read that
// shape. Found live: the row parser (snake_case) returned null for it, so
// "Explore a variant from here" created the variant and then never opened it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

const { lineFromApi } = await import('../linesClient');

describe('lineFromApi', () => {
  it('reads the line exactly as api/reviews/lines.ts sends it', () => {
    const line = lineFromApi({
      id: '56b1875c-f19d-4081-90c5-70fdd796d35b',
      reviewId: '203698b3-33c8-4a80-9e52-1b108ae398cf',
      kind: 'variant',
      name: 'Steel hinge pin',
      letter: 'A',
      parentSessionId: '75da64bd-9796-4217-a555-ce743b8c7271',
      status: 'active',
      createdBy: null,
      createdByName: 'Olga',
      createdAt: '2026-09-25T12:00:00Z',
      closedAt: null,
    });
    expect(line).toMatchObject({
      id: '56b1875c-f19d-4081-90c5-70fdd796d35b',
      reviewId: '203698b3-33c8-4a80-9e52-1b108ae398cf',
      kind: 'variant',
      letter: 'A',
      parentSessionId: '75da64bd-9796-4217-a555-ce743b8c7271',
      status: 'active',
    });
  });

  it('answers null for nothing usable', () => {
    expect(lineFromApi(null)).toBeNull();
    expect(lineFromApi({ id: 'x' })).toBeNull();
  });
});
