
import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import {
    CheckCircle2, Lightbulb, FileText, Download,
    ShieldAlert, Scale, MessageSquare, ArrowRight, ArrowLeft, LayoutDashboard, List,
    Users, Box, CircleDollarSign, Fingerprint, Gavel,
    Construction, HelpCircle, User, Building2, Zap, Microscope, Eye,
    BarChart2, Search, CircleDot, TriangleAlert, Target,
    BrainCircuit, Sparkles, ChevronDown, ChevronRight as ChevronRightIcon,
    Link2, Clock, Route, TreeDeciduous, X
} from 'lucide-react';
import { clsx } from 'clsx';
import { InsightType, InsightCard, ChatMessage, AgentState } from '../../types';
import type { LucideIcon } from 'lucide-react';
import InsightDetailModal from './InsightDetailModal';

// ============================================================================
// ADVANCED CONVERSATION ANALYSIS ENGINE
// ============================================================================

type ConversationRole =
    | 'OBSERVATION'
    | 'COORDINATION'
    | 'TRIGGER'
    | 'RATIONALE'
    | 'CONSTRAINT'
    | 'DECISION'
    | 'SYNTHESIS'
    | 'QUESTIONING'
    | 'EVIDENCE'
    | 'GENERAL';

interface ReasoningNode {
    id: string;
    type: 'trigger' | 'observation' | 'hypothesis' | 'analysis' | 'evidence' | 'synthesis' | 'decision' | 'rationale';
    content: string;
    confidence: number;
    timestamp: number;
    agentId: string;
    linkedMessageIds: string[];
    children: ReasoningNode[];
    parentId: string | null;
    depth: number;
}

interface CausalChain {
    id: string;
    component: string;
    nodes: ReasoningNode[];
    rootCause: string;
    finalOutcome: string;
    confidenceScore: number;
    impactScore: number;
    patterns: AnalysisPattern[];
}

interface AnalysisPattern {
    type: string;
    description: string;
    confidence: number;
    icon: LucideIcon;
    color: string;
}

// Enhanced message classification with more granularity
const classifyMessage = (text: string): ConversationRole => {
    const t = text.toLowerCase();

    // Synthesis patterns
    if (t.includes('synthesiz') || t.includes('connect the dots') || t.includes('putting together') || t.includes('in summary')) return 'SYNTHESIS';

    // Questioning patterns
    if (t.includes('?') || t.includes('what if') || t.includes('have we considered') || t.includes('can someone')) return 'QUESTIONING';

    // Evidence patterns
    if (t.includes('data shows') || t.includes('testing') || t.includes('simulation') || t.includes('historical') || t.includes('validated')) return 'EVIDENCE';

    // Risk/Trigger patterns
    if (t.includes('risk') || t.includes('concern') || t.includes('fail') || t.includes('weak') || t.includes('worried') || t.includes('flag')) return 'TRIGGER';

    // Rationale patterns
    if (t.includes('because') || t.includes('designed to') || t.includes('intent') || t.includes('driver') || t.includes('rationale') || t.includes('reason we')) return 'RATIONALE';

    // Decision patterns
    if (t.includes('let\'s') || t.includes('action') || t.includes('freeze') || t.includes('lock') || t.includes('proceed') || t.includes('approve')) return 'DECISION';

    // Coordination patterns
    if (t.includes('can\'t see') || t.includes('rotate') || t.includes('view') || t.includes('focus') || t.includes('move to')) return 'COORDINATION';

    // Constraint patterns
    if (t.includes('cost') || t.includes('supplier') || t.includes('time') || t.includes('limit') || t.includes('budget')) return 'CONSTRAINT';

    // Observation patterns
    if (t.includes('see') || t.includes('notice') || t.includes('measuring') || t.includes('looking at') || t.includes('running my eye')) return 'OBSERVATION';

    return 'GENERAL';
};

const getRoleColor = (role: ConversationRole) => {
    switch (role) {
        case 'TRIGGER': return 'bg-red-400 text-red-900 border-red-200';
        case 'RATIONALE': return 'bg-amber-400 text-amber-900 border-amber-200';
        case 'DECISION': return 'bg-blue-400 text-blue-900 border-blue-200';
        case 'COORDINATION': return 'bg-purple-400 text-purple-900 border-purple-200';
        case 'CONSTRAINT': return 'bg-emerald-400 text-emerald-900 border-emerald-200';
        case 'OBSERVATION': return 'bg-gray-400 text-gray-900 border-gray-200';
        case 'SYNTHESIS': return 'bg-indigo-400 text-indigo-900 border-indigo-200';
        case 'QUESTIONING': return 'bg-cyan-400 text-cyan-900 border-cyan-200';
        case 'EVIDENCE': return 'bg-teal-400 text-teal-900 border-teal-200';
        default: return 'bg-gray-200 text-gray-700 border-gray-300';
    }
};

const getRoleIcon = (role: ConversationRole) => {
    switch (role) {
        case 'TRIGGER': return TriangleAlert;
        case 'RATIONALE': return Lightbulb;
        case 'DECISION': return Target;
        case 'SYNTHESIS': return BrainCircuit;
        case 'QUESTIONING': return HelpCircle;
        case 'EVIDENCE': return BarChart2;
        case 'OBSERVATION': return Eye;
        case 'CONSTRAINT': return Scale;
        case 'COORDINATION': return Users;
        default: return MessageSquare;
    }
};

type TriggerCategory = 'DISAGREEMENT' | 'COST' | 'ERGONOMICS' | 'COMPLIANCE' | 'QUALITY' | 'TECHNICAL' | 'SAFETY' | 'GENERAL';

const getTriggerInfo = (text: string): { type: TriggerCategory, icon: LucideIcon, label: string, color: string } => {
    const t = text.toLowerCase();
    if (t.includes('disagree') || t.includes('not sure') || t.includes('opinion') || t.includes('push back'))
        return { type: 'DISAGREEMENT', icon: HelpCircle, label: 'Disagreement', color: 'text-amber-600 bg-amber-50 border-amber-200' };
    if (t.includes('cost') || t.includes('expensive') || t.includes('budget') || t.includes('cheap'))
        return { type: 'COST', icon: CircleDollarSign, label: 'Cost Constraint', color: 'text-emerald-600 bg-emerald-50 border-emerald-200' };
    if (t.includes('reach') || t.includes('comfort') || t.includes('fit') || t.includes('user') || t.includes('ergo'))
        return { type: 'ERGONOMICS', icon: Fingerprint, label: 'Ergonomics', color: 'text-purple-600 bg-purple-50 border-purple-200' };
    if (t.includes('standard') || t.includes('iso') || t.includes('req') || t.includes('rule') || t.includes('compliance'))
        return { type: 'COMPLIANCE', icon: Gavel, label: 'Compliance', color: 'text-blue-600 bg-blue-50 border-blue-200' };
    if (t.includes('break') || t.includes('fail') || t.includes('weak') || t.includes('quality') || t.includes('defect'))
        return { type: 'QUALITY', icon: ShieldAlert, label: 'Quality Risk', color: 'text-red-600 bg-red-50 border-red-200' };
    if (t.includes('tolerance') || t.includes('clearance') || t.includes('interference') || t.includes('thermal') || t.includes('stress'))
        return { type: 'TECHNICAL', icon: Construction, label: 'Technical Issue', color: 'text-orange-600 bg-orange-50 border-orange-200' };
    if (t.includes('safe') || t.includes('hazard') || t.includes('injury') || t.includes('protect'))
        return { type: 'SAFETY', icon: ShieldAlert, label: 'Safety Concern', color: 'text-red-700 bg-red-100 border-red-300' };

    return { type: 'GENERAL', icon: Zap, label: 'General Input', color: 'text-gray-600 bg-gray-50 border-gray-200' };
};

// ============================================================================
// REASONING TREE BUILDER
// ============================================================================

const buildReasoningTree = (
    messages: ChatMessage[],
    _cards: InsightCard[],
    _agents: AgentState[]
): ReasoningNode[] => {
    const nodes: ReasoningNode[] = [];
    let currentParentId: string | null = null;
    let depth = 0;

    messages.forEach((msg) => {
        const role = classifyMessage(msg.text);
        let nodeType: ReasoningNode['type'] = 'observation';
        let confidence = 0.5;

        // Map conversation roles to reasoning node types
        switch (role) {
            case 'TRIGGER':
                nodeType = 'trigger';
                confidence = 0.9;
                depth = 0;
                currentParentId = null;
                break;
            case 'OBSERVATION':
                nodeType = 'observation';
                confidence = 0.7;
                if (depth === 0) depth = 1;
                break;
            case 'QUESTIONING':
                nodeType = 'hypothesis';
                confidence = 0.4;
                depth = Math.min(depth + 1, 3);
                break;
            case 'EVIDENCE':
                nodeType = 'evidence';
                confidence = 0.85;
                break;
            case 'RATIONALE':
                nodeType = 'rationale';
                confidence = 0.8;
                break;
            case 'SYNTHESIS':
                nodeType = 'synthesis';
                confidence = 0.75;
                depth = Math.max(1, depth - 1);
                break;
            case 'DECISION':
                nodeType = 'decision';
                confidence = 0.95;
                depth = 0;
                break;
            default:
                nodeType = 'observation';
                confidence = 0.5;
        }

        // Adjust confidence based on content signals
        if (msg.text.includes('high-confidence') || msg.text.includes('validated') || msg.text.includes('confirm')) {
            confidence = Math.min(confidence + 0.15, 1);
        }
        if (msg.text.includes('might') || msg.text.includes('could') || msg.text.includes('possibly')) {
            confidence = Math.max(confidence - 0.2, 0.2);
        }

        const node: ReasoningNode = {
            id: msg.id,
            type: nodeType,
            content: msg.text,
            confidence,
            timestamp: msg.timestamp,
            agentId: msg.agentId,
            linkedMessageIds: [msg.id],
            children: [],
            parentId: currentParentId,
            depth
        };

        nodes.push(node);

        // Update parent tracking for tree structure
        if (nodeType === 'trigger' || nodeType === 'decision') {
            currentParentId = node.id;
        }
    });

    return nodes;
};

