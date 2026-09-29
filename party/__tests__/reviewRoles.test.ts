// Tests for party/reviewRoles.ts — how a room server, which holds an anon key and
// nothing else, learns who owns a design review and who is on its roster, and how
// long it is allowed to keep believing it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BC. The enforcement these facts feed
// is tested against the server itself in room.server.test.ts; what is here is the
// read, the cache, and the join into a role.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  EMPTY_REVIEW_FACTS,
  REVIEW_FACTS_TTL_MS,
  ReviewFactsCache,
  readReviewFacts,
  roleFromFacts,
  type FetchLike,
  type ReviewFactsSource,
} from '../reviewRoles';

const SOURCE: ReviewFactsSource = { restUrl: 'http://rest:3000', anonKey: 'anon-key' };
const OWNER = '6f1a2b3c-0000-4000-8000-000000000001';
const EDITOR = '6f1a2b3c-0000-4000-8000-000000000002';
const STRANGER = '6f1a2b3c-0000-4000-8000-000000000003';

/** A fetch that answers each PostgREST table from a map of URL-substring → body. */
function fakeFetch(bodies: Record<string, unknown>, options: { ok?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const doFetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (options.throws) throw new Error('network down');
    const match = Object.keys(bodies).find((needle) => url.includes(needle));
    return {
      ok: options.ok ?? true,
      status: options.ok === false ? 500 : 200,
      json: async () => (match === undefined ? [] : bodies[match]),
    };
  };
  return { doFetch, calls };
}

// ─── The read ───────────────────────────────────────────────────────────────

describe('readReviewFacts', () => {
  it('reads the owner and the roster, at the PostgREST root, with the anon key', async () => {
    const { doFetch, calls } = fakeFetch({
      'review_curations': [{ owner_id: OWNER }],
      'review_members': [
        { user_id: OWNER, role: 'owner' },
        { user_id: EDITOR, role: 'editor' },
      ],
    });

    const facts = await readReviewFacts('review-1', SOURCE, doFetch);

    expect(facts).toEqual({
      ownerId: OWNER,
      members: [
        { userId: OWNER, role: 'owner' },
        { userId: EDITOR, role: 'editor' },
      ],
    });
    expect(calls).toHaveLength(2);
    // The ROOT, not `/rest/v1/`: that prefix is what nginx-proxy rewrites away for
    // a browser, and asking PostgREST for it from inside the compose network is a
    // 404. The audit write in room.server.ts depends on the same fact.
    expect(calls[0].url.startsWith('http://rest:3000/review_curations?')).toBe(true);
    expect(calls[0].url).toContain('id=eq.review-1');
    expect(calls[1].url.startsWith('http://rest:3000/review_members?')).toBe(true);
    expect(calls[1].url).toContain('review_id=eq.review-1');
    for (const call of calls) {
      expect(call.headers['Authorization']).toBe('Bearer anon-key');
      expect(call.headers['apikey']).toBe('anon-key');
    }
  });

  it('strips a trailing slash off the REST_URL rather than asking for a double one', async () => {
    const { doFetch, calls } = fakeFetch({});
    await readReviewFacts('review-1', { restUrl: 'http://rest:3000/', anonKey: 'k' }, doFetch);
    expect(calls[0].url).toContain('http://rest:3000/review_curations');
  });

  it('encodes a review id that is not URL-safe', async () => {
    const { doFetch, calls } = fakeFetch({});
    await readReviewFacts('a review & a half', SOURCE, doFetch);
    expect(calls[0].url).toContain('id=eq.a%20review%20%26%20a%20half');
  });

  it('reads a review with no owner and no roster as exactly that', async () => {
    const { doFetch } = fakeFetch({ review_curations: [{}], review_members: [] });
    expect(await readReviewFacts('review-1', SOURCE, doFetch)).toEqual(EMPTY_REVIEW_FACTS);
  });

  it('skips a roster row whose role this code has never heard of', async () => {
    // A hand-edited value, or a role a later version adds. Reading it as the most
    // permissive thing a nullish branch would fall back to is how a permission
    // gets granted by accident.
    const { doFetch } = fakeFetch({
      review_curations: [],
      review_members: [
        { user_id: EDITOR, role: 'superuser' },
        { user_id: STRANGER, role: 3 },
        { user_id: OWNER, role: 'participant' },
        { role: 'owner' },
        { user_id: '', role: 'owner' },
      ],
    });

    const facts = await readReviewFacts('review-1', SOURCE, doFetch);
    expect(facts.members).toEqual([{ userId: OWNER, role: 'participant' }]);
  });

  it('answers no facts when the database refuses, rather than guessing', async () => {
    const { doFetch } = fakeFetch({}, { ok: false });
    expect(await readReviewFacts('review-1', SOURCE, doFetch)).toEqual(EMPTY_REVIEW_FACTS);
  });

  it('answers no facts when the read throws', async () => {
    const { doFetch } = fakeFetch({}, { throws: true });
    expect(await readReviewFacts('review-1', SOURCE, doFetch)).toEqual(EMPTY_REVIEW_FACTS);
  });

  it('answers no facts when a body is not the array PostgREST returns', async () => {
    // An SPA fallback or a proxy in front of PostgREST answers an API path with
    // 200 and something that is not our JSON.
    const { doFetch } = fakeFetch({ review_curations: '<html></html>', review_members: null });
    expect(await readReviewFacts('review-1', SOURCE, doFetch)).toEqual(EMPTY_REVIEW_FACTS);
  });

  it('does not reach the network with no review id or no key', async () => {
    const { doFetch, calls } = fakeFetch({ review_curations: [{ owner_id: OWNER }] });
    expect(await readReviewFacts('', SOURCE, doFetch)).toEqual(EMPTY_REVIEW_FACTS);
    expect(await readReviewFacts('review-1', { restUrl: 'http://rest:3000', anonKey: '' }, doFetch))
      .toEqual(EMPTY_REVIEW_FACTS);
    expect(calls).toHaveLength(0);
  });
});

