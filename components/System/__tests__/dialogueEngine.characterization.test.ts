// Characterization tests for DialogueEngine.tsx's pure generation logic.
//
// These tests pin the CURRENT output of the dialogue generation so that
// extracting MockProvider (T3.6 step 2) can prove "output unchanged."
// There is no "correct" output — the values are whatever the engine
// produces today with a deterministic PRNG and fixed clock.
//
// Determinism strategy:
//   - Math.random is replaced with a seeded mulberry32 PRNG via vi.stubGlobal.
//   - Date.now is pinned to a fixed timestamp via vi.stubGlobal.
//   - Both are restored in afterAll.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { SceneNode } from '../../../types';
import { findNodeName, ConversationContextManager } from '../DialogueEngine';
import {
    generateDetails,
    buildEnhancedDialogue,
    generateDialogueOutput,
} from '../../../lib/connectors/capture/mock';
import type { ConversationContext, EnhancedPhraseTemplate } from '../../../lib/connectors/capture/mock';

// ---------------------------------------------------------------------------
// Seeded PRNG — simple LCG (deterministic, no Math.imul dependency)
// ---------------------------------------------------------------------------
function createSeededRandom(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state * 1664525 + 1013904223) & 0xffffffff;
        return (state >>> 0) / 0xffffffff;
    };
}

const FIXED_TIMESTAMP = 1700000000000; // 2023-11-14T22:13:20.000Z

beforeAll(() => {
    const prng = createSeededRandom(42);
    vi.spyOn(Math, 'random').mockImplementation(prng);
    vi.spyOn(Date, 'now').mockImplementation(() => FIXED_TIMESTAMP);
});

afterAll(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
    return {
        componentId: 'comp-1',
        componentName: 'TestPart',
        step: 0,
        recentTopics: [],
        riskLevel: 'low',
        hasUserInteraction: false,
        previousSpeakers: [],
        activeDiscussion: null,
        reasoningDepth: 0,
        decisionsMade: [],
        ...overrides,
    };
}

function makeTemplate(overrides: Partial<EnhancedPhraseTemplate> = {}): EnhancedPhraseTemplate {
    return {
        text: 'Examining the {poi} surface finish.',
        type: 'neutral',
        technicalDepth: 'medium',
        emotionalTone: 'neutral',
        ...overrides,
    };
}

const TEST_TREE: SceneNode = {
    id: 'root',
    name: 'Assembly',
    type: 'GROUP',
    children: [
        {
            id: 'frame',
            name: 'Frame',
            type: 'GROUP',
            children: [
                { id: 'tube-a', name: 'Top Tube', type: 'PART' },
                { id: 'tube-b', name: 'Down Tube', type: 'PART' },
            ],
        },
        {
            id: 'fork',
            name: 'Fork',
            type: 'PART',
        },
    ],
};

// ============================================================================
// findNodeName
// ============================================================================
describe('findNodeName', () => {
    it('returns the name of the root when the id matches', () => {
        expect(findNodeName('root', TEST_TREE)).toMatchInlineSnapshot(`"Assembly"`);
    });

    it('finds a deeply nested node by id', () => {
        expect(findNodeName('tube-a', TEST_TREE)).toMatchInlineSnapshot(`"Top Tube"`);
    });

    it('finds a top-level child', () => {
        expect(findNodeName('fork', TEST_TREE)).toMatchInlineSnapshot(`"Fork"`);
    });

    it('returns null when the id is not in the tree', () => {
        expect(findNodeName('nonexistent', TEST_TREE)).toMatchInlineSnapshot(`null`);
    });
});

