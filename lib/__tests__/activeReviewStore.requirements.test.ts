import { describe, it, expect, beforeEach } from 'vitest';
import { useActiveReviewStore } from '../activeReviewStore';
import { useStore } from '../../store';
import type { ReviewDraft } from '../reviewSetupStore';

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

describe('activeReviewStore — requirements', () => {
  beforeEach(() => {
    useActiveReviewStore.setState({
      config: null,
      jumpTarget: null,
      activeViewpointIdx: 0,
      agendaIdx: 0,
    });
    useStore.setState({ requirements: [] });
  });

  it('setConfig syncs requirements to the main store', () => {
    const draft = baseDraft({
      requirements: [
        { id: 'r1', code: 'REQ-001', description: 'Test', category: 'MECHANICAL', status: 'MET' },
      ],
    });
    useActiveReviewStore.getState().setConfig(draft);
    expect(useStore.getState().requirements).toHaveLength(1);
    expect(useStore.getState().requirements[0].code).toBe('REQ-001');
  });

  it('setConfig(null) clears requirements on the main store', () => {
    useStore.setState({
      requirements: [{ id: 'r1', code: 'REQ-001', description: 'Test', category: 'MECHANICAL', status: 'MET' }],
    });
    useActiveReviewStore.getState().setConfig(null);
    expect(useStore.getState().requirements).toHaveLength(0);
  });

  it('addRequirement appends to the config and syncs the main store', () => {
    useActiveReviewStore.getState().setConfig(baseDraft());
    const next = useActiveReviewStore.getState().addRequirement({
      code: 'REQ-NEW',
      description: 'Added live',
      category: 'SAFETY',
      status: 'PENDING',
    });
    expect(next).not.toBeNull();
    expect(next!.requirements).toHaveLength(1);
    expect(next!.requirements[0].code).toBe('REQ-NEW');
    expect(useStore.getState().requirements).toHaveLength(1);
  });

  it('updateRequirement patches a requirement in config and main store', () => {
    const draft = baseDraft({
      requirements: [
        { id: 'r1', code: 'REQ-001', description: 'Original', category: 'MECHANICAL', status: 'MET' },
      ],
    });
    useActiveReviewStore.getState().setConfig(draft);
    const next = useActiveReviewStore.getState().updateRequirement('r1', { status: 'AT_RISK' });
    expect(next!.requirements[0].status).toBe('AT_RISK');
    expect(useStore.getState().requirements[0].status).toBe('AT_RISK');
  });

  it('removeRequirement drops from config and main store', () => {
    const draft = baseDraft({
      requirements: [
        { id: 'r1', code: 'REQ-001', description: 'Gone', category: 'ELECTRICAL', status: 'PENDING' },
      ],
    });
    useActiveReviewStore.getState().setConfig(draft);
    const next = useActiveReviewStore.getState().removeRequirement('r1');
    expect(next!.requirements).toHaveLength(0);
    expect(useStore.getState().requirements).toHaveLength(0);
  });

  it('returns null when there is no active config', () => {
    expect(useActiveReviewStore.getState().addRequirement({
      code: 'X', description: 'No config', category: 'MECHANICAL', status: 'MET',
    })).toBeNull();
    expect(useActiveReviewStore.getState().updateRequirement('r1', { status: 'MET' })).toBeNull();
    expect(useActiveReviewStore.getState().removeRequirement('r1')).toBeNull();
  });
});

// User, 2026-09-25: a new requirement came pre-named "REQ-xxxx", and its code box
// could never be emptied to type a new one.
describe('requirement codes are the user\'s', () => {
  it('adds a requirement with no invented code, and lets the code be cleared and retyped', () => {
    useActiveReviewStore.getState().setConfig(baseDraft({ requirements: [] }));
    const added = useActiveReviewStore.getState().addRequirement({
      code: '', description: '', category: '', status: 'PENDING',
    });
    const req = added!.requirements[0];
    expect(req.code).toBe('');

    useActiveReviewStore.getState().updateRequirement(req.id, { code: 'HINGE 1' });
    useActiveReviewStore.getState().updateRequirement(req.id, { code: '' });
    expect(useActiveReviewStore.getState().config!.requirements[0].code).toBe('');
    useActiveReviewStore.getState().updateRequirement(req.id, { code: 'Load ' });
    expect(useActiveReviewStore.getState().config!.requirements[0].code).toBe('Load ');
  });
});
