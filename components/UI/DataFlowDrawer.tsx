
import React, { useState } from 'react';
import { clsx } from 'clsx';
import { 
    Mic, MousePointer2, Eye, Box, Cpu,
    FileText, GitCommitHorizontal, LayoutDashboard, ArrowRight,
    X, Activity, UserCheck, ClipboardCheck, BrainCircuit, ScanLine
} from 'lucide-react';

interface DataFlowDrawerProps {
    isOpen: boolean;
    onClose: () => void;
}

// Tooltip Spec Data
const NODE_SPECS: Record<string, { title: string, specs: string[] }> = {
    'SPEECH': { title: "Audio Stream", specs: ["Format: 16kHz PCM", "VAD: Silero", "ASR: Whisper-tiny"] },
    'POINT': { title: "Pointer Events", specs: ["Raycast: Three.js", "Freq: 60Hz", "Target: Mesh ID"] },
    'GAZE': { title: "Attention Ray", specs: ["Vector: Forward Z", "Dwell: >300ms", "Heatmap: Additive"] },
    'CONTEXT': { title: "Active Object", specs: ["Tree Node: ID", "Metadata: Material", "State: Visible"] },
    
    'CAPTURE': { title: "Pattern Extraction", specs: ["Engine: Local Rules", "Method: Semantic Match", "Output: JSON"] },
    'CLASSIFY': { title: "Card Logic", specs: ["Intent: Trigger Words", "Sentiment: Polarity", "Priority: Heuristic"] },
    
    'LIVE_OVER': { title: "Live Oversight", specs: ["UI: Conversation Panel", "Action: Edit/Reject", "Latency: <500ms"] },
    
    'THREADING': { title: "Context Engine", specs: ["Graph: Temporal DAG", "Link: Component ID", "Heuristic: Causal"] },
    
    'FINAL_OVER': { title: "Session Review", specs: ["UI: Summary Board", "View: Kanban/Flow", "Action: Reassign/Approve"] },
    
    'CARDS': { title: "Insight Card", specs: ["Schema: v2.1", "Persist: Store", "Export: PDF/JSON"] },
    'FLOWS': { title: "Rationale Flow", specs: ["Format: GraphJSON", "Nodes: Trigger/Decide"] },
    'BOARD': { title: "Summary Report", specs: ["Format: PDF/HTML", "Stats: Aggregated"] },
};

// Reusable Node Component with Tooltip
const Node: React.FC<{ 
    id: string,
    icon: any, 
    label: string, 
    sub?: string, 
    color?: string,
    className?: string,
    onHover: (id: string | null) => void
}> = ({ id, icon: Icon, label, sub, color = "text-gray-600 border-gray-300", className, onHover }) => (
    <div 
        onMouseEnter={() => onHover(id)}
        onMouseLeave={() => onHover(null)}
        className={clsx(
            "flex flex-col items-center justify-center p-3 rounded-sm border bg-white shadow-sm relative z-10 min-w-[100px] transition-transform hover:scale-105 hover:shadow-md cursor-help pointer-events-auto",
            color,
            className
        )}
    >
        <Icon size={16} className="mb-1 opacity-80" />
        <div className="text-[9px] font-bold uppercase tracking-wider text-center">{label}</div>
        {sub && <div className="text-[8px] font-mono text-gray-400 mt-0.5 text-center">{sub}</div>}
    </div>
);

// Animated Connector Line
const Connector: React.FC<{ length?: string, vertical?: boolean, label?: string, dashed?: boolean }> = ({ length = "w-12", vertical = false, label, dashed }) => (
    <div className={clsx(
        "flex items-center justify-center relative shrink-0",
        vertical ? "flex-col h-12 w-px" : "flex-row h-px " + length
    )}>
        <div className={clsx(
            "bg-gray-300 relative overflow-visible",
            vertical ? "w-px h-full" : "h-px w-full",
            dashed && "opacity-50"
        )} style={{ borderStyle: dashed ? 'dashed' : 'solid' }}>
            <div className={clsx(
                "absolute bg-black rounded-full w-1.5 h-1.5 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
                vertical ? "animate-[flow-vert_2s_infinite]" : "animate-[flow-horz_2s_infinite]"
            )}></div>
        </div>
        {label && (
            <div className="absolute -top-4 text-[8px] font-mono text-gray-400 bg-white/50 px-1 backdrop-blur-sm whitespace-nowrap">
                {label}
            </div>
        )}
    </div>
);

