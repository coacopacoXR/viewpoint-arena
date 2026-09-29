// MockCaptureProvider — current DialogueEngine generation logic extracted
// behind the CaptureProvider interface with NO behaviour change.
// See docs/plan/02-connector-adapters.md §2.

import type { InsightType, InsightDetails } from '../../../types';
import type { CaptureProvider, DialogueOutput } from './types';
import type { HealthCheckResult } from '../../health/types';
import { HEALTH_DETAILS } from '../../health/details';

interface PersonalityProfile {
    id: string;
    name: string;
    expertise: string[];
    communicationStyle: 'analytical' | 'collaborative' | 'questioning' | 'decisive';
    riskTolerance: 'low' | 'medium' | 'high';
    focusAreas: string[];
    phrasePatterns: {
        opening: string[];
        reasoning: string[];
        conclusion: string[];
        challenge: string[];
        agreement: string[];
    };
}

const AGENT_PERSONALITIES: Record<string, PersonalityProfile> = {
    '1': {
        id: '1',
        name: 'SYS.OP',
        expertise: ['system integration', 'manufacturing', 'tolerance analysis'],
        communicationStyle: 'analytical',
        riskTolerance: 'low',
        focusAreas: ['clearances', 'assembly sequence', 'tooling'],
        phrasePatterns: {
            opening: [
                "From a systems perspective,",
                "Looking at the integration requirements,",
                "Considering the assembly flow,",
                "Based on my analysis of"
            ],
            reasoning: [
                "This is important because",
                "The underlying concern here is",
                "What drives this observation is",
                "The root cause appears to be"
            ],
            conclusion: [
                "Therefore, I recommend",
                "This leads me to suggest",
                "My assessment indicates we should",
                "Based on this analysis, the action is"
            ],
            challenge: [
                "However, we need to consider",
                "One critical factor we're missing is",
                "I'd push back slightly on that because",
                "Let me offer a counterpoint:"
            ],
            agreement: [
                "That aligns with my findings on",
                "Exactly, and building on that,",
                "I concur, and would add that",
                "That's consistent with what I'm seeing in"
            ]
        }
    },
    '2': {
        id: '2',
        name: 'ENG.UNIT',
        expertise: ['structural analysis', 'material science', 'FEA simulation'],
        communicationStyle: 'questioning',
        riskTolerance: 'medium',
        focusAreas: ['stress distribution', 'material properties', 'failure modes'],
        phrasePatterns: {
            opening: [
                "From an engineering standpoint,",
                "If we look at the structural aspects,",
                "The technical data suggests that",
                "Running through the calculations,"
            ],
            reasoning: [
                "The physics behind this is",
                "What's happening mechanically is",
                "The stress analysis reveals that",
                "Looking at the force vectors,"
            ],
            conclusion: [
                "We need to validate this with",
                "I'd recommend running",
                "The data points us toward",
                "This requires verification through"
            ],
            challenge: [
                "But have we considered the",
                "What about the edge case where",
                "I'm concerned about the scenario where",
                "My simulations show a different outcome when"
            ],
            agreement: [
                "The numbers support that assessment,",
                "My FEA results confirm",
                "That matches the empirical data showing",
                "The structural analysis aligns with"
            ]
        }
    },
    '3': {
        id: '3',
        name: 'DES.LEAD',
        expertise: ['design intent', 'user experience', 'aesthetics', 'ergonomics'],
        communicationStyle: 'collaborative',
        riskTolerance: 'high',
        focusAreas: ['user interaction', 'visual design', 'brand alignment'],
        phrasePatterns: {
            opening: [
                "From a design perspective,",
                "Thinking about the user experience,",
                "Considering the design intent,",
                "Looking at how this serves the user,"
            ],
            reasoning: [
                "The design rationale here was to",
                "We chose this approach because",
                "The thinking behind this decision was",
                "This serves the user need for"
            ],
            conclusion: [
                "Let's find a solution that balances",
                "We should explore alternatives that",
                "I propose we iterate on",
                "The design direction should move toward"
            ],
            challenge: [
                "But how does this impact the user when",
                "I'm worried about the perception of",
                "From a usability standpoint,",
                "The brand guidelines suggest we reconsider"
            ],
            agreement: [
                "That preserves the design intent while",
                "Good, that maintains the user experience and",
                "That solution elegantly addresses",
                "I appreciate how that balances aesthetics with"
            ]
        }
    }
};