// ============================================================================
// PATTERN DETECTION ENGINE
// ============================================================================

const detectPatterns = (messages: ChatMessage[], _cards: InsightCard[]): AnalysisPattern[] => {
    const patterns: AnalysisPattern[] = [];
    const roles = messages.map(m => classifyMessage(m.text));
    const uniqueSpeakers = new Set(messages.map(m => m.agentId)).size;

    // Collaborative Discussion Pattern
    if (uniqueSpeakers >= 2 && messages.length > 5) {
        patterns.push({
            type: 'COLLABORATIVE_ANALYSIS',
            description: 'Multiple participants engaged in structured discussion',
            confidence: Math.min(0.5 + (uniqueSpeakers * 0.15), 0.95),
            icon: Users,
            color: 'bg-blue-100 text-blue-700 border-blue-200'
        });
    }

    // Deep Technical Dive Pattern
    const technicalTerms = ['tolerance', 'stress', 'thermal', 'clearance', 'moldflow', 'FEA', 'simulation'];
    const technicalCount = messages.filter(m => technicalTerms.some(t => m.text.toLowerCase().includes(t))).length;
    if (technicalCount > 2) {
        patterns.push({
            type: 'DEEP_TECHNICAL_ANALYSIS',
            description: `${technicalCount} messages with technical specifications`,
            confidence: Math.min(0.6 + (technicalCount * 0.1), 0.95),
            icon: Microscope,
            color: 'bg-purple-100 text-purple-700 border-purple-200'
        });
    }

    // Risk Escalation Pattern
    const triggerCount = roles.filter(r => r === 'TRIGGER').length;
    if (triggerCount >= 2) {
        patterns.push({
            type: 'RISK_ESCALATION',
            description: `${triggerCount} risk triggers identified and addressed`,
            confidence: 0.85,
            icon: TriangleAlert,
            color: 'bg-red-100 text-red-700 border-red-200'
        });
    }

    // Evidence-Based Reasoning Pattern
    const evidenceCount = roles.filter(r => r === 'EVIDENCE').length;
    if (evidenceCount >= 1) {
        patterns.push({
            type: 'EVIDENCE_BACKED',
            description: 'Decisions supported by data and validation',
            confidence: 0.9,
            icon: BarChart2,
            color: 'bg-teal-100 text-teal-700 border-teal-200'
        });
    }

    // Iterative Refinement Pattern
    const synthCount = roles.filter(r => r === 'SYNTHESIS').length;
    if (synthCount >= 1) {
        patterns.push({
            type: 'ITERATIVE_SYNTHESIS',
            description: 'Ideas were synthesized and refined collaboratively',
            confidence: 0.8,
            icon: BrainCircuit,
            color: 'bg-indigo-100 text-indigo-700 border-indigo-200'
        });
    }

    // Question-Driven Exploration Pattern
    const questionCount = roles.filter(r => r === 'QUESTIONING').length;
    if (questionCount >= 2) {
        patterns.push({
            type: 'EXPLORATORY_QUESTIONING',
            description: 'Critical questions drove deeper investigation',
            confidence: 0.75,
            icon: HelpCircle,
            color: 'bg-cyan-100 text-cyan-700 border-cyan-200'
        });
    }

    // Constraint Navigation Pattern
    const constraintCount = roles.filter(r => r === 'CONSTRAINT').length;
    if (constraintCount >= 1) {
        patterns.push({
            type: 'CONSTRAINT_AWARE',
            description: 'External constraints factored into decision',
            confidence: 0.7,
            icon: Scale,
            color: 'bg-emerald-100 text-emerald-700 border-emerald-200'
        });
    }

    return patterns;
};

// ============================================================================
// CAUSAL CHAIN BUILDER
// ============================================================================

