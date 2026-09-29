import React from 'react';
import {
  Camera, MapPin, AlertTriangle, Info, ShieldAlert,
  ChevronLeft, ChevronRight, FileText, Image as ImageIcon, Layers,
  ClipboardList, MessageSquare,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { usePresence } from '../../lib/PresenceContext';
import { useStore } from '../../store';
import { getIdentity } from '../../lib/identity';
import type { PinSeverity } from '../../lib/reviewSetupStore';

const PIN_COLOR: Record<PinSeverity, string> = {
  info: '#3b82f6',
  concern: '#f59e0b',
  blocker: '#ef4444',
};

const PIN_ICON: Record<PinSeverity, React.ReactNode> = {
  info: <Info size={11} />,
  concern: <AlertTriangle size={11} />,
  blocker: <ShieldAlert size={11} />,
};

const PreReviewBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 border border-emerald-500/30">
    <span className="w-1 h-1 bg-emerald-500 rounded-full" /> Pre-Review
  </span>
);

const AnnotationBadge: React.FC<{ kind: 'visual' | 'text' }> = ({ kind }) => (
  <span className="inline-flex items-center gap-1 text-[8px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">
    {kind === 'visual' ? <ImageIcon size={9} /> : <FileText size={9} />}
    {kind === 'visual' ? 'Visual' : 'Text'}
  </span>
);

interface Props {
  // When true, renders against a dark backdrop (used inside the boardroom
  // floating panel). When false, renders against the lighter chrome used by
  // the bottom-dock expansion.
  theme?: 'light' | 'dark';
  // When true, hides the agenda/slide navigator section AND the host-only
  // "Open Manager view" trigger. Used when this component is embedded inside
  // the Manager workspace, which has its own persistent slide context header.
  embedded?: boolean;
}

