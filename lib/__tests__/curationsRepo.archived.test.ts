// Archived design reviews stay out of the lobby — but a link to one still opens
// it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BE put an `archived` column on
// review_curations and an Archive button in the admin console: "archived
// reviews are hidden from the lobby but kept". This pins both halves of "hidden
// but kept", at the level the queries are built:
//
//   * listRecentCurations — the lobby's Saved design reviews — asks the
//     database for rows that are NOT archived, so one can never come back in
//     the list (and the `limit` counts rows that will be shown);
//   * listArchivedIds answers the same question for a set of ids, which is how
//     "Your design reviews" drops them: that list is keyed on the person and
//     read out of review_participants, which has no `archived` to filter on;
//   * loadCuration and getCurationSummary never mention the column, so
//     /room/:id and the lobby's invited preview still open a review an admin
//     has put away.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** One recorded link of a PostgREST chain. */
interface Step {
  method: string;
  args: unknown[];
}

/** What a query answers with. One per query, consumed in order. */
interface QueryResult {
  data: unknown;
  error: unknown;
}

const { queries, results } = vi.hoisted(() => ({
  queries: [] as Array<Step[]>,
  results: [] as Array<{ data: unknown; error: unknown }>,
}));

vi.mock('../supabase', () => {
  const METHODS = ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle'] as const;

  function builder(log: Step[]) {
    // A supabase-js builder is thenable, so a query settles wherever the repo
    // stops chaining — `.limit(…)`, `.maybeSingle()`, or the builder itself.
    const chain: Record<string, unknown> = {
      then: (onFulfilled: (value: QueryResult) => unknown) =>
        onFulfilled(results.shift() ?? { data: null, error: null }),
    };
    for (const method of METHODS) {
      chain[method] = (...args: unknown[]) => {
        log.push({ method, args });
        return builder(log);
      };
    }
    return chain;
  }

  return {
    supabase: {
      from: (table: string) => {
        const log: Step[] = [{ method: 'from', args: [table] }];
        queries.push(log);
        return builder(log);
      },
    },
    supabaseConfigured: true,
  };
});

import {
  listRecentCurations,
  listArchivedIds,
  loadCuration,
  getCurationSummary,
} from '../curationsRepo';

/** The arguments of every `method` in one recorded query. */
function argsOf(query: Step[], method: string): unknown[][] {
  return query.filter((step) => step.method === method).map((step) => step.args);
}

/** A `review_curations` row an admin has put away. */
const ARCHIVED_ROW = {
  id: 'rev-archived',
  title: 'Put away by an admin',
  description: '',
  asset: { modelType: 'headphones', references: [] },
  viewpoints: [],
  pins: [],
  agenda: [],
  requirements: [],
  team: [],
  labels: {},
  listed: true,
  archived: true,
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-22T00:00:00Z',
};

describe('curationsRepo — archived column', () => {
  beforeEach(() => {
    queries.length = 0;
    results.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── the lobby's Saved design reviews ────────────────────────────────────

  it('listRecentCurations asks for rows that are not archived', async () => {
    results.push({ data: [], error: null });

    await listRecentCurations(8);

    // One query: the filters are the database's, so there is nothing to retry
    // and nothing to drop afterwards.
    expect(queries).toHaveLength(1);
    expect(argsOf(queries[0], 'eq')).toEqual([
      ['listed', true],
      ['archived', false],
    ]);
    expect(argsOf(queries[0], 'limit')).toEqual([[8]]);
  });

  it('listRecentCurations keeps listing on a database with no archived column', async () => {
    // `listed` shipped a day before `archived`, so an install can have one and
    // not the other. Falling straight back to the unfiltered read would put
    // every link-only review back in the lobby; the middle step keeps the
    // `listed` filter this database does understand.
    results.push(
      {
        data: null,
        error: { code: '42703', message: 'column review_curations.archived does not exist' },
      },
      {
        data: [{ ...ARCHIVED_ROW, archived: undefined, title: 'Listed and kept' }],
        error: null,
      },
    );

    const list = await listRecentCurations(8);

    expect(queries).toHaveLength(2);
    expect(argsOf(queries[1], 'eq')).toEqual([['listed', true]]);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('Listed and kept');
  });

  // ─── the lobby's Your design reviews ─────────────────────────────────────

  it('listArchivedIds answers with the archived ones among the ids it is given', async () => {
    results.push({ data: [{ id: 'room-2' }], error: null });

    const archived = await listArchivedIds(['room-1', 'room-2', 'room-3']);

    expect([...archived]).toEqual(['room-2']);
    expect(queries).toHaveLength(1);
    expect(argsOf(queries[0], 'eq')).toEqual([['archived', true]]);
    expect(argsOf(queries[0], 'in')).toEqual([['id', ['room-1', 'room-2', 'room-3']]]);
  });

  it('listArchivedIds makes no query at all for an empty list', async () => {
    // Nothing took part in nothing: the lobby asks this before it has any rows,
    // and an `.in('id', [])` is a query that can only answer "none of them".
    expect(await listArchivedIds([])).toEqual(new Set<string>());
    expect(queries).toHaveLength(0);
  });

  it('listArchivedIds hides nothing when the read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    results.push({
      data: null,
      error: { code: '42703', message: 'column review_curations.archived does not exist' },
    });

    // A database that has never heard of the column has nothing archived in
    // it, so "hide nothing" is the right answer rather than an empty list.
    expect(await listArchivedIds(['room-1'])).toEqual(new Set<string>());
  });

  // ─── the read paths a link uses ──────────────────────────────────────────

  it('loadCuration still opens a review an admin has put away', async () => {
    results.push({ data: { ...ARCHIVED_ROW }, error: null });

    const draft = await loadCuration('rev-archived');

    expect(draft).not.toBeNull();
    expect(draft!.title).toBe('Put away by an admin');
    expect(draft!.reviewId).toBe('rev-archived');
    // The only filter is the id: `archived` is not mentioned, so there is
    // nothing for the row to fail.
    expect(queries).toHaveLength(1);
    expect(argsOf(queries[0], 'eq')).toEqual([['id', 'rev-archived']]);
  });

  it('getCurationSummary still previews an archived review', async () => {
    results.push({ data: { ...ARCHIVED_ROW }, error: null });

    const summary = await getCurationSummary('rev-archived');

    expect(summary).not.toBeNull();
    expect(summary!.title).toBe('Put away by an admin');
    expect(queries).toHaveLength(1);
    expect(argsOf(queries[0], 'eq')).toEqual([['id', 'rev-archived']]);
  });
});
