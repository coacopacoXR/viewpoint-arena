
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
    X, Cpu, Server, ShieldCheck, Terminal,
    Network, Database, Lock, HardDrive, Share2,
    AlertTriangle, Lightbulb, CheckCircle2, ScanLine
} from 'lucide-react';
import { clsx } from 'clsx';

// --- TYPE DEFINITIONS ---

interface ExplainerItem {
    id: string;
    label: string;
    icon: any;
    shortDesc: string;
    fullDesc: string;
    techSpecs: string[]; // Or "Trigger Logic" for functional items
    illustration: React.ReactNode;
}

// --- 1. FUNCTIONAL CONFIGS (Practical Logic) ---

const FUNCTIONAL_CONFIGS: ExplainerItem[] = [
    {
        id: 'RISK',
        label: "Risk Detection",
        icon: AlertTriangle,
        shortDesc: "Failure & Safety Patterns",
        fullDesc: "The model scans the transcript for linguistic patterns indicating uncertainty, potential failure, or regulatory non-compliance. It correlates negative sentiment adjectives (e.g., 'weak', 'interference', 'dangerous') with specific 3D component references to flag high-priority issues.",
        techSpecs: ["Triggers: 'fail', 'break', 'clash'", "Sentiment: Negative (< 0.4)", "Context: Geometry Intersection"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                 <div className="w-48 h-24 border-2 border-red-100 bg-red-50/50 rounded-lg flex items-center justify-center relative">
                    <div className="text-red-800 font-bold text-xs uppercase tracking-widest flex items-center gap-2">
                        <AlertTriangle size={14} /> Risk Detected
                    </div>
                    {/* Failure Path */}
                    <div className="absolute -bottom-4 left-8 w-px h-8 bg-red-300"></div>
                    <div className="absolute -bottom-4 left-8 w-32 h-px bg-red-300"></div>
                    <div className="absolute -bottom-8 right-8 text-[8px] text-red-400 font-mono">INTERFERENCE</div>
                 </div>
            </div>
        )
    },
    {
        id: 'RATIONALE',
        label: "Design Rationale",
        icon: Lightbulb,
        shortDesc: "Intent Extraction",
        fullDesc: "This classifier identifies the 'Why' behind a design choice. It listens for causal linking phrases (e.g., 'so that', 'in order to', 'because of') that connect a geometric feature to a functional outcome or constraint. This preserves institutional knowledge that is often lost in verbal meetings.",
        techSpecs: ["Triggers: 'because', 'intended to'", "Pattern: Feature -> Outcome", "Tagging: Design Driver"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                 <div className="flex items-center gap-4">
                     <div className="w-16 h-16 border border-gray-300 rounded flex items-center justify-center bg-white shadow-sm">
                        <span className="text-[8px] font-mono text-gray-400">FEATURE</span>
                     </div>
                     <div className="w-8 h-px bg-amber-400 relative">
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[8px] text-amber-600 font-bold">LINK</div>
                     </div>
                     <div className="w-16 h-16 border-2 border-amber-200 rounded flex items-center justify-center bg-amber-50 shadow-sm">
                        <Lightbulb size={20} className="text-amber-500" />
                     </div>
                 </div>
            </div>
        )
    },
    {
        id: 'ACTION',
        label: "Action Assignment",
        icon: CheckCircle2,
        shortDesc: "Commitment Tracking",
        fullDesc: "The system detects future-tense commitments and imperative statements. It analyzes sentence structure to extract the 'Task' (Verb Phrase), the 'Assignee' (Proper Noun/Pronoun), and the 'Deadline' (Time Phrase). If an assignee is ambiguous, it flags the card for human review.",
        techSpecs: ["Triggers: 'will verify', 'check'", "Extraction: Named Entity Rec.", "Output: Task Object"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                 <div className="w-full max-w-[200px] flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-[9px] text-gray-400 font-mono">
                        <div className="w-2 h-2 bg-blue-500 rounded-full"></div> NLP PARSE TREE
                    </div>
                    <div className="h-px w-full bg-gray-200"></div>
                    <div className="flex justify-between">
                        <div className="px-2 py-1 bg-gray-100 rounded text-[8px] text-gray-500">Subject</div>
                        <div className="px-2 py-1 bg-blue-100 text-blue-700 rounded text-[8px] font-bold">Verb (Task)</div>
                        <div className="px-2 py-1 bg-gray-100 rounded text-[8px] text-gray-500">Object</div>
                    </div>
                 </div>
            </div>
        )
    }
];