// ============================================================================
// generateDetails
// ============================================================================
describe('generateDetails', () => {
    it('RISK with reasoningChain confidence > 0.85', () => {
        const tpl = makeTemplate({
            type: 'risk',
            reasoningChain: {
                trigger: 'wall thickness',
                observation: 'rapid transition',
                hypothesis: 'sink risk',
                analysis: 'exceeds guideline',
                implication: 'visible sink on A-surface',
                confidence: 0.92,
            },
        });
        expect(generateDetails('RISK', 'poi-1', 'Bracket', 'NONE', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Sarah J. (Ergo)",
            "componentReference": "Bracket",
            "decisionRole": "TRIGGER",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-15",
            "impact": "visible sink on A-surface",
            "mitigationStrategy": "Add gas-assist channels for thick sections",
            "priority": "Critical",
            "status": "Open",
          }
        `);
    });

    it('RISK with reasoningChain confidence 0.7–0.85', () => {
        const tpl = makeTemplate({
            type: 'risk',
            reasoningChain: {
                trigger: 'clearance',
                observation: 'tight gap',
                hypothesis: 'thermal issue',
                analysis: 'CTE growth',
                implication: 'possible interference',
                confidence: 0.78,
            },
        });
        expect(generateDetails('RISK', 'poi-2', 'Housing', 'INTERMEDIATE', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Sarah J. (Ergo)",
            "componentReference": "Housing",
            "decisionRole": "TRIGGER",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-17",
            "impact": "possible interference",
            "mitigationStrategy": "Increase local wall thickness by 15%",
            "priority": "Critical",
            "status": "Open",
          }
        `);
    });

    it('RISK without reasoningChain (fallback priority)', () => {
        const tpl = makeTemplate({ type: 'risk' });
        expect(generateDetails('RISK', 'poi-3', 'Cover', 'FINAL', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Alex Chen (Lead)",
            "componentReference": "Cover",
            "decisionRole": "TRIGGER",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-21",
            "impact": "Potential production impact",
            "mitigationStrategy": "Evaluate alternative material grade",
            "priority": "Critical",
            "status": "Open",
          }
        `);
    });

    it('RATIONALE with decisionState NONE', () => {
        const tpl = makeTemplate({
            type: 'rationale',
            reasoningChain: { confidence: 0.9 },
        });
        expect(generateDetails('RATIONALE', 'poi-4', 'Rib', 'NONE', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Marcus T. (DFM)",
            "componentReference": "Rib",
            "decisionRole": "RATIONALE",
            "designDriver": "Aesthetic Specification",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-18",
            "priority": "Critical",
            "status": "Open",
            "tradeoffAnalysis": "Material Cost vs. Processing Window",
          }
        `);
    });

    it('RATIONALE with decisionState FINAL', () => {
        const tpl = makeTemplate({ type: 'rationale' });
        expect(generateDetails('RATIONALE', 'poi-5', 'Boss', 'FINAL', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Alex Chen (Lead)",
            "componentReference": "Boss",
            "decisionRole": "RATIONALE",
            "designDriver": "User Ergonomics",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-15",
            "priority": "Medium",
            "status": "Open",
            "tradeoffAnalysis": "Material Cost vs. Processing Window",
          }
        `);
    });

    it('ACTION with decisionState NONE → INTERMEDIATE_DECISION', () => {
        const tpl = makeTemplate({ type: 'action' });
        expect(generateDetails('ACTION', 'poi-6', 'Bracket', 'NONE', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Mfg. Engineering",
            "componentReference": "Bracket",
            "decisionRole": "INTERMEDIATE_DECISION",
            "department": "Mechanical Eng",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-16",
            "priority": "High",
            "status": "Open",
          }
        `);
    });

    it('ACTION with decisionState INTERMEDIATE → FINAL_DECISION', () => {
        const tpl = makeTemplate({ type: 'action' });
        expect(generateDetails('ACTION', 'poi-7', 'Bracket', 'INTERMEDIATE', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Sarah J. (Ergo)",
            "componentReference": "Bracket",
            "decisionRole": "FINAL_DECISION",
            "department": "Mechanical Eng",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-21",
            "priority": "Medium",
            "status": "Open",
          }
        `);
    });

    it('ACTION with decisionState FINAL → FINAL_DECISION', () => {
        const tpl = makeTemplate({ type: 'action' });
        expect(generateDetails('ACTION', 'poi-8', 'Bracket', 'FINAL', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Sarah J. (Ergo)",
            "componentReference": "Bracket",
            "decisionRole": "FINAL_DECISION",
            "department": "Mechanical Eng",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-20",
            "priority": "High",
            "status": "Open",
          }
        `);
    });

    it('default type (neutral template) returns base details', () => {
        const tpl = makeTemplate({ type: 'neutral' });
        expect(generateDetails('ACTION', 'poi-9', 'Surface', 'NONE', tpl)).toMatchInlineSnapshot(`
          {
            "assignee": "Alex Chen (Lead)",
            "componentReference": "Surface",
            "decisionRole": "INTERMEDIATE_DECISION",
            "department": "Mechanical Eng",
            "designStage": "DETAILED_DESIGN",
            "dueDate": "2023-11-15",
            "priority": "Medium",
            "status": "Open",
          }
        `);
    });
});

