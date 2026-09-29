import { describe, it, expect, beforeEach } from 'vitest';
import { useReviewSetupStore } from '../reviewSetupStore';

function resetStore() {
  useReviewSetupStore.setState({ draft: null });
}

describe('reviewSetupStore — listed', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts a new draft with listed: true', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const draft = useReviewSetupStore.getState().draft;
    expect(draft).not.toBeNull();
    expect(draft!.listed).toBe(true);
  });

  it('setListed(false) flips the value', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setListed(false);
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.listed).toBe(false);
  });

  it('setListed(true) flips it back', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    useReviewSetupStore.getState().setListed(false);
    useReviewSetupStore.getState().setListed(true);
    const draft = useReviewSetupStore.getState().draft!;
    expect(draft.listed).toBe(true);
  });

  it('setListed marks the draft dirty (updatedAt advances)', () => {
    useReviewSetupStore.getState().startNewDraft('rev-1');
    const before = useReviewSetupStore.getState().draft!.updatedAt;
    useReviewSetupStore.getState().setListed(false);
    const after = useReviewSetupStore.getState().draft!.updatedAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
