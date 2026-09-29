import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { InsightCard, SpatialComment } from '../../types';
import type { UsePartyPresenceReturn } from '../../lib/usePartyPresence';
import { participantLabel } from '../../lib/identity';

interface MobileParticipantViewProps {
  roomId: string;
  userName: string;
  presence: UsePartyPresenceReturn;
}

const TYPE_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  RISK:      { bg: 'rgba(239,68,68,0.12)',  text: '#f87171', dot: '#ef4444' },
  ACTION:    { bg: 'rgba(59,130,246,0.12)', text: '#60a5fa', dot: '#3b82f6' },
  RATIONALE: { bg: 'rgba(251,191,36,0.12)', text: '#fbbf24', dot: '#f59e0b' },
};

const MobileParticipantView: React.FC<MobileParticipantViewProps> = ({ roomId, userName, presence }) => {
  const insightCards = useStore(state => state.insightCards);
  const [commentText, setCommentText] = useState('');
  const [sent, setSent] = useState(false);
  const [activeTab, setActiveTab] = useState<'insights' | 'participants'>('insights');
  const feedRef = useRef<HTMLDivElement>(null);

  const { broadcastPresence, broadcastCommentAdd, remoteParticipantList, localUserId } = presence;

  // Announce presence so desktop sees this mobile user
  useEffect(() => {
    const ping = () => broadcastPresence([0, 0, 0], [0, 0, 0]);
    ping();
    const interval = setInterval(ping, 5000);
    return () => clearInterval(interval);
  }, [broadcastPresence]);

  // Auto-scroll feed to bottom when new cards arrive
  useEffect(() => {
    if (feedRef.current && activeTab === 'insights') {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [insightCards.length, activeTab]);

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

  const allParticipants = [
    { userId: localUserId, name: userName, color: '#10b981', isYou: true },
    ...remoteParticipantList.map(p => ({ ...p, name: participantLabel(p.name, p.guest), isYou: false })),
  ];

  return (
    <div className="flex flex-col h-screen" style={{ background: '#0A0A0A', fontFamily: 'Inter, system-ui, sans-serif' }}>

      {/* Header */}
      <header
        className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: '#1f1f1f' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: '#fff' }}>
            <span style={{ color: '#000', fontWeight: 900, fontSize: 11 }}>VA</span>
          </div>
          <span className="text-white text-sm font-bold tracking-widest uppercase" style={{ fontFamily: 'monospace' }}>
            Viewpoint Arena
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span
            className="font-mono text-xs px-2 py-1 rounded"
            style={{ background: '#1a1a1a', color: '#6b7280', border: '1px solid #2a2a2a' }}
          >
            {roomId.slice(0, 8).toUpperCase()}
          </span>
          <div className="flex items-center gap-1">
            <span style={{ color: '#10b981', fontSize: 8 }}>●</span>
            <span className="font-mono text-xs" style={{ color: '#4b5563' }}>
              {allParticipants.length} live
            </span>
          </div>
        </div>
      </header>

      {/* Mobile banner */}
      <div
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 text-xs"
        style={{ background: '#111827', color: '#6b7280', borderBottom: '1px solid #1f2937' }}
      >
        <span style={{ fontSize: 13 }}>📱</span>
        <span>Mobile view — desktop is controlling the 3D model</span>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b" style={{ borderColor: '#1f1f1f' }}>
        {(['insights', 'participants'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex-1 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors relative"
            style={{
              color: activeTab === tab ? '#fff' : '#4b5563',
              background: 'transparent',
            }}
          >
            {tab === 'insights' ? `Insights${insightCards.length > 0 ? ` (${insightCards.length})` : ''}` : `Participants (${allParticipants.length})`}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-4 right-4 h-0.5 rounded-full" style={{ background: '#10b981' }} />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div ref={feedRef} className="flex-1 overflow-y-auto px-4 py-4">

        {activeTab === 'insights' && (
          insightCards.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-4 py-16">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: '#141414', border: '1px solid #2a2a2a' }}>
                <span style={{ fontSize: 24 }}>🔍</span>
              </div>
              <div>
                <p className="text-white text-sm font-semibold mb-1">Waiting for insights</p>
                <p className="font-mono text-xs" style={{ color: '#4b5563' }}>
                  AI agents will post cards here during the session
                </p>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <span style={{ color: '#10b981', fontSize: 8 }}>●</span>
                <span className="font-mono text-xs" style={{ color: '#374151' }}>Connected to room</span>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {insightCards.map((card: InsightCard) => {
                const s = TYPE_STYLES[card.type] ?? { bg: '#1a1a1a', text: '#9ca3af', dot: '#4b5563' };
                return (
                  <div
                    key={card.id}
                    className="rounded-2xl p-4 border"
                    style={{ background: '#111', borderColor: '#2a2a2a' }}
                  >
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.dot }} />
                      <span className="text-[10px] font-bold font-mono uppercase tracking-wide" style={{ color: s.text }}>
                        {card.type}
                      </span>
                      <span className="ml-auto font-mono text-[9px]" style={{ color: '#374151' }}>
                        {card.agentId}
                      </span>
                    </div>
                    <p className="text-sm font-semibold mb-1.5 leading-snug" style={{ color: '#f3f4f6' }}>
                      {card.title}
                    </p>
                    <p className="text-xs leading-relaxed" style={{ color: '#6b7280' }}>
                      {card.description}
                    </p>
                  </div>
                );
              })}
            </div>
          )
        )}

        {activeTab === 'participants' && (
          <div className="space-y-2">
            {allParticipants.map(p => (
              <div
                key={p.userId}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                style={{ background: '#111', border: '1px solid #1f1f1f' }}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                  style={{ background: p.color }}
                >
                  {p.name[0]?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: '#f3f4f6' }}>
                    {p.name}
                    {p.isYou && <span className="ml-1.5 text-[9px] font-mono" style={{ color: '#374151' }}>YOU</span>}
                  </p>
                  <p className="text-[10px] font-mono" style={{ color: '#374151' }}>
                    {p.isYou ? 'Mobile participant' : 'In session'}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span style={{ color: '#10b981', fontSize: 7 }}>●</span>
                  <span className="font-mono text-[9px]" style={{ color: '#374151' }}>live</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Comment input */}
      <div
        className="flex-shrink-0 px-4 py-3 border-t"
        style={{ borderColor: '#1f1f1f', background: '#0a0a0a' }}
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={commentText}
            onChange={e => setCommentText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
            placeholder="Send a comment to the room…"
            className="flex-1 rounded-xl px-3 py-2.5 text-sm outline-none"
            style={{
              background: '#1a1a1a',
              border: '1px solid #2a2a2a',
              color: '#f3f4f6',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!commentText.trim()}
            className="px-4 py-2.5 rounded-xl text-sm font-bold transition-all"
            style={{
              background: sent ? 'rgba(16,185,129,0.2)' : commentText.trim() ? '#fff' : '#1a1a1a',
              color: sent ? '#10b981' : commentText.trim() ? '#000' : '#374151',
              border: sent ? '1px solid rgba(16,185,129,0.4)' : '1px solid #2a2a2a',
            }}
          >
            {sent ? '✓' : 'Send'}
          </button>
        </div>
        <p className="font-mono text-[10px] mt-1.5" style={{ color: '#374151' }}>
          As {userName}
        </p>
      </div>
    </div>
  );
};

export default MobileParticipantView;
