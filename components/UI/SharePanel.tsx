import React, { useState, useRef, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X, Copy, Check, QrCode, Link, AlertTriangle, Globe, BellRing } from 'lucide-react';
import { useConnectorConfig } from '../../lib/config/ConfigContext.tsx';
import { useJoinPolicy, broadcastSetJoinPolicy } from '../../lib/usePartyPresence';
import { usePresence } from '../../lib/PresenceContext';
import { useStore } from '../../store';
import { roomPath, shortLineLabel } from '../../lib/reviews/lines';

interface SharePanelProps {
  roomId: string;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const SharePanel: React.FC<SharePanelProps> = ({ roomId, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'link' | 'qr'>('qr');
  const panelRef = useRef<HTMLDivElement>(null);
  const config = useConnectorConfig();
  const joinPolicy = useJoinPolicy();
  const { localUserId } = usePresence();
  const sessionHostId = useStore(state => state.sessionHostId);
  const isHost = sessionHostId === localUserId || sessionHostId === null;

  // Which line this room is on, so the link it hands out opens THAT line. Sharing a
  // variant's meeting as the review's own address would invite the next person into
  // the main line — a different live room, a different model on screen — and they
  // would have no way to tell from the link. The main line carries no parameter, so
  // the address of every review that existed before lines did is unchanged.
  const activeLine = useStore(state => state.activeLine);
  const onVariant = activeLine?.kind === 'variant';
  const variantLabel = onVariant ? shortLineLabel(activeLine) : null;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const baseUrl = config.publicUrl || origin;
  const roomUrl = `${baseUrl}${roomPath(roomId, onVariant ? activeLine?.id ?? null : null)}`;

  const urlHost = extractHost(baseUrl);
  const localOnly = isLocalHost(urlHost);

  const originHost = extractHost(origin);
  const mismatch = Boolean(
    config.publicUrl && origin && urlHost && originHost && urlHost !== originHost,
  );

  function handleCopy() {
    navigator.clipboard.writeText(roomUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onOutside);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="absolute top-10 right-0 z-[300] pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-150"
      style={{ width: 280 }}
    >
      <div
        className="rounded-xl shadow-2xl border overflow-hidden"
        style={{ background: '#111', borderColor: 'rgba(255,255,255,0.12)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          <span className="text-white text-xs font-bold tracking-wide">Invite to Session</span>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
          {(['qr', 'link'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors"
              style={{
                color: tab === t ? '#fff' : 'rgba(255,255,255,0.3)',
                borderBottom: tab === t ? '2px solid #fff' : '2px solid transparent',
              }}
            >
              {t === 'qr' ? <QrCode size={11} /> : <Link size={11} />}
              {t === 'qr' ? 'QR Code' : 'Copy Link'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="p-4">
          {localOnly && (
            <div
              className="flex items-start gap-2 mb-3 px-3 py-2 rounded-lg"
              style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.35)' }}
              data-testid="local-only-warning"
            >
              <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
              <p className="text-[10px] leading-relaxed" style={{ color: '#fbbf24' }}>
                This link only opens on this computer. To share it with a phone or
                colleague, re-run <code>./install.sh</code> and enter this machine's
                network address (e.g. <code>192.168.1.50</code>).
              </p>
            </div>
          )}

          {mismatch && (
            <div
              className="mb-3 px-3 py-2 rounded-lg"
              style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)' }}
              data-testid="mismatch-warning"
            >
              <p className="text-[10px] leading-relaxed" style={{ color: '#a5b4fc' }}>
                You are viewing this at {origin}; the shared link uses {config.publicUrl}.
              </p>
            </div>
          )}

          {tab === 'qr' ? (
            <div className="flex flex-col items-center gap-3">
              <div className="p-3 rounded-lg bg-white">
                <QRCodeSVG
                  value={roomUrl}
                  size={180}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                />
              </div>
              <p className="text-[10px] font-mono text-center" style={{ color: 'rgba(255,255,255,0.3)' }}>
                Scan to join on mobile
              </p>
              <div
                className="w-full px-3 py-2 rounded-lg text-[9px] font-mono truncate"
                style={{ background: '#1a1a1a', color: 'rgba(255,255,255,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {roomUrl}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div
                className="w-full px-3 py-2.5 rounded-lg text-[10px] font-mono break-all leading-relaxed"
                style={{ background: '#1a1a1a', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {roomUrl}
              </div>
              <button
                onClick={handleCopy}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-bold transition-all"
                style={{
                  background: copied ? 'rgba(16,185,129,0.2)' : '#fff',
                  color: copied ? '#10b981' : '#000',
                  border: copied ? '1px solid rgba(16,185,129,0.4)' : '1px solid transparent',
                }}
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? 'Copied!' : 'Copy Link'}
              </button>
            </div>
          )}
        </div>

        {/* Join Policy */}
        <div className="px-4 pb-2">
          <div
            className="flex items-center gap-2 mb-1.5"
            style={{ color: 'rgba(255,255,255,0.4)' }}
          >
            <span className="text-[9px] font-bold uppercase tracking-widest">
              Who can join
            </span>
          </div>
          {isHost ? (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => broadcastSetJoinPolicy('open')}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-colors text-left"
                style={{
                  background: joinPolicy === 'open' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: joinPolicy === 'open' ? '#fff' : 'rgba(255,255,255,0.4)',
                  border: joinPolicy === 'open' ? '1px solid rgba(255,255,255,0.2)' : '1px solid transparent',
                }}
              >
                <Globe size={11} />
                Anyone with the link
              </button>
              <button
                onClick={() => broadcastSetJoinPolicy('ask')}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-colors text-left"
                style={{
                  background: joinPolicy === 'ask' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  color: joinPolicy === 'ask' ? '#fff' : 'rgba(255,255,255,0.4)',
                  border: joinPolicy === 'ask' ? '1px solid rgba(255,255,255,0.2)' : '1px solid transparent',
                }}
              >
                <BellRing size={11} />
                Ask me first
              </button>
            </div>
          ) : (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px]"
              style={{ color: 'rgba(255,255,255,0.35)' }}
            >
              {joinPolicy === 'open' ? <Globe size={11} /> : <BellRing size={11} />}
              {joinPolicy === 'open' ? 'Anyone with the link' : 'Ask the host first'}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 pb-3">
          <p className="text-[9px] font-mono text-center" style={{ color: 'rgba(255,255,255,0.2)' }}>
            Room · {roomId.slice(0, 8).toUpperCase()}
            {variantLabel ? ` · ${variantLabel}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
};

export default SharePanel;
