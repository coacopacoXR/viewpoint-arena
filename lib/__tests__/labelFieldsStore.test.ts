import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LabelField } from '../supabase';

const { mockFetch, mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../labelFieldsRepo', () => ({
  fetchLabelFields: mockFetch,
  insertLabelField: mockInsert,
  updateLabelField: mockUpdate,
  deleteLabelField: mockDelete,
}));

import { useLabelFieldsStore } from '../labelFieldsStore';

function resetStore() {
  useLabelFieldsStore.setState({ fields: [], loaded: false });
}

const field = (id: string, name: string, position: number, values: string[] = []): LabelField => ({
  id, name, position, values, created_at: '2026-09-23T00:00:00Z',
});

describe('labelFieldsStore', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('load fetches fields and sets loaded=true', async () => {
    mockFetch.mockResolvedValue([
      field('product', 'Product', 0, ['Headphones']),
      field('phase', 'Phase', 1),
    ]);
    await useLabelFieldsStore.getState().load();
    expect(useLabelFieldsStore.getState().fields).toHaveLength(2);
    expect(useLabelFieldsStore.getState().loaded).toBe(true);
  });

  it('addField appends a field and persists it', async () => {
    mockFetch.mockResolvedValue([]);
    await useLabelFieldsStore.getState().load();

    mockInsert.mockResolvedValue(field('new', 'New Field', 0));
    const result = await useLabelFieldsStore.getState().addField('New Field');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('New Field');
    expect(useLabelFieldsStore.getState().fields).toHaveLength(1);
    expect(mockInsert).toHaveBeenCalledWith({ name: 'New Field', position: 0, values: [] });
  });

  it('renameField updates the name locally and persists', async () => {
    useLabelFieldsStore.setState({
      fields: [field('f1', 'Old Name', 0)],
      loaded: true,
    });
    mockUpdate.mockResolvedValue(true);
    await useLabelFieldsStore.getState().renameField('f1', 'New Name');
    expect(useLabelFieldsStore.getState().fields[0].name).toBe('New Name');
    expect(mockUpdate).toHaveBeenCalledWith('f1', { name: 'New Name' });
  });

  it('updateFieldValues updates values locally and persists', async () => {
    useLabelFieldsStore.setState({
      fields: [field('f1', 'Product', 0, ['A'])],
      loaded: true,
    });
    mockUpdate.mockResolvedValue(true);
    await useLabelFieldsStore.getState().updateFieldValues('f1', ['A', 'B', 'C']);
    expect(useLabelFieldsStore.getState().fields[0].values).toEqual(['A', 'B', 'C']);
    expect(mockUpdate).toHaveBeenCalledWith('f1', { values: ['A', 'B', 'C'] });
  });

  it('removeField removes locally and persists', async () => {
    useLabelFieldsStore.setState({
      fields: [field('f1', 'Product', 0), field('f2', 'Phase', 1)],
      loaded: true,
    });
    mockDelete.mockResolvedValue(true);
    await useLabelFieldsStore.getState().removeField('f1');
    expect(useLabelFieldsStore.getState().fields).toHaveLength(1);
    expect(useLabelFieldsStore.getState().fields[0].id).toBe('f2');
    expect(mockDelete).toHaveBeenCalledWith('f1');
  });

  it('reorderFields updates positions locally and persists each', async () => {
    useLabelFieldsStore.setState({
      fields: [field('f1', 'A', 0), field('f2', 'B', 1), field('f3', 'C', 2)],
      loaded: true,
    });
    mockUpdate.mockResolvedValue(true);
    await useLabelFieldsStore.getState().reorderFields(['f3', 'f1', 'f2']);
    const fields = useLabelFieldsStore.getState().fields;
    expect(fields[0].id).toBe('f3');
    expect(fields[0].position).toBe(0);
    expect(fields[1].id).toBe('f1');
    expect(fields[1].position).toBe(1);
    expect(fields[2].id).toBe('f2');
    expect(fields[2].position).toBe(2);
    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });
});