// --- REASONING CHAIN TEMPLATES ---
interface ReasoningChain {
    trigger: string;           // What initiates this reasoning
    observation: string;       // What is observed
    hypothesis: string;        // Initial theory
    analysis: string;          // Deeper analysis
    implication: string;       // What it means
    recommendation: string;    // What to do
    confidence: number;        // 0-1 confidence level
}

export interface ConversationContext {
    componentId: string;
    componentName: string;
    step: number;
    recentTopics: string[];
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    hasUserInteraction: boolean;
    previousSpeakers: string[];
    activeDiscussion: string | null;
    reasoningDepth: number;
    decisionsMade: string[];
}

// --- EXPANDED PHRASE LIBRARY WITH REASONING TEMPLATES ---
export interface EnhancedPhraseTemplate {
    text: string;
    type: 'neutral' | 'risk' | 'rationale' | 'action' | 'visibility' | 'social' | 'questioning' | 'synthesis';
    summary?: string;
    reasoningChain?: Partial<ReasoningChain>;
    requiresFollowUp?: boolean;
    followUpTopics?: string[];
    technicalDepth: 'shallow' | 'medium' | 'deep';
    emotionalTone: 'neutral' | 'concerned' | 'confident' | 'curious' | 'assertive';
}

// --- BICYCLE-SPECIFIC DIALOGUE LIBRARY ---
const BICYCLE_PHRASE_LIBRARY: EnhancedPhraseTemplate[] = [
    // OBSERVATION PHASE
    {
        text: "Looking at the {poi}, the weld bead consistency appears excellent. I'm measuring approximately 3mm bead width which is within our spec for TIG welding.",
        type: 'neutral',
        technicalDepth: 'deep',
        emotionalTone: 'confident',
        summary: "Weld Quality Assessment"
    },
    {
        text: "The {poi} geometry uses a hydroformed profile. The wall thickness transitions look smooth from the buttressed ends to the center section.",
        type: 'neutral',
        technicalDepth: 'deep',
        emotionalTone: 'neutral'
    },
    {
        text: "I'm examining the {poi}. The butted tubing shows the internal profile stepping from 0.9mm at the ends down to 0.6mm in the center for weight optimization.",
        type: 'neutral',
        technicalDepth: 'deep',
        emotionalTone: 'curious'
    },
    // RISK IDENTIFICATION
    {
        text: "I need to flag a concern on the {poi}. The stress concentration at this junction shows 15% higher than our baseline. We're at 87% of yield strength under the worst-case loading scenario.",
        type: 'risk',
        summary: "Stress Concentration Risk",
        technicalDepth: 'deep',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'stress analysis',
            observation: 'elevated stress at junction',
            hypothesis: 'geometry creates stress riser',
            analysis: '87% of yield strength at peak load',
            implication: 'fatigue failure risk under repeated loading',
            confidence: 0.88
        }
    },
    {
        text: "The {poi} dropouts show a 0.2mm misalignment between left and right sides. This is outside our 0.1mm tolerance and will affect wheel tracking and brake alignment.",
        type: 'risk',
        summary: "Dropout Alignment Issue",
        technicalDepth: 'deep',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'dropout measurement',
            observation: '0.2mm lateral misalignment',
            hypothesis: 'fixture issue during welding',
            analysis: 'exceeds 0.1mm tolerance spec',
            implication: 'wheel tracking and brake rub issues',
            confidence: 0.92
        }
    },
    {
        text: "The fork rake on the {poi} measures 47mm, but our target was 45mm. This will affect trail calculation and handling feel - making the steering feel slower than intended.",
        type: 'risk',
        summary: "Fork Geometry Deviation",
        technicalDepth: 'deep',
        emotionalTone: 'concerned'
    },
    {
        text: "I'm seeing potential galvanic corrosion risk at the {poi}. The aluminum seatpost in a steel frame without proper isolation could cause issues in wet conditions.",
        type: 'risk',
        summary: "Galvanic Corrosion Risk",
        technicalDepth: 'medium',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'material interface analysis',
            observation: 'dissimilar metals in contact',
            hypothesis: 'electrolyte presence enables corrosion',
            analysis: 'aluminum and steel galvanic potential difference',
            implication: 'accelerated corrosion and seizure',
            confidence: 0.85
        }
    },
    // RATIONALE
    {
        text: "The reason we specified this particular geometry for the {poi} is to achieve a 72-degree head tube angle with 50mm of trail. This gives us the responsive handling our target rider expects.",
        type: 'rationale',
        summary: "Handling Geometry Rationale",
        technicalDepth: 'deep',
        emotionalTone: 'confident',
        reasoningChain: {
            trigger: 'geometry question',
            observation: '72-degree head angle specified',
            hypothesis: 'optimized for urban agility',
            analysis: '50mm trail provides quick steering',
            implication: 'suits target commuter use case',
            confidence: 0.95
        }
    },
    {
        text: "The {poi} uses 4130 chromoly steel instead of aluminum. The fatigue characteristics of steel allow for a lifetime warranty - it bends before breaking and doesn't have aluminum's finite fatigue life.",
        type: 'rationale',
        summary: "Material Selection Rationale",
        technicalDepth: 'deep',
        emotionalTone: 'confident'
    },
    {
        text: "We went with hydraulic disc brakes on the {poi} rather than mechanical for consistent stopping power in wet conditions. The sealed system requires less maintenance for daily commuters.",
        type: 'rationale',
        summary: "Brake System Rationale",
        technicalDepth: 'medium',
        emotionalTone: 'confident'
    },
    {
        text: "The 1x drivetrain on the {poi} was chosen to simplify the cockpit - no front derailleur means one less cable, cleaner aesthetics, and less for the user to adjust.",
        type: 'rationale',
        summary: "Drivetrain Simplification",
        technicalDepth: 'medium',
        emotionalTone: 'confident'
    },
    // ACTIONS
    {
        text: "I'm calling for a fatigue test on the {poi} junction. We need 100,000 cycles at 1.5x max rider weight before I'm comfortable signing off.",
        type: 'action',
        summary: "Fatigue Testing Required",
        technicalDepth: 'medium',
        emotionalTone: 'assertive'
    },
    {
        text: "Let's get the {poi} alignment checked on the frame jig before powder coating. I want confirmation we're within 0.5mm on all critical interfaces.",
        type: 'action',
        summary: "Alignment Verification",
        technicalDepth: 'medium',
        emotionalTone: 'assertive'
    },
    {
        text: "We need to validate the {poi} clearance with 700x42c tires. Our spec says 40c but marketing wants to claim 42c compatibility.",
        type: 'action',
        summary: "Tire Clearance Validation",
        technicalDepth: 'medium',
        emotionalTone: 'neutral'
    },
    {
        text: "I'm requesting a ride quality assessment from the test team on the {poi}. We need subjective feedback on the compliance versus our competitor benchmark.",
        type: 'action',
        summary: "Ride Quality Assessment",
        technicalDepth: 'medium',
        emotionalTone: 'neutral'
    },
    // QUESTIONING
    {
        text: "Has anyone checked the {poi} brake hose routing? I want to make sure we have enough length for full lock-to-lock steering without binding.",
        type: 'questioning',
        technicalDepth: 'medium',
        emotionalTone: 'curious',
        requiresFollowUp: true
    },
    {
        text: "What's our weight target for the {poi}? The current build is showing 11.2kg complete and I want to know how much margin we have.",
        type: 'questioning',
        technicalDepth: 'medium',
        emotionalTone: 'curious',
        requiresFollowUp: true
    },
    // SYNTHESIS
    {
        text: "Synthesizing the discussion on {poi}: the geometry is optimized for urban commuting, the material choice supports durability, but we need to verify the stress concentration at the junction before production.",
        type: 'synthesis',
        summary: "Design Summary",
        technicalDepth: 'deep',
        emotionalTone: 'neutral'
    },
    {
        text: "Looking at the {poi} holistically: the frame achieves our weight target, the geometry hits the handling goals, the main risk is the dropout alignment which we need to address in fixturing.",
        type: 'synthesis',
        summary: "Holistic Assessment",
        technicalDepth: 'deep',
        emotionalTone: 'confident'
    },
    // VISIBILITY & SOCIAL
    {
        text: "Can we rotate to see the {poi} from the drive side? I want to check the derailleur hanger alignment.",
        type: 'visibility',
        technicalDepth: 'shallow',
        emotionalTone: 'neutral'
    },
    {
        text: "Good catch on the {poi}. Let me add that to my notes.",
        type: 'social',
        technicalDepth: 'shallow',
        emotionalTone: 'neutral'
    }
];

