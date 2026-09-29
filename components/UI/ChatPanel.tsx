import React, { useState, useRef, useEffect } from 'react';
import { Send } from 'lucide-react';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import type { LiveChatMessage, ChatTag } from '../../types';

function getUserInfo(): { userId: string; name: string; color: string } {
  try {
    const s = localStorage.getItem('vp_user');
    if (s) return JSON.parse(s);
  } catch { /* */ }
  return { userId: 'anon', name: 'Anonymous', color: '#10b981' };
}

const TAG_META: Record<ChatTag, { label: string; bg: string; text: string }> = {
  RISK:     { label: 'RISK',     bg: '#fef2f2', text: '#dc2626' },
  ACTION:   { label: 'ACTION',   bg: '#eff6ff', text: '#2563eb' },
  DECISION: { label: 'DECISION', bg: '#f5f3ff', text: '#7c3aed' },
  NOTE:     { label: 'NOTE',     bg: '#f0fdf4', text: '#16a34a' },
};

const ChatPanel: React.FC = () => {
  const liveChat = useStore(state => state.liveChat);
  const addLiveChatMessage = useStore(state => state.addLiveChatMessage);
  const { broadcastChatMessage, localUserId } = usePresence();
  const [input, setInput] = useState('');
  const [activeTag, setActiveTag] = useState<ChatTag | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const userInfo = useRef(getUserInfo());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveChat.length]);

  function send() {
    const text = input.trim();
    if (!text) return;
    const msg: LiveChatMessage = {
      id: `${localUserId}-${Date.now()}`,
      authorId: localUserId,
      authorName: userInfo.current.name,
      authorColor: userInfo.current.color,
      text,
      timestamp: Date.now(),
      tag: activeTag ?? undefined,
    };
    addLiveChatMessage(msg);
    broadcastChatMessage(msg);
    setInput('');
    setActiveTag(null);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 shrink-0 flex items-center justify-between">
        <span className="text-[10px] font-bold uppercase text-gray-500 tracking-wider">Session Chat</span>
        <span className="text-[9px] font-mono text-gray-400">{liveChat.length} messages</span>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3 custom-scrollbar">
        {liveChat.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-8">
            <span className="text-2xl">💬</span>
            <p className="text-[11px] font-mono text-gray-400">
              Tag messages as RISK, ACTION, DECISION,<br />or NOTE to flag them for the record.
            </p>
          </div>
        )}
        {liveChat.map(msg => {
          const isMe = msg.authorId === localUserId;
          const tagMeta = msg.tag ? TAG_META[msg.tag] : null;

          return (
            <div key={msg.id} className={`flex flex-col gap-0.5 ${isMe ? 'items-end' : 'items-start'}`}>
              {/* Tagged messages get a full-width card regardless of sender */}
              {tagMeta ? (
                <div
                  className="w-full rounded-xl p-2.5 border"
                  style={{ background: tagMeta.bg, borderColor: tagMeta.text + '33' }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded"
                      style={{ background: tagMeta.text, color: '#fff' }}
                    >
                      {tagMeta.label}
                    </span>
                    <span className="text-[9px] font-mono text-gray-400">
                      {msg.authorName} · {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-xs text-gray-800 leading-snug">{msg.text}</p>
                </div>
              ) : (
                <>
                  {!isMe && (
                    <span className="text-[9px] font-mono text-gray-400 px-1" style={{ color: msg.authorColor }}>
                      {msg.authorName}
                    </span>
                  )}
                  <div
                    className={`max-w-[85%] px-3 py-2 rounded-2xl text-xs leading-snug ${
                      isMe ? 'bg-black text-white rounded-br-sm' : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                    }`}
                  >
                    {msg.text}
                  </div>
                  <span className="text-[8px] text-gray-300 font-mono px-1">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Tag selector */}
      <div className="shrink-0 px-3 pt-2 flex gap-1 flex-wrap">
        {(Object.keys(TAG_META) as ChatTag[]).map(tag => {
          const m = TAG_META[tag];
          const active = activeTag === tag;
          return (
            <button
              key={tag}
              onClick={() => setActiveTag(active ? null : tag)}
              className="text-[9px] font-bold font-mono px-2 py-0.5 rounded transition-all border"
              style={{
                background: active ? m.text : m.bg,
                color: active ? '#fff' : m.text,
                borderColor: m.text + '55',
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-gray-100 px-3 py-2 flex gap-2 items-end mt-2">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={activeTag ? `Flag as ${activeTag}…` : 'Message or flag an issue…'}
          rows={1}
          className="flex-1 resize-none bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-gray-400 placeholder:text-gray-400 transition-colors max-h-24 overflow-y-auto"
          style={{ lineHeight: '1.4' }}
        />
        <button
          onClick={send}
          disabled={!input.trim()}
          className="w-8 h-8 rounded-xl bg-black text-white flex items-center justify-center shrink-0 disabled:opacity-30 hover:bg-gray-800 transition-colors"
        >
          <Send size={13} />
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;
