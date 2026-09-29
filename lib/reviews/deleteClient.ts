// The browser's side of api/reviews/delete.ts: delete a design review, or delete
// one of its sessions.
//
// docs/plan/15-sessions-and-variants.md batch BN. Shaped like
// lib/reviews/linesClient.ts, and for the same reasons: the signed-in person's own
// access token is attached when this browser holds one, nothing on this side
// decides anything, and an answer is always a value rather than a thrown exception
// — every one of these calls happens behind a button somebody pressed, and the only
// useful answer is the sentence that can be shown to them.
//
// WHY NOT A DELETE AT SUPABASE, which is what lib/curationsRepo.deleteCuration used
// to make. docs/supabase-schema.sql no longer lets the published anon key delete a
// review_curations row, and never let it delete a tracker_sessions row at all. The
// removal is `delete_review` / `delete_review_session`, executable by the service
// role alone, so that the whole review goes in one transaction instead of leaving
// its meetings, cards, lines and roster behind with no review to be opened on.

import { supabase } from '../supabase';
import { getStoredIdentity } from '../identity';

/**
 * Whether a delete landed.
 *
 * `error` optional rather than a discriminated union for the reason linesClient
 * gives: this tsconfig does not narrow `{ ok: true } | { ok: false; error: string }`
 * on the boolean, so `result.error` would not type.
 */
export interface DeleteResult {
  ok: boolean;
  /** The sentence to show when it did not land. */
  error?: string;
  /** How many cards went with it, for the sentence that says it worked. */
  items?: number;
  /** How many meetings went with a deleted review. */
  sessions?: number;
}

/** What this browser knows that the endpoint cannot work out. */
export interface DeleteContext {
  /**
   * Whether this browser is running the meeting. Read only on a deployment whose
   * identity.mode is 'none', where there is no token to verify — see
   * api/reviews/delete.ts for what such an install has to go on instead.
   */
  isMeetingHost?: boolean;
}

const REFUSED = 'That could not be deleted.';

/**
 * Under `vite preview` — which is what the Playwright suite serves — every `/api/*`
 * route answers 200 with index.html, because Vercel functions do not run there.
 * `response.json()` on that throws a SyntaxError with nothing in it that points at
 * the real cause, so the content type is checked first. The same check
 * lib/reviews/linesClient.ts makes.
 */
function isJson(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('application/json');
}

async function accessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Post to the endpoint.
 *
 * The token is attached when this browser holds one and omitted when it does not,
 * rather than refused outright: an install with no accounts has no session to hold,
 * and the lobby's delete button has to keep working there.
 */
async function call(body: Record<string, unknown>): Promise<Response | null> {
  const token = await accessToken();
  const name = getStoredIdentity()?.name?.trim() || '';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch('/api/reviews/delete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, actorName: name }),
  });
}

async function post(body: Record<string, unknown>): Promise<DeleteResult> {
  try {
    const res = await call(body);
    if (!res) return { ok: false, error: 'The delete endpoint could not be reached.' };
    if (!isJson(res)) {
      return { ok: false, error: 'The delete endpoint did not answer. Is the api running?' };
    }
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && answer?.ok === true) {
      return {
        ok: true,
        items: typeof answer['items'] === 'number' ? answer['items'] : undefined,
        sessions: typeof answer['sessions'] === 'number' ? answer['sessions'] : undefined,
      };
    }
    const error =
      typeof answer?.['error'] === 'string' && answer['error'] !== '' ? (answer['error'] as string) : null;
    return { ok: false, error: error ?? `${REFUSED} (${res.status})` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : REFUSED };
  }
}

/**
 * Delete a whole design review: its meetings, the cards raised in them, its lines,
 * its roster, its stored revisions and its own row.
 *
 * Stored model FILES stay, because they are content-addressed and another review
 * may be showing the same bytes.
 */
export async function deleteReview(
  reviewId: string,
  context: DeleteContext = {},
): Promise<DeleteResult> {
  return post({
    action: 'review',
    reviewId,
    isMeetingHost: context.isMeetingHost === true,
  });
}

/**
 * Delete one meeting of a design review, with its cards.
 *
 * Refused with the endpoint's own sentence when a variant starts from that meeting:
 * the map draws the variant leaving from it, and which of the two should go is a
 * decision for the people exploring the variant. Session numbers are not reused and
 * not renumbered, so the meetings after this one keep saying what they always said.
 */
export async function deleteSession(
  reviewId: string,
  sessionId: string,
  context: DeleteContext = {},
): Promise<DeleteResult> {
  return post({
    action: 'session',
    reviewId,
    sessionId,
    isMeetingHost: context.isMeetingHost === true,
  });
}
