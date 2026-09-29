// The bottom call bar: the call itself (mic, speaker, same room), the four
// view modes, and the way out. One short centred bar, so the strip that used
// to hold the simulation transport holds the meeting instead.
//
// The handlers stay where they were — Interface owns the ones that broadcast
// (free view, leader, split) and passes them down; the call controls come
// straight from WebRTCContext.

import React from 'react';
import {
  Mic, MicOff, Volume2, VolumeX, Home,
  Activity, Users, Sparkles, SplitSquareHorizontal,
  Power, LogOut,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../../store';
import { ViewMode } from '../../../types';
import { usePresence } from '../../../lib/PresenceContext';
import { useWebRTCContext } from '../../../lib/WebRTCContext';
import { attendeeNames, getDisplayName } from '../../../lib/identity';
import BarButton from './BarButton';

const iconSlot =
  'w-9 h-9 shrink-0 flex items-center justify-center rounded-sm border transition-all duration-200 pointer-events-auto';
const idleSlot = 'bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-black hover:shadow-sm';

interface CallBarProps {
  isHost: boolean;
  onFreeView: () => void;
  onLeaderToggle: () => void;
  onSplitToggle: () => void;
  onLeave: () => void;
}

const CallBar: React.FC<CallBarProps> = ({ isHost, onFreeView, onLeaderToggle, onSplitToggle, onLeave }) => {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const setActiveAgent = useStore((s) => s.setActiveAgent);
  const leaderId = useStore((s) => s.leaderId);
  const endMeeting = useStore((s) => s.endMeeting);
  const { remoteParticipantList, broadcastMeetingEnd } = usePresence();
  const { isMicOn, toggleMic, isSpeakerOn, toggleSpeaker, isSameRoom, toggleSameRoom, micPermissionState } =
    useWebRTCContext();

  const micBlocked = micPermissionState === 'blocked';

  return (
    <div className="flex items-center gap-1.5 bg-white/90 backdrop-blur-md p-1.5 rounded-md border border-gray-200 shadow-sm transition-all hover:shadow-md pointer-events-auto">
      {/* Mic toggle — always visible in a room */}
      <button
        onClick={toggleMic}
        title={micBlocked ? 'Microphone blocked — re-enable in browser settings' : isMicOn ? 'Mute microphone' : 'Unmute microphone'}
        className={clsx(
          iconSlot,
          micBlocked
            ? 'bg-orange-100 text-orange-700 border-orange-300'
            : !isMicOn
              ? 'bg-red-600 text-white border-red-600 hover:bg-red-700'
              : idleSlot
        )}
      >
        {micBlocked ? <MicOff size={16} /> : isMicOn ? <Mic size={16} /> : <MicOff size={16} />}
      </button>

      {/* Speaker toggle — mutes all remote audio */}
      <button
        onClick={toggleSpeaker}
        title={isSpeakerOn ? 'Mute all remote audio' : 'Unmute remote audio'}
        className={clsx(
          iconSlot,
          !isSpeakerOn ? 'bg-red-600 text-white border-red-600 hover:bg-red-700' : idleSlot
        )}
      >
        {isSpeakerOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>

      {/* Same room toggle — mutes speakers, keeps mic live */}
      <button
        onClick={toggleSameRoom}
        title={isSameRoom ? 'You are in the same physical room' : 'Mark that you share a physical room with another participant'}
        className={clsx(
          iconSlot,
          isSameRoom ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : idleSlot
        )}
      >
        <Home size={16} />
      </button>

      <div className="w-px h-7 bg-gray-200 mx-0.5 shrink-0" />

      {/* View modes */}
      <BarButton
        active={viewMode === ViewMode.FREE && !leaderId}
        onClick={onFreeView}
        title="Free View"
      >
        <Activity size={16} />
      </BarButton>
      <BarButton
        active={leaderId === 'USER'}
        onClick={onLeaderToggle}
        title="Sync / Leader Mode"
        className={leaderId ? 'text-indigo-600 border-indigo-200' : ''}
      >
        <Users size={16} />
      </BarButton>
      <BarButton
        active={viewMode === ViewMode.AI_GUIDED}
        onClick={() => { setViewMode(ViewMode.AI_GUIDED); setActiveAgent(null); }}
        title="AI Guided Focus (Group Gaze)"
      >
        <Sparkles size={16} />
      </BarButton>
      <BarButton
        active={viewMode === ViewMode.SPLIT_SCREEN}
        onClick={onSplitToggle}
        title="Hybrid Split Screen"
      >
        <SplitSquareHorizontal size={16} />
      </BarButton>

      <div className="w-px h-7 bg-gray-200 mx-0.5 shrink-0" />

      {/* The way out: the host ends the session, everybody else leaves it. */}
      {isHost ? (
        <button
          onClick={() => {
            // The person at this browser pressed End, so this browser is the one
            // that records the meeting: the names travel with the head count, and
            // MEETING_END tells everybody else to end on screen without writing a
            // second session row. See store.meetingEndedRemotely.
            endMeeting(true, remoteParticipantList.length + 1, attendeeNames(getDisplayName(), remoteParticipantList));
            broadcastMeetingEnd();
          }}
          title="End Session"
          className={clsx(iconSlot, 'bg-black text-white border-black hover:bg-gray-800')}
        >
          <Power size={16} className="text-red-500" />
        </button>
      ) : (
        <button
          onClick={onLeave}
          title="Leave"
          className={clsx(iconSlot, 'bg-white text-gray-600 border-gray-200 hover:border-red-400 hover:text-red-600')}
        >
          <LogOut size={16} />
        </button>
      )}
    </div>
  );
};

export default CallBar;
