import React, { useState } from 'react';
import {
  X, AlertTriangle, CheckCircle2, Lightbulb, Check, XCircle, Pencil,
  StickyNote, ChevronDown, ChevronLeft, ChevronRight,
  Mic, MessageSquare, MessageCircle, Layers, Camera,
  Info, ShieldAlert,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../store';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { usePresence } from '../../lib/PresenceContext';
import InsightDetailModal from './InsightDetailModal';
import ConversationPanel from './ConversationPanel';
import CommentsPanel from './CommentsPanel';
import ChatPanel from './ChatPanel';
import ReviewPanelContent from './ReviewPanelContent';
import RecordingControls from './RecordingControls';
import type { InsightCard } from '../../types';
import type { PinSeverity } from '../../lib/reviewSetupStore';

// Split-screen meeting workspace for the host. Top: persistent slide-context
// hero anchored to the active agenda slide, then the post-meeting recording
// controls (which hide themselves on a mock-capture deployment). Below: tabbed
// surfaces for action triage, follow-up notes, curated viewpoint/pin editing,
// capture transcript, comments, and chat. Absorbs the right side-panel entirely.

type TabId = 'actions' | 'notes' | 'curated' | 'capture' | 'comments' | 'chat';

const TYPE_META: Record<InsightCard['type'], { label: string; color: string; icon: React.ReactNode }> = {
  RISK:      { label: 'Risk',      color: '#ef4444', icon: <AlertTriangle size={12} /> },
  ACTION:    { label: 'Action',    color: '#3b82f6', icon: <CheckCircle2 size={12} /> },
  RATIONALE: { label: 'Rationale', color: '#f59e0b', icon: <Lightbulb size={12} /> },
};

const STATUS_PILL: Record<InsightCard['details']['status'], string> = {
  Open:        'bg-gray-100 text-gray-700 border-gray-300',
  'In Review': 'bg-amber-50 text-amber-700 border-amber-300',
  Approved:    'bg-emerald-50 text-emerald-700 border-emerald-300',
  Rejected:    'bg-red-50 text-red-700 border-red-300',
};

const PIN_COLOR: Record<PinSeverity, string> = {
  info: '#3b82f6',
  concern: '#f59e0b',
  blocker: '#ef4444',
};

const PIN_ICON: Record<PinSeverity, React.ReactNode> = {
  info: <Info size={10} />,
  concern: <AlertTriangle size={10} />,
  blocker: <ShieldAlert size={10} />,
};

const ManagerPanel: React.FC = () => {
  const setManagerMode = useActiveReviewStore((s) => s.setManagerMode);
  const config = useActiveReviewStore((s) => s.config);
  const insightCards = useStore((s) => s.insightCards);
  const comments = useStore((s) => s.comments);
  const liveChat = useStore((s) => s.liveChat);

  const [tab, setTab] = useState<TabId>('actions');
  const [lastSeenChat, setLastSeenChat] = useState(0);

  React.useEffect(() => {
    if (tab === 'chat') setLastSeenChat(liveChat.length);
  }, [tab, liveChat.length]);

  const openActions = insightCards.filter(
    (c) => c.details.status === 'Open' || c.details.status === 'In Review',
  ).length;
  const unresolvedComments = comments.filter((c) => !c.resolved).length;
  const unreadChat = tab === 'chat' ? 0 : Math.max(0, liveChat.length - lastSeenChat);

  return (
    <div className="w-full h-full flex flex-col bg-white text-gray-800 font-sans overflow-hidden border-l border-gray-200">
      {/* ─── Header ─────────────────────────────────────────────────────────── */}
      <header className="relative flex items-center justify-between px-4 py-2.5 shrink-0 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2 min-w-0">
          <div className="min-w-0">
            <div className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-black">Manager</div>
            {config?.title && (
              <div className="text-[11px] text-gray-500 truncate leading-tight">{config.title}</div>
            )}
          </div>
        </div>
        <button
          onClick={() => setManagerMode(false)}
          className="text-gray-500 hover:text-gray-900 p-1 rounded hover:bg-gray-100 transition-colors"
          title="Close manager view"
        >
          <X size={16} />
        </button>
      </header>

      {/* ─── Persistent slide-context hero ──────────────────────────────────── */}
      <SlideHero />

      {/* ─── Post-meeting recording (host-only) ─────────────────────────────── */}
      <RecordingControls />

      {/* ─── Tab bar ────────────────────────────────────────────────────────── */}
      <nav className="flex border-b border-gray-200 bg-white shrink-0 overflow-x-auto custom-scrollbar px-2 pt-2 gap-0.5">
        <TabButton id="actions"  current={tab} onSelect={setTab} icon={<CheckCircle2 size={12} />} badge={openActions}>Actions</TabButton>
        <TabButton id="notes"    current={tab} onSelect={setTab} icon={<StickyNote size={12} />}>Notes</TabButton>
        <TabButton id="curated"  current={tab} onSelect={setTab} icon={<Camera size={12} />}>Curated</TabButton>
        <span className="w-px self-center h-5 bg-gray-200 shrink-0 mx-1" />
        <TabButton id="capture"  current={tab} onSelect={setTab} icon={<Mic size={12} />}>Capture</TabButton>
        <TabButton id="comments" current={tab} onSelect={setTab} icon={<MessageSquare size={12} />} badge={unresolvedComments} badgeColor="blue">Comments</TabButton>
        <TabButton id="chat"     current={tab} onSelect={setTab} icon={<MessageCircle size={12} />} badge={unreadChat} badgeColor="green">Chat</TabButton>
      </nav>

      {/* ─── Tab content ────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-white">
        {tab === 'actions'  && <ActionsTab />}
        {tab === 'notes'    && <NotesTab />}
        {tab === 'curated'  && (
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
            {config ? (
              <ReviewPanelContent theme="light" embedded />
            ) : (
              <div className="text-center py-10 px-4 text-gray-400 text-[11px] italic">
                No active review — nothing curated to edit yet.
              </div>
            )}
          </div>
        )}
        {tab === 'capture'  && <div className="flex-1 min-h-0 overflow-hidden"><ConversationPanel /></div>}
        {tab === 'comments' && <div className="flex-1 min-h-0 overflow-hidden"><CommentsPanel /></div>}
        {tab === 'chat'     && <div className="flex-1 min-h-0 overflow-hidden"><ChatPanel /></div>}
      </div>
    </div>
  );
};

// ─── Persistent slide-context hero ─────────────────────────────────────────

const SlideHero: React.FC = () => {
  const config = useActiveReviewStore((s) => s.config);
  const agendaIdx = useActiveReviewStore((s) => s.agendaIdx);
  const nextSlide = useActiveReviewStore((s) => s.nextSlide);
  const prevSlide = useActiveReviewStore((s) => s.prevSlide);
  const jumpToSlide = useActiveReviewStore((s) => s.jumpToSlide);
  const jumpToViewpoint = useActiveReviewStore((s) => s.jumpToViewpoint);

  if (!config || config.agenda.length === 0) {
    return (
      <div className="px-4 py-3 bg-white border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-gray-500">
          <Layers size={11} /> No slides in this review
        </div>
      </div>
    );
  }

  const slide = config.agenda[Math.max(0, Math.min(agendaIdx, config.agenda.length - 1))];
  const linkedVps = slide.viewpointIds
    .map((vid) => config.viewpoints.find((v) => v.id === vid))
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
  const linkedPins = slide.pinIds
    .map((pid) => config.pins.find((p) => p.id === pid))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  return (
    <section className="relative shrink-0 bg-white border-b border-gray-200">
      {/* Top row: slide counter + nav buttons */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1.5">
        <div className="flex items-center gap-2 text-[10px] font-mono font-bold uppercase tracking-widest text-gray-500">
          <Layers size={11} />
          Slide {agendaIdx + 1} <span className="text-gray-400">/</span> {config.agenda.length}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={prevSlide}
            disabled={config.agenda.length < 2}
            className="w-6 h-6 rounded flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Previous slide"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={nextSlide}
            disabled={config.agenda.length < 2}
            className="w-6 h-6 rounded flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Next slide"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Title + notes */}
      <div className="px-4 pb-2">
        <div className="text-[15px] font-bold text-gray-900 leading-tight truncate">
          {slide.title || 'Untitled slide'}
        </div>
        {slide.notes && (
          <div className="text-[11px] text-gray-500 italic line-clamp-2 mt-0.5 leading-snug">
            {slide.notes}
          </div>
        )}
      </div>

      {/* Attached viewpoints + pins */}
      {(linkedVps.length > 0 || linkedPins.length > 0) && (
        <div className="px-4 pb-2.5 flex flex-wrap gap-1.5">
          {linkedVps.map((v) => (
            <button
              key={v.id}
              onClick={() => jumpToViewpoint(v.id)}
              className="group flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full bg-white border border-gray-200 hover:border-gray-400 hover:shadow-sm transition-all"
              title={`Jump camera to ${v.label}`}
            >
              {v.thumbnail ? (
                <img src={v.thumbnail} alt="" className="w-6 h-4 object-cover rounded-full" />
              ) : (
                <span className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
                  <Camera size={9} className="text-gray-600" />
                </span>
              )}
              <span className="text-[10px] font-bold text-gray-700 group-hover:text-gray-900 truncate max-w-[110px]">
                {v.label}
              </span>
            </button>
          ))}
          {linkedPins.map((p) => (
            <span
              key={p.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-bold"
              style={{
                background: `${PIN_COLOR[p.severity]}15`,
                borderColor: `${PIN_COLOR[p.severity]}60`,
                color: PIN_COLOR[p.severity],
              }}
            >
              {PIN_ICON[p.severity]}
              <span className="truncate max-w-[110px]">{p.label}</span>
            </span>
          ))}
        </div>
      )}

      {/* Dot navigator */}
      <div className="px-4 pb-3 flex items-center justify-center gap-1">
        {config.agenda.map((_, i) => (
          <button
            key={i}
            onClick={() => jumpToSlide(i)}
            title={`Slide ${i + 1}`}
            className={clsx(
              'rounded-full transition-all shrink-0',
              i === agendaIdx
                ? 'w-4 h-1.5 bg-black'
                : 'w-1.5 h-1.5 bg-gray-300 hover:bg-gray-400'
            )}
          />
        ))}
      </div>
    </section>
  );
};

// ─── Tab button ─────────────────────────────────────────────────────────────

const TabButton: React.FC<{
  id: TabId;
  current: TabId;
  onSelect: (id: TabId) => void;
  icon: React.ReactNode;
  badge?: number;
  badgeColor?: 'emerald' | 'blue' | 'green';
  children: React.ReactNode;
}> = ({ id, current, onSelect, icon, badge, badgeColor = 'emerald', children }) => {
  const active = id === current;
  const badgeBg = badgeColor === 'blue' ? 'bg-blue-500' : badgeColor === 'green' ? 'bg-green-500' : 'bg-black';
  return (
    <button
      onClick={() => onSelect(id)}
      className={clsx(
        'shrink-0 px-2 py-1.5 rounded text-[10px] font-bold flex items-center justify-center gap-1.5 transition-all relative',
        active
          ? 'bg-black text-white'
          : 'text-gray-500 hover:bg-gray-100'
      )}
    >
      {icon}
      {children}
      {badge !== undefined && badge > 0 && (
        <span className={clsx(
          'min-w-[14px] h-3.5 px-1 rounded-full text-[8px] flex items-center justify-center font-bold text-white',
          active ? 'bg-white/20' : badgeBg,
        )}>
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
};

// ─── Actions tab ────────────────────────────────────────────────────────────

const ActionsTab: React.FC = () => {
  const insightCards = useStore((s) => s.insightCards);
  const updateInsight = useStore((s) => s.updateInsight);
  const [editingCard, setEditingCard] = useState<InsightCard | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'decided'>('all');

  const filteredCards = insightCards.filter((c) => {
    if (filter === 'open') return c.details.status === 'Open' || c.details.status === 'In Review';
    if (filter === 'decided') return c.details.status === 'Approved' || c.details.status === 'Rejected';
    return true;
  });

  const setStatus = (cardId: string, status: InsightCard['details']['status']) => {
    const card = insightCards.find((c) => c.id === cardId);
    if (!card) return;
    updateInsight(cardId, { details: { ...card.details, status } });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2 flex items-center justify-between border-b border-gray-100 shrink-0 bg-gray-50/50">
        <div className="text-[10px] font-mono text-gray-400">
          {insightCards.length} card{insightCards.length === 1 ? '' : 's'}
        </div>
        <div className="flex items-center gap-0.5 text-[10px] font-bold uppercase">
          {(['all', 'open', 'decided'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                'px-2 py-0.5 rounded transition-colors',
                filter === f
                  ? 'bg-black text-white'
                  : 'text-gray-400 hover:text-gray-700'
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar p-3 flex flex-col gap-2">
        {filteredCards.length === 0 && (
          <div className="text-center py-10 text-gray-400 text-[11px] italic">
            {insightCards.length === 0
              ? 'No action cards yet — the AI will generate them as the meeting progresses.'
              : 'No cards match this filter.'}
          </div>
        )}
        {filteredCards.map((card) => {
          const meta = TYPE_META[card.type];
          return (
            <div key={card.id} className="rounded-md border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all">
              <div className="px-3 py-2 flex items-start gap-2">
                <span
                  className="mt-0.5 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider text-white shrink-0"
                  style={{ background: meta.color }}
                >
                  {meta.icon} {meta.label}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-bold text-gray-900 truncate">{card.title}</div>
                  <div className="text-[11px] text-gray-600 line-clamp-2 leading-snug mt-0.5">{card.description}</div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={clsx('text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border', STATUS_PILL[card.details.status])}>
                      {card.details.status}
                    </span>
                    {card.details.assignee && (
                      <span className="text-[10px] text-gray-500 truncate">→ {card.details.assignee}</span>
                    )}
                    {card.details.priority && (
                      <span className="text-[9px] font-mono text-gray-400">{card.details.priority}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="px-3 pb-2 flex items-center gap-1">
                <button
                  onClick={() => setStatus(card.id, 'Approved')}
                  disabled={card.details.status === 'Approved'}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-50 hover:bg-emerald-100 text-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-emerald-200"
                >
                  <Check size={11} /> Approve
                </button>
                <button
                  onClick={() => setStatus(card.id, 'Rejected')}
                  disabled={card.details.status === 'Rejected'}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-red-50 hover:bg-red-100 text-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors border border-red-200"
                >
                  <XCircle size={11} /> Reject
                </button>
                <button
                  onClick={() => setEditingCard(card)}
                  className="flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors border border-gray-200"
                  title="Open full editor"
                >
                  <Pencil size={11} /> Edit
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {editingCard && (
        <InsightDetailModal card={editingCard} onClose={() => setEditingCard(null)} />
      )}
    </div>
  );
};

// ─── Notes tab (per-slide follow-ups + session notes) ───────────────────────

const NotesTab: React.FC = () => {
  const config = useActiveReviewStore((s) => s.config);
  const agendaIdx = useActiveReviewStore((s) => s.agendaIdx);
  const updateAgendaItem = useActiveReviewStore((s) => s.updateAgendaItem);
  const sessionNotes = useActiveReviewStore((s) => s.sessionNotes);
  const setSessionNotes = useActiveReviewStore((s) => s.setSessionNotes);
  const { broadcastReviewConfig } = usePresence();

  const updateSlideFollowUp = (itemId: string, followUp: string) => {
    const next = updateAgendaItem(itemId, { followUp });
    if (next) broadcastReviewConfig(next);
  };

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      {/* Slide follow-ups */}
      <section className="border-b border-gray-100">
        <div className="px-4 py-2.5 flex items-center gap-2 sticky top-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 z-10">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Slide Follow-ups</h2>
          <span className="text-[10px] font-mono text-gray-400">({config?.agenda.length ?? 0})</span>
        </div>
        <div className="px-3 py-2 flex flex-col gap-1.5">
          {(!config || config.agenda.length === 0) && (
            <div className="text-center py-6 text-gray-400 text-[11px] italic">
              No slides in this review.
            </div>
          )}
          {config?.agenda.map((item, idx) => (
            <SlideFollowUpCard
              key={item.id}
              idx={idx}
              item={item}
              highlighted={idx === agendaIdx}
              onChange={(text) => updateSlideFollowUp(item.id, text)}
            />
          ))}
        </div>
      </section>

      {/* Session notes */}
      <section>
        <div className="px-4 py-2.5 flex items-center gap-2 border-b border-gray-100">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-gray-500">Session Notes</h2>
        </div>
        <div className="px-3 py-3">
          <textarea
            value={sessionNotes}
            onChange={(e) => setSessionNotes(e.target.value)}
            placeholder="Running log — open items, decisions, parking lot…"
            className="w-full h-48 bg-gray-50 text-[12px] rounded p-3 border border-gray-200 outline-none focus:border-gray-400 placeholder:text-gray-400 resize-none leading-relaxed text-gray-800"
          />
        </div>
      </section>
    </div>
  );
};

const SlideFollowUpCard: React.FC<{
  idx: number;
  item: { id: string; title: string; followUp?: string };
  highlighted: boolean;
  onChange: (text: string) => void;
}> = ({ idx, item, highlighted, onChange }) => {
  const [open, setOpen] = useState(Boolean(item.followUp) || highlighted);
  React.useEffect(() => {
    if (highlighted) setOpen(true);
  }, [highlighted]);
  return (
    <div className={clsx(
      'rounded border transition-all',
      highlighted
        ? 'border-gray-400 bg-gray-50 shadow-[0_0_0_3px_rgba(0,0,0,0.04)]'
        : 'border-gray-200 bg-white'
    )}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-50 transition-colors"
      >
        <span className={clsx(
          'text-[9px] font-mono tabular-nums w-6 text-left',
          highlighted ? 'text-black font-bold' : 'text-gray-400',
        )}>
          {String(idx + 1).padStart(2, '0')}
        </span>
        <span className="flex-1 text-[12px] font-bold text-gray-800 text-left truncate">{item.title || 'Untitled slide'}</span>
        {highlighted && (
          <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500 text-white">
            Live
          </span>
        )}
        {item.followUp && !highlighted && (
          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
            • Noted
          </span>
        )}
        <ChevronDown size={13} className={clsx('text-gray-400 transition-transform', open ? 'rotate-180' : '')} />
      </button>
      {open && (
        <div className="px-3 pb-3">
          <textarea
            value={item.followUp ?? ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Follow-up for this slide — decisions, owners, open questions…"
            className="w-full h-20 bg-white text-[11px] rounded p-2 border border-gray-200 outline-none focus:border-gray-400 placeholder:text-gray-400 resize-none leading-snug text-gray-800"
          />
        </div>
      )}
    </div>
  );
};

export default ManagerPanel;
