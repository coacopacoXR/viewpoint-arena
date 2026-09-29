
import React, { useState } from 'react';
import { 
    X, SplitSquareHorizontal, Users, Sparkles, Activity,
    ScanEye, MousePointer2
} from 'lucide-react';
import { clsx } from 'clsx';
import { ViewMode } from '../../types';

interface ConfigDetails {
    id: ViewMode;
    label: string;
    icon: any;
    shortDesc: string;
    fullDesc: string;
    techSpecs: string[];
    illustration: React.ReactNode;
}

const CONFIGS: ConfigDetails[] = [
    {
        id: ViewMode.FREE,
        label: "Free View",
        icon: Activity,
        shortDesc: "Standard Orbital Control",
        fullDesc: "The default navigation mode allowing unrestricted 6-DOF inspection of the model. The user maintains complete agency over the camera position using standard orbit, pan, and zoom controls. This mode is best for individual exploration and detail inspection independent of the group context.",
        techSpecs: ["Control: 3-Button Mouse / Touch", "Focus: User-defined", "Latency: Real-time"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                <div className="w-24 h-24 border-2 border-gray-800 rounded-full flex items-center justify-center animate-[spin_10s_linear_infinite]">
                    <div className="w-2 h-2 bg-black rounded-full absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1"></div>
                    <div className="w-2 h-2 bg-black rounded-full absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1"></div>
                </div>
                <MousePointer2 size={32} className="absolute text-gray-400" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-gray-200 rounded-sm"></div>
            </div>
        )
    },
    {
        id: ViewMode.SPLIT_SCREEN,
        label: "Hybrid Split",
        icon: SplitSquareHorizontal,
        shortDesc: "Dual Context / Detail View",
        fullDesc: "A specialized viewport configuration that renders two simultaneous perspectives. The left pane maintains your personal context (Free View), while the right pane 'possesses' a selected agent's viewpoint. This solves the 'Show me what you mean' problem by allowing you to verify visual claims without losing your own orientation.",
        techSpecs: ["Render Pass: Double Scissor", "Sync: Local + Remote", "Context: Preserved"],
        illustration: (
            <div className="w-full h-full flex gap-2 p-8">
                <div className="flex-1 border-2 border-dashed border-gray-300 rounded bg-gray-50 flex items-center justify-center">
                    <span className="font-mono text-[10px] text-gray-400">USER</span>
                </div>
                <div className="w-px bg-gray-800"></div>
                <div className="flex-1 border-2 border-gray-800 rounded bg-white flex items-center justify-center relative overflow-hidden">
                    <span className="font-mono text-[10px] text-gray-800 font-bold">AGENT POV</span>
                    <ScanEye className="absolute bottom-2 right-2 text-gray-200" size={48} />
                </div>
            </div>
        )
    },
    {
        id: ViewMode.AI_GUIDED,
        label: "AI Guided Focus",
        icon: Sparkles,
        shortDesc: "Algorithmic Gaze Convergence",
        fullDesc: "An autonomous camera controller that calculates the 'Center of Attention' based on the weighted gaze vectors of all agents. The camera smoothly drifts to frame the area of highest collective interest. User input temporarily overrides the AI, which gently resumes control after inactivity.",
        techSpecs: ["Algo: Weighted Centroid", "Smoothing: 0.5s dampening", "Input: Override enabled"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                {/* Agent Eyes */}
                <div className="absolute top-1/4 left-1/4 w-4 h-4 bg-gray-300 rounded-full flex items-center justify-center"><div className="w-1 h-1 bg-black rounded-full"></div></div>
                <div className="absolute top-1/3 right-1/4 w-4 h-4 bg-gray-300 rounded-full flex items-center justify-center"><div className="w-1 h-1 bg-black rounded-full"></div></div>
                <div className="absolute bottom-1/3 left-1/3 w-4 h-4 bg-gray-300 rounded-full flex items-center justify-center"><div className="w-1 h-1 bg-black rounded-full"></div></div>
                
                {/* Convergence Lines */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none">
                    <line x1="25%" y1="25%" x2="50%" y2="50%" stroke="black" strokeWidth="1" strokeDasharray="4 4" className="opacity-30" />
                    <line x1="75%" y1="33%" x2="50%" y2="50%" stroke="black" strokeWidth="1" strokeDasharray="4 4" className="opacity-30" />
                    <line x1="33%" y1="66%" x2="50%" y2="50%" stroke="black" strokeWidth="1" strokeDasharray="4 4" className="opacity-30" />
                </svg>

                {/* Focus Target */}
                <div className="w-12 h-12 border-2 border-purple-500 rounded-full animate-pulse flex items-center justify-center">
                    <div className="w-1 h-1 bg-purple-500 rounded-full"></div>
                </div>
            </div>
        )
    },
    {
        id: ViewMode.FOLLOW_PRESENTER, // Reusing ID for Sync Mode concept
        label: "Sync / Leader",
        icon: Users,
        shortDesc: "Formation Following",
        fullDesc: "Enables a 'Presenter Mode' where one actor (User or Agent) dictates the global viewpoint. All other agents break their autonomous behavior and physically move into a formation relative to the leader, aligning their gaze to match the leader's focus vector.",
        techSpecs: ["Topology: Master/Slave", "Formation: Wedge", "Latency: Synchronized"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                {/* Leader */}
                <div className="w-0 h-0 border-l-[10px] border-l-transparent border-r-[10px] border-r-transparent border-b-[20px] border-b-black absolute top-1/3 left-1/2 -translate-x-1/2"></div>
                
                {/* Followers */}
                <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[12px] border-b-gray-400 absolute bottom-1/3 left-1/3 -translate-x-1/2 opacity-50"></div>
                <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[12px] border-b-gray-400 absolute bottom-1/3 right-1/3 translate-x-1/2 opacity-50"></div>
                
                {/* Connection */}
                <div className="absolute top-1/2 w-24 h-px bg-gray-200"></div>
            </div>
        )
    },
];

const ViewConfigExplainer: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [activeId, setActiveId] = useState<ViewMode>(ViewMode.SPLIT_SCREEN);
    const activeConfig = CONFIGS.find(c => c.id === activeId) || CONFIGS[0];

    return (
        <div className="fixed inset-0 z-[100] bg-[#F2F2F2]/90 backdrop-blur-xl flex items-center justify-center p-8 animate-in fade-in duration-300 pointer-events-auto">
            
            {/* Close Button */}
            <button 
                onClick={onClose}
                className="absolute top-8 right-8 p-2 rounded-full border border-gray-300 text-gray-500 hover:bg-white hover:text-black transition-colors"
            >
                <X size={24} />
            </button>

            <div className="w-full max-w-6xl h-[80vh] flex shadow-2xl rounded-2xl overflow-hidden border border-gray-200 bg-white">
                
                {/* LEFT: Navigation List */}
                <div className="w-1/3 bg-gray-50 border-r border-gray-200 flex flex-col">
                    <div className="p-8 border-b border-gray-200">
                        <h2 className="text-2xl font-bold tracking-tight text-gray-900 mb-2">View Configuration</h2>
                        <p className="text-sm text-gray-500 font-mono">System Manual v2.0</p>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                        {CONFIGS.map(config => {
                            const Icon = config.icon;
                            return (
                                <button
                                    key={config.id}
                                    onClick={() => setActiveId(config.id)}
                                    className={clsx(
                                        "flex items-center gap-4 p-4 rounded-lg text-left transition-all duration-200 group",
                                        activeId === config.id 
                                            ? "bg-black text-white shadow-lg scale-[1.02]" 
                                            : "hover:bg-gray-200 text-gray-600"
                                    )}
                                >
                                    <Icon size={20} className={activeId === config.id ? "text-emerald-400" : "text-gray-400 group-hover:text-gray-600"} />
                                    <div>
                                        <div className="font-bold text-sm uppercase tracking-wide">{config.label}</div>
                                        <div className={clsx("text-xs", activeId === config.id ? "text-gray-400" : "text-gray-400")}>{config.shortDesc}</div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* RIGHT: Detail View */}
                <div className="flex-1 flex flex-col relative bg-white">
                    {/* Background Grid */}
                    <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none"></div>
                    <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>

                    {/* Content */}
                    <div className="p-12 flex flex-col h-full relative z-10">
                        
                        {/* Header */}
                        <div className="flex items-start justify-between mb-12">
                            <div>
                                <div className="text-xs font-mono font-bold text-emerald-600 mb-2 uppercase tracking-widest border border-emerald-100 bg-emerald-50 px-2 py-1 rounded w-fit">
                                    Active Configuration
                                </div>
                                <h1 className="text-5xl font-bold text-gray-900 tracking-tight mb-4">{activeConfig.label}</h1>
                                <p className="text-xl text-gray-500 font-light max-w-xl leading-relaxed">
                                    {activeConfig.fullDesc}
                                </p>
                            </div>
                            
                            {/* Tech Specs Box */}
                            <div className="bg-gray-50 border border-gray-200 p-4 rounded-lg w-64 shrink-0">
                                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-200 pb-2">Technical Specs</div>
                                <div className="flex flex-col gap-2">
                                    {activeConfig.techSpecs.map((spec, i) => (
                                        <div key={i} className="text-xs font-mono text-gray-600 flex items-center gap-2">
                                            <div className="w-1 h-1 bg-gray-400 rounded-full"></div>
                                            {spec}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Visualization Area */}
                        <div className="flex-1 border-2 border-gray-100 rounded-xl bg-gray-50/50 relative overflow-hidden flex items-center justify-center p-8 group">
                            <div className="absolute top-4 left-4 text-[10px] font-mono text-gray-400 uppercase">Schematic Representation</div>
                            
                            {/* The Schematic Illustration */}
                            <div className="w-full max-w-lg aspect-video bg-white shadow-xl rounded-lg border border-gray-200 p-2 transition-transform duration-700 group-hover:scale-105">
                                {activeConfig.illustration}
                            </div>
                        </div>

                    </div>
                </div>

            </div>
        </div>
    );
};

export default ViewConfigExplainer;
