import { describe, it, expect } from 'vitest';
import { reviewIdOfPartyRoom } from '../partyRoom';
import { partyRoomName } from '../lines';

describe('reviewIdOfPartyRoom', () => {
  it('gives the review id back for a main-line room and for a variant room', () => {
    const id = '0f06d42a-2e0c-4c1a-ab0a-e0c60353b391';
    expect(reviewIdOfPartyRoom(id)).toBe(id);
    const variantRoom = partyRoomName(id, { kind: 'variant', letter: 'A', name: 'Steel hinge pin' });
    expect(variantRoom).toBe(`${id}~A`);
    expect(reviewIdOfPartyRoom(variantRoom)).toBe(id);
  });
});

describe('announceReviewRosterChanged', () => {
  it('dispatches the event useReviewRole listens for, carrying the review id', async () => {
    const { announceReviewRosterChanged, REVIEW_ROSTER_CHANGED } = await import('../rosterEvents');
    const seen: unknown[] = [];
    const listener = (event: Event) => { if (event instanceof CustomEvent) seen.push(event.detail); };
    window.addEventListener(REVIEW_ROSTER_CHANGED, listener);
    announceReviewRosterChanged('review-1');
    window.removeEventListener(REVIEW_ROSTER_CHANGED, listener);
    expect(seen).toEqual(['review-1']);
  });
});
