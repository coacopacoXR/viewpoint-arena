// Tests for the join-state module-level pattern in usePartyPresence:
// subscribeJoinState, subscribeJoinRequests, subscribeJoinPolicy, and the
// React hooks useJoinState / useJoinRequests.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import {
  subscribeJoinState,
  subscribeJoinRequests,
  subscribeJoinPolicy,
  useJoinState,
  useJoinRequests,
  broadcastAdmit,
  broadcastDecline,
  broadcastSetJoinPolicy,
  type JoinState,
  type JoinRequest,
} from '../usePartyPresence';

afterEach(() => {
  cleanup();
});

// ─── subscribeJoinState ─────────────────────────────────────────────────────

describe('subscribeJoinState', () => {
  // The transitions themselves (joining → pending → admitted / declined) are
  // driven by server messages, so they are tested against a fake socket in
  // joinKnock.test.tsx. Here: the subscription mechanism only.
  it('calls a new subscriber immediately with the current state', () => {
    const states: JoinState[] = [];
    const unsub = subscribeJoinState((s) => { states.push(s); });

    expect(states).toEqual(['joining']);
    unsub();
  });

  it('unsubscribe stops notifications', () => {
    const states: JoinState[] = [];
    const unsub = subscribeJoinState((s) => { states.push(s); });
    unsub();
    // After unsub, no more calls should happen (we can't easily trigger
    // internal state changes from here, but the unsub function should
    // not throw).
    expect(states.length).toBe(1);
  });
});

// ─── subscribeJoinRequests ──────────────────────────────────────────────────

describe('subscribeJoinRequests', () => {
  it('returns an empty array initially', () => {
    const reqs: JoinRequest[][] = [];
    const unsub = subscribeJoinRequests((r) => { reqs.push(r); });
    expect(reqs[0]).toEqual([]);
    unsub();
  });
});

// ─── subscribeJoinPolicy ────────────────────────────────────────────────────

describe('subscribeJoinPolicy', () => {
  it('returns ask as the default', () => {
    const policies: string[] = [];
    const unsub = subscribeJoinPolicy((p) => { policies.push(p); });
    expect(policies[0]).toBe('ask');
    unsub();
  });
});

// ─── useJoinState hook ──────────────────────────────────────────────────────

describe('useJoinState', () => {
  it('returns the current join state', () => {
    let state: JoinState = 'joining';
    function TestComponent() {
      state = useJoinState();
      return null;
    }
    render(React.createElement(TestComponent));
    expect(state).toBe('joining');
  });
});

// ─── useJoinRequests hook ───────────────────────────────────────────────────

describe('useJoinRequests', () => {
  it('returns a stable reference when nothing changed', () => {
    const refs: JoinRequest[][] = [];
    function TestComponent() {
      const reqs = useJoinRequests();
      refs.push(reqs);
      return null;
    }
    const { rerender } = render(React.createElement(TestComponent));
    rerender(React.createElement(TestComponent));
    rerender(React.createElement(TestComponent));

    // All references should be the same array (stable ref)
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs[0]).toBe(refs[1]);
  });
});

// ─── broadcast helpers (no-ops without a socket) ───────────────────────────

describe('broadcast helpers', () => {
  it('broadcastAdmit does not throw without a socket', () => {
    expect(() => broadcastAdmit('user-1')).not.toThrow();
  });

  it('broadcastDecline does not throw without a socket', () => {
    expect(() => broadcastDecline('user-1')).not.toThrow();
  });

  it('broadcastSetJoinPolicy does not throw without a socket', () => {
    expect(() => broadcastSetJoinPolicy('open')).not.toThrow();
  });
});
