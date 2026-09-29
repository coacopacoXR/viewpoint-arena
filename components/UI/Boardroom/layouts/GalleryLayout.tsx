import React, { useState, useCallback, useRef, useLayoutEffect } from 'react';
import { Monitor, LayoutGrid } from 'lucide-react';
import { AgentState, PointOfInterest } from '../../../../types';
import ParticipantTile from '../ParticipantTile';

interface GalleryLayoutProps {
  agents: AgentState[];
  speakingAgentId: string | null;
  pinnedAgentId: string | null;
  pois: PointOfInterest[];
  onPin: (id: string | null) => void;
  presenterLabel: string | null;
  interactionEnabled: boolean;
  screenSharing: boolean;
  onPanelWidthChange?: (w: number) => void;
  onWebcamOnlyChange?: (value: boolean) => void;
  userSelfTile?: React.ReactNode;
  humanTiles?: React.ReactNode;
  participantCount?: number;
}

const MIN_PANEL = 260;
const PANEL_PADDING = 12; // p-3 on each side
const CELL_GAP = 8;       // gap-2

const GalleryLayout: React.FC<GalleryLayoutProps> = ({
  agents, speakingAgentId, pinnedAgentId, pois, onPin,
  presenterLabel, interactionEnabled, screenSharing,
  onPanelWidthChange, onWebcamOnlyChange, userSelfTile, humanTiles,
  participantCount,
}) => {
  const [panelWidth, setPanelWidth] = useState(320);
  const [isWebcamOnly, setIsWebcamOnly] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const panelWidthRef = useRef(320);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // Measure container width for webcam-only threshold
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const updatePanelWidth = useCallback((w: number) => {
    panelWidthRef.current = w;
    setPanelWidth(w);
    onPanelWidthChange?.(w);
  }, [onPanelWidthChange]);

  const setWebcamOnly = useCallback((val: boolean) => {
    setIsWebcamOnly(val);
    onWebcamOnlyChange?.(val);
  }, [onWebcamOnlyChange]);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = ev.clientX - dragStartX.current;
      const newWidth = Math.max(MIN_PANEL, dragStartWidth.current + delta);
      updatePanelWidth(newWidth);
    };

    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Snap to webcam-only if dragged past 75% of container
      if (containerWidth > 0 && panelWidthRef.current > containerWidth * 0.75) {
        setWebcamOnly(true);
        updatePanelWidth(containerWidth);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [containerWidth, updatePanelWidth, setWebcamOnly]);

  const exitWebcamOnly = useCallback(() => {
    setWebcamOnly(false);
    updatePanelWidth(320);
  }, [setWebcamOnly, updatePanelWidth]);

  // --- Tile geometry ---
  const cols = 2; // always 2 columns in side panel
  const cellWidth = Math.max(80, Math.floor((panelWidth - PANEL_PADDING * 2 - CELL_GAP * (cols - 1)) / cols));
  const cellHeight = Math.floor(cellWidth * 9 / 16);

  // Webcam-only grid geometry — clamp to at least 1 column so an empty agent
  // list doesn't produce repeat(0, 1fr) and a division by zero in wcCellWidth.
  const wcCols = Math.max(1, agents.length <= 2 ? agents.length : 2);
  const wcCellWidth = containerWidth > 0
    ? Math.floor((containerWidth - PANEL_PADDING * 2 - CELL_GAP * (wcCols - 1)) / wcCols)
    : 480;
  const wcCellHeight = Math.floor(wcCellWidth * 9 / 16);

  // Approaching threshold hint
  const approachingThreshold = containerWidth > 0 && panelWidth > containerWidth * 0.55 && !isWebcamOnly;

  // --- WEBCAM-ONLY MODE ---
  if (isWebcamOnly) {
    return (
      <div ref={containerRef} className="w-full h-full bg-[#0d0d0d] flex flex-col">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2 text-white/50 text-[10px] font-mono uppercase tracking-wider">
            <LayoutGrid size={12} />
            Webcam View
            {(participantCount ?? agents.length) > 0 && (
              <span className="text-[8px] text-white/20">— {participantCount ?? agents.length} participants</span>
            )}
          </div>
          <button
            onClick={exitWebcamOnly}
            className="px-3 py-1 rounded text-[9px] font-bold bg-white/10 text-white/60 border border-white/10 hover:bg-white/20 hover:text-white transition-all pointer-events-auto flex items-center gap-1.5"
          >
            <Monitor size={10} />
            Show 3D View
          </button>
        </div>

        {/* Full-screen tile grid */}
        <div className="flex-1 flex items-center justify-center p-4 pointer-events-auto">
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${wcCols}, 1fr)`,
              gridAutoRows: `${wcCellHeight}px`,
              width: '100%',
              maxWidth: wcCols * wcCellWidth + (wcCols - 1) * CELL_GAP,
            }}
          >
            {agents.map(agent => {
              const currentPoi = pois.find(p => p.id === agent.currentPoiId) || null;
              return (
                <div key={agent.id} className="relative" style={{ height: wcCellHeight }}>
                  <div className="absolute inset-0">
                    <ParticipantTile
                      agent={agent}
                      isSpeaking={speakingAgentId === agent.id}
                      isPinned={pinnedAgentId === agent.id}
                      currentPoi={currentPoi}
                      onPin={() => onPin(pinnedAgentId === agent.id ? null : agent.id)}
                      fill
                    />
                  </div>
                </div>
              );
            })}
            {/* Human participant tiles (WebRTC) — or legacy self tile */}
            {humanTiles ? (
              humanTiles
            ) : userSelfTile && (
              <div className="relative" style={{ height: wcCellHeight }}>
                <div className="absolute inset-0">{userSelfTile}</div>
              </div>
            )}
            {agents.length === 0 && !humanTiles && (
              <div className="col-span-full flex items-center justify-center text-white/30 text-xs font-mono">
                No other participants yet.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- GALLERY MODE ---
  return (
    <div ref={containerRef} className="flex w-full h-full">
      {/* Left: Participant panel */}
      <div
        className="bg-[#111] border-r border-white/5 flex flex-col p-3 shrink-0 overflow-y-auto pointer-events-auto"
        style={{ width: panelWidth }}
      >
        <div className="text-[9px] text-white/25 font-mono uppercase tracking-widest mb-2 shrink-0">
          {participantCount !== undefined
            ? `Participants (${participantCount})`
            : `Participants (${agents.length})`}
        </div>

        {/* 16:9 tile grid */}
        <div
          className="grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridAutoRows: `${cellHeight}px`,
          }}
        >
          {agents.map(agent => {
            const currentPoi = pois.find(p => p.id === agent.currentPoiId) || null;
            return (
              <div key={agent.id} className="relative" style={{ height: cellHeight }}>
                <div className="absolute inset-0">
                  <ParticipantTile
                    agent={agent}
                    isSpeaking={speakingAgentId === agent.id}
                    isPinned={pinnedAgentId === agent.id}
                    currentPoi={currentPoi}
                    onPin={() => onPin(pinnedAgentId === agent.id ? null : agent.id)}
                    fill
                  />
                </div>
              </div>
            );
          })}
          {/* Human participant tiles (WebRTC) — or legacy self tile */}
          {humanTiles ? (
            humanTiles
          ) : userSelfTile && (
            <div className="relative" style={{ height: cellHeight }}>
              <div className="absolute inset-0">{userSelfTile}</div>
            </div>
          )}
          {agents.length === 0 && !humanTiles && (
            <div className="col-span-full flex items-center justify-center text-white/30 text-xs font-mono py-4">
              No other participants yet.
            </div>
          )}
        </div>

        {/* Webcam-only hint when approaching threshold */}
        {approachingThreshold && (
          <div className="mt-auto pt-3 text-center text-[8px] text-white/30 font-mono animate-pulse">
            drag further → webcam only
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div
        className="w-1 bg-white/5 hover:bg-white/25 active:bg-white/40 cursor-col-resize shrink-0 transition-colors pointer-events-auto"
        onMouseDown={onDragStart}
      />

      {/* Right: Shared screen — transparent area */}
      <div className="flex-1 relative">
        {/* Screen sharing overlay */}
        {screenSharing && (
          <div className="absolute inset-0 bg-[#0d0d0d] flex flex-col items-center justify-center z-10">
            <div className="w-24 h-24 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mb-4">
              <Monitor size={40} className="text-white/30" />
            </div>
            <div className="text-white/60 text-sm font-bold">Screen is being shared</div>
            <div className="text-white/30 text-[10px] font-mono mt-1">Your screen is visible to all participants</div>
          </div>
        )}

        {!screenSharing && presenterLabel && (
          <div className="absolute top-3 left-3 z-10 bg-black/50 backdrop-blur-sm text-white/70 text-[9px] font-mono px-2 py-1 rounded pointer-events-none">
            PRESENTING: {presenterLabel}
          </div>
        )}
        {!screenSharing && interactionEnabled && (
          <div className="absolute top-3 right-3 z-10 bg-green-500/20 border border-green-500/40 text-green-300 text-[9px] font-mono px-2 py-1 rounded pointer-events-none">
            INTERACTION ON
          </div>
        )}
      </div>
    </div>
  );
};

export default GalleryLayout;
