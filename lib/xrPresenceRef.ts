import type { XRParticipantData } from '../types';

// Module-level map so XRManager (writer) and RemoteXRAvatars (reader) share data
// without going through React state — read every frame in useFrame.
export const remoteXRParticipants = new Map<string, XRParticipantData>();
