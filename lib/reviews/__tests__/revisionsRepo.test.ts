// Tests for lib/reviews/revisionsRepo.ts — the review's stored model history:
// what one write carries, what a read answers when the table is not there, the
// scene that history means, and the two joins the tracker depends on (which
// revision was on screen, and which one a pointed-at part belongs to).
//
// docs/plan/14-rooms-models-admin-ai.md batch BC.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_SCENE_MODELS, nextRevisionFor, sceneModelId } from '../../scene/roomScene';
import { PLACEMENT_GAP_FRACTION } from '../../scene/placement';

interface Call {
  table: string;
  op: string;
  args: unknown[];
}

interface Answer {
  data: unknown;
  error: { code?: string; message?: string } | null;
  throws?: Error;
}

const { calls, answers, identity } = vi.hoisted(() => ({
  calls: [] as Call[],
  answers: new Map<string, Answer>(),
  identity: { value: null as null | Record<string, unknown> },
}));

interface QueryChain extends Promise<Answer> {
  insert: (...args: unknown[]) => QueryChain;
  select: (...args: unknown[]) => QueryChain;
  single: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  order: (...args: unknown[]) => QueryChain;
}

function queryChain(table: string): QueryChain {
  const step =
    (op: string) =>
    (...args: unknown[]): QueryChain => {
      calls.push({ table, op, args });
      const configured = answers.get(table);
      if (configured?.throws) throw configured.throws;
      return queryChain(table);
    };
  const answer = answers.get(table) ?? { data: null, error: null };
  return Object.assign(Promise.resolve(answer), {
    insert: step('insert'),
    select: step('select'),
    single: step('single'),
    eq: step('eq'),
    order: step('order'),
  });
}

vi.mock('../../supabase', () => ({
  supabase: { from: (table: string) => queryChain(table) },
  supabaseConfigured: true,
}));

vi.mock('../../identity', () => ({
  getStoredIdentity: () => identity.value,
}));

import {
  NOMINAL_MODEL_WIDTH,
  listModelRevisions,
  recordModelRevision,
  revisionIdForPart,
  revisionsOnScreen,
  sceneFromRevisions,
  type ModelRevision,
} from '../revisionsRepo';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const HASH_C = 'c3'.repeat(32);