// ============================================================================
// buildEnhancedDialogue
// ============================================================================
describe('buildEnhancedDialogue', () => {
    const ctx = makeContext();

    it('agent 1, deep neutral, AI-driven', () => {
        const tpl = makeTemplate({ technicalDepth: 'deep', emotionalTone: 'curious' });
        expect(buildEnhancedDialogue('1', 'Top Tube', tpl, ctx, false)).toMatchInlineSnapshot(`"Based on my analysis of examining the Top Tube surface finish."`);
    });

    it('agent 2, deep risk with reasoningChain, AI-driven', () => {
        const tpl = makeTemplate({
            type: 'risk',
            technicalDepth: 'deep',
            emotionalTone: 'concerned',
            reasoningChain: { implication: 'fatigue risk', confidence: 0.88 },
        });
        expect(buildEnhancedDialogue('2', 'Down Tube', tpl, ctx, false)).toMatchInlineSnapshot(`"The technical data suggests that examining the Down Tube surface finish."`);
    });

    it('agent 3, medium rationale, AI-driven', () => {
        const tpl = makeTemplate({
            type: 'rationale',
            technicalDepth: 'medium',
            emotionalTone: 'confident',
        });
        expect(buildEnhancedDialogue('3', 'Fork', tpl, ctx, false)).toMatchInlineSnapshot(`"Examining the Fork surface finish."`);
    });

    it('agent 1, deep neutral, user-driven (adds prefix)', () => {
        const tpl = makeTemplate({ technicalDepth: 'deep' });
        expect(buildEnhancedDialogue('1', 'Top Tube', tpl, ctx, true)).toMatchInlineSnapshot(`"The Top Tube you've selected is interesting because considering the assembly flow, examining the Top Tube surface finish."`);
    });

    it('agent 2, medium questioning with requiresFollowUp, AI-driven', () => {
        const tpl = makeTemplate({
            type: 'questioning',
            technicalDepth: 'medium',
            requiresFollowUp: true,
        });
        expect(buildEnhancedDialogue('2', 'Frame', tpl, ctx, false)).toMatchInlineSnapshot(`"Examining the Frame surface finish. We should discuss this further."`);
    });

    it('agent 3, deep action, user-driven', () => {
        const tpl = makeTemplate({
            type: 'action',
            technicalDepth: 'deep',
            emotionalTone: 'assertive',
        });
        expect(buildEnhancedDialogue('3', 'Fork', tpl, ctx, true)).toMatchInlineSnapshot(`"Good eye on the Fork. Now that you've highlighted it, I can see thinking about the user experience, examining the Fork surface finish."`);
    });

    it('unknown agent falls back to agent 1 personality', () => {
        const tpl = makeTemplate({ technicalDepth: 'deep' });
        expect(buildEnhancedDialogue('99', 'Top Tube', tpl, ctx, false)).toMatchInlineSnapshot(`"Examining the Top Tube surface finish."`);
    });

    it('agent 1, shallow template (no personality opening)', () => {
        const tpl = makeTemplate({ technicalDepth: 'shallow' });
        expect(buildEnhancedDialogue('1', 'Top Tube', tpl, ctx, false)).toMatchInlineSnapshot(`"Examining the Top Tube surface finish."`);
    });

    it('agent 2, deep rationale with reasoningChain confidence > 0.8', () => {
        const tpl = makeTemplate({
            type: 'rationale',
            technicalDepth: 'deep',
            reasoningChain: { implication: 'improved flow', confidence: 0.95 },
        });
        expect(buildEnhancedDialogue('2', 'Housing', tpl, ctx, false)).toMatchInlineSnapshot(`"Examining the Housing surface finish."`);
    });

    it('agent 3, medium risk without reasoningChain, AI-driven', () => {
        const tpl = makeTemplate({
            type: 'risk',
            technicalDepth: 'medium',
            emotionalTone: 'concerned',
        });
        expect(buildEnhancedDialogue('3', 'Cover', tpl, ctx, false)).toMatchInlineSnapshot(`"Examining the Cover surface finish."`);
    });

    it('agent 1, deep synthesis, user-driven', () => {
        const tpl = makeTemplate({
            type: 'synthesis',
            technicalDepth: 'deep',
        });
        expect(buildEnhancedDialogue('1', 'Bracket', tpl, ctx, true)).toMatchInlineSnapshot(`"The Bracket you've selected is interesting because considering the assembly flow, examining the Bracket surface finish."`);
    });

    it('agent 2, medium neutral, user-driven', () => {
        const tpl = makeTemplate({ technicalDepth: 'medium' });
        expect(buildEnhancedDialogue('2', 'Tube', tpl, ctx, true)).toMatchInlineSnapshot(`"You've identified a key area on the Tube. Let me add that examining the Tube surface finish."`);
    });
});