// ─── The cache ──────────────────────────────────────────────────────────────

describe('ReviewFactsCache', () => {
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    clock = 0;
  });

  function cache(bodies: Record<string, unknown>, source: ReviewFactsSource | null = SOURCE) {
    const { doFetch, calls } = fakeFetch(bodies);
    const cacheInstance = new ReviewFactsCache('review-1', () => source, doFetch, now);
    return { cacheInstance, calls };
  }

  it('reads once and answers from memory for the next minute', async () => {
    const { cacheInstance, calls } = cache({ review_curations: [{ owner_id: OWNER }], review_members: [] });

    await cacheInstance.get();
    clock += REVIEW_FACTS_TTL_MS - 1;
    await cacheInstance.get();
    await cacheInstance.get();

    expect(calls).toHaveLength(2); // one read of each table, once
  });

  it('reads again once the sixty seconds are up', async () => {
    const { cacheInstance, calls } = cache({ review_curations: [], review_members: [] });

    await cacheInstance.get();
    clock += REVIEW_FACTS_TTL_MS;
    await cacheInstance.get();

    expect(calls).toHaveLength(4);
  });

  it('shares one read between two callers who arrive while it is in flight', async () => {
    // onMessage awaits, so a second SCENE_UPDATE can be handled before the first
    // lookup has answered. Two reads of the roster for one import burst is the
    // waste the promise cache exists to prevent.
    const { cacheInstance, calls } = cache({ review_curations: [], review_members: [] });

    const [first, second] = await Promise.all([cacheInstance.get(), cacheInstance.get()]);

    expect(calls).toHaveLength(2);
    expect(first).toBe(second);
  });

  it('picks up a change to the roster after the TTL, which is how making somebody an editor takes effect', async () => {
    const bodies: Record<string, unknown> = { review_curations: [], review_members: [] };
    const { cacheInstance } = cache(bodies);

    expect((await cacheInstance.get()).members).toEqual([]);
    bodies['review_members'] = [{ user_id: EDITOR, role: 'editor' }];
    clock += REVIEW_FACTS_TTL_MS;
    expect((await cacheInstance.get()).members).toEqual([{ userId: EDITOR, role: 'editor' }]);
  });

  it('does not cache a missing source, so wiring ANON_KEY up takes effect without a restart', async () => {
    let source: ReviewFactsSource | null = null;
    const { doFetch, calls } = fakeFetch({ review_curations: [{ owner_id: OWNER }], review_members: [] });
    const cacheInstance = new ReviewFactsCache('review-1', () => source, doFetch, now);

    expect(await cacheInstance.get()).toEqual(EMPTY_REVIEW_FACTS);
    expect(await cacheInstance.get()).toEqual(EMPTY_REVIEW_FACTS);
    expect(calls).toHaveLength(0);

    source = SOURCE;
    expect((await cacheInstance.get()).ownerId).toBe(OWNER);
  });

  it('forgets what it read when told to', async () => {
    const { cacheInstance, calls } = cache({ review_curations: [], review_members: [] });

    await cacheInstance.get();
    cacheInstance.invalidate();
    await cacheInstance.get();

    expect(calls).toHaveLength(4);
  });

  it('caches a failure too, so an unreachable database is not asked ten times a second', async () => {
    const { doFetch, calls } = fakeFetch({}, { throws: true });
    const cacheInstance = new ReviewFactsCache('review-1', () => SOURCE, doFetch, now);

    await cacheInstance.get();
    await cacheInstance.get();

    expect(calls).toHaveLength(2);
  });
});

