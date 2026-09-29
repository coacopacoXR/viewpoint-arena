import { Vector3 } from 'three';

// Augment Global JSX namespace (permissive for stability)
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
      // Core
      primitive: any;
      group: any;
      mesh: any;
      scene: any;
      
      // Geometries
      boxGeometry: any;
      cylinderGeometry: any;
      planeGeometry: any;
      sphereGeometry: any;
      capsuleGeometry: any;
      ringGeometry: any;
      circleGeometry: any;
      coneGeometry: any;
      dodecahedronGeometry: any;
      icosahedronGeometry: any;
      octahedronGeometry: any;
      tetrahedronGeometry: any;
      torusGeometry: any;
      torusKnotGeometry: any;
      tubeGeometry: any;

      // Materials
      meshStandardMaterial: any;
      meshBasicMaterial: any;
      meshPhysicalMaterial: any;
      meshPhongMaterial: any;
      meshLambertMaterial: any;
      meshNormalMaterial: any;
      meshDepthMaterial: any;
      meshToonMaterial: any;
      pointsMaterial: any;
      
      // Lights
      pointLight: any;
      ambientLight: any;
      directionalLight: any;
      spotLight: any;
      hemisphereLight: any;
      rectAreaLight: any;

      // Helpers & Misc
      fog: any;
      color: any;
      gridHelper: any;
      axesHelper: any;
      arrowHelper: any;
    }
  }
}

// Augment React module JSX namespace (needed for some TS configurations)
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
      // Core
      primitive: any;
      group: any;
      mesh: any;
      scene: any;
      
      // Geometries
      boxGeometry: any;
      cylinderGeometry: any;
      planeGeometry: any;
      sphereGeometry: any;
      capsuleGeometry: any;
      ringGeometry: any;
      circleGeometry: any;
      coneGeometry: any;
      dodecahedronGeometry: any;
      icosahedronGeometry: any;
      octahedronGeometry: any;
      tetrahedronGeometry: any;
      torusGeometry: any;
      torusKnotGeometry: any;
      tubeGeometry: any;

      // Materials
      meshStandardMaterial: any;
      meshBasicMaterial: any;
      meshPhysicalMaterial: any;
      meshPhongMaterial: any;
      meshLambertMaterial: any;
      meshNormalMaterial: any;
      meshDepthMaterial: any;
      meshToonMaterial: any;
      pointsMaterial: any;
      
      // Lights
      pointLight: any;
      ambientLight: any;
      directionalLight: any;
      spotLight: any;
      hemisphereLight: any;
      rectAreaLight: any;

      // Helpers & Misc
      fog: any;
      color: any;
      gridHelper: any;
      axesHelper: any;
      arrowHelper: any;
    }
  }
}

export enum ViewMode {
  FREE = 'FREE',
  FOLLOW_PRESENTER = 'FOLLOW_PRESENTER',
  POV_AGENT = 'POV_AGENT',
  AI_GUIDED = 'AI_GUIDED',
  SPLIT_SCREEN = 'SPLIT_SCREEN'
}

export enum RepresentationMode {
  MINIMAL = 'MINIMAL',
  FULL = 'FULL'
}

export enum AgentStyle {
  BOX = 'BOX',
  CAPSULE = 'CAPSULE',
  ROBOT = 'ROBOT',
  VR_HEADSET = 'VR_HEADSET'
}

export interface PointOfInterest {
  id: string;
  position: Vector3;
  label: string;
  type: 'KNOB' | 'SCREEN' | 'KEY' | 'GENERAL';
}

export type AgentRole = 'PRESENTER' | 'REVIEWER' | 'OBSERVER';

export type AgentBehaviorState = 'IDLE' | 'MOVING' | 'INSPECTING' | 'DISCUSSING' | 'FOLLOWING' | 'FOLLOWING_AGENT';

export interface AgentState {
  id: string;
  name: string;
  role: AgentRole;
  color: string;
  behavior: AgentBehaviorState;
  currentPoiId: string | null; // The POI they are interested in
  attentionLevel: number; // 0-1, simulates cognitive load/focus
}

export interface SimulationFrame {
  time: number;
  isPlaying: boolean;
}

