// A review's roster changed: re-read roles. No imports, so nothing mocks it away.

/**
 * Tell every open useReviewRole that a review's roster changed.
 *
 * Found live (batch BQ2): the room claims an unowned review a moment AFTER its role
 * was first read, and useReviewRole reads a review's roster once. So the owner
 * stayed a participant for the rest of the page: walking into a variant, they could
 * not fill its empty room with the review's models. A reload fixed it, which is not
 * something anybody should have to know.
 */
export const REVIEW_ROSTER_CHANGED = 'vp:review-roster-changed';

export function announceReviewRosterChanged(reviewId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<string>(REVIEW_ROSTER_CHANGED, { detail: reviewId }));
}