// Deep technical dialogue library
const PHRASE_LIBRARY: EnhancedPhraseTemplate[] = [
    // ============================================================================
    // OBSERVATION PHASE - Initial Discoveries
    // ============================================================================
    {
        text: "I'm seeing some interesting geometry on the {poi}. The draft angles appear to vary from 1.5 to 3 degrees across the surface.",
        type: 'neutral',
        technicalDepth: 'medium',
        emotionalTone: 'curious',
        followUpTopics: ['draft angle', 'molding', 'surface finish']
    },
    {
        text: "Running my eye along the {poi}, I notice the curvature transitions aren't quite G2 continuous at the edge blend.",
        type: 'neutral',
        technicalDepth: 'deep',
        emotionalTone: 'neutral',
        summary: "Surface Continuity"
    },
    {
        text: "The {poi} mounting interface shows a 0.3mm step that wasn't in the last revision. Was this intentional?",
        type: 'questioning',
        technicalDepth: 'medium',
        emotionalTone: 'curious',
        requiresFollowUp: true
    },
    {
        text: "Looking at the cross-section of {poi}, the wall thickness profile seems optimized for flow length rather than structural performance.",
        type: 'neutral',
        technicalDepth: 'deep',
        emotionalTone: 'neutral'
    },
    {
        text: "I'm measuring the {poi} envelope. We're at 127.3mm which gives us 2.7mm margin to the package boundary.",
        type: 'neutral',
        technicalDepth: 'medium',
        emotionalTone: 'neutral'
    },

    // ============================================================================
    // RISK IDENTIFICATION - Concerns with Reasoning
    // ============================================================================
    {
        text: "I need to flag a concern on the {poi}. The wall thickness transitions from 2.8mm to 1.2mm over 15mm. That's a 57% reduction which historically causes sink marks in our PP grades.",
        type: 'risk',
        summary: "Sink Mark Risk",
        technicalDepth: 'deep',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'wall thickness variation',
            observation: 'rapid thickness transition',
            hypothesis: 'may cause cosmetic defects',
            analysis: 'ratio exceeds 40% guideline',
            implication: 'visible sink on A-surface',
            confidence: 0.85
        }
    },
    {
        text: "The undercut geometry on the {poi} is more aggressive than we've previously tooled. We're looking at a 12-degree undercut which will require either a lifter or a side action. Cost implication could be significant.",
        type: 'risk',
        summary: "Tooling Complexity",
        technicalDepth: 'deep',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'undercut angle',
            observation: '12-degree undercut detected',
            hypothesis: 'standard ejection not possible',
            analysis: 'requires complex tool action',
            implication: 'increased tooling cost and lead time',
            confidence: 0.92
        }
    },
    {
        text: "I'm worried about the {poi} clearance to the adjacent sub-assembly. We're at 0.35mm which is below our 0.5mm minimum for thermal expansion. When this heats up in operation, we could see interference.",
        type: 'risk',
        summary: "Thermal Interference Risk",
        technicalDepth: 'deep',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'clearance measurement',
            observation: '0.35mm gap detected',
            hypothesis: 'thermal expansion may cause contact',
            analysis: 'CTE calculation shows 0.22mm growth at max temp',
            implication: 'possible interference and wear',
            confidence: 0.78
        }
    },
    {
        text: "The {poi} rib pattern looks susceptible to knit line formation. The flow front will meet at approximately 70% fill, which is our danger zone for weld line strength.",
        type: 'risk',
        summary: "Structural Weld Lines",
        technicalDepth: 'deep',
        emotionalTone: 'concerned',
        reasoningChain: {
            trigger: 'rib geometry analysis',
            observation: 'flow path convergence point',
            hypothesis: 'knit lines will form at ribs',
            analysis: 'fill simulation indicates 70% fill merge',
            implication: 'reduced rib strength by 20-40%',
            confidence: 0.82
        }
    },
    {
        text: "The snap-fit on the {poi} has a 45-degree entry angle but only 30-degree retention. That's below our 1.5:1 ratio guideline for secure retention without permanent deformation.",
        type: 'risk',
        summary: "Snap-Fit Retention",
        technicalDepth: 'deep',
        emotionalTone: 'assertive'
    },

    // ============================================================================
    // RATIONALE - Design Intent Explanation with Chains
    // ============================================================================
    {
        text: "Let me explain the thinking behind the {poi} profile. We went with this rib pattern specifically to achieve a 15Hz natural frequency target, which keeps us above the excitation range of the motor vibration.",
        type: 'rationale',
        summary: "Vibration Design",
        technicalDepth: 'deep',
        emotionalTone: 'confident',
        reasoningChain: {
            trigger: 'rib pattern question',
            observation: 'specific rib spacing and height',
            hypothesis: 'designed for stiffness target',
            analysis: 'modal analysis showed 15Hz achievable',
            implication: 'no resonance with motor at 8Hz',
            confidence: 0.95
        }
    },
    {
        text: "The fillet radius on the {poi} was deliberately oversized to 2.5mm. This serves dual purpose: it improves flow during injection by 15% and reduces stress concentration at the corner by a factor of 3.",
        type: 'rationale',
        summary: "Multi-Function Geometry",
        technicalDepth: 'deep',
        emotionalTone: 'confident',
        reasoningChain: {
            trigger: 'fillet size question',
            observation: '2.5mm radius larger than typical',
            hypothesis: 'intentional for multiple benefits',
            analysis: 'moldflow and FEA both improved',
            implication: 'optimized for manufacturing and performance',
            confidence: 0.90
        }
    },
    {
        text: "The {poi} uses a living hinge design rated for 500K cycles. We validated this with accelerated testing at 3x frequency and the Nylon 6/6 showed no crack propagation after 1.5M cycles.",
        type: 'rationale',
        summary: "Durability Validation",
        technicalDepth: 'deep',
        emotionalTone: 'confident'
    },
    {
        text: "This texture on the {poi} is MT-11020 at 0.025mm depth. It's specified to hide flow lines and sink while maintaining grip coefficient above 0.4 for wet hands.",
        type: 'rationale',
        summary: "Texture Specification",
        technicalDepth: 'medium',
        emotionalTone: 'confident'
    },
    {
        text: "The reason we offset the {poi} by 0.15mm from center is to compensate for the expected shrinkage differential. Left and right sides cool at different rates, so this pre-compensation keeps the final part symmetric.",
        type: 'rationale',
        summary: "Shrinkage Compensation",
        technicalDepth: 'deep',
        emotionalTone: 'confident'
    },

    // ============================================================================
    // ACTION - Decisions and Tasks with Clear Owners
    // ============================================================================
    {
        text: "Based on this discussion, I'm going to action a moldflow analysis on the {poi} with specific attention to the weld line locations. We need to know if they coincide with high-stress regions.",
        type: 'action',
        summary: "Moldflow Analysis",
        technicalDepth: 'medium',
        emotionalTone: 'assertive'
    },
    {
        text: "Let's lock this down. I propose we freeze the {poi} geometry pending the tolerance stack-up verification. Design team to provide updated GD&T by EOD Thursday.",
        type: 'action',
        summary: "Design Freeze",
        technicalDepth: 'medium',
        emotionalTone: 'assertive'
    },
    {
        text: "We need supplier input on the {poi} texture feasibility. I'll reach out to our tooling partner to validate they can achieve MT-11020 on this geometry with the specified draft.",
        type: 'action',
        summary: "Supplier Validation",
        technicalDepth: 'medium',
        emotionalTone: 'neutral'
    },
    {
        text: "I'm calling for a tolerance review meeting on the {poi}. The stack-up shows we're at 87% of tolerance which is tighter than I'm comfortable with for volume production.",
        type: 'action',
        summary: "Tolerance Review",
        technicalDepth: 'medium',
        emotionalTone: 'concerned'
    },
    {
        text: "Let me add a checkpoint here. Before we proceed with the {poi} tooling release, we need sign-off from manufacturing engineering on the assembly sequence feasibility.",
        type: 'action',
        summary: "Manufacturing Approval",
        technicalDepth: 'medium',
        emotionalTone: 'assertive'
    },

    // ============================================================================
    // QUESTIONING - Prompting Deeper Analysis
    // ============================================================================
    {
        text: "Can someone walk me through the load path on the {poi}? I want to understand how forces transfer from the user interface through to the mounting points.",
        type: 'questioning',
        technicalDepth: 'deep',
        emotionalTone: 'curious',
        requiresFollowUp: true
    },
    {
        text: "What's our fallback if the {poi} doesn't meet the stiffness target? Do we have a secondary design concept we can pivot to?",
        type: 'questioning',
        technicalDepth: 'medium',
        emotionalTone: 'curious',
        requiresFollowUp: true
    },
    {
        text: "Has anyone validated the {poi} assembly sequence in the AR environment? I want to make sure our technicians can actually reach the fastener locations.",
        type: 'questioning',
        technicalDepth: 'medium',
        emotionalTone: 'curious',
        requiresFollowUp: true
    },

    // ============================================================================
    // SYNTHESIS - Bringing Ideas Together
    // ============================================================================
    {
        text: "So if I'm synthesizing the discussion on {poi}: we have a potential sink mark issue that could be addressed by either increasing wall thickness or adding ribs, but both options affect tooling cost. We need to quantify which path is more economical.",
        type: 'synthesis',
        summary: "Trade-off Analysis",
        technicalDepth: 'deep',
        emotionalTone: 'neutral'
    },
    {
        text: "Let me connect the dots on {poi}. The clearance issue, the thermal expansion concern, and the assembly sequence all point to the same root cause: we need to revisit the mounting boss locations.",
        type: 'synthesis',
        summary: "Root Cause Identified",
        technicalDepth: 'deep',
        emotionalTone: 'confident'
    },

    // ============================================================================
    // VISIBILITY & SOCIAL - Collaboration
    // ============================================================================
    {
        text: "I'm having trouble seeing the detail on the {poi}. Can we rotate to get a better angle on the interface region?",
        type: 'visibility',
        technicalDepth: 'shallow',
        emotionalTone: 'neutral'
    },
    {
        text: "Following your pointer to the {poi}. Good call highlighting that area.",
        type: 'social',
        technicalDepth: 'shallow',
        emotionalTone: 'neutral'
    },
    {
        text: "Let me move to your position so we're both looking at the {poi} from the same reference.",
        type: 'social',
        technicalDepth: 'shallow',
        emotionalTone: 'neutral'
    }
];

