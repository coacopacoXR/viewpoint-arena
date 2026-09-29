import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  Settings, LayoutGrid, Radio, Power, MonitorPlay,
  MessageSquare, X, Monitor, MonitorOff, Layers, ChevronRight, ChevronDown,
  Video, VideoOff, Mic, MicOff, Mic2, CheckCircle, XCircle, Share2, Camera,
  Volume2, VolumeX, Home,
} from 'lucide-react';
import SharePanel from '../SharePanel';
import { clsx } from 'clsx';
import { useStore } from '../../../store';
import { useShallow } from 'zustand/react/shallow';
import { InsightCard } from '../../../types';
import type { AgentState } from '../../../types';
import { usePresence } from '../../../lib/PresenceContext';
import { participantLabel, attendeeNames, getDisplayName } from '../../../lib/identity';
import InsightExplainer from '../InsightExplainer';
import MeetingManagerPopover from './MeetingManagerPopover';
import FocusLayout from './layouts/FocusLayout';
import GalleryLayout from './layouts/GalleryLayout';
import ConversationPanel from '../ConversationPanel';
import SceneTree from '../SceneTree';
import CommentsPanel from '../CommentsPanel';
import InsightDetailModal from '../InsightDetailModal';
import { useWebRTCContext } from '../../../lib/WebRTCContext';
import HumanParticipantTile from './HumanParticipantTile';
import MobileBoardroomLayout from './layouts/MobileBoardroomLayout';
import { useActiveReviewStore } from '../../../lib/activeReviewStore';
import ReviewPanelContent from '../ReviewPanelContent';
import { useIsMobile } from '../../../lib/useIsMobile';

// Thin collapsable floating panel wrapper used for tree and comments
const FloatingPanel: React.FC<{
  title: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  style?: React.CSSProperties;
  children: React.ReactNode;
  width?: number;
}> = ({ title, icon, isOpen, onToggle, style, children, width = 240 }) => (
  <div
    className="absolute z-[100] pointer-events-auto flex flex-col"
    style={style}
  >
    {/* Toggle button */}
    <button
      onClick={onToggle}
      className={clsx(
        'flex items-center gap-1.5 px-2 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all self-start shadow-md',
        isOpen
          ? 'bg-[#1a1a1a] text-white/70 border-white/20 rounded-b-none'
          : 'bg-[#1a1a1a]/80 text-white/40 border-white/10 hover:text-white/70 hover:border-white/20'
      )}
    >
      {icon}
      {title}
      {isOpen ? <ChevronDown size={9} /> : <ChevronRight size={9} />}
    </button>

    {/* Panel body */}
    {isOpen && (
      <div
        className="bg-[#0f0f0f]/95 backdrop-blur-md border border-t-0 border-white/15 rounded-b rounded-tr shadow-xl overflow-hidden"
        style={{ width }}
      >
        {children}
      </div>
    )}
  </div>
);

/** Stable empty list for when agents are hidden. */
const NO_AGENTS: AgentState[] = [];

