// Tests for lib/trackerBridge.ts — the design review and the revisions a meeting
// is recorded against (docs/plan/14-rooms-models-admin-ai.md batch BC).
//
// The labels half of this module is covered by trackerBridge.labels.test.ts; this
// file is about continuity: that a meeting says which review it was held in and
// what was on screen, that a card says which revision it was raised on and which
// part it was pointing at, and that an ad-hoc session — a room nobody curated —
// still records exactly what it always did.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InsightCard } from '../../types';
import type { ModelRevision } from '../reviews/revisionsRepo';

const { state } = vi.hoisted(() => ({
  state: {
    sessions: [] as Array<Record<string, unknown>>,
    items: [] as Array<Record<string, unknown>>,
    sessionId: 'sess-1',
    sessionError: null as { message: string } | null,
    stored: [] as ModelRevision[],
  },
}));

vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'tracker_sessions') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.sessions.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: state.sessionError ? null : { id: state.sessionId },
                  error: state.sessionError,
                }),
              }),
            };
          },
        };
      }
      if (table === 'tracker_items') {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            state.items.push(...rows);
            return { error: null };
          },
        };
      }
      return {};
    },
  },
}));

// Only the READ is faked. `revisionsOnScreen` and `revisionIdForPart` are the
// real ones, so what these tests assert is the join the tracker actually makes
// between a scene and a history, not a stub of it.
vi.mock('../reviews/revisionsRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reviews/revisionsRepo')>();
  return { ...actual, listModelRevisions: vi.fn(async () => state.stored) };
});

import { flushSessionToTracker } from '../trackerBridge';

const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const HASH_C = 'c3'.repeat(32);

function revision(overrides: Partial<ModelRevision> = {}): ModelRevision {
  return {
    id: 'rev-a',
    reviewId: 'review-1',
    line: 'bracket',
    revision: 'A',
    hash: HASH_A,
    fileName: 'bracket.step',
    size: 1024,
    notes: '',
    uploadedBy: null,
    uploadedByName: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

function card(overrides: Partial<InsightCard> = {}, details: Partial<InsightCard['details']> = {}): InsightCard {
  return {
    id: 'ic-1',
    type: 'RISK',
    title: 'A risk',
    description: '',
    agentId: 'SYS.OP',
    timestamp: Date.now(),
    details: { priority: 'High', status: 'Open', ...details },
    ...overrides,
  };
}

/** A three-revision history: bracket Rev A superseded by Rev B, and a mating part. */
function history(): ModelRevision[] {
  return [
    revision({ id: 'rev-a', line: 'bracket', revision: 'A', hash: HASH_A }),
    revision({ id: 'rev-b', line: 'bracket', revision: 'B', hash: HASH_B }),
    revision({ id: 'rev-m', line: 'mating-part', revision: 'A', hash: HASH_C, fileName: 'mating-part.step' }),
  ];
}

beforeEach(() => {
  state.sessions = [];
  state.items = [];
  state.sessionId = 'sess-1';
  state.sessionError = null;
  state.stored = [];
});

// ─── The session row ────────────────────────────────────────────────────────

describe('flushSessionToTracker — the meeting', () => {
  it('records the design review and the revisions that were on screen', async () => {
    state.stored = history();

    await flushSessionToTracker({
      roomId: 'review-1',
      insightCards: [card()],
      participantCount: 4,
      modelName: 'imported',
      reviewId: 'review-1',
      // Rev A is hidden: Rev B superseded it. What the meeting was LOOKING AT is
      // the visible set, and a hidden revision is not on screen.
      onScreen: [
        { line: 'bracket', revision: 'A', visible: false },
        { line: 'bracket', revision: 'B', visible: true },
        { line: 'mating-part', revision: 'A', visible: true },
      ],
    });

    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].review_id).toBe('review-1');
    expect(state.sessions[0].revision_ids).toEqual(['rev-b', 'rev-m']);
  });

  it('records a null review and no revisions for an ad-hoc session', async () => {
    // A room id with no curation row behind it. This is the shape every meeting
    // had before batch BC, and it must keep working rather than inventing a
    // review to belong to.
    state.stored = history();

    await flushSessionToTracker({
      roomId: 'some-room',
      insightCards: [card()],
      participantCount: 2,
      modelName: null,
    });

    expect(state.sessions[0].review_id).toBeNull();
    expect(state.sessions[0].revision_ids).toEqual([]);
    expect(state.items[0].review_id).toBeNull();
    expect(state.items[0].raised_on_revision).toBeNull();
  });

  it('records an empty revision list for a review whose models were never stored', async () => {
    // A review created before model_revisions existed, opened from its
    // asset.modelHash. There is a review to name and nothing to point at.
    await flushSessionToTracker({
      roomId: 'review-1',
      insightCards: [card()],
      participantCount: 2,
      modelName: 'imported',
      reviewId: 'review-1',
      onScreen: [{ line: 'bracket', revision: 'A', visible: true }],
    });

    expect(state.sessions[0].review_id).toBe('review-1');
    expect(state.sessions[0].revision_ids).toEqual([]);
  });

  it('still writes no session at all when there were no cards', async () => {
    await flushSessionToTracker({
      roomId: 'review-1',
      insightCards: [],
      participantCount: 1,
      modelName: null,
      reviewId: 'review-1',
    });

    expect(state.sessions).toHaveLength(0);
    expect(state.items).toHaveLength(0);
  });

  it('writes no items when the session row could not be created', async () => {
    state.stored = history();
    state.sessionError = { message: 'nope' };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await flushSessionToTracker({
      roomId: 'review-1',
      insightCards: [card()],
      participantCount: 1,
      modelName: null,
      reviewId: 'review-1',
      onScreen: [{ line: 'bracket', revision: 'B', visible: true }],
    });

    expect(result).toBeNull();
    expect(state.items).toHaveLength(0);
    error.mockRestore();
  });
});

