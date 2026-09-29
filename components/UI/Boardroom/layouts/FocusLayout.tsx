import React from 'react';
import { Monitor } from 'lucide-react';
import { AgentState, PointOfInterest } from '../../../../types';
import ParticipantTile from '../ParticipantTile';

interface FocusLayoutProps {
  agents: AgentState[];
  speakingAgentId: string | null;
  pinnedAgentId: string | null;
  pois: PointOfInterest[];
  onPin: (id: string | null) => void;
  presenterLabel: string | null;
  interactionEnabled: boolean;
  screenSharing: boolean;
  userSelfTile?: React.ReactNode;
  humanTiles?: React.ReactNode;
}

const FocusLayout: React.FC<FocusLayoutProps> = ({
  agents, speakingAgentId, pinnedAgentId, pois, onPin,
  presenterLabel, interactionEnabled, screenSharing, userSelfTile, humanTiles,
}) => {
  return (
    <div className="flex flex-col w-full h-full">
      {/* Shared screen — transparent unless screen sharing */}
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

      {/* Participants strip — fixed 16:9 tiles */}
      <div className="bg-[#111] border-t border-white/10 px-4 py-2.5 flex items-center gap-3 overflow-x-auto shrink-0 pointer-events-auto">
        {agents.map(agent => {
          const currentPoi = pois.find(p => p.id === agent.currentPoiId) || null;
          return (
            <ParticipantTile
              key={agent.id}
              agent={agent}
              isSpeaking={speakingAgentId === agent.id}
              isPinned={pinnedAgentId === agent.id}
              currentPoi={currentPoi}
              onPin={() => onPin(pinnedAgentId === agent.id ? null : agent.id)}
              size="md"
            />
          );
        })}
        {/* Human participant tiles (WebRTC) */}
        {humanTiles}
        {/* Self tile (legacy fallback) */}
        {!humanTiles && userSelfTile}
        {agents.length === 0 && !humanTiles && !userSelfTile && (
          <div className="text-white/30 text-xs font-mono">No other participants yet.</div>
        )}
      </div>
    </div>
  );
};

export default FocusLayout;
