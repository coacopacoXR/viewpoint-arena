import { describe, it, expect, beforeEach } from 'vitest';
import { useActiveReviewStore, pinToLiveComment } from '../activeReviewStore';
import type { ReviewDraft, ReviewPin } from '../reviewSetupStore';

function baseDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    reviewId: 'rev-1',
    title: 'Test',
    description: '',
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

function basePin(overrides: Partial<ReviewPin> = {}): ReviewPin {
  return {
    id: 'pin-1',
    label: 'Test pin',
    notes: 'Some notes',
    worldPos: [1, 2, 3],
    modelId: 'model-a',
    meshIndex: 'mesh-0',
    partName: 'Ear cup',
    severity: 'info',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('activeReviewStore — pin commit', () => {
  beforeEach(() => {
    useActiveReviewStore.setState({
      config: null,
      jumpTarget: null,
      activeViewpointIdx: 0,
      agendaIdx: 0,
    });
  });

  describe('pinToLiveComment', () => {
    it('uses "label — notes" when both are present', () => {
      const pin = basePin({ label: 'Knob fit', notes: 'Too tight' });
      const comment = pinToLiveComment(pin, 'Alice', '#ff0000');
      expect(comment.content).toBe('Knob fit — Too tight');
    });

    it('uses notes alone when label is empty', () => {
      const pin = basePin({ label: '', notes: 'Just notes' });
      const comment = pinToLiveComment(pin, 'Alice', '#ff0000');
      expect(comment.content).toBe('Just notes');
    });

    it('uses label when notes are empty', () => {
      const pin = basePin({ label: 'Only label', notes: '' });
      const comment = pinToLiveComment(pin, 'Alice', '#ff0000');
      expect(comment.content).toBe('Only label');
    });

    it('uses label when notes are whitespace-only', () => {
      const pin = basePin({ label: 'Only label', notes: '   ' });
      const comment = pinToLiveComment(pin, 'Alice', '#ff0000');
      expect(comment.content).toBe('Only label');
    });

    it('maps position, attachedToNodeId, and attachedToNodeName from the pin', () => {
      const pin = basePin({
        worldPos: [10, 20, 30],
        meshIndex: 'mesh-5',
        modelId: 'model-x',
        partName: 'Hinge',
      });
      const comment = pinToLiveComment(pin, 'Bob', '#00ff00');
      expect(comment.position).toEqual({ x: 10, y: 20, z: 30 });
      expect(comment.attachedToNodeId).toBe('mesh-5');
      expect(comment.attachedToNodeName).toBe('Hinge');
      expect(comment.author).toBe('Bob');
      expect(comment.authorColor).toBe('#00ff00');
      expect(comment.type).toBe('text');
      expect(comment.assignees).toEqual([]);
      expect(comment.resolved).toBe(false);
    });

    it('falls back to modelId when meshIndex is null', () => {
      const pin = basePin({ meshIndex: null, modelId: 'model-fallback', partName: null });
      const comment = pinToLiveComment(pin, 'Bob', '#00ff00');
      expect(comment.attachedToNodeId).toBe('model-fallback');
      expect(comment.attachedToNodeName).toBe('Test pin');
    });

    it('falls back to empty string when both meshIndex and modelId are null', () => {
      const pin = basePin({ meshIndex: null, modelId: null, partName: null });
      const comment = pinToLiveComment(pin, 'Bob', '#00ff00');
      expect(comment.attachedToNodeId).toBe('');
    });
  });

  describe('commitPinAsComment', () => {
    it('creates a comment, stores committedCommentId on the pin, and returns both', () => {
      const pin = basePin();
      useActiveReviewStore.getState().setConfig(baseDraft({ pins: [pin] }));

      const result = useActiveReviewStore.getState().commitPinAsComment('pin-1', 'Alice', '#ff0000');

      expect(result).not.toBeNull();
      expect(result!.comment.content).toBe('Test pin — Some notes');
      expect(result!.comment.author).toBe('Alice');
      expect(typeof result!.comment.id).toBe('string');
      expect(result!.comment.id.length).toBeGreaterThan(0);

      const cfg = useActiveReviewStore.getState().config;
      expect(cfg).not.toBeNull();
      const committedPin = cfg!.pins.find((p) => p.id === 'pin-1');
      expect(committedPin!.committedCommentId).toBe(result!.comment.id);
    });

    it('returns null when there is no config', () => {
      expect(useActiveReviewStore.getState().commitPinAsComment('pin-1', 'A', '#000')).toBeNull();
    });

    it('returns null for an unknown pin id', () => {
      useActiveReviewStore.getState().setConfig(baseDraft({ pins: [basePin()] }));
      expect(useActiveReviewStore.getState().commitPinAsComment('no-such-pin', 'A', '#000')).toBeNull();
    });

    it('returns null on a second call (already committed)', () => {
      useActiveReviewStore.getState().setConfig(baseDraft({ pins: [basePin()] }));
      const first = useActiveReviewStore.getState().commitPinAsComment('pin-1', 'A', '#000');
      expect(first).not.toBeNull();
      const second = useActiveReviewStore.getState().commitPinAsComment('pin-1', 'B', '#111');
      expect(second).toBeNull();
    });
  });

  describe('clearCommittedCommentId', () => {
    it('clears the field so the pin can be committed again', () => {
      useActiveReviewStore.getState().setConfig(baseDraft({ pins: [basePin()] }));
      const first = useActiveReviewStore.getState().commitPinAsComment('pin-1', 'A', '#000');
      expect(first).not.toBeNull();
      const commentId = first!.comment.id;

      const cleared = useActiveReviewStore.getState().clearCommittedCommentId(commentId);
      expect(cleared).not.toBeNull();
      expect(cleared!.pins[0].committedCommentId).toBeUndefined();

      // The pin can now be committed again.
      const again = useActiveReviewStore.getState().commitPinAsComment('pin-1', 'B', '#111');
      expect(again).not.toBeNull();
      expect(again!.comment.id).not.toBe(commentId);
    });

    it('returns null when no pin holds that commentId', () => {
      useActiveReviewStore.getState().setConfig(baseDraft({ pins: [basePin()] }));
      expect(useActiveReviewStore.getState().clearCommittedCommentId('no-such-id')).toBeNull();
    });

    it('returns null when there is no config', () => {
      expect(useActiveReviewStore.getState().clearCommittedCommentId('any')).toBeNull();
    });
  });

  describe('commit all (bulk via the store)', () => {
    it('only commits pins that are not yet committed', () => {
      const pins = [
        basePin({ id: 'p1', label: 'First' }),
        basePin({ id: 'p2', label: 'Second' }),
        basePin({ id: 'p3', label: 'Third' }),
      ];
      useActiveReviewStore.getState().setConfig(baseDraft({ pins }));

      // Commit the first one manually.
      const first = useActiveReviewStore.getState().commitPinAsComment('p1', 'A', '#000');
      expect(first).not.toBeNull();

      // Now commit the remaining two (simulating "commit all").
      const cfg = useActiveReviewStore.getState().config!;
      const uncommitted = cfg.pins.filter((p) => !p.committedCommentId);
      expect(uncommitted).toHaveLength(2);

      for (const pin of uncommitted) {
        useActiveReviewStore.getState().commitPinAsComment(pin.id, 'A', '#000');
      }

      const final = useActiveReviewStore.getState().config!;
      expect(final.pins.every((p) => !!p.committedCommentId)).toBe(true);
    });
  });
});
