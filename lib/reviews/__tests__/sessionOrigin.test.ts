// A session starts where its line left off.
//
// docs/plan/15-sessions-and-variants.md batch BK. `revisionsForSession` is the pure
// half of that: tracker_sessions.revision_ids is the set of models a meeting was
// LOOKING AT when it ended, and narrowing a review's whole history to that set before
// handing it to sceneFromRevisions is what opens a room on the model its line left on
// screen instead of on the newest thing anybody ever imported into the review.
//
// The interesting cases are the ones where the narrowing must NOT happen: a meeting
// recorded before revision_ids existed, a meeting held on a built-in preset, and a
// revision somebody has since deleted from the review. Each of those has to fall back
// to the whole history, because the alternative is a room that opens on an empty scene
// and a review that appears to have lost its model.

import { describe, it, expect } from 'vitest';
import { revisionsForSession, sceneFromRevisions, type ModelRevision } from '../revisionsRepo';

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

/** A review that has been through two revisions of the bracket and added a mating part. */
const HISTORY: ModelRevision[] = [
  revision({ id: 'rev-a', line: 'bracket', revision: 'A', hash: HASH_A }),
  revision({ id: 'rev-b', line: 'bracket', revision: 'B', hash: HASH_B }),
  revision({ id: 'rev-m', line: 'mating-part', revision: 'A', hash: HASH_C, fileName: 'mating-part.step' }),
];

describe('revisionsForSession', () => {
  it('narrows a review\'s history to what the meeting was looking at', () => {
    expect(revisionsForSession(HISTORY, ['rev-a']).map((row) => row.id)).toEqual(['rev-a']);
  });

  it('keeps the history\'s own order, which is what sceneFromRevisions places by', () => {
    expect(revisionsForSession(HISTORY, ['rev-m', 'rev-a']).map((row) => row.id)).toEqual(['rev-a', 'rev-m']);
  });

  it('answers the whole history for a meeting that stored no revisions', () => {
    // Empty is "nothing was stored", not "show nothing": every meeting recorded
    // before revision_ids existed, and every one held on a built-in preset.
    expect(revisionsForSession(HISTORY, [])).toEqual(HISTORY);
    expect(revisionsForSession(HISTORY, null)).toEqual(HISTORY);
    expect(revisionsForSession(HISTORY, undefined)).toEqual(HISTORY);
  });

  it('skips an id whose revision has been deleted, rather than answering nothing', () => {
    expect(revisionsForSession(HISTORY, ['rev-a', 'gone']).map((row) => row.id)).toEqual(['rev-a']);
  });

  it('falls back to the whole history when every id it was given is gone', () => {
    // A review whose models were all deleted from the admin console still opens on
    // what it has, rather than on an empty room.
    expect(revisionsForSession(HISTORY, ['gone-1', 'gone-2'])).toEqual(HISTORY);
  });

  it('does not hand the caller the array it was given', () => {
    const narrowed = revisionsForSession(HISTORY, []);
    expect(narrowed).not.toBe(HISTORY);
    expect(narrowed).toEqual(HISTORY);
  });
});

describe('the scene a session starts from', () => {
  it('is the model the line left on screen, and only that one', () => {
    // The main line met on Rev A, then somebody imported Rev B and Rev C into the
    // review. A room opened on the line's last session shows Rev A.
    const scene = sceneFromRevisions(revisionsForSession(HISTORY, ['rev-a']));
    expect(scene.models).toHaveLength(1);
    expect(scene.models[0]).toMatchObject({ line: 'bracket', revision: 'A', visible: true });
  });

  it('is the whole history, newest of each line visible, when the line has no origin', () => {
    // Which is exactly what opening such a review did before this batch.
    const scene = sceneFromRevisions(revisionsForSession(HISTORY, null));
    expect(scene.models).toHaveLength(3);
    const visible = scene.models.filter((model) => model.visible);
    expect(visible.map((model) => model.revision).sort()).toEqual(['A', 'B']);
  });

  it('keeps a mating part that was on screen beside the product', () => {
    const scene = sceneFromRevisions(revisionsForSession(HISTORY, ['rev-b', 'rev-m']));
    expect(scene.models.map((model) => model.line).sort()).toEqual(['bracket', 'mating-part']);
    expect(scene.models.every((model) => model.visible)).toBe(true);
  });
});