// --- USER CONTEXT RESPONSE TEMPLATES ---
const USER_CONTEXT_TEMPLATES = [
    "Good eye on the {poi}. Now that you've highlighted it, I can see",
    "Thanks for pointing out the {poi}. Building on your observation,",
    "You've identified a key area on the {poi}. Let me add that",
    "Following your focus on {poi}, I'd note that",
    "The {poi} you've selected is interesting because",
    "That's a critical detail on the {poi}. From my analysis,"
];

// --- REASONING DEPTH ENHANCERS ---
const REASONING_CONNECTORS = [
    "This matters because",
    "The implication here is that",
    "What this tells us is",
    "Connecting this to our requirements,",
    "In the context of our production goals,",
    "From a manufacturability standpoint, this means"
];

const EVIDENCE_STATEMENTS = [
    "Our historical data shows",
    "Based on similar projects,",
    "The supplier feedback indicated",
    "Testing has demonstrated that",
    "Industry standards suggest",
    "Our simulation results confirm"
];

// --- INSIGHT GENERATION ---
const ASSIGNEES = [
    "Alex Chen (Lead)",
    "Sarah J. (Ergo)",
    "Design Team A",
    "Mfg. Engineering",
    "Validation Lab",
    "Marcus T. (DFM)",
    "Quality Assurance"
];