// ============================================================================
// generateDialogueOutput — full pipeline (template selection + text)
// ============================================================================
describe('generateDialogueOutput', () => {
    // Phase × agent × model × user-driven combinations — each as a separate
    // it() block so that toMatchInlineSnapshot has a unique source location per case.

    // Phase 1 (step 0-2): Observation
    it('agent1-phase1-generic-ai', () => {
        const ctx = makeContext({ step: 0, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": null,
            "templateType": "neutral",
            "text": "Running my eye along the TestPart, I notice the curvature transitions aren't quite G2 continuous at the edge blend.",
          }
        `);
    });
    it('agent2-phase1-bicycle-ai', () => {
        const ctx = makeContext({ step: 1, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": null,
            "templateType": "neutral",
            "text": "Looking at the TestPart, the weld bead consistency appears excellent. I'm measuring approximately 3mm bead width which is within our spec for TIG welding.",
          }
        `);
    });
    it('agent3-phase1-generic-user', () => {
        const ctx = makeContext({ step: 2, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, true, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "questioning",
            "text": "That's a critical detail on the TestPart. From my analysis, the TestPart mounting interface shows a 0.3mm step that wasn't in the last revision. Was this intentional? We should discuss this further.",
          }
        `);
    });

    // Phase 2 (step 3-6): Analysis
    it('agent1-phase2-generic-ai', () => {
        const ctx = makeContext({ step: 3, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RISK",
            "templateType": "risk",
            "text": "Considering the assembly flow, the undercut geometry on the TestPart is more aggressive than we've previously tooled. We're looking at a 12-degree undercut which will require either a lifter or a side action. Cost implication could be significant.",
          }
        `);
    });
    it('agent2-phase2-bicycle-ai', () => {
        const ctx = makeContext({ step: 5, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RISK",
            "templateType": "risk",
            "text": "I'm seeing potential galvanic corrosion risk at the TestPart. The aluminum seatpost in a steel frame without proper isolation could cause issues in wet conditions.",
          }
        `);
    });
    it('agent3-phase2-generic-user', () => {
        const ctx = makeContext({ step: 6, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, true, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "questioning",
            "text": "Good eye on the TestPart. Now that you've highlighted it, I can see has anyone validated the TestPart assembly sequence in the AR environment? I want to make sure our technicians can actually reach the fastener locations. We should discuss this further.",
          }
        `);
    });

    // Phase 3 (step 7-10): Deep Dive
    it('agent1-phase3-generic-ai', () => {
        const ctx = makeContext({ step: 7, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RATIONALE",
            "templateType": "rationale",
            "text": "The reason we offset the TestPart by 0.15mm from center is to compensate for the expected shrinkage differential. Left and right sides cool at different rates, so this pre-compensation keeps the final part symmetric.",
          }
        `);
    });
    it('agent2-phase3-bicycle-ai', () => {
        const ctx = makeContext({ step: 9, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RATIONALE",
            "templateType": "rationale",
            "text": "The 1x drivetrain on the TestPart was chosen to simplify the cockpit - no front derailleur means one less cable, cleaner aesthetics, and less for the user to adjust.",
          }
        `);
    });
    it('agent3-phase3-generic-user', () => {
        const ctx = makeContext({ step: 10, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, true, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RISK",
            "templateType": "risk",
            "text": "The TestPart you've selected is interesting because the TestPart rib pattern looks susceptible to knit line formation. The flow front will meet at approximately 70% fill, which is our danger zone for weld line strength. This matters because reduced rib strength by 20-40%. Based on similar projects, this is a high-confidence assessment.",
          }
        `);
    });

    // Phase 4 (step 11+): Decision
    it('agent1-phase4-generic-ai', () => {
        const ctx = makeContext({ step: 11, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "action",
            "text": "Based on this discussion, I'm going to action a moldflow analysis on the TestPart with specific attention to the weld line locations. We need to know if they coincide with high-stress regions.",
          }
        `);
    });
    it('agent2-phase4-bicycle-ai', () => {
        const ctx = makeContext({ step: 15, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RATIONALE",
            "templateType": "rationale",
            "text": "We went with hydraulic disc brakes on the TestPart rather than mechanical for consistent stopping power in wet conditions. The sealed system requires less maintenance for daily commuters.",
          }
        `);
    });
    it('agent3-phase4-generic-user', () => {
        const ctx = makeContext({ step: 20, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, true, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RATIONALE",
            "templateType": "rationale",
            "text": "The TestPart you've selected is interesting because looking at how this serves the user, the TestPart uses a living hinge design rated for 500K cycles. We validated this with accelerated testing at 3x frequency and the Nylon 6/6 showed no crack propagation after 1.5M cycles.",
          }
        `);
    });

    // Extra coverage combinations
    it('agent1-phase1-bicycle-user', () => {
        const ctx = makeContext({ step: 0, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, true, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "questioning",
            "text": "That's a critical detail on the TestPart. From my analysis, has anyone checked the TestPart brake hose routing? I want to make sure we have enough length for full lock-to-lock steering without binding.",
          }
        `);
    });
    it('agent2-phase2-generic-ai', () => {
        const ctx = makeContext({ step: 4, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RISK",
            "templateType": "risk",
            "text": "The undercut geometry on the TestPart is more aggressive than we've previously tooled. We're looking at a 12-degree undercut which will require either a lifter or a side action. Cost implication could be significant. Connecting this to our requirements, increased tooling cost and lead time.",
          }
        `);
    });
    it('agent3-phase3-bicycle-ai', () => {
        const ctx = makeContext({ step: 8, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RATIONALE",
            "templateType": "rationale",
            "text": "The 1x drivetrain on the TestPart was chosen to simplify the cockpit - no front derailleur means one less cable, cleaner aesthetics, and less for the user to adjust.",
          }
        `);
    });
    it('agent1-phase4-bicycle-user', () => {
        const ctx = makeContext({ step: 12, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, true, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "action",
            "text": "Good eye on the TestPart. Now that you've highlighted it, I can see i'm calling for a fatigue test on the TestPart junction. We need 100,000 cycles at 1.5x max rider weight before I'm comfortable signing off.",
          }
        `);
    });
    it('agent2-phase1-generic-user', () => {
        const ctx = makeContext({ step: 2, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, true, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "neutral",
            "text": "The TestPart you've selected is interesting because i'm seeing some interesting geometry on the TestPart. The draft angles appear to vary from 1.5 to 3 degrees across the surface.",
          }
        `);
    });
    it('agent3-phase2-bicycle-user', () => {
        const ctx = makeContext({ step: 5, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, true, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "questioning",
            "text": "The TestPart you've selected is interesting because what's our weight target for the TestPart? The current build is showing 11.2kg complete and I want to know how much margin we have.",
          }
        `);
    });
    it('agent1-phase3-generic-ai-b', () => {
        const ctx = makeContext({ step: 10, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RISK",
            "templateType": "risk",
            "text": "The snap-fit on the TestPart has a 45-degree entry angle but only 30-degree retention. That's below our 1.5:1 ratio guideline for secure retention without permanent deformation.",
          }
        `);
    });
    it('agent2-phase4-generic-ai', () => {
        const ctx = makeContext({ step: 14, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "ACTION",
            "templateType": "action",
            "text": "Based on this discussion, I'm going to action a moldflow analysis on the TestPart with specific attention to the weld line locations. We need to know if they coincide with high-stress regions.",
          }
        `);
    });
    it('agent3-phase1-bicycle-ai', () => {
        const ctx = makeContext({ step: 1, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": null,
            "templateType": "visibility",
            "text": "Can we rotate to see the TestPart from the drive side? I want to check the derailleur hanger alignment.",
          }
        `);
    });
    it('agent1-phase2-generic-ai-b', () => {
        const ctx = makeContext({ step: 6, componentName: 'TestPart' });
        const result = generateDialogueOutput('1', 'TestPart', ctx, false, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": null,
            "templateType": "questioning",
            "text": "What's our fallback if the TestPart doesn't meet the stiffness target? Do we have a secondary design concept we can pivot to?",
          }
        `);
    });
    it('agent2-phase3-generic-user', () => {
        const ctx = makeContext({ step: 9, componentName: 'TestPart' });
        const result = generateDialogueOutput('2', 'TestPart', ctx, true, 'generic');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RISK",
            "templateType": "risk",
            "text": "You've identified a key area on the TestPart. Let me add that if we look at the structural aspects, the TestPart rib pattern looks susceptible to knit line formation. The flow front will meet at approximately 70% fill, which is our danger zone for weld line strength. This matters because reduced rib strength by 20-40%.",
          }
        `);
    });
    it('agent3-phase4-bicycle-ai', () => {
        const ctx = makeContext({ step: 18, componentName: 'TestPart' });
        const result = generateDialogueOutput('3', 'TestPart', ctx, false, 'bicycle');
        expect({ text: result.text, insightType: result.insightType, templateType: result.template.type }).toMatchInlineSnapshot(`
          {
            "insightType": "RATIONALE",
            "templateType": "rationale",
            "text": "We went with hydraulic disc brakes on the TestPart rather than mechanical for consistent stopping power in wet conditions. The sealed system requires less maintenance for daily commuters.",
          }
        `);
    });
});

// ============================================================================
// ConversationContextManager
// ============================================================================
describe('ConversationContextManager', () => {
    it('creates a default context for a new component', () => {
        const mgr = new ConversationContextManager();
        const ctx = mgr.getContext('c1', 'Part A');
        expect(ctx).toMatchInlineSnapshot(`
          {
            "activeDiscussion": null,
            "componentId": "c1",
            "componentName": "Part A",
            "decisionsMade": [],
            "hasUserInteraction": false,
            "previousSpeakers": [],
            "reasoningDepth": 0,
            "recentTopics": [],
            "riskLevel": "low",
            "step": 0,
          }
        `);
    });

    it('returns the same context on subsequent calls', () => {
        const mgr = new ConversationContextManager();
        const ctx1 = mgr.getContext('c1', 'Part A');
        mgr.advanceContext('c1', 'agent-1', 'topic-x');
        const ctx2 = mgr.getContext('c1', 'Part A');
        expect(ctx2.step).toMatchInlineSnapshot(`1`);
        expect(ctx2.recentTopics).toMatchInlineSnapshot(`
          [
            "topic-x",
          ]
        `);
        expect(ctx2.previousSpeakers).toMatchInlineSnapshot(`
          [
            "agent-1",
          ]
        `);
        expect(ctx1).toBe(ctx2);
    });

    it('advanceContext caps previousSpeakers at 5', () => {
        const mgr = new ConversationContextManager();
        mgr.getContext('c1', 'Part A');
        for (let i = 0; i < 8; i++) {
            mgr.advanceContext('c1', `agent-${i}`);
        }
        const ctx = mgr.getContext('c1', 'Part A');
        expect(ctx.previousSpeakers).toMatchInlineSnapshot(`
          [
            "agent-3",
            "agent-4",
            "agent-5",
            "agent-6",
            "agent-7",
          ]
        `);
    });

    it('advanceContext caps recentTopics at 3', () => {
        const mgr = new ConversationContextManager();
        mgr.getContext('c1', 'Part A');
        for (let i = 0; i < 6; i++) {
            mgr.advanceContext('c1', 'a', `topic-${i}`);
        }
        const ctx = mgr.getContext('c1', 'Part A');
        expect(ctx.recentTopics).toMatchInlineSnapshot(`
          [
            "topic-3",
            "topic-4",
            "topic-5",
          ]
        `);
    });

    it('setRiskLevel updates the risk level', () => {
        const mgr = new ConversationContextManager();
        mgr.getContext('c1', 'Part A');
        mgr.setRiskLevel('c1', 'high');
        expect(mgr.getContext('c1', 'Part A').riskLevel).toMatchInlineSnapshot(`"high"`);
    });

    it('setUserInteraction updates the flag', () => {
        const mgr = new ConversationContextManager();
        mgr.getContext('c1', 'Part A');
        mgr.setUserInteraction('c1', true);
        expect(mgr.getContext('c1', 'Part A').hasUserInteraction).toMatchInlineSnapshot(`true`);
    });

    it('addDecision appends to decisionsMade', () => {
        const mgr = new ConversationContextManager();
        mgr.getContext('c1', 'Part A');
        mgr.addDecision('c1', 'Freeze geometry');
        mgr.addDecision('c1', 'Review tolerance');
        expect(mgr.getContext('c1', 'Part A').decisionsMade).toMatchInlineSnapshot(`
          [
            "Freeze geometry",
            "Review tolerance",
          ]
        `);
    });

    it('tracks independent contexts for different components', () => {
        const mgr = new ConversationContextManager();
        mgr.getContext('c1', 'Part A');
        mgr.getContext('c2', 'Part B');
        mgr.advanceContext('c1', 'a1', 'topic-a');
        mgr.advanceContext('c2', 'a2', 'topic-b');
        expect(mgr.getContext('c1', 'Part A').step).toMatchInlineSnapshot(`1`);
        expect(mgr.getContext('c2', 'Part B').step).toMatchInlineSnapshot(`1`);
    });
});