// ─── The join into a role ───────────────────────────────────────────────────

describe('roleFromFacts', () => {
  const facts = {
    ownerId: OWNER,
    members: [
      { userId: OWNER, role: 'owner' as const },
      { userId: EDITOR, role: 'editor' as const },
    ],
  };

  it('makes the account the review names its owner', () => {
    expect(roleFromFacts(facts, { accountId: OWNER, isAdmin: false, isMeetingHost: false })).toBe('owner');
  });

  it('makes an admin the owner of a review somebody else owns', () => {
    expect(roleFromFacts(facts, { accountId: STRANGER, isAdmin: true, isMeetingHost: false })).toBe('owner');
  });

  it('takes the roster role for everybody else on it', () => {
    expect(roleFromFacts(facts, { accountId: EDITOR, isAdmin: false, isMeetingHost: false })).toBe('editor');
  });

  it('makes a signed-in person who is not on the roster a participant', () => {
    expect(roleFromFacts(facts, { accountId: STRANGER, isAdmin: false, isMeetingHost: false })).toBe('participant');
  });

  it('makes a connection with no verified account a guest, whoever it says it is', () => {
    // The room server only passes an accountId it proved from a token, so this is
    // the forged-token and the expired-token case.
    expect(roleFromFacts(facts, { accountId: null, isAdmin: false, isMeetingHost: true })).toBe('guest');
  });

  it('makes the meeting host of an ownerless review a participant, not an editor', () => {
    // With accounts, arriving first is not authority. Without them, it is — and
    // that case never reaches here, because a room server on identity.mode 'none'
    // builds no cache and asks for no role.
    expect(
      roleFromFacts({ ownerId: null, members: [] }, { accountId: STRANGER, isAdmin: false, isMeetingHost: true }),
    ).toBe('participant');
  });

  it('reads no facts at all as nobody owning the review and nobody on it', async () => {
    const { doFetch } = fakeFetch({}, { ok: false });
    const factsEmpty = await readReviewFacts('review-1', SOURCE, doFetch);
    expect(roleFromFacts(factsEmpty, { accountId: STRANGER, isAdmin: false, isMeetingHost: false }))
      .toBe('participant');
  });
});