const MITIGATIONS = [
    "Increase local wall thickness by 15%",
    "Add flow leaders to improve fill balance",
    "Modify rib geometry to shift weld lines",
    "Increase draft angle to 2 degrees minimum",
    "Add gas-assist channels for thick sections",
    "Conduct DOE on process parameters",
    "Evaluate alternative material grade"
];

const DRIVERS = [
    "Weight Optimization",
    "Cost Reduction Target",
    "Assembly Efficiency",
    "Durability Requirement",
    "Aesthetic Specification",
    "Regulatory Compliance",
    "User Ergonomics"
];

const TRADEOFFS = [
    "Weight vs. Stiffness (3:1 ratio targeted)",
    "Cost vs. Surface Finish Quality",
    "Cycle Time vs. Part Quality",
    "Tool Complexity vs. Part Count",
    "Material Cost vs. Processing Window"
];

const getRandomElement = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// Generate structured details based on role and type
export const generateDetails = (
    type: InsightType,
    targetId: string,
    targetLabel: string,
    decisionState: "NONE" | "INTERMEDIATE" | "FINAL",
    template: EnhancedPhraseTemplate
): InsightDetails => {
    const base: InsightDetails = {
        priority: template.reasoningChain?.confidence
            ? (template.reasoningChain.confidence > 0.85 ? 'Critical' : template.reasoningChain.confidence > 0.7 ? 'High' : 'Medium')
            : (Math.random() > 0.7 ? 'High' : 'Medium'),
        status: 'Open',
        assignee: getRandomElement(ASSIGNEES),
        dueDate: new Date(Date.now() + Math.random() * 604800000).toISOString().split('T')[0],
        designStage: "DETAILED_DESIGN",
        componentReference: targetLabel,
        decisionRole: undefined
    };

    if (type === 'RISK') {
        return {
            ...base,
            priority: 'Critical',
            decisionRole: 'TRIGGER',
            impact: template.reasoningChain?.implication || "Potential production impact",
            mitigationStrategy: getRandomElement(MITIGATIONS)
        };
    }

    if (type === 'RATIONALE') {
        return {
            ...base,
            decisionRole: 'RATIONALE',
            designDriver: getRandomElement(DRIVERS),
            tradeoffAnalysis: getRandomElement(TRADEOFFS)
        };
    }

    if (type === 'ACTION') {
        return {
            ...base,
            decisionRole: decisionState === 'NONE' ? 'INTERMEDIATE_DECISION' : 'FINAL_DECISION',
            department: "Mechanical Eng"
        };
    }

    return base;
};

