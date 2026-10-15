import { create } from 'zustand';
import { ViewMode, RepresentationMode, PointOfInterest, AgentState, AgentStyle, ChatMessage, InsightCard, AgentBehaviorState, SceneNode, ObjectState, Requirement, KBEntry, InsightType, SpatialComment, CommentMode, ModelType, RightPanelMode, ReviewGizmoMode, ReviewGizmoTarget, BoardroomLayout, LiveChatMessage, ViewCapture } from './types';
import { Vector3, type Group } from 'three';
import { flushSessionToTracker } from './lib/trackerBridge';
import { writeMeetingMinutes } from './lib/capture/meetingMinutes';
import { buildTranscript } from './lib/capture/transcript';
import { isCapturePaused } from './lib/capture/captureGate';
// Both import nothing of their own, which is why endMeeting can read them: they are
// the two facts a meeting's record needs that live outside the store — when the
// recording ran, and whether its transcript is to be kept. See each module's header.
import { getRecordingState } from './lib/recordingState';
import { getTranscriptKeep } from './lib/transcriptKeep';
import { DEFAULT_MAX_COMPONENTS, flattenSceneTree, type FlatComponent } from './lib/componentIndex';
import { useReviewSetupStore } from './lib/reviewSetupStore';
// Read inside endMeeting only, and lib/activeReviewStore reads this store inside
// its own actions only — so the two never touch each other while a module is
// still being evaluated, which is what makes the import cycle between them safe.
import { useActiveReviewStore } from './lib/activeReviewStore';
import { usePointingTimelineStore } from './lib/pointingTimelineStore';
import type { ReviewLine } from './lib/reviews/lines';
import type { SceneModelEntry } from './lib/scene/sceneEntries';
import {
  applySceneUpdate,
  emptyScene,
  sceneModelLabel,
  type BuiltInModel,
  type ModelEditors,
  type RoomScene,
  type SceneModel,
  type SceneUpdate,
} from './lib/scene/roomScene';

/**
 * The names of every part anybody pointed at during this meeting, by node id.
 *
 * Read at meeting-end rather than tracked as cards arrive, because a card's
 * `componentReference` is a node id and the tree node's NAME is not on the card —
 * and the pointing timeline is the one place that already holds both together.
 * Later segments win, so a part renamed by a second model importing over the
 * first is recorded as the room last called it.
 */
function pointedAtPartNames(): Record<string, string> {
  const names: Record<string, string> = {};
  for (const segment of usePointingTimelineStore.getState().segments) {
    if (segment.partId && segment.partName) names[segment.partId] = segment.partName;
  }
  return names;
}

const INITIAL_AGENTS: AgentState[] = [
  { id: '1', name: 'SYS.OP', role: 'PRESENTER', color: '#ff4400', behavior: 'IDLE', currentPoiId: null, attentionLevel: 0 },
  { id: '2', name: 'ENG.UNIT', role: 'REVIEWER', color: '#0066ff', behavior: 'IDLE', currentPoiId: null, attentionLevel: 0 },
  { id: '3', name: 'DES.LEAD', role: 'OBSERVER', color: '#666666', behavior: 'IDLE', currentPoiId: null, attentionLevel: 0 },
  { id: '4', name: 'VR.USER', role: 'OBSERVER', color: '#8b5cf6', behavior: 'IDLE', currentPoiId: null, attentionLevel: 0 },
];

const INITIAL_WEIGHTS: Record<string, number> = {
  '1': 5,
  '2': 5,
  '3': 5,
  '4': 5
};

// --- MOCK KNOWLEDGE BASE ---
const KB_DB: KBEntry[] = [
    { id: 'kb1', category: 'RISK', triggerKeyword: 'clearance', recommendation: "Historical Action: Check tolerance stack-up analysis (Ref: Project Titan)." },
    { id: 'kb2', category: 'RISK', triggerKeyword: 'interference', recommendation: "Recommendation: Implement interference check in CAD assembly level 2." },
    { id: 'kb3', category: 'RATIONALE', triggerKeyword: 'stiffness', recommendation: "Standard: Use ribbing pattern C for injection molded chassis." },
    { id: 'kb4', category: 'ACTION', triggerKeyword: 'material', recommendation: "Action: Verify material availability with procurement lead (Lead Time > 4 wks)." },
];

// --- SCENE DEFINITION ---
export const SYNTH_SCENE_TREE: SceneNode = {
  id: 'assembly', name: 'Synth Assembly', type: 'GROUP', children: [
    { id: 'chassis_grp', name: 'Chassis Module', type: 'GROUP', children: [
        { id: 'main_body', name: 'Unibody Case', type: 'MESH' },
        { id: 'branding', name: 'Logo Plate', type: 'MESH' }
    ]},
    { id: 'interface', name: 'User Interface', type: 'GROUP', children: [
        { id: 'screen_grp', name: 'Display Unit', type: 'GROUP', children: [
            { id: 'screen_glass', name: 'OLED Panel', type: 'MESH' },
            { id: 'screen_ui', name: 'GUI Layer', type: 'MESH' }
        ]},
        { id: 'controls', name: 'Control Surface', type: 'GROUP', children: [
            { id: 'knobs_grp', name: 'Rotary Encoders', type: 'GROUP', children: [
                { id: 'knob-vol', name: 'Master Volume', type: 'PART' },
                { id: 'knob-filter', name: 'Filter Cutoff', type: 'PART' },
                { id: 'knob-res', name: 'Resonance', type: 'PART' }
            ]},
            { id: 'keybed', name: 'Keybed Assembly', type: 'GROUP' }
        ]}
    ]}
  ]
};

// --- BICYCLE SCENE TREE (Import Demo) ---
export const BICYCLE_SCENE_TREE: SceneNode = {
  id: 'bicycle_assembly', name: 'Urban Commuter Bicycle', type: 'GROUP', children: [
    { id: 'frame_grp', name: 'Frame Assembly', type: 'GROUP', children: [
        { id: 'main_frame', name: 'Main Frame', type: 'MESH' },
        { id: 'top_tube', name: 'Top Tube', type: 'MESH' },
        { id: 'down_tube', name: 'Down Tube', type: 'MESH' },
        { id: 'seat_tube', name: 'Seat Tube', type: 'MESH' },
        { id: 'chain_stays', name: 'Chain Stays', type: 'MESH' },
        { id: 'seat_stays', name: 'Seat Stays', type: 'MESH' },
        { id: 'head_tube', name: 'Head Tube', type: 'MESH' },
        { id: 'bottom_bracket', name: 'Bottom Bracket Shell', type: 'PART' }
    ]},
    { id: 'front_assembly', name: 'Front Assembly', type: 'GROUP', children: [
        { id: 'fork_grp', name: 'Fork Assembly', type: 'GROUP', children: [
            { id: 'fork_crown', name: 'Fork Crown', type: 'MESH' },
            { id: 'fork_blades', name: 'Fork Blades', type: 'MESH' },
            { id: 'fork_dropouts', name: 'Fork Dropouts', type: 'PART' }
        ]},
        { id: 'headset', name: 'Headset Bearings', type: 'PART' },
        { id: 'stem', name: 'Stem', type: 'MESH' },
        { id: 'handlebar', name: 'Handlebar', type: 'MESH' },
        { id: 'grips', name: 'Handlebar Grips', type: 'PART' },
        { id: 'front_brake_lever', name: 'Front Brake Lever', type: 'PART' }
    ]},
    { id: 'wheel_front', name: 'Front Wheel', type: 'GROUP', children: [
        { id: 'hub_front', name: 'Front Hub', type: 'PART' },
        { id: 'spokes_front', name: 'Front Spokes', type: 'MESH' },
        { id: 'rim_front', name: 'Front Rim', type: 'MESH' },
        { id: 'tire_front', name: 'Front Tire', type: 'MESH' }
    ]},
    { id: 'wheel_rear', name: 'Rear Wheel', type: 'GROUP', children: [
        { id: 'hub_rear', name: 'Rear Hub', type: 'PART' },
        { id: 'spokes_rear', name: 'Rear Spokes', type: 'MESH' },
        { id: 'rim_rear', name: 'Rear Rim', type: 'MESH' },
        { id: 'tire_rear', name: 'Rear Tire', type: 'MESH' },
        { id: 'cassette', name: 'Rear Cassette', type: 'PART' }
    ]},
    { id: 'drivetrain', name: 'Drivetrain', type: 'GROUP', children: [
        { id: 'crankset', name: 'Crankset', type: 'GROUP', children: [
            { id: 'crank_arms', name: 'Crank Arms', type: 'MESH' },
            { id: 'chainring', name: 'Chainring', type: 'MESH' },
            { id: 'pedals', name: 'Pedals', type: 'PART' }
        ]},
        { id: 'chain', name: 'Chain', type: 'MESH' },
        { id: 'derailleur_rear', name: 'Rear Derailleur', type: 'PART' }
    ]},
    { id: 'braking_system', name: 'Braking System', type: 'GROUP', children: [
        { id: 'brake_front', name: 'Front Disc Brake', type: 'GROUP', children: [
            { id: 'caliper_front', name: 'Front Caliper', type: 'PART' },
            { id: 'rotor_front', name: 'Front Rotor', type: 'MESH' }
        ]},
        { id: 'brake_rear', name: 'Rear Disc Brake', type: 'GROUP', children: [
            { id: 'caliper_rear', name: 'Rear Caliper', type: 'PART' },
            { id: 'rotor_rear', name: 'Rear Rotor', type: 'MESH' }
        ]},
        { id: 'brake_cables', name: 'Hydraulic Lines', type: 'MESH' }
    ]},
    { id: 'cockpit', name: 'Cockpit', type: 'GROUP', children: [
        { id: 'saddle', name: 'Saddle', type: 'MESH' },
        { id: 'seatpost', name: 'Seatpost', type: 'MESH' },
        { id: 'seatpost_clamp', name: 'Seatpost Clamp', type: 'PART' }
    ]},
    { id: 'accessories', name: 'Accessories', type: 'GROUP', children: [
        { id: 'bell', name: 'Bell', type: 'PART' },
        { id: 'reflectors', name: 'Reflectors', type: 'PART' },
        { id: 'kickstand', name: 'Kickstand', type: 'PART' }
    ]}
  ]
};

