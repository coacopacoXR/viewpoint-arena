import type { RemoteParticipantInfo } from './usePartyPresence';
import type { AgentState } from '../types';

export type SplitScreenTarget =
  | { kind: 'agent'; id: string }
  | { kind: 'user'; userId: string }
  | null;

/**
 * Pick the default split-view target.
 *
 * Priority: first remote participant → first visible agent → null.
 */
export function pickDefaultSplitTarget(
  participants: RemoteParticipantInfo[],
  agents: AgentState[],
  hideAgents: boolean,
): SplitScreenTarget {
  if (participants.length > 0) {
    return { kind: 'user', userId: participants[0].userId };
  }
  if (!hideAgents && agents.length > 0) {
    return { kind: 'agent', id: agents[0].id };
  }
  return null;
}
