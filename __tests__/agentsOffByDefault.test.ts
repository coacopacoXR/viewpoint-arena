// The scripted agents (SYS.OP, ENG.UNIT, DES.LEAD, VR.USER) are demo
// furniture. A real review must not start with four fake participants
// standing next to the real ones, and must not record them as attendees.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const flushSessionToTracker = vi.fn();
vi.mock('../lib/trackerBridge', () => ({
  // async, because the real flushSessionToTracker answers a promise and store.ts
  // chains the meeting's minutes onto the session id it resolves with (batch BM).
  flushSessionToTracker: async (...args: unknown[]) => flushSessionToTracker(...args),
}));

import { useStore } from '../store';

describe('agents are off by default', () => {
  beforeEach(() => flushSessionToTracker.mockClear());
  afterEach(() => useStore.setState({ hideAgents: true, insightCards: [] }));

  it('a fresh room hides them', () => {
    expect(useStore.getState().hideAgents).toBe(true);
  });

  it('still ships the agents, so the toggle can bring them back', () => {
    expect(useStore.getState().agents.length).toBeGreaterThan(0);
  });

  it('records the real head count the caller passes, not the agents', () => {
    useStore.setState({ insightCards: [{ id: 'c1' }] as never });
    useStore.getState().endMeeting(true, 3);
    expect(flushSessionToTracker).toHaveBeenCalledTimes(1);
    expect(flushSessionToTracker.mock.calls[0][0]).toMatchObject({ participantCount: 3 });
  });

  it('falls back to one person when the caller passes nothing and agents are hidden', () => {
    useStore.setState({ insightCards: [{ id: 'c1' }] as never, hideAgents: true });
    useStore.getState().endMeeting(true);
    expect(flushSessionToTracker.mock.calls[0][0]).toMatchObject({ participantCount: 1 });
  });
});