// --- 2. TECHNICAL CONFIGS (System Specs) ---

const TECHNICAL_CONFIGS: ExplainerItem[] = [
    {
        id: 'ARCHITECTURE',
        label: "Architecture",
        icon: Network,
        shortDesc: "RAG + Vector Pipeline",
        fullDesc: "The system utilizes a Retrieval-Augmented Generation (RAG) pipeline to ground AI responses in 3D spatial context. Raw audio/text streams are chunked and embedded using 'text-embedding-004'. A local vector database (Chroma/Pinecone) indexes these embeddings alongside spatial coordinates.",
        techSpecs: ["Embeddings: 768-dim", "Vector DB: HNSW Index", "Context Window: 128k"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                {/* Pipeline Flow */}
                <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-64 h-px bg-gray-200"></div>
                </div>
                <div className="w-12 h-12 bg-white border border-gray-200 rounded flex items-center justify-center absolute left-1/4 -translate-x-1/2 shadow-sm z-10">
                    <span className="text-[8px] font-mono text-gray-500">INPUT</span>
                </div>
                <div className="w-16 h-16 bg-blue-50 border-2 border-blue-100 rounded-lg flex flex-col items-center justify-center relative z-20 shadow-md">
                    <Database className="text-blue-500 mb-1" size={20} />
                    <span className="text-[8px] font-bold text-blue-700">VECTOR</span>
                </div>
                <div className="w-12 h-12 bg-purple-50 border border-purple-200 rounded flex items-center justify-center absolute right-1/4 translate-x-1/2 shadow-sm z-10">
                    <Cpu size={16} className="text-purple-500" />
                </div>
            </div>
        )
    },
    {
        id: 'MODELS',
        label: "Reasoning Engine",
        icon: Server,
        shortDesc: "Local-First Architecture",
        fullDesc: "The system uses a sophisticated local reasoning engine with rule-based extraction and pattern matching. No external API calls required. The engine analyzes conversation context, detects semantic patterns, and constructs decision trees using deterministic algorithms optimized for design review workflows.",
        techSpecs: ["Engine: Local Pattern Match", "Memory: Context Graph", "Output: Structured JSON"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                 <div className="w-20 h-20 bg-gray-900 rounded-xl flex items-center justify-center z-20 shadow-xl">
                    <Share2 className="text-emerald-400" size={32} />
                 </div>
                 <div className="absolute top-1/4 left-1/4 flex flex-col items-center">
                    <div className="w-10 h-10 bg-white border border-gray-200 rounded-full flex items-center justify-center shadow-sm mb-1"><span className="text-[8px] font-bold text-blue-600">RULES</span></div>
                 </div>
                 <div className="absolute bottom-1/4 right-1/4 flex flex-col items-center">
                    <div className="w-10 h-10 bg-white border border-gray-200 rounded-full flex items-center justify-center shadow-sm mt-1"><span className="text-[8px] font-bold text-orange-600">LOCAL</span></div>
                 </div>
            </div>
        )
    },
    {
        id: 'PRIVACY',
        label: "Data Privacy",
        icon: ShieldCheck,
        shortDesc: "Air-Gapped Execution",
        fullDesc: "Designed for high-security engineering environments. When configured in 'Local Mode', no data leaves the internal network. Weights are loaded into VRAM on the workstation, and vector storage is persisted on local NVMe drives. Enterprise-grade encryption (AES-256) is applied.",
        techSpecs: ["Network: Air-Gapped", "Storage: Local NVMe", "Encryption: AES-256"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                 <div className="w-48 h-32 border-2 border-gray-800 border-dashed rounded-lg flex items-center justify-center relative bg-gray-50/50">
                    <div className="absolute -top-3 left-4 bg-gray-800 text-white text-[8px] font-bold px-2 py-0.5 rounded">LOCALHOST</div>
                    <div className="flex gap-4">
                        <HardDrive size={24} className="text-gray-600" />
                        <Lock size={24} className="text-emerald-500" />
                    </div>
                 </div>
            </div>
        )
    },
    {
        id: 'DEPLOY',
        label: "Deployment",
        icon: Terminal,
        shortDesc: "Docker / Edge Inference",
        fullDesc: "Deployment via standard OCI containers. The entire stack (Frontend, Vector DB, Inference API) runs via 'docker-compose up'. Supports GPU passthrough (NVIDIA CUDA / Apple Metal) for hardware-accelerated local inference. Ideal for edge devices in factory settings.",
        techSpecs: ["Container: Docker", "Hardware: CUDA/Metal", "RAM Req: 16GB+"],
        illustration: (
            <div className="w-full h-full flex items-center justify-center relative">
                 <div className="flex flex-col gap-1 z-10">
                    <div className="w-32 h-8 bg-blue-50 border border-blue-200 rounded flex items-center px-3 shadow-sm">
                        <div className="w-2 h-2 bg-blue-400 rounded-full mr-2"></div>
                        <span className="text-[8px] font-mono text-blue-700">app-frontend</span>
                    </div>
                    <div className="w-32 h-8 bg-blue-50 border border-blue-200 rounded flex items-center px-3 shadow-sm">
                        <div className="w-2 h-2 bg-blue-400 rounded-full mr-2"></div>
                        <span className="text-[8px] font-mono text-blue-700">vector-db</span>
                    </div>
                 </div>
                 <div className="absolute bottom-12 w-40 h-2 bg-gray-200 rounded-full blur-sm"></div>
            </div>
        )
    }
];