const DataFlowDrawer: React.FC<DataFlowDrawerProps> = ({ isOpen, onClose }) => {
    const [hoveredNode, setHoveredNode] = useState<string | null>(null);

    // Get specs for hovered node
    const activeSpec = hoveredNode ? NODE_SPECS[hoveredNode] : null;

    return (
        <>
            {/* Backdrop click to close */}
            {isOpen && <div className="fixed inset-0 z-[110] bg-black/10 backdrop-blur-[1px]" onClick={onClose}></div>}
            
            {/* Drawer Container */}
            <div 
                className={clsx(
                    "fixed bottom-0 left-0 right-0 h-[420px] z-[120] flex flex-col shadow-[0_-10px_40px_rgba(0,0,0,0.1)] transition-transform duration-500 cubic-bezier(0.22, 1, 0.36, 1) pointer-events-auto",
                    isOpen ? "translate-y-0" : "translate-y-[110%]"
                )}
            >
                {/* TOOLTIP POPUP */}
                {activeSpec && (
                    <div className="absolute -top-24 left-1/2 -translate-x-1/2 bg-black/90 backdrop-blur text-white p-3 rounded-lg shadow-xl border border-gray-700 w-64 animate-in fade-in slide-in-from-bottom-2 z-[130]">
                        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">{activeSpec.title}</div>
                        <div className="flex flex-col gap-1">
                            {activeSpec.specs.map((spec, i) => (
                                <div key={i} className="text-xs font-mono text-emerald-400 flex items-center gap-2">
                                    <div className="w-1 h-1 bg-white rounded-full"></div> {spec}
                                </div>
                            ))}
                        </div>
                        {/* Little triangle arrow */}
                        <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-black/90 rotate-45 border-r border-b border-gray-700"></div>
                    </div>
                )}

                {/* Panel Background */}
                <div className="absolute inset-0 bg-[#F2F2F2]/98 backdrop-blur-xl border-t border-gray-300 rounded-t-xl shadow-2xl"></div>
                
                {/* Header Content */}
                <div className="relative z-10 flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white/50 rounded-t-xl shrink-0">
                    <div className="flex items-center gap-3">
                        <Activity className="text-emerald-500" size={16} />
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-600">System Data Architecture</span>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="text-[9px] font-mono text-gray-400 hidden md:block">DEBUG_VIEW_MODE // V.2.2.0</div>
                        <button 
                            onClick={onClose}
                            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-black/10 text-gray-500 hover:text-black transition-colors pointer-events-auto"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Diagram Canvas */}
                <div className="relative z-10 flex-1 overflow-x-auto overflow-y-hidden flex items-center p-8 custom-scrollbar">
                    
                    <div className="flex items-center gap-0 min-w-max mx-auto">
                        
                        {/* 1. INPUTS */}
                        <div className="flex flex-col gap-4 shrink-0">
                            <div className="flex flex-col gap-2 p-3 border border-dashed border-gray-300 rounded-lg bg-gray-50/50">
                                <div className="text-[9px] font-mono text-gray-400 uppercase mb-1 text-center">Raw Inputs</div>
                                <div className="grid grid-cols-2 gap-2">
                                    <Node id="SPEECH" icon={Mic} label="Speech" sub="Audio" onHover={setHoveredNode} />
                                    <Node id="POINT" icon={MousePointer2} label="Point" sub="Vector3" onHover={setHoveredNode} />
                                    <Node id="GAZE" icon={Eye} label="Gaze" sub="Ray" onHover={setHoveredNode} />
                                    <Node id="CONTEXT" icon={Box} label="Context" sub="Tree ID" onHover={setHoveredNode} />
                                </div>
                            </div>
                        </div>

                        <Connector length="w-12" label="Events" />

                        {/* 2. AI EXTRACTION LAYER */}
                        <div className="flex flex-col items-center shrink-0">
                            <div className="p-3 bg-white border-2 border-gray-800 shadow-sm rounded-lg relative">
                                <div className="absolute -top-2.5 left-4 bg-gray-800 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
                                    Extraction Layer
                                </div>
                                <div className="flex items-center gap-3">
                                    <Node id="CAPTURE" icon={Cpu} label="Capture" sub="LLM" color="border-gray-200 bg-gray-50" className="w-20" onHover={setHoveredNode} />
                                    <ArrowRight size={12} className="text-gray-300" />
                                    <Node id="CLASSIFY" icon={ScanLine} label="Classify" sub="Logic" color="border-gray-200 bg-gray-50" className="w-20" onHover={setHoveredNode} />
                                </div>
                            </div>
                        </div>

                        <Connector length="w-12" label="Drafts" dashed />

                        {/* 3. LIVE OVERSIGHT */}
                        <div className="flex flex-col items-center gap-2 shrink-0">
                            <Node 
                                id="LIVE_OVER"
                                icon={UserCheck} 
                                label="Live Oversight" 
                                sub="Panel UI" 
                                color="border-dashed border-blue-400 bg-blue-50/50" 
                                className="w-24"
                                onHover={setHoveredNode}
                            />
                        </div>

                        <Connector length="w-12" label="Validated" />

                        {/* 4. AI SYNTHESIS LAYER */}
                        <div className="flex flex-col items-center shrink-0">
                            <div className="p-3 bg-white border-2 border-gray-800 shadow-sm rounded-lg relative">
                                <div className="absolute -top-2.5 left-4 bg-gray-800 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
                                    Synthesis Layer
                                </div>
                                <div className="flex items-center gap-3">
                                     <Node id="THREADING" icon={BrainCircuit} label="Context Engine" sub="Threading" color="border-gray-200 bg-gray-50" className="w-28 h-20" onHover={setHoveredNode} />
                                </div>
                            </div>
                        </div>

                        <Connector length="w-12" label="Flows" dashed />

                        {/* 5. FINAL REVIEW */}
                        <div className="flex flex-col items-center gap-2 shrink-0">
                            <Node 
                                id="FINAL_OVER"
                                icon={ClipboardCheck} 
                                label="Final Review" 
                                sub="Board UI" 
                                color="border-dashed border-emerald-400 bg-emerald-50/50" 
                                className="w-24"
                                onHover={setHoveredNode}
                            />
                        </div>

                        <Connector length="w-12" label="Assets" />

                        {/* 6. STRUCTURED OUTPUTS */}
                        <div className="flex flex-col gap-2 shrink-0">
                             <div className="flex flex-col gap-2 p-3 border border-gray-200 rounded-lg bg-white shadow-sm">
                                <div className="text-[9px] font-mono text-gray-400 uppercase mb-1 text-center">Artifacts</div>
                                <div className="grid grid-cols-1 gap-2">
                                    <Node id="CARDS" icon={FileText} label="Cards" className="w-20 py-1.5" onHover={setHoveredNode} />
                                    <Node id="FLOWS" icon={GitCommitHorizontal} label="Flows" className="w-20 py-1.5" onHover={setHoveredNode} />
                                    <Node id="BOARD" icon={LayoutDashboard} label="Report" className="w-20 py-1.5" onHover={setHoveredNode} />
                                </div>
                            </div>
                        </div>

                    </div>

                </div>

                <style>{`
                    @keyframes flow-horz {
                        0% { transform: translate(-20px, -50%); opacity: 0; }
                        50% { opacity: 1; }
                        100% { transform: translate(40px, -50%); opacity: 0; }
                    }
                    @keyframes flow-vert {
                        0% { transform: translate(-50%, -20px); opacity: 0; }
                        50% { opacity: 1; }
                        100% { transform: translate(-50%, 40px); opacity: 0; }
                    }
                `}</style>
            </div>
        </>
    );
};

export default DataFlowDrawer;