// Build enhanced dialogue with personality and reasoning chains
export const buildEnhancedDialogue = (
    agentId: string,
    targetLabel: string,
    template: EnhancedPhraseTemplate,
    context: ConversationContext,
    isUserDriven: boolean
): string => {
    const personality = AGENT_PERSONALITIES[agentId] || AGENT_PERSONALITIES['1'];
    let dialogue = template.text.replace(/{poi}/g, targetLabel);

    // Add personality-driven opening for deeper analysis
    if (template.technicalDepth === 'deep' && Math.random() > 0.5) {
        const opening = getRandomElement(personality.phrasePatterns.opening);
        dialogue = `${opening} ${dialogue.charAt(0).toLowerCase()}${dialogue.slice(1)}`;
    }

    // Add reasoning connector for risk and rationale types
    if ((template.type === 'risk' || template.type === 'rationale') && template.reasoningChain && Math.random() > 0.4) {
        const connector = getRandomElement(REASONING_CONNECTORS);
        const evidence = getRandomElement(EVIDENCE_STATEMENTS);

        if (template.reasoningChain.implication) {
            dialogue += ` ${connector} ${template.reasoningChain.implication.toLowerCase()}.`;
        }
        if (template.reasoningChain.confidence && template.reasoningChain.confidence > 0.8 && Math.random() > 0.5) {
            dialogue += ` ${evidence} this is a high-confidence assessment.`;
        }
    }

    // Add context-aware prefix for user-driven interactions
    if (isUserDriven) {
        const prefixTemplate = getRandomElement(USER_CONTEXT_TEMPLATES);
        const prefix = prefixTemplate.replace(/{poi}/g, targetLabel);
        dialogue = `${prefix} ${dialogue.charAt(0).toLowerCase()}${dialogue.slice(1)}`;
    }

    // Add follow-up indication
    if (template.requiresFollowUp && Math.random() > 0.7) {
        dialogue += " We should discuss this further.";
    }

    return dialogue;
};