const BoardroomShell: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const {
    agents, pois, chatHistory, time, isPrivacyMode,
    toggleBoardroomMode,
    boardroomLayout,
    boardroomInteractionEnabled,
    boardroomTranscriptPermission,
    endMeeting,
    boardroomLeaderId,
    takeoverModeEnabled,
    takeoverApprovedUserIds,
    boardroomPresenterDetachedId,
    resumeBoardroomPresenter,
    pendingPresenterRequest,
    setPendingPresenterRequest,
    presenterRequestStatus,
    setPresenterRequestStatus,
    sessionHostId,
    hideAgents,
  } = useStore(useShallow(state => ({
    agents: state.agents,
    pois: state.pois,
    chatHistory: state.chatHistory,
    time: state.time,
    isPrivacyMode: state.isPrivacyMode,
    toggleBoardroomMode: state.toggleBoardroomMode,
    boardroomLayout: state.boardroomLayout,
    boardroomInteractionEnabled: state.boardroomInteractionEnabled,
    boardroomTranscriptPermission: state.boardroomTranscriptPermission,
    endMeeting: state.endMeeting,
    boardroomLeaderId: state.boardroomLeaderId,
    takeoverModeEnabled: state.takeoverModeEnabled,
    takeoverApprovedUserIds: state.takeoverApprovedUserIds,
    boardroomPresenterDetachedId: state.boardroomPresenterDetachedId,
    resumeBoardroomPresenter: state.resumeBoardroomPresenter,
    pendingPresenterRequest: state.pendingPresenterRequest,
    setPendingPresenterRequest: state.setPendingPresenterRequest,
    presenterRequestStatus: state.presenterRequestStatus,
    setPresenterRequestStatus: state.setPresenterRequestStatus,
    sessionHostId: state.sessionHostId,
    hideAgents: state.hideAgents,
  })));

  const { localUserId, remoteParticipantList, broadcastArenaEntry, broadcastMeetingEnd, broadcastLeaderTakeover, broadcastPresenterRequest, broadcastPresenterRequestDenied } = usePresence();
  const { localStream, remoteStreams, isMicOn, isCamOn, toggleMic, toggleCam, isSpeakerOn, toggleSpeaker, isSameRoom, toggleSameRoom } = useWebRTCContext();
  const isHost = sessionHostId === localUserId || sessionHostId === null;
  const isPresenter = boardroomLeaderId === localUserId;
  // A non-approved participant in takeover mode can't grab the camera by dragging,
  // so they still need the explicit "Request to Present" button. Approved
  // takeover users get the button hidden because they can just drag to take over.
  const canSelfTakeover = takeoverModeEnabled && takeoverApprovedUserIds.includes(localUserId);

  // One handler for the two End buttons (the layout's and the manager's), because
  // they must do the same thing: the person at this browser pressed End, so this
  // browser is the one that records the meeting, with the names of who was in it
  // beside the head count. Everybody else hears MEETING_END and ends on screen
  // without writing a second session row — see store.meetingEndedRemotely.
  const endSession = () => {
    endMeeting(true, remoteParticipantList.length + 1, attendeeNames(getDisplayName(), remoteParticipantList));
    broadcastMeetingEnd();
  };

  // Auto-clear a "denied" toast after a few seconds so it doesn't linger.
  useEffect(() => {
    if (presenterRequestStatus !== 'denied') return;
    const t = setTimeout(() => setPresenterRequestStatus(null), 4000);
    return () => clearTimeout(t);
  }, [presenterRequestStatus, setPresenterRequestStatus]);

  // If the request becomes irrelevant (I became host, became presenter, or left
  // boardroom mode), drop it.
  useEffect(() => {
    if (isHost || isPresenter) {
      if (presenterRequestStatus) setPresenterRequestStatus(null);
    }
  }, [isHost, isPresenter, presenterRequestStatus, setPresenterRequestStatus]);

  // Stable mobile detection (UA + pointer capability). Resizing the window
  // must not toggle the user into the mobile layout mid-session.
  const isMobile = useIsMobile();

  // Presenter label based on the real person driving the camera
  const boardroomLeader = remoteParticipantList.find(p => p.userId === boardroomLeaderId);
  const leaderName = boardroomLeaderId === localUserId
    ? 'You'
    : boardroomLeader
      ? participantLabel(boardroomLeader.name, boardroomLeader.guest)
      : null;

  const [showManager, setShowManager] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [isWebcamOnly, setIsWebcamOnly] = useState(false);
  const [selectedInsightCard, setSelectedInsightCard] = useState<InsightCard | null>(null);
  const [showInsightExplainer, setShowInsightExplainer] = useState(false);

  // Track gallery panel width to position floating panels without occluding it
  const [galleryPanelWidth, setGalleryPanelWidth] = useState(320);

  const speakingAgentId = useMemo(() => {
    if (chatHistory.length === 0) return null;
    const last = chatHistory[chatHistory.length - 1];
    const age = (Date.now() / 1000) - last.timestamp;
    return age < 3 ? last.agentId : null;
  }, [chatHistory]);

  const [pinnedAgentId, setPinnedAgentId] = useState<string | null>(null);
  const handlePin = useCallback((agentId: string | null) => setPinnedAgentId(agentId), []);

  // One source of truth for whether agent tiles appear in the boardroom.
  // Layouts receive this as their `agents` prop; they never check hideAgents
  // themselves. NO_AGENTS is a module constant rather than a fresh `[]`: a new
  // array identity on every render defeats memoisation downstream, and this
  // codebase has already been bitten once by a selector that built one.
  const visibleAgents = hideAgents ? NO_AGENTS : agents;

  // If the speaking/pinned agent is not in the visible set, treat it as unset
  // for rendering. Don't write to the store — turning agents back on must
  // restore the exact prior state.
  const visibleSpeakingId = speakingAgentId && visibleAgents.some(a => a.id === speakingAgentId)
    ? speakingAgentId : null;
  const visiblePinnedId = pinnedAgentId && visibleAgents.some(a => a.id === pinnedAgentId)
    ? pinnedAgentId : null;

  // Camera presenter = real person (host or appointed). No AI-driven camera in boardroom.
  const presenterLabel = leaderName;

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Floating panel left edge: after gallery panel in gallery mode
  const floatingLeft = boardroomLayout === 'gallery' && !isWebcamOnly
    ? galleryPanelWidth + 10
    : 8;

  // Floating panel right edge: leave room for transcript if open
  const floatingCommentRight = showTranscript ? 348 : 8;

  // Build human tiles from WebRTC streams (local + remote participants)
  const localUserName = (() => {
    try {
      const s = localStorage.getItem('vp_user');
      return s ? (JSON.parse(s).name || 'You') : 'You';
    } catch { return 'You'; }
  })();

  const humanParticipants = [
    { userId: localUserId, name: localUserName, color: '#10b981', isYou: true },
    // Named here rather than in the tile so the "(guest)" suffix stays a
    // display concern: nothing downstream of this list is stored anywhere.
    ...remoteParticipantList.map(p => ({ ...p, name: participantLabel(p.name, p.guest), isYou: false })),
  ];

  const humanTiles = (
    <>
      {humanParticipants.map(p => (
        <HumanParticipantTile
          key={p.userId}
          stream={p.isYou ? localStream : (remoteStreams.get(p.userId) ?? null)}
          name={p.name}
          color={p.color}
          isMicOn={p.isYou ? isMicOn : true}
          isCamOn={p.isYou ? isCamOn : true}
          isYou={p.isYou}
          isPresenter={boardroomLeaderId === p.userId}
        />
      ))}
    </>
  );

  // Legacy self tile — kept as fallback (unused when humanTiles is passed)
  const userSelfTile = (
    <HumanParticipantTile
      stream={localStream}
      name={localUserName}
      color="#10b981"
      isMicOn={isMicOn}
      isCamOn={isCamOn}
      isYou
      isPresenter={boardroomLeaderId === localUserId}
    />
  );

  // Mobile: simplified layout — 3D fills screen, PiP cameras top-right, no AI insights
  if (isMobile) {
    return (
      <MobileBoardroomLayout
        localUserId={localUserId}
        localStream={localStream}
        remoteStreams={remoteStreams}
        remoteParticipantList={remoteParticipantList}
        isMicOn={isMicOn}
        isCamOn={isCamOn}
        toggleMic={toggleMic}
        toggleCam={toggleCam}
        onEnd={endSession}
        isHost={isHost}
        boardroomLeaderId={boardroomLeaderId}
      />
    );
  }

  const layoutProps = {
    agents: visibleAgents, speakingAgentId: visibleSpeakingId, pinnedAgentId: visiblePinnedId, pois,
    onPin: handlePin, presenterLabel,
    interactionEnabled: boardroomInteractionEnabled,
    screenSharing,
    userSelfTile,
    humanTiles,
    participantCount: visibleAgents.length + humanParticipants.length,
  };

  return (
    <div className="w-full h-full flex flex-col pointer-events-none">

      {/* Full-Screen Insight Detail Modal */}
      {selectedInsightCard && (
        <InsightDetailModal
          card={selectedInsightCard}
          onClose={() => setSelectedInsightCard(null)}
          agentColor={agents.find(a => a.id === selectedInsightCard.agentId)?.color}
        />
      )}

      {/* Full-Screen Insight Explainer */}
      {showInsightExplainer && (
        <InsightExplainer onClose={() => setShowInsightExplainer(false)} />
      )}

      {/* ── Top bar ── */}
      <div className="bg-[#111] border-b border-white/10 px-4 py-2 flex items-center justify-between shrink-0 pointer-events-auto z-[200]">

        {/* Left */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <MonitorPlay size={13} className="text-white/50" />
            <span className="text-white text-[11px] font-bold tracking-tight">BOARDROOM</span>
          </div>
          <div className="h-4 w-px bg-white/10" />
          {!isPrivacyMode && (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-green-400">
              <Radio size={8} className="animate-pulse" />
              REC
            </div>
          )}
          <div className="text-white/35 font-mono text-[9px]">{formatTime(time)}</div>
          {/* Speaking dots */}
          <div className="hidden sm:flex items-center gap-1">
            {visibleAgents.map(a => (
              <div
                key={a.id}
                className={clsx(
                  'w-5 h-5 rounded-full flex items-center justify-center text-[8px] text-white font-bold border-2 transition-all duration-200',
                  visibleSpeakingId === a.id ? 'border-green-400 scale-110' : 'border-white/10'
                )}
                style={{ backgroundColor: a.color }}
                title={a.name}
              >
                {a.name[0]}
              </div>
            ))}
          </div>
        </div>

        {/* Right */}
        <div className="flex items-center gap-1.5">

          {/* Share Screen */}
          {!isWebcamOnly && (
            <button
              onClick={() => setScreenSharing(!screenSharing)}
              className={clsx(
                'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
                screenSharing
                  ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'
                  : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
              )}
              title={screenSharing ? 'Stop sharing' : 'Share screen'}
            >
              {screenSharing ? <MonitorOff size={10} /> : <Monitor size={10} />}
              {screenSharing ? 'Stop' : 'Share'}
            </button>
          )}

          {/* Scene Tree */}
          <button
            onClick={() => setShowTree(!showTree)}
            className={clsx(
              'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
              showTree
                ? 'bg-white/15 text-white border-white/25'
                : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
            )}
            title="Scene Tree"
          >
            <Layers size={10} />
            Tree
          </button>

          {/* Comments */}
          <button
            onClick={() => setShowComments(!showComments)}
            className={clsx(
              'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
              showComments
                ? 'bg-white/15 text-white border-white/25'
                : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
            )}
            title="Comments"
          >
            <MessageSquare size={10} />
            Comments
          </button>

          {/* Review — only when a curated config is active */}
          <BoardroomReviewButton showReview={showReview} setShowReview={setShowReview} />


          {/* Mic toggle */}
          <button
            onClick={toggleMic}
            title={isMicOn ? 'Mute' : 'Unmute'}
            className={clsx(
              'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
              !isMicOn
                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
            )}
          >
            {isMicOn ? <Mic size={10} /> : <MicOff size={10} />}
            {isMicOn ? 'Mute' : 'Unmute'}
          </button>

          {/* Cam toggle */}
          <button
            onClick={toggleCam}
            title={isCamOn ? 'Stop video' : 'Start video'}
            className={clsx(
              'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
              !isCamOn
                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
            )}
          >
            {isCamOn ? <Video size={10} /> : <VideoOff size={10} />}
            {isCamOn ? 'Cam' : 'Cam Off'}
          </button>

          {/* Speaker toggle */}
          <button
            onClick={toggleSpeaker}
            title={isSpeakerOn ? 'Mute all remote audio' : 'Unmute remote audio'}
            className={clsx(
              'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
              !isSpeakerOn
                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
            )}
          >
            {isSpeakerOn ? <Volume2 size={10} /> : <VolumeX size={10} />}
            {isSpeakerOn ? 'Speaker' : 'Muted'}
          </button>

          {/* Same room toggle */}
          <button
            onClick={toggleSameRoom}
            title={isSameRoom ? 'In the same physical room' : 'Share a physical room'}
            className={clsx(
              'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
              isSameRoom
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
                : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
            )}
          >
            <Home size={10} />
            {isSameRoom ? 'Same Room' : 'Same Room'}
          </button>

          {/* Transcript */}
          {boardroomTranscriptPermission && (
            <button
              onClick={() => setShowTranscript(!showTranscript)}
              className={clsx(
                'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
                showTranscript
                  ? 'bg-blue-500/20 text-blue-300 border-blue-500/40'
                  : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
              )}
            >
              <MessageSquare size={10} />
              Transcript
            </button>
          )}

          <div className="h-5 w-px bg-white/10 mx-0.5" />

          {/* Share */}
          <div className="relative">
            <button
              onClick={() => setShowShare(v => !v)}
              className={clsx(
                'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
                showShare
                  ? 'bg-white text-black border-white'
                  : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
              )}
              title="Invite participants"
            >
              <Share2 size={10} />
              Share
            </button>
            {showShare && roomId && (
              <SharePanel roomId={roomId} onClose={() => setShowShare(false)} />
            )}
          </div>

          <div className="h-5 w-px bg-white/10 mx-0.5" />

          {/* Back to 3D Arena — host only */}
          {isHost && (
          <button
            onClick={() => { toggleBoardroomMode(); broadcastArenaEntry(); }}
            className="px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide bg-white/8 text-white/50 border border-white/10 hover:bg-white/15 hover:text-white transition-all flex items-center gap-1"
          >
            <LayoutGrid size={10} />
            3D Arena
          </button>
          )}

          {/* Manage — popover uses fixed positioning so always on top */}
          <div className="relative">
            <button
              onClick={() => setShowManager(!showManager)}
              className={clsx(
                'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
                showManager
                  ? 'bg-white text-black border-white'
                  : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
              )}
            >
              <Settings size={10} />
              Manage
            </button>
            {showManager && (
              <MeetingManagerPopover onClose={() => setShowManager(false)} />
            )}
          </div>

          {/* End — host only */}
          {isHost && (
          <button
            onClick={endSession}
            className="px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide bg-red-600/20 text-red-400 border border-red-500/30 hover:bg-red-600/40 transition-all flex items-center gap-1"
          >
            <Power size={10} />
            End
          </button>
          )}
        </div>
      </div>

      {/* ── Main content area ── */}
      <div className="flex-1 min-h-0 relative">

        {/* Leader presence badge — shown on the 3D shared screen area */}
        {boardroomLeaderId && leaderName && !isWebcamOnly && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[25] pointer-events-none">
            <div className="flex items-center gap-1.5 bg-[#0d0d0d]/80 border border-yellow-500/40 backdrop-blur-sm px-2.5 py-1 rounded-full text-[9px] font-mono">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shrink-0" />
              <span className="text-yellow-300 font-bold">{leaderName}</span>
              <span className="text-white/40">presenting</span>
            </div>
          </div>
        )}

        {/* Active layout */}
        {boardroomLayout === 'focus' && (
          <FocusLayout {...layoutProps} />
        )}
        {boardroomLayout === 'gallery' && (
          <GalleryLayout
            {...layoutProps}
            onPanelWidthChange={setGalleryPanelWidth}
            onWebcamOnlyChange={setIsWebcamOnly}
          />
        )}

        {/* ── Scene Tree floating panel ── */}
        {showTree && !isWebcamOnly && (
          <FloatingPanel
            title="Scene Tree"
            icon={<Layers size={10} />}
            isOpen={showTree}
            onToggle={() => setShowTree(false)}
            width={300}
            style={{ top: 8, left: floatingLeft }}
          >
            <div className="overflow-y-auto" style={{ maxHeight: 'calc(100vh - 120px)' }}>
              <SceneTree />
            </div>
          </FloatingPanel>
        )}

        {/* ── Comments floating panel ── */}
        {showComments && !isWebcamOnly && (
          <FloatingPanel
            title="Comments"
            icon={<MessageSquare size={10} />}
            isOpen={showComments}
            onToggle={() => setShowComments(false)}
            width={280}
            style={{ top: 8, right: floatingCommentRight }}
          >
            <div className="max-h-96 overflow-y-auto">
              <CommentsPanel />
            </div>
          </FloatingPanel>
        )}

        {/* Curated review viewpoints/pins panel — same FloatingPanel shell */}
        {showReview && !isWebcamOnly && (
          <FloatingPanel
            title="Review"
            icon={<Camera size={10} />}
            isOpen={showReview}
            onToggle={() => setShowReview(false)}
            width={340}
            style={{ top: 8, right: floatingCommentRight + (showComments ? 296 : 0) }}
          >
            <div className="max-h-[60vh] overflow-y-auto">
              <ReviewPanelContent theme="dark" />
            </div>
          </FloatingPanel>
        )}

        {/* ── Transcript popup — slides in from right ── */}
        {showTranscript && boardroomTranscriptPermission && (
          <div
            className="absolute top-0 right-0 bottom-0 z-[50] flex flex-col pointer-events-auto animate-in slide-in-from-right-4 duration-200"
            style={{ width: 340 }}
          >
            <div className="bg-[#0d0d0d]/95 backdrop-blur-md border-l border-white/10 flex flex-col h-full shadow-2xl">
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 shrink-0">
                <span className="text-white/50 text-[9px] font-mono uppercase tracking-wider flex items-center gap-2">
                  <MessageSquare size={9} />
                  Live Transcript & Insights
                </span>
                <button onClick={() => setShowTranscript(false)} className="text-white/30 hover:text-white transition-colors">
                  <X size={13} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <ConversationPanel />
              </div>
            </div>
          </div>
        )}

        {/* Host: incoming presenter request notification */}
        {isHost && pendingPresenterRequest && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[60] pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex items-center gap-3 bg-[#1a1a1a]/95 border border-white/20 backdrop-blur-md px-3 py-2 rounded-lg shadow-xl text-[10px] font-mono">
              <Mic2 size={11} className="text-yellow-400 shrink-0" />
              <span className="text-white/80">
                <span className="text-white font-bold">{pendingPresenterRequest.fromName}</span> wants to present
              </span>
              <button
                onClick={() => {
                  broadcastLeaderTakeover(pendingPresenterRequest.fromUserId);
                  setPendingPresenterRequest(null);
                }}
                className="flex items-center gap-1 bg-green-500/20 border border-green-500/40 text-green-300 px-2 py-0.5 rounded hover:bg-green-500/40 transition-colors"
              >
                <CheckCircle size={9} /> Allow
              </button>
              <button
                onClick={() => {
                  broadcastPresenterRequestDenied(pendingPresenterRequest.fromUserId);
                  setPendingPresenterRequest(null);
                }}
                className="flex items-center gap-1 bg-white/5 border border-white/15 text-white/40 px-2 py-0.5 rounded hover:bg-white/15 transition-colors"
              >
                <XCircle size={9} /> Deny
              </button>
            </div>
          </div>
        )}

        {/* Non-host, non-presenter: explicit request flow.
            Hidden for approved-in-takeover users (they grab via drag). */}
        {!isHost && !isPresenter && !canSelfTakeover && (
          <div className="absolute bottom-16 right-3 z-20 pointer-events-auto">
            {presenterRequestStatus === 'pending' ? (
              <div className="flex items-center gap-1.5 bg-yellow-500/15 border border-yellow-500/40 backdrop-blur-sm text-yellow-200 text-[9px] font-mono px-2.5 py-1.5 rounded-full">
                <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                Request sent — waiting for host…
                <button
                  onClick={() => setPresenterRequestStatus(null)}
                  className="ml-1 text-yellow-200/70 hover:text-white text-[10px]"
                  title="Cancel"
                >
                  ×
                </button>
              </div>
            ) : presenterRequestStatus === 'denied' ? (
              <div className="flex items-center gap-1.5 bg-red-500/15 border border-red-500/40 backdrop-blur-sm text-red-300 text-[9px] font-mono px-2.5 py-1.5 rounded-full">
                <XCircle size={10} />
                Request denied
              </div>
            ) : (
              <button
                onClick={() => {
                  const stored = localStorage.getItem('vp_user');
                  const name = stored ? JSON.parse(stored).name || 'Guest' : 'Guest';
                  broadcastPresenterRequest(localUserId, name);
                }}
                className="flex items-center gap-1.5 bg-[#1a1a1a]/80 border border-white/20 backdrop-blur-sm text-white/60 hover:text-white hover:border-white/40 text-[9px] font-mono px-2.5 py-1.5 rounded-full transition-all"
              >
                <Mic2 size={10} />
                Request to Present
              </button>
            )}
          </div>
        )}

        {/* Detachment indicator — shown when user dragged away from presenter cam */}
        {!isWebcamOnly && !screenSharing && boardroomPresenterDetachedId && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto animate-in fade-in duration-200">
            <div className="flex items-center gap-2 bg-orange-500/90 backdrop-blur-sm text-white text-[9px] font-mono px-3 py-1.5 rounded-full shadow-lg">
              <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              <span>FREE LOOK · auto-resume in 3s</span>
              <button
                onClick={resumeBoardroomPresenter}
                className="ml-1 bg-white/20 hover:bg-white/40 px-2 py-0.5 rounded text-[8px] font-bold transition-colors"
              >
                Resume
              </button>
            </div>
          </div>
        )}
        {/* Static hint when following presenter and not detached */}
        {!isWebcamOnly && boardroomLeaderId && !screenSharing && !boardroomPresenterDetachedId && !isPresenter && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
            <div className="bg-black/35 backdrop-blur-sm text-white/20 text-[8px] font-mono px-3 py-1 rounded-full whitespace-nowrap">
              drag to look around · auto-resumes after 3s
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Toolbar button for the curated-review panel. Hides when no review config is
// active so ad-hoc boardroom sessions stay uncluttered.
const BoardroomReviewButton: React.FC<{
  showReview: boolean;
  setShowReview: (v: boolean) => void;
}> = ({ showReview, setShowReview }) => {
  const config = useActiveReviewStore((s) => s.config);
  if (!config) return null;
  const total = config.viewpoints.length + config.pins.length;
  if (total === 0) return null;
  return (
    <button
      onClick={() => setShowReview(!showReview)}
      className={clsx(
        'px-2.5 py-1.5 rounded text-[9px] font-bold uppercase tracking-wide border transition-all flex items-center gap-1',
        showReview
          ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
          : 'bg-white/8 text-white/50 border-white/10 hover:bg-white/15 hover:text-white'
      )}
      title="Curated review viewpoints & pins"
    >
      <Camera size={10} />
      Review
      <span className="font-mono opacity-60 text-[8px]">{total}</span>
    </button>
  );
};

export default BoardroomShell;
