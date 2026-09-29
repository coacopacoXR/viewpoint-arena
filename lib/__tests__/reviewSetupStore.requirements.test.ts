import { describe, it, expect, beforeEach } from 'vitest';
import { useReviewSetupStore, type ReviewDraft } from '../reviewSetupStore';

function resetStore() {
  useReviewSetupStore.setState({ draft: null });
}

describe('reviewSetupStore — requirements', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts a new draft with an empty requirements array', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const draft = useReviewSetupStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft!.requirements).toEqual([]);
  });

  it('addRequirement appends a requirement and returns its id', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const id = useReviewSetupStore.getState().addRequirement({
      code: 'REQ-001',
      description: 'Test requirement',
      category: 'MECHANICAL',
      status: 'PENDING',
    });
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.requirements).toHaveLength(1);
    expect(draft.requirements[0].id).toBe(id);
    expect(draft.requirements[0].code).toBe('REQ-001');
    expect(draft.requirements[0].description).toBe('Test requirement');
  });

  it('updateRequirement patches a single requirement', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const id = useReviewSetupStore.getState().addRequirement({
      code: 'REQ-010',
      description: 'Original',
      category: 'ELECTRICAL',
      status: 'PENDING',
    });
    useReviewSetupStore.getState().updateRequirement(id, { status: 'AT_RISK', description: 'Updated' });
    const req = useReviewSetupStore.getState().draft!.requirements[0];
    expect(req.status).toBe('AT_RISK');
    expect(req.description).toBe('Updated');
    expect(req.code).toBe('REQ-010');
  });

  it('removeRequirement drops the requirement', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const id = useReviewSetupStore.getState().addRequirement({
      code: 'REQ-099',
      description: 'To remove',
      category: 'ERGONOMIC',
      status: 'MET',
    });
    expect(useReviewSetupStore.getState().draft!.requirements).toHaveLength(1);
    useReviewSetupStore.getState().removeRequirement(id);
    expect(useReviewSetupStore.getState().draft!.requirements).toHaveLength(0);
  });

  it('reorderRequirements moves an item from one index to another', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().addRequirement({ code: 'A', description: 'First', category: 'MECHANICAL', status: 'MET' });
    useReviewSetupStore.getState().addRequirement({ code: 'B', description: 'Second', category: 'MECHANICAL', status: 'MET' });
    useReviewSetupStore.getState().addRequirement({ code: 'C', description: 'Third', category: 'MECHANICAL', status: 'MET' });
    useReviewSetupStore.getState().reorderRequirements(0, 2);
    const codes = useReviewSetupStore.getState().draft!.requirements.map((r) => r.code);
    expect(codes).toEqual(['B', 'C', 'A']);
  });


  it('leaves a blank code blank instead of inventing one', () => {
    // "REQ-A1B2" pretended to be the user's numbering scheme (user, 2026-09-23).
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().addRequirement({
      code: '   ',
      description: 'No code given',
      category: '',
      status: 'PENDING',
    });
    expect(useReviewSetupStore.getState().draft!.requirements[0].code).toBe('');
  });

  it('updatedAt changes when a requirement is added', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const before = useReviewSetupStore.getState().draft!.updatedAt;
    // Force a different timestamp
    useReviewSetupStore.getState().addRequirement({
      code: 'REQ-X',
      description: 'Timestamp check',
      category: 'SAFETY',
      status: 'PENDING',
    });
    const after = useReviewSetupStore.getState().draft!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('reviewSetupStore — fingerprint includes requirements', () => {
  beforeEach(() => {
    resetStore();
  });

  it('fingerprint changes when a requirement is added', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const fp1 = fingerprintOf(useReviewSetupStore.getState().draft!);
    useReviewSetupStore.getState().addRequirement({
      code: 'REQ-001',
      description: 'New',
      category: 'MECHANICAL',
      status: 'PENDING',
    });
    const fp2 = fingerprintOf(useReviewSetupStore.getState().draft!);
    expect(fp1).not.toBe(fp2);
  });
});

function fingerprintOf(d: ReviewDraft): string {
  const { importedFileBase64: _, ...asset } = d.asset;
  return JSON.stringify({
    title: d.title, description: d.description, asset,
    viewpoints: d.viewpoints, pins: d.pins, agenda: d.agenda,
    requirements: d.requirements,
  });
}