// Editor view for an active review — viewpoint navigator + pins-as-comments
// stream. Reused by ReviewViewpointsDock (light) and the boardroom Review
// floating panel (dark). Returns null when no review config is active.
const ReviewPanelContent: React.FC<Props> = ({ theme = 'light', embedded = false }) => {
  const config = useActiveReviewStore((s) => s.config);
  const activeIdx = useActiveReviewStore((s) => s.activeViewpointIdx);
  const nextVp = useActiveReviewStore((s) => s.nextViewpoint);
  const prevVp = useActiveReviewStore((s) => s.prevViewpoint);
  const jumpAtIdx = useActiveReviewStore((s) => s.jumpToViewpointAtIdx);
  const jumpToViewpoint = useActiveReviewStore((s) => s.jumpToViewpoint);
  const updateViewpoint = useActiveReviewStore((s) => s.updateViewpoint);
  const updatePin = useActiveReviewStore((s) => s.updatePin);
  const commitPinAsComment = useActiveReviewStore((s) => s.commitPinAsComment);
  const agendaIdx = useActiveReviewStore((s) => s.agendaIdx);
  const nextSlide = useActiveReviewStore((s) => s.nextSlide);
  const prevSlide = useActiveReviewStore((s) => s.prevSlide);
  const jumpToSlide = useActiveReviewStore((s) => s.jumpToSlide);
  const setManagerMode = useActiveReviewStore((s) => s.setManagerMode);
  const sessionHostId = useStore((s) => s.sessionHostId);
  const addComment = useStore((s) => s.addComment);
  const { broadcastReviewConfig, broadcastCommentAdd, localUserId } = usePresence();
  const isHost = sessionHostId === localUserId || sessionHostId === null;

  if (!config) return null;
  const { viewpoints, pins, agenda } = config;
  if (viewpoints.length === 0 && pins.length === 0 && agenda.length === 0) {
    return (
      <div className="p-4 text-center text-[11px] italic" style={{ color: theme === 'dark' ? 'rgba(255,255,255,0.4)' : '#9ca3af' }}>
        No curated viewpoints, pins, or slides
      </div>
    );
  }

  const currentVp = viewpoints.length > 0
    ? viewpoints[Math.max(0, Math.min(activeIdx, viewpoints.length - 1))]
    : null;
  const currentSlide = agenda.length > 0
    ? agenda[Math.max(0, Math.min(agendaIdx, agenda.length - 1))]
    : null;

  const scrollToPinCard = (pinId: string) => {
    const el = document.getElementById(`review-pin-card-${pinId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-emerald-400');
      setTimeout(() => el.classList.remove('ring-2', 'ring-emerald-400'), 1500);
    }
  };

  const sync = (next: ReturnType<typeof updateViewpoint>) => {
    if (next) broadcastReviewConfig(next);
  };

  const handleCommitPin = (pinId: string) => {
    const identity = getIdentity();
    const author = identity?.name ?? 'Guest';
    const authorColor = identity?.color ?? '#4F8EF7';
    const result = commitPinAsComment(pinId, author, authorColor);
    if (!result) return;
    addComment(result.comment);
    broadcastCommentAdd(result.comment);
    broadcastReviewConfig(result.config);
  };

  const handleCommitAllPins = () => {
    const uncommitted = pins.filter((p) => !p.committedCommentId);
    if (uncommitted.length === 0) return;
    // Confirm bulk action with a plain count — the spec calls for it because
    // it creates one comment per pin in the room.
    if (typeof window !== 'undefined' && window.confirm) {
      const ok = window.confirm(`Commit ${uncommitted.length} pin${uncommitted.length === 1 ? '' : 's'} as comments?`);
      if (!ok) return;
    }
    const identity = getIdentity();
    const author = identity?.name ?? 'Guest';
    const authorColor = identity?.color ?? '#4F8EF7';
    let lastConfig = null;
    for (const pin of uncommitted) {
      const result = commitPinAsComment(pin.id, author, authorColor);
      if (!result) continue;
      addComment(result.comment);
      broadcastCommentAdd(result.comment);
      lastConfig = result.config;
    }
    // One broadcast for the final state — intermediate ones would race.
    if (lastConfig) broadcastReviewConfig(lastConfig);
  };

  // Theme-aware classes
  const t = theme === 'dark'
    ? {
        panelBg: 'bg-transparent',
        sectionBorder: 'border-white/10',
        labelEmpty: 'text-white/60',
        titleText: 'text-white',
        notesBg: 'bg-white/5 border-white/10 focus:border-emerald-400/60 text-white/85',
        noteText: 'text-white/85',
        dimText: 'text-white/40',
        navBtnBg: 'bg-white/10 text-white/85 hover:bg-white/20',
        navDot: 'bg-white/30',
        pinCardBg: 'bg-white/5',
        commentLabelBg: 'bg-transparent',
      }
    : {
        panelBg: 'bg-transparent',
        sectionBorder: 'border-gray-100',
        labelEmpty: 'text-gray-500',
        titleText: 'text-gray-900',
        notesBg: 'bg-gray-50 border-gray-200 focus:border-emerald-400/60 text-gray-700',
        noteText: 'text-gray-700',
        dimText: 'text-gray-400',
        navBtnBg: 'bg-gray-100 text-gray-700 hover:bg-gray-200',
        navDot: 'bg-gray-300',
        pinCardBg: 'bg-white',
        commentLabelBg: 'bg-transparent',
      };

  return (
    <div className={t.panelBg}>
      {/* Agenda / slide-deck navigator */}
      {currentSlide && !embedded && (
        <div className={clsx('p-3 border-b', t.sectionBorder)}>
          <div className="flex items-center justify-between mb-2">
            <div className={clsx('text-[9px] font-bold uppercase tracking-widest flex items-center gap-1', t.dimText)}>
              <Layers size={10} /> Agenda
            </div>
            <div className={clsx('text-[10px] font-mono tabular-nums', t.dimText)}>
              Slide {agendaIdx + 1} / {agenda.length}
            </div>
          </div>

          <div className={clsx('text-sm font-bold', t.titleText)}>{currentSlide.title || 'Untitled slide'}</div>
          {currentSlide.notes && (
            <div className={clsx('text-[11px] mt-1 whitespace-pre-wrap leading-snug', t.noteText)}>
              {currentSlide.notes}
            </div>
          )}

          {/* Attached viewpoints + pins */}
          {(currentSlide.viewpointIds.length > 0 || currentSlide.pinIds.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {currentSlide.viewpointIds.map((vid) => {
                const v = viewpoints.find((x) => x.id === vid);
                if (!v) return null;
                return (
                  <button
                    key={vid}
                    onClick={() => jumpToViewpoint(vid)}
                    className={clsx(
                      'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors',
                      theme === 'dark'
                        ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-100 hover:bg-emerald-500/25'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100'
                    )}
                    title="Jump camera to this viewpoint"
                  >
                    {v.thumbnail && <img src={v.thumbnail} alt="" className="w-6 h-4 object-cover rounded-sm" />}
                    <Camera size={9} />
                    <span className="truncate max-w-[120px]">{v.label}</span>
                  </button>
                );
              })}
              {currentSlide.pinIds.map((pid) => {
                const p = pins.find((x) => x.id === pid);
                if (!p) return null;
                const color = PIN_COLOR[p.severity];
                return (
                  <button
                    key={pid}
                    onClick={() => scrollToPinCard(pid)}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border transition-colors"
                    style={{
                      background: `${color}1a`,
                      borderColor: `${color}66`,
                      color: theme === 'dark' ? '#fff' : '#111',
                    }}
                    title="Show this pin"
                  >
                    <span style={{ color }} className="flex items-center">{PIN_ICON[p.severity]}</span>
                    <span className="truncate max-w-[120px]">{p.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Slide nav */}
          <div className="mt-3 flex items-center justify-between gap-1">
            <button
              onClick={prevSlide}
              disabled={agenda.length < 2}
              className={clsx('flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide disabled:opacity-40 disabled:cursor-not-allowed transition-colors', t.navBtnBg)}
            >
              <ChevronLeft size={12} /> Prev
            </button>

            <div className="flex items-center gap-1 overflow-x-auto max-w-[140px]">
              {agenda.map((_, i) => (
                <button
                  key={i}
                  onClick={() => jumpToSlide(i)}
                  title={`Slide ${i + 1}`}
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full shrink-0 transition-all',
                    i === agendaIdx ? 'bg-emerald-500 scale-125' : t.navDot
                  )}
                />
              ))}
            </div>

            <button
              onClick={nextSlide}
              disabled={agenda.length < 2}
              className={clsx('flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide disabled:opacity-40 disabled:cursor-not-allowed transition-colors', t.navBtnBg)}
            >
              Next <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Viewpoint navigator */}
      {currentVp && (
        <div className={clsx('p-3 border-b', t.sectionBorder)}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <PreReviewBadge />
              <AnnotationBadge kind="visual" />
            </div>
            <div className={clsx('text-[10px] font-mono tabular-nums', t.dimText)}>
              {activeIdx + 1} / {viewpoints.length}
            </div>
          </div>

          <button
            onClick={() => jumpAtIdx(activeIdx)}
            className={clsx('block w-full aspect-video rounded overflow-hidden border transition-colors group',
              theme === 'dark' ? 'bg-black border-white/10 hover:border-emerald-400/60' : 'bg-gray-100 border-gray-200 hover:border-emerald-400/60'
            )}
            title="Jump to this viewpoint"
          >
            {currentVp.thumbnail ? (
              <img src={currentVp.thumbnail} alt="" className="w-full h-full object-cover group-hover:opacity-95" />
            ) : (
              <div className={clsx('w-full h-full flex items-center justify-center', t.dimText)}>
                <Camera size={20} />
              </div>
            )}
          </button>

          <input
            value={currentVp.label}
            onChange={(e) => sync(updateViewpoint(currentVp.id, { label: e.target.value }))}
            placeholder="Viewpoint title"
            className={clsx('w-full mt-2 bg-transparent text-sm font-bold outline-none border-b border-transparent focus:border-emerald-400/60 transition-colors', t.titleText)}
          />
          <textarea
            value={currentVp.notes ?? ''}
            onChange={(e) => sync(updateViewpoint(currentVp.id, { notes: e.target.value }))}
            placeholder="Add notes about this view…"
            className={clsx('w-full mt-2 h-14 text-xs rounded p-2 border outline-none resize-none transition-colors', t.notesBg)}
          />

          <div className="mt-2 flex items-center justify-between gap-1">
            <button
              onClick={prevVp}
              disabled={viewpoints.length < 2}
              className={clsx('flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide disabled:opacity-40 disabled:cursor-not-allowed transition-colors', t.navBtnBg)}
            >
              <ChevronLeft size={12} /> Prev
            </button>

            <div className="flex items-center gap-1 overflow-x-auto max-w-[140px]">
              {viewpoints.map((_, i) => (
                <button
                  key={i}
                  onClick={() => jumpAtIdx(i)}
                  title={`Viewpoint ${i + 1}`}
                  className={clsx(
                    'w-1.5 h-1.5 rounded-full shrink-0 transition-all',
                    i === activeIdx ? 'bg-emerald-500 scale-125' : t.navDot
                  )}
                />
              ))}
            </div>

            <button
              onClick={nextVp}
              disabled={viewpoints.length < 2}
              className={clsx('flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide disabled:opacity-40 disabled:cursor-not-allowed transition-colors', t.navBtnBg)}
            >
              Next <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Pins-as-comments stream */}
      {pins.length > 0 && (
        <div className="p-3 flex flex-col gap-2 max-h-[40vh] overflow-y-auto">
          <div className={clsx('text-[9px] font-bold uppercase tracking-widest flex items-center gap-1', t.dimText)}>
            <MapPin size={10} /> Pins ({pins.length}) · text-only comments
          </div>
          {pins.map((p) => (
            <div
              key={p.id}
              id={`review-pin-card-${p.id}`}
              className={clsx('rounded border p-2 flex flex-col gap-1.5 transition-shadow', t.pinCardBg)}
              style={{ borderColor: `${PIN_COLOR[p.severity]}55` }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <PreReviewBadge />
                  <AnnotationBadge kind="text" />
                </div>
                <span
                  className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded text-white"
                  style={{ background: PIN_COLOR[p.severity] }}
                >
                  {PIN_ICON[p.severity]} {p.severity}
                </span>
              </div>
              <input
                value={p.label}
                onChange={(e) => sync(updatePin(p.id, { label: e.target.value }))}
                placeholder="Pin label"
                className={clsx('w-full bg-transparent text-xs font-bold outline-none border-b border-transparent focus:border-emerald-400/60 transition-colors', t.titleText)}
              />
              {p.partName && (
                <div className={clsx('text-[9px] font-mono', t.dimText)}>on {p.partName}</div>
              )}
              <textarea
                value={p.notes ?? ''}
                onChange={(e) => sync(updatePin(p.id, { notes: e.target.value }))}
                placeholder="Comment…"
                className={clsx('w-full h-12 text-[11px] rounded p-1.5 border outline-none resize-none transition-colors', t.notesBg)}
              />
              <button
                onClick={() => handleCommitPin(p.id)}
                disabled={!!p.committedCommentId}
                className={clsx(
                  'flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wide transition-colors',
                  p.committedCommentId
                    ? 'opacity-50 cursor-not-allowed bg-gray-100 text-gray-400 border border-gray-200'
                    : theme === 'dark'
                      ? 'bg-white/10 text-white/80 hover:bg-white/20 border border-white/10'
                      : 'bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200',
                )}
                title={p.committedCommentId ? 'This pin has been committed as a comment' : 'Create a live comment from this pin'}
              >
                <MessageSquare size={10} />
                {p.committedCommentId ? 'Committed' : 'Commit as comment'}
              </button>
            </div>
          ))}
          {pins.some((p) => !p.committedCommentId) && (
            <button
              onClick={handleCommitAllPins}
              className={clsx(
                'flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[10px] font-bold uppercase tracking-wide transition-colors mt-1',
                theme === 'dark'
                  ? 'text-white/50 hover:text-white/70 hover:bg-white/5'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50',
              )}
              title="Commit every uncommitted pin as a live comment"
            >
              <MessageSquare size={10} />
              Commit all pins ({pins.filter((p) => !p.committedCommentId).length})
            </button>
          )}
        </div>
      )}

      {/* Host-only manager-mode trigger — boardroom only. In the arena the
          call bar's Manage button is the one entry point (and is there even
          with no review); the boardroom has no call bar, so it keeps this. */}
      {isHost && !embedded && theme === 'dark' && (
        <div className={clsx('p-3 border-t', t.sectionBorder)}>
          <button
            onClick={() => setManagerMode(true)}
            className={clsx(
              'w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-[11px] font-bold uppercase tracking-wide transition-colors',
              theme === 'dark'
                ? 'bg-emerald-500/15 border border-emerald-400/40 text-emerald-100 hover:bg-emerald-500/25'
                : 'bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100',
            )}
            title="Split-screen workspace: triage action cards and write follow-ups"
          >
            <ClipboardList size={13} />
            Open Manager view
          </button>
          <div className={clsx('text-[9px] text-center mt-1 italic', t.dimText)}>
            Host-only · split-screen meeting workspace
          </div>
        </div>
      )}
    </div>
  );
};

export default ReviewPanelContent;