// Pure dialogue-output generator: template selection + text building.
// Extracted so it can be characterization-tested without React/store side effects.
export const generateDialogueOutput = (
    agentId: string,
    targetLabel: string,
    context: ConversationContext,
    isUserDriven: boolean,
    modelType: string
): { template: EnhancedPhraseTemplate; text: string; insightType: InsightType | null } => {
    const basePhraseLibrary = modelType === 'bicycle' ? BICYCLE_PHRASE_LIBRARY : PHRASE_LIBRARY;
    let candidates: EnhancedPhraseTemplate[];
    const step = context.step;

    if (step < 3) {
        candidates = basePhraseLibrary.filter(t =>
            t.type === 'neutral' || t.type === 'visibility' || t.type === 'questioning'
        );
    } else if (step < 7) {
        candidates = basePhraseLibrary.filter(t =>
            t.type === 'risk' || t.type === 'rationale' || t.type === 'questioning'
        );
    } else if (step < 11) {
        candidates = basePhraseLibrary.filter(t =>
            t.type === 'rationale' || t.type === 'synthesis' || t.type === 'risk'
        );
    } else {
        candidates = basePhraseLibrary.filter(t =>
            t.type === 'action' || t.type === 'synthesis' || t.type === 'rationale'
        );
    }

    if (isUserDriven) {
        candidates = candidates.filter(t => t.technicalDepth !== 'shallow');
        if (candidates.length === 0) {
            candidates = basePhraseLibrary.filter(t => t.type !== 'social' && t.type !== 'visibility');
        }
    }

    if (candidates.length === 0) candidates = basePhraseLibrary;

    const template = getRandomElement(candidates);
    const text = buildEnhancedDialogue(agentId, targetLabel, template, context, isUserDriven);

    let insightType: InsightType | null = null;
    if (template.type === 'action' || template.type === 'risk' || template.type === 'rationale' || template.type === 'synthesis' || isUserDriven) {
        if (template.type === 'risk') insightType = 'RISK';
        else if (template.type === 'rationale' || template.type === 'synthesis') insightType = 'RATIONALE';
        else insightType = 'ACTION';
    }

    return { template, text, insightType };
};