export interface ChatMessage {
  id: string;
  agentId: string;
  text: string;
  timestamp: number;
  /**
   * Fallback speaker label for messages whose agentId does not match any
   * agent in the store (e.g. live-transcript lines from T4.7, where there is
   * no diarization and every line is labelled 'Meeting'). ConversationPanel
   * and BoardroomShell fall back to this when `agents.find(a => a.id === agentId)`
   * returns undefined.
   */
  speakerName?: string;
  /**
   * The userId of the participant who spoke this line. Stamped server-side
   * (room.server.ts overwrites it from the connection) so nobody can post
   * lines as somebody else. Present on every line from the per-speaker
   * transcript path (section B of the grounded-capture plan).
   */
  speakerId?: string;
  /**
   * Milliseconds since the recording started, from the sender's own clock.
   * Used to merge lines from multiple speakers into a single ordered
   * transcript. Absent on legacy lines (pre-section-B) and on system
   * messages (gap lines, error lines).
   */
  offsetMs?: number;
}

export type InsightType = 'RISK' | 'RATIONALE' | 'ACTION';

// DETAILED DESIGN TYPES
export type DecisionRole = "TRIGGER" | "RATIONALE" | "INTERMEDIATE_DECISION" | "FINAL_DECISION";

export interface InsightDetails {
  priority: 'Critical' | 'High' | 'Medium' | 'Low';
  status: 'Open' | 'In Review' | 'Approved' | 'Rejected';
  assignee?: string;
  dueDate?: string;
  /**
   * The deadline as it was SAID — "by Friday", "end of the month" — copied
   * verbatim out of the transcript (docs/plan/14 batch BG).
   *
   * It exists because the built-in 7B model cannot do date arithmetic: given
   * today's date and a fortnight of weekday names it still answered a Monday's
   * "by Friday" with the wrong day. lib/capture/resolveDeadline.ts resolves the
   * phrase in code instead, and where it can, its answer replaces `dueDate`.
   * The words stay on the card too, so a phrase this code does not know ("before
   * the freeze") is still visible to a reviewer rather than silently dropped.
   */
  dueDateText?: string;
  componentReference?: string; // The name of the component from the tree
  
  // Design Review Metadata
  designStage?: "DETAILED_DESIGN";
  decisionRole?: DecisionRole;

  // Risk Specific
  impact?: string;
  mitigationStrategy?: string;
  
  // Rationale Specific
  designDriver?: string;
  alternativesConsidered?: string;
  tradeoffAnalysis?: string;
  
  // Action Specific
  department?: string;
}

export interface InsightCard {
  id: string;
  type: InsightType;
  agentId: string;
  title: string;
  description: string;
  timestamp: number;
  relatedPoiId?: string;
  sourceMessageIds?: string[]; // Array of IDs linking back to the conversation cluster
  details: InsightDetails;

  /**
   * Who wrote this card: an agent that read the transcript, or a person in the
   * room who typed it (docs/plan/14 batch BG). Absent means 'ai', which is what
   * every card was before hand-made ones existed — including every card already
   * in the tracker.
   */
  source?: 'ai' | 'manual';
  /**
   * The display name behind a hand-made card, so the tracker can say "added by
   * Maria" instead of naming an agent. Not set on an agent's card: agentId
   * already says who wrote it.
   */
  createdByName?: string;

  // NEW: Compliance & Historical Data
  affectedRequirementIds?: string[];
  kbRecommendations?: string[];
}

// --- BOARDROOM TYPES ---
export type BoardroomLayout = 'focus' | 'gallery';

// --- SCENE GRAPH TYPES ---

export interface SceneNode {
  id: string;
  name: string;
  type: 'GROUP' | 'MESH' | 'PART';
  children?: SceneNode[];
}

export interface ObjectState {
  id: string;
  visible: boolean;
  selected: boolean;
  expanded?: boolean;
}

// --- DOCUMENTATION TYPES ---

export interface Requirement {
  id: string;
  code: string;
  description: string;
  /** Free text. A fixed list (MECHANICAL/ELECTRICAL/...) was our vocabulary
   *  imposed on the user's; they type their own (user, 2026-09-23). */
  category: string;
  status: 'MET' | 'PENDING' | 'AT_RISK';
}

export interface KBEntry {
    id: string;
    category: InsightType;
    triggerKeyword: string;
    recommendation: string;
}

// --- COMMENT SYSTEM TYPES ---

