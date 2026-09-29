// What the room server needs to know about a design review in order to judge a
// scene change — and how long it is allowed to keep believing it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. Batch BB enforced "who may
// change models" against the meeting host, which on a deployment with no accounts
// is the only authority there is. With accounts on, the authority is the person's
// ROLE IN THIS REVIEW, and that lives in Postgres: review_curations.owner_id and
// review_members. lib/reviews/roles.ts turns those two into a role; this file is
// how a room server, which holds an anon key and nothing else, gets them.
//
// The read is open to the anon key on purpose and is documented as such in
// docs/supabase-schema.sql: a participant's screen has to render the review's
// roster too, so this is not a privileged channel. What the room server does with
// the answer — refuse a socket message — is the enforcement; the database is the
// record.
//
// CACHED FOR 60 SECONDS PER ROOM, and the promise is what is cached rather than
// its result. Presence arrives about ten times a second and a scene change can
// arrive in a burst, so without this every import would be preceded by two HTTP
// round trips into the compose network. Sixty seconds is the plan's number and it
// is the right shape of trade: making somebody an editor takes effect within a
// minute of the owner doing it, and nobody has ever been made an editor mid-sentence.
//
// Two callers in flight at once share one lookup, which matters because the room
// server is single-threaded but not sequential: `onMessage` awaits, so a second
// SCENE_UPDATE can be handled while the first is still waiting on Postgres.

import { asMemberRole, resolveRole, type MemberRole, type Role } from '../lib/reviews/roles';

/** The review's ownership and roster, as a role decision needs them. */
export interface ReviewFacts {
  ownerId: string | null;
  members: Array<{ userId: string; role: MemberRole }>;
}

/** What a review with nothing readable looks like: nobody owns it, nobody is on it. */
export const EMPTY_REVIEW_FACTS: ReviewFacts = { ownerId: null, members: [] };

/** How long one room trusts what it read. The plan's number, not a tuned one. */
export const REVIEW_FACTS_TTL_MS = 60_000;

/** Where to read, and with what. Both come from the room's own environment. */
export interface ReviewFactsSource {
  /** PostgREST's root, as the api container reaches it (no /rest/v1 prefix). */
  restUrl: string;
  anonKey: string;
}

/** Anything that can perform a fetch. The real one in workerd, a spy in tests. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface CurationRow {
  owner_id?: unknown;
}

interface MemberRow {
  user_id?: unknown;
  role?: unknown;
}

function asStringArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Read one review's owner and roster.
 *
 * Answers EMPTY_REVIEW_FACTS on ANY failure — unreachable, refused, a body that
 * is not the array PostgREST returns, a database that has not had
 * docs/supabase-schema.sql re-applied since batch BC. That is fail-closed, and it
 * is fail-closed on purpose: with no facts, lib/reviews/roles.ts resolves a
 * signed-in person to 'participant', who may not change the models. The
 * alternative — treating an unreadable roster as "nobody is restricted" — would
 * make a PostgREST outage the moment a design review's models became editable by
 * whoever was standing in the room.
 *
 * A row whose role this code has never heard of is skipped rather than trusted,
 * which is asMemberRole's rule and the reason it exists.
 */
export async function readReviewFacts(
  reviewId: string,
  source: ReviewFactsSource,
  doFetch: FetchLike = fetch,
): Promise<ReviewFacts> {
  if (!reviewId || !source.anonKey) return EMPTY_REVIEW_FACTS;

  const headers = {
    'Authorization': `Bearer ${source.anonKey}`,
    'apikey': source.anonKey,
  };
  const id = encodeURIComponent(reviewId);
  const root = source.restUrl.replace(/\/+$/, '');

  try {
    const [curationResponse, membersResponse] = await Promise.all([
      doFetch(`${root}/review_curations?id=eq.${id}&select=owner_id`, { headers }),
      doFetch(`${root}/review_members?review_id=eq.${id}&select=user_id,role`, { headers }),
    ]);
    if (!curationResponse.ok || !membersResponse.ok) return EMPTY_REVIEW_FACTS;

    const curations = asStringArray(await curationResponse.json());
    const rows = asStringArray(await membersResponse.json());

    const first = curations[0] as CurationRow | undefined;
    const ownerId =
      first && typeof first.owner_id === 'string' && first.owner_id !== '' ? first.owner_id : null;

    const members: Array<{ userId: string; role: MemberRole }> = [];
    for (const raw of rows) {
      const row = raw as MemberRow;
      if (typeof row.user_id !== 'string' || row.user_id === '') continue;
      const role = asMemberRole(row.role);
      if (!role) continue;
      members.push({ userId: row.user_id, role });
    }
    return { ownerId, members };
  } catch {
    // A network that is down, a runtime without fetch, a JSON body that is not
    // JSON. All of them are "no facts", and the caller's answer is the safe one.
    return EMPTY_REVIEW_FACTS;
  }
}

/**
 * One room's cached view of one review's facts.
 *
 * A class rather than a module-level Map because a room server IS the per-room
 * scope: it lives as long as the room is awake, so the cache dies with it and
 * there is nothing to evict and no way for one room to read another's answer.
 *
 * `now` is injectable so a test can move past the TTL without waiting for it.
 */
export class ReviewFactsCache {
  private entry: { at: number; promise: Promise<ReviewFacts> } | null = null;

  constructor(
    private readonly reviewId: string,
    private readonly source: () => ReviewFactsSource | null,
    private readonly doFetch: FetchLike = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The facts, from the cache while they are fresh.
   *
   * `source()` is called on every miss rather than held, because the room's
   * environment is read the same way everywhere else in the server (envValue) and
   * a test sets it before the first look rather than before construction.
   *
   * A null source — no ANON_KEY, so a deployment that has not wired PostgREST up —
   * is not cached: there is nothing to remember, and caching it would hide the
   * moment the operator does wire it up for the rest of the room's life.
   */
  get(): Promise<ReviewFacts> {
    const cached = this.entry;
    if (cached && this.now() - cached.at < REVIEW_FACTS_TTL_MS) return cached.promise;

    const source = this.source();
    if (!source) return Promise.resolve(EMPTY_REVIEW_FACTS);

    const promise = readReviewFacts(this.reviewId, source, this.doFetch);
    this.entry = { at: this.now(), promise };
    return promise;
  }

  /** Forget what was read. Tests, and a future "the owner just changed it". */
  invalidate(): void {
    this.entry = null;
  }
}

/**
 * The role this signed-in person holds in the room's review.
 *
 * Kept beside the cache rather than inside it because it is the join of two facts
 * the server already has — who the token proved this connection to be, and what
 * the review says about that account — and lib/reviews/roles.ts is the only place
 * that join is written down.
 *
 * `identityMode` is 'accounts' and not the deployment's own value: the caller has
 * already decided identity is on, or it would not be asking, and the difference
 * between accounts and sso changes nothing about who may do what.
 */
export function roleFromFacts(
  facts: ReviewFacts,
  person: { accountId: string | null; isAdmin: boolean; isMeetingHost: boolean },
): Role {
  return resolveRole({
    identityMode: 'accounts',
    accountId: person.accountId,
    // No proven account is a guest, and that is the only answer available: a room
    // server on a deployment with identity on has just been handed a connection
    // whose token did not verify.
    isGuest: person.accountId === null,
    members: facts.members,
    ownerId: facts.ownerId,
    isAdmin: person.isAdmin,
    isMeetingHost: person.isMeetingHost,
  });
}
