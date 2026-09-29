// The browser's side of api/reviews/members.ts.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH, the People tab. Everything here
// carries the signed-in person's own access token and nothing else: the endpoint
// decides what that token may do, from the review's owner_id and roster as the
// database holds them, so there is no "am I allowed" logic on this side to get
// wrong or to lift.
//
// A failure is always a sentence rather than a thrown exception, because every one
// of these calls happens behind a button somebody pressed in a meeting and the
// only useful answer is the one that can be shown to them.

import { supabase } from '../supabase';
import type { MemberRole } from './roles';

/** One roster row with the account behind it, as the People tab shows it. */
export interface ReviewPerson {
  userId: string;
  role: MemberRole;
  /** The account's name, or '' when GoTrue has no full_name for it. */
  name: string;
  email: string;
}

export interface ReviewPeople {
  ownerId: string | null;
  /** Whether the signed-in person may change this list. An editor may read it. */
  canManage: boolean;
  /** Whether the "make me the owner" line belongs on screen. An admin, and no owner. */
  canClaimOwner: boolean;
  people: ReviewPerson[];
}

/**
 * Whether a write to the roster landed, and the sentence to show if it did not.
 *
 * Shaped like `saveCuration`'s answer rather than as a discriminated union, which
 * is what the rest of this repo does and which this tsconfig needs: without
 * strictNullChecks, narrowing `{ ok: true } | { ok: false; error: string }` on the
 * boolean does not happen, so `result.error` would not type. `error` is therefore
 * optional and every caller reads it through a fallback.
 */
export interface MemberWriteResult {
  ok: boolean;
  error?: string;
}

const NOT_SIGNED_IN = 'You are not signed in, so this review has no people to show.';

/**
 * Under `vite preview` — which is what the Playwright suite serves — every
 * `/api/*` route answers 200 with index.html, because Vercel functions do not run
 * there and the SPA fallback takes the request. `response.json()` on that throws a
 * SyntaxError with nothing in it that points at the real cause, so the content type
 * is checked first and the answer is a sentence about the endpoint instead.
 *
 * The same check the capture clients make, for the same reason.
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

async function call(path: string, init: RequestInit = {}): Promise<Response | null> {
  const token = await accessToken();
  if (!token) throw new Error(NOT_SIGNED_IN);
  return fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** The error text an answer carries, or a sentence that names the status. */
async function readError(res: Response, fallback: string): Promise<string> {
  if (!isJson(res)) {
    return 'The people endpoint did not answer. Is the api running?';
  }
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // A body that is not JSON is not worth a second guess about; the status is.
  }
  return `${fallback} (${res.status})`;
}

/**
 * The review's people.
 *
 * Null when the list could not be read at all — the tab then says so rather than
 * rendering an empty list, because "nobody is on this review" and "this review
 * could not be read" are different facts and only one of them is a reason to
 * stop inviting people.
 */
export async function fetchReviewPeople(
  reviewId: string,
): Promise<{ people: ReviewPeople } | { error: string }> {
  try {
    const res = await call(`/api/reviews/members?reviewId=${encodeURIComponent(reviewId)}`);
    if (!res) return { error: NOT_SIGNED_IN };
    if (!res.ok) return { error: await readError(res, 'Could not read this review’s people') };
    if (!isJson(res)) return { error: 'The people endpoint did not answer. Is the api running?' };

    const body = (await res.json()) as {
      ownerId?: unknown;
      canManage?: unknown;
      canClaimOwner?: unknown;
      members?: unknown;
    };
    const people: ReviewPerson[] = [];
    for (const raw of Array.isArray(body.members) ? body.members : []) {
      const row = raw as Record<string, unknown>;
      const userId = row['userId'];
      const role = row['role'];
      if (typeof userId !== 'string' || userId === '') continue;
      if (role !== 'owner' && role !== 'editor' && role !== 'participant') continue;
      people.push({
        userId,
        role,
        name: typeof row['name'] === 'string' ? row['name'] : '',
        email: typeof row['email'] === 'string' ? row['email'] : '',
      });
    }
    return {
      people: {
        ownerId: typeof body.ownerId === 'string' && body.ownerId !== '' ? body.ownerId : null,
        canManage: body.canManage === true,
        canClaimOwner: body.canClaimOwner === true,
        people,
      },
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not read this review’s people' };
  }
}

/** What a write to the roster can ask for. Mirrors the endpoint's `action`. */
export type MemberWrite =
  | { action: 'add'; email: string; role: MemberRole }
  | { action: 'setRole'; userId: string; role: MemberRole }
  | { action: 'remove'; userId: string }
  | { action: 'claimOwner' };

/**
 * Change the roster.
 *
 * The caller re-reads with fetchReviewPeople rather than patching its own copy:
 * the endpoint is the only place that knows what a write actually did — an add
 * resolves an email to an account id, and a claim sets a column this browser
 * cannot read back any other way.
 */
export async function writeReviewMember(
  reviewId: string,
  write: MemberWrite,
): Promise<MemberWriteResult> {
  try {
    const res = await call('/api/reviews/members', {
      method: 'POST',
      body: JSON.stringify({ reviewId, ...write }),
    });
    if (!res) return { ok: false, error: NOT_SIGNED_IN };
    if (!res.ok) return { ok: false, error: await readError(res, 'That change was refused') };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'That change was refused' };
  }
}