export const HEADPHONES_SCENE_TREE: SceneNode = {
  id: 'headphones_assembly', name: 'Headphones', type: 'GROUP', children: [
    { id: 'left_cup', name: 'Left Ear Cup', type: 'GROUP', children: [
        { id: 'left_driver', name: 'Left Driver Unit', type: 'PART' },
        { id: 'left_cushion', name: 'Left Ear Cushion', type: 'MESH' }
    ]},
    { id: 'right_cup', name: 'Right Ear Cup', type: 'GROUP', children: [
        { id: 'right_driver', name: 'Right Driver Unit', type: 'PART' },
        { id: 'right_cushion', name: 'Right Ear Cushion', type: 'MESH' }
    ]},
    { id: 'headband', name: 'Headband', type: 'GROUP', children: [
        { id: 'headband_pad', name: 'Headband Padding', type: 'MESH' },
        { id: 'headband_frame', name: 'Headband Frame', type: 'MESH' }
    ]},
    { id: 'controls', name: 'Controls', type: 'GROUP', children: [
        { id: 'usb_c_port', name: 'USB-C Port', type: 'PART' },
        { id: 'power_button', name: 'Power Button', type: 'PART' },
        { id: 'volume_control', name: 'Volume Control', type: 'PART' }
    ]}
  ]
};

// For backwards compatibility
export const SCENE_TREE = SYNTH_SCENE_TREE;

/**
 * The tree of a room with nothing in it.
 *
 * Batch BI made that the DEFAULT rather than a state the app could only reach by
 * removing everything, so `getCurrentSceneTree` has to answer for it. A real node
 * with no children rather than null: every reader takes a `SceneNode` and would
 * otherwise need a null branch it has never had, and an empty tree already gives
 * them the empty answer — no parts to list, nothing to resolve a node id against.
 *
 * It is deliberately NOT a POI source: see derivedFromScene, which answers with no
 * points of interest at all when the scene is empty rather than one point named
 * after the absence of a model.
 */
export const EMPTY_SCENE_TREE: SceneNode = {
  id: 'empty_scene', name: 'No model', type: 'GROUP', children: [],
};

// Helper to init object states
const initObjectStates = (node: SceneNode, states: Record<string, ObjectState> = {}) => {
    states[node.id] = { id: node.id, visible: true, selected: false, expanded: true };
    if (node.children) {
        node.children.forEach(child => initObjectStates(child, states));
    }
    return states;
};

// Helper to count parts in a scene tree. Exported for the import status line,
// which says how many parts a file turned into.
export const countParts = (node: SceneNode): number => {
    let count = node.type === 'PART' || node.type === 'MESH' ? 1 : 0;
    if (node.children) {
        node.children.forEach(child => {
            count += countParts(child);
        });
    }
    return count;
};

/**
 * Seed POIs from a scene tree so agents always have targets to inspect, even for models
 * whose 3D component doesn't call registerPOI (bicycle, headphones, fresh imports before
 * the parts have been measured). Positions default to origin; the component later upserts
 * real world positions via registerPOI / registerPOIs.
 *
 * Capped at the same number of components the extraction prompt is allowed, and the cap is
 * what makes the one on registration mean anything: uncapped, this hands the store one POI
 * per leaf of a 40 000-part assembly and every one of them is at the origin, so the 200
 * real positions the renderer measures would be 200 needles in that. An agent picks its
 * target uniformly at random out of this list (components/Scene/Agent.tsx), so it would
 * spend the meeting looking at the origin.
 *
 * Depth-first, so what survives a truncation is the first branch of the tree rather than
 * its skeleton — unlike lib/componentIndex's flattenSceneTree, which goes breadth-first on
 * purpose because a truncated prompt still has to describe the whole assembly. These are
 * standing targets for a simulated agent, not a description of the model, and for anything
 * big enough to be truncated the renderer's own 200 largest parts upsert over them.
 */
const derivePoisFromSceneTree = (
    node: SceneNode,
    out: PointOfInterest[] = [],
    max: number = DEFAULT_MAX_COMPONENTS,
): PointOfInterest[] => {
    const isLeaf = !node.children || node.children.length === 0;
    if (isLeaf && out.length < max) {
        out.push({ id: node.id, position: new Vector3(0, 0, 0), label: node.name, type: 'GENERAL' });
    }
    for (const child of node.children ?? []) {
        if (out.length >= max) break;
        derivePoisFromSceneTree(child, out, max);
    }
    return out;
};

// ─── The room's scene ───────────────────────────────────────────────────────
//
// A room shows a LIST of models, not one: the product under review, a mating
// part, a competitor's version, and the revisions of each. What follows is the
// bookkeeping that turns that list — which the room server owns and relays as
// SCENE_STATE — into something the tree, the renderer and the laser can use.

/** The parsed half of one scene model, keyed in `sceneEntries` by SceneModel.id. */
export type { SceneModelEntry } from './lib/scene/sceneEntries';

/**
 * A revision comparison in progress, and what to put back when it ends.
 *
 * Compare is a scene operation, not a local view: everybody in the room sees
 * the same two revisions side by side, because a comparison one person can see
 * and the person they are talking to cannot is not a comparison. That means
 * entering it changes shared visibility and offsets, so leaving it has to undo
 * exactly what it changed — which is what `restore` is for.
 */
export interface SceneCompare {
    line: string;
    olderId: string;
    newerId: string;
    restore: Array<{ id: string; visible: boolean; offset: [number, number, number] }>;
}

/** The root the scene models hang off in the combined tree. */
export const SCENE_ROOT_ID = 'scene-root';

/**
 * Whether a model shows on THIS screen.
 *
 * Two different things decide it, and keeping them apart is the whole point:
 * `model.visible` is shared — the room agreed it, the server holds it, and
 * changing it changes everybody's screen. `localModelVisibility` is not: hiding
 * a model so you can see the one behind it is your business, and somebody who is
 * not allowed to change the room's models must still be able to do it. A local
 * override wins while it exists, which is why the eye on a model row can mean
 * either thing depending on who is clicking it.
 */
export function sceneModelVisible(
    model: SceneModel,
    localModelVisibility: Record<string, boolean>,
): boolean {
    return localModelVisibility[model.id] ?? model.visible;
}

/** The width of one model in scene units, which is what placement needs. */
export function sceneEntryWidth(entry: SceneModelEntry): number {
    return entry.size.x * entry.baseScale * entry.scale;
}

/**
 * The node the Model Tree or the laser has selected, or null.
 *
 * One selection, and it is the one that already existed: `selectNode` writes
 * `objectStates[id].selected` from a row click in the tree and from a hit in the 3D
 * view alike, and batch BR's Part mode reads it rather than adding a second
 * selection of its own that a person would have to keep in step with the first.
 *
 * Takes the record rather than the whole state so it can BE the selector —
 * `useStore(s => selectedNodeId(s.objectStates))` answers a string, and a string is
 * something zustand can compare, which an object literal built inside a selector is
 * not.
 */
export function selectedNodeId(objectStates: Record<string, ObjectState>): string | null {
    for (const id of Object.keys(objectStates)) {
        if (objectStates[id]?.selected) return id;
    }
    return null;
}

/** The node with this id in a scene tree, or null when the tree does not hold it. */
export function findSceneNode(tree: SceneNode | null, id: string | null): SceneNode | null {
    if (!tree || !id) return null;
    if (tree.id === id) return tree;
    for (const child of tree.children ?? []) {
        const found = findSceneNode(child, id);
        if (found) return found;
    }
    return null;
}

/**
 * One top-level tree group per scene model, named "Bracket · Rev B".
 *
 * Each model's own root node keeps its id — that is the id its geometry carries
 * in userData.modelId, so picking the model in the 3D view and selecting its row
 * in the tree have to be the same id — and takes the line-and-revision label
 * instead of the file's root group name, which is whatever the exporter called
 * it and is usually "Scene" or the part number.
 *
 * Models whose bytes have not been parsed yet are simply absent: the tree shows
 * their row from `scene.models` with a "loading" state, and the geometry arrives
 * when the download does.
 */
