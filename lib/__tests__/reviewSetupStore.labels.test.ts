import { describe, it, expect, beforeEach } from 'vitest';
import { useReviewSetupStore, type ReviewDraft } from '../reviewSetupStore';

function resetStore() {
  useReviewSetupStore.setState({ draft: null });
}

describe('reviewSetupStore — labels', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts a new draft with an empty labels object', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const draft = useReviewSetupStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft!.labels).toEqual({});
  });

  it('setLabel sets a value for a field', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.labels).toEqual({ product: 'Headphones' });
  });

  it('setLabel overwrites an existing value', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    useReviewSetupStore.getState().setLabel('product', 'Bicycle');
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.labels).toEqual({ product: 'Bicycle' });
  });

  it('setLabel supports multiple fields', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    useReviewSetupStore.getState().setLabel('variant', 'Mk II');
    useReviewSetupStore.getState().setLabel('phase', 'Concept');
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.labels).toEqual({
      product: 'Headphones',
      variant: 'Mk II',
      phase: 'Concept',
    });
  });

  it('clearLabel removes a specific field value', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    useReviewSetupStore.getState().setLabel('variant', 'Mk II');
    useReviewSetupStore.getState().clearLabel('product');
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.labels).toEqual({ variant: 'Mk II' });
  });

  it('clearLabel on a non-existent field is a no-op', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    useReviewSetupStore.getState().clearLabel('nonexistent');
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.labels).toEqual({ product: 'Headphones' });
  });

  it('updatedAt changes when a label is set', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const before = useReviewSetupStore.getState().draft!.updatedAt;
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    const after = useReviewSetupStore.getState().draft!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('reviewSetupStore — fingerprint includes labels', () => {
  beforeEach(() => {
    resetStore();
  });

  it('fingerprint changes when a label is set', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const fp1 = fingerprintOf(useReviewSetupStore.getState().draft!);
    useReviewSetupStore.getState().setLabel('product', 'Headphones');
    const fp2 = fingerprintOf(useReviewSetupStore.getState().draft!);
    expect(fp1).not.toBe(fp2);
  });
});

function fingerprintOf(d: ReviewDraft): string {
  const { importedFileBase64: _, ...asset } = d.asset;
  return JSON.stringify({
    title: d.title, description: d.description, asset,
    viewpoints: d.viewpoints, pins: d.pins, agenda: d.agenda,
    requirements: d.requirements, team: d.team, labels: d.labels,
  });
}
