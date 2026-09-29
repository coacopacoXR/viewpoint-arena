// Client-side cache for label field definitions. Loaded once from the
// database; mutations go through the repo and update the local cache.

import { create } from 'zustand';
import type { LabelField } from './supabase';
import {
  fetchLabelFields,
  insertLabelField,
  updateLabelField,
  deleteLabelField,
} from './labelFieldsRepo';

interface LabelFieldsState {
  fields: LabelField[];
  loaded: boolean;

  load: () => Promise<void>;
  addField: (name: string, values?: string[]) => Promise<LabelField | null>;
  renameField: (id: string, name: string) => Promise<void>;
  updateFieldValues: (id: string, values: string[]) => Promise<void>;
  reorderFields: (orderedIds: string[]) => Promise<void>;
  removeField: (id: string) => Promise<void>;
}

export const useLabelFieldsStore = create<LabelFieldsState>()((set, get) => ({
  fields: [],
  loaded: false,

  load: async () => {
    const fields = await fetchLabelFields();
    set({ fields, loaded: true });
  },

  addField: async (name, values = []) => {
    const { fields } = get();
    const position = fields.length;
    const field = await insertLabelField({ name, position, values });
    if (field) {
      set({ fields: [...fields, field] });
    }
    return field;
  },

  renameField: async (id, name) => {
    const ok = await updateLabelField(id, { name });
    if (ok) {
      set({ fields: get().fields.map((f) => f.id === id ? { ...f, name } : f) });
    }
  },

  updateFieldValues: async (id, values) => {
    const ok = await updateLabelField(id, { values });
    if (ok) {
      set({ fields: get().fields.map((f) => f.id === id ? { ...f, values } : f) });
    }
  },

  reorderFields: async (orderedIds) => {
    const { fields } = get();
    const reordered = orderedIds
      .map((id, idx) => {
        const f = fields.find((x) => x.id === id);
        return f ? { ...f, position: idx } : null;
      })
      .filter((f): f is LabelField => f !== null);
    // Optimistic update
    set({ fields: reordered });
    for (const f of reordered) {
      await updateLabelField(f.id, { position: f.position });
    }
  },

  removeField: async (id) => {
    const ok = await deleteLabelField(id);
    if (ok) {
      const remaining = get().fields.filter((f) => f.id !== id);
      set({ fields: remaining });
    }
  },
}));
