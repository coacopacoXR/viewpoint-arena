// Supabase-backed read path for the audit_events table. Written by the room
// server (party/room.server.ts) via PostgREST; read here by the admin screen.
//
// The table may not exist on installs that have not re-applied
// docs/supabase-schema.sql since the audit batch landed. PostgREST answers
// 42P01 (undefined_table) for the whole query in that case, which we surface
// as a distinct state rather than an empty list — the admin screen tells the
// operator which of the two reasons the log is empty.

import { supabase } from './supabase';

export interface AuditEvent {
  id: number;
  at: string;
  action: string;
  room_id: string;
  actor_name: string;
  actor_id: string;
  subject_name: string;
  subject_id: string;
  detail: string;
}

export type AuditListResult =
  | { status: 'ok'; events: AuditEvent[] }
  | { status: 'not_configured' };

// PostgREST's code for "relation does not exist" — an install whose database
// predates the audit_events table and has not re-applied the schema.
const UNDEFINED_TABLE = '42P01';

export async function listAuditEvents(limit = 50): Promise<AuditListResult> {
  const { data, error } = await supabase
    .from('audit_events')
    .select('*')
    .order('at', { ascending: false })
    .limit(limit);

  if (error) {
    if (error.code === UNDEFINED_TABLE) {
      return { status: 'not_configured' };
    }
    console.error('[auditRepo] listAuditEvents failed:', error);
    return { status: 'ok', events: [] };
  }

  return { status: 'ok', events: (data ?? []) as AuditEvent[] };
}
