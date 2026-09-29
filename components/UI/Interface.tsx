import React, { useState, useEffect, useRef, Suspense } from 'react';
import {
  Eye, EyeOff,
  User, Sparkles, Users,
  Layers, Network, Link, BellRing, X,
  Radio, Glasses, MessageSquare, MessageCircle, Mic,
  ChevronDown, ChevronRight, PanelRightClose, PanelRight,
  Home, Headphones
} from 'lucide-react';
// `Link` is aliased because lucide-react's own `Link` icon is imported above and is
// what the Linked Viewers HUD renders.
import { useParams, useNavigate, useSearchParams, Link as RouterLink } from 'react-router-dom';
import { useStore } from '../../store';
import { ViewMode } from '../../types';
import { usePresence } from '../../lib/PresenceContext';
import { participantLabel } from '../../lib/identity';
import { useWebRTCContext } from '../../lib/WebRTCContext';
import { pickDefaultSplitTarget } from '../../lib/splitTarget';
import { clsx } from 'clsx';
import ConversationPanel from './ConversationPanel';
import CommentsPanel from './CommentsPanel';
import ChatPanel from './ChatPanel';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import FingerPointerHost from './FingerPointerHost';
import ReviewViewpointsDock from './ReviewViewpointsDock';
import SceneTree from './SceneTree';
import MeetingSummary from './MeetingSummary';
import DataFlowDrawer from './DataFlowDrawer';
import ViewConfigExplainer from './ViewConfigExplainer';
import DeicticFeaturesExplainer from './DeicticFeaturesExplainer';
import DrawingCanvas from './DrawingCanvas';
import BoardroomShell from './Boardroom/BoardroomShell';
import BoardroomCountdown from './BoardroomCountdown';
import SplitViewOverlay from './SplitViewOverlay';
import JoinRequests from './JoinRequests';
import FollowersBadge, { FollowingBadge } from './FollowersBadge';
import TopBar from './room/TopBar';
import CallBar from './room/CallBar';
import ManageButton from './room/ManageButton';
import EmptyScenePrompt from './room/EmptyScenePrompt';
import LobbyLink from './room/LobbyLink';
import ReviewNameTag from './room/ReviewNameTag';
import EditingStrip from '../review/EditingStrip';
import { useSceneEditShortcuts } from '../../lib/scene/useSceneEditHistory';
import PlmLaunch from '../review/PlmLaunch';
import ReviewEditingNotice from '../review/ReviewEditingNotice';
import { useReviewRole } from '../../lib/reviews/useReviewRole';
import { useLeaderAutoRelease } from '../../lib/useLeaderAutoRelease';
import { useSessionMap } from '../../lib/reviews/useSessionMap';

/**
 * The review's editing tools, fetched when somebody actually turns Edit on.
 *
 * Batch BI. Only an owner or an editor with Edit on ever sees these tabs, but the
 * panel and the six tabs it renders were in the main chunk — the one every
 * participant downloads in order to look at a model. React.lazy rather than a
 * hand-rolled dynamic import because this is a component in a fixed place in the
 * tree, which is exactly what lazy is for; the tabs come with it, since they are
 * what it statically imports.
 */
const ReviewEditPanel = React.lazy(() => import('../review/ReviewEditPanel'));

/**
 * The map of this design review's sessions, fetched when somebody presses Sessions.
 *
 * Batch BK. Same reasoning as the panel above: the map is one SVG drawing and its
 * layout, but it is in the room's own chunk otherwise, and the room's chunk is what
 * every participant downloads in order to look at a model. Lazy here AND in
 * pages/TrackerPage.tsx — a static import from either one puts it straight back in
 * the main bundle.
 */
const SessionMap = React.lazy(() => import('../review/SessionMap'));

// The side panel owns the right edge, so every bar that centres on the *free*
// canvas has to stop short of it. Collapsed rail is 48px, the open panel 340px,
// plus a 24px gutter; in Manager mode the panel is gone and RoomPage has already
// taken the width off the flex row, so only the gutter is left.
const canvasRight = (managerMode: boolean, collapsed: boolean) =>
  managerMode ? 'right-6' : collapsed ? 'right-[72px]' : 'right-[364px]';