/** A stored revision, oldest-first list order being the caller's business. */
function revision(overrides: Partial<ModelRevision> = {}): ModelRevision {
  return {
    id: 'rev-1',
    reviewId: 'review-1',
    line: 'bracket',
    revision: 'A',
    hash: HASH_A,
    fileName: 'bracket.step',
    size: 2048,
    notes: '',
    uploadedBy: null,
    uploadedByName: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

/** What PostgREST hands back: snake_case, and bigint as a string. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'rev-1',
    review_id: 'review-1',
    line: 'bracket',
    revision: 'A',
    hash: HASH_A,
    file_name: 'bracket.step',
    size: '2048',
    notes: '',
    uploaded_by: null,
    uploaded_by_name: '',
    created_at: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  answers.clear();
  identity.value = null;
});

// ─── Writing a revision ─────────────────────────────────────────────────────

describe('recordModelRevision', () => {
  it('writes the review, the line, the letter, the hash, the name, the size and who', async () => {
    identity.value = { name: 'Maria Okafor', color: '#fff', accountId: 'acc-1' };
    answers.set('model_revisions', { data: row(), error: null });

    const stored = await recordModelRevision({
      reviewId: 'review-1',
      line: 'bracket',
      revision: 'B',
      hash: HASH_B,
      fileName: 'bracket-v2.step',
      size: 4096,
    });

    const insert = calls.find((call) => call.op === 'insert');
    expect(insert?.table).toBe('model_revisions');
    expect(insert?.args[0]).toEqual({
      review_id: 'review-1',
      line: 'bracket',
      revision: 'B',
      hash: HASH_B,
      file_name: 'bracket-v2.step',
      size: 4096,
      notes: '',
      uploaded_by: 'acc-1',
      uploaded_by_name: 'Maria Okafor',
    });
    expect(stored?.revision).toBe('A'); // the row the database answered with
  });

  it('records the name but no account for a guest, who has nothing to key one on', async () => {
    identity.value = { name: 'Supplier Sam', color: '#fff', guest: true, accountId: 'acc-9' };
    answers.set('model_revisions', { data: row(), error: null });

    await recordModelRevision({
      reviewId: 'review-1',
      line: 'bracket',
      revision: 'A',
      hash: HASH_A,
      fileName: 'bracket.step',
      size: 1,
    });

    // A guest's accountId is not theirs to give, and vp_user can hold one from a
    // session they signed out of: the flag is what decides, not the field.
    expect(calls.find((call) => call.op === 'insert')?.args[0]).toMatchObject({
      uploaded_by: null,
      uploaded_by_name: 'Supplier Sam',
    });
  });

  it('writes nothing at all on the default install, where nobody has an account', async () => {
    identity.value = { name: 'Robin', color: '#fff' };
    answers.set('model_revisions', { data: row(), error: null });

    await recordModelRevision({
      reviewId: 'review-1',
      line: 'bracket',
      revision: 'A',
      hash: HASH_A,
      fileName: 'bracket.step',
      size: 1,
    });

    expect(calls.find((call) => call.op === 'insert')?.args[0]).toMatchObject({
      uploaded_by: null,
      uploaded_by_name: 'Robin',
    });
  });

  it('refuses to write a revision with no review to belong to, or no file behind it', async () => {
    expect(
      await recordModelRevision({
        reviewId: '',
        line: 'bracket',
        revision: 'A',
        hash: HASH_A,
        fileName: 'bracket.step',
        size: 1,
      }),
    ).toBeNull();
    expect(
      await recordModelRevision({
        reviewId: 'review-1',
        line: 'bracket',
        revision: 'A',
        hash: '',
        fileName: 'bracket.step',
        size: 1,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('answers null — and does not throw — when the unique key refuses a duplicate Rev B', async () => {
    // Two people importing into one line at the same moment both compute Rev B
    // from the scene they can see. The second insert is the one that fails, and
    // that is the constraint doing its job rather than a bug to work around.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    answers.set('model_revisions', { data: null, error: { code: '23505', message: 'duplicate key' } });

    const stored = await recordModelRevision({
      reviewId: 'review-1',
      line: 'bracket',
      revision: 'B',
      hash: HASH_B,
      fileName: 'bracket.step',
      size: 1,
    });

    expect(stored).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('answers null when the database has no such table yet', async () => {
    answers.set('model_revisions', { data: null, error: { code: '42P01', message: 'undefined table' } });
    expect(
      await recordModelRevision({
        reviewId: 'review-1',
        line: 'bracket',
        revision: 'A',
        hash: HASH_A,
        fileName: 'bracket.step',
        size: 1,
      }),
    ).toBeNull();
  });

  it('answers null when the query throws, because a bookkeeping write must not break an import', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    answers.set('model_revisions', { data: null, error: null, throws: new Error('network down') });

    expect(
      await recordModelRevision({
        reviewId: 'review-1',
        line: 'bracket',
        revision: 'A',
        hash: HASH_A,
        fileName: 'bracket.step',
        size: 1,
      }),
    ).toBeNull();
    error.mockRestore();
  });
});

// ─── Reading a review's history ─────────────────────────────────────────────

describe('listModelRevisions', () => {
  it('reads one review, oldest first, and translates the row', async () => {
    answers.set('model_revisions', { data: [row(), row({ id: 'rev-2', revision: 'B', size: 99 })], error: null });

    const revisions = await listModelRevisions('review-1');

    const eq = calls.find((call) => call.op === 'eq');
    expect(eq?.args).toEqual(['review_id', 'review-1']);
    expect(calls.find((call) => call.op === 'order')?.args).toEqual(['created_at', { ascending: true }]);
    expect(revisions).toHaveLength(2);
    // bigint arrives as a string, which is the point of bigint.
    expect(revisions[1].size).toBe(99);
    expect(revisions[1].id).toBe('rev-2');
  });

  it('answers an empty list for a database that predates the table, and says nothing about it', async () => {
    // The most common failure in the wild: an install that has not re-applied
    // docs/supabase-schema.sql. It is not broken, it has no stored revisions,
    // and the caller falls back to asset.modelHash.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    answers.set('model_revisions', { data: null, error: { code: '42P01', message: 'undefined table' } });

    expect(await listModelRevisions('review-1')).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('answers an empty list when the read throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    answers.set('model_revisions', { data: null, error: null, throws: new Error('nope') });

    expect(await listModelRevisions('review-1')).toEqual([]);
    error.mockRestore();
  });

  it('does not query at all for an empty review id', async () => {
    expect(await listModelRevisions('')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ─── The next letter, counted from stored history ───────────────────────────

describe('the next revision letter per line', () => {
  it('starts a new line at A', () => {
    expect(nextRevisionFor([revision()], 'mating-part')).toBe('A');
    expect(nextRevisionFor([], 'bracket')).toBe('A');
  });

  it('continues a line from its newest letter, not from the last row', () => {
    const history = [
      revision({ id: 'r1', revision: 'A' }),
      revision({ id: 'r3', revision: 'C' }),
      revision({ id: 'r2', revision: 'B' }),
    ];
    expect(nextRevisionFor(history, 'bracket')).toBe('D');
  });

  it('counts each line separately', () => {
    const history = [
      revision({ id: 'r1', line: 'bracket', revision: 'C' }),
      revision({ id: 'r2', line: 'mating-part', revision: 'A' }),
    ];
    expect(nextRevisionFor(history, 'bracket')).toBe('D');
    expect(nextRevisionFor(history, 'mating-part')).toBe('B');
  });

  it('carries past Z, because a product that outlives 26 revisions is the one whose history matters', () => {
    expect(nextRevisionFor([revision({ revision: 'Z' })], 'bracket')).toBe('AA');
    expect(nextRevisionFor([revision({ revision: 'AZ' })], 'bracket')).toBe('BA');
  });

  it('ignores another line entirely when counting', () => {
    expect(nextRevisionFor([revision({ line: 'other', revision: 'M' })], 'bracket')).toBe('A');
  });
});

// ─── The scene a history means ──────────────────────────────────────────────

describe('sceneFromRevisions', () => {
  it('builds an empty scene from no history', () => {
    expect(sceneFromRevisions([])).toEqual({ models: [], builtIn: null });
  });

  it('shows the newest revision of a line and keeps the older ones, hidden', () => {
    const scene = sceneFromRevisions([
      revision({ id: 'r1', revision: 'A', hash: HASH_A }),
      revision({ id: 'r2', revision: 'B', hash: HASH_B }),
      revision({ id: 'r3', revision: 'C', hash: HASH_C }),
    ]);

    expect(scene.models).toHaveLength(3);
    expect(scene.models.map((model) => [model.revision, model.visible])).toEqual([
      ['A', false],
      ['B', false],
      ['C', true],
    ]);
  });

  it('derives each model id from its hash, so pins placed while curating still resolve', () => {
    const scene = sceneFromRevisions([revision({ hash: HASH_B, revision: 'A' })]);
    expect(scene.models[0].id).toBe(sceneModelId(HASH_B));
  });

  it('puts every revision of a line in the same place, which is where the pins are', () => {
    const scene = sceneFromRevisions([
      revision({ id: 'r1', revision: 'A', hash: HASH_A }),
      revision({ id: 'r2', revision: 'B', hash: HASH_B }),
    ]);
    expect(scene.models[0].offset).toEqual(scene.models[1].offset);
    expect(scene.models[0].offset).toEqual([0, 0, 0]);
  });

  it('puts a second line beside the first, not inside it', () => {
    const scene = sceneFromRevisions([
      revision({ id: 'r1', line: 'bracket', revision: 'A', hash: HASH_A }),
      revision({ id: 'r2', line: 'mating-part', revision: 'A', hash: HASH_B, fileName: 'mating-part.step' }),
    ]);

    expect(scene.models[0].offset[0]).toBe(0);
    // nextToOffset: right edge of the first (width/2) + a gap + half the new width.
    const gap = NOMINAL_MODEL_WIDTH * PLACEMENT_GAP_FRACTION;
    expect(scene.models[1].offset[0]).toBeCloseTo(NOMINAL_MODEL_WIDTH / 2 + gap + NOMINAL_MODEL_WIDTH / 2);
    expect(scene.models[1].visible).toBe(true);
  });

  it('keeps lines in the order they were first added, whatever the row order after', () => {
    const scene = sceneFromRevisions([
      revision({ id: 'r1', line: 'bracket', revision: 'A', hash: HASH_A }),
      revision({ id: 'r2', line: 'mating-part', revision: 'A', hash: HASH_B }),
      revision({ id: 'r3', line: 'bracket', revision: 'B', hash: HASH_C }),
    ]);
    expect(scene.models.map((model) => model.line)).toEqual(['bracket', 'bracket', 'mating-part']);
  });

  it('includes the curation model nobody ever recorded, hidden behind the revision that superseded it', () => {
    // Every review created before model_revisions existed: it has an
    // asset.modelHash and its first recorded upload became Rev B. Dropping the
    // original would have left its pins floating in empty space.
    const scene = sceneFromRevisions(
      [revision({ id: 'r2', revision: 'B', hash: HASH_B })],
      { line: 'bracket', revision: 'A', hash: HASH_A, fileName: 'bracket.step' },
    );

    expect(scene.models).toHaveLength(2);
    const a = scene.models.find((model) => model.hash === HASH_A);
    const b = scene.models.find((model) => model.hash === HASH_B);
    expect(a?.visible).toBe(false);
    expect(b?.visible).toBe(true);
    expect(a?.offset).toEqual(b?.offset);
  });

  it('does not add the curation model twice when history already holds that file', () => {
    const scene = sceneFromRevisions(
      [revision({ id: 'r1', revision: 'A', hash: HASH_A })],
      { line: 'bracket', revision: 'A', hash: HASH_A, fileName: 'bracket.step' },
    );
    expect(scene.models).toHaveLength(1);
  });

  it('ignores an unrecorded model with no hash, which is a legacy inline draft', () => {
    const scene = sceneFromRevisions(
      [revision({ id: 'r1' })],
      { line: 'bracket', revision: 'A', hash: '', fileName: 'bracket.step' },
    );
    expect(scene.models).toHaveLength(1);
  });

  it('names a model after its line when the row has no file name', () => {
    const scene = sceneFromRevisions([revision({ id: 'r1', fileName: '' })]);
    expect(scene.models[0].fileName).toBe('bracket');
  });

  it('keeps the newest revisions when a review has outlived the scene cap', () => {
    const many: ModelRevision[] = [];
    for (let i = 0; i < MAX_SCENE_MODELS + 6; i += 1) {
      many.push(
        revision({
          id: `r${i}`,
          revision: `A${i}`,
          hash: `${i}`.padStart(64, '0'),
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        }),
      );
    }

    const scene = sceneFromRevisions(many);

    expect(scene.models).toHaveLength(MAX_SCENE_MODELS);
    // The oldest six fell off; the newest is the visible one.
    expect(scene.models.some((model) => model.hash === many[0].hash)).toBe(false);
    expect(scene.models.some((model) => model.hash === many[many.length - 1].hash)).toBe(true);
    expect(scene.models.filter((model) => model.visible)).toHaveLength(1);
  });
});

// ─── Which revisions were on screen ─────────────────────────────────────────

describe('revisionsOnScreen', () => {
  const history = [
    revision({ id: 'r1', line: 'bracket', revision: 'A', hash: HASH_A }),
    revision({ id: 'r2', line: 'bracket', revision: 'B', hash: HASH_B }),
    revision({ id: 'r3', line: 'mating-part', revision: 'A', hash: HASH_C, fileName: 'mating-part.step' }),
  ];

  it('takes the visible models and nothing else', () => {
    const found = revisionsOnScreen(history, [
      { line: 'bracket', revision: 'A', visible: false },
      { line: 'bracket', revision: 'B', visible: true },
      { line: 'mating-part', revision: 'A', visible: true },
    ]);
    expect(found.map((found_) => found_.id)).toEqual(['r2', 'r3']);
  });

  it('matches the letter regardless of case, because a scene and a row can disagree about it', () => {
    const found = revisionsOnScreen(history, [{ line: 'bracket', revision: 'a', visible: true }]);
    expect(found.map((match) => match.id)).toEqual(['r1']);
  });

  it('distinguishes two lines that hold the same letter', () => {
    const found = revisionsOnScreen(history, [{ line: 'mating-part', revision: 'A', visible: true }]);
    expect(found.map((match) => match.id)).toEqual(['r3']);
  });

  it('skips a model the review has no stored revision for', () => {
    // A scene built from asset.modelHash before this table existed: the tracker
    // then writes an empty revision_ids rather than inventing one.
    const found = revisionsOnScreen(history, [{ line: 'bracket', revision: 'Z', visible: true }]);
    expect(found).toEqual([]);
  });

  it('answers nothing for an empty scene', () => {
    expect(revisionsOnScreen(history, [])).toEqual([]);
    expect(revisionsOnScreen([], [{ line: 'bracket', revision: 'A', visible: true }])).toEqual([]);
  });

  it('never lists one revision twice', () => {
    const found = revisionsOnScreen(history, [
      { line: 'bracket', revision: 'B', visible: true },
      { line: 'bracket', revision: 'B', visible: true },
    ]);
    expect(found).toHaveLength(1);
  });
});

// ─── Which revision a pointed-at part belongs to ────────────────────────────

describe('revisionIdForPart', () => {
  // lib/scene/roomScene derives a node-id prefix from a file's hash; the loader
  // numbers every node under it. Written out rather than computed so a change to
  // the scheme fails here as an assertion rather than as two tests agreeing.
  const prefixOf = (hash: string) => `m${hash.slice(0, 8)}_`;

  const history = [
    revision({ id: 'r1', revision: 'A', hash: HASH_A }),
    revision({ id: 'r2', revision: 'B', hash: HASH_B }),
    revision({ id: 'r3', line: 'mating-part', revision: 'A', hash: HASH_C }),
  ];

  it('finds the revision a node id belongs to', () => {
    expect(revisionIdForPart(`${prefixOf(HASH_B)}12`, history)).toBe('r2');
    expect(revisionIdForPart(`${prefixOf(HASH_C)}root`, history)).toBe('r3');
  });

  it('answers null for a part that is not from a stored revision', () => {
    // Built-in presets (headphones, bicycle, synth) number their nodes under a
    // prefix of their own, and a legacy inline model under `legacy-…`.
    expect(revisionIdForPart('imported_4', history)).toBeNull();
    expect(revisionIdForPart('headphones_root', history)).toBeNull();
  });

  it('answers null for no part at all', () => {
    expect(revisionIdForPart(null, history)).toBeNull();
    expect(revisionIdForPart(undefined, history)).toBeNull();
    expect(revisionIdForPart('', history)).toBeNull();
  });

  it('answers null when the review has no stored revisions', () => {
    expect(revisionIdForPart(`${prefixOf(HASH_A)}1`, [])).toBeNull();
  });

  it('requires the prefix to end at the underscore, so a longer id that starts the same way does not match', () => {
    // sceneModelPrefix is eight hex characters followed by '_' before the node
    // number. Without the separator in the comparison, a model whose prefix
    // happened to begin with another's would claim its parts.
    const prefix = prefixOf(HASH_A).slice(0, -1); // 'ma1a1a1a1', no underscore
    expect(revisionIdForPart(`${prefix}ff_1`, history)).toBeNull();
    expect(revisionIdForPart(`${prefix}_1`, history)).toBe('r1');
  });

  it('skips a row with no hash rather than matching every node id', () => {
    expect(revisionIdForPart('_anything', [revision({ id: 'r0', hash: '' })])).toBeNull();
  });
});
