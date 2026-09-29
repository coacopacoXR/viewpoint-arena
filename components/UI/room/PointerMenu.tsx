// Pointer ▾ — the two deictic toggles that are set-and-forget (finger
// pointing, hover dwell) folded into one menu, so the top bar keeps the
// Highlight granularity the user drives constantly and nothing else.
//
// The button carries a dot while either toggle is on: an active pointer that
// cannot be seen from the bar is how people end up pointing without knowing.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Hand, MousePointer } from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../../../store';
import { useFingerPointerStore } from '../../../lib/fingerPointerStore';

const FingerRow: React.FC = () => {
  const mode = useFingerPointerStore((s) => s.mode);
  const calibration = useFingerPointerStore((s) => s.calibration);
  const enable = useFingerPointerStore((s) => s.enableFingerPointer);
  const disable = useFingerPointerStore((s) => s.disableFingerPointer);
  const recalibrate = useFingerPointerStore((s) => s.startRecalibration);
  const isActive = mode === 'active';
  return (
    <div className="flex items-center gap-1">
      <Hand size={14} className={isActive ? 'text-emerald-500' : 'text-gray-400'} />
      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mr-1">Finger</span>
      <button
        onClick={isActive ? disable : enable}
        title={isActive ? 'Disable finger pointer' : 'Enable finger pointer'}
        className={clsx(
          'text-[9px] font-bold uppercase px-2 py-0.5 rounded transition-all',
          isActive ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-gray-800'
        )}
      >
        {isActive ? 'On' : 'Off'}
      </button>
      {calibration && (
        <button
          onClick={recalibrate}
          title="Recalibrate corners"
          className="text-[9px] font-bold uppercase px-2 py-0.5 rounded text-gray-400 hover:text-gray-700 transition-all ml-auto"
        >
          Recal
        </button>
      )}
    </div>
  );
};

const HoverRow: React.FC = () => {
  const enabled = useStore((s) => s.hoverPointingEnabled);
  const setEnabled = useStore((s) => s.setHoverPointingEnabled);
  return (
    <div className="flex items-center gap-1">
      <MousePointer size={14} className={enabled ? 'text-emerald-500' : 'text-gray-400'} />
      <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 mr-1">Hover</span>
      <button
        onClick={() => setEnabled(!enabled)}
        title={enabled ? 'Disable hover-to-point' : 'Auto-engage when you dwell on a part'}
        className={clsx(
          'text-[9px] font-bold uppercase px-2 py-0.5 rounded transition-all',
          enabled ? 'bg-emerald-600 text-white' : 'text-gray-500 hover:text-gray-800'
        )}
      >
        {enabled ? 'On' : 'Off'}
      </button>
    </div>
  );
};

const PointerMenu: React.FC<{
  onOpenExplainer: () => void;
  /**
   * False when the top bar has run out of room and is shedding labels — the icon and
   * the `title` below stay, so the button is still findable and still says what it is
   * on a hover. See TOP_BAR_DROP_ORDER in components/UI/room/TopBar.tsx.
   */
  showLabel?: boolean;
}> = ({ onOpenExplainer, showLabel = true }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useFingerPointerStore((s) => s.mode);
  const hoverEnabled = useStore((s) => s.hoverPointingEnabled);
  const anyOn = mode === 'active' || hoverEnabled;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Pointer tools: finger pointing and hover dwell"
        aria-expanded={open}
        className={clsx(
          'relative h-9 px-2 flex items-center gap-1.5 rounded-sm border transition-all pointer-events-auto',
          open || anyOn
            ? 'bg-black text-white border-black'
            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:text-black'
        )}
      >
        <MousePointer size={14} />
        {showLabel && <span className="text-[10px] font-bold uppercase tracking-wide">Pointer</span>}
        <ChevronDown size={12} className={clsx('transition-transform', open && 'rotate-180')} />
        {anyOn && (
          <span
            className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 border border-white"
            title="A pointer tool is on"
          />
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-2 w-56 bg-white rounded-lg border border-gray-200 shadow-xl p-2 flex flex-col gap-1.5 pointer-events-auto z-[60]">
          <div className="text-[9px] font-mono uppercase tracking-widest text-gray-400 px-0.5">
            Deictic Features
          </div>
          <FingerRow />
          <div className="w-full h-px bg-gray-100" />
          <HoverRow />
          <button
            onClick={() => {
              setOpen(false);
              onOpenExplainer();
            }}
            className="mt-0.5 text-[10px] font-mono uppercase tracking-wide text-gray-400 hover:text-black transition-colors text-left px-0.5"
          >
            What are these?
          </button>
        </div>
      )}
    </div>
  );
};

export default PointerMenu;