function combinedSceneTree(scene: RoomScene, entries: Record<string, SceneModelEntry>): SceneNode | null {
    const children: SceneNode[] = [];
    for (const model of scene.models) {
        const entry = entries[model.id];
        if (entry) children.push({ ...entry.sceneTree, name: sceneModelLabel(model) });
    }
    if (children.length === 0) return null;
    return { id: SCENE_ROOT_ID, name: 'Scene', type: 'GROUP', children };
}

/**
 * Object states for a tree, keeping what is already there.
 *
 * Adding a model to a scene used to mean rebuilding every node's state, which
 * collapsed the tree the room had opened and un-hid the parts somebody had
 * hidden — the second model arriving would have wiped what the first one's
 * walkthrough had set up. So states for ids that still exist are carried over
 * and only new ids are initialised. Ids that are gone are dropped, because a
 * state for a mesh that is no longer in the scene is how a hidden part comes
 * back invisible after the model it belonged to was removed and re-added.
 */
function mergeObjectStates(
    existing: Record<string, ObjectState>,
    tree: SceneNode | null,
): Record<string, ObjectState> {
    if (!tree) return existing;
    const next: Record<string, ObjectState> = {};
    const walk = (node: SceneNode) => {
        next[node.id] = existing[node.id] ?? { id: node.id, visible: true, selected: false, expanded: true };
        node.children?.forEach(walk);
    };
    walk(tree);
    return next;
}

/**
 * Wiped when the scene is replaced rather than added to — "Replace everything",
 * which is the import flow's fresh start and behaves the way importing a model
 * always did. Adding a model next to the current one, or a revision of it, does
 * NOT do this: the meeting is still about the same product, so its comments,
 * transcript and cards stay.
 */
const FRESH_SCENE_RESET: Partial<AppState> = {
    comments: [],
    chatHistory: [],
    insightCards: [],
    activeAgentId: null,
    leaderId: null,
    splitScreenTarget: null,
    isMeetingEnded: false,
    time: 0,
    commentMode: 'none',
    pendingCommentPosition: null,
    pendingCommentNodeId: null,
    pendingCommentNodeName: null,
    drawingCanvas: null,
    capturedScreenshot: null,
    drawingInteractionActive: false,
    compare: null,
    localModelVisibility: {},
};

/**
 * The model type the rest of the app reads, derived from the scene.
 *
 * 'none' when the scene holds neither models of its own nor a chosen sample, which
 * is what a fresh room and a fresh design review both are since batch BI. There
 * used to be a DEFAULT_BUILT_IN here: every room opened on the same sample
 * whether the meeting was about it or not.
 */
function activeModelTypeFor(scene: RoomScene): ModelType {
    if (scene.models.length > 0) return 'imported';
    return scene.builtIn ?? 'none';
}

/** Drop the records for models the scene no longer holds. */
function pruneToScene<T>(record: Record<string, T>, scene: RoomScene): Record<string, T> {
    const next: Record<string, T> = {};
    for (const model of scene.models) {
        const value = record[model.id];
        if (value !== undefined) next[model.id] = value;
    }
    return next;
}

/**
 * The same prune, for the one record whose values own something on the GPU.
 *
 * A separate function rather than a hook on `pruneToScene`, because that one is shared with
 * three records of plain data — a Group, and two booleans — and none of them has anything to
 * free. An entry's part registry does: a model big enough to be drawn as batches keeps its
 * merged vertex and index buffers, its instance-matrix texture and its highlight clones until
 * somebody calls `dispose`, and three frees none of that on a dropped reference.
 *
 * This is the render audit's R10. The room prunes its entries on every scene update, so a
 * model the room removes would otherwise hold its buffers for the life of the page, and a
 * session spent swapping revisions would accumulate one batched model per swap.
 */
function pruneEntriesToScene(
    record: Record<string, SceneModelEntry>,
    scene: RoomScene,
): Record<string, SceneModelEntry> {
    const next = pruneToScene(record, scene);
    for (const id of Object.keys(record)) {
        if (next[id] === undefined) record[id].partRegistry.dispose();
    }
    return next;
}

/**
 * The four fields that follow from the scene: which model type the app is in,
 * the combined tree, and the node states and agent targets derived from it.
 */
function derivedFromScene(
    scene: RoomScene,
    state: AppState,
    entries: Record<string, SceneModelEntry>,
    fresh: boolean,
) {
    const activeModelType = activeModelTypeFor(scene);
    const importedSceneTree = combinedSceneTree(scene, entries);
    const tree = getCurrentSceneTree(
        activeModelType,
        importedSceneTree,
        state.bicycleSceneTree,
        state.headphonesSceneTree,
    );
    return {
        activeModelType,
        importedSceneTree,
        objectStates: fresh ? initObjectStates(tree) : mergeObjectStates(state.objectStates, tree),
        // No points of interest in a room with nothing to inspect. EMPTY_SCENE_TREE
        // is a childless leaf, and derivePoisFromSceneTree turns every leaf into a
        // POI — so without this an empty room would offer its agents one target
        // called "No model", at the origin, where nothing is.
        pois: activeModelType === 'none' ? [] : derivePoisFromSceneTree(tree),
    };
}

/**
 * Make `scene` the scene, and everything that follows from it follow.
 *
 * One function because three callers need exactly the same bookkeeping — a
 * SCENE_STATE from the room server, a curation being opened, and a local
 * prediction of an operation this client just sent — and a divergence between
 * them is the kind of bug that shows up as one participant's tree being out of
 * step with everybody else's.
 */
function adoptScene(scene: RoomScene, state: AppState, fresh: boolean): Partial<AppState> {
    // Not just a prune: the entries being dropped own their registries' GPU buffers, and this
    // is the only moment anybody knows which ones are going. A side effect inside a `set`
    // updater, which is normally a smell — here it is the alternative to threading the dropped
    // ids back out through three callers that each have their own reason to prune.
    const entries = pruneEntriesToScene(state.sceneEntries, scene);
    const last = scene.models[scene.models.length - 1];
    // Keep pointing at whatever the scale slider was on while it is still in the
    // scene, so a model arriving does not move the slider somebody is dragging.
    const activeSceneModelId = scene.models.some((model) => model.id === state.activeSceneModelId)
        ? state.activeSceneModelId
        : last
          ? last.id
          : null;
    return {
        scene,
        sceneEntries: entries,
        // Pruned with the entries: a group belonging to a model the room has
        // removed is an Object3D nobody renders, and keeping it would leave the
        // gizmo able to attach to a model that is not on screen.
        sceneModelGroups: pruneToScene(state.sceneModelGroups, scene),
        localModelVisibility: pruneToScene(state.localModelVisibility, scene),
        expandedSceneModels: pruneToScene(state.expandedSceneModels, scene),
        activeSceneModelId,
        isImporting: false,
        ...(fresh ? FRESH_SCENE_RESET : {}),
        ...derivedFromScene(scene, state, entries, fresh),
    };
}


interface AppState {
  viewMode: ViewMode;
  representationMode: RepresentationMode;
  showFrustums: boolean;
  showGaze: boolean;
  showTrails: boolean;
  isPlaying: boolean;
  isMeetingEnded: boolean;
  /**
   * Bumped when THIS browser should take a snapshot of the room for the review's lobby
   * card. A counter rather than a boolean because the interesting event is the change,
   * and a boolean set twice to true would look like nothing happened the second time.
   *
   * Only `endMeeting(true)` bumps it, and NOT `meetingEndedRemotely`: one meeting is
   * recorded once, by the browser whose person pressed End, and the snapshot belongs
   * with that record. components/Scene/ThumbnailCapture.tsx is the only reader — it
   * lives inside the canvas because reading a WebGL drawing buffer needs the renderer,
   * which only R3F has.
   */
  snapshotRequest: number;
  time: number;

  // Collaboration State
  agents: AgentState[];
  agentStyle: AgentStyle;
  agentWeights: Record<string, number>;
  pois: PointOfInterest[];
  activeAgentId: string | null;

  // Advanced Collaboration Features
  leaderId: string | 'USER' | null;
  followingRemoteUserId: string | null; // camera + agents locked to a remote participant
  // True while the user is dragging their own view *without* leaving the
  // follow: the camera stops tracking the leader for the length of the drag
  // plus FOLLOW_RESUME_DELAY_MS, then eases back. Still counts as following.
  followNudged: boolean;
  // Split screen can follow either an AI agent or a real participant.
  // Discriminated by `kind` so the renderer knows which lookup path to use.
  splitScreenTarget:
    | { kind: 'agent'; id: string }
    | { kind: 'user'; userId: string }
    | null;
  userInteractionPoint: Vector3;
  isLaserActive: boolean;
  laserHighlightGranularity: 'model' | 'part';
  // When true, the laser auto-engages while the user dwells on a model part
  // with the mouse (passive "hover pointing").
  hoverPointingEnabled: boolean;
  hideAgents: boolean;

  // Follow Request System
  followRequest: { agentId: string; timestamp: number } | null;

  // Privacy Mode
  isPrivacyMode: boolean;

  // Followed Agent (for participant list)
  followedAgentId: string | null;

  // Temporary disengage from agent following
  temporarilyDisengagedFromAgentId: string | null;

  // Conversation & AI
  chatHistory: ChatMessage[];
  liveChat: LiveChatMessage[];
  insightCards: InsightCard[];
  mobileLaserNDC: [number, number] | null;
  requirements: Requirement[];
  knowledgeBase: KBEntry[];

