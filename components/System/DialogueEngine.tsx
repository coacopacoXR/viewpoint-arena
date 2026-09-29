import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useStore, getCurrentSceneTree } from '../../store';
import { InsightType, SceneNode } from '../../types';
import { usePresence } from '../../lib/PresenceContext';
import { useConnectorConfig } from '../../lib/config/ConfigContext';
import { MockCaptureProvider } from '../../lib/connectors/capture/mock';
import type { ConversationContext } from '../../lib/connectors/capture/mock';

export const findNodeName = (id: string, node: SceneNode): string | null => {
    if (node.id === id) return node.name;
    if (node.children) {
        for (const child of node.children) {
            const found = findNodeName(id, child);
            if (found) return found;
        }
    }
    return null;
};

// --- CONVERSATION CONTEXT TRACKER ---
export class ConversationContextManager {
    private contexts: Map<string, ConversationContext> = new Map();

    getContext(componentId: string, componentName: string): ConversationContext {
        if (!this.contexts.has(componentId)) {
            this.contexts.set(componentId, {
                componentId,
                componentName,
                step: 0,
                recentTopics: [],
                riskLevel: 'low',
                hasUserInteraction: false,
                previousSpeakers: [],
                activeDiscussion: null,
                reasoningDepth: 0,
                decisionsMade: []
            });
        }
        return this.contexts.get(componentId)!;
    }

    advanceContext(componentId: string, agentId: string, topic?: string) {
        const ctx = this.contexts.get(componentId);
        if (ctx) {
            ctx.step++;
            ctx.previousSpeakers.push(agentId);
            if (ctx.previousSpeakers.length > 5) ctx.previousSpeakers.shift();
            if (topic) {
                ctx.recentTopics.push(topic);
                if (ctx.recentTopics.length > 3) ctx.recentTopics.shift();
            }
        }
    }

    setRiskLevel(componentId: string, level: 'low' | 'medium' | 'high' | 'critical') {
        const ctx = this.contexts.get(componentId);
        if (ctx) ctx.riskLevel = level;
    }

    setUserInteraction(componentId: string, value: boolean) {
        const ctx = this.contexts.get(componentId);
        if (ctx) ctx.hasUserInteraction = value;
    }

    addDecision(componentId: string, decision: string) {
        const ctx = this.contexts.get(componentId);
        if (ctx) ctx.decisionsMade.push(decision);
    }
}


