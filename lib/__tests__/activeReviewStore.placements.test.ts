// The review's copy of where its models stand — batch BI's third section.
//
// The gizmo writes a SceneModel's transform into the room's scene, which the room
// server persists. This is the second copy, in the review row, and it is what makes
// the placement outlive the room. What these tests pin is the write's three
// promises: that it lands in `asset.placements`, that it raises the local-edit mark
// so RoomPage's subscriber saves it (batch BH3's rule), and that a drag which ended
// where it started is NOT an edit — no mark, no broadcast, no row written.

import { describe, it, expect, beforeEach } from 'vitest';
import { useActiveReviewStore } from '../activeReviewStore';
import { useStore } from '../../store';
import { consumeLocalEdit, forgetLocalEdit } from '../reviewLocalEdit';
import type { ReviewDraft } from '../reviewSetupStore';
import type { StoredPlacement } from '../scene/placement';

const MOVED: StoredPlacement = {
  line: 'bracket',
  revision: 'A',
  offset: [3, 0, -1],
  rotation: [0, 1.5708, 0],
  scale: 1.5,
};

function baseDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    reviewId: 'rev-1',
    title: 'Landing gear review',
    description: '',
    // A preset rather than 'imported', for the same reason the other
    // activeReviewStore tests use one: setConfig pushes the model onto the main
    // store, and the imported path goes to the database for the review's
    // revisions. Nothing here is about which model is loaded.
    asset: { modelType: 'headphones', references: [] },
    viewpoints: [],
    pins: [],
    agenda: [],
    requirements: [],
    team: [],
    labels: {},
    listed: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('activeReviewStore — setScenePlacements', () => {
  beforeEach(() => {
    useActiveReviewStore.setState({ config: null, jumpTarget: null });
    useStore.setState({ comments: [] });
    forgetLocalEdit();
  });

  it('writes the placement into the review\'s asset, and marks the edit', () => {
    useActiveReviewStore.getState().setConfig(baseDraft());
    forgetLocalEdit(); // setConfig forgets on purpose; the mark under test is the write's

    const next = useActiveReviewStore.getState().setScenePlacements([MOVED]);

    expect(next?.asset.placements).toEqual([MOVED]);
    expect(useActiveReviewStore.getState().config?.asset.placements).toEqual([MOVED]);
    // The mark is what RoomPage's subscriber waits for. Without it the placement
    // would live in this browser only, which is the whole thing being fixed.
    expect(consumeLocalEdit()).toBe(true);
  });

  it('answers the draft so the caller can broadcast exactly that', () => {
    useActiveReviewStore.getState().setConfig(baseDraft());
    const next = useActiveReviewStore.getState().setScenePlacements([MOVED]);
    expect(next).toBe(useActiveReviewStore.getState().config);
  });

  it('answers null and marks nothing when the placements say the same thing', () => {
    // A drag that ended where it started, and a scene whose model ORDER changed
    // without anybody moving anything — a Compare, a removal, a re-import. Both
    // rebuild the same list, and treating either as an edit would broadcast the
    // whole review to everybody and write the row for a change nobody can see.
    useActiveReviewStore.getState().setConfig(baseDraft({ asset: { modelType: 'headphones', references: [], placements: [MOVED] } }));
    forgetLocalEdit();

    const other = { ...MOVED, revision: 'a' };
    expect(useActiveReviewStore.getState().setScenePlacements([other])).toBeNull();
    expect(consumeLocalEdit()).toBe(false);
    // Untouched, and not replaced by a differently-spelled copy of itself.
    expect(useActiveReviewStore.getState().config?.asset.placements).toEqual([MOVED]);
  });

  it('answers null and marks nothing when nothing was ever moved', () => {
    useActiveReviewStore.getState().setConfig(baseDraft());
    forgetLocalEdit();

    expect(useActiveReviewStore.getState().setScenePlacements([])).toBeNull();
    expect(consumeLocalEdit()).toBe(false);
  });

  it('answers null when no review is open', () => {
    // An ad-hoc session: the room has models and a gizmo, and no review to keep
    // their placement in. The drag still works, because the scene is the room
    // server's; only the second copy has nowhere to go.
    expect(useActiveReviewStore.getState().setScenePlacements([MOVED])).toBeNull();
    expect(consumeLocalEdit()).toBe(false);
  });

  it('keeps everything else in the review exactly as it was', () => {
    const draft = baseDraft({
      viewpoints: [{ id: 'v1', label: 'View 1', position: [0, 0, 0], lookAt: [0, 0, 0], createdAt: 1 }],
      pins: [{ id: 'p1', label: 'Crack', worldPos: [0, 0, 0], severity: 'blocker', createdAt: 1 }],
      labels: { product: 'Bracket' },
    });
    useActiveReviewStore.getState().setConfig(draft);
    const commentsBefore = useStore.getState().comments.length;

    useActiveReviewStore.getState().setScenePlacements([MOVED]);
    const config = useActiveReviewStore.getState().config;

    expect(config?.viewpoints).toEqual(draft.viewpoints);
    expect(config?.pins).toEqual(draft.pins);
    expect(config?.labels).toEqual(draft.labels);
    expect(config?.asset.modelType).toBe('headphones');
    // And nothing on the room's own canvas changed: a placement describes the
    // scene, it does not redraw it. setConfig mirrors the pin into the comment
    // list, so the number to hold is the one after it, not zero.
    expect(useStore.getState().comments).toHaveLength(commentsBefore);
  });
});