  // Scene Graph State
  objectStates: Record<string, ObjectState>;

  // --- Models: the room's scene ---
  /** Which model the app renders. Derived from `scene` — see activeModelTypeFor. */
  activeModelType: ModelType;
  isImporting: boolean;
  /**
   * What is on screen, shared by the room. The room server holds the truth and
   * relays it whole as SCENE_STATE; this copy is what the renderer and the tree
   * read. Changing it locally is only ever a prediction of what the server will
   * relay back — see applyLocalSceneUpdate.
   */
  scene: RoomScene;
  /** Who may change the models. Enforced by the room server; the UI reads it to disable what would be refused. */
  modelEditors: ModelEditors;
  /** Parsed geometry per SceneModel.id. Absent until the file has been fetched and parsed. */
  sceneEntries: Record<string, SceneModelEntry>;
  /**
   * The rendered wrapper group per SceneModel.id — the one that carries the
   * model's own offset, rotation and scale.
   *
   * Registered by SceneModelView and read by ReviewModelGizmo, because drei's
   * TransformControls needs the Object3D itself and the gizmo lives in a different
   * branch of the canvas than the model does. This is the wrapper and NOT
   * sceneEntries[id].group: that inner group is already scaled and centred by
   * placeImportedGroup, so dragging it would write a transform that includes the
   * centring and slide the model when the drag ended.
   *
   * Non-serializable, like sceneEntries and _glCapture beside it: an Object3D has
   * one parent, so exactly one renderer may hold each of these.
   */
  sceneModelGroups: Record<string, Group>;
  registerSceneModelGroup: (id: string, group: Group | null) => void;
  /** Per-model visibility for THIS screen only. Overrides SceneModel.visible while present. */
  localModelVisibility: Record<string, boolean>;
  /** The model the scale slider and the import status refer to. */
  activeSceneModelId: string | null;
  /** Which model rows are open in the tree. Kept out of objectStates: a row's expansion is not a node's. */
  expandedSceneModels: Record<string, boolean>;
  compare: SceneCompare | null;
  /** A SCENE_REFUSED the room server sent this client, in words. Shown once in the model tree. */
  sceneRefusal: string | null;
  /**
   * The scene models as one tree, one top-level group per model. Derived from
   * `scene` and `sceneEntries`; keeps its old name because the consumers —
   * RecordingContext, DialogueEngine, SpatialComments — resolve a node id to the
   * name it should be read out as, and that is exactly what this is for.
   */
  importedSceneTree: SceneNode | null;

  // Built-in models' real scene trees, populated when the GLB loads.
  // Until then, getCurrentSceneTree falls back to the hand-written constants.
  bicycleSceneTree: SceneNode | null;
  headphonesSceneTree: SceneNode | null;