// --- MAIN COMPONENT ---
const DialogueEngine: React.FC = () => {
    const agents = useStore(state => state.agents);
    const hideAgents = useStore(state => state.hideAgents);
    const pois = useStore(state => state.pois);
    const isPlaying = useStore(state => state.isPlaying);
    const isPrivacyMode = useStore(state => state.isPrivacyMode);
    const addChatMessage = useStore(state => state.addChatMessage);
    const addInsightCard = useStore(state => state.addInsightCard);
    const { broadcastInsightCard } = usePresence();
    const requirements = useStore(state => state.requirements);
    const activeModelType = useStore(state => state.activeModelType);
    const objectStates = useStore(state => state.objectStates);

    const importedSceneTree = useStore(state => state.importedSceneTree);
    const connectorConfig = useConnectorConfig();
    const simulate = !connectorConfig.loading && connectorConfig.capture === 'mock';

    const lastSpeakTime = useRef<Record<string, number>>({});
    const messageBuffer = useRef<string[]>([]);
    const contextManager = useRef(new ConversationContextManager());
    const provider = useRef(new MockCaptureProvider()).current;
    const lastComponentIndex = useRef(0);

    // Decision state per component
    const poiDecisionState = useRef<Record<string, "NONE" | "INTERMEDIATE" | "FINAL">>({});

    // Get current scene tree (properly handles imported models)
    const currentTree = getCurrentSceneTree(activeModelType, importedSceneTree);

    // Get next component in round-robin fashion for structured discussion
    const getNextComponent = (): { name: string; id: string } => {
        const allNodes: { name: string; id: string }[] = [];
        const collectNodes = (node: SceneNode) => {
            allNodes.push({ name: node.name, id: node.id });
            if (node.children) node.children.forEach(collectNodes);
        };
        collectNodes(currentTree);

        lastComponentIndex.current = (lastComponentIndex.current + 1) % allNodes.length;
        return allNodes[lastComponentIndex.current];
    };

    useFrame(() => {
        // The simulation is the MOCK capture provider. With a real provider
        // (local, openai, ...) its invented dialogue and cards would be mixed in
        // with the real insights, indistinguishable in the tracker. Found in a
        // live run: real cards from a recording sat between simulated ones.
        // Nothing runs while the config is still loading, for the same reason.
        if (!simulate) return;
        // Don't generate dialogue when paused, in privacy mode, or agents hidden
        if (!isPlaying || isPrivacyMode || hideAgents) return;
        // Or when there is nothing in the room to talk about. EMPTY_SCENE_TREE is a
        // childless leaf, so the round-robin below does not come to a halt in an
        // empty room — it cycles through its one node and has the agents discuss a
        // component called "No model", which becomes chat lines and insight cards,
        // and a card is tracker data. Findings on a part that does not exist are
        // worse than no findings (batch BI).
        if (activeModelType === 'none') return;

        agents.forEach(agent => {
            const now = Date.now();
            const last = lastSpeakTime.current[agent.id] || 0;
            const isInspecting = agent.behavior === 'INSPECTING' && agent.currentPoiId;

            // FASTER timing for 10-min demo - generate more insights quickly
            const baseInterval = 1800; // Reduced from 3500ms
            const randomInterval = Math.random() * 2500; // Reduced from 5000ms

            if (now - last > (baseInterval + randomInterval)) {
                // Higher probability - 70% chance to speak (was 55%)
                if (Math.random() > 0.30) {
                    // Check if user has selected a component in the tree
                    const userSelectedId = Object.keys(objectStates).find(key => objectStates[key].selected);

                    if (userSelectedId) {
                        // User selected something - focus on that
                        const name = findNodeName(userSelectedId, currentTree);
                        if (name) {
                            generateDialogue(agent.id, name, userSelectedId);
                            lastSpeakTime.current[agent.id] = now;
                        }
                    } else if (isInspecting && agent.currentPoiId) {
                        // Agent inspecting a POI
                        const poi = pois.find(p => p.id === agent.currentPoiId);
                        if (poi) {
                            generateDialogue(agent.id, poi.label, poi.id);
                            lastSpeakTime.current[agent.id] = now;
                        }
                    } else {
                        // No user selection or POI - pick from model tree components
                        const component = getNextComponent();
                        generateDialogue(agent.id, component.name, component.id);
                        lastSpeakTime.current[agent.id] = now;
                    }
                }
            }
        });
    });

    const generateDialogue = (agentId: string, poiLabel: string, poiId: string) => {
        const state = useStore.getState();
        const currentObjectStates = state.objectStates;
        const userSelectedId = Object.keys(currentObjectStates).find(key => currentObjectStates[key].selected);

        let targetLabel = poiLabel;
        let targetId = poiId;
        let isUserDriven = false;

        if (userSelectedId) {
            const name = findNodeName(userSelectedId, currentTree);
            if (name) {
                targetLabel = name;
                targetId = userSelectedId;
                isUserDriven = true;
            }
        }

        // Get or create conversation context
        const context = contextManager.current.getContext(targetId, targetLabel);
        contextManager.current.advanceContext(targetId, agentId);

        if (isUserDriven) {
            contextManager.current.setUserInteraction(targetId, true);
        }

        // --- PURE DIALOGUE GENERATION (extracted for testability) ---
        const { template, text } = provider.generateDialogue(
            agentId, targetLabel, context.step, isUserDriven, state.activeModelType
        );

        // Update risk level if risk detected
        if (template.type === 'risk') {
            contextManager.current.setRiskLevel(targetId, 'high');
        }

        const messageId = Math.random().toString(36).substr(2, 9);
        addChatMessage({ id: messageId, agentId, text, timestamp: Date.now() });
        messageBuffer.current.push(messageId);
        if (messageBuffer.current.length > 5) messageBuffer.current.shift();

        // Insight capture logic - INCREASED CAPTURE RATE for demo
        if (template.type === 'action' || template.type === 'risk' || template.type === 'rationale' || template.type === 'synthesis' || isUserDriven) {
            // Higher capture rate: 80% for user-driven, 70% for AI-driven (was 50%)
            const shouldCapture = isUserDriven || Math.random() > 0.30;

            if (shouldCapture) {
                setTimeout(() => {
                    let type: InsightType = 'ACTION';
                    if (template.type === 'risk') type = 'RISK';
                    if (template.type === 'rationale' || template.type === 'synthesis') type = 'RATIONALE';

                    const currentDecState = poiDecisionState.current[targetId] || "NONE";
                    const details = provider.generateInsightDetails(type, targetId, targetLabel, currentDecState, template);

                    // Update Decision State
                    if (type === 'ACTION') {
                        if (currentDecState === "NONE") poiDecisionState.current[targetId] = "INTERMEDIATE";
                        else poiDecisionState.current[targetId] = "FINAL";
                        contextManager.current.addDecision(targetId, template.summary || "Decision");
                    }

                    const sourceIds = [...messageBuffer.current];
                    const affectedReqs: string[] = [];
                    if ((type === 'RISK' || type === 'ACTION') && Math.random() > 0.4 && requirements.length > 0) {
                        affectedReqs.push(requirements[Math.floor(Math.random() * requirements.length)].id);
                    }

                    const newCard = {
                        id: Math.random().toString(36).substr(2, 9),
                        agentId,
                        type,
                        title: isUserDriven ? `User Focus: ${targetLabel}` : (template.summary || "Design Analysis"),
                        description: text,
                        timestamp: Date.now(),
                        relatedPoiId: targetId,
                        sourceMessageIds: sourceIds,
                        details,
                        affectedRequirementIds: affectedReqs
                    };
                    addInsightCard(newCard);
                    broadcastInsightCard(newCard);
                }, 500);
            }
        }
    };

    return null;
};

export default DialogueEngine;
