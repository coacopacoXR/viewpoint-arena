import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Bot, ChevronDown, User, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../store';
import { useShallow } from 'zustand/react/shallow';
import { usePresence } from '../../lib/PresenceContext';
import { ViewMode } from '../../types';
import { pickDefaultSplitTarget } from '../../lib/splitTarget';
import { participantLabel } from '../../lib/identity';

// Rendered above the canvas while SPLIT_SCREEN is active. Surfaces three
// things the user can't otherwise see:
//   1. Which two POVs are on screen (left = you, right = the followed target)
//   2. A vertical separator so the two halves read as distinct viewports
//   3. A picker to swap targets without leaving split mode — people AND
//      agents are listed, so following a teammate's view is one click.
const SplitViewOverlay: React.FC = () => {
  const {
    viewMode,
    setViewMode,
    splitScreenTarget,
    setSplitScreenTarget,
    agents,
    hideAgents,
  } = useStore(useShallow(state => ({
    viewMode: state.viewMode,
    setViewMode: state.setViewMode,
    splitScreenTarget: state.splitScreenTarget,
    setSplitScreenTarget: state.setSplitScreenTarget,
    agents: state.agents,
    hideAgents: state.hideAgents,
  })));

  const { remoteParticipantList } = usePresence();

  const [pickerOpen, setPickerOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close the picker on outside-click so it feels like a real popover.
  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [pickerOpen]);

  // When agents are hidden, an agent target is treated as no target.
  // We do NOT write to the store — turning agents back on should restore it.
  const effectiveTarget = (splitScreenTarget?.kind === 'agent' && hideAgents)
    ? null
    : splitScreenTarget;

  const targetName = useMemo<string | null>(() => {
    if (!effectiveTarget) return null;
    if (effectiveTarget.kind === 'agent') {
      return agents.find(a => a.id === effectiveTarget.id)?.name ?? null;
    }
    const target = remoteParticipantList.find(p => p.userId === effectiveTarget.userId);
    return target ? participantLabel(target.name, target.guest) : null;
  }, [effectiveTarget, agents, remoteParticipantList]);

  // If the followed user disconnects, gracefully fall back using the same
  // priority as the default: next remaining participant → visible agent → null.
  useEffect(() => {
    if (!splitScreenTarget) return;
    if (splitScreenTarget.kind !== 'user') return;
    const stillThere = remoteParticipantList.some(p => p.userId === splitScreenTarget.userId);
    if (!stillThere) {
      setSplitScreenTarget(pickDefaultSplitTarget(remoteParticipantList, agents, hideAgents));
    }
  }, [splitScreenTarget, remoteParticipantList, agents, hideAgents, setSplitScreenTarget]);

  // Split view opened while alone: the first person to join fills the right
  // pane. Only when nothing was picked at all — a hidden agent target is kept
  // so turning agents back on restores it.
  useEffect(() => {
    if (viewMode !== ViewMode.SPLIT_SCREEN) return;
    if (splitScreenTarget !== null) return;
    if (remoteParticipantList.length === 0) return;
    setSplitScreenTarget({ kind: 'user', userId: remoteParticipantList[0].userId });
  }, [viewMode, splitScreenTarget, remoteParticipantList, setSplitScreenTarget]);

  if (viewMode !== ViewMode.SPLIT_SCREEN) return null;

  const targetKindLabel = effectiveTarget?.kind === 'user'
    ? 'Participant'
    : effectiveTarget?.kind === 'agent'
      ? 'Agent'
      : '';

  return (
    <div className="absolute inset-0 z-[60] pointer-events-none">
      {/* Vertical separator down the middle of the canvas */}
      <div
        className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2"
        style={{
          background:
            'linear-gradient(to bottom, transparent 0%, rgba(255,255,255,0.45) 12%, rgba(255,255,255,0.45) 88%, transparent 100%)',
        }}
      />

      {/* "YOU ←→ TARGET" badge straddling the seam at the top */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-stretch shadow-lg rounded-md overflow-hidden border border-white/15 backdrop-blur-md">
        <div className="bg-black/70 text-white text-[10px] font-mono font-bold tracking-widest px-3 py-1.5 flex items-center gap-1.5">
          <User size={10} className="text-emerald-400" />
          YOU
        </div>
        <div className="bg-black/55 text-white/80 px-2 flex items-center">
          <ArrowLeftRight size={11} />
        </div>
        <button
          onClick={() => setPickerOpen(v => !v)}
          className={clsx(
            'pointer-events-auto bg-black/70 text-white text-[10px] font-mono font-bold tracking-widest px-3 py-1.5 flex items-center gap-1.5 hover:bg-black/85 transition-colors',
          )}
          title="Switch split-screen target"
        >
          {effectiveTarget?.kind === 'user' ? (
            <User size={10} className="text-cyan-400" />
          ) : effectiveTarget?.kind === 'agent' ? (
            <Bot size={10} className="text-orange-400" />
          ) : null}
          <span className="truncate max-w-[160px]">{targetName ?? 'PICK A TARGET'}</span>
          <ChevronDown size={10} className={clsx('transition-transform', pickerOpen && 'rotate-180')} />
        </button>
      </div>

      {/* Picker popover */}
      {pickerOpen && (
        <div
          ref={popoverRef}
          className="pointer-events-auto absolute top-12 left-1/2 -translate-x-1/2 w-64 bg-[#0d0d0d]/95 backdrop-blur-md border border-white/15 rounded-lg shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <span className="text-white/60 text-[9px] font-mono uppercase tracking-widest">
              Follow in split view
            </span>
            <button
              onClick={() => setPickerOpen(false)}
              className="text-white/30 hover:text-white transition-colors"
              title="Close"
            >
              <X size={11} />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {/* Remote participants — listed first */}
            <div className="px-3 py-2">
              <div className="text-[8px] text-white/40 font-mono uppercase tracking-widest mb-1.5">
                Participants
              </div>
              {remoteParticipantList.length === 0 ? (
                <div className="text-[10px] text-white/30 italic px-1 py-2">
                  No other participants in this room yet.
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {remoteParticipantList.map(p => {
                    const isSel = effectiveTarget?.kind === 'user' && effectiveTarget.userId === p.userId;
                    return (
                      <button
                        key={p.userId}
                        onClick={() => {
                          setSplitScreenTarget({ kind: 'user', userId: p.userId });
                          setPickerOpen(false);
                        }}
                        className={clsx(
                          'flex items-center gap-2 px-2 py-1.5 rounded text-[11px] transition-colors border',
                          isSel
                            ? 'bg-white/15 border-white/30 text-white'
                            : 'bg-transparent border-white/5 text-white/65 hover:bg-white/10 hover:text-white',
                        )}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: p.color }}
                        />
                        <span className="flex-1 truncate font-mono">{participantLabel(p.name, p.guest)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* AI Agents — only when visible */}
            {!hideAgents && agents.length > 0 && (
              <div className="px-3 py-2 border-t border-white/5">
                <div className="text-[8px] text-white/40 font-mono uppercase tracking-widest mb-1.5">
                  Agents
                </div>
                <div className="flex flex-col gap-1">
                  {agents.map(a => {
                    const isSel = effectiveTarget?.kind === 'agent' && effectiveTarget.id === a.id;
                    return (
                      <button
                        key={a.id}
                        onClick={() => {
                          setSplitScreenTarget({ kind: 'agent', id: a.id });
                          setPickerOpen(false);
                        }}
                        className={clsx(
                          'flex items-center gap-2 px-2 py-1.5 rounded text-[11px] transition-colors border',
                          isSel
                            ? 'bg-white/15 border-white/30 text-white'
                            : 'bg-transparent border-white/5 text-white/65 hover:bg-white/10 hover:text-white',
                        )}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: a.color }}
                        />
                        <span className="flex-1 truncate font-mono">{a.name}</span>
                        <span className="text-[8px] text-white/35 uppercase tracking-widest">
                          {a.role}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Footer: exit split-screen entirely */}
          <div className="border-t border-white/10 px-3 py-2 flex items-center justify-between">
            <span className="text-white/35 text-[9px] font-mono uppercase tracking-widest">
              {targetKindLabel}
            </span>
            <button
              onClick={() => {
                setViewMode(ViewMode.FREE);
                setPickerOpen(false);
              }}
              className="text-[9px] font-mono uppercase tracking-widest text-white/50 hover:text-white border border-white/10 hover:border-white/30 px-2 py-1 rounded transition-colors"
            >
              Exit split
            </button>
          </div>
        </div>
      )}

      {/* Empty state when no valid target is selected */}
      {!effectiveTarget && remoteParticipantList.length === 0 && (
        <div className="absolute top-1/2 right-[15%] -translate-y-1/2 pointer-events-none">
          <p className="text-white/50 text-[11px] font-mono text-center leading-relaxed max-w-[200px]">
            No one else is here yet. When someone joins, their view appears here.
          </p>
        </div>
      )}
      {!effectiveTarget && remoteParticipantList.length > 0 && (
        <div className="absolute top-1/2 right-[15%] -translate-y-1/2 pointer-events-auto">
          <button
            onClick={() => setPickerOpen(true)}
            className="bg-black/65 text-white text-[10px] font-mono uppercase tracking-widest px-3 py-2 rounded border border-white/20 hover:bg-black/85 transition-colors"
          >
            + Pick someone
          </button>
        </div>
      )}
    </div>
  );
};

export default SplitViewOverlay;
