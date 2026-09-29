// Recording who did something irreversible (batch BY).
//
// On 2026-09-26 reviews and meetings disappeared from an install and nothing said who
// or what had removed them. Deleting a review or a session, dropping a variant and
// merging one are now written to `audit_events` — the table the room server already
// writes join and editing events to — with the verified caller as the actor.
//
// Never throws and never delays the answer beyond one request: a delete that
// happened must not be reported as failed because its log line could not be written.
// A failure is one line in the server log, without the row's contents.

import { postgrestFetch } from './postgrest.ts';

export interface AuditEvent {
  action: 'review_deleted' | 'session_deleted' | 'variant_dropped' | 'variant_merged';
  /** The design review it happened in. */
  roomId: string;
  actorId?: string | null;
  actorName?: string | null;
  subjectId?: string | null;
  subjectName?: string | null;
  /** Counts and the like, e.g. "3 sessions, 12 cards". Never secrets. */
  detail?: string | null;
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    const res = await postgrestFetch('audit_events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        action: event.action,
        room_id: event.roomId,
        actor_id: event.actorId ?? '',
        actor_name: (event.actorName ?? '').slice(0, 120),
        subject_id: event.subjectId ?? '',
        subject_name: (event.subjectName ?? '').slice(0, 200),
        detail: (event.detail ?? '').slice(0, 300),
      }),
    });
    if (!res || !res.ok) console.error(`[audit] could not record ${event.action}: ${res ? res.status : 'store unavailable'}`);
  } catch {
    console.error(`[audit] could not record ${event.action}`);
  }
}

/** "1 session, 3 cards" — the counts a delete answered with, as a sentence. */
export function countsDetail(parts: Array<[number | null | undefined, string, string]>): string {
  return parts
    .filter(([n]) => typeof n === 'number')
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(', ');
}