  // Curator-set transform applied to whatever model is loaded. Lives here
  // (not in the imported* group) so it applies to presets too. Synced from
  // the active review config's asset.transform when a curation loads.
  modelTransform: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale: number;
  };
  setModelTransform: (t: { position: [number, number, number]; rotation: [number, number, number]; scale: number }) => void;

  // --- NEW: Comments System ---
  comments: SpatialComment[];
  commentMode: CommentMode;
  pendingCommentPosition: { x: number; y: number; z: number } | null;
  pendingCommentNodeId: string | null;
  pendingCommentNodeName: string | null;
  currentUser: string;
  currentUserColor: string;

  // --- NEW: Drawing State ---
  drawingCanvas: string | null; // Base64 of current drawing
  capturedScreenshot: string | null; // Base64 of captured 3D view for drawing overlay
  drawingInteractionActive: boolean;
  showDrawingCanvas: boolean; // Whether the drawing canvas overlay is visible

  // --- NEW: Panel Mode ---
  rightPanelMode: RightPanelMode;

  // --- Editing the design review (batch BH) ---
  /**
   * Who has the review's Edit switch on, or null when nobody does.
   *
   * Written ONLY from the room server's EDITING_STATE, never optimistically by
   * the browser that pressed the button: the server decides whether one person
   * may edit, and a client that assumed yes would show the tools for a frame
   * before being told no. Reading it is how every other screen in the room knows
   * to show "Robin is editing the review" instead of the tools, and how capture
   * knows to stay quiet.
   */
  reviewEditing: { userId: string; name: string } | null;
  /**
   * A one-shot notice for somebody whose edit mode was ended by another person
   * taking over. Cleared by whoever shows it, so it is read once and does not
   * come back on the next render of an unrelated component.
   */
  reviewEditNotice: string | null;
  /**
   * The room's refusal of a request to edit, or null.
   *
   * Structured rather than a sentence because 'busy' comes with a button: the
   * person who was refused can ask to take over, which is a second EDITING_START
   * with force. 'role' has nothing to offer — the tools are not this person's —
   * and is only ever shown as the reason the Edit button did nothing. So is
   * 'dropped', which is not about this person at all: the room is on a variant the
   * review has finished with, so there is no edit for anybody to hold.
   */
  reviewEditRefusal: { reason: 'busy' | 'role' | 'dropped'; editorName: string | null } | null;

  // --- NEW: Comments Display State ---
  commentsExpandedInScene: boolean; // Toggle all comments expanded in 3D

  // --- NEW: Import Status Messages ---
  importError: string | null;
  importSuccess: string | null;

  // Actions
  setViewMode: (mode: ViewMode) => void;
  setRepresentationMode: (mode: RepresentationMode) => void;
  toggleFrustums: () => void;
  toggleGaze: () => void;
  toggleTrails: () => void;
  togglePlay: () => void;
  /**
   * End the meeting from HERE: the person at this browser pressed End, so this
   * browser is the one that records it.
   *
   * `participantCount` is the number of real people; agents are not participants.
   * `attendeeNames` is those same people by name (lib/identity.attendeeNames),
   * which is what the session row's `attendee_names` carries — a head count says
   * that three people met, and not who they were.
   */
  endMeeting: (ended: boolean, participantCount?: number, attendeeNames?: string[]) => void;
  /**
   * End the meeting because somebody ELSE in the room pressed End.
   *
   * The same on-screen state change `endMeeting(true)` makes, and nothing more: no
   * session row and no cards are written. Every browser in a room holds the same
   * broadcast cards, so letting the receivers flush too recorded one meeting three
   * times. Called from MEETING_END in lib/usePartyPresence.ts.
   */
  meetingEndedRemotely: () => void;
  setTime: (time: number) => void;
  resetTime: () => void;

  registerPOI: (poi: PointOfInterest) => void;
  /**
   * `registerPOI` for a whole model's parts, as ONE write.
   *
   * The batch half of the render audit's D3. `registerPOI` is one zustand `set()` per call,
   * and components/Scene/ImportedModel.tsx used to call it once per mesh inside a traverse —
   * so a 40 000-part STEP performed 40 000 store writes and re-rendered every POI
   * subscriber 40 000 times, per model, on every change to the model's moved parts. That is
   * independent of batching and was arguably worse than the draw-call problem 04b exists to
   * fix.
   *
   * Upserts, exactly as the single version does, so a caller may hand over the parts it
   * measured and leave everything else — another model's POIs, the bundled sample's — alone.
   * An empty list is not a write at all: a model with nothing to measure must not churn the
   * subscribers that are watching.
   */
  registerPOIs: (pois: PointOfInterest[]) => void;
  setActiveAgent: (id: string | null) => void;
  setLeader: (id: string | 'USER' | null) => void;
  setFollowingRemoteUser: (userId: string | null) => void;
  setFollowNudged: (nudged: boolean) => void;
  setSplitScreenTarget: (target: AppState['splitScreenTarget']) => void;
  setUserInteractionPoint: (pos: Vector3) => void;
  setLaserActive: (active: boolean) => void;
  setLaserHighlightGranularity: (g: 'model' | 'part') => void;
  setHoverPointingEnabled: (enabled: boolean) => void;
  toggleHideAgents: () => void;
  setFollowRequest: (req: { agentId: string; timestamp: number } | null) => void;
  togglePrivacyMode: () => void;
  setFollowedAgent: (id: string | null) => void;
  temporarilyDisengageFromAgent: () => void;
  resumeFollowingAgent: () => void;
  clearTemporaryDisengage: () => void;

  setAgentStyle: (style: AgentStyle) => void;
  setAgentWeight: (id: string, weight: number) => void;

  updateAgentStatus: (id: string, behavior: AgentBehaviorState, poiId: string | null) => void;
  addChatMessage: (msg: ChatMessage) => void;
  addLiveChatMessage: (msg: LiveChatMessage) => void;
  addInsightCard: (card: InsightCard) => void;
  setMobileLaserNDC: (ndc: [number, number] | null) => void;
  updateInsightType: (id: string, newType: InsightType) => void;
  updateInsight: (id: string, updates: Partial<InsightCard>) => void;
  setRequirements: (reqs: Requirement[]) => void;

  // Scene Graph Actions
  toggleNodeVisibility: (id: string) => void;
  toggleNodeExpanded: (id: string) => void;
  selectNode: (id: string | null) => void;

  // --- Model Import Actions ---
  setActiveModelType: (type: ModelType) => void;
  setIsImporting: (importing: boolean) => void;
  /**
   * Adopt a scene — from SCENE_STATE, or from a curation being opened.
   * `fresh` also wipes the meeting's content, which is what replacing the whole
   * scene means and what adding to it does not.
   */
  setRoomScene: (scene: RoomScene, options?: { fresh?: boolean }) => void;
  setModelEditors: (editors: ModelEditors) => void;
  /** Apply one operation to the local copy, the way the room server would. */
  applyLocalSceneUpdate: (update: SceneUpdate, options?: { fresh?: boolean }) => void;
  /** Record a model's parsed geometry. Idempotent: the loader may offer it twice. */
  upsertSceneModel: (entry: SceneModelEntry) => void;
  /** Drop parsed geometry for models the scene no longer holds. */
  pruneSceneEntries: () => void;
  setSceneModelScale: (id: string, scale: number) => void;
  /** Hide or show a model on THIS screen only — never sent to the room. */
  setLocalModelVisibility: (id: string, visible: boolean) => void;
  setActiveSceneModel: (id: string | null) => void;
  toggleSceneModelExpanded: (id: string) => void;
  setSceneCompare: (compare: SceneCompare | null) => void;
  setSceneRefusal: (message: string | null) => void;
  setBuiltInSceneTree: (type: 'bicycle' | 'headphones', tree: SceneNode) => void;

  // --- NEW: Comment Actions ---
  setAllComments: (comments: SpatialComment[]) => void;
  setCommentMode: (mode: CommentMode) => void;
  setPendingComment: (position: { x: number; y: number; z: number } | null, nodeId: string | null, nodeName: string | null) => void;
  addComment: (comment: SpatialComment) => void;
  updateComment: (id: string, updates: Partial<SpatialComment>) => void;
  deleteComment: (id: string) => void;
  resolveComment: (id: string) => void;
  setDrawingCanvas: (data: string | null) => void;
  setCapturedScreenshot: (data: string | null) => void;
  setDrawingInteractionActive: (active: boolean) => void;
  setShowDrawingCanvas: (show: boolean) => void;
  // Non-serializable: live reference so handleSave can capture the current GL frame.
  _glCapture: (() => string | null) | null;
  setGlCapture: (fn: (() => string | null) | null) => void;
  /**
   * Where the room's camera is, and what it is looking at, plus a thumbnail of it.
   *
   * Non-serializable for the same reason as _glCapture and registered from inside
   * the canvas by the component that owns the OrbitControls: "Save this view" is a
   * button in the amber strip, which is an overlay in a different React tree from
   * the renderer, and the camera's pose is only readable from within R3F.
   *
   * Null outside a room, so the button can be hidden rather than offered and
   * silently do nothing.
   */
  _viewCapture: (() => ViewCapture | null) | null;
  setViewCapture: (fn: (() => ViewCapture | null) | null) => void;

  // --- NEW: Panel Mode Action ---
  setRightPanelMode: (mode: RightPanelMode) => void;

  // --- Editing the design review actions (batch BH) ---
  setReviewEditing: (editing: { userId: string; name: string } | null) => void;
  setReviewEditNotice: (message: string | null) => void;
  setReviewEditRefusal: (refusal: { reason: 'busy' | 'role' | 'dropped'; editorName: string | null } | null) => void;
  /**
   * Which transform the amber strip is applying to the SELECTED scene model.
   * In the store rather than in the strip's component because the thing being
   * moved is drei's TransformControls inside the R3F canvas, and a canvas and an
   * overlay are two trees with no prop path between them.
   */
  reviewGizmoMode: ReviewGizmoMode;
  setReviewGizmoMode: (mode: ReviewGizmoMode) => void;
  /**
   * Whether those tools move the whole selected model or one PART of it — batch BR.
   *
   * In the store beside the mode for the same reason the mode is: the thing being
   * moved is drei's TransformControls inside the R3F canvas and the switch is a
   * button in the amber strip, which is an overlay in a different React tree.
   *
   * Which part is NOT stored here. The selection the laser and the Model Tree
   * already set — objectStates[id].selected — is the only selection there is, and a
   * second one for the gizmo would have been a third thing a person had to keep in
   * step. lib/scene/partTransforms.partTargetFor resolves it.
   */
  reviewGizmoTarget: ReviewGizmoTarget;
  setReviewGizmoTarget: (target: ReviewGizmoTarget) => void;

  // --- NEW: Comments Display Actions ---
  toggleCommentsExpandedInScene: () => void;
  setCommentScreenOffset: (id: string, offset: { x: number; y: number }) => void;
  toggleCommentExpanded: (id: string) => void;

  // --- NEW: Import Status Actions ---
  /** What the model tree's status area says: a failure, or what just succeeded. */
  setImportStatus: (error: string | null, success: string | null) => void;
  clearImportStatus: () => void;

  // --- BOARDROOM MODE ---
  boardroomPendingEntry: boolean; // countdown is running, waiting to enter
  isBoardroomMode: boolean;
  boardroomLayout: BoardroomLayout;
  boardroomInteractionEnabled: boolean;
  boardroomLayoutLocked: boolean;
  boardroomPresenterAgentId: string | 'USER' | null;
  boardroomTranscriptPermission: boolean;
  boardroomLeaderId: string | null; // real person leading (userId)
  takeoverModeEnabled: boolean;
  takeoverApprovedUserIds: string[];

  triggerBoardroomEntry: () => void;
  cancelBoardroomEntry: () => void;
  toggleBoardroomMode: () => void;
  setBoardroomLayout: (layout: BoardroomLayout) => void;
  toggleBoardroomInteraction: () => void;
  toggleBoardroomLayoutLocked: () => void;
  setBoardroomPresenter: (id: string | 'USER' | null) => void;
  toggleBoardroomTranscriptPermission: () => void;
  setBoardroomLeaderId: (userId: string | null) => void;
  setTakeoverModeEnabled: (v: boolean) => void;
  toggleTakeoverApproval: (userId: string) => void;
  setTakeoverApprovedUserIds: (ids: string[]) => void;
  setPrivacyMode: (enabled: boolean) => void;

  // Local-only boardroom presenter detach (drag to look around, auto-resume after 3s)
  boardroomPresenterDetachedId: string | null;
  detachBoardroomPresenter: (presenterId: string) => void;
  resumeBoardroomPresenter: () => void;

  // Presenter request (non-host requests; host sees notification)
  pendingPresenterRequest: { fromUserId: string; fromName: string } | null;
  setPendingPresenterRequest: (req: { fromUserId: string; fromName: string } | null) => void;

  // Requestor's local view of their pending/denied presenter request
  presenterRequestStatus: 'pending' | 'denied' | null;
  setPresenterRequestStatus: (status: 'pending' | 'denied' | null) => void;

  // --- SESSION HOST ---
  sessionHostId: string | null; // Zoom-style host: first to join, controls view transitions
  setSessionHostId: (id: string | null) => void;

  // --- THE DESIGN REVIEW THIS ROOM IS HOLDING ---
  /**
   * review_curations.id when this room was opened from a design review, and null
   * for an ad-hoc session nobody curated.
   *
   * Not derived from the URL. A room id and a review id are the same STRING, but
   * only one of them has a row behind it, and the difference is what decides
   * whether a meeting is recorded against a review or stands alone — so it is set
   * by pages/RoomPage.tsx at the moment it actually loads a curation, and cleared
   * when the room unmounts.
   */
  activeReviewId: string | null;
  setActiveReviewId: (id: string | null) => void;

  /**
   * The line of that design review this room is on, or null.
   *
   * docs/plan/15-sessions-and-variants.md batch BK. A review's meetings run along a
   * MAIN line, and a VARIANT is a side line somebody started from one of them to try
   * a different answer; the room is always on exactly one of them. Null means this
   * browser has not worked out which yet, or the room is an ad-hoc session with no
   * review to have lines — and both are answered for at meeting end by
   * lib/trackerBridge, which resolves the line itself rather than recording a
   * session the map cannot place.
   *
   * Set by pages/RoomPage.tsx, from the address it was opened on: `/room/<reviewId>`
   * is the main line, so every link already in circulation keeps working, and
   * `/room/<reviewId>?line=<lineId>` is that variant. The whole row is held rather
   * than its id because three readers need more than the id — the meeting flush
   * numbers the session on it, the Capture panel lists the cards it is carrying, and
   * lib/scene/showCurationModel.ts starts the scene from its last meeting.
   */
  activeLine: ReviewLine | null;
  setActiveLine: (line: ReviewLine | null) => void;
}


