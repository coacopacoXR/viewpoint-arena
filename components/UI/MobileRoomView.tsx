import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { usePresence } from '../../lib/PresenceContext';
import { participantLabel, attendeeNames } from '../../lib/identity';
import { useWebRTCContext } from '../../lib/WebRTCContext';
import ViewpointCanvas from '../Scene/ViewpointCanvas';
import BoardroomCountdown from './BoardroomCountdown';
import HumanParticipantTile from './Boardroom/HumanParticipantTile';
import LobbyLink from './room/LobbyLink';
import { mobileLaserRef } from '../../lib/mobileLaserRef';
import { InsightCard, SpatialComment, LiveChatMessage, ChatTag } from '../../types';
import { MonitorPlay, Radio, Mic, MicOff, Video, VideoOff, Power, Crosshair, Send, Volume2, VolumeX } from 'lucide-react';

type Tab = '3d' | 'session' | 'people';
type SessionSubTab = 'chat' | 'comments' | 'insights';

const TAG_META: Record<ChatTag, { label: string; bg: string; text: string }> = {
  RISK:     { label: 'RISK',     bg: 'rgba(239,68,68,0.15)',   text: '#f87171' },
  ACTION:   { label: 'ACTION',   bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa' },
  DECISION: { label: 'DECISION', bg: 'rgba(139,92,246,0.15)',  text: '#a78bfa' },
  NOTE:     { label: 'NOTE',     bg: 'rgba(16,185,129,0.15)',  text: '#34d399' },
};

const TYPE_STYLES: Record<string, { border: string; text: string; dot: string }> = {
  RISK:      { border: 'rgba(239,68,68,0.35)',  text: '#f87171', dot: '#ef4444' },
  ACTION:    { border: 'rgba(59,130,246,0.35)', text: '#60a5fa', dot: '#3b82f6' },
  RATIONALE: { border: 'rgba(251,191,36,0.35)', text: '#fbbf24', dot: '#f59e0b' },
};

interface Props {
  roomId: string;
  userName: string;
}

const MobileRoomView: React.FC<Props> = ({ roomId, userName }) => {
  const {
    insightCards, isBoardroomMode, sessionHostId,
    followingRemoteUserId, setFollowingRemoteUser, followNudged,
    boardroomLeaderId, time, isPrivacyMode, endMeeting,
    liveChat, addLiveChatMessage,
  } = useStore(useShallow(state => ({
    insightCards: state.insightCards,
    isBoardroomMode: state.isBoardroomMode,
    sessionHostId: state.sessionHostId,
    followingRemoteUserId: state.followingRemoteUserId,
    setFollowingRemoteUser: state.setFollowingRemoteUser,
    followNudged: state.followNudged,
    boardroomLeaderId: state.boardroomLeaderId,
    time: state.time,
    isPrivacyMode: state.isPrivacyMode,
    endMeeting: state.endMeeting,
    liveChat: state.liveChat,
    addLiveChatMessage: state.addLiveChatMessage,
  })));

  const {
    remoteParticipantList, broadcastPresence, broadcastCommentAdd,
    broadcastMeetingEnd, broadcastChatMessage, localUserId,
  } = usePresence();
  const { localStream, remoteStreams, isMicOn, isCamOn, toggleMic, toggleCam, isSpeakerOn, toggleSpeaker } = useWebRTCContext();

  const [activeTab, setActiveTab] = useState<Tab>('3d');
  const [sessionSubTab, setSessionSubTab] = useState<SessionSubTab>('chat');
  const [commentText, setCommentText] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatTag, setChatTag] = useState<ChatTag | null>(null);
  const [sent, setSent] = useState(false);
  const [freeExplore, setFreeExplore] = useState(false);
  const [laserActive, setLaserActive] = useState(false);
  const [lastSeenChat, setLastSeenChat] = useState(0);

  const feedRef = useRef<HTMLDivElement>(null);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // Unread chat badge
  const unreadChat = (activeTab !== 'session' || sessionSubTab !== 'chat')
    ? Math.max(0, liveChat.length - lastSeenChat)
    : 0;

  useEffect(() => {
    if (activeTab === 'session' && sessionSubTab === 'chat') {
      setLastSeenChat(liveChat.length);
    }
  }, [activeTab, sessionSubTab, liveChat.length]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveChat.length]);

  // Broadcast presence so desktop sees this mobile user in its roster
  useEffect(() => {
    const ping = () => broadcastPresence([0, 0, 0], [0, 0, 0]);
    ping();
    const interval = setInterval(ping, 5000);
    return () => clearInterval(interval);
  }, [broadcastPresence]);

  // Auto-follow host or first remote participant — but never over the user's
  // own choice: once they tap Explore, someone joining or leaving (which
  // changes the list length) must not pull them back onto the host.
  useEffect(() => {
    if (freeExplore) return;
    const hostId = sessionHostId ?? remoteParticipantList[0]?.userId ?? null;
    if (hostId && hostId !== localUserId) {
      setFollowingRemoteUser(hostId);
    }
  }, [sessionHostId, remoteParticipantList.length, freeExplore]);

  // When boardroom activates, make sure we follow the boardroom leader
  useEffect(() => {
    if (isBoardroomMode && boardroomLeaderId && boardroomLeaderId !== localUserId) {
      setFollowingRemoteUser(boardroomLeaderId);
    }
  }, [isBoardroomMode, boardroomLeaderId]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [insightCards.length]);

  // ── Laser trackpad handlers (write directly to module-level ref) ────────────
  const handleTrackpadPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setLaserActive(true);
    writeLaserNDC(e.currentTarget, e.clientX, e.clientY);
  }, []);

  const handleTrackpadPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    writeLaserNDC(e.currentTarget, e.clientX, e.clientY);
  }, []);

  const handleTrackpadPointerUp = useCallback(() => {
    setLaserActive(false);
    mobileLaserRef.ndc = null;
  }, []);

  function writeLaserNDC(el: HTMLDivElement, clientX: number, clientY: number) {
    const rect = el.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    mobileLaserRef.ndc = [x, y];
  }

  // ── Comment send ────────────────────────────────────────────────────────────
  function handleSend() {
    const text = commentText.trim();
    if (!text) return;
    const comment: SpatialComment = {
      id: `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'text',
      content: text,
      author: userName,
      authorColor: '#10b981',
      timestamp: Date.now(),
      position: { x: 0, y: 0, z: 0 },
      attachedToNodeId: '',
      attachedToNodeName: '',
      assignees: [],
      resolved: false,
      linkedToMeeting: true,
    };
    broadcastCommentAdd(comment);
    setCommentText('');
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  }

  // ── Chat send ───────────────────────────────────────────────────────────────
  function handleChatSend() {
    const text = chatInput.trim();
    if (!text) return;
    const msg: LiveChatMessage = {
      id: `${localUserId}-${Date.now()}`,
      authorId: localUserId,
      authorName: userName,
      authorColor: '#10b981',
      text,
      timestamp: Date.now(),
      tag: chatTag ?? undefined,
    };
    addLiveChatMessage(msg);
    broadcastChatMessage(msg);
    setChatInput('');
    setChatTag(null);
  }

  function formatTime(t: number) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  const followingParticipant = followingRemoteUserId
    ? remoteParticipantList.find(p => p.userId === followingRemoteUserId)
    : null;

  const leaderName = boardroomLeaderId
    ? (boardroomLeaderId === localUserId
        ? 'You'
        : (() => {
            const leader = remoteParticipantList.find(p => p.userId === boardroomLeaderId);
            return leader ? participantLabel(leader.name, leader.guest) : 'Host';
          })())
    : null;

  const allParticipants = [
    { userId: localUserId, name: userName, color: '#10b981', isYou: true },
    ...remoteParticipantList.map(p => ({ ...p, name: participantLabel(p.name, p.guest), isYou: false })),
  ];

  const sessionBadge = (insightCards.length || 0) + unreadChat || undefined;

  // ─── BOARDROOM VIEW ─────────────────────────────────────────────────────────
  if (isBoardroomMode) {
    const isHost = sessionHostId === localUserId || sessionHostId === null;
    const pipParticipants = [
      { userId: localUserId, name: userName, color: '#10b981', isYou: true, stream: localStream },
      ...remoteParticipantList.slice(0, 2).map(p => ({
        userId: p.userId, name: participantLabel(p.name, p.guest), color: p.color, isYou: false,
        stream: remoteStreams.get(p.userId) ?? null,
      })),
    ];

    return (
      <div className="relative overflow-hidden" style={{ height: '100dvh', background: '#0a0a0a' }}>
        <BoardroomCountdown />

        <div className="absolute inset-0">
          <ViewpointCanvas />
        </div>

        {/* Header */}
        <div
          className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between px-3"
          style={{ paddingTop: 'max(10px, env(safe-area-inset-top))', paddingBottom: 10, background: 'linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, transparent 100%)' }}
        >
          <div className="flex items-center gap-2">
            <MonitorPlay size={12} className="text-white/50" />
            <span className="text-white text-[11px] font-bold tracking-tight uppercase">Boardroom</span>
            {!isPrivacyMode && (
              <>
                <div className="h-3 w-px bg-white/20" />
                <div className="flex items-center gap-1 text-[9px] font-mono text-green-400">
                  <Radio size={7} className="animate-pulse" />
                  REC
                </div>
              </>
            )}
            <span className="font-mono text-[9px] text-white/25">{formatTime(time)}</span>
          </div>
          {leaderName && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,0,0,0.5)', border: '1px solid rgba(251,191,36,0.4)' }}>
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-yellow-300 text-[9px] font-mono font-bold">{leaderName}</span>
            </div>
          )}
        </div>

        {/* PiP camera tiles */}
        <div className="absolute right-3 z-20 flex flex-col gap-2" style={{ top: 'max(56px, calc(env(safe-area-inset-top) + 48px))' }}>
          {pipParticipants.map(p => (
            <div key={p.userId} style={{ width: 88, height: 66 }} className="rounded-xl overflow-hidden shadow-lg ring-1 ring-white/10">
              <HumanParticipantTile
                stream={p.stream}
                name={p.name}
                color={p.color}
                isMicOn={p.isYou ? isMicOn : true}
                isCamOn={p.isYou ? isCamOn : true}
                isYou={p.isYou}
                isPresenter={boardroomLeaderId === p.userId}
                size="fill"
              />
            </div>
          ))}
        </div>

        {/* Bottom controls */}
        <div
          className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center gap-5 py-4"
          style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))', background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)' }}
        >
          <button
            onClick={toggleMic}
            className="rounded-full flex items-center justify-center transition-all"
            style={{ width: 52, height: 52, background: isMicOn ? 'rgba(255,255,255,0.15)' : 'rgba(239,68,68,0.35)', border: `1px solid ${isMicOn ? 'rgba(255,255,255,0.25)' : 'rgba(239,68,68,0.5)'}` }}
          >
            {isMicOn ? <Mic size={20} color="#fff" /> : <MicOff size={20} color="#f87171" />}
          </button>
          <button
            onClick={toggleCam}
            className="rounded-full flex items-center justify-center transition-all"
            style={{ width: 52, height: 52, background: isCamOn ? 'rgba(255,255,255,0.15)' : 'rgba(239,68,68,0.35)', border: `1px solid ${isCamOn ? 'rgba(255,255,255,0.25)' : 'rgba(239,68,68,0.5)'}` }}
          >
            {isCamOn ? <Video size={20} color="#fff" /> : <VideoOff size={20} color="#f87171" />}
          </button>
          {isHost && (
            <button
              onClick={() => {
                // This browser's person pressed End, so this one records the
                // meeting — names beside the count, which is left to the store's
                // own fallback here exactly as it was. See store.meetingEndedRemotely
                // for why the browsers that receive MEETING_END write nothing.
                endMeeting(true, undefined, attendeeNames(userName, remoteParticipantList));
                broadcastMeetingEnd();
              }}
              className="rounded-full flex items-center justify-center transition-all"
              style={{ width: 52, height: 52, background: 'rgba(239,68,68,0.3)', border: '1px solid rgba(239,68,68,0.45)' }}
            >
              <Power size={20} color="#f87171" />
            </button>
          )}
        </div>
      </div>
    );
  }

  // ─── ARENA VIEW ───────────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{ height: '100dvh', background: '#0a0a0a', fontFamily: 'Inter, system-ui, sans-serif' }}
    >
      <BoardroomCountdown />

      {/* Top bar */}
      <div
        className="flex-shrink-0 flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: '#1f1f1f', background: '#0a0a0a', paddingTop: 'max(8px, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2">
          {/* The way back to the lobby: the logo is the link and the word beside it
              says so — the same control the desktop room's header has, in the dark
              tone this bar needs. Leaving this way LEAVES the meeting rather than
              ending it; see components/UI/room/LobbyLink.tsx. */}
          <Link to="/" title="Back to the lobby" className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: '#fff' }}>
              <span style={{ color: '#000', fontWeight: 900, fontSize: 9 }}>VA</span>
            </div>
            <span className="text-white text-xs font-bold tracking-widest uppercase" style={{ fontFamily: 'monospace' }}>
              Viewpoint Arena
            </span>
          </Link>
          <LobbyLink tone="dark" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded" style={{ background: '#1a1a1a', color: '#6b7280', border: '1px solid #2a2a2a' }}>
            {roomId.slice(0, 6).toUpperCase()}
          </span>
          <div className="flex items-center gap-1">
            <span style={{ color: '#10b981', fontSize: 7 }}>●</span>
            <span className="font-mono text-[10px]" style={{ color: '#4b5563' }}>{allParticipants.length}</span>
          </div>
          {/* Mic toggle */}
          <button
            onClick={toggleMic}
            className="rounded-full flex items-center justify-center"
            style={{ width: 28, height: 28, background: isMicOn ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.3)', border: `1px solid ${isMicOn ? 'rgba(255,255,255,0.15)' : 'rgba(239,68,68,0.4)'}` }}
          >
            {isMicOn ? <Mic size={12} color="#fff" /> : <MicOff size={12} color="#f87171" />}
          </button>
          {/* Speaker toggle */}
          <button
            onClick={toggleSpeaker}
            className="rounded-full flex items-center justify-center"
            style={{ width: 28, height: 28, background: isSpeakerOn ? 'rgba(255,255,255,0.1)' : 'rgba(239,68,68,0.3)', border: `1px solid ${isSpeakerOn ? 'rgba(255,255,255,0.15)' : 'rgba(239,68,68,0.4)'}` }}
          >
            {isSpeakerOn ? <Volume2 size={12} color="#fff" /> : <VolumeX size={12} color="#f87171" />}
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 min-h-0 relative overflow-hidden">

        {/* 3D Canvas — always mounted */}
        <div className="absolute inset-0" style={{ visibility: activeTab === '3d' ? 'visible' : 'hidden' }}>
          <ViewpointCanvas />

          {/* Follow badge */}
          {!freeExplore && followingParticipant && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full" style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid rgba(255,255,255,0.15)', backdropFilter: 'blur(8px)' }}>
                <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0" style={{ background: followingParticipant.color }}>
                  {followingParticipant.name[0]}
                </div>
                <span className="text-white text-[11px] font-mono">
                  Following <span className="font-bold">{participantLabel(followingParticipant.name, followingParticipant.guest)}</span>
                  {followNudged && (
                    <span className="text-white/60"> — moving on your own · snapping back</span>
                  )}
                </span>
                <button
                  onClick={() => { setFollowingRemoteUser(null); setFreeExplore(true); }}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.6)' }}
                >
                  Explore
                </button>
              </div>
            </div>
          )}

          {freeExplore && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full" style={{ background: 'rgba(0,0,0,0.75)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(8px)' }}>
                <span className="text-white/50 text-[11px] font-mono">Free look</span>
                <button
                  onClick={() => {
                    const hostId = sessionHostId ?? remoteParticipantList[0]?.userId ?? null;
                    if (hostId && hostId !== localUserId) { setFollowingRemoteUser(hostId); setFreeExplore(false); }
                  }}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(16,185,129,0.2)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)' }}
                >
                  Re-attach
                </button>
              </div>
            </div>
          )}

          {/* Laser trackpad — bottom left */}
          <div className="absolute bottom-3 left-3 z-30 pointer-events-auto flex flex-col items-center gap-1">
            <div
              onPointerDown={handleTrackpadPointerDown}
              onPointerMove={handleTrackpadPointerMove}
              onPointerUp={handleTrackpadPointerUp}
              onPointerCancel={handleTrackpadPointerUp}
              className="rounded-2xl select-none"
              style={{
                width: 90, height: 90,
                background: laserActive ? 'rgba(239,68,68,0.2)' : 'rgba(0,0,0,0.5)',
                border: `1.5px solid ${laserActive ? 'rgba(239,68,68,0.65)' : 'rgba(255,255,255,0.12)'}`,
                backdropFilter: 'blur(8px)',
                touchAction: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.1s, border-color 0.1s',
              }}
            >
              <Crosshair
                size={22}
                color={laserActive ? '#f87171' : 'rgba(255,255,255,0.22)'}
                style={{ transition: 'color 0.1s' }}
              />
            </div>
            <span className="font-mono text-[8px]" style={{ color: 'rgba(255,255,255,0.15)' }}>laser</span>
          </div>

          {/* Hint — bottom right */}
          <div className="absolute bottom-3 right-3 z-20 pointer-events-none">
            <div className="px-3 py-1 rounded-full" style={{ background: 'rgba(0,0,0,0.4)' }}>
              <span className="font-mono text-[9px]" style={{ color: 'rgba(255,255,255,0.18)' }}>pinch zoom · drag rotate</span>
            </div>
          </div>
        </div>

        {/* ── SESSION TAB ── */}
        {activeTab === 'session' && (
          <div className="absolute inset-0 flex flex-col" style={{ background: '#0a0a0a' }}>

            {/* Sub-tab strip */}
            <div className="flex-shrink-0 flex gap-0 border-b" style={{ borderColor: '#1f1f1f' }}>
              {([
                { id: 'chat' as SessionSubTab, label: 'Chat', badge: unreadChat || undefined },
                { id: 'comments' as SessionSubTab, label: 'Comments' },
                { id: 'insights' as SessionSubTab, label: 'Insights', badge: insightCards.length || undefined },
              ]).map(s => (
                <button
                  key={s.id}
                  onClick={() => setSessionSubTab(s.id)}
                  className="relative flex-1 py-2.5 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors"
                  style={{ color: sessionSubTab === s.id ? '#fff' : '#4b5563' }}
                >
                  {s.label}
                  {s.badge ? (
                    <span
                      className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full text-[8px] font-bold"
                      style={{ background: s.id === 'chat' ? '#10b981' : '#6366f1', color: '#000' }}
                    >
                      {s.badge > 9 ? '9+' : s.badge}
                    </span>
                  ) : null}
                  {sessionSubTab === s.id && (
                    <div className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full" style={{ background: '#fff' }} />
                  )}
                </button>
              ))}
            </div>

            {/* ── CHAT sub-tab ── */}
            {sessionSubTab === 'chat' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
                  {liveChat.length === 0 && (
                    <div className="flex-1 flex flex-col items-center justify-center gap-3 py-10">
                      <span style={{ fontSize: 28 }}>💬</span>
                      <p className="font-mono text-xs text-center" style={{ color: '#4b5563' }}>
                        Tag messages as RISK, ACTION,<br />DECISION or NOTE to flag them.
                      </p>
                    </div>
                  )}
                  {liveChat.map(msg => {
                    const isMe = msg.authorId === localUserId;
                    const tagMeta = msg.tag ? TAG_META[msg.tag] : null;
                    if (tagMeta) {
                      return (
                        <div key={msg.id} className="rounded-2xl p-3" style={{ background: tagMeta.bg, border: `1px solid ${tagMeta.text}44` }}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded" style={{ background: tagMeta.text, color: '#000' }}>
                              {tagMeta.label}
                            </span>
                            <span className="text-[9px] font-mono" style={{ color: tagMeta.text + 'aa' }}>
                              {msg.authorName} · {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-sm leading-snug" style={{ color: '#f3f4f6' }}>{msg.text}</p>
                        </div>
                      );
                    }
                    return (
                      <div key={msg.id} className={`flex flex-col gap-0.5 ${isMe ? 'items-end' : 'items-start'}`}>
                        {!isMe && (
                          <span className="text-[9px] font-mono px-1" style={{ color: msg.authorColor }}>{msg.authorName}</span>
                        )}
                        <div
                          className="max-w-[82%] px-3 py-2 text-sm leading-snug"
                          style={{
                            background: isMe ? '#fff' : '#1a1a1a',
                            color: isMe ? '#000' : '#f3f4f6',
                            borderRadius: isMe ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                          }}
                        >
                          {msg.text}
                        </div>
                        <span className="text-[8px] px-1 font-mono" style={{ color: '#374151' }}>
                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    );
                  })}
                  <div ref={chatBottomRef} />
                </div>

                {/* Tag row */}
                <div className="flex-shrink-0 flex gap-1.5 px-4 pt-2 flex-wrap">
                  {(Object.keys(TAG_META) as ChatTag[]).map(tag => {
                    const m = TAG_META[tag];
                    const active = chatTag === tag;
                    return (
                      <button
                        key={tag}
                        onClick={() => setChatTag(active ? null : tag)}
                        className="text-[9px] font-bold font-mono px-2 py-1 rounded-full transition-all"
                        style={{
                          background: active ? m.text : m.bg,
                          color: active ? '#000' : m.text,
                          border: `1px solid ${m.text}55`,
                        }}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>

                {/* Input */}
                <div className="flex-shrink-0 flex gap-2 px-4 py-3 border-t" style={{ borderColor: '#1f1f1f' }}>
                  <input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleChatSend()}
                    placeholder={chatTag ? `Flag as ${chatTag}…` : 'Message or flag an issue…'}
                    className="flex-1 rounded-full px-4 py-2 text-sm outline-none text-white placeholder-gray-600"
                    style={{ background: '#1a1a1a', border: `1px solid ${chatTag ? TAG_META[chatTag].text + '66' : '#2a2a2a'}` }}
                  />
                  <button
                    onClick={handleChatSend}
                    disabled={!chatInput.trim()}
                    className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 disabled:opacity-30"
                    style={{ background: '#fff' }}
                  >
                    <Send size={14} color="#000" />
                  </button>
                </div>
              </div>
            )}

            {/* ── COMMENTS sub-tab ── */}
            {sessionSubTab === 'comments' && (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: '#111', border: '1px solid #2a2a2a' }}>
                    <span style={{ fontSize: 20 }}>💬</span>
                  </div>
                  <div>
                    <p className="text-white text-sm font-semibold mb-1">Add a comment</p>
                    <p className="font-mono text-xs" style={{ color: '#4b5563' }}>Comments are attached to the 3D session and visible to all participants.</p>
                  </div>
                </div>
                <div className="flex-shrink-0 flex flex-col gap-2 px-4 py-3 border-t" style={{ borderColor: '#1f1f1f' }}>
                  <textarea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder="Write a comment…"
                    rows={3}
                    className="w-full rounded-2xl px-4 py-3 text-sm outline-none text-white placeholder-gray-600 resize-none"
                    style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!commentText.trim()}
                    className="w-full py-2.5 rounded-full text-sm font-bold disabled:opacity-30 transition-opacity"
                    style={{ background: '#fff', color: '#000' }}
                  >
                    {sent ? 'Sent ✓' : 'Post comment'}
                  </button>
                </div>
              </div>
            )}

            {/* ── INSIGHTS sub-tab ── */}
            {sessionSubTab === 'insights' && (
              <div ref={feedRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 flex flex-col gap-3">
                {insightCards.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center h-full text-center gap-4 py-10">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: '#111', border: '1px solid #2a2a2a' }}>
                      <span style={{ fontSize: 20 }}>✦</span>
                    </div>
                    <div>
                      <p className="text-white text-sm font-semibold mb-1">No insights yet</p>
                      <p className="font-mono text-xs" style={{ color: '#4b5563' }}>AI agents will post here during the session</p>
                    </div>
                  </div>
                ) : (
                  insightCards.map((card: InsightCard) => {
                    const s = TYPE_STYLES[card.type] ?? { border: 'rgba(255,255,255,0.1)', text: '#9ca3af', dot: '#4b5563' };
                    return (
                      <div key={card.id} className="rounded-2xl p-4" style={{ background: '#111', border: `1px solid ${s.border}` }}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.dot, display: 'inline-block' }} />
                          <span className="text-[10px] font-bold font-mono uppercase tracking-wide" style={{ color: s.text }}>{card.type}</span>
                          <span className="ml-auto font-mono text-[9px]" style={{ color: '#374151' }}>{card.agentId}</span>
                        </div>
                        <p className="text-sm font-semibold mb-1.5 leading-snug" style={{ color: '#f3f4f6' }}>{card.title}</p>
                        <p className="text-xs leading-relaxed" style={{ color: '#6b7280' }}>{card.description}</p>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* ── PEOPLE TAB ── */}
        {activeTab === 'people' && (
          <div className="absolute inset-0 overflow-y-auto px-4 py-4 space-y-2">
            {allParticipants.map(p => (
              <div key={p.userId} className="flex items-center gap-3 rounded-xl px-3 py-3" style={{ background: '#111', border: '1px solid #1f1f1f' }}>
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0" style={{ background: p.color }}>
                  {p.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: '#f3f4f6' }}>
                    {p.name}
                    {p.isYou && <span className="ml-1.5 text-[9px] font-mono" style={{ color: '#374151' }}>YOU</span>}
                  </p>
                  <p className="text-[10px] font-mono" style={{ color: '#374151' }}>
                    {p.isYou ? 'Mobile' : p.userId === sessionHostId ? 'Host' : 'Desktop'}
                  </p>
                </div>
                {!p.isYou && (
                  <button
                    onClick={() => { setFollowingRemoteUser(p.userId); setFreeExplore(false); setActiveTab('3d'); }}
                    className="text-[9px] font-mono px-2 py-1 rounded-lg shrink-0"
                    style={{
                      background: followingRemoteUserId === p.userId ? 'rgba(16,185,129,0.2)' : 'rgba(255,255,255,0.05)',
                      color: followingRemoteUserId === p.userId ? '#10b981' : '#6b7280',
                      border: followingRemoteUserId === p.userId ? '1px solid rgba(16,185,129,0.3)' : '1px solid #2a2a2a',
                    }}
                  >
                    {followingRemoteUserId === p.userId ? 'Following' : 'Follow'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div
        className="flex-shrink-0 flex border-t"
        style={{ borderColor: '#1f1f1f', background: '#0a0a0a', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {([
          { id: '3d' as Tab,      label: '3D View',  emoji: '⬡' },
          { id: 'session' as Tab, label: 'Session',  emoji: '✦', badge: sessionBadge },
          { id: 'people' as Tab,  label: 'People',   emoji: '●', badge: allParticipants.length },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className="flex-1 flex flex-col items-center justify-center py-3 gap-0.5 relative transition-colors"
            style={{ color: activeTab === t.id ? '#fff' : '#4b5563' }}
          >
            <span style={{ fontSize: 15, lineHeight: 1 }}>{t.emoji}</span>
            <span className="text-[9px] font-mono uppercase tracking-wider mt-0.5">{t.label}</span>
            {t.badge ? (
              <span
                className="absolute top-1.5 right-[25%] w-4 h-4 rounded-full text-[8px] font-bold flex items-center justify-center"
                style={{ background: '#10b981', color: '#000' }}
              >
                {t.badge > 9 ? '9+' : t.badge}
              </span>
            ) : null}
            {activeTab === t.id && (
              <div className="absolute top-0 left-3 right-3 h-0.5 rounded-full" style={{ background: '#fff' }} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default MobileRoomView;
