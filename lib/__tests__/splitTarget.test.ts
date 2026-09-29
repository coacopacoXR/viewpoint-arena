import { describe, it, expect } from 'vitest';
import { pickDefaultSplitTarget } from '../splitTarget';
import type { RemoteParticipantInfo } from '../usePartyPresence';
import type { AgentState } from '../../types';

function participant(userId: string): RemoteParticipantInfo {
  return { userId, name: `User ${userId}`, color: '#000' };
}

function agent(id: string): AgentState {
  return {
    id,
    name: `Agent ${id}`,
    role: 'REVIEWER',
    color: '#f00',
    style: 'BOX',
    behavior: 'IDLE',
    currentPoiId: null,
    weight: 1,
    status: 'ACTIVE',
    attentionLevel: 0,
  } as AgentState;
}

describe('pickDefaultSplitTarget', () => {
  it('returns the first participant when participants are present', () => {
    const result = pickDefaultSplitTarget(
      [participant('p1'), participant('p2')],
      [agent('a1')],
      false,
    );
    expect(result).toEqual({ kind: 'user', userId: 'p1' });
  });

  it('falls back to the first agent when no participants and agents visible', () => {
    const result = pickDefaultSplitTarget([], [agent('a1'), agent('a2')], false);
    expect(result).toEqual({ kind: 'agent', id: 'a1' });
  });

  it('returns null when no participants and agents hidden', () => {
    const result = pickDefaultSplitTarget([], [agent('a1')], true);
    expect(result).toBeNull();
  });

  it('returns null when no participants and no agents', () => {
    const result = pickDefaultSplitTarget([], [], false);
    expect(result).toBeNull();
  });
});