export interface SpatialComment {
    id: string;
    type: 'text' | 'drawing';
    content: string;
    drawingData?: string; // Base64 PNG for drawings
    author: string;
    authorColor: string;
    timestamp: number;
    position: { x: number; y: number; z: number };
    attachedToNodeId: string;
    attachedToNodeName: string;
    assignees: string[]; // @mentioned users
    resolved: boolean;
    linkedToMeeting: boolean; // If captured in meeting transcript
    // NEW: UI state for 3D display
    expanded?: boolean; // Whether comment text is expanded in 3D scene
    screenOffset?: { x: number; y: number }; // Offset for drag positioning
    // Synthesized from a curated review viewpoint or pin. UI surfaces a
    // "PRE-REVIEW" badge for these and edits flow back through the review store.
    preReview?: boolean;
    // Source id back-reference (viewpointId or pinId) when preReview is true.
    preReviewSourceId?: string;
    // 'viewpoint' (visual annotation) or 'pin' (text-only) — when preReview.
    preReviewSourceKind?: 'viewpoint' | 'pin';
}

/**
 * What the next click on the model means.
 *
 * 'placing-pin' is batch BI's: the review's Pins tab could list, jump to and edit
 * a pin but not add one, because the only raycast in the room is this one and it
 * belonged to the comment panel. Reusing it — rather than growing a second
 * listener that finds the point and the part its own way — is what makes a pin
 * added in Edit mode land on the same part a comment would have, on everybody's
 * screen.
 */
export type CommentMode = 'none' | 'placing-comment' | 'placing-drawing' | 'placing-pin' | 'positioning-drawing' | 'drawing';

// --- MODEL IMPORT TYPES ---

export interface ImportedModel {
    id: string;
    name: string;
    fileName: string;
    importedAt: number;
    sceneTree: SceneNode;
}

/**
 * What the renderer is showing.
 *
 * 'none' is batch BI's, and it is the DEFAULT: a room and a new design review both
 * start with nothing on screen, and the three models that ship with the app are
 * samples somebody chooses rather than a product every meeting opens on. Every
 * reader has to cope with it — there is no part list, nothing to raycast against
 * and no product name to put in a tracker row.
 *
 * 'imported' is not chosen either: it is what the scene reads as while it holds
 * models of its own.
 */
export type ModelType = 'none' | 'synth' | 'bicycle' | 'imported' | 'headphones';

// --- XR TYPES ---

export type XRPose = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
};

export interface XRParticipantData {
  userId: string;
  name: string;
  color: string;
  head: XRPose;
  leftController?: XRPose;
  rightController?: XRPose;
}

// --- PANEL MODE TYPES ---

export type RightPanelMode = 'meeting' | 'comments' | 'chat';

/**
 * The transform the amber strip applies to the selected scene model, or null for
 * no gizmo. The three names are drei's TransformControls modes, which is why they
 * are spelled 'translate' rather than the strip's own label "Move": the strip
 * translates a button into one of these and the canvas hands it straight to drei.
 * Batch BH (docs/plan/14-rooms-models-admin-ai.md).
 */
export type ReviewGizmoMode = 'translate' | 'rotate' | 'scale' | null;

/**
 * What the amber strip's three tools are attached to: the whole selected model, or
 * the one part of it that is selected. Batch BR
 * (docs/plan/14-rooms-models-admin-ai.md).
 *
 * The three MODES do not change — Move is Move either way — which is the point of a
 * second switch beside them rather than three more buttons: a person who has found
 * the tool they want should not have to find it again to use it on something else.
 *
 * 'model' is the default and the one every screen written before this batch means.
 */
export type ReviewGizmoTarget = 'model' | 'part';

/**
 * Where the room's camera is, as a review viewpoint needs it.
 *
 * The three fields ReviewViewpoint carries about a place in the model, without the
 * id, the label or the timestamp that make it a saved one. "Save this view" reads
 * this from inside the canvas and hands it to the review; a jump-to reads it back.
 * Batch BH (docs/plan/14-rooms-models-admin-ai.md).
 */
export interface ViewCapture {
  position: [number, number, number];
  lookAt: [number, number, number];
  /** A JPEG data URL of the frame, or absent when the canvas would not give one. */
  thumbnail?: string;
}

export type ChatTag = 'RISK' | 'ACTION' | 'DECISION' | 'NOTE';

export interface LiveChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  text: string;
  timestamp: number;
  tag?: ChatTag;
}
