import { describe, it, expect } from 'vitest';
import {
  groupSessions,
  filterSessions,
  collectFieldValues,
  pruneGroupByChoice,
  UNASSIGNED,
} from '../trackerGrouping';
import type { TrackerSession, LabelField } from '../supabase';

function session(id: string, labels: Record<string, string> = {}): TrackerSession {
  return {
    id,
    room_id: 'r1',
    title: `Session ${id}`,
    ended_at: '2026-09-20T10:00:00Z',
    created_at: '2026-09-20T09:00:00Z',
    participant_count: 2,
    model_name: null,
    labels,
  };
}

describe('trackerGrouping — groupSessions', () => {
  it('returns a single "All sessions" node when no fields given', () => {
    const sessions = [session('s1'), session('s2')];
    const result = groupSessions(sessions, []);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('All sessions');
    expect(result[0].sessions).toHaveLength(2);
    expect(result[0].children).toEqual([]);
  });

  it('groups by a single field', () => {
    const sessions = [
      session('s1', { product: 'Headphones' }),
      session('s2', { product: 'Bicycle' }),
      session('s3', { product: 'Headphones' }),
    ];
    const result = groupSessions(sessions, ['product']);
    expect(result).toHaveLength(2);
    // Alphabetical: Bicycle, Headphones
    expect(result[0].value).toBe('Bicycle');
    expect(result[0].sessions).toHaveLength(1);
    expect(result[1].value).toBe('Headphones');
    expect(result[1].sessions).toHaveLength(2);
  });

  it('puts sessions without a value under Unassigned', () => {
    const sessions = [
      session('s1', { product: 'Headphones' }),
      session('s2', {}),
      session('s3', { product: 'Bicycle' }),
    ];
    const result = groupSessions(sessions, ['product']);
    expect(result).toHaveLength(3);
    const unassigned = result.find((n) => n.value === UNASSIGNED);
    expect(unassigned).toBeDefined();
    expect(unassigned!.sessions).toHaveLength(1);
    expect(unassigned!.sessions[0].id).toBe('s2');
  });

  it('Unassigned sorts last', () => {
    const sessions = [
      session('s1', {}),
      session('s2', { product: 'Aaa' }),
    ];
    const result = groupSessions(sessions, ['product']);
    expect(result[0].value).toBe('Aaa');
    expect(result[result.length - 1].value).toBe(UNASSIGNED);
  });

  it('groups by two fields (nested)', () => {
    const sessions = [
      session('s1', { product: 'Headphones', phase: 'Concept' }),
      session('s2', { product: 'Headphones', phase: 'Validation' }),
      session('s3', { product: 'Bicycle', phase: 'Concept' }),
    ];
    const result = groupSessions(sessions, ['product', 'phase']);
    expect(result).toHaveLength(2);
    // Bicycle subtree
    const bicycle = result.find((n) => n.value === 'Bicycle')!;
    expect(bicycle.children).toHaveLength(1);
    expect(bicycle.children[0].value).toBe('Concept');
    expect(bicycle.children[0].sessions).toHaveLength(1);
    // Headphones subtree
    const headphones = result.find((n) => n.value === 'Headphones')!;
    expect(headphones.children).toHaveLength(2);
  });

  it('groups by three fields', () => {
    const sessions = [
      session('s1', { product: 'A', variant: 'X', phase: 'P1' }),
      session('s2', { product: 'A', variant: 'X', phase: 'P2' }),
    ];
    const result = groupSessions(sessions, ['product', 'variant', 'phase']);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].children).toHaveLength(2);
  });
});

describe('trackerGrouping — filterSessions', () => {
  const sessions = [
    session('s1', { product: 'Headphones', phase: 'Concept' }),
    session('s2', { product: 'Bicycle', phase: 'Concept' }),
    session('s3', { product: 'Headphones', phase: 'Validation' }),
  ];

  it('returns all sessions when no filters', () => {
    expect(filterSessions(sessions, {})).toHaveLength(3);
  });

  it('filters by one field', () => {
    const result = filterSessions(sessions, { product: 'Headphones' });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(['s1', 's3']);
  });

  it('filters by two fields', () => {
    const result = filterSessions(sessions, { product: 'Headphones', phase: 'Concept' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s1');
  });

  it('empty filter value means no filter', () => {
    const result = filterSessions(sessions, { product: '' });
    expect(result).toHaveLength(3);
  });
});

describe('trackerGrouping — collectFieldValues', () => {
  it('collects distinct sorted values', () => {
    const sessions = [
      session('s1', { product: 'Bicycle' }),
      session('s2', { product: 'Headphones' }),
      session('s3', { product: 'Bicycle' }),
      session('s4', {}),
    ];
    const values = collectFieldValues(sessions, 'product');
    expect(values).toEqual(['Bicycle', 'Headphones']);
  });

  it('returns empty array when no sessions have the field', () => {
    const sessions = [session('s1', {})];
    expect(collectFieldValues(sessions, 'product')).toEqual([]);
  });
});

describe('trackerGrouping — pruneGroupByChoice', () => {
  const fields: LabelField[] = [
    { id: 'product', name: 'Product', position: 0, values: [], created_at: '' },
    { id: 'phase', name: 'Phase', position: 1, values: [], created_at: '' },
  ];

  it('removes field ids that no longer exist', () => {
    const result = pruneGroupByChoice(
      { fieldIds: ['product', 'deleted', 'phase'] },
      fields,
    );
    expect(result.fieldIds).toEqual(['product', 'phase']);
  });

  it('preserves order of surviving fields', () => {
    const result = pruneGroupByChoice(
      { fieldIds: ['phase', 'product'] },
      fields,
    );
    expect(result.fieldIds).toEqual(['phase', 'product']);
  });

  it('returns empty when all fields are deleted', () => {
    const result = pruneGroupByChoice(
      { fieldIds: ['gone1', 'gone2'] },
      fields,
    );
    expect(result.fieldIds).toEqual([]);
  });
});