const buildCausalChain = (
    component: string,
    messages: ChatMessage[],
    cards: InsightCard[],
    agents: AgentState[]
): CausalChain => {
    const nodes = buildReasoningTree(messages, cards, agents);
    const patterns = detectPatterns(messages, cards);

    // Find root cause (first trigger or observation)
    const triggerNode = nodes.find(n => n.type === 'trigger');
    const rootCause = triggerNode?.content || nodes[0]?.content || 'Initial observation';

    // Find final outcome (last decision or synthesis)
    const decisionNodes = nodes.filter(n => n.type === 'decision' || n.type === 'synthesis');
    const finalOutcome = decisionNodes.length > 0
        ? decisionNodes[decisionNodes.length - 1].content
        : 'Analysis ongoing';

    // Calculate confidence score
    const avgConfidence = nodes.length > 0
        ? nodes.reduce((sum, n) => sum + n.confidence, 0) / nodes.length
        : 0.5;

    // Calculate impact score based on risk triggers and decisions
    const riskCount = nodes.filter(n => n.type === 'trigger').length;
    const decisionCount = nodes.filter(n => n.type === 'decision').length;
    const impactScore = Math.min((riskCount * 0.2) + (decisionCount * 0.3) + 0.3, 1);

    return {
        id: component,
        component,
        nodes,
        rootCause: rootCause.substring(0, 100) + (rootCause.length > 100 ? '...' : ''),
        finalOutcome: finalOutcome.substring(0, 100) + (finalOutcome.length > 100 ? '...' : ''),
        confidenceScore: avgConfidence,
        impactScore,
        patterns
    };
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

const MeetingSummary: React.FC = () => {
    const navigate = useNavigate();
    const insightCards = useStore(state => state.insightCards);
    const requirements = useStore(state => state.requirements);
    const chatHistory = useStore(state => state.chatHistory);
    const isMeetingEnded = useStore(state => state.isMeetingEnded);
    const endMeeting = useStore(state => state.endMeeting);
    const agents = useStore(state => state.agents);
    const time = useStore(state => state.time);
    const updateInsightType = useStore(state => state.updateInsightType);
    const updateInsight = useStore(state => state.updateInsight);
    const comments = useStore(state => state.comments);

    const [activeTab, setActiveTab] = useState<'DECISIONS' | 'REQUIREMENTS' | 'ASSIGNEES' | 'COMPONENTS' | 'THREADS' | 'ANALYSIS' | 'TREE' | 'COMMENTS'>('DECISIONS');
    const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
    const [selectedCard, setSelectedCard] = useState<InsightCard | null>(null);
    const [assigneeMode, setAssigneeMode] = useState<'INDIVIDUAL' | 'DEPARTMENT'>('INDIVIDUAL');
    const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
    const [showBoardExplainer, setShowBoardExplainer] = useState(false);


    // Session Review Board view descriptions
    const VIEW_DESCRIPTIONS = {
        DECISIONS: {
            title: 'Decision Board',
            description: 'Kanban-style board organizing all captured insights into three categories: Risks (potential issues), Actions (tasks to complete), and Rationale (design decisions). Drag cards between columns to reclassify.',
            icon: LayoutDashboard
        },
        COMMENTS: {
            title: 'Spatial Comments',
            description: 'Review all spatial comments and annotations made during the session. See which components were discussed, view drawing annotations, and track comment resolution status.',
            icon: MessageSquare
        },
        REQUIREMENTS: {
            title: 'Requirements Impact',
            description: 'View all regulatory and design requirements with their current status. See which decisions affect each requirement and track compliance across the session.',
            icon: List
        },
        ASSIGNEES: {
            title: 'Assignment View',
            description: 'Organize insights by person or department. Drag cards to assign ownership. Toggle between individual and department views for different perspectives.',
            icon: Users
        },
        TREE: {
            title: 'Reasoning Tree',
            description: 'Visual representation of the decision-making process. Shows how observations, questions, and evidence led to final decisions. Each node represents a step in the reasoning chain.',
            icon: TreeDeciduous
        },
        THREADS: {
            title: 'Causal Flow',
            description: 'Schematic diagram showing cause-and-effect relationships. Traces triggers through analysis to final outcomes. Includes pattern detection and confidence scoring.',
            icon: Route
        },
        ANALYSIS: {
            title: 'Deep Analysis',
            description: 'Conversation dynamics visualization. Shows interaction density over time, message classification, and detected collaboration patterns. Useful for understanding discussion quality.',
            icon: Microscope
        }
    };

    const transcriptRef = useRef<HTMLDivElement>(null);

    // Auto scroll logic
    useEffect(() => {
        if (!hoveredCardId || !transcriptRef.current) return;

        const card = insightCards.find(c => c.id === hoveredCardId);
        if (card && card.sourceMessageIds && card.sourceMessageIds.length > 0) {
            const msgId = card.sourceMessageIds[0];
            const el = document.getElementById(`summary-msg-${msgId}`);

            if (el) {
                const container = transcriptRef.current;
                const topPos = el.offsetTop;
                const centerOffset = (container.clientHeight / 2) - (el.clientHeight / 2);

                container.scrollTo({
                    top: Math.max(0, topPos - centerOffset),
                    behavior: 'smooth'
                });

                el.style.transition = 'background-color 0.2s';
                el.style.backgroundColor = 'rgba(59, 130, 246, 0.2)';
                setTimeout(() => {
                    el.style.backgroundColor = '';
                }, 1000);
            }
        }
    }, [hoveredCardId, insightCards]);


    if (!isMeetingEnded) return null;

    // Drag and drop handlers
    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (e: React.DragEvent, targetType: InsightType) => {
        const cardId = e.dataTransfer.getData("cardId");
        if (cardId) {
            updateInsightType(cardId, targetType);
        }
    };

    const handleAssigneeDrop = (e: React.DragEvent, targetName: string) => {
        const cardId = e.dataTransfer.getData("cardId");
        if (cardId) {
            const card = insightCards.find(c => c.id === cardId);
            if (card) {
                if (assigneeMode === 'INDIVIDUAL') {
                    updateInsight(cardId, { details: { ...card.details, assignee: targetName } });
                } else {
                    updateInsight(cardId, { details: { ...card.details, department: targetName } });
                }
            }
        }
    };

    // Derived State
    const risks = insightCards.filter(c => c.type === 'RISK');
    const actions = insightCards.filter(c => c.type === 'ACTION');
    const rationale = insightCards.filter(c => c.type === 'RATIONALE');

    const highlightedMsgIds = hoveredCardId ? insightCards.find(c => c.id === hoveredCardId)?.sourceMessageIds || [] : [];
    const highlightedReqIds = hoveredCardId ? insightCards.find(c => c.id === hoveredCardId)?.affectedRequirementIds || [] : [];

    // Grouping helpers
    const getCardsByAssignee = () => {
        const groups: Record<string, InsightCard[]> = {};
        insightCards.forEach(card => {
            const key = assigneeMode === 'INDIVIDUAL'
                ? (card.details.assignee || 'Unassigned')
                : (card.details.department || 'General');
            if (!groups[key]) groups[key] = [];
            groups[key].push(card);
        });
        return groups;
    };

    const getCardsByComponent = () => {
        const groups: Record<string, InsightCard[]> = {};
        insightCards.forEach(card => {
            const comp = card.details.componentReference || 'General Assembly';
            if (!groups[comp]) groups[comp] = [];
            groups[comp].push(card);
        });
        return groups;
    };

    // Thread reconstruction with causal chains
    interface DecisionThread {
        id: string;
        component: string;
        finalDecision: InsightCard | null;
        intermediates: InsightCard[];
        triggerTypes: TriggerCategory[];
        triggerMessages: ChatMessage[];
        allMessages: ChatMessage[];
        patterns: string[];
        causalChain: CausalChain;
    }

    const getThreads = (): DecisionThread[] => {
        const groups = getCardsByComponent();
        const threads: DecisionThread[] = [];

        Object.entries(groups).forEach(([component, cards]) => {
            const sorted = [...cards].sort((a, b) => a.timestamp - b.timestamp);

            if (sorted.length === 0) return;

            const final = sorted[sorted.length - 1];
            const intermediates = sorted.slice(0, sorted.length - 1);

            const firstCard = sorted[0];
            const originMsgs = chatHistory.filter(m => firstCard.sourceMessageIds?.includes(m.id));

            const relatedMessages = chatHistory.filter(m =>
                m.text.toLowerCase().includes(component.toLowerCase()) ||
                sorted.some(c => c.sourceMessageIds?.includes(m.id))
            ).sort((a,b) => a.timestamp - b.timestamp);

            const triggersSet = new Set<TriggerCategory>();
            originMsgs.forEach(m => triggersSet.add(getTriggerInfo(m.text).type));

            // Build causal chain
            const causalChain = buildCausalChain(component, relatedMessages, cards, agents);

            // Detect legacy patterns for backwards compat
            const legacyPatterns: string[] = [];
            const uniqueSpeakers = new Set(relatedMessages.map(m => m.agentId)).size;
            if (uniqueSpeakers > 2) legacyPatterns.push("Shared Focus");
            if (relatedMessages.length > 8) legacyPatterns.push("Deep Dive");
            if (relatedMessages.some(m => m.text.includes("rotate") || m.text.includes("view"))) legacyPatterns.push("View Coord.");
            if (relatedMessages.some(m => m.text.includes("fail") || m.text.includes("risk"))) legacyPatterns.push("High Alert");

            threads.push({
                id: component,
                component,
                finalDecision: final,
                intermediates,
                triggerTypes: Array.from(triggersSet),
                triggerMessages: originMsgs,
                allMessages: relatedMessages,
                patterns: legacyPatterns,
                causalChain
            });
        });

        return threads;
    };

    const threads = getThreads();
    const activeThread = selectedThreadId ? threads.find(t => t.id === selectedThreadId) : null;

    // Toggle node expansion
    const toggleNodeExpand = (nodeId: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    };

    // Render reasoning node for tree view
    const renderReasoningNode = (node: ReasoningNode, index: number, isLast: boolean) => {
        const agent = agents.find(a => a.id === node.agentId);
        const isExpanded = expandedNodes.has(node.id);

        const getNodeColor = () => {
            switch (node.type) {
                case 'trigger': return 'border-red-500 bg-red-50';
                case 'observation': return 'border-gray-400 bg-gray-50';
                case 'hypothesis': return 'border-cyan-500 bg-cyan-50';
                case 'evidence': return 'border-teal-500 bg-teal-50';
                case 'analysis': return 'border-purple-500 bg-purple-50';
                case 'synthesis': return 'border-indigo-500 bg-indigo-50';
                case 'rationale': return 'border-amber-500 bg-amber-50';
                case 'decision': return 'border-blue-500 bg-blue-50';
                default: return 'border-gray-300 bg-white';
            }
        };

        const getNodeIcon = () => {
            switch (node.type) {
                case 'trigger': return TriangleAlert;
                case 'observation': return Eye;
                case 'hypothesis': return HelpCircle;
                case 'evidence': return BarChart2;
                case 'analysis': return Microscope;
                case 'synthesis': return BrainCircuit;
                case 'rationale': return Lightbulb;
                case 'decision': return Target;
                default: return CircleDot;
            }
        };

        const Icon = getNodeIcon();

        return (
            <div key={node.id} className="relative">
                {/* Connector Line */}
                {index > 0 && (
                    <div className="absolute -top-4 left-6 w-px h-4 bg-gray-300"></div>
                )}

                {/* Node */}
                <div
                    className={clsx(
                        "relative p-4 rounded-lg border-l-4 transition-all cursor-pointer hover:shadow-md",
                        getNodeColor(),
                        isExpanded ? "shadow-md" : ""
                    )}
                    onClick={() => toggleNodeExpand(node.id)}
                    style={{ marginLeft: `${node.depth * 24}px` }}
                >
                    {/* Node Header */}
                    <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                            <div className={clsx(
                                "w-8 h-8 rounded-full flex items-center justify-center",
                                node.type === 'trigger' ? "bg-red-200 text-red-700" :
                                node.type === 'decision' ? "bg-blue-200 text-blue-700" :
                                node.type === 'synthesis' ? "bg-indigo-200 text-indigo-700" :
                                "bg-gray-200 text-gray-700"
                            )}>
                                <Icon size={16} />
                            </div>
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
                                    {node.type}
                                </div>
                                <div className="text-[9px] text-gray-400 font-mono">
                                    Depth: {node.depth} | Conf: {(node.confidence * 100).toFixed(0)}%
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center gap-2">
                            {agent && (
                                <div className="flex items-center gap-1">
                                    <div className="w-4 h-4 rounded-full" style={{ backgroundColor: agent.color }}></div>
                                    <span className="text-[10px] font-mono font-bold text-gray-600">{agent.name}</span>
                                </div>
                            )}
                            {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRightIcon size={14} className="text-gray-400" />}
                        </div>
                    </div>

                    {/* Node Content */}
                    <div className={clsx(
                        "text-sm leading-relaxed transition-all",
                        isExpanded ? "text-gray-800" : "text-gray-600 line-clamp-2"
                    )}>
                        "{node.content}"
                    </div>

                    {/* Confidence Bar */}
                    <div className="mt-3 flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                                className={clsx(
                                    "h-full rounded-full transition-all",
                                    node.confidence > 0.8 ? "bg-green-500" :
                                    node.confidence > 0.6 ? "bg-blue-500" :
                                    node.confidence > 0.4 ? "bg-amber-500" :
                                    "bg-red-500"
                                )}
                                style={{ width: `${node.confidence * 100}%` }}
                            ></div>
                        </div>
                        <span className="text-[9px] font-mono text-gray-500">
                            {(node.confidence * 100).toFixed(0)}%
                        </span>
                    </div>
                </div>

                {/* Branch indicator for non-last items */}
                {!isLast && (
                    <div className="absolute bottom-0 left-6 w-px h-4 bg-gray-300"></div>
                )}
            </div>
        );
    };

    return (
        <div className="fixed inset-0 z-50 bg-[#F2F2F2] flex flex-col items-center justify-center p-4 animate-in fade-in duration-300 pointer-events-auto">

            {selectedCard && (
                <InsightDetailModal
                    card={selectedCard}
                    onClose={() => setSelectedCard(null)}
                    agentColor={agents.find(a => a.id === selectedCard.agentId)?.color}
                />
            )}

            <div className="w-full max-w-[95vw] h-[90vh] bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden flex flex-col">

                {/* Header */}
                <div className="bg-black text-white p-5 flex justify-between items-center shrink-0">
                    <div className="flex flex-col gap-1">
                        <button
                            onClick={() => setShowBoardExplainer(!showBoardExplainer)}
                            className="text-xl font-bold tracking-tight flex items-center gap-3 hover:text-gray-300 transition-colors group text-left"
                        >
                            <FileText size={20} />
                            Session Review Board
                            <HelpCircle size={14} className="text-gray-500 group-hover:text-white transition-colors" />
                        </button>
                        <div className="text-gray-400 text-xs font-mono flex items-center gap-4">
                            <span>DURATION: {(time / 60).toFixed(1)} MIN</span>
                            <span>DECISIONS: {insightCards.length}</span>
                            <span>COMMENTS: {comments.length}</span>
                            <span>PATTERNS: {threads.reduce((sum, t) => sum + t.causalChain.patterns.length, 0)}</span>
                        </div>
                    </div>

                    {/* Board Explainer Dropdown */}
                    {showBoardExplainer && (
                        <div className="absolute top-20 left-5 w-96 bg-white text-gray-800 rounded-lg shadow-2xl border border-gray-200 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
                            <div className="p-4 border-b border-gray-100">
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="font-bold text-sm uppercase tracking-wide">View Guide</h3>
                                    <button
                                        onClick={() => setShowBoardExplainer(false)}
                                        className="text-gray-400 hover:text-gray-600"
                                    >
                                        <X size={16} />
                                    </button>
                                </div>
                                <p className="text-xs text-gray-500">Click any view tab to explore different analysis perspectives</p>
                            </div>
                            <div className="p-2 max-h-80 overflow-y-auto">
                                {Object.entries(VIEW_DESCRIPTIONS).map(([key, view]) => {
                                    const Icon = view.icon;
                                    const isActive = activeTab === key;
                                    return (
                                        <button
                                            key={key}
                                            onClick={() => {
                                                setActiveTab(key as typeof activeTab);
                                                setShowBoardExplainer(false);
                                            }}
                                            className={clsx(
                                                "w-full p-3 rounded-lg text-left flex items-start gap-3 transition-colors",
                                                isActive ? "bg-black text-white" : "hover:bg-gray-50"
                                            )}
                                        >
                                            <Icon size={18} className={isActive ? "text-white" : "text-gray-400"} />
                                            <div className="flex-1">
                                                <div className={clsx("font-bold text-sm", isActive ? "text-white" : "text-gray-800")}>
                                                    {view.title}
                                                </div>
                                                <div className={clsx("text-[11px] leading-relaxed mt-0.5", isActive ? "text-gray-300" : "text-gray-500")}>
                                                    {view.description}
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}


                    <div className="flex bg-white/10 rounded p-1 gap-1">
                         <button onClick={() => setActiveTab('DECISIONS')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors", activeTab === 'DECISIONS' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <LayoutDashboard size={14} /> Board
                         </button>
                         <button onClick={() => setActiveTab('COMMENTS')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors relative", activeTab === 'COMMENTS' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <MessageSquare size={14} /> Comments
                            {comments.length > 0 && (
                                <span className={clsx("ml-1 w-4 h-4 rounded-full text-[9px] flex items-center justify-center", activeTab === 'COMMENTS' ? "bg-black text-white" : "bg-blue-500 text-white")}>
                                    {comments.length}
                                </span>
                            )}
                         </button>
                         <button onClick={() => setActiveTab('REQUIREMENTS')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors", activeTab === 'REQUIREMENTS' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <List size={14} /> Requirements
                         </button>
                         <button onClick={() => setActiveTab('ASSIGNEES')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors", activeTab === 'ASSIGNEES' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <Users size={14} /> Assignees
                         </button>
                         <button onClick={() => setActiveTab('TREE')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors", activeTab === 'TREE' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <TreeDeciduous size={14} /> Reasoning Tree
                         </button>
                         <button onClick={() => setActiveTab('THREADS')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors", activeTab === 'THREADS' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <Route size={14} /> Causal Flow
                         </button>
                         <button onClick={() => setActiveTab('ANALYSIS')} className={clsx("px-3 py-1.5 rounded text-xs font-bold uppercase flex items-center gap-2 transition-colors", activeTab === 'ANALYSIS' ? "bg-white text-black" : "text-gray-400 hover:text-white")}>
                            <Microscope size={14} /> Deep Analysis
                         </button>
                    </div>

                    <div className="flex items-center gap-3">
                        <button className="bg-gray-800 text-gray-300 px-4 py-2 rounded font-bold text-xs hover:text-white hover:bg-gray-700 transition-colors flex items-center gap-2">
                            <Download size={14} /> PDF Report
                        </button>
                        {/* The way back to the lobby, which until batch BP this board did
                            not have: it offered the tracker and the room the meeting was
                            held in, and a person who had finished a review and wanted the
                            list of design reviews had to edit the address bar to get
                            there. Arrow-left because it goes back out of the meeting,
                            where the tracker's arrow goes sideways into another view of
                            the same cards. */}
                        <button
                            onClick={() => navigate('/')}
                            data-testid="summary-lobby"
                            className="bg-gray-800 text-gray-300 px-4 py-2 rounded font-bold text-xs hover:text-white hover:bg-gray-700 transition-colors flex items-center gap-2"
                        >
                            <ArrowLeft size={14} /> Lobby
                        </button>
                        <button
                            onClick={() => navigate('/tracker')}
                            className="bg-gray-800 text-gray-300 px-4 py-2 rounded font-bold text-xs hover:text-white hover:bg-gray-700 transition-colors"
                        >
                            Open Tracker →
                        </button>
                        <button
                            onClick={() => endMeeting(false)}
                            className="bg-white text-black px-4 py-2 rounded font-bold text-xs hover:bg-gray-200 transition-colors"
                        >
                            Return to Scene
                        </button>
                    </div>
                </div>

                <div className="flex-1 flex overflow-hidden">

                    {/* LEFT PANEL CONTENT */}
                    <div className={clsx("flex-1 bg-gray-50/50 relative", (activeTab !== 'THREADS' && activeTab !== 'ANALYSIS' && activeTab !== 'TREE') ? "p-6 overflow-y-auto" : "overflow-hidden")}>

                        {/* DECISIONS TAB */}
                        {activeTab === 'DECISIONS' && (
                            <div className="grid grid-cols-3 gap-6 h-full min-h-[500px]">
                                <div className="flex flex-col gap-3 h-full bg-red-50/30 rounded-lg p-2 border border-dashed border-red-200" onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, 'RISK')}>
                                    <div className="flex items-center gap-2 text-red-800 font-bold text-sm uppercase px-2 py-1"><ShieldAlert size={16}/> Risks ({risks.length})</div>
                                    {risks.map(card => <SummaryCard key={card.id} card={card} agents={agents} setHover={setHoveredCardId} onClick={() => setSelectedCard(card)} color="bg-white border-red-200 shadow-sm" />)}
                                </div>
                                <div className="flex flex-col gap-3 h-full bg-blue-50/30 rounded-lg p-2 border border-dashed border-blue-200" onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, 'ACTION')}>
                                    <div className="flex items-center gap-2 text-blue-800 font-bold text-sm uppercase px-2 py-1"><CheckCircle2 size={16}/> Actions ({actions.length})</div>
                                    {actions.map(card => <SummaryCard key={card.id} card={card} agents={agents} setHover={setHoveredCardId} onClick={() => setSelectedCard(card)} color="bg-white border-blue-200 shadow-sm" />)}
                                </div>
                                <div className="flex flex-col gap-3 h-full bg-amber-50/30 rounded-lg p-2 border border-dashed border-amber-200" onDragOver={handleDragOver} onDrop={(e) => handleDrop(e, 'RATIONALE')}>
                                    <div className="flex items-center gap-2 text-amber-800 font-bold text-sm uppercase px-2 py-1"><Lightbulb size={16}/> Rationale ({rationale.length})</div>
                                    {rationale.map(card => <SummaryCard key={card.id} card={card} agents={agents} setHover={setHoveredCardId} onClick={() => setSelectedCard(card)} color="bg-white border-amber-200 shadow-sm" />)}
                                </div>
                            </div>
                        )}

                        {/* COMMENTS TAB */}
                        {activeTab === 'COMMENTS' && (
                            <div className="h-full">
                                {comments.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-64 text-gray-400">
                                        <MessageSquare size={48} className="opacity-20 mb-4" />
                                        <div className="text-sm font-bold">No Comments</div>
                                        <div className="text-xs">Spatial comments made during the session will appear here</div>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-2 gap-6">
                                        {/* Text Comments Column */}
                                        <div className="flex flex-col gap-3">
                                            <div className="flex items-center gap-2 text-blue-800 font-bold text-sm uppercase px-2 py-1 border-b border-gray-200 pb-2">
                                                <MessageSquare size={16}/> Text Comments ({comments.filter(c => c.type === 'text').length})
                                            </div>
                                            {comments.filter(c => c.type === 'text').map(comment => (
                                                <div key={comment.id} className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 hover:shadow-md transition-shadow">
                                                    <div className="flex items-start gap-3 mb-2">
                                                        <div
                                                            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                                                            style={{ backgroundColor: comment.authorColor }}
                                                        >
                                                            {comment.author[0]}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-bold text-sm">{comment.author}</span>
                                                                <span className="text-[10px] text-gray-400">
                                                                    {new Date(comment.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                                </span>
                                                            </div>
                                                            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-blue-600">
                                                                <Link2 size={10} />
                                                                <span className="font-mono font-bold">{comment.attachedToNodeName}</span>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-1.5">
                                                            {comment.resolved && (
                                                                <span className="text-[9px] bg-green-50 text-green-600 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                                    <CheckCircle2 size={10} /> Resolved
                                                                </span>
                                                            )}
                                                            {comment.linkedToMeeting && (
                                                                <span className="text-[9px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded flex items-center gap-1">
                                                                    <Link2 size={10} /> In Transcript
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="text-xs text-gray-700 leading-relaxed pl-11">
                                                        {comment.content}
                                                    </div>
                                                    {comment.assignees.length > 0 && (
                                                        <div className="flex flex-wrap gap-1 pl-11 mt-2">
                                                            {comment.assignees.map((assignee, i) => (
                                                                <span key={i} className="text-[9px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full">
                                                                    @{assignee}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                            {comments.filter(c => c.type === 'text').length === 0 && (
                                                <div className="text-center py-8 text-gray-400 text-xs">No text comments</div>
                                            )}
                                        </div>

                                        {/* Drawing Annotations Column */}
                                        <div className="flex flex-col gap-3">
                                            <div className="flex items-center gap-2 text-purple-800 font-bold text-sm uppercase px-2 py-1 border-b border-gray-200 pb-2">
                                                <Zap size={16}/> Drawing Annotations ({comments.filter(c => c.type === 'drawing').length})
                                            </div>
                                            <div className="grid grid-cols-2 gap-3">
                                                {comments.filter(c => c.type === 'drawing').map(comment => (
                                                    <div key={comment.id} className="bg-white rounded-lg border border-purple-200 shadow-sm p-3 hover:shadow-md transition-shadow">
                                                        {comment.drawingData && (
                                                            <div className="mb-2 rounded overflow-hidden border border-gray-200 bg-gray-100">
                                                                <img
                                                                    src={comment.drawingData}
                                                                    alt="Drawing annotation"
                                                                    className="w-full h-32 object-contain"
                                                                />
                                                            </div>
                                                        )}
                                                        <div className="flex items-center gap-2">
                                                            <div
                                                                className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                                                                style={{ backgroundColor: comment.authorColor }}
                                                            >
                                                                {comment.author[0]}
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-xs font-bold truncate">{comment.author}</div>
                                                                <div className="text-[9px] text-gray-400">
                                                                    {new Date(comment.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-1.5 mt-2 text-[9px] text-purple-600 bg-purple-50 px-2 py-1 rounded">
                                                            <Link2 size={9} />
                                                            <span className="font-mono font-bold truncate">{comment.attachedToNodeName}</span>
                                                        </div>
                                                        {comment.content && comment.content !== 'Screen annotation' && (
                                                            <div className="text-[10px] text-gray-600 mt-2 line-clamp-2">
                                                                {comment.content}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                            {comments.filter(c => c.type === 'drawing').length === 0 && (
                                                <div className="text-center py-8 text-gray-400 text-xs">No drawing annotations</div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Comment Summary Stats */}
                                {comments.length > 0 && (
                                    <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                                        <div className="text-xs font-bold uppercase text-gray-500 mb-3">Comment Analytics</div>
                                        <div className="grid grid-cols-4 gap-4">
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-gray-800">{comments.length}</div>
                                                <div className="text-[10px] text-gray-500 uppercase">Total Comments</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-green-600">{comments.filter(c => c.resolved).length}</div>
                                                <div className="text-[10px] text-gray-500 uppercase">Resolved</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-blue-600">{comments.filter(c => c.linkedToMeeting).length}</div>
                                                <div className="text-[10px] text-gray-500 uppercase">In Transcript</div>
                                            </div>
                                            <div className="text-center">
                                                <div className="text-2xl font-bold text-purple-600">
                                                    {new Set(comments.map(c => c.attachedToNodeName)).size}
                                                </div>
                                                <div className="text-[10px] text-gray-500 uppercase">Components</div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* REQUIREMENTS TAB */}
                        {activeTab === 'REQUIREMENTS' && (
                             <div className="flex flex-col gap-3">
                                {requirements.length === 0 && (
                                    <div className="text-center py-8 text-gray-400 text-sm italic">No requirements defined for this review</div>
                                )}
                                {requirements.map(req => {
                                    const linkedCards = insightCards.filter(c => c.affectedRequirementIds?.includes(req.id));
                                    const isHighlight = highlightedReqIds.includes(req.id);
                                    return (
                                        <div key={req.id} className={clsx("bg-white border p-4 rounded-lg flex items-start justify-between transition-all duration-300", isHighlight ? "ring-2 ring-orange-400 border-orange-400 shadow-lg scale-[1.01]" : "border-gray-200")}>
                                            <div className="flex flex-col gap-1 max-w-2xl">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-mono font-bold text-orange-600 text-sm">{req.code}</span>
                                                    <span className={clsx("text-[10px] px-2 py-0.5 rounded-full font-bold uppercase", req.status === 'MET' ? "bg-green-100 text-green-700" : req.status === 'AT_RISK' ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700")}>{req.status.replace('_', ' ')}</span>
                                                </div>
                                                <div className="text-sm text-gray-700">{req.description}</div>
                                            </div>
                                            {linkedCards.length > 0 && (
                                                <div className="flex flex-col gap-2 items-end">
                                                    <span className="text-[10px] font-bold text-gray-400 uppercase">Linked Decisions</span>
                                                    {linkedCards.map(c => (
                                                        <div key={c.id} onMouseEnter={() => setHoveredCardId(c.id)} onMouseLeave={() => setHoveredCardId(null)} onClick={() => setSelectedCard(c)} className="text-[10px] px-2 py-1 bg-gray-100 rounded border border-gray-200 hover:bg-gray-200 cursor-pointer">{c.title}</div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}

                        {/* ASSIGNEES TAB */}
                        {activeTab === 'ASSIGNEES' && (
                             <div className="flex flex-col h-full">
                                 <div className="flex justify-center mb-6">
                                     <div className="bg-white border border-gray-300 rounded-lg p-1 flex">
                                         <button onClick={() => setAssigneeMode('INDIVIDUAL')} className={clsx("px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 transition-all", assigneeMode === 'INDIVIDUAL' ? "bg-blue-100 text-blue-700 shadow-sm" : "text-gray-500 hover:text-gray-800")}><User size={14}/> Individual</button>
                                         <button onClick={() => setAssigneeMode('DEPARTMENT')} className={clsx("px-4 py-1.5 rounded text-xs font-bold flex items-center gap-2 transition-all", assigneeMode === 'DEPARTMENT' ? "bg-blue-100 text-blue-700 shadow-sm" : "text-gray-500 hover:text-gray-800")}><Building2 size={14}/> Department</button>
                                     </div>
                                 </div>
                                 <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
                                    {Object.entries(getCardsByAssignee()).map(([groupName, cards]) => (
                                        <div key={groupName} className="bg-white border border-gray-200 rounded-lg shadow-sm flex flex-col overflow-hidden" onDragOver={handleDragOver} onDrop={(e) => handleAssigneeDrop(e, groupName)}>
                                            <div className="bg-gray-50 border-b border-gray-100 p-3 flex items-center gap-3">
                                                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold text-xs border border-blue-200">{groupName.charAt(0)}</div>
                                                <div className="flex flex-col"><div className="text-sm font-bold text-gray-800">{groupName}</div><div className="text-[10px] text-gray-500 font-mono">{cards.length} Tasks Assigned</div></div>
                                            </div>
                                            <div className="p-2 flex flex-col gap-2 bg-gray-50/50 flex-1 min-h-[100px]">
                                                {cards.map(card => <SummaryCard key={card.id} card={card} agents={agents} setHover={setHoveredCardId} onClick={() => setSelectedCard(card)} color="bg-white border-gray-200 shadow-sm" />)}
                                            </div>
                                        </div>
                                    ))}
                                 </div>
                             </div>
                        )}

                        {/* REASONING TREE TAB */}
                        {activeTab === 'TREE' && (
                            <div className="flex h-full w-full">
                                {/* TREE SIDEBAR */}
                                <div className="w-72 border-r border-gray-200 bg-white overflow-y-auto shrink-0 flex flex-col">
                                    <div className="p-3 bg-gradient-to-r from-indigo-500 to-purple-500 text-white">
                                        <div className="text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-2">
                                            <TreeDeciduous size={14} /> Reasoning Flows
                                        </div>
                                        <div className="text-[10px] opacity-80">Select a component to view decision tree</div>
                                    </div>
                                    {threads.map(thread => (
                                        <button
                                            key={thread.id}
                                            onClick={() => setSelectedThreadId(thread.id)}
                                            className={clsx(
                                                "p-4 text-left border-b border-gray-100 hover:bg-gray-50 transition-colors group relative",
                                                selectedThreadId === thread.id ? "bg-indigo-50/70 border-r-4 border-r-indigo-500" : ""
                                            )}
                                        >
                                            <div className="flex items-center gap-2 mb-2">
                                                <Box size={14} className="text-gray-400" />
                                                <span className="font-mono text-xs font-bold text-gray-800">{thread.component}</span>
                                            </div>

                                            {/* Causal Chain Stats */}
                                            <div className="grid grid-cols-2 gap-2 mb-2">
                                                <div className="bg-gray-50 rounded p-1.5 text-center">
                                                    <div className="text-[10px] text-gray-500">Nodes</div>
                                                    <div className="text-sm font-bold text-gray-800">{thread.causalChain.nodes.length}</div>
                                                </div>
                                                <div className="bg-gray-50 rounded p-1.5 text-center">
                                                    <div className="text-[10px] text-gray-500">Confidence</div>
                                                    <div className="text-sm font-bold text-gray-800">{(thread.causalChain.confidenceScore * 100).toFixed(0)}%</div>
                                                </div>
                                            </div>

                                            {/* Pattern Tags */}
                                            <div className="flex flex-wrap gap-1">
                                                {thread.causalChain.patterns.slice(0, 3).map((p, idx) => {
                                                    const Icon = p.icon;
                                                    return (
                                                        <span key={idx} className={clsx("text-[9px] px-1.5 py-0.5 rounded border font-bold flex items-center gap-1", p.color)}>
                                                            <Icon size={8} /> {p.type.replace(/_/g, ' ')}
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        </button>
                                    ))}
                                </div>

                                {/* TREE CANVAS */}
                                <div className="flex-1 bg-gradient-to-br from-gray-50 to-white overflow-hidden flex flex-col">
                                    {activeThread ? (
                                        <div className="flex flex-col h-full">
                                            {/* Tree Header */}
                                            <div className="p-6 border-b border-gray-200 bg-white">
                                                <div className="flex items-center justify-between">
                                                    <div>
                                                        <h2 className="text-xl font-bold text-gray-900 flex items-center gap-3">
                                                            <TreeDeciduous className="text-indigo-500" size={24} />
                                                            Decision Tree: {activeThread.component}
                                                        </h2>
                                                        <p className="text-sm text-gray-500 mt-1">
                                                            Showing the reasoning chain from trigger to final decision
                                                        </p>
                                                    </div>

                                                    {/* Summary Stats */}
                                                    <div className="flex gap-4">
                                                        <div className="text-center px-4 py-2 bg-red-50 rounded-lg border border-red-100">
                                                            <div className="text-2xl font-bold text-red-600">
                                                                {activeThread.causalChain.nodes.filter(n => n.type === 'trigger').length}
                                                            </div>
                                                            <div className="text-[10px] text-red-500 font-bold uppercase">Triggers</div>
                                                        </div>
                                                        <div className="text-center px-4 py-2 bg-indigo-50 rounded-lg border border-indigo-100">
                                                            <div className="text-2xl font-bold text-indigo-600">
                                                                {activeThread.causalChain.nodes.filter(n => n.type === 'synthesis').length}
                                                            </div>
                                                            <div className="text-[10px] text-indigo-500 font-bold uppercase">Syntheses</div>
                                                        </div>
                                                        <div className="text-center px-4 py-2 bg-blue-50 rounded-lg border border-blue-100">
                                                            <div className="text-2xl font-bold text-blue-600">
                                                                {activeThread.causalChain.nodes.filter(n => n.type === 'decision').length}
                                                            </div>
                                                            <div className="text-[10px] text-blue-500 font-bold uppercase">Decisions</div>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Root Cause to Outcome Summary */}
                                                <div className="mt-4 p-4 bg-gradient-to-r from-red-50 via-gray-50 to-blue-50 rounded-lg border border-gray-200">
                                                    <div className="flex items-center gap-4">
                                                        <div className="flex-1">
                                                            <div className="text-[10px] font-bold text-red-500 uppercase mb-1">Root Cause</div>
                                                            <div className="text-sm text-gray-700 italic">"{activeThread.causalChain.rootCause}"</div>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-gray-400">
                                                            <ArrowRight size={20} />
                                                            <Route size={16} />
                                                            <ArrowRight size={20} />
                                                        </div>
                                                        <div className="flex-1 text-right">
                                                            <div className="text-[10px] font-bold text-blue-500 uppercase mb-1">Final Outcome</div>
                                                            <div className="text-sm text-gray-700 italic">"{activeThread.causalChain.finalOutcome}"</div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Tree Visualization */}
                                            <div className="flex-1 overflow-y-auto p-6">
                                                <div className="max-w-3xl mx-auto">
                                                    {/* Legend */}
                                                    <div className="mb-6 p-3 bg-white rounded-lg border border-gray-200 flex flex-wrap gap-3 justify-center">
                                                        {[
                                                            { type: 'trigger', label: 'Trigger', color: 'bg-red-200 border-red-500' },
                                                            { type: 'observation', label: 'Observation', color: 'bg-gray-200 border-gray-400' },
                                                            { type: 'hypothesis', label: 'Question', color: 'bg-cyan-200 border-cyan-500' },
                                                            { type: 'evidence', label: 'Evidence', color: 'bg-teal-200 border-teal-500' },
                                                            { type: 'rationale', label: 'Rationale', color: 'bg-amber-200 border-amber-500' },
                                                            { type: 'synthesis', label: 'Synthesis', color: 'bg-indigo-200 border-indigo-500' },
                                                            { type: 'decision', label: 'Decision', color: 'bg-blue-200 border-blue-500' }
                                                        ].map(item => (
                                                            <div key={item.type} className="flex items-center gap-1.5">
                                                                <div className={clsx("w-3 h-3 rounded border-l-2", item.color)}></div>
                                                                <span className="text-[10px] font-bold text-gray-600">{item.label}</span>
                                                            </div>
                                                        ))}
                                                    </div>

                                                    {/* Tree Nodes */}
                                                    <div className="flex flex-col gap-4">
                                                        {activeThread.causalChain.nodes.map((node, idx) =>
                                                            renderReasoningNode(node, idx, idx === activeThread.causalChain.nodes.length - 1)
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center justify-center w-full h-full text-gray-400 gap-4 opacity-50">
                                            <TreeDeciduous size={64} />
                                            <div className="text-lg font-mono">Select a component to view its reasoning tree</div>
                                            <div className="text-sm">The tree shows how observations led to decisions</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* CAUSAL FLOW TAB (Upgraded THREADS) */}
                        {activeTab === 'THREADS' && (
                            <div className="flex h-full w-full">
                                {/* OVERVIEW SIDEBAR */}
                                <div className="w-72 border-r border-gray-200 bg-white overflow-y-auto shrink-0 flex flex-col">
                                    <div className="p-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white">
                                        <div className="text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-2">
                                            <Route size={14} /> Causal Chains
                                        </div>
                                        <div className="text-[10px] opacity-80">Trace cause-and-effect flows</div>
                                    </div>
                                    {threads.map(thread => (
                                        <button
                                            key={thread.id}
                                            onClick={() => setSelectedThreadId(thread.id)}
                                            className={clsx(
                                                "p-3 text-left border-b border-gray-100 hover:bg-gray-50 transition-colors group relative",
                                                selectedThreadId === thread.id ? "bg-purple-50/50 border-r-4 border-r-purple-500" : ""
                                            )}
                                        >
                                            <div className="font-mono text-xs font-bold text-gray-800 mb-1">{thread.component}</div>
                                            <div className="text-[10px] text-gray-500 truncate mb-2">{thread.finalDecision?.title || "No Outcome"}</div>

                                            {/* Impact & Confidence Bars */}
                                            <div className="space-y-1 mb-2">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[9px] text-gray-400 w-12">Impact</span>
                                                    <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden">
                                                        <div className="h-full bg-purple-500 rounded-full" style={{ width: `${thread.causalChain.impactScore * 100}%` }}></div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[9px] text-gray-400 w-12">Conf.</span>
                                                    <div className="flex-1 h-1 bg-gray-200 rounded-full overflow-hidden">
                                                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${thread.causalChain.confidenceScore * 100}%` }}></div>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex gap-1">
                                                {thread.triggerTypes.map(type => {
                                                    const { icon: Icon, color } = getTriggerInfo(type);
                                                    return (
                                                        <div key={type} className={clsx("w-4 h-4 rounded-full flex items-center justify-center border", color)}>
                                                            <Icon size={8} />
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </button>
                                    ))}
                                </div>

                                {/* SCHEMATIC CANVAS */}
                                <div className="flex-1 bg-[#FAFAFA] overflow-hidden flex flex-col">

                                    {/* Pattern Detection Header */}
                                    {activeThread && (
                                        <div className="p-4 border-b border-gray-200 bg-white">
                                            <div className="flex items-center justify-between">
                                                <div className="text-sm font-bold text-gray-700 flex items-center gap-2">
                                                    <Sparkles className="text-purple-500" size={16} />
                                                    Detected Patterns
                                                </div>
                                                <div className="flex gap-2">
                                                    {activeThread.causalChain.patterns.map((p, idx) => {
                                                        const Icon = p.icon;
                                                        return (
                                                            <div key={idx} className={clsx("px-3 py-1.5 rounded-full border flex items-center gap-2", p.color)}>
                                                                <Icon size={12} />
                                                                <span className="text-[10px] font-bold">{p.type.replace(/_/g, ' ')}</span>
                                                                <span className="text-[9px] opacity-70">{(p.confidence * 100).toFixed(0)}%</span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Main Schematic Area */}
                                    <div className="flex-1 overflow-x-auto overflow-y-hidden p-8 flex items-center">
                                        {activeThread ? (
                                            <div className="flex items-center gap-0">

                                                {/* 1. CONTEXT NODE */}
                                                <div className="flex items-center">
                                                    <div className="w-64 bg-white border border-gray-300 shadow-lg p-4 rounded-lg flex flex-col relative group">
                                                        <div className="absolute -top-3 left-3 bg-gray-800 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase">
                                                            Context
                                                        </div>
                                                        <div className="flex items-center gap-2 mb-3 mt-1">
                                                            <Box size={18} className="text-gray-700"/>
                                                            <span className="font-mono font-bold text-sm">{activeThread.component}</span>
                                                        </div>
                                                        <div className="border-t border-gray-100 pt-2 flex flex-col gap-1">
                                                            <div className="text-[9px] text-gray-500 uppercase font-bold mb-1">Linked Requirements</div>
                                                            {requirements.filter(r => activeThread.finalDecision?.affectedRequirementIds?.includes(r.id)).map(r => (
                                                                <div key={r.id} className="text-[9px] bg-orange-50 text-orange-700 px-2 py-1 rounded border border-orange-100 font-mono flex items-center gap-1">
                                                                    <Scale size={8} /> {r.code}
                                                                </div>
                                                            ))}
                                                            {activeThread.finalDecision?.affectedRequirementIds?.length === 0 && (
                                                                <div className="text-[9px] text-gray-400 italic">No requirements linked</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="w-12 h-px bg-gradient-to-r from-gray-300 to-red-300"></div>
                                                </div>

                                                {/* 2. TRIGGER CLUSTER */}
                                                <div className="flex items-center">
                                                    <div className="flex flex-col gap-2 relative">
                                                        <div className="absolute -top-6 left-0 text-[9px] font-bold text-red-500 uppercase flex items-center gap-1">
                                                            <TriangleAlert size={10} /> Triggers
                                                        </div>
                                                        {activeThread.triggerMessages.slice(0, 3).map((msg, idx) => {
                                                            const info = getTriggerInfo(msg.text);
                                                            const Icon = info.icon;
                                                            return (
                                                                <div key={msg.id} className={clsx("w-56 p-3 rounded-lg border-2 shadow-md relative group cursor-help transition-all hover:scale-105", info.color)}>
                                                                    <div className="flex items-center justify-between mb-1">
                                                                        <div className="flex items-center gap-1 text-[9px] font-bold uppercase">
                                                                            <Icon size={12} /> {info.label}
                                                                        </div>
                                                                        <div className="text-[8px] opacity-60 font-mono bg-white/50 px-1 rounded">T-{idx+1}</div>
                                                                    </div>
                                                                    <div className="text-[10px] leading-snug italic opacity-90 line-clamp-2">
                                                                        "{msg.text}"
                                                                    </div>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                    <div className="w-12 flex items-center">
                                                        <div className="w-full h-px bg-gradient-to-r from-red-300 to-amber-300"></div>
                                                        <ArrowRight size={16} className="text-amber-400 -ml-2" />
                                                    </div>
                                                </div>

                                                {/* 3. REASONING PROCESS */}
                                                <div className="flex items-center">
                                                    <div className="flex flex-col gap-2 relative">
                                                        <div className="absolute -top-6 left-0 text-[9px] font-bold text-amber-600 uppercase flex items-center gap-1">
                                                            <BrainCircuit size={10} /> Analysis
                                                        </div>
                                                        {activeThread.intermediates.length > 0 ? (
                                                            activeThread.intermediates.slice(0, 2).map((card) => (
                                                                <div
                                                                    key={card.id}
                                                                    onClick={() => setSelectedCard(card)}
                                                                    className="w-48 bg-gradient-to-r from-amber-50 to-white border-2 border-dashed border-amber-300 p-3 rounded-lg hover:border-amber-500 cursor-pointer transition-all hover:shadow-md"
                                                                >
                                                                    <div className="text-[9px] font-bold text-amber-600 uppercase mb-1 flex items-center gap-1">
                                                                        <Lightbulb size={10} /> Intermediate
                                                                    </div>
                                                                    <div className="font-bold text-xs text-gray-700 mb-1 line-clamp-1">{card.title}</div>
                                                                    <div className="text-[9px] text-gray-500 italic line-clamp-2">"{card.description}"</div>
                                                                </div>
                                                            ))
                                                        ) : (
                                                            <div className="w-48 h-20 border-2 border-dashed border-gray-200 rounded-lg flex items-center justify-center">
                                                                <span className="text-[10px] text-gray-400 italic">Direct path</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="w-12 flex items-center">
                                                        <div className="w-full h-px bg-gradient-to-r from-amber-300 to-blue-300"></div>
                                                        <ArrowRight size={16} className="text-blue-400 -ml-2" />
                                                    </div>
                                                </div>

                                                {/* 4. FINAL DECISION */}
                                                <div className="flex items-center">
                                                    <div className="relative">
                                                        <div className="absolute -top-6 left-0 text-[9px] font-bold text-blue-600 uppercase flex items-center gap-1">
                                                            <Target size={10} /> Outcome
                                                        </div>
                                                        {activeThread.finalDecision ? (
                                                            <div
                                                                onClick={() => setSelectedCard(activeThread.finalDecision!)}
                                                                className={clsx(
                                                                    "w-64 p-4 rounded-lg shadow-xl border-l-4 cursor-pointer hover:scale-105 transition-all relative",
                                                                    activeThread.finalDecision.type === 'RISK' ? "bg-gradient-to-r from-red-50 to-white border-l-red-500" :
                                                                    activeThread.finalDecision.type === 'ACTION' ? "bg-gradient-to-r from-blue-50 to-white border-l-blue-500" :
                                                                    "bg-gradient-to-r from-amber-50 to-white border-l-amber-500"
                                                                )}
                                                            >
                                                                <div className="absolute -top-2 right-3 bg-gradient-to-r from-blue-500 to-purple-500 text-white text-[8px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide shadow">
                                                                    Final Decision
                                                                </div>
                                                                <div className="font-bold text-sm text-gray-900 mb-2 mt-1">{activeThread.finalDecision.title}</div>
                                                                <div className="text-xs text-gray-600 leading-relaxed bg-white/80 p-2 rounded border border-gray-100 italic line-clamp-3">
                                                                    "{activeThread.finalDecision.description}"
                                                                </div>

                                                                {/* Confidence indicator */}
                                                                <div className="mt-3 flex items-center gap-2">
                                                                    <span className="text-[9px] text-gray-500">Chain Confidence:</span>
                                                                    <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                                                                        <div
                                                                            className="h-full bg-gradient-to-r from-blue-400 to-purple-500 rounded-full"
                                                                            style={{ width: `${activeThread.causalChain.confidenceScore * 100}%` }}
                                                                        ></div>
                                                                    </div>
                                                                    <span className="text-[9px] font-bold text-gray-700">
                                                                        {(activeThread.causalChain.confidenceScore * 100).toFixed(0)}%
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="w-48 h-24 border-2 border-gray-200 border-dashed rounded-lg flex items-center justify-center text-xs text-gray-400 italic">
                                                                <Clock size={14} className="mr-2" /> Pending...
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center justify-center w-full h-full text-gray-400 gap-4 opacity-50">
                                                <Route size={64} />
                                                <div className="text-lg font-mono">Select a flow to view causal chain</div>
                                                <div className="text-sm">See how triggers led to decisions</div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* DEEP ANALYSIS TAB */}
                        {activeTab === 'ANALYSIS' && (
                            <div className="flex h-full w-full">
                                {/* OVERVIEW SIDEBAR */}
                                <div className="w-72 border-r border-gray-200 bg-white overflow-y-auto shrink-0 flex flex-col">
                                    <div className="p-3 bg-gradient-to-r from-teal-500 to-cyan-500 text-white">
                                        <div className="text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-2">
                                            <Microscope size={14} /> Deep Analysis
                                        </div>
                                        <div className="text-[10px] opacity-80">Conversation dynamics & patterns</div>
                                    </div>
                                    {threads.map(thread => (
                                        <button
                                            key={thread.id}
                                            onClick={() => setSelectedThreadId(thread.id)}
                                            className={clsx(
                                                "p-3 text-left border-b border-gray-100 hover:bg-gray-50 transition-colors group relative",
                                                selectedThreadId === thread.id ? "bg-teal-50/50 border-r-4 border-r-teal-500" : ""
                                            )}
                                        >
                                            <div className="font-mono text-xs font-bold text-gray-800 mb-1">{thread.component}</div>

                                            {/* Pattern Badges */}
                                            <div className="flex flex-wrap gap-1 mt-1">
                                                {thread.causalChain.patterns.map((p, idx) => (
                                                    <span key={idx} className={clsx("text-[9px] px-1.5 py-0.5 rounded border font-bold", p.color)}>
                                                        {p.type.split('_')[0]}
                                                    </span>
                                                ))}
                                                {thread.causalChain.patterns.length === 0 && <span className="text-[9px] text-gray-400 italic">No patterns</span>}
                                            </div>
                                        </button>
                                    ))}
                                </div>

                                {/* ANALYSIS CANVAS */}
                                <div className="flex-1 bg-white overflow-hidden flex flex-col">
                                    {activeThread ? (
                                        <div className="flex flex-col h-full">
                                            {/* Top: Stats Header */}
                                            <div className="p-6 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white flex justify-between items-start">
                                                <div>
                                                    <div className="text-xl font-bold text-gray-900 mb-2 flex items-center gap-2">
                                                        <Box size={20} className="text-gray-400" />
                                                        {activeThread.component}
                                                    </div>
                                                    <div className="flex gap-6">
                                                        <div className="flex flex-col">
                                                            <span className="text-[10px] font-bold text-gray-400 uppercase">Messages</span>
                                                            <span className="text-2xl font-mono font-bold text-gray-700">{activeThread.allMessages.length}</span>
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className="text-[10px] font-bold text-gray-400 uppercase">Participants</span>
                                                            <span className="text-2xl font-mono font-bold text-gray-700">{new Set(activeThread.allMessages.map(m => m.agentId)).size}</span>
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className="text-[10px] font-bold text-gray-400 uppercase">Avg Confidence</span>
                                                            <span className="text-2xl font-mono font-bold text-gray-700">{(activeThread.causalChain.confidenceScore * 100).toFixed(0)}%</span>
                                                        </div>
                                                        <div className="flex flex-col">
                                                            <span className="text-[10px] font-bold text-gray-400 uppercase">Impact Score</span>
                                                            <span className="text-2xl font-mono font-bold text-gray-700">{(activeThread.causalChain.impactScore * 100).toFixed(0)}%</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Pattern Cards */}
                                                <div className="flex gap-2 flex-wrap max-w-md justify-end">
                                                    {activeThread.causalChain.patterns.map((p, idx) => {
                                                        const Icon = p.icon;
                                                        return (
                                                            <div key={idx} className={clsx("border p-3 rounded-lg flex flex-col items-center min-w-[110px]", p.color)}>
                                                                <Icon size={18} className="mb-1" />
                                                                <div className="text-[10px] font-bold uppercase text-center leading-tight">{p.type.replace(/_/g, ' ')}</div>
                                                                <div className="text-[9px] opacity-70 mt-0.5">{(p.confidence * 100).toFixed(0)}% conf.</div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>

                                            {/* Center: Timeline Visualization */}
                                            <div className="h-48 border-b border-gray-200 p-4 relative overflow-hidden bg-gradient-to-r from-gray-50 to-white shrink-0">
                                                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                                                    <BarChart2 size={12}/> Interaction Density X-Ray
                                                </div>

                                                <div className="absolute top-1/2 left-4 right-4 h-px bg-gray-200"></div>
                                                <div className="flex items-center h-24 gap-1 overflow-x-auto custom-scrollbar pb-2 px-2">
                                                    {activeThread.allMessages.map((msg) => {
                                                        const role = classifyMessage(msg.text);
                                                        const colorClass = getRoleColor(role);
                                                        const bgClass = colorClass.split(' ')[0];

                                                        return (
                                                            <div key={msg.id} className="group relative shrink-0 flex flex-col items-center justify-center h-full w-4 hover:w-56 hover:z-10 transition-all duration-300">
                                                                <div className={clsx("w-2 h-12 rounded-full opacity-80 group-hover:h-16 group-hover:w-3 group-hover:opacity-100 transition-all", bgClass)}></div>

                                                                {/* Hover Detail Card */}
                                                                <div className="absolute bottom-full mb-2 bg-gray-900 text-white p-3 rounded-lg shadow-xl opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 w-64 -translate-x-1/2 left-1/2">
                                                                    <div className="flex items-center justify-between mb-1">
                                                                         <span className={clsx("font-bold text-[10px] uppercase px-1.5 py-0.5 rounded", colorClass)}>{role}</span>
                                                                         <span className="font-mono text-[9px] text-gray-400">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                                                    </div>
                                                                    <div className="text-xs leading-snug italic mt-1">"{msg.text}"</div>
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>

                                                {/* Legend */}
                                                <div className="flex gap-3 justify-end mt-2">
                                                    {(['OBSERVATION', 'TRIGGER', 'RATIONALE', 'SYNTHESIS', 'DECISION'] as ConversationRole[]).map(role => (
                                                        <div key={role} className="flex items-center gap-1">
                                                            <div className={clsx("w-2 h-2 rounded-full", getRoleColor(role).split(' ')[0])}></div>
                                                            <span className="text-[8px] text-gray-500 font-bold">{role}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            {/* Bottom: Coded Transcript */}
                                            <div className="flex-1 overflow-y-auto p-6 bg-gray-50">
                                                <div className="max-w-3xl mx-auto flex flex-col gap-3">
                                                    {activeThread.allMessages.map((msg) => {
                                                        const role = classifyMessage(msg.text);
                                                        const agent = agents.find(a => a.id === msg.agentId);
                                                        const colorClass = getRoleColor(role);
                                                        const Icon = getRoleIcon(role);

                                                        return (
                                                            <div key={msg.id} className="flex gap-4 group">
                                                                <div className="w-28 text-right pt-2 shrink-0">
                                                                    <div className={clsx("text-[10px] font-bold px-2 py-0.5 rounded inline-flex items-center gap-1", colorClass)}>
                                                                        <Icon size={10} /> {role}
                                                                    </div>
                                                                </div>
                                                                <div className="relative">
                                                                    <div className={clsx(
                                                                        "absolute top-3 -left-[6px] w-3 h-3 rounded-full border-2 border-white shadow",
                                                                        colorClass.split(' ')[0]
                                                                    )}></div>
                                                                    <div className="absolute top-0 bottom-0 -left-px w-px bg-gray-200 -z-10 group-last:bottom-auto group-last:h-4"></div>
                                                                </div>
                                                                <div className="flex-1 bg-white p-4 rounded-lg border border-gray-200 shadow-sm flex flex-col gap-1 hover:shadow-md transition-shadow">
                                                                    <div className="flex items-center gap-2 mb-1">
                                                                        <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shadow" style={{backgroundColor: agent?.color}}>{agent?.name[0]}</div>
                                                                        <span className="text-xs font-bold text-gray-700">{agent?.name}</span>
                                                                        <span className="text-[9px] text-gray-400 font-mono ml-auto">{new Date(msg.timestamp).toLocaleTimeString()}</span>
                                                                    </div>
                                                                    <div className="text-sm text-gray-800 leading-relaxed">
                                                                        {msg.text}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            </div>

                                        </div>
                                    ) : (
                                         <div className="flex flex-col items-center justify-center w-full h-full text-gray-400 gap-4 opacity-50">
                                            <Search size={64} />
                                            <div className="text-lg font-mono">Select a component to analyze</div>
                                            <div className="text-sm">View conversation dynamics and detected patterns</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                    </div>

                    {/* RIGHT PANEL: CONTEXTUAL TRANSCRIPT (Always Visible) */}
                    <div className="w-80 bg-white border-l border-gray-200 flex flex-col shrink-0">
                        <div className="p-3 border-b border-gray-100 bg-gray-50 flex items-center gap-2 text-gray-500 font-bold text-xs uppercase">
                            <MessageSquare size={14} /> Source Context
                        </div>
                        <div
                            ref={transcriptRef}
                            className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 custom-scrollbar bg-gray-50/30 relative"
                        >
                            {chatHistory.map(msg => {
                                const agent = agents.find(a => a.id === msg.agentId);
                                const isHighlighted = highlightedMsgIds.includes(msg.id);

                                return (
                                    <div
                                        key={msg.id}
                                        id={`summary-msg-${msg.id}`}
                                        className={clsx(
                                            "text-xs p-2 rounded transition-all duration-300",
                                            isHighlighted
                                                ? "bg-white border-l-4 border-blue-500 shadow-md opacity-100 scale-105 my-1"
                                                : "opacity-50 grayscale"
                                        )}
                                    >
                                        <div className="flex items-center gap-1 mb-1">
                                             <div className="w-1.5 h-1.5 rounded-full" style={{backgroundColor: agent?.color}}></div>
                                             <span className="font-mono font-bold text-[10px]" style={{color: agent?.color}}>{agent?.name}</span>
                                        </div>
                                        <div className="text-gray-700 leading-snug">{msg.text}</div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

// Sub-component for Draggable Card
const SummaryCard: React.FC<{
    card: InsightCard,
    agents: AgentState[],
    setHover: (id: string | null) => void,
    onClick: () => void,
    color: string
}> = ({ card, agents, setHover, onClick, color }) => {
    const agent = agents.find(a => a.id === card.agentId);
    return (
        <div
            draggable
            onDragStart={(e) => e.dataTransfer.setData("cardId", card.id)}
            onMouseEnter={() => setHover(card.id)}
            onMouseLeave={() => setHover(null)}
            onClick={onClick}
            className={clsx(
                "p-3 rounded-lg cursor-grab active:cursor-grabbing hover:scale-[1.02] transition-all relative border",
                color
            )}
        >
            <div className="font-bold text-gray-800 text-xs mb-1 leading-tight">{card.title}</div>
            <div className="text-[10px] text-gray-500 italic mb-2 line-clamp-2">"{card.description}"</div>

            <div className="flex items-center justify-between border-t border-gray-100 pt-2 mt-1">
                <div className="flex items-center gap-1.5">
                     <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white shadow-sm" style={{backgroundColor: agent?.color}}>
                        {agent?.name[0]}
                    </div>
                </div>

                {card.affectedRequirementIds && card.affectedRequirementIds.length > 0 && (
                     <div className="flex items-center gap-1 text-[9px] text-orange-500 font-bold bg-orange-50 px-1.5 py-0.5 rounded border border-orange-100">
                        <Scale size={8} /> REQ LINKED
                     </div>
                )}
            </div>
        </div>
    )
}

export default MeetingSummary;