// ─── The card rows ──────────────────────────────────────────────────────────

describe('flushSessionToTracker — the cards', () => {
  const onScreen = [
    { line: 'bracket', revision: 'A', visible: false },
    { line: 'bracket', revision: 'B', visible: true },
    { line: 'mating-part', revision: 'A', visible: true },
  ];

  async function flush(cards: InsightCard[], partNames?: Record<string, string>) {
    state.stored = history();
    await flushSessionToTracker({
      roomId: 'review-1',
      insightCards: cards,
      participantCount: 3,
      modelName: 'imported',
      reviewId: 'review-1',
      onScreen,
      partNames,
    });
  }

  it('puts the review on every card', async () => {
    await flush([card({ id: 'a' }), card({ id: 'b' })]);
    expect(state.items.map((item) => item.review_id)).toEqual(['review-1', 'review-1']);
  });

  it('records the revision a pointed-at part belongs to', async () => {
    // The node ids utils/modelLoader.ts builds: sceneModelPrefix(hash) + '_'.
    await flush([card({}, { componentReference: `m${HASH_B.slice(0, 8)}_12` })]);
    expect(state.items[0].raised_on_revision).toBe('rev-b');
    expect(state.items[0].part_node_id).toBe(`m${HASH_B.slice(0, 8)}_12`);
  });

  it('records the part name the pointing timeline knew it by', async () => {
    const nodeId = `m${HASH_C.slice(0, 8)}_4`;
    await flush([card({}, { componentReference: nodeId })], { [nodeId]: 'Flange M8' });
    expect(state.items[0].part_name).toBe('Flange M8');
    expect(state.items[0].part_node_id).toBe(nodeId);
  });

  it('falls back to the first revision on screen for a card about no part in particular', async () => {
    await flush([card()]);
    expect(state.items[0].raised_on_revision).toBe('rev-b');
    expect(state.items[0].part_node_id).toBeNull();
    expect(state.items[0].part_name).toBeNull();
  });

  it('does not record a part the model tree never had, whatever the model called it', async () => {
    // `componentReference` is free text an extraction model fills in. Only an id
    // the pointing timeline knows, or one carrying a stored revision's node
    // prefix, is evidence of a real mesh.
    await flush([card({}, { componentReference: 'the bracket thing' })]);
    expect(state.items[0].part_node_id).toBeNull();
    expect(state.items[0].part_name).toBeNull();
    expect(state.items[0].raised_on_revision).toBe('rev-b');
  });

  it('keeps component_reference as the free text it has always been', async () => {
    await flush([card({}, { componentReference: 'the bracket thing' })]);
    expect(state.items[0].component_reference).toBe('the bracket thing');
  });

  it('names a part from the pointing timeline even when no revision is stored for its model', async () => {
    // A card raised on a built-in preset: the timeline knows the id and the name,
    // and no revision does. The part is still worth recording.
    await flush([card({}, { componentReference: 'headphones_7' })], { headphones_7: 'Left Ear Cup' });
    expect(state.items[0].part_node_id).toBe('headphones_7');
    expect(state.items[0].part_name).toBe('Left Ear Cup');
    expect(state.items[0].raised_on_revision).toBe('rev-b');
  });

  it('marks an agent card as ai and leaves the author to agent_id', async () => {
    await flush([card({ agentId: 'ENG.UNIT' })]);
    expect(state.items[0].source).toBe('ai');
    expect(state.items[0].created_by_name).toBeNull();
    expect(state.items[0].agent_id).toBe('ENG.UNIT');
  });

  it('marks a hand-made card as manual and records who typed it', async () => {
    await flush([card({ source: 'manual', createdByName: 'Maria Okafor', agentId: '' })]);
    expect(state.items[0].source).toBe('manual');
    expect(state.items[0].created_by_name).toBe('Maria Okafor');
  });

  it('does not let a card claim to be manual without saying so', async () => {
    // `source` is a check constraint in the database: anything other than 'ai' or
    // 'manual' would refuse the whole insert, taking every other card with it.
    await flush([card({ source: 'ai', createdByName: 'Somebody' })]);
    expect(state.items[0].source).toBe('ai');
    expect(state.items[0].created_by_name).toBeNull();
  });
});
