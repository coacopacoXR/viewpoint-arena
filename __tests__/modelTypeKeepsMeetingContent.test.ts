// Re-applying the SAME model must not erase the meeting.
//
// The room re-applies the review's model on every REVIEW_CONFIG sync, and
// setActiveModelType cleared comments, chat and insight cards
// unconditionally "for a new model". So committing a pin — which updates the
// review and broadcasts it — wiped every comment, transcript line and card on
// the other participants' screens a moment after they arrived (found live,
// 2026-09-23).
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import type { SpatialComment, InsightCard, ChatMessage } from '../types';

const comment = { id: 'c1', type: 'text', content: 'x', author: 'A', authorColor: '#fff', timestamp: 1, position: { x: 0, y: 0, z: 0 }, attachedToNodeId: '', attachedToNodeName: '', assignees: [], resolved: false } as SpatialComment;
const line = { id: 'm1', agentId: 'live-transcript', text: 'hello', timestamp: 1 } as ChatMessage;
const card = { id: 'k1' } as InsightCard;

describe('setActiveModelType', () => {
  beforeEach(() => {
    useStore.setState({ activeModelType: 'headphones', comments: [comment], chatHistory: [line], insightCards: [card] });
  });

  it('keeps comments, chat and cards when the model does not change', () => {
    useStore.getState().setActiveModelType('headphones');
    const s = useStore.getState();
    expect(s.comments).toHaveLength(1);
    expect(s.chatHistory).toHaveLength(1);
    expect(s.insightCards).toHaveLength(1);
  });

  it('still clears them when the model really changes', () => {
    useStore.getState().setActiveModelType('bicycle');
    const s = useStore.getState();
    expect(s.comments).toHaveLength(0);
    expect(s.chatHistory).toHaveLength(0);
    expect(s.insightCards).toHaveLength(0);
  });
});
