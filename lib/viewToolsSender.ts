// The store's way out to the room socket, for the room's view tools.
//
// Split out for exactly the reason lib/recordingState.ts and lib/transcriptKeep.ts were:
// `store.ts`'s `setViewTools` has to SEND the value it was given, because that is what
// makes a cut a thing the room is doing rather than a thing one browser is doing — and
// lib/usePartyPresence.ts imports the store, so a store → usePartyPresence import would be
// a cycle that also drags partysocket into every test that imports store.ts. This module
// has no dependencies of its own beyond a type, so both sides import it and neither
// imports the other.
//
// The writer is unchanged and is still in usePartyPresence: `broadcastViewTools`, which
// uses the same module-level socket ref `broadcastPointingSegment` uses and no-ops when
// this browser is not in a room. This module only holds the reference to it.

import type { ViewTools } from './scene/viewTools';

/** How a view-tools value reaches the room, or null while no room is connected. */
let sender: ((payload: ViewTools) => void) | null = null;

/** Register the sender. Called once, at module scope, by lib/usePartyPresence.ts. */
export function setViewToolsSender(send: ((payload: ViewTools) => void) | null): void {
  sender = send;
}

/**
 * Hand a value to the room, if there is one.
 *
 * Silent when there is not, which is the same answer `broadcastRecordingState` gives: the
 * lobby's preview canvas has view tools of its own to move and nothing to tell anybody
 * about them, and a local room with no server still has to be able to cut its model.
 */
export function sendViewTools(payload: ViewTools): void {
  sender?.(payload);
}
