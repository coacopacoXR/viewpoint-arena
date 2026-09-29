// Persistence for user-defined label fields (review_label_fields table).
// Fields define grouping dimensions: one team groups by Product → Variant →
// Phase, another by Programme → Gate. The app ships suggested seeds; users
// can add, rename, reorder, and delete freely.

import { supabase } from './supabase';
import type { LabelField } from './supabase';

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2);

export async function fetchLabelFields(): Promise<LabelField[]> {
  const { data, error } = await supabase
    .from('review_label_fields')
    .select('*')
    .order('position', { ascending: true });
  if (error) {
    console.error('[labelFieldsRepo] fetchLabelFields failed:', error);
    return [];
  }
  return (data ?? []) as LabelField[];
}

export async function insertLabelField(
  field: Omit<LabelField, 'id' | 'created_at'>,
): Promise<LabelField | null> {
  const id = uid();
  const { data, error } = await supabase
    .from('review_label_fields')
    .insert({ id, name: field.name, position: field.position, values: field.values })
    .select()
    .single();
  if (error) {
    console.error('[labelFieldsRepo] insertLabelField failed:', error);
    return null;
  }
  return data as LabelField;
}

export async function updateLabelField(
  id: string,
  patch: Partial<Pick<LabelField, 'name' | 'position' | 'values'>>,
): Promise<boolean> {
  const { error } = await supabase
    .from('review_label_fields')
    .update(patch)
    .eq('id', id);
  if (error) {
    console.error('[labelFieldsRepo] updateLabelField failed:', error);
    return false;
  }
  return true;
}

export async function deleteLabelField(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('review_label_fields')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('[labelFieldsRepo] deleteLabelField failed:', error);
    return false;
  }
  return true;
}