// --- MOCK CAPTURE PROVIDER ---
// Wraps the extracted generation functions behind the CaptureProvider interface.

export class MockCaptureProvider implements CaptureProvider {
    generateDialogue(
        agentId: string,
        partName: string,
        step: number,
        isUserDriven: boolean,
        modelType: string,
    ): DialogueOutput {
        const context = {
            componentId: partName,
            componentName: partName,
            step,
            recentTopics: [] as string[],
            riskLevel: 'low' as const,
            hasUserInteraction: isUserDriven,
            previousSpeakers: [] as string[],
            activeDiscussion: null,
            reasoningDepth: 0,
            decisionsMade: [] as string[],
        };
        return generateDialogueOutput(agentId, partName, context, isUserDriven, modelType);
    }

    generateInsightDetails(
        type: InsightType,
        targetId: string,
        targetLabel: string,
        decisionState: 'NONE' | 'INTERMEDIATE' | 'FINAL',
        template: { type: string; reasoningChain?: { confidence?: number; implication?: string } },
    ): InsightDetails {
        return generateDetails(type, targetId, targetLabel, decisionState, template as EnhancedPhraseTemplate);
    }

    /**
     * Always ok: the simulation is a phrase library living in this module, so
     * there is no network, no model host and no key that could be missing.
     * Saying so explicitly is what lets a default install report a green
     * /api/health with zero accounts configured.
     */
    async healthCheck(): Promise<HealthCheckResult> {
        return { ok: true, detail: HEALTH_DETAILS.selfContained };
    }
}
