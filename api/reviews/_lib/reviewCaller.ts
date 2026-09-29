// Who is asking one of the /api/reviews endpoints, and what the review says about
// them.
//
// Extracted from api/reviews/lines.ts in docs/plan/15-sessions-and-variants.md
// batch BN, when api/reviews/delete.ts needed exactly the same answer and copying
// it would have put the role rule in two places — and the rule is the whole
// reason these endpoints exist rather than a browser writing the rows itself.
//
// WITH ACCOUNTS the caller is who their own verified access token says they are,
// and their role is resolved from the roster and the owner AS THE DATABASE HOLDS
// THEM RIGHT NOW, not from anything in the request body. Nothing a client sends
// can raise its own role.
//
// WITHOUT THEM (identity.mode 'none') there is no token to verify, so the caller's
// claim to be running the meeting is taken as it is. That is not a hole this
// module opens: on such an install the published anon key could until batch BL
// write review_lines outright, and the room server — which is where the claim is
// actually checked for anything that matters — has nothing better to go on either.
// What guards a 'none' install is the front-door password on the origin.
//
// SERVER ONLY: it mints service-role requests through api/_lib/postgrest.ts and
// verifies tokens with JWT_SECRET, neither of which a browser may see.

import type { VercelRequest } from '@vercel/node';
import { verifyAccessToken } from '../../../lib/auth/verifyJwt.ts';
import {
  asMemberRole,
  resolveRole,
  type ReviewMember,
  type Role,
} from '../../../lib/reviews/roles.ts';
import { postgrestFetch } from '../../_lib/postgrest.ts';

/** A value safe to interpolate into a PostgREST filter. */
export function enc(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Parse a PostgREST answer, or throw the one of three markers the handlers map to
// a status: 'store_unavailable' (503), 'upstream_error' (502).
 */
export async function json(res: Response | null, what: string, tag: string): Promise<unknown> {
  if (!res) throw new Error('store_unavailable');
  if (!res.ok) {
    console.error(`[${tag}] ${what} failed: ${res.status}`);
    throw new Error('upstream_error');
  }
  return res.json();
}

export function bearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

export function bodyRecord(req: VercelRequest): Record<string, unknown> {
  const body = req.body;
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

export function bodyString(body: Record<string, unknown>, key: string): string | null {
  const raw = body[key];
  if (typeof raw !== 'string') return null;
  // One line, because these values end up printed on a card, in a filter or in a
  // sentence shown to a room: a value with newlines in it would break the row it
  // is shown in and is never what somebody meant.
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

export interface Caller {
  /** The verified account, or null on a deployment with no accounts. */
  accountId: string | null;
  /** The display name the caller offered, for a row that records who did it. */
  name: string;
  role: Role;
}

/**
 * Who is asking, and what this review says about them.
 *
 * @param tag     what the failures are logged as, e.g. 'reviews/delete'.
 * @param reviewId the review the request is about, whose owner and roster decide.
 * @param accountsOn whether this deployment has identities at all.
 *
 * @returns the caller, or null when a deployment with accounts was asked by
 *          somebody who could not be verified — which the handler answers 401.
 * @throws 'config_unavailable' when JWT_SECRET is missing on a deployment that
 *         needs it, 'store_unavailable' / 'upstream_error' from the roster read.
 */
export async function callerFor(
  req: VercelRequest,
  body: Record<string, unknown>,
  reviewId: string,
  accountsOn: boolean,
  tag: string,
): Promise<Caller | null> {
  if (!accountsOn) {
    const isMeetingHost = body['isMeetingHost'] === true;
    return {
      accountId: null,
      name: bodyString(body, 'actorName') ?? '',
      role: resolveRole({
        identityMode: 'none',
        accountId: null,
        isGuest: false,
        members: [],
        ownerId: null,
        isAdmin: false,
        isMeetingHost,
      }),
    };
  }

  const secret = process.env.JWT_SECRET ?? '';
  if (!secret) throw new Error('config_unavailable');
  const token = bearerToken(req);
  if (!token) return null;
  const verified = await verifyAccessToken(token, secret);
  if (!verified) return null;

  const id = enc(reviewId);
  const [curationRes, membersRes] = await Promise.all([
    postgrestFetch(`review_curations?id=eq.${id}&select=owner_id`),
    postgrestFetch(`review_members?review_id=eq.${id}&select=user_id,role`),
  ]);
  if (!curationRes || !membersRes) throw new Error('store_unavailable');
  if (!curationRes.ok || !membersRes.ok) {
    console.error(`[${tag}] roster read failed: ${curationRes.status} / ${membersRes.status}`);
    throw new Error('upstream_error');
  }
  const curations = (await curationRes.json()) as Array<{ owner_id?: unknown }>;
  const rawOwner = curations[0]?.owner_id;
  const ownerId = typeof rawOwner === 'string' && rawOwner !== '' ? rawOwner : null;
  const rows = (await membersRes.json()) as Array<Record<string, unknown>>;
  const members: ReviewMember[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const userId = row['user_id'];
    if (typeof userId !== 'string' || userId === '') continue;
    const role = asMemberRole(row['role']);
    if (!role) continue;
    members.push({ userId, role });
  }

  return {
    accountId: verified.sub,
    name: bodyString(body, 'actorName') ?? '',
    // `isMeetingHost` is false: it only changes a role on a deployment with no
    // accounts, and this is one with them.
    role: resolveRole({
      identityMode: 'accounts',
      accountId: verified.sub,
      isGuest: false,
      members,
      ownerId,
      isAdmin: verified.role === 'admin',
      isMeetingHost: false,
    }),
  };
}

/** What one of the database's own functions answered. */
export interface RpcAnswer {
  ok?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/** Call a Postgres function through PostgREST and parse its jsonb answer. */
export async function rpc(
  path: string,
  body: Record<string, unknown>,
  tag: string,
): Promise<RpcAnswer> {
  const res = await postgrestFetch(path, { method: 'POST', body: JSON.stringify(body) });
  const answer = (await json(res, path, tag)) as RpcAnswer;
  return answer ?? {};
}

/**
 * The three store failures every handler answers the same way, so that a database
 * that cannot be reached is a 503 an operator can act on rather than a 500 that
 * looks like a bug in the endpoint.
 *
 * @returns the status and body to answer with, or null when `err` is not one of
 *          the three and the handler should report an internal error instead.
 */
export function storeFailure(err: unknown): { status: number; body: Record<string, string> } | null {
  const message = err instanceof Error ? err.message : 'unknown';
  if (message === 'config_unavailable') {
    return { status: 500, body: { error: 'config_unavailable' } };
  }
  if (message === 'store_unavailable') {
    return { status: 503, body: { error: 'The database could not be reached. Try again.' } };
  }
  if (message === 'upstream_error') {
    return { status: 502, body: { error: 'upstream_error' } };
  }
  return null;
}