export const useStore = create<AppState>((set, get) => ({
  viewMode: ViewMode.FREE,
  representationMode: RepresentationMode.FULL,
  showFrustums: false,
  showGaze: false,
  showTrails: false,
  isPlaying: true,
  isMeetingEnded: false,
  snapshotRequest: 0,
  time: 0,
  agents: INITIAL_AGENTS,
  agentStyle: AgentStyle.BOX,
  agentWeights: INITIAL_WEIGHTS,
  pois: [],
  activeAgentId: null,
  leaderId: null,
  followingRemoteUserId: null,
  followNudged: false,
  splitScreenTarget: null,
  userInteractionPoint: new Vector3(),
  isLaserActive: false,
  laserHighlightGranularity: 'part',
  hoverPointingEnabled: false,
  // Agents OFF by default. The four scripted agents (SYS.OP, ENG.UNIT,
  // DES.LEAD, VR.USER) are demo furniture: in a real review they stand next
  // to actual participants and are mistaken for them. The AGENTS toggle in
  // the room brings them back for a demo.
  hideAgents: true,
  followRequest: null,
  isPrivacyMode: false,
  followedAgentId: null,
  temporarilyDisengagedFromAgentId: null,
  chatHistory: [],
  liveChat: [],
  mobileLaserNDC: null,
  insightCards: [],
  requirements: [],
  knowledgeBase: KB_DB,
  objectStates: initObjectStates(EMPTY_SCENE_TREE),

  // --- Models: the room's scene ---
  // Empty, and not a preset: a room opens with nothing on screen until somebody
  // imports a model or picks one of the samples (batch BI).
  activeModelType: 'none',
  modelTransform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  isImporting: false,
  scene: emptyScene(),
  modelEditors: 'host',
  sceneEntries: {},
  sceneModelGroups: {},
  registerSceneModelGroup: (id, group) => set((state) => {
      const groups = { ...state.sceneModelGroups };
      if (group) groups[id] = group;
      else delete groups[id];
      return { sceneModelGroups: groups };
  }),
  localModelVisibility: {},
  activeSceneModelId: null,
  expandedSceneModels: {},
  compare: null,
  sceneRefusal: null,
  importedSceneTree: null,
  bicycleSceneTree: null,
  headphonesSceneTree: null,

  // --- NEW: Comments System ---
  comments: [],
  commentMode: 'none',
  pendingCommentPosition: null,
  pendingCommentNodeId: null,
  pendingCommentNodeName: null,
  currentUser: (() => { try { const s = localStorage.getItem('vp_user'); return s ? (JSON.parse(s).name || 'Guest') : 'Guest'; } catch { return 'Guest'; } })(),
  currentUserColor: (() => { try { const s = localStorage.getItem('vp_user'); return s ? (JSON.parse(s).color || '#10b981') : '#10b981'; } catch { return '#10b981'; } })(),

  // --- NEW: Drawing State ---
  drawingCanvas: null,
  capturedScreenshot: null,
  drawingInteractionActive: false,
  showDrawingCanvas: false,

  // --- NEW: Panel Mode ---
  rightPanelMode: 'meeting',
  reviewEditing: null,
  reviewEditNotice: null,
  reviewEditRefusal: null,
  reviewGizmoMode: null,
  reviewGizmoTarget: 'model',

  // --- NEW: Comments Display State ---
  commentsExpandedInScene: false,

  // --- NEW: Import Status Messages ---
  importError: null,
  importSuccess: null,

  setViewMode: (mode) => set({ viewMode: mode }),
  setRepresentationMode: (mode) => set({ representationMode: mode }),
  toggleFrustums: () => set((state) => ({ showFrustums: !state.showFrustums })),
  toggleGaze: () => set((state) => ({ showGaze: !state.showGaze })),
  toggleTrails: () => set((state) => ({ showTrails: !state.showTrails })),
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),
  endMeeting: (ended, participantCount, attendeeNames) => {
    if (ended) {
      const { insightCards, agents, activeModelType, hideAgents, scene, activeReviewId, activeLine, chatHistory, isPrivacyMode } = get();
      const roomId = window.location.pathname.split('/room/')[1] ?? 'local';
      // The labels of the review this meeting was held in. The room's own copy
      // first, because batch BH3 drops the lobby's handover draft once the room
      // has read the row — in a room with a database that draft is gone by the
      // time the meeting ends. It was always the weaker answer anyway: the review
      // being presented is the copy everybody in the room was looking at, and the
      // draft is only what one browser carried in from the lobby. Kept as the
      // fallback for an install with no database, where the draft is all there is.
      const labels = useActiveReviewStore.getState().config?.labels
        ?? useReviewSetupStore.getState().draft?.labels
        ?? {};
      // The review's name, for the minutes' heading, on the same reasoning.
      const reviewTitle = useActiveReviewStore.getState().config?.title
        ?? useReviewSetupStore.getState().draft?.title
        ?? null;
      // The transcript, when the meeting asked for one to be kept.
      //
      // Built HERE rather than by the browser that stopped the recording, because
      // this is the browser that writes the meeting's row and one meeting is
      // recorded once (see meetingEndedRemotely). That is usually a different person
      // from the one who pressed Stop, and it works because both halves of a
      // transcript are already the room's rather than anybody's: live lines arrive
      // on every client through TRANSCRIPT_LINE and pointing segments through
      // POINTING_SEGMENT. The choice itself came the same way — TRANSCRIPT_KEEP,
      // kept by the room server and relayed, so it reaches whichever browser ends up
      // here. lib/transcriptKeep.ts.
      //
      // Re-checked against privacy mode and the capture pause rather than trusted
      // from the button that was pressed, for the reason lib/capture/meetingMinutes
      // gives for itself: a room that turned privacy on between Stop and End has
      // said that what was said in it does not leave it, and a meeting ending is not
      // a reason to break that.
      const keepTranscript = getTranscriptKeep();
      const transcript = keepTranscript?.keep === true && !isPrivacyMode && !isCapturePaused()
        ? buildTranscript({
            chatHistory,
            recordingStart: getRecordingState()?.startedAt ?? 0,
            segments: usePointingTimelineStore.getState().segments,
            includePointing: keepTranscript.includePointing === true,
          })
        : [];
      const flushed = flushSessionToTracker({
        roomId,
        insightCards,
        // Real people, passed in by the caller (which knows the presence
        // list). The old `agents.length` recorded four demo agents as
        // attendees of every meeting; with agents hidden it would have
        // recorded four people who were never there.
        participantCount: participantCount ?? (hideAgents ? 1 : agents.length),
        attendeeNames,
        // The product this meeting was held on, or null when it was held on
        // nothing — an empty room. 'none' is the app's own spelling of "no model"
        // and is not a product name, so it is not what the tracker row should say.
        modelName: activeModelType === 'none' ? null : activeModelType,
        labels,
        // The design review this room is holding, or null for an ad-hoc session.
        // Deliberately NOT the draft's reviewId: the draft is persisted, so a
        // stale one from the review somebody curated an hour ago would otherwise
        // attach this meeting to that review.
        reviewId: activeReviewId,
        // What was on screen, so the meeting and its cards can be recorded
        // against revisions rather than against "the model".
        onScreen: scene.models,
        partNames: pointedAtPartNames(),
        // The line this meeting continued. Null when the room never worked one out
        // — an ad-hoc session, or a review on an install whose database has no
        // review_lines yet — and lib/trackerBridge resolves the main line itself
        // rather than recording a session the map cannot place.
        lineId: activeLine?.id ?? null,
        // Empty when nothing is to be stored, which lib/trackerBridge reads as
        // "leave the column out of the INSERT entirely" — an install whose database
        // has not been re-applied since this batch then records its meetings exactly
        // as it did before, instead of failing the one write that matters.
        transcript,
      });
      // The minutes, asked for once the meeting's own row exists and in the
      // background: a summary is one AI job on the whole meeting, which is seconds
      // of work, and the person who pressed End must get their meeting back now —
      // as must the tracker row, which is the record and does not wait on prose
      // that may never arrive. `sessionId` is null when the flush wrote nothing (a
      // meeting with no cards), and then there is no row to put minutes on either.
      void flushed.then((sessionId) => {
        if (!sessionId) return;
        void writeMeetingMinutes({
          sessionId,
          chatHistory,
          cards: insightCards,
          title: reviewTitle,
          privacyMode: isPrivacyMode,
        });
      });
    }
    // The snapshot is asked for here and only here: this is the browser whose person
    // pressed End, so it is the one still looking at the model the meeting was held on,
    // and the picture belongs with the record that meeting just wrote.
    // `meetingEndedRemotely` deliberately does NOT ask — one meeting is recorded once,
    // and a snapshot from every browser in the room is four writes of the same picture.
    set(ended
      ? { isMeetingEnded: ended, isPlaying: !ended, snapshotRequest: get().snapshotRequest + 1 }
      : { isMeetingEnded: ended, isPlaying: !ended });
  },
  // The same on-screen change endMeeting(true) makes and NOT its write. Cards are
  // broadcast to every browser in the room, so each of them holds the same
  // insightCards: a meeting with three people in it used to end with three
  // tracker_sessions rows — S1, S2 and S3 on the line — and every card three
  // times. One meeting is recorded once, by the browser whose person pressed End.
  meetingEndedRemotely: () => set({ isMeetingEnded: true, isPlaying: false }),
  setTime: (time) => set({ time }),
  resetTime: () => set({ time: 0, chatHistory: [], insightCards: [] }),
  
  registerPOI: (poi) => set((state) => {
    const existingIdx = state.pois.findIndex(p => p.id === poi.id);
    if (existingIdx === -1) return { pois: [...state.pois, poi] };
    // Upsert so per-mesh components can overwrite seeded origin positions
    // with the real world-space center once meshes mount.
    const next = state.pois.slice();
    next[existingIdx] = poi;
    return { pois: next };
  }),
  registerPOIs: (incoming) => set((state) => {
    if (incoming.length === 0) return state;
    // One index and one array for the whole batch. `registerPOI` in a loop is the D3
    // write storm: each call is a `set()`, and every subscriber of `pois` re-renders on
    // each one, so a model's parts arriving cost as many renders as it has parts.
    const indexOf = new Map(state.pois.map((poi, index) => [poi.id, index]));
    const next = state.pois.slice();
    for (const poi of incoming) {
      const existing = indexOf.get(poi.id);
      if (existing === undefined) {
        indexOf.set(poi.id, next.length);
        next.push(poi);
      } else {
        next[existing] = poi;
      }
    }
    return { pois: next };
  }),
  setActiveAgent: (id) => set({ activeAgentId: id }),
  // A nudge belongs to the follow it happened during, so every change of who
  // leads clears it — otherwise a stale nudge would freeze the next follow.
  setLeader: (id) => set({ leaderId: id, followingRemoteUserId: null, followNudged: false }),
  // Follow a remote user: locks camera and makes agents follow too
  setFollowingRemoteUser: (userId) => set(
    userId
      ? { followingRemoteUserId: userId, leaderId: 'USER', viewMode: ViewMode.FREE, activeAgentId: null, followNudged: false }
      : { followingRemoteUserId: null, leaderId: null, followNudged: false }
  ),
  setFollowNudged: (followNudged) => set({ followNudged }),
  setSplitScreenTarget: (target) => set({ splitScreenTarget: target }),
  setUserInteractionPoint: (pos) => set({ userInteractionPoint: pos }),
  setLaserActive: (active) => set({ isLaserActive: active }),
  setLaserHighlightGranularity: (g) => set({ laserHighlightGranularity: g }),
  setHoverPointingEnabled: (hoverPointingEnabled) => set({ hoverPointingEnabled }),
  toggleHideAgents: () => set(state => ({ hideAgents: !state.hideAgents })),
  setFollowRequest: (req) => set({ followRequest: req }),
  togglePrivacyMode: () => set((state) => ({ isPrivacyMode: !state.isPrivacyMode })),
  setFollowedAgent: (id) => set({ followedAgentId: id }),

  // Temporarily disengage from POV following - stores current agent and switches to FREE mode
  temporarilyDisengageFromAgent: () => set((state) => {
    if (state.viewMode === ViewMode.POV_AGENT && state.activeAgentId) {
      return {
        temporarilyDisengagedFromAgentId: state.activeAgentId,
        viewMode: ViewMode.FREE
      };
    }
    return state;
  }),

  // Resume following the temporarily disengaged agent
  resumeFollowingAgent: () => set((state) => {
    if (state.temporarilyDisengagedFromAgentId) {
      return {
        activeAgentId: state.temporarilyDisengagedFromAgentId,
        viewMode: ViewMode.POV_AGENT,
        temporarilyDisengagedFromAgentId: null
      };
    }
    return state;
  }),

  // Clear temporary disengage state without resuming
  clearTemporaryDisengage: () => set({ temporarilyDisengagedFromAgentId: null }),
  
  setAgentStyle: (style) => set({ agentStyle: style }),
  setAgentWeight: (id, weight) => set((state) => ({
    agentWeights: { ...state.agentWeights, [id]: weight }
  })),
  
  updateAgentStatus: (id, behavior, poiId) => set((state) => ({
    agents: state.agents.map(a => a.id === id ? { ...a, behavior, currentPoiId: poiId } : a)
  })),
  
  addChatMessage: (msg) => set((state) => ({
    chatHistory: [...state.chatHistory, msg].slice(-50)
  })),

  addLiveChatMessage: (msg) => set((state) => ({
    liveChat: [...state.liveChat, msg].slice(-200)
  })),

  setMobileLaserNDC: (ndc) => set({ mobileLaserNDC: ndc }),

  setRequirements: (reqs) => set({ requirements: reqs }),

  addInsightCard: (card) => set((state) => {
    if (state.insightCards.some(c => c.id === card.id)) return state; // deduplicate
    return { insightCards: [card, ...state.insightCards].slice(0, 15) };
  }),

  updateInsightType: (id, newType) => set((state) => ({
    insightCards: state.insightCards.map(c => c.id === id ? { ...c, type: newType } : c)
  })),

  updateInsight: (id, updates) => set((state) => ({
    insightCards: state.insightCards.map(c => c.id === id ? { ...c, ...updates } : c)
  })),

  // Scene Graph Actions
  toggleNodeVisibility: (id) => set((state) => ({
      objectStates: {
          ...state.objectStates,
          [id]: { ...state.objectStates[id], visible: !state.objectStates[id].visible }
      }
  })),
  toggleNodeExpanded: (id) => set((state) => ({
      objectStates: {
          ...state.objectStates,
          [id]: { ...state.objectStates[id], expanded: !state.objectStates[id].expanded }
      }
  })),
  selectNode: (id) => set((state) => {
      const newStates = { ...state.objectStates };
      Object.keys(newStates).forEach(key => {
          newStates[key] = { ...newStates[key], selected: false };
      });
      if (id && newStates[id]) {
          newStates[id] = { ...newStates[id], selected: true };
      }
      return { objectStates: newStates };
  }),

  // --- NEW: Model Import Actions ---
  setModelTransform: (modelTransform) => set({ modelTransform }),

  setActiveModelType: (type) => set((state) => {
      // 'imported' is not something a caller picks: it is what the scene reads
      // as when it holds models, and there is nothing to show when it does not.
      // Choosing a built-in clears the list, which is what switching models has
      // always meant — the preset replaces what was there. 'none' clears it and
      // leaves no preset behind: the empty room batch BI made the starting point.
      if (type === 'imported') return state;
      const builtIn: BuiltInModel | null = type === 'none' ? null : type;
      // Only a REAL model change wipes the meeting's content. This used to
      // clear unconditionally, and the room re-applies the model on every
      // REVIEW_CONFIG sync — so committing a pin (which updates the review)
      // erased every comment, chat line and insight card on the other
      // participants' screens moments after they arrived. Found live
      // 2026-09-23 while testing commit-as-comment.
      const sameModel = state.activeModelType === type;
      return adoptScene({ models: [], builtIn }, state, !sameModel);
  }),

  setIsImporting: (importing) => set({ isImporting: importing }),

  setRoomScene: (scene, options) => set((state) => adoptScene(scene, state, options?.fresh ?? false)),

  applyLocalSceneUpdate: (update, options) => {
      const state = get();
      const next = applySceneUpdate(state.scene, update);
      // The reducer returned the same object, so there is nothing to adopt —
      // unless the caller asked for a fresh start, which is a change to the
      // MEETING even when it is not a change to the list.
      if (next === state.scene && !options?.fresh) return;
      state.setRoomScene(next, options);
  },

  setModelEditors: (modelEditors) => set({ modelEditors }),

  upsertSceneModel: (entry) => set((state) => {
      const previous = state.sceneEntries[entry.id];
      // The same geometry can be offered twice — an import parses the file to
      // measure it, and the loader parses whatever the scene says is missing.
      // Keep the scale the user dialled in rather than resetting it under them.
      const merged: SceneModelEntry = previous ? { ...entry, scale: previous.scale } : entry;
      // The entry this one replaces is dropped as surely as a pruned one is, and its registry
      // owns the same buffers: a re-parse of a model already in the scene builds a second set
      // of batches and leaves the first with nothing pointing at it. The identity check is
      // what keeps an upsert of the entry already there — which `merged` is when there was no
      // previous — from disposing the registry it is about to publish.
      if (previous && previous.partRegistry !== merged.partRegistry) {
          previous.partRegistry.dispose();
      }
      const entries = { ...state.sceneEntries, [entry.id]: merged };
      return {
          sceneEntries: entries,
          activeSceneModelId: state.activeSceneModelId ?? entry.id,
          ...derivedFromScene(state.scene, state, entries, false),
      };
  }),

  pruneSceneEntries: () => set((state) => {
      const entries = pruneEntriesToScene(state.sceneEntries, state.scene);
      if (Object.keys(entries).length === Object.keys(state.sceneEntries).length) return state;
      return { sceneEntries: entries, ...derivedFromScene(state.scene, state, entries, false) };
  }),

  setSceneModelScale: (id, scale) => set((state) => {
      const entry = state.sceneEntries[id];
      if (!entry || entry.scale === scale) return state;
      return { sceneEntries: { ...state.sceneEntries, [id]: { ...entry, scale } } };
  }),

  setLocalModelVisibility: (id, visible) => set((state) => ({
      localModelVisibility: { ...state.localModelVisibility, [id]: visible },
  })),

  setActiveSceneModel: (id) => set({ activeSceneModelId: id }),

  toggleSceneModelExpanded: (id) => set((state) => ({
      expandedSceneModels: { ...state.expandedSceneModels, [id]: !state.expandedSceneModels[id] },
  })),

  setSceneCompare: (compare) => set({ compare }),

  setSceneRefusal: (message) => set({ sceneRefusal: message }),

  setImportStatus: (importError, importSuccess) => set({ importError, importSuccess }),

  setBuiltInSceneTree: (type, tree) => set({
    [type === 'bicycle' ? 'bicycleSceneTree' : 'headphonesSceneTree']: tree,
    objectStates: initObjectStates(tree),
    pois: derivePoisFromSceneTree(tree),
  }),

  // --- NEW: Comment Actions ---
  setAllComments: (comments) => set({ comments }),
  setCommentMode: (mode) => set({ commentMode: mode }),

  setPendingComment: (position, nodeId, nodeName) => set({
      pendingCommentPosition: position,
      pendingCommentNodeId: nodeId,
      pendingCommentNodeName: nodeName
  }),

  addComment: (comment) => set((state) => ({
      comments: [...state.comments, comment]
  })),

  updateComment: (id, updates) => set((state) => ({
      comments: state.comments.map(c => c.id === id ? { ...c, ...updates } : c)
  })),

  deleteComment: (id) => set((state) => ({
      comments: state.comments.filter(c => c.id !== id)
  })),

  resolveComment: (id) => set((state) => ({
      comments: state.comments.map(c => c.id === id ? { ...c, resolved: true } : c)
  })),

  setDrawingCanvas: (data) => set({ drawingCanvas: data }),
  setCapturedScreenshot: (data) => set({ capturedScreenshot: data }),
  setDrawingInteractionActive: (active) => set({ drawingInteractionActive: active }),
  setShowDrawingCanvas: (show) => set({ showDrawingCanvas: show }),
  _glCapture: null,
  setGlCapture: (fn) => set({ _glCapture: fn }),
  _viewCapture: null,
  setViewCapture: (fn) => set({ _viewCapture: fn }),

  // --- NEW: Panel Mode Action ---
  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),
  setReviewEditing: (editing) => set((state) => (
    // The gizmo is a tool of edit mode, so it goes when edit mode does. A
    // TransformControls left attached to a model after Done would keep stealing
    // the camera drag for somebody who can no longer see why. A refusal goes at
    // the same time: it was an answer to a question the room has now answered
    // differently, and leaving the prompt up beside the working tools would be
    // two contradictory things on one screen.
    editing === null
      ? (state.reviewGizmoMode !== null || state.reviewEditRefusal !== null || state.reviewGizmoTarget !== 'model'
          ? { reviewEditing: null, reviewGizmoMode: null, reviewGizmoTarget: 'model', reviewEditRefusal: null }
          : { reviewEditing: null })
      : { reviewEditing: editing, reviewEditRefusal: null }
  )),
  setReviewEditNotice: (message) => set({ reviewEditNotice: message }),
  setReviewEditRefusal: (refusal) => set({ reviewEditRefusal: refusal }),
  setReviewGizmoMode: (mode) => set({ reviewGizmoMode: mode }),
  setReviewGizmoTarget: (target) => set({ reviewGizmoTarget: target }),

  // --- NEW: Comments Display Actions ---
  toggleCommentsExpandedInScene: () => set((state) => ({
      commentsExpandedInScene: !state.commentsExpandedInScene
  })),

  setCommentScreenOffset: (id, offset) => set((state) => ({
      comments: state.comments.map(c => c.id === id ? { ...c, screenOffset: offset } : c)
  })),

  toggleCommentExpanded: (id) => set((state) => ({
      comments: state.comments.map(c => c.id === id ? { ...c, expanded: !c.expanded } : c)
  })),

  // --- NEW: Import Status Actions ---
  clearImportStatus: () => set({ importError: null, importSuccess: null }),

  // --- SESSION HOST ---
  sessionHostId: null,

  // --- THE DESIGN REVIEW THIS ROOM IS HOLDING ---
  activeReviewId: null,
  setActiveReviewId: (activeReviewId) => set({ activeReviewId }),
  activeLine: null,
  setActiveLine: (activeLine) => set({ activeLine }),

  // --- BOARDROOM MODE ---
  boardroomPendingEntry: false,
  boardroomPresenterDetachedId: null,
  pendingPresenterRequest: null,
  presenterRequestStatus: null,
  isBoardroomMode: false,
  boardroomLayout: 'focus' as BoardroomLayout,
  boardroomInteractionEnabled: false,
  boardroomLayoutLocked: false,
  boardroomPresenterAgentId: null,
  boardroomTranscriptPermission: true,
  boardroomLeaderId: null,
  takeoverModeEnabled: false,
  takeoverApprovedUserIds: [],

  triggerBoardroomEntry: () => set({ boardroomPendingEntry: true }),
  cancelBoardroomEntry: () => set({ boardroomPendingEntry: false }),

  toggleBoardroomMode: () => set((state) => {
    if (!state.isBoardroomMode) {
      return {
        isBoardroomMode: true,
        boardroomPendingEntry: false,
        viewMode: ViewMode.FREE,
        activeAgentId: null,
        temporarilyDisengagedFromAgentId: null,
        // Host is presenter by default; BoardroomPresenterSync will set followingRemoteUserId for non-hosts.
        // Late joiners overwrite this from BOARDROOM_STATE's authoritative leaderId.
        boardroomLeaderId: state.sessionHostId,
        boardroomPresenterDetachedId: null,
        // Clean slate for boardroom policy each entry — host re-enables explicitly
        takeoverModeEnabled: false,
        takeoverApprovedUserIds: [],
        pendingPresenterRequest: null,
        presenterRequestStatus: null,
      };
    }
    return {
      isBoardroomMode: false,
      boardroomPendingEntry: false,
      boardroomLeaderId: null,
      followingRemoteUserId: null,
      viewMode: ViewMode.FREE,
      activeAgentId: null,
      temporarilyDisengagedFromAgentId: null,
      boardroomPresenterDetachedId: null,
      takeoverModeEnabled: false,
      takeoverApprovedUserIds: [],
      pendingPresenterRequest: null,
      presenterRequestStatus: null,
    };
  }),
  setBoardroomLayout: (layout) => set({ boardroomLayout: layout }),
  toggleBoardroomInteraction: () => set((state) => ({ boardroomInteractionEnabled: !state.boardroomInteractionEnabled })),
  toggleBoardroomLayoutLocked: () => set((state) => ({ boardroomLayoutLocked: !state.boardroomLayoutLocked })),
  setBoardroomPresenter: (id) => set({
    boardroomPresenterAgentId: id,
    activeAgentId: (id && id !== 'USER') ? id : null,
    viewMode: (id && id !== 'USER') ? ViewMode.POV_AGENT : ViewMode.FREE,
    // Always clear detach state — prevents stale resume timer overwriting the new pin
    temporarilyDisengagedFromAgentId: null,
  }),
  toggleBoardroomTranscriptPermission: () => set((state) => ({ boardroomTranscriptPermission: !state.boardroomTranscriptPermission })),
  setBoardroomLeaderId: (userId) => set({ boardroomLeaderId: userId }),
  setTakeoverModeEnabled: (v) => set({ takeoverModeEnabled: v }),
  toggleTakeoverApproval: (userId) => set((state) => {
    const ids = state.takeoverApprovedUserIds;
    return {
      takeoverApprovedUserIds: ids.includes(userId)
        ? ids.filter(id => id !== userId)
        : [...ids, userId],
    };
  }),
  setTakeoverApprovedUserIds: (ids) => set({ takeoverApprovedUserIds: ids }),
  setPrivacyMode: (enabled) => set({ isPrivacyMode: enabled }),
  setSessionHostId: (id) => set({ sessionHostId: id }),
  detachBoardroomPresenter: (presenterId) => set({
    boardroomPresenterDetachedId: presenterId,
    followingRemoteUserId: null,
    leaderId: null,
  }),
  resumeBoardroomPresenter: () => set({ boardroomPresenterDetachedId: null }),
  setPendingPresenterRequest: (req) => set({ pendingPresenterRequest: req }),
  setPresenterRequestStatus: (status) => set({ presenterRequestStatus: status }),

}));

