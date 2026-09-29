import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock PresenceContext.
const mockPresence: Record<string, unknown> = {
  remoteParticipantList: [] as { userId: string; name: string; color: string }[],
  localUserId: 'local-1',
};
vi.mock('../PresenceContext', () => ({
  usePresence: () => mockPresence,
}));

// Mock activeReviewStore.
let mockTeam: { id: string; name: string; role?: string; email?: string }[] = [];
vi.mock('../activeReviewStore', () => ({
  useActiveReviewStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = { config: { team: mockTeam } };
    if (typeof selector === 'function') return selector(state);
    return state;
  },
}));

// Mock identity.
let mockIdentity: { name: string; color: string } | null = { name: 'LocalUser', color: '#000' };
vi.mock('../identity', () => ({
  getIdentity: () => mockIdentity,
}));

import { usePeopleOptions } from '../people';

describe('usePeopleOptions', () => {
  beforeEach(() => {
    mockPresence.remoteParticipantList = [];
    mockPresence.localUserId = 'local-1';
    mockTeam = [];
    mockIdentity = { name: 'LocalUser', color: '#000' };
  });

  it('always starts with Unassigned', () => {
    const { result } = renderHook(() => usePeopleOptions());
    expect(result.current[0].name).toBe('Unassigned');
    expect(result.current[0].source).toBe('unassigned');
    expect(result.current[0].inRoom).toBe(false);
  });

  it('includes the local user tagged inRoom', () => {
    const { result } = renderHook(() => usePeopleOptions());
    const local = result.current.find((o) => o.name === 'LocalUser');
    expect(local).toBeDefined();
    expect(local!.inRoom).toBe(true);
    expect(local!.source).toBe('room');
  });

  it('includes remote participants tagged inRoom', () => {
    mockPresence.remoteParticipantList = [
      { userId: 'r1', name: 'RemoteA', color: '#f00' },
      { userId: 'r2', name: 'RemoteB', color: '#0f0' },
    ];
    const { result } = renderHook(() => usePeopleOptions());
    const names = result.current.map((o) => o.name);
    expect(names).toContain('RemoteA');
    expect(names).toContain('RemoteB');
    const remoteA = result.current.find((o) => o.name === 'RemoteA');
    expect(remoteA!.inRoom).toBe(true);
  });



  it('de-duplicates case-insensitively', () => {
    mockPresence.remoteParticipantList = [{ userId: 'r1', name: 'alice', color: '#f00' }];
    mockTeam = [{ id: 't1', name: 'ALICE' }];
    const { result } = renderHook(() => usePeopleOptions());
    const alices = result.current.filter((o) => o.name.toLowerCase() === 'alice');
    expect(alices).toHaveLength(1);
  });

  it('preserves the card existing value as orphan when it matches nobody', () => {
    const { result } = renderHook(() => usePeopleOptions('OldAssignee'));
    const orphan = result.current.find((o) => o.name === 'OldAssignee');
    expect(orphan).toBeDefined();
    expect(orphan!.source).toBe('orphan');
    expect(orphan!.inRoom).toBe(false);
  });

  it('does not duplicate the card existing value when someone in the room has that name', () => {
    mockPresence.remoteParticipantList = [{ userId: 'u2', name: 'OldAssignee', color: '#fff' }];
    const { result } = renderHook(() => usePeopleOptions('OldAssignee'));
    const matches = result.current.filter((o) => o.name === 'OldAssignee');
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('room');
  });

  it('does not add orphan for Unassigned', () => {
    const { result } = renderHook(() => usePeopleOptions('Unassigned'));
    const unassigned = result.current.filter((o) => o.name === 'Unassigned');
    expect(unassigned).toHaveLength(1);
  });

});