const InsightExplainer: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState<'FUNCTIONAL' | 'TECHNICAL'>('FUNCTIONAL');
    const [activeId, setActiveId] = useState<string>('');

    // Ensure activeId is valid when switching tabs
    React.useEffect(() => {
        if (activeTab === 'FUNCTIONAL') setActiveId(FUNCTIONAL_CONFIGS[0].id);
        else setActiveId(TECHNICAL_CONFIGS[0].id);
    }, [activeTab]);

    const configs = activeTab === 'FUNCTIONAL' ? FUNCTIONAL_CONFIGS : TECHNICAL_CONFIGS;
    const activeConfig = configs.find(c => c.id === activeId) || configs[0];

    // Portal to <body> so the fullscreen overlay escapes any ancestor with
    // `transform` / `overflow` (which would otherwise clip a `position: fixed`
    // child — e.g., the conversation panel's containment).
    return createPortal(
        <div className="fixed inset-0 z-[100] bg-[#F2F2F2]/90 backdrop-blur-xl flex items-center justify-center p-8 animate-in fade-in duration-300 pointer-events-auto">

            <button
                onClick={onClose}
                className="absolute top-8 right-8 p-2 rounded-full border border-gray-300 text-gray-500 hover:bg-white hover:text-black transition-colors"
            >
                <X size={24} />
            </button>

            <div className="w-full max-w-5xl h-[70vh] flex shadow-2xl rounded-2xl overflow-hidden border border-gray-200 bg-white flex-col">
                
                {/* TOP TAB BAR */}
                <div className="flex border-b border-gray-200 bg-gray-50 shrink-0">
                    <button 
                        onClick={() => setActiveTab('FUNCTIONAL')}
                        className={clsx(
                            "flex-1 py-4 text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-colors",
                            activeTab === 'FUNCTIONAL' ? "bg-white text-black border-b-2 border-black" : "text-gray-400 hover:text-gray-600"
                        )}
                    >
                        <ScanLine size={16} /> Logic & Classification
                    </button>
                    <div className="w-px bg-gray-200"></div>
                    <button 
                        onClick={() => setActiveTab('TECHNICAL')}
                        className={clsx(
                            "flex-1 py-4 text-xs font-bold uppercase tracking-widest flex items-center justify-center gap-2 transition-colors",
                            activeTab === 'TECHNICAL' ? "bg-white text-black border-b-2 border-black" : "text-gray-400 hover:text-gray-600"
                        )}
                    >
                        <Server size={16} /> System Architecture
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* LEFT: Navigation List */}
                    <div className="w-1/3 bg-gray-50 border-r border-gray-200 flex flex-col">
                        <div className="p-6 border-b border-gray-200">
                            <h2 className="text-xl font-bold tracking-tight text-gray-900 mb-1">
                                {activeTab === 'FUNCTIONAL' ? 'Card Classification' : 'Technical Specs'}
                            </h2>
                            <p className="text-xs text-gray-500 font-mono">
                                {activeTab === 'FUNCTIONAL' ? 'Trigger Logic & Definitions' : 'Infrastructure & Deployment'}
                            </p>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
                            {configs.map(config => {
                                const Icon = config.icon;
                                const isActive = activeId === config.id;
                                return (
                                    <button
                                        key={config.id}
                                        onClick={() => setActiveId(config.id)}
                                        className={clsx(
                                            "flex items-center gap-4 p-4 rounded-lg text-left transition-all duration-200 border",
                                            isActive ? "bg-black text-white shadow-md scale-[1.02] border-black" : "hover:bg-gray-200 text-gray-600 border-transparent"
                                        )}
                                    >
                                        <Icon size={20} className={isActive ? "text-emerald-400" : "opacity-40"} />
                                        <div>
                                            <div className="font-bold text-sm uppercase tracking-wide">{config.label}</div>
                                            <div className={clsx("text-[10px]", isActive ? "text-gray-400" : "opacity-70")}>{config.shortDesc}</div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* RIGHT: Detail View */}
                    <div className="flex-1 flex flex-col relative bg-white">
                        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>

                        <div className="p-10 flex flex-col h-full relative z-10">
                            <div className="flex items-start justify-between mb-8">
                                <div>
                                    <div className="text-xs font-mono font-bold text-gray-400 mb-2 uppercase tracking-widest px-2 py-1 rounded w-fit border border-gray-100">
                                        {activeTab === 'FUNCTIONAL' ? 'Logic Module' : 'System Module'}
                                    </div>
                                    <h1 className="text-4xl font-bold text-gray-900 tracking-tight mb-4">{activeConfig.label}</h1>
                                    <p className="text-sm text-gray-500 font-light max-w-md leading-relaxed">
                                        {activeConfig.fullDesc}
                                    </p>
                                </div>
                                <div className="bg-white/80 backdrop-blur border border-gray-200 p-4 rounded-lg w-56 shrink-0 shadow-sm">
                                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-3 border-b border-gray-100 pb-2">
                                        {activeTab === 'FUNCTIONAL' ? 'Trigger Logic' : 'Configuration'}
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        {activeConfig.techSpecs.map((spec, i) => (
                                            <div key={i} className="text-[10px] font-mono text-gray-600 flex items-center gap-2">
                                                <div className="w-1 h-1 bg-blue-400 rounded-full"></div>
                                                {spec}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="flex-1 border border-gray-200 rounded-xl bg-gray-50/30 relative overflow-hidden flex items-center justify-center p-8 group hover:bg-gray-50 transition-colors">
                                <div className="absolute top-4 left-4 text-[10px] font-mono text-gray-400 uppercase">
                                    {activeTab === 'FUNCTIONAL' ? 'Process Visualization' : 'Architecture Diagram'}
                                </div>
                                <div className="w-full max-w-md aspect-[2/1] bg-white shadow-lg rounded border border-gray-100 p-4 transition-transform duration-500 group-hover:scale-105">
                                    {activeConfig.illustration}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

            </div>
        </div>,
        document.body
    );
};

export default InsightExplainer;