// Helper to get current scene tree
export const getCurrentSceneTree = (
  modelType: ModelType,
  importedTree?: SceneNode | null,
  bicycleTree?: SceneNode | null,
  headphonesTree?: SceneNode | null
): SceneNode => {
  // A room with nothing in it, which is where every room starts (batch BI). The
  // fallback at the bottom is SYNTH_SCENE_TREE, so without this an empty room
  // would list a synth's parts next to an empty canvas.
  if (modelType === 'none') return EMPTY_SCENE_TREE;
  // An import whose file is still parsing has no tree yet: show nothing rather
  // than falling through to the synth's parts at the bottom.
  if (modelType === 'imported') {
    return importedTree ?? EMPTY_SCENE_TREE;
  }
  if (modelType === 'bicycle' && bicycleTree) {
    return bicycleTree;
  }
  if (modelType === 'headphones' && headphonesTree) {
    return headphonesTree;
  }
  return modelType === 'bicycle' ? BICYCLE_SCENE_TREE : modelType === 'headphones' ? HEADPHONES_SCENE_TREE : SYNTH_SCENE_TREE;
};

/**
 * The parts of the room's model that something can be attributed to.
 *
 * Empty in a room with no model, which is NOT the same as flattening the empty
 * tree: EMPTY_SCENE_TREE is a childless leaf, and flattenSceneTree turns every
 * leaf into a component, so an empty room would otherwise offer one part called
 * "No model" — for a grounded capture to attribute an insight to, and for the chat
 * panel to suggest as a part name. Both readers ask this one question rather than
 * composing the two calls themselves, so the answer to it is written down once
 * (batch BI).
 */
export const sceneComponents = (
  modelType: ModelType,
  importedTree?: SceneNode | null,
): FlatComponent[] =>
  modelType === 'none' ? [] : flattenSceneTree(getCurrentSceneTree(modelType, importedTree)).components;
