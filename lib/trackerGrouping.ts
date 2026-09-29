// Tracker grouping utilities. Groups sessions by up to three label fields
// in user-chosen order. Pure functions — no React, no stores.

import type { TrackerSession } from './supabase';
import type { LabelField } from './supabase';

export const UNASSIGNED = 'Unassigned';
export const LS_GROUP_BY_KEY = 'vp_tracker_group_by';
export const LS_GROUP_FILTERS_KEY = 'vp_tracker_group_filters';

export interface GroupByChoice {
  fieldIds: string[];  // up to 3 field ids, in order
}

export interface GroupFilters {
  [fieldId: string]: string;  // fieldId -> selected value (or '' for no filter)
}

// A node in the grouping tree. Leaf nodes carry the sessions that matched
// the path from root to this node.
export interface GroupNode {
  value: string;       // the label value (or UNASSIGNED)
  sessions: TrackerSession[];
  children: GroupNode[];
}

export function groupSessions(
  sessions: TrackerSession[],
  fieldIds: string[],
): GroupNode[] {
  if (fieldIds.length === 0) {
    return [{ value: 'All sessions', sessions, children: [] }];
  }
  return buildLevel(sessions, fieldIds, 0);
}

function buildLevel(
  sessions: TrackerSession[],
  fieldIds: string[],
  depth: number,
): GroupNode[] {
  if (depth >= fieldIds.length) {
    return [];
  }
  const fieldId = fieldIds[depth];
  const buckets = new Map<string, TrackerSession[]>();

  for (const s of sessions) {
    const val = s.labels?.[fieldId] || UNASSIGNED;
    const arr = buckets.get(val) ?? [];
    arr.push(s);
    buckets.set(val, arr);
  }

  const nodes: GroupNode[] = [];
  // Sort: named values alphabetically, Unassigned last
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => {
    if (a === UNASSIGNED) return 1;
    if (b === UNASSIGNED) return -1;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    const bucketSessions = buckets.get(key)!;
    nodes.push({
      value: key,
      sessions: bucketSessions,
      children: buildLevel(bucketSessions, fieldIds, depth + 1),
    });
  }
  return nodes;
}

// Filter sessions by label field values.
export function filterSessions(
  sessions: TrackerSession[],
  filters: GroupFilters,
): TrackerSession[] {
  return sessions.filter((s) => {
    for (const [fieldId, value] of Object.entries(filters)) {
      if (!value) continue;
      const sessionVal = s.labels?.[fieldId] ?? '';
      if (sessionVal !== value) return false;
    }
    return true;
  });
}

// Collect all distinct values for a field across a set of sessions.
export function collectFieldValues(
  sessions: TrackerSession[],
  fieldId: string,
): string[] {
  const vals = new Set<string>();
  for (const s of sessions) {
    const v = s.labels?.[fieldId];
    if (v) vals.add(v);
  }
  return Array.from(vals).sort();
}

// Load/save group-by choice from localStorage.
export function loadGroupByChoice(): GroupByChoice {
  try {
    const raw = localStorage.getItem(LS_GROUP_BY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.fieldIds)) return parsed;
    }
  } catch { /* ignore */ }
  return { fieldIds: [] };
}

export function saveGroupByChoice(choice: GroupByChoice): void {
  try {
    localStorage.setItem(LS_GROUP_BY_KEY, JSON.stringify(choice));
  } catch { /* ignore */ }
}

export function loadGroupFilters(): GroupFilters {
  try {
    const raw = localStorage.getItem(LS_GROUP_FILTERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch { /* ignore */ }
  return {};
}

export function saveGroupFilters(filters: GroupFilters): void {
  try {
    localStorage.setItem(LS_GROUP_FILTERS_KEY, JSON.stringify(filters));
  } catch { /* ignore */ }
}

// Prune a group-by choice: remove field ids that no longer exist in the
// field definitions (e.g., after a field was deleted).
export function pruneGroupByChoice(
  choice: GroupByChoice,
  fields: LabelField[],
): GroupByChoice {
  const validIds = new Set(fields.map((f) => f.id));
  return { fieldIds: choice.fieldIds.filter((id) => validIds.has(id)) };
}