const Interface: React.FC = () => {
  const {
    viewMode, setViewMode, followingRemoteUserId, setFollowingRemoteUser,
    isPlaying,
    time,
    activeAgentId, setActiveAgent,
    leaderId, setLeader,
    splitScreenTarget, setSplitScreenTarget,
    agents,
    agentWeights, setAgentWeight,
    followRequest, setFollowRequest,
    isPrivacyMode,
    followedAgentId, setFollowedAgent,
    rightPanelMode, setRightPanelMode,
    comments,
    commentMode,
    temporarilyDisengagedFromAgentId,
    resumeFollowingAgent,
    showDrawingCanvas,
    setShowDrawingCanvas,
    capturedScreenshot,
    setCapturedScreenshot,
    setDrawingCanvas,
    setCommentMode,
    setPendingComment,
    setDrawingInteractionActive,
    isBoardroomMode,
    hideAgents,
    toggleHideAgents,
  } = useStore();

  const { localUserId, remoteParticipantList, broadcastPresenterChange, broadcastLeaderChange, setSameRoom, requestReviewEdit, endReviewEdit } = usePresence();
  const { isSameRoom } = useWebRTCContext();
  const sessionHostId = useStore(state => state.sessionHostId);
  const isHost = sessionHostId === localUserId || sessionHostId === null; // null = solo session, treat as host
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [showShare, setShowShare] = useState(false);
  const [isDataFlowOpen, setIsDataFlowOpen] = useState(false);
  const [showExplainer, setShowExplainer] = useState(false);
  const [showDeicticExplainer, setShowDeicticExplainer] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);

  // The map of this design review's sessions, opened from the top bar
  // (docs/plan/15 batch BK). Everybody in the room may open it — it changes nothing
  // — and it is read only while it is open: passing null until then means a meeting
  // that never looks at the map never asks the database for it.
  const [showSessions, setShowSessions] = useState(false);
  const reviewTitle = useActiveReviewStore((s) => s.config?.title ?? null);
  // The line this room resolved itself to, put in the store by pages/RoomPage.tsx.
  // Read here as well as in the top bar because the name in the corner says which
  // review a VARIANT belongs to, and only this knows which line the room is on.
  const activeLine = useStore((s) => s.activeLine);
  const sessionMap = useSessionMap(showSessions ? (roomId ?? null) : null);

  // Sync sameRoom flag with presence broadcasting
  useEffect(() => {
    setSameRoom(isSameRoom);
  }, [isSameRoom, setSameRoom]);

  // Headphones hint: shown once when 2+ participants are in the call
  const [showHeadphonesHint, setShowHeadphonesHint] = useState(false);
  useEffect(() => {
    if (remoteParticipantList.length >= 1 && !localStorage.getItem('vp_headphones_hint_dismissed')) {
      setShowHeadphonesHint(true);
    }
  }, [remoteParticipantList.length]);
  const dismissHeadphonesHint = () => {
    setShowHeadphonesHint(false);
    localStorage.setItem('vp_headphones_hint_dismissed', '1');
  };

  // Expandable panel states
  const [isSceneTreeExpanded, setIsSceneTreeExpanded] = useState(true);
  const [isSessionSyncExpanded, setIsSessionSyncExpanded] = useState(true);
  const [isFollowersExpanded, setIsFollowersExpanded] = useState(true);
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false);
  // When the host enters split-screen Manager mode, the right side-panel is
  // redundant (its tabs are absorbed into the workspace). Hide it entirely.
  const managerMode = useActiveReviewStore((s) => s.managerMode);
  const canvasRightClass = canvasRight(managerMode, isRightPanelCollapsed);

  // ─── Editing the review (batch BH) ─────────────────────────────────────────
  // `can` answers from what lib/reviews/roles.ts says about me in THIS review: the
  // deployment's identity mode, my account, the review's owner and roster, whether
  // I administer the install, and whether I am the meeting's host. The role itself
  // is not read here — every control this screen gates is an ACTION, and asking
  // `can('editReview')` rather than `role === 'owner' || role === 'editor'` is what
  // keeps the table in roles.ts the only place the answer is written down.
  // The Edit button is hidden rather than disabled for somebody who may not: it is
  // not a tool this meeting has, and the room server would refuse it anyway.
  const { can, rolesApply, loading: roleLoading, refresh: refreshRole } = useReviewRole({
    reviewId: roomId,
    sessionHostId,
    localUserId,
  });
  const mayEditReview = can('editReview');

  // Deleting is NARROWER than editing, and deliberately so: `deleteReview` in
  // lib/reviews/roles.ts is the owner's and this install's administrators', not its
  // editors' — changing a review's agenda is something an editor does every meeting,
  // and unmaking the review is not. On a deployment with NO accounts there is no owner
  // to be and no administrator to read off a token, so the meeting host is the person
  // api/reviews/delete.ts lets act, which is the same claim api/reviews/lines.ts
  // already takes. Everybody else sees the tabs and the map and nothing to press.
  const mayDeleteReview = !roleLoading && (rolesApply ? can('deleteReview') : isHost);

  const reviewEditing = useStore((s) => s.reviewEditing);
  // MINE, not "somebody is". The strip, the panel swap and the gizmo are all
  // gated on this; everybody else in the room gets the banner instead.
  const iAmEditing = reviewEditing !== null && reviewEditing.userId === localUserId;

  // Ctrl+Z / Ctrl+Shift+Z for the scene, and the thing that empties the undo stack
  // when the room is left. Mounted here rather than in the strip: the buttons belong
  // to Edit mode but the history does not — hiding a model in the tree and undoing it
  // a moment later is the same undo whether or not anybody has the edit lock.
  useSceneEditShortcuts();

  // ?edit=1 — where the lobby's "New design review" and a saved review's Edit both
  // land. Retried until the room answers rather than fired once: RoomPage navigates
  // before the presence socket has connected, and a single attempt would be dropped
  // silently, leaving the room open without the edit mode its own link promised.
  // Bails on either answer — granted or refused — so a person who does not have the
  // right is not asking sixteen times over eight seconds.
  //
  // The sender is read through a ref, and the effect depends on the QUERY alone.
  // usePartyPresence builds a fresh object every render, so listing the function
  // here would re-run this effect on every presence update — and, worse, would
  // re-run it after Done: reviewEditing back to null and no refusal on screen is
  // indistinguishable from "just arrived, not answered yet", so the room would be
  // asked again and Edit would turn straight back on. ?edit=1 is an arrival, and
  // an arrival happens once.
  const requestReviewEditRef = useRef(requestReviewEdit);
  useEffect(() => {
    requestReviewEditRef.current = requestReviewEdit;
  });
  const [searchParams] = useSearchParams();
  const wantsEditOnArrival = searchParams.get('edit') === '1';
  useEffect(() => {
    if (!wantsEditOnArrival) return;
    let settled = false;
    const ask = () => {
      const s = useStore.getState();
      if (s.reviewEditing || s.reviewEditRefusal) {
        settled = true;
        return;
      }
      requestReviewEditRef.current();
    };
    ask();
    const retry = setInterval(() => {
      ask();
      if (settled) clearInterval(retry);
    }, 500);
    const stop = setTimeout(() => clearInterval(retry), 8000);
    return () => { clearInterval(retry); clearTimeout(stop); };
  }, [wantsEditOnArrival]);

  // The collapse toggle has no meaning while the review's own tabs are up, and the
  // panel is the only place they are. Expanded, and not collapsible, for the length
  // of the edit — which also means the free canvas keeps the same inset either side
  // of the strip, so nothing jumps when Done is pressed.
  useEffect(() => {
    if (iAmEditing) setIsRightPanelCollapsed(false);
  }, [iAmEditing]);

  const unresolvedComments = comments.filter(c => !c.resolved).length;
  const liveChat = useStore(state => state.liveChat);
  const [lastSeenChatCount, setLastSeenChatCount] = useState(0);
  const unreadChat = rightPanelMode === 'chat' ? 0 : Math.max(0, liveChat.length - lastSeenChatCount);

  useEffect(() => {
    if (rightPanelMode === 'chat') setLastSeenChatCount(liveChat.length);
  }, [rightPanelMode, liveChat.length]);

  // Derived state for HUD: Who is following me?
  const myFollowers = agents.filter(a => a.behavior === 'FOLLOWING' || (leaderId === 'USER'));

  // Real people whose camera is locked to mine (myFollowers above is the agents).
  const humanFollowers = remoteParticipantList.filter(p => p.followingUserId === localUserId);
  // The person I follow, named once for the three places that show it.
  const followedParticipant = remoteParticipantList.find(p => p.userId === followingRemoteUserId);
  const followedName = followedParticipant
    ? participantLabel(followedParticipant.name, followedParticipant.guest)
    : null;
  // When the last of them leaves, leading has nothing left to lead.
  const { noteVisible: leaderReleaseNote } = useLeaderAutoRelease();

  const handleSplitToggle = () => {
      if (viewMode === ViewMode.SPLIT_SCREEN) {
          setViewMode(ViewMode.FREE);
      } else {
          setViewMode(ViewMode.SPLIT_SCREEN);
          if (!splitScreenTarget) {
              setSplitScreenTarget(pickDefaultSplitTarget(remoteParticipantList, agents, hideAgents));
          }
      }
  };

  const handleLeaderToggle = () => {
      // A follower detaches only themselves. Broadcasting null here used to
      // stop *every* client following, so one person leaving the follow ended
      // the session for people who never asked to leave it.
      if (followingRemoteUserId) {
          setFollowingRemoteUser(null);
          return;
      }
      if (leaderId) {
          setLeader(null);
          broadcastLeaderChange(null);
      } else {
          setLeader('USER');
          broadcastLeaderChange(localUserId);
      }
  };

  // The only control that leaves a follow or stops leading. Local when I am
  // following; a leader has to tell the room too, or the followers stay locked
  // to someone who has stopped leading.
  const handleFreeView = () => {
      const iAmLeading = leaderId === 'USER' && !followingRemoteUserId;
      setViewMode(ViewMode.FREE);
      setActiveAgent(null);
      if (iAmLeading) broadcastLeaderChange(null);
      setLeader(null);
  };
  
  const handleAcceptFollow = () => {
      if (followRequest) {
          setActiveAgent(followRequest.agentId);
          setViewMode(ViewMode.POV_AGENT);
          setFollowRequest(null);
      }
  };

  const showAIControls = viewMode === ViewMode.AI_GUIDED && !hideAgents;

  return (
    <div className="w-full h-full p-6 relative pointer-events-none">
      {/* Split-view connector (separator + name badges + target picker).
          Renders only when viewMode === SPLIT_SCREEN. */}
      <SplitViewOverlay />

      {/* Finger pointer prompt/calibration overlay + tracker host */}
      <FingerPointerHost />

      {/* (ReviewViewpointsDock is mounted inside the bottom dock below, not here.) */}

      {/* Drawing Canvas Overlay - Rendered at root level to avoid backdrop-filter containing block issues */}
      {showDrawingCanvas && (
        <DrawingCanvas
          backgroundImage={capturedScreenshot}
          onSave={(dataUrl) => {
            setDrawingCanvas(dataUrl);
            setShowDrawingCanvas(false);
            setCommentMode('none');
            setCapturedScreenshot(null);
          }}
          onCancel={() => {
            setShowDrawingCanvas(false);
            setCommentMode('none');
            setPendingComment(null, null, null);
            setDrawingCanvas(null);
            setDrawingInteractionActive(false);
            setCapturedScreenshot(null);
          }}
        />
      )}

      {/* High Z-Index Overlays - Pointer Events Auto handled inside components */}
      <div className="relative z-[200]">
          <MeetingSummary />
          {showExplainer && <ViewConfigExplainer onClose={() => setShowExplainer(false)} />}
          {showDeicticExplainer && <DeicticFeaturesExplainer onClose={() => setShowDeicticExplainer(false)} />}

          {/* The PLM launch this room was opened from (T5.3): Onshape's document
              browser, and the card that says what a launch recorded. Mounted at the
              room's own level rather than inside the Edit panel, because the
              reference it writes is written on ARRIVAL — before the room has
              answered the ?edit=1 request — and a child that only exists with Edit
              on would wait for an answer that may never come. Only the browser is
              gated on the amber strip, and it gates itself. */}
          <PlmLaunch />
      </div>
      
      {/* Drawer Layer */}
      <div className="relative z-[100]">
          <DataFlowDrawer isOpen={isDataFlowOpen} onClose={() => setIsDataFlowOpen(false)} />
      </div>

      {/* ── 3D Arena UI — hidden when Boardroom mode is active ── */}
      {!isBoardroomMode && <>

      {/* Header row: the room's name plate on the left, then the top bar in whatever
          canvas is left before the side panel. ONE flex row rather than two absolutely
          placed blocks, and that is the fix: the bar used to be centred from
          `left-[300px]` with no idea how wide the block beside it had grown, so a full
          bar ran back over the logo and forward under the panel, and the review's name
          — which batch BQ put inside the h1 — sat exactly where the bar covered it.
          Now the bar starts where the name plate ends and stops where the canvas does,
          and sheds its own labels when that is not enough (see TopBar). */}
      <div className={clsx(
        "absolute top-6 left-6 flex items-start gap-4 pointer-events-none z-[45]",
        canvasRightClass
      )}>
          {/* The way back to the lobby. The logo is the link — it is what every other
              screen in this app means by home, and until now it went nowhere — and
              the word beside it is there because a link nobody knows is a link is not
              a control anybody finds twice. Leaving this way LEAVES the meeting: it
              does not end it, does not record it, and does not end it for everybody
              else. See components/UI/room/LobbyLink.tsx. */}
          <header className="flex flex-col gap-1 shrink-0">
            <h1 className="font-bold tracking-tight text-lg text-neutral-900 flex items-center gap-2 whitespace-nowrap">
                <RouterLink
                  to="/"
                  title="Back to the lobby"
                  className="pointer-events-auto flex items-center gap-2 text-neutral-900 hover:opacity-60 transition-opacity"
                >
                  <div className={`w-3 h-3 rounded-full transition-colors ${isPlaying ? 'bg-orange-500 animate-pulse' : 'bg-gray-400'}`}></div>
                  VIEWPOINT ARENA
                </RouterLink>
                <LobbyLink />
            </h1>
            {/* Which design review this room is holding, where the sim's stopwatch used
                to be. Everybody in the room sees it, not only whoever may edit the
                review — knowing which one you are in is what makes it possible to take
                part in it, and a variant's room says which review its variant belongs
                to. It REPLACES "Design Review Sim // 56.4s", which counted a clock
                nobody in a meeting was ever racing, in the one line of the room's own
                chrome that could have said what the meeting was about. A room holding
                no review — an ad-hoc session, or one from before reviews — has no name
                to show and keeps the stopwatch rather than an empty row. */}
            <div className="font-mono text-xs text-neutral-500 uppercase tracking-wide">
                {(reviewTitle ?? '').trim() === ''
                  ? <>Design Review Sim // {Math.floor(time * 10) / 10}s</>
                  : <ReviewNameTag title={reviewTitle} line={activeLine} />}
            </div>
          </header>

          {/* The bar, in what is left of the canvas. TopBar centres itself and measures
              the box this wrapper gives it, so the same element is both the thing laid
              out and the thing that decides how much of itself fits. While THIS person
              has Edit on, the bar is the amber strip instead: the meeting's controls are
              not what they are here to use, and swapping them out is what makes that
              obvious to everybody watching the shared screen. */}
          <div className="flex-1 min-w-0 flex justify-center">
            {iAmEditing ? (
              <EditingStrip onDone={endReviewEdit} />
            ) : (
              <TopBar
                isHost={isHost}
                roomId={roomId}
                showShare={showShare}
                onToggleShare={() => setShowShare(v => !v)}
                showParticipants={showParticipants}
                onToggleParticipants={() => setShowParticipants(v => !v)}
                onOpenDeicticExplainer={() => setShowDeicticExplainer(true)}
                canEditReview={mayEditReview && !roleLoading && roomId !== undefined}
                onEditReview={() => requestReviewEdit()}
                onOpenSessions={roomId ? () => setShowSessions(v => !v) : undefined}
              />
            )}
          </div>
      </div>

      {/* Meta / Tree — the left column, under the name plate rather than beside it. */}
      <div className="flex flex-col items-start pointer-events-none z-[30] absolute top-[80px] left-6 max-h-[90vh]">
          {/* Scene Tree Integration - Expandable */}
          <div className="mt-2 pointer-events-auto">
            <button
              onClick={() => setIsSceneTreeExpanded(!isSceneTreeExpanded)}
              className="flex items-center gap-2 text-[10px] font-mono uppercase text-gray-500 tracking-widest mb-1 bg-white/60 px-2 py-1 rounded backdrop-blur-sm shadow-sm hover:bg-white/80 transition-colors w-fit"
            >
              {isSceneTreeExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Layers size={10} />
              Model Tree
            </button>
            <div className={clsx(
              "transition-all duration-300 overflow-hidden",
              isSceneTreeExpanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
            )}>
              <SceneTree />
            </div>
          </div>

          {/* SYNC / LEADER CONTROLS - Expandable — host only */}
          {isHost && <div className="mt-4 pointer-events-auto animate-in slide-in-from-left-4 fade-in duration-500">
            <button
              onClick={() => setIsSessionSyncExpanded(!isSessionSyncExpanded)}
              className="flex items-center gap-2 text-[10px] font-mono uppercase text-gray-500 tracking-widest mb-1 bg-white/60 px-2 py-1 rounded backdrop-blur-sm shadow-sm hover:bg-white/80 transition-colors w-fit"
            >
              {isSessionSyncExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Users size={10} />
              Session Sync
              {(leaderId || followingRemoteUserId) && <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>}
            </button>
            <div className={clsx(
              "transition-all duration-300 overflow-hidden",
              isSessionSyncExpanded ? "max-h-[200px] opacity-100" : "max-h-0 opacity-0"
            )}>
              <button
                  onClick={handleLeaderToggle}
                  className={clsx(
                      "w-64 px-3 py-2 rounded text-xs font-mono flex items-center justify-between shadow-sm border transition-all duration-300 group",
                      (leaderId || followingRemoteUserId)
                          ? "bg-indigo-600 text-white border-indigo-600 shadow-indigo-200"
                          : "bg-white/90 backdrop-blur text-gray-600 border-gray-200 hover:border-gray-400"
                  )}
              >
                  <div className="flex items-center gap-2">
                      <Users size={14} className={(leaderId || followingRemoteUserId) ? "text-white" : "text-gray-400 group-hover:text-gray-600"} />
                      <span className="font-bold">
                        {followingRemoteUserId
                          ? `FOLLOWING: ${followedName ?? '...'}`
                          : leaderId ? "SYNC ACTIVE: LEADING" : "SYNC INACTIVE"}
                      </span>
                  </div>
                  <div className={clsx(
                      "w-2 h-2 rounded-full",
                      (leaderId || followingRemoteUserId) ? "bg-white animate-pulse" : "bg-gray-300"
                  )}></div>
              </button>
              {leaderId && !followingRemoteUserId && (
                  <div className="w-64 mt-1 px-2 py-1.5 bg-indigo-50 border border-indigo-100 rounded text-[9px] text-indigo-800 leading-tight">
                      You are the session leader.{' '}
                      {humanFollowers.length > 0
                          ? `${humanFollowers.map(p => participantLabel(p.name, p.guest)).join(', ')} ${humanFollowers.length === 1 ? 'is' : 'are'} following your view.`
                          : 'Nobody is following yet.'}
                  </div>
              )}
              {followingRemoteUserId && (
                  <div className="w-64 mt-1 px-2 py-1.5 bg-indigo-50 border border-indigo-100 rounded text-[9px] text-indigo-800 leading-tight">
                      Following {followedName ?? 'remote user'}. Click again to detach.
                  </div>
              )}
            </div>
          </div>}

          {/* FOLLOWERS HUD - Expandable */}
          {myFollowers.length > 0 && !leaderId && (
              <div className="mt-4 pointer-events-auto animate-in slide-in-from-left-4 fade-in duration-500">
                <button
                  onClick={() => setIsFollowersExpanded(!isFollowersExpanded)}
                  className="flex items-center gap-2 text-[10px] font-mono uppercase text-gray-500 tracking-widest mb-1 bg-white/60 px-2 py-1 rounded backdrop-blur-sm shadow-sm hover:bg-white/80 transition-colors w-fit"
                >
                  {isFollowersExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Link size={10} />
                  Linked Viewers
                  <span className="bg-indigo-100 text-indigo-600 px-1.5 rounded text-[9px] font-bold">{myFollowers.length}</span>
                </button>
                <div className={clsx(
                  "transition-all duration-300 overflow-hidden",
                  isFollowersExpanded ? "max-h-[300px] opacity-100" : "max-h-0 opacity-0"
                )}>
                  <div className="w-64 flex flex-col gap-1">
                      {myFollowers.map(agent => (
                          <div key={agent.id} className="bg-white/80 backdrop-blur border border-gray-200 p-2 rounded flex items-center gap-2 shadow-sm">
                              <div className="relative">
                                  <div className="w-2 h-2 rounded-full animate-pulse" style={{backgroundColor: agent.color}}></div>
                                  <div className="absolute inset-0 w-2 h-2 rounded-full animate-ping opacity-20" style={{backgroundColor: agent.color}}></div>
                              </div>
                              <span className="text-xs font-bold text-gray-700">{agent.name}</span>
                              <span className="text-[9px] text-gray-400 font-mono ml-auto">FOLLOWING</span>
                          </div>
                      ))}
                  </div>
                </div>
              </div>
          )}
      </div>

      {/* The session map, over the canvas and centred on the same free space the
          top bar is: it is a panel about this design review, not a modal about the
          app, and it has to leave the left column and the side panel alone. Read
          only while open, so a meeting that never presses Sessions costs nothing. */}
      {showSessions && roomId && (
        <div className={clsx(
          "absolute top-[76px] bottom-6 left-[300px] z-[60] pointer-events-auto",
          canvasRightClass
        )}>
          <Suspense fallback={null}>
            <SessionMap
              reviewTitle={reviewTitle}
              lines={sessionMap.lines}
              sessions={sessionMap.sessions}
              revisions={sessionMap.revisions}
              cards={sessionMap.cards}
              onClose={() => setShowSessions(false)}
              emptyMessage={sessionMap.loading ? 'Reading this design review’s sessions…' : undefined}
              // The three variant actions, offered to the same people the Edit button
              // is offered to: starting, adopting and dropping a variant are all
              // `editReview` in lib/reviews/roles.ts, and hiding them here is the
              // panel not offering a tool the endpoint would refuse.
              reviewId={roomId ?? null}
              mayEditLines={mayEditReview && !roleLoading}
              // Deleting a session is narrower than changing a line: `deleteReview`
              // in lib/reviews/roles.ts, the owner and this install's admins.
              mayDelete={mayDeleteReview}
              isMeetingHost={isHost}
              onChanged={sessionMap.refresh}
              readTranscript={sessionMap.readTranscript}
            />
          </Suspense>
        </div>
      )}

      {/* Status indicators — top right of the canvas, below the bar and clear
          of the side panel, which now starts at the very top of the window. */}
      <div className={clsx(
        "absolute top-[76px] flex flex-col items-end gap-2 pointer-events-auto z-[40]",
        canvasRightClass
      )}>

           {/* Recording indicator when privacy mode is OFF */}
           {!isPrivacyMode && (
               <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-1.5 rounded text-[10px] font-mono flex items-center gap-2 animate-in fade-in slide-in-from-right-4">
                  <Radio size={10} className="text-green-500 animate-pulse" />
                  MEETING RECORDED
               </div>
           )}

           {/* Headphones hint — shown once when 2+ participants are in the call */}
           {showHeadphonesHint && (
               <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-1.5 rounded text-[10px] font-mono flex items-center gap-2 animate-in fade-in slide-in-from-right-4">
                  <Headphones size={10} />
                  Wearing headphones avoids echo
                  <button onClick={dismissHeadphonesHint} className="ml-1 hover:text-amber-600">
                    <X size={10} />
                  </button>
               </div>
           )}

           {activeAgentId && viewMode === ViewMode.POV_AGENT && (
               <div className="bg-black text-white px-3 py-1.5 rounded text-xs font-mono flex items-center gap-2 shadow-lg animate-in fade-in slide-in-from-right-4">
                  <User size={12} />
                  POSSESSING: {agents.find(a => a.id === activeAgentId)?.name}
                  <button onClick={() => { setActiveAgent(null); setViewMode(ViewMode.FREE); }} className="ml-2 hover:text-gray-300">✕</button>
               </div>
           )}

           {/* Temporarily Disengaged Indicator */}
           {temporarilyDisengagedFromAgentId && (
               <div className="bg-orange-500 text-white px-3 py-1.5 rounded text-xs font-mono flex items-center gap-2 shadow-lg animate-in fade-in slide-in-from-right-4">
                  <Eye size={12} className="animate-pulse" />
                  <span>PAUSED: {agents.find(a => a.id === temporarilyDisengagedFromAgentId)?.name}</span>
                  <button
                    onClick={resumeFollowingAgent}
                    className="ml-2 bg-white/20 hover:bg-white/30 px-2 py-0.5 rounded text-[10px] font-bold transition-colors"
                  >
                    Resume
                  </button>
               </div>
           )}
      </div>

      {/* Participants Panel - Positioned to not overlap with right panel */}
      {showParticipants && (
          <div className={clsx(
            "absolute top-28 z-[45] pointer-events-auto w-56 bg-white/95 backdrop-blur-md border border-gray-200 rounded-lg shadow-lg animate-in fade-in slide-in-from-right-4 duration-200 transition-all",
            canvasRightClass
          )}>
              <div className="p-2 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wider flex items-center gap-2">
                      <Users size={12} /> Participants
                  </span>
                  <span className="text-[9px] bg-gray-200 text-gray-600 px-1.5 rounded-full font-mono">{(hideAgents ? 0 : agents.length) + remoteParticipantList.length}</span>
              </div>
              <div className="p-2 flex flex-col gap-1 max-h-64 overflow-y-auto custom-scrollbar">
                  {hideAgents && agents.length > 0 && (
                    <div className="px-2 py-1.5 text-[9px] font-mono text-gray-400 flex items-center gap-1.5">
                      <EyeOff size={10} /> AI agents hidden
                    </div>
                  )}
                  {!hideAgents && agents.map(agent => {
                      const isFollowing = followedAgentId === agent.id;
                      const isVR = agent.id === '4';
                      return (
                          <button
                              key={agent.id}
                              onClick={() => {
                                  if (isFollowing) {
                                      setFollowedAgent(null);
                                      setActiveAgent(null);
                                      setViewMode(ViewMode.FREE);
                                      broadcastPresenterChange(null);
                                  } else {
                                      setFollowedAgent(agent.id);
                                      setActiveAgent(agent.id);
                                      setViewMode(ViewMode.POV_AGENT);
                                      broadcastPresenterChange(agent.id);
                                  }
                              }}
                              className={clsx(
                                  "w-full p-2 rounded-lg text-left flex items-center gap-2 transition-all",
                                  isFollowing
                                      ? "bg-black text-white shadow-md"
                                      : "bg-gray-50 hover:bg-gray-100 text-gray-700"
                              )}
                          >
                              <div
                                  className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[9px] font-bold shadow-sm shrink-0"
                                  style={{ backgroundColor: agent.color }}
                              >
                                  {isVR ? <Glasses size={12} /> : agent.name[0]}
                              </div>
                              <div className="flex-1 min-w-0">
                                  <div className="font-mono text-[10px] font-bold flex items-center gap-1 truncate">
                                      {agent.name}
                                      {isVR && (
                                          <span className={clsx(
                                              "text-[7px] px-1 py-0.5 rounded uppercase shrink-0",
                                              isFollowing ? "bg-white/20 text-white" : "bg-purple-100 text-purple-600"
                                          )}>
                                              VR
                                          </span>
                                      )}
                                  </div>
                                  <div className={clsx(
                                      "text-[8px] capitalize truncate",
                                      isFollowing ? "text-gray-300" : "text-gray-400"
                                  )}>
                                      {agent.role.toLowerCase()}
                                  </div>
                              </div>
                              {isFollowing && (
                                  <div className="text-[8px] bg-white/20 px-1.5 py-0.5 rounded font-bold shrink-0">
                                      POV
                                  </div>
                              )}
                          </button>
                      );
                  })}

                  {/* Remote (real) participants */}
                  {remoteParticipantList.length > 0 && (
                      <div className="mt-1 pt-1 border-t border-gray-100">
                          <div className="text-[8px] uppercase text-gray-400 tracking-wider px-1 mb-1">Live</div>
                          {/* Same-room summary line */}
                          {remoteParticipantList.some(p => p.sameRoom) && (
                              <div className="px-2 py-1 mb-1 text-[8px] font-mono text-indigo-600 bg-indigo-50 rounded flex items-center gap-1">
                                  <Home size={8} />
                                  {remoteParticipantList.filter(p => p.sameRoom).map(p => participantLabel(p.name, p.guest)).join(', ')} in same room
                              </div>
                          )}
                          {remoteParticipantList.map(p => {
                              const isFollowing = followingRemoteUserId === p.userId;
                              return (
                                  <button
                                      key={p.userId}
                                      onClick={() => {
                                          if (isFollowing) {
                                              // Local only — the leader (and everyone
                                              // else following them) keeps going.
                                              setFollowingRemoteUser(null);
                                          } else {
                                              // Anti-circular: cannot follow someone who is already following you
                                              if (leaderId === 'USER' && !followingRemoteUserId) return;
                                              setFollowingRemoteUser(p.userId);
                                          }
                                      }}
                                      className={clsx(
                                          "w-full p-2 rounded-lg text-left flex items-center gap-2 transition-all",
                                          isFollowing
                                              ? "bg-black text-white shadow-md"
                                              : "bg-gray-50 hover:bg-gray-100 text-gray-700"
                                      )}
                                  >
                                      <div
                                          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[9px] font-bold shadow-sm shrink-0"
                                          style={{ backgroundColor: p.color }}
                                      >
                                          {p.name[0]?.toUpperCase() || '?'}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                          <div className="font-mono text-[10px] font-bold truncate flex items-center gap-1">
                                              {participantLabel(p.name, p.guest)}
                                              {p.sameRoom && <Home size={7} className="text-indigo-500 shrink-0" />}
                                          </div>
                                          <div className={clsx("text-[8px]", isFollowing ? "text-gray-300" : "text-gray-400")}>human</div>
                                      </div>
                                      {isFollowing
                                          ? <div className="text-[8px] bg-white/20 px-1.5 py-0.5 rounded font-bold shrink-0">POV</div>
                                          : <div className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="Online" />
                                      }
                                  </button>
                              );
                          })}
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* RIGHT PANEL: Mode Switcher + Content. A full-height column that owns
          the right edge — the manager workspace takes the same edge, and the
          two never show at once. Hidden while the host is in split-screen
          Manager mode (its tabs live there instead). */}
      {!managerMode && (
      <div className={clsx(
        "absolute right-0 top-0 bottom-0 flex flex-col pointer-events-none z-[40] bg-white border-l border-gray-200 transition-all duration-300",
        isRightPanelCollapsed ? "w-12" : "w-[340px]"
      )}>
        {/* Collapse Toggle Button. Not offered while editing: the panel is the only
            place the review's tabs are, so collapsing it would leave the amber strip
            editing something the editor cannot see. */}
        {!iAmEditing && (
        <button
          onClick={() => setIsRightPanelCollapsed(!isRightPanelCollapsed)}
          className="pointer-events-auto m-2 shrink-0 w-10 h-10 bg-white rounded-lg border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-100 transition-all self-end"
          title={isRightPanelCollapsed ? "Expand panel" : "Collapse panel"}
        >
          {isRightPanelCollapsed ? (
            <PanelRight size={16} className="text-gray-600" />
          ) : (
            <PanelRightClose size={16} className="text-gray-600" />
          )}
        </button>
        )}

        {/* Panel Content - Hidden when collapsed. Swapped wholesale while Edit is
            on: the review's own tabs, in the order the user approved, rather than
            the meeting's. The call keeps running — this is a change of what the
            panel holds, not of what the room is doing. */}
        {!isRightPanelCollapsed && iAmEditing && (
          <div className="flex-1 min-h-0 flex flex-col px-2 pb-2 pointer-events-auto">
            {/* The placeholder is the panel's own dark surface with nothing in it,
                so the side panel does not change size or colour while the chunk
                arrives. Neutral on purpose: it stands in for six tabs and should
                not look like one of them. */}
            <Suspense fallback={
              <div className="flex-1 min-h-0 rounded-lg border border-white/10 bg-[#111] p-5">
                <p className="text-[11px] text-gray-500">Loading the editing tools…</p>
              </div>
            }>
              <ReviewEditPanel
                reviewId={roomId ?? ''}
                onRosterChanged={refreshRole}
                mayDeleteReview={mayDeleteReview}
              />
            </Suspense>
          </div>
        )}
        {!isRightPanelCollapsed && !iAmEditing && (
          <div className="flex-1 min-h-0 flex flex-col gap-2 px-2 pb-2">
            {/* Panel Mode Toggle */}
            <div className="flex shrink-0 pointer-events-auto bg-white rounded-lg border border-gray-200 shadow-sm p-1 gap-0.5">
              <button
                onClick={() => setRightPanelMode('meeting')}
                className={clsx(
                  "flex-1 px-2 py-2 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all",
                  rightPanelMode === 'meeting'
                    ? "bg-black text-white"
                    : "text-gray-500 hover:bg-gray-100"
                )}
              >
                <Mic size={11} />
                Capture
              </button>
              <button
                onClick={() => setRightPanelMode('comments')}
                className={clsx(
                  "flex-1 px-2 py-2 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all relative",
                  rightPanelMode === 'comments'
                    ? "bg-black text-white"
                    : "text-gray-500 hover:bg-gray-100"
                )}
              >
                <MessageSquare size={11} />
                Comments
                {unresolvedComments > 0 && (
                  <span className={clsx(
                    "absolute -top-1 -right-1 w-4 h-4 rounded-full text-[8px] flex items-center justify-center font-bold",
                    rightPanelMode === 'comments' ? "bg-white text-black" : "bg-blue-500 text-white"
                  )}>
                    {unresolvedComments}
                  </span>
                )}
              </button>
              <button
                onClick={() => setRightPanelMode('chat')}
                className={clsx(
                  "flex-1 px-2 py-2 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all relative",
                  rightPanelMode === 'chat'
                    ? "bg-black text-white"
                    : "text-gray-500 hover:bg-gray-100"
                )}
              >
                <MessageCircle size={11} />
                Chat
                {unreadChat > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[8px] flex items-center justify-center font-bold bg-green-500 text-white">
                    {unreadChat > 9 ? '9+' : unreadChat}
                  </span>
                )}
              </button>
            </div>

            {/* Panel Content */}
            <div className="flex-1 min-h-0 pointer-events-auto bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
              {rightPanelMode === 'meeting' ? (
                <ConversationPanel />
              ) : rightPanelMode === 'comments' ? (
                <CommentsPanel />
              ) : (
                <ChatPanel />
              )}
            </div>
          </div>
        )}

        {/* Collapsed indicators */}
        {isRightPanelCollapsed && (
          <div className="flex flex-col gap-2 pointer-events-auto px-1">
            <button
              onClick={() => { setIsRightPanelCollapsed(false); setRightPanelMode('meeting'); }}
              className={clsx(
                "w-10 h-10 bg-white rounded-lg border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-100 transition-all",
                rightPanelMode === 'meeting' && "border-black bg-black text-white hover:bg-gray-800"
              )}
              title="Meeting Capture"
            >
              <Mic size={16} />
            </button>
            <button
              onClick={() => { setIsRightPanelCollapsed(false); setRightPanelMode('comments'); }}
              className={clsx(
                "w-10 h-10 bg-white rounded-lg border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-100 transition-all relative",
                rightPanelMode === 'comments' && "border-black bg-black text-white hover:bg-gray-800"
              )}
              title="Comments"
            >
              <MessageSquare size={16} />
              {unresolvedComments > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[8px] flex items-center justify-center font-bold bg-blue-500 text-white">
                  {unresolvedComments}
                </span>
              )}
            </button>
            <button
              onClick={() => { setIsRightPanelCollapsed(false); setRightPanelMode('chat'); }}
              className={clsx(
                "w-10 h-10 bg-white rounded-lg border border-gray-200 shadow-sm flex items-center justify-center hover:bg-gray-100 transition-all relative",
                rightPanelMode === 'chat' && "border-black bg-black text-white hover:bg-gray-800"
              )}
              title="Chat"
            >
              <MessageCircle size={16} />
              {unreadChat > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full text-[8px] flex items-center justify-center font-bold bg-green-500 text-white">
                  {unreadChat > 9 ? '9+' : unreadChat}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      )}

      {/* Comment Mode Indicator */}
      {(commentMode === 'placing-comment' || commentMode === 'placing-drawing' || commentMode === 'placing-pin') && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[50] pointer-events-none">
          <div className={`px-6 py-3 rounded-lg shadow-lg animate-pulse ${commentMode === 'placing-drawing' ? 'bg-purple-500/90' : commentMode === 'placing-pin' ? 'bg-amber-500/90' : 'bg-blue-500/90'} text-white`}>
            <div className="text-sm font-bold text-center">
              {commentMode === 'placing-comment' && 'Click on the 3D model to place comment'}
              {commentMode === 'placing-drawing' && 'Click on the 3D model to anchor your drawing'}
              {commentMode === 'placing-pin' && 'Click the model to place the pin'}
            </div>
          </div>
        </div>
      )}
      
      {/* OVERLAY: AI View Sliders - Positioned to the left of right panel */}
      {showAIControls && (
         <div className={clsx(
           "absolute top-28 z-[40] pointer-events-auto w-48 bg-white/95 backdrop-blur-md border border-gray-200 rounded-lg shadow-sm p-2.5 animate-in slide-in-from-right-4 transition-all",
           canvasRightClass
         )}>
             <div className="flex items-center gap-2 mb-2 border-b border-gray-100 pb-2">
                 <Sparkles size={12} className="text-purple-600"/>
                 <span className="text-[10px] font-bold text-gray-700">AI Camera Weights</span>
             </div>
             <div className="flex flex-col gap-3">
                {agents.map(agent => (
                    <div key={agent.id} className="flex flex-col gap-1">
                        <div className="flex justify-between text-[9px] font-mono text-gray-500 uppercase">
                            <span style={{color: agent.color}}>{agent.name}</span>
                            <span>{agentWeights[agent.id]}</span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="10"
                            step="1"
                            value={agentWeights[agent.id] || 0}
                            onChange={(e) => setAgentWeight(agent.id, parseInt(e.target.value))}
                            className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
                        />
                    </div>
                ))}
             </div>
         </div>
      )}

      {/* BOTTOM-LEFT TOGGLES
          No width-dependent lift any more. The old bottom-[97px] below 1360px
          existed because the dock was centred on the *window* and ~1030px wide,
          so at 1280px its left edge landed 11px inside this cluster. The bottom
          row is now inset left-[300px] and centres on the free canvas, so it
          cannot reach this cluster at any width; both sit at bottom-6/bottom-8.
          The labels stay readable (shrinking them to icons hides whether the
          agents are on, which is the one thing this button is for). */}
      <div className="absolute bottom-6 left-6 z-[40] pointer-events-auto flex flex-col gap-2 items-start">
          <button
            onClick={toggleHideAgents}
            className={clsx(
                "flex items-center gap-2 px-3 py-2 rounded-full border shadow-sm transition-all hover:scale-105",
                hideAgents
                    ? "bg-black text-white border-black"
                    : "bg-white/90 backdrop-blur text-gray-600 border-gray-200 hover:border-gray-400"
            )}
          >
              {hideAgents ? <EyeOff size={14} className="text-orange-400" /> : <Eye size={14} className="text-gray-400" />}
              <span className="text-[10px] font-bold uppercase tracking-wide">
                {hideAgents ? 'Agents Off' : 'Agents On'}
              </span>
          </button>
          <button
            onClick={() => setIsDataFlowOpen(!isDataFlowOpen)}
            className={clsx(
                "flex items-center gap-2 px-3 py-2 rounded-full border shadow-sm transition-all hover:scale-105",
                isDataFlowOpen
                    ? "bg-black text-white border-black"
                    : "bg-white/90 backdrop-blur text-gray-600 border-gray-200 hover:border-gray-400"
            )}
          >
              <Network size={14} className={isDataFlowOpen ? "text-emerald-400" : "text-gray-400"} />
              <span className="text-[10px] font-bold uppercase tracking-wide">Data Flow</span>
          </button>

      </div>

      {/* BOTTOM ROW: the call bar (call controls · view modes · the way out),
          with the review pill and the host's Manage button beside it. Centred on
          the free canvas: the row starts at x=300, so it can never reach the
          bottom-left cluster (x=24, ~110px wide) whatever the window width. */}
      <div className={clsx(
        "absolute bottom-8 left-[300px] flex items-end justify-center pointer-events-none gap-3 z-[30]",
        canvasRightClass
      )}>

        {/* Center: View Modes, and the call controls that share their bar */}
        <div className="flex flex-col items-center gap-2 pointer-events-auto">
            {/* Who is locked to my camera, so leading is not a guess */}
            <FollowersBadge />
            {leaderReleaseNote && (
              <div className="px-3 py-1 rounded-full bg-white/90 backdrop-blur-md border border-gray-200 shadow-sm font-mono text-[10px] uppercase tracking-wide text-gray-500">
                Nobody is following any more — back to free view
              </div>
            )}
            <button
                onClick={() => setShowExplainer(true)}
                className="text-[10px] font-mono uppercase text-gray-400 tracking-widest mb-1 bg-white/40 px-2 py-0.5 rounded backdrop-blur-sm shadow-sm hover:bg-white/80 hover:text-black transition-colors"
            >
                View Configuration
            </button>
            <CallBar
              isHost={isHost}
              onFreeView={handleFreeView}
              onLeaderToggle={handleLeaderToggle}
              onSplitToggle={handleSplitToggle}
              onLeave={() => navigate('/')}
            />
        </div>

        {/* Active Review pane (replaces the old Visual Aids panel) */}
        <ReviewViewpointsDock />

        {/* The host's way into the manager workspace. Beside the bar rather than
            inside the review pane, so it is there before the review has
            produced anything. */}
        <ManageButton />

      </div>

      {/* What an empty room says about itself, centred on the free canvas like
          every other overlay here. Inside the !isBoardroomMode branch: a
          boardroom session has its own overlay covering this one. Under the bars
          (z-20 against their 30 and 45) so it can never sit on top of the call
          controls or the amber strip. */}
      <div className={clsx(
        "absolute inset-y-0 left-[300px] flex items-center justify-center pointer-events-none z-[20]",
        canvasRightClass
      )}>
        <EmptyScenePrompt />
      </div>

      </> /* end !isBoardroomMode */}

      {/* BELOW THE TOP BAR, centred on the same free canvas: an agent's request
          to follow, the knocks waiting to be admitted, and my own follow state.
          One stack, so the three never land on each other or on the bar.
          JoinRequests stays OUTSIDE the !isBoardroomMode branch above, and above
          the boardroom overlay's z-[150]: a knock during a boardroom session was
          invisible to the host, so the person outside waited until the host
          happened to leave the boardroom. In boardroom mode there is no top bar
          and no side panel, so the stack keeps its old window-centred spot. */}
      <div className={clsx(
        "absolute flex flex-col items-center gap-2 pointer-events-none z-[250]",
        isBoardroomMode
          ? "top-8 left-0 right-0"
          : clsx("top-[76px] left-[300px]", canvasRightClass)
      )}>
          {/* EDITING THE REVIEW: who is, what the room said to me when I asked, and
              who took it away. In this stack rather than in the bar, because it is
              for the people who are NOT editing — the editor has the amber strip —
              and the stack is where the room already puts "something is happening
              that you should know about". */}
          {!isBoardroomMode && (
            <div className="pointer-events-auto">
              <ReviewEditingNotice localUserId={localUserId} onTakeOver={() => requestReviewEdit(true)} />
            </div>
          )}

          {/* REQUEST TOAST */}
          {!isBoardroomMode && followRequest && (
              <div className="pointer-events-auto animate-in slide-in-from-top-4 fade-in">
              <div className="bg-black/90 text-white backdrop-blur-md px-4 py-3 rounded-lg shadow-2xl flex items-center gap-4 border border-gray-700">
                  <div className="flex items-center gap-2">
                      <BellRing className="text-orange-400 animate-bounce" size={18} />
                      <div className="flex flex-col">
                          <span className="text-xs font-bold uppercase tracking-wide">Request to Follow</span>
                          <span className="text-[10px] text-gray-400 font-mono">
                              {agents.find(a => a.id === followRequest.agentId)?.name} wants to show you something.
                          </span>
                      </div>
                  </div>
                  <div className="h-8 w-px bg-gray-700"></div>
                  <div className="flex gap-2">
                      <button
                        onClick={handleAcceptFollow}
                        className="px-3 py-1.5 bg-white text-black rounded text-xs font-bold hover:bg-gray-200 transition-colors"
                      >
                          Accept
                      </button>
                      <button
                        onClick={() => setFollowRequest(null)}
                        className="px-2 py-1.5 text-gray-400 hover:text-white transition-colors"
                      >
                          <X size={14} />
                      </button>
                  </div>
              </div>
              </div>
          )}

          {isHost && <JoinRequests />}

          {/* Follow state. Dragging is only a nudge that snaps back; this pill
              says so, and holds the one control that actually leaves. */}
          {!isBoardroomMode && (
            <div className="pointer-events-auto">
              <FollowingBadge onFreeView={handleFreeView} />
            </div>
          )}
      </div>

      {/* Boardroom Mode Overlay — pointer-events-none so transparent area passes events to canvas */}
      {isBoardroomMode && (
        <div className="absolute inset-0 z-[150] pointer-events-none">
          <BoardroomShell />
        </div>
      )}

      {/* Boardroom countdown — shown to all clients */}
      <BoardroomCountdown />

    </div>
  );
};

export default Interface;
