// The way out of a room: back to the lobby.
//
// docs/plan/15-sessions-and-variants.md batch BN. Until this batch the only way out
// of a meeting was the browser's own back button or the address bar, neither of
// which is a control anybody finds twice — and the room's logo, which every other
// screen in this app treats as "home", went nowhere.
//
// LEAVING IS NOT ENDING. This navigates, and that is all it does: RoomPage unmounts,
// lib/usePartyPresence's cleanup closes the socket (so the room server drops this
// person's presence exactly as it does when a tab is closed) and lib/useWebRTC's
// stops the local microphone and camera tracks and closes every peer connection.
// Nothing here calls `endMeeting` or broadcasts MEETING_END, so the meeting carries
// on for everybody else and is recorded when somebody who is still in it ends it.
// A host who leaves this way does NOT end or record the meeting either: the room
// server hands the host to the next arrival on the socket closing, the way it does
// for a closed tab.

import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { clsx } from 'clsx';

const LobbyLink: React.FC<{
  /**
   * 'light' for the desktop room's white chrome, 'dark' for the mobile header,
   * which is white-on-black. Two tones rather than two components: the words, the
   * icon and the destination are the one thing that must not drift between them.
   */
  tone?: 'light' | 'dark';
}> = ({ tone = 'light' }) => (
  <Link
    to="/"
    title="Leave this room and go back to the lobby"
    aria-label="Back to the lobby"
    className={clsx(
      // pointer-events-auto because both headers this sits in are inside a layer
      // that ignores the pointer, so the canvas can have the rest of it.
      'pointer-events-auto inline-flex items-center gap-1 h-6 px-2 shrink-0 rounded-sm border',
      'font-mono text-[10px] font-bold uppercase tracking-wide transition-colors',
      tone === 'dark'
        ? 'text-gray-300 border-white/15 bg-white/5 hover:text-white hover:border-white/40'
        : 'text-gray-600 border-gray-200 bg-white hover:border-gray-400 hover:text-black',
    )}
  >
    <ArrowLeft size={12} />
    Lobby
  </Link>
);

export default LobbyLink;
