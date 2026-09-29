import React, { useEffect, useRef, useCallback } from 'react';
import PartySocket from 'partysocket';
import type { ParticipantPresence, WebRTCSignalData, ModelReference } from '../party/room.server';
import type { InsightCard, LiveChatMessage, XRParticipantData, SpatialComment } from '../types';
import { remoteXRParticipants } from './xrPresenceRef';
import { remoteLaserTargets, remoteLaserColors, remoteLaserMeshNames, remoteLaserPartNames, remoteLaserLastUpdate } from './laserTargetRef';
import { useActiveReviewStore } from './activeReviewStore';
import { forgetLocalEdit } from './reviewLocalEdit';
import type { ReviewDraft } from './reviewSetupStore';
import { useStore } from '../store';
import { ViewMode } from '../types';
import { clearModelFileCache } from './modelsClient';
import {
  describeSceneRefusal,
  emptyScene,
  scenePermissions,
  type BuiltInModel,
  type ModelEditors,
  type RoomScene,
  type SceneRefusalReason,
  type SceneStatePayload,
  type SceneUpdate,
} from './scene/roomScene';
import { showReviewScene } from './scene/showCurationModel';
import { useReviewRole } from './reviews/useReviewRole';
import { reviewIdOfPartyRoom } from './reviews/partyRoom';
import type { Role } from './reviews/roles';
import { asSceneStatePayload, sceneFromLegacyReference } from './scene/sceneWire';
import { usePointingTimelineStore } from './pointingTimelineStore';
import type { PointingSegment } from './pointingTimelineStore';
import { supabase } from './supabase';
import { getStoredIdentity } from './identity';
import { recordingStateRef, type RecordingStatePayload } from './recordingState';
import { setTranscriptKeep, type TranscriptKeepPayload } from './transcriptKeep';
import type { Session } from '@supabase/supabase-js';

export type { ParticipantPresence };
// Re-exported from where it now lives, so this module's readers — usePointingTimeline,
// RecordingContext — keep importing it from here. See lib/recordingState.ts.
export type { RecordingStatePayload };
// Same reasoning, and the same kind of reader: store.ts's endMeeting reads the
// choice from lib/transcriptKeep rather than from here. See that module's header.
export type { TranscriptKeepPayload };

type RoomMessage =
  | { type: 'PRESENCE'; payload: ParticipantPresence }
  | { type: 'LEAVE'; payload: { userId: string } }
  | { type: 'ROSTER'; payload: ParticipantPresence[] }
  | { type: 'PRESENTER_CHANGE'; payload: { agentId: string | null } }
  | { type: 'INSIGHT_CARD'; payload: InsightCard }
  | { type: 'LEADER_CHANGE'; payload: { userId: string | null } }
  | { type: 'BOARDROOM_COUNTDOWN'; payload: Record<string, never> }
  | { type: 'BOARDROOM_STATE'; payload: { active: boolean; leaderId: string | null; takeover: { enabled: boolean; approvedUserIds: string[] } } }
  | { type: 'ARENA_ENTRY'; payload: Record<string, never> }
  | { type: 'LASER_MOVE'; payload: { userId: string; position: [number, number, number] | null; targetId?: string | null; targetMeshName?: string | null; targetPartName?: string | null } }
  | { type: 'PRIVACY_MODE'; payload: { enabled: boolean } }
  | { type: 'LEADER_TAKEOVER'; payload: { userId: string } }
  | { type: 'MODEL_CHANGE'; payload: ModelReference }
  | { type: 'SCENE_STATE'; payload: SceneStatePayload }
  | { type: 'SCENE_UPDATE'; payload: SceneUpdate }
  // The scene a client computed from its design review's history, offered to a room
  // whose server says it has never held one. Accepted once, by a connection that may
  // change the models; see seedScene in party/room.server.ts.
  | { type: 'SCENE_SEED'; payload: RoomScene }
  | { type: 'SCENE_REFUSED'; payload: { reason: SceneRefusalReason } }
  | { type: 'SET_MODEL_EDITORS'; payload: { modelEditors: ModelEditors } }
  | { type: 'REVIEW_CONFIG'; payload: { config: ReviewDraft } }
  // Editing the review (batch BH). A REQUEST and an ANSWER, not one message: the
  // client asks to edit and the room says whether it may, because "only one
  // person edits at a time" is a fact about the room and a client cannot know it.
  // EDITING_REFUSED and EDITING_TAKEN_OVER go to one connection; EDITING_STATE is
  // relayed to the whole room, sender included.
  | { type: 'EDITING_START'; payload: { force?: boolean } }
  | { type: 'EDITING_STOP'; payload: Record<string, never> }
  | { type: 'EDITING_STATE'; payload: { editorUserId: string | null; editorName: string | null } }
  | { type: 'EDITING_REFUSED'; payload: { reason: 'busy' | 'role' | 'dropped'; editorName: string | null } }
  | { type: 'EDITING_TAKEN_OVER'; payload: { byName: string } }
  | { type: 'HOST_CHANGE'; payload: { hostId: string | null } }
  | { type: 'HOST_TRANSFER'; payload: { toUserId: string } }
  | { type: 'MEETING_END'; payload: Record<string, never> }
  | { type: 'TAKEOVER_SYNC'; payload: { enabled: boolean; approvedUserIds: string[] } }
  | { type: 'PRESENTER_REQUEST'; payload: { fromUserId: string; fromName: string } }
  | { type: 'PRESENTER_REQUEST_DENIED'; payload: { fromUserId: string } }
  | { type: 'TAKEOVER_ATTEMPT'; payload: { userId: string } }
  | { type: 'PRESENTER_CHANGED'; payload: { userId: string } }
  | { type: 'COMMENT_ADD'; payload: { comment: SpatialComment } }
  | { type: 'COMMENT_UPDATE'; payload: { id: string; updates: Partial<SpatialComment> } }
  | { type: 'COMMENT_DELETE'; payload: { id: string } }
  | { type: 'COMMENT_RESOLVE'; payload: { id: string } }
  | { type: 'COMMENT_ROSTER'; payload: { comments: SpatialComment[] } }
  | { type: 'WEBRTC_SIGNAL'; payload: { from: string; to: string; data: WebRTCSignalData } }
  | { type: 'LIVE_CHAT'; payload: LiveChatMessage }
  | { type: 'XR_PRESENCE'; payload: XRParticipantData }
  | { type: 'TRANSCRIPT_LINE'; payload: import('../types').ChatMessage }
  | { type: 'RECORDING_STATE'; payload: { recording: boolean; startedAt: number; byUserId: string; byName: string } }
  // "Save the transcript with this meeting", chosen by whoever stopped the recording
  // and carried out by whoever ends it — which may be a different browser. Relayed
  // by the room server to everybody and kept for late joiners; host-only, and the
  // server is what enforces that (batch BU).
  | { type: 'TRANSCRIPT_KEEP'; payload: TranscriptKeepPayload }
  | { type: 'POINTING_SEGMENT'; payload: import('./pointingTimelineStore').PointingSegment }
  | { type: 'ADMIT'; payload: { userId: string } }
  | { type: 'DECLINE'; payload: { userId: string } }
  | { type: 'SET_JOIN_POLICY'; payload: { policy: 'open' | 'ask' } }
  | { type: 'JOIN_PENDING'; payload: Record<string, never> }
  | { type: 'JOIN_ADMITTED'; payload: Record<string, never> }
  | { type: 'JOIN_DECLINED'; payload: Record<string, never> }
  | { type: 'JOIN_REQUESTS'; payload: { pending: Array<{ userId: string; name: string; since: number }> } }
  | { type: 'JOIN_POLICY'; payload: { policy: 'open' | 'ask' } };

// Module-level ref so it persists across re-renders and is accessible from the message handler
const webRTCSignalHandlerRef: { current: ((payload: { from: string; to: string; data: WebRTCSignalData }) => void) | null } = { current: null };

// Module-level socket ref so broadcastTranscriptLine (called from useLiveTranscript,
// outside the hook) can send without going through the hook's return value.
const partySocketRef: { current: PartySocket | null } = { current: null };

// Recording state: module-level so broadcastRecordingState (called from
// RecordingContext, outside the hook's return) can send without a socket
// ref of its own. Subscribers are notified when the state changes so the
// RecordingIndicator and per-client mic slicer can react.
//
// The ref itself lives in lib/recordingState.ts, which imports nothing: store.ts's
// endMeeting reads the recording's startedAt from there to pick out this meeting's
// live transcript, and this module imports the store.
const recordingStateSubscribers = new Set<(state: RecordingStatePayload | null) => void>();

function notifyRecordingStateSubscribers() {
  for (const sub of recordingStateSubscribers) {
    sub(recordingStateRef.current);
  }
}

/**
 * Subscribe to recording-state changes. Returns an unsubscribe function.
 * The subscriber is called immediately with the current state (which may be
 * null if no recording is in progress).
 */
export function subscribeRecordingState(
  listener: (state: RecordingStatePayload | null) => void,
): () => void {
  recordingStateSubscribers.add(listener);
  listener(recordingStateRef.current);
  return () => { recordingStateSubscribers.delete(listener); };
}

// Join state: module-level, same pattern as recording state. The hook
// exposes useJoinState() and useJoinRequests() so components can subscribe
// without building fresh arrays/objects on every render (React error #185).
export type JoinState = 'joining' | 'pending' | 'admitted' | 'declined';
export interface JoinRequest {
  userId: string;
  name: string;
  since: number;
  /** True when the knocker has no account on this deployment. */
  guest?: boolean;
}
const joinStateRef: { current: JoinState } = { current: 'joining' };
const joinStateSubscribers = new Set<(state: JoinState) => void>();
const joinRequestsRef: { current: JoinRequest[] } = { current: [] };
const joinRequestsSubscribers = new Set<(reqs: JoinRequest[]) => void>();
const joinPolicyRef: { current: 'open' | 'ask' } = { current: 'ask' };
const joinPolicySubscribers = new Set<(policy: 'open' | 'ask') => void>();

function notifyJoinStateSubscribers() {
  for (const sub of joinStateSubscribers) {
    sub(joinStateRef.current);
  }
}
function notifyJoinRequestsSubscribers() {
  for (const sub of joinRequestsSubscribers) {
    sub(joinRequestsRef.current);
  }
}
function notifyJoinPolicySubscribers() {
  for (const sub of joinPolicySubscribers) {
    sub(joinPolicyRef.current);
  }
}

export function subscribeJoinState(listener: (state: JoinState) => void): () => void {
  joinStateSubscribers.add(listener);
  listener(joinStateRef.current);
  return () => { joinStateSubscribers.delete(listener); };
}
export function subscribeJoinRequests(listener: (reqs: JoinRequest[]) => void): () => void {
  joinRequestsSubscribers.add(listener);
  listener(joinRequestsRef.current);
  return () => { joinRequestsSubscribers.delete(listener); };
}
export function subscribeJoinPolicy(listener: (policy: 'open' | 'ask') => void): () => void {
  joinPolicySubscribers.add(listener);
  listener(joinPolicyRef.current);
  return () => { joinPolicySubscribers.delete(listener); };
}

/** React hook — returns the current join gate state. */
export function useJoinState(): JoinState {
  const [state, setState] = React.useState<JoinState>(joinStateRef.current);
  React.useEffect(() => subscribeJoinState(setState), []);
  return state;
}

/** React hook — returns the pending join queue (stable ref when unchanged). */
export function useJoinRequests(): JoinRequest[] {
  const [reqs, setReqs] = React.useState<JoinRequest[]>(joinRequestsRef.current);
  React.useEffect(() => subscribeJoinRequests(setReqs), []);
  return reqs;
}

/** React hook — returns the current join policy. */
export function useJoinPolicy(): 'open' | 'ask' {
  const [policy, setPolicy] = React.useState<'open' | 'ask'>(joinPolicyRef.current);
  React.useEffect(() => subscribeJoinPolicy(setPolicy), []);
  return policy;
}

// Seen transcript-line IDs for deduplication. A Set that is bounded: the live
// transcript produces at most a few hundred IDs per meeting, and the Set is
// cleared when the hook unmounts (room change).
const seenTranscriptIds = new Set<string>();

const PARTYKIT_HOST: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_PARTYKIT_HOST) || 'localhost:1999';

/**
 * 'wss' whenever the page itself is https, else undefined (partysocket decides).
 *
 * partysocket picks plain ws:// for any host that looks local: localhost:,
 * 127.0.0.1:, 192.168., 10., 172.16-31. That suits `partykit dev`, but the
 * self-hosted stack serves the app over https at https://localhost/ (the
 * installer's default) or a LAN IP, with PartyKit behind TLS on :8443. There
 * the ws:// guess fails the handshake, and a browser would block ws:// from an
 * https page anyway. Found on the first live Docker run.
 */
export function partykitProtocol(pageProtocol?: string): 'wss' | undefined {
  const proto = pageProtocol ?? (typeof window !== 'undefined' ? window.location.protocol : undefined);
  return proto === 'https:' ? 'wss' : undefined;
}

function getUserInfo(): { userId: string; name: string; color: string; guest: boolean } {
  const stored = localStorage.getItem('vp_user');
  const user = stored ? JSON.parse(stored) : { name: 'Guest', color: '#4F8EF7' };
  let userId = sessionStorage.getItem('vp_userId');
  if (!userId) {
    userId = crypto.randomUUID();
    sessionStorage.setItem('vp_userId', userId);
  }
  // Read here, once, like the name: whoever wrote vp_user — the lobby's form or
  // a sign-in — did it before this room was entered.
  return { userId, name: user.name || 'Guest', color: user.color || '#4F8EF7', guest: user.guest === true };
}

/**
 * Whether this browser is signed in, and therefore has an access token the
 * room server can be handed.
 *
 * Read from vp_user rather than from the deployment's config, which is what
 * keeps identity.mode 'none' untouched: nothing ever writes an accountId
 * there, so this answers false and the hook below never calls Supabase at all.
 * A default install gains no request to an auth service it is not running.
 */
function isSignedIn(): boolean {
  const stored = getStoredIdentity();
  if (stored?.guest === true) return false;
  return typeof stored?.accountId === 'string' && stored.accountId !== '';
}

export interface RemoteLaserState {
  position: [number, number, number] | null;
  targetId: string | null;
  targetMeshName: string | null;
  partName: string | null;
}

export interface RemoteParticipantInfo {
  userId: string;
  name: string;
  color: string;
  sameRoom?: boolean;
  /** Whose camera this participant is locked to. Absent = following nobody. */
  followingUserId?: string | null;
  /** True while they are dragging their own view without leaving the follow. */
  followNudged?: boolean;
  /** True when they are here without an account. Render with participantLabel(). */
  guest?: boolean;
}

export interface UsePartyPresenceReturn {
  localUserId: string;
  remoteParticipants: React.MutableRefObject<Map<string, ParticipantPresence>>;
  remoteLasers: React.MutableRefObject<Map<string, RemoteLaserState>>;
  remoteParticipantList: RemoteParticipantInfo[];
  broadcastPresence: (position: [number, number, number], lookAt: [number, number, number]) => void;
  setSameRoom: (value: boolean) => void;
  broadcastPresenterChange: (agentId: string | null) => void;
  broadcastInsightCard: (card: InsightCard) => void;
  broadcastLeaderChange: (userId: string | null) => void;
  broadcastBoardroomCountdown: () => void;
  broadcastArenaEntry: () => void;
  broadcastLaserMove: (position: [number, number, number] | null, targetId?: string | null, targetMeshName?: string | null, targetPartName?: string | null) => void;
  broadcastPrivacyMode: (enabled: boolean) => void;
  broadcastLeaderTakeover: (userId: string) => void;
  broadcastSceneUpdate: (update: SceneUpdate) => boolean;
  broadcastSetModelEditors: (modelEditors: ModelEditors) => boolean;
  broadcastReviewConfig: (config: ReviewDraft) => boolean;
  /**
   * Ask the room for Edit. Answered by EDITING_STATE (room-wide) or
   * EDITING_REFUSED (to this connection), so this returns nothing: whether the
   * request was granted is state, not a result. See requestReviewEdit.
   */
  requestReviewEdit: (force?: boolean) => void;
  /** Give Edit up. */
  endReviewEdit: () => void;
  broadcastMeetingEnd: () => void;
  broadcastTakeoverSync: (enabled: boolean, approvedUserIds: string[]) => void;
  broadcastHostTransfer: (toUserId: string) => void;
  broadcastPresenterRequest: (fromUserId: string, fromName: string) => void;
  broadcastPresenterRequestDenied: (fromUserId: string) => void;
  broadcastTakeoverAttempt: (userId: string) => void;
  broadcastCommentAdd: (comment: SpatialComment) => void;
  broadcastCommentUpdate: (id: string, updates: Partial<SpatialComment>) => void;
  broadcastChatMessage: (msg: LiveChatMessage) => void;
  broadcastXRPresence: (data: XRParticipantData) => void;
  broadcastCommentDelete: (id: string) => void;
  broadcastCommentResolve: (id: string) => void;
  broadcastWebRTCSignal: (to: string, data: WebRTCSignalData) => void;
  registerWebRTCSignalHandler: (handler: (payload: { from: string; to: string; data: WebRTCSignalData }) => void) => () => void;
}

export function usePartyPresence(roomId: string | undefined): UsePartyPresenceReturn {
  const remoteParticipants = useRef<Map<string, ParticipantPresence>>(new Map());
  const remoteLasers = useRef<Map<string, RemoteLaserState>>(new Map());
  const [remoteParticipantList, setRemoteParticipantList] = React.useState<RemoteParticipantInfo[]>([]);
  const socketRef = useRef<PartySocket | null>(null);
  const userRef = useRef(getUserInfo());
  const sameRoomRef = useRef(false);
  const lastPresenceRef = useRef<{ position: [number, number, number]; lookAt: [number, number, number] }>({
    position: [0, 0, 0],
    lookAt: [0, 0, 0],
  });
  // The signed-in person's access token, for the room server to verify and
  // then drop (party/room.server.ts, party/verifyJwt.ts). A ref rather than
  // state: presence goes out from a frame loop and from a knock timer, and a
  // token refresh an hour later must not re-render a room to deliver it.
  const accessTokenRef = useRef<string | null>(null);
  // Set by the socket effect below so this one can re-knock the moment a token
  // arrives. Without it a first knock that beats getSession() — unlikely, since
  // a websocket handshake is slower than a localStorage read, but not
  // impossible — would leave a signed-in person in the host's queue marked as a
  // guest until the next three-second tick.
  const knockRef = useRef<(() => void) | null>(null);

  const {
    addInsightCard, setActiveAgent, setViewMode, setFollowingRemoteUser,
    triggerBoardroomEntry, setPrivacyMode, setBoardroomLeaderId, setSessionHostId,
    setPendingPresenterRequest, setTakeoverModeEnabled, setTakeoverApprovedUserIds,
    setPresenterRequestStatus,
  } = useStore.getState();

  function syncList() {
    setRemoteParticipantList(
      Array.from(remoteParticipants.current.values()).map(({ userId, name, color, sameRoom, followingUserId, followNudged, guest }) => ({ userId, name, color, sameRoom, followingUserId, followNudged, guest })),
    );
  }

  // ─── Starting a room that has never held a scene (batch BQ2) ───────────────────
  //
  // The room server sends its scene on connect even when it is empty, and the handler
  // below replaces this browser's copy with what arrives — batch BB's rule, and the
  // right one for a room that IS the live space. But "empty" was two different facts
  // with no way to tell them apart: a room somebody cleared, and a room nobody has ever
  // put anything into. Every new variant room is the second kind, and so is any main
  // room whose server storage is gone, and both wiped the models this browser had just
  // built from the review's history. That is how the variant of a review holding two
  // imported models came to show "No model yet", and went on showing it after a reload.
  //
  // `seeded: false` is the server saying it is the second kind. The answer is not to
  // keep the empty scene but to compute the review's and offer it back — once, and only
  // from a connection the SAME rule as SCENE_UPDATE lets change the models. Everybody
  // else waits for the seeded SCENE_STATE that offer causes, so a participant and a
  // late joiner both get the scene without being able to choose it.
  const sessionHostId = useStore((state) => state.sessionHostId);
  const { role, rolesApply, loading: roleLoading } = useReviewRole({
    // The REVIEW's roles, also in a variant's room (`<reviewId>~A`).
    reviewId: roomId ? reviewIdOfPartyRoom(roomId) : null,
    sessionHostId,
    localUserId: userRef.current.userId,
  });
  // Read through a ref inside the message handler, because nothing derived from a render
  // may become a dependency of the effect that owns the socket: this hook hands back a
  // fresh object literal every render, and an effect that re-ran on every render
  // reopened the room (the trap pages/RoomPage.tsx's seed effect documents).
  //
  // `ready` is the part that matters. On a deployment with accounts the role is the SAFE
  // one until the roster lands, so answering from it would have a participant who
  // happened to arrive first offer a seed the server would then refuse. Waiting costs
  // one round trip, and only on an install that has accounts.
  const sceneRoleRef = useRef<{ role: Role | null; ready: boolean }>({ role: null, ready: false });
  useEffect(() => {
    sceneRoleRef.current = rolesApply
      ? { role: roleLoading ? null : role, ready: !roleLoading }
      : { role: null, ready: true };
  });
  const sceneSeedRef = useRef({ unseeded: false, attemptedKey: null as string | null, inFlight: false });

  function attemptSceneSeed() {
    const seed = sceneSeedRef.current;
    if (!seed.unseeded || seed.inFlight) return;
    const config = useActiveReviewStore.getState().config;
    // No review in the store yet — and on a reload that is the common case rather than
    // an edge one, because the room's SCENE_STATE beats the row read that fills it. The
    // subscription the socket effect installs asks again the moment the config arrives.
    const reviewId = config?.reviewId ?? null;
    if (!reviewId) return;
    const lineId = useStore.getState().activeLine?.id ?? null;
    // Per line, the way showReviewScene's own once-per-open guard is keyed: one review
    // opened on its main line and on a variant is two different scenes.
    const key = lineId === null ? reviewId : `${reviewId} ${lineId}`;
    if (seed.attemptedKey === key) return;
    const authority = sceneRoleRef.current;
    if (!authority.ready) return;

    const { mayChangeModels } = scenePermissions({
      role: authority.role,
      modelEditors: useStore.getState().modelEditors,
      userId: userRef.current.userId || null,
      hostId: useStore.getState().sessionHostId,
    });
    // A "no" is NOT remembered. Found live (batch BQ2): in a fresh variant room the
    // first render asks before HOST_CHANGE has arrived, so the host — the only one who
    // may change models under "Host only" — was judged a participant, the answer was
    // remembered, and the room stayed empty for good. Asking again on the next render
    // is two ref reads. The room server checks the same rule on the way in — this is
    // the client not offering what would be refused.
    if (!mayChangeModels) return;
    seed.attemptedKey = key;

    seed.inFlight = true;
    void (async () => {
      try {
        // `force`, because the once-per-open guard protects a scene this room says it
        // does not have. And COMPUTED rather than read from the store first: the copy in
        // the store is the empty one the SCENE_STATE just put there.
        await showReviewScene(reviewId, config.asset, 'scene-seed', { force: true });
      } catch (err) {
        console.warn('[scene-seed] could not build this review’s scene:', err);
      }
      seed.inFlight = false;
      // Asked again after the read: somebody else's seed can land while this one is in
      // flight, and the room's answer to that is a SCENE_STATE with `seeded: true`.
      if (!seed.unseeded) return;
      const built = useStore.getState().scene;
      // A preset the review names is part of the scene record too (`builtIn`), so a room
      // that has never held anything starts from the same sample its review does. Read
      // from the ASSET rather than from the store when the store has nothing: the config's
      // own sync is what puts a preset on screen, and on a reload it runs a moment AFTER
      // the SCENE_STATE that wiped it.
      const named = config.asset?.modelType;
      const preset: BuiltInModel | null =
        named === 'synth' || named === 'headphones' || named === 'bicycle' ? named : null;
      // Nothing to offer — a review with no revisions, no model and no preset. The room
      // stays unseeded, which costs nothing and leaves the question open for a client that
      // can answer it.
      const offer: RoomScene | null =
        built.models.length > 0 || built.builtIn !== null
          ? built
          : preset === null
            ? null
            : { models: [], builtIn: preset };
      if (!offer) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        seed.attemptedKey = null;
        return;
      }
      // Cleared before the send rather than on the answer, so a second SCENE_STATE that
      // crosses the relay cannot produce a second offer from this connection.
      seed.unseeded = false;
      socket.send(JSON.stringify({ type: 'SCENE_SEED', payload: offer } as RoomMessage));
    })();
  }

  // Repeated on every render until it lands or is refused, because the three things it
  // waits for each arrive on their own schedule: the review's row, the line this room
  // resolved to, and — on a deployment with accounts — the roster the role is read from.
  // Every check above is a ref read or two and the first one ends it for a room that is
  // already seeded, which is every room but one nobody has put a model in yet.
  useEffect(() => {
    attemptSceneSeed();
  });

  // Declared before the socket effect on purpose: effects run in order, so this
  // one is already asking for the session while the socket is still
  // handshaking, and the first knock usually carries the token.
  useEffect(() => {
    if (!roomId) return;
    if (!isSignedIn()) {
      accessTokenRef.current = null;
      return;
    }

    let active = true;
    const apply = (session: Session | null) => {
      if (!active) return;
      accessTokenRef.current = session?.access_token ?? null;
      if (accessTokenRef.current) knockRef.current?.();
    };

    supabase.auth.getSession().then(
      ({ data }) => apply(data.session),
      () => apply(null),
    );

    // A token is refreshed hourly, and the room server re-verifies only when
    // the string changes — so the refresh has to reach the ref, or a meeting
    // that runs past the expiry would have its name demoted to "(guest)" while
    // everybody in it carries on talking.
    const { data } = supabase.auth.onAuthStateChange((_event, session) => apply(session));

    return () => {
      active = false;
      accessTokenRef.current = null;
      data.subscription.unsubscribe();
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;

    const socket = new PartySocket({ host: PARTYKIT_HOST, room: roomId, protocol: partykitProtocol() });
    socketRef.current = socket;
    partySocketRef.current = socket;

    // Reset join state for the new room connection.
    joinStateRef.current = 'joining';
    notifyJoinStateSubscribers();
    joinRequestsRef.current = [];
    notifyJoinRequestsSubscribers();

    // A new room is a new question about its scene, so nothing the last one answered
    // carries over — including "this browser may not change the models".
    sceneSeedRef.current = { unseeded: false, attemptedKey: null, inFlight: false };
    // The review's row lands AFTER the room's SCENE_STATE on a reload, and the seed is
    // built from that row. A zustand write does not re-render this hook, so the question
    // is asked again from a subscription rather than waited for.
    const stopSceneSeedWatch = useActiveReviewStore.subscribe((state) => {
      if (state.config) attemptSceneSeed();
    });

    // The previous room's models are of no use here and can be hundreds of
    // megabytes, so they go rather than waiting to be evicted. The scene goes
    // with them: a download still in flight for the old room checks the scene
    // before it stores anything (lib/scene/useSceneModelLoader), so emptying the
    // list is what stops the old room's model landing in the new one. The new
    // room's own SCENE_STATE, replayed once this connection is admitted, is what
    // puts its models back up.
    clearModelFileCache();
    useStore.getState().setRoomScene(emptyScene());
    // And nobody is editing until this room says so. The flag lives in the store and
    // is only ever set from the room's EDITING_STATE, so leaving a room mid-edit
    // (the Lobby link, a variant) carried it into every room opened after that —
    // the next room sends EDITING_STATE only while somebody IS editing, so nothing
    // ever cleared it, and Done asked a room that did not think you were editing
    // (user, 2026-09-26: "it gets stuck there and it is not possible to press done").
    useStore.getState().setReviewEditing(null);

    // Knock. PRESENCE is how a connection tells the server who it is, and the
    // server's knock gate answers it (admitted, or parked in the host's
    // queue). Until batch AI the first PRESENCE came from the 3D scene's frame
    // loop — but the scene does not mount until this hook says 'admitted', so
    // leaving it there deadlocks every room, the host's included: no PRESENCE,
    // no admission, no scene, no PRESENCE. The knock therefore lives here, in
    // the only code that is mounted before admission.
    //
    // It repeats while we are not admitted, for two reasons: PartySocket
    // reconnects silently (the new connection has to re-identify itself), and
    // the server admits a waiter immediately once the room has no admitted
    // participants left — so a host who closes the tab while someone waits
    // lets that person in on the next knock instead of stranding them.
    const knock = () => {
      const s = socketRef.current;
      if (!s || s.readyState !== WebSocket.OPEN) return;
      if (joinStateRef.current === 'admitted' || joinStateRef.current === 'declined') return;
      const { position, lookAt } = lastPresenceRef.current;
      // Same follow fields broadcastPresence sends: a PartySocket reconnect
      // re-identifies itself through here, and a knock without them would
      // blank the leader's "who is following me" badge until the scene's next
      // frame broadcast (~100ms later). The guest flag travels for the same
      // reason — it is what the host's knock prompt marks them with.
      const { followingRemoteUserId, followNudged } = useStore.getState();
      s.send(JSON.stringify({
        type: 'PRESENCE',
        payload: {
          userId: userRef.current.userId,
          name: userRef.current.name,
          color: userRef.current.color,
          position,
          lookAt,
          sameRoom: sameRoomRef.current,
          followingUserId: followingRemoteUserId,
          followNudged,
          guest: userRef.current.guest,
          // Proof of who this is, when there is an account to prove it with.
          // The server verifies it and deletes it before the payload is stored
          // or relayed; JSON.stringify drops the undefined, so a client with no
          // session sends exactly what it sent before identity existed.
          accessToken: accessTokenRef.current ?? undefined,
        },
      } as RoomMessage));
    };
    knockRef.current = knock;
    socket.addEventListener('open', knock);
    const knockTimer = setInterval(knock, 3000);

    socket.addEventListener('message', (event: MessageEvent) => {
      let msg: RoomMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      try {
      if (msg.type === 'ROSTER') {
        remoteParticipants.current.clear();
        for (const p of msg.payload) {
          if (p.userId !== userRef.current.userId) {
            remoteParticipants.current.set(p.userId, p);
          }
        }
        syncList();
      } else if (msg.type === 'PRESENCE') {
        if (msg.payload.userId !== userRef.current.userId) {
          const prev = remoteParticipants.current.get(msg.payload.userId);
          remoteParticipants.current.set(msg.payload.userId, msg.payload);
          // The follow fields drive the leader's "who is following me" badge,
          // so a change in either has to reach the list — not only a new join.
          // The guest flag is here for the same reason: it is what a name is
          // rendered with. Missing fields (an older client) read as "following
          // nobody" and "not a guest".
          const listChanged =
            (prev?.followingUserId ?? null) !== (msg.payload.followingUserId ?? null) ||
            (prev?.followNudged ?? false) !== (msg.payload.followNudged ?? false) ||
            (prev?.guest ?? false) !== (msg.payload.guest ?? false);
          if (!prev || listChanged) syncList();
        }
      } else if (msg.type === 'LEAVE') {
        const leavingId = msg.payload.userId;
        remoteParticipants.current.delete(leavingId);
        remoteLasers.current.delete(leavingId);
        remoteLaserTargets.delete(leavingId);
        remoteLaserColors.delete(leavingId);
        remoteLaserMeshNames.delete(leavingId);
        remoteLaserPartNames.delete(leavingId);
        remoteLaserLastUpdate.delete(leavingId);
        // If the leaving user was the active boardroom presenter on our local
        // state, snap to the host immediately. The server also broadcasts an
        // authoritative LEADER_TAKEOVER right after LEAVE, but we don't want
        // a stale leaderId pointing at a ghost in the interim.
        {
          const { boardroomLeaderId, sessionHostId } = useStore.getState();
          if (boardroomLeaderId === leavingId) {
            setBoardroomLeaderId(sessionHostId);
          }
        }
        syncList();
      } else if (msg.type === 'PRESENTER_CHANGE') {
        const { agentId } = msg.payload;
        setActiveAgent(agentId);
        setViewMode(agentId ? ViewMode.POV_AGENT : ViewMode.FREE);
      } else if (msg.type === 'INSIGHT_CARD') {
        addInsightCard(msg.payload);
      } else if (msg.type === 'LEADER_CHANGE') {
        const { leaderId, followingRemoteUserId } = useStore.getState();
        if (leaderId === 'USER' && !followingRemoteUserId) return;
        setFollowingRemoteUser(msg.payload.userId);
      } else if (msg.type === 'BOARDROOM_STATE') {
        // Late-joiner sync. Tolerant of the legacy `{ active }` shape so a
        // stale partykit dev server can't crash this handler and break the
        // rest of the message loop (incl. ROSTER/PRESENCE for participants).
        const payload = msg.payload as Partial<{
          active: boolean;
          leaderId: string | null;
          takeover: { enabled: boolean; approvedUserIds: string[] };
        }>;
        const { isBoardroomMode, toggleBoardroomMode } = useStore.getState();
        if (payload.active && !isBoardroomMode) {
          toggleBoardroomMode();
        }
        if (payload.active && payload.leaderId !== undefined) {
          setBoardroomLeaderId(payload.leaderId);
        }
        if (payload.takeover) {
          setTakeoverModeEnabled(!!payload.takeover.enabled);
          setTakeoverApprovedUserIds(payload.takeover.approvedUserIds ?? []);
        }
      } else if (msg.type === 'BOARDROOM_COUNTDOWN') {
        triggerBoardroomEntry();
      } else if (msg.type === 'ARENA_ENTRY') {
        const { isBoardroomMode, toggleBoardroomMode } = useStore.getState();
        if (isBoardroomMode) toggleBoardroomMode();
      } else if (msg.type === 'LASER_MOVE') {
        const { userId: laserId, position, targetId = null, targetMeshName = null, targetPartName = null } = msg.payload;
        if (laserId !== userRef.current.userId) {
          remoteLasers.current.set(laserId, { position, targetId, targetMeshName, partName: targetPartName });
          remoteLaserTargets.set(laserId, targetId);
          remoteLaserMeshNames.set(laserId, targetMeshName);
          remoteLaserPartNames.set(laserId, targetPartName);
          remoteLaserLastUpdate.set(laserId, Date.now());
          const color = remoteParticipants.current.get(laserId)?.color ?? '#ffffff';
          remoteLaserColors.set(laserId, color);
        }
      } else if (msg.type === 'PRIVACY_MODE') {
        setPrivacyMode(msg.payload.enabled);
      } else if (msg.type === 'LEADER_TAKEOVER') {
        // Server-authoritative: apply on every client (including sender) and
        // let BoardroomPresenterSync wire up followingRemoteUserId based on the
        // new leaderId. Also clear any local detach so the new presenter pin
        // takes effect immediately.
        const newLeaderId = msg.payload.userId;
        const { resumeBoardroomPresenter } = useStore.getState();
        setBoardroomLeaderId(newLeaderId);
        resumeBoardroomPresenter();
        // If this user just got accepted as presenter, clear any pending request UI
        if (newLeaderId === userRef.current.userId) {
          setPresenterRequestStatus(null);
        }
      } else if (msg.type === 'SCENE_STATE') {
        // The whole scene, from the server that owns it.
        //
        // Replaced wholesale rather than merged, and sent to the client that
        // asked for the change as well as everybody else: with several people
        // able to add, hide and move models, a client that merged its own
        // prediction into what arrived would sooner or later keep a model the
        // room had removed. Whatever this says is the scene, is.
        //
        // Nothing is downloaded here. The list holds hashes, and
        // lib/scene/useSceneModelLoader turns the ones this browser is missing
        // into geometry — which is what lets a late joiner arrive at the same
        // picture without this handler ever waiting on a 200 MB file.
        const state = asSceneStatePayload(msg.payload);
        if (!state) return;
        const { setRoomScene, setModelEditors, setSceneRefusal } = useStore.getState();
        setModelEditors(state.modelEditors);
        setRoomScene({ models: state.models, builtIn: state.builtIn });
        // A change that landed supersedes whatever was refused a moment ago: the
        // reason to keep showing it would be that the room is still saying no,
        // and it just said yes.
        setSceneRefusal(null);
        // Batch BQ2: this room has never held a scene, so the empty list above is an
        // absence rather than a decision, and the clients in it are being asked what it
        // shows. Answered from the review's own history for the LINE this room is on —
        // see attemptSceneSeed, which is also what decides whether this connection may
        // answer at all.
        sceneSeedRef.current.unseeded = !state.seeded;
        if (!state.seeded) attemptSceneSeed();
      } else if (msg.type === 'SCENE_REFUSED') {
        // Told to this connection only, because it is the only one that tried.
        // Surfaced in the model tree rather than logged: the alternative is a
        // person clicking an eye that does nothing and concluding the app is
        // broken, when what actually happened is that the host has not let them
        // change what the room is looking at.
        const reason = msg.payload.reason;
        // Unless what happened is that two connections offered the same empty room its
        // review's models at the same moment and the first one won. Nobody pressed
        // anything that was turned down, and the winner's SCENE_STATE is already on its
        // way, so this is dropped: a banner about a race the room settled correctly
        // would be noise about nothing.
        if (reason === 'already_seeded') return;
        useStore.getState().setSceneRefusal(describeSceneRefusal(reason));
      } else if (msg.type === 'MODEL_CHANGE') {
        // A room server that has not been updated still relays the one model it
        // was told about. Read as what that message always meant — a scene
        // holding exactly that model — so a mixed deployment shows the same
        // geometry on both sides instead of a blank canvas on the new client.
        const scene = sceneFromLegacyReference(msg.payload);
        if (scene) useStore.getState().setRoomScene(scene);
      } else if (msg.type === 'REVIEW_CONFIG') {
        // Store the curated review config — setConfig syncs the main store's
        // model type and comments automatically. The host sets its own draft
        // locally before broadcasting; receivers (including late joiners via
        // on-connect replay) update through here.
        useActiveReviewStore.getState().setConfig(msg.payload.config);
      } else if (msg.type === 'EDITING_STATE') {
        // The room's answer about who is editing. Written straight through,
        // including for the browser that asked: the request was a question, and
        // this is the answer, so the tools appear only once the room agrees.
        const { editorUserId, editorName } = msg.payload;
        const { setReviewEditing } = useStore.getState();
        setReviewEditing(editorUserId ? { userId: editorUserId, name: editorName ?? '' } : null);
      } else if (msg.type === 'EDITING_REFUSED') {
        // Told to this connection only, because it is the only one that asked.
        // Surfaced rather than logged: an Edit button that appears to do nothing
        // reads as a broken app, when what happened is that a colleague has it.
        useStore.getState().setReviewEditRefusal({
          reason: msg.payload.reason,
          editorName: msg.payload.editorName,
        });
      } else if (msg.type === 'EDITING_TAKEN_OVER') {
        // Also only to this connection — the one that was editing. The room hears
        // about the change through the EDITING_STATE that follows this message.
        useStore.getState().setReviewEditNotice(`${msg.payload.byName} took over editing`);
      } else if (msg.type === 'HOST_CHANGE') {
        setSessionHostId(msg.payload.hostId);
        // If I just became the host (e.g. previous host left), update local state
        if (msg.payload.hostId === userRef.current.userId) {
          setSessionHostId(msg.payload.hostId);
        }
      } else if (msg.type === 'MEETING_END') {
        // Somebody else in the room pressed End. This browser ends the meeting on
        // screen and records NOTHING. Cards are broadcast to everybody, so every
        // browser in the room holds the same insightCards and a three-person
        // meeting that let all three flush wrote three tracker_sessions — S1, S2
        // and S3 on the line — and every card three times. Only the browser whose
        // person pressed End records it; see endMeeting in store.ts.
        const { meetingEndedRemotely } = useStore.getState();
        meetingEndedRemotely();
      } else if (msg.type === 'TAKEOVER_SYNC') {
        setTakeoverModeEnabled(msg.payload.enabled);
        setTakeoverApprovedUserIds(msg.payload.approvedUserIds);
      } else if (msg.type === 'PRESENTER_REQUEST') {
        // Only the host handles this — store it for the host's UI to show
        const { sessionHostId } = useStore.getState();
        if (sessionHostId === userRef.current.userId) {
          setPendingPresenterRequest(msg.payload);
        }
      } else if (msg.type === 'PRESENTER_REQUEST_DENIED') {
        // Only the requestor cares — show "denied" toast briefly
        if (msg.payload.fromUserId === userRef.current.userId) {
          setPresenterRequestStatus('denied');
        }
      } else if (msg.type === 'PRESENTER_CHANGED') {
        // Server-authoritative presenter change (takeover mode)
        const newUserId = msg.payload.userId;
        const { resumeBoardroomPresenter } = useStore.getState();
        setBoardroomLeaderId(newUserId);
        resumeBoardroomPresenter(); // clear local detach state; BoardroomPresenterSync will update followingRemoteUserId
      } else if (msg.type === 'COMMENT_ROSTER') {
        const { setAllComments } = useStore.getState();
        setAllComments(msg.payload.comments);
      } else if (msg.type === 'COMMENT_ADD') {
        const { addComment } = useStore.getState();
        addComment(msg.payload.comment);
      } else if (msg.type === 'COMMENT_UPDATE') {
        const { updateComment } = useStore.getState();
        updateComment(msg.payload.id, msg.payload.updates);
      } else if (msg.type === 'COMMENT_DELETE') {
        const { deleteComment } = useStore.getState();
        // If the deleted comment was produced by committing a curated pin,
        // clear the pin's committedCommentId so it can be committed again.
        useActiveReviewStore.getState().clearCommittedCommentId(msg.payload.id);
        // Taken back at once: that clear came off the socket, so it is not this
        // browser's edit and must not make it write the review (batch BH3). The
        // browser that deleted the comment broadcasts the cleared review and
        // saves it itself.
        forgetLocalEdit();
        deleteComment(msg.payload.id);
      } else if (msg.type === 'COMMENT_RESOLVE') {
        const { resolveComment } = useStore.getState();
        resolveComment(msg.payload.id);
      } else if (msg.type === 'LIVE_CHAT') {
        const { addLiveChatMessage } = useStore.getState();
        addLiveChatMessage(msg.payload);
      } else if (msg.type === 'TRANSCRIPT_LINE') {
        // Dedupe by id: the sender both adds the line locally AND broadcasts it,
        // so without dedup the sender would see every line twice.
        const line = msg.payload;
        if (line && typeof line.id === 'string' && !seenTranscriptIds.has(line.id)) {
          seenTranscriptIds.add(line.id);
          const { chatHistory, addChatMessage } = useStore.getState();
          // Merge in offsetMs order when the sender supplied one; lines
          // without offsetMs (legacy, system messages) append at the end.
          if (typeof line.offsetMs === 'number') {
            const idx = chatHistory.findIndex(
              (m) => typeof m.offsetMs === 'number' && m.offsetMs > line.offsetMs!,
            );
            if (idx === -1) {
              addChatMessage(line);
            } else {
              // Insert before the first message with a larger offsetMs.
              const next = [...chatHistory];
              next.splice(idx, 0, line);
              useStore.setState({ chatHistory: next });
            }
          } else {
            addChatMessage(line);
          }
        }
      } else if (msg.type === 'RECORDING_STATE') {
        recordingStateRef.current = msg.payload;
        notifyRecordingStateSubscribers();
      } else if (msg.type === 'TRANSCRIPT_KEEP') {
        // Relayed to the sender as well as to everybody else, so a second tab of
        // the same person and a browser that rejoined mid-meeting hold the same
        // answer as the one that pressed the button.
        setTranscriptKeep(msg.payload);
      } else if (msg.type === 'POINTING_SEGMENT') {
        const { addSegment } = usePointingTimelineStore.getState();
        addSegment(msg.payload);
      } else if (msg.type === 'XR_PRESENCE') {
        const { userId } = msg.payload;
        if (userId !== userRef.current.userId) {
          remoteXRParticipants.set(userId, msg.payload);
        }
      } else if (msg.type === 'WEBRTC_SIGNAL') {
        webRTCSignalHandlerRef.current?.(msg.payload);
      } else if (msg.type === 'JOIN_PENDING') {
        joinStateRef.current = 'pending';
        notifyJoinStateSubscribers();
      } else if (msg.type === 'JOIN_ADMITTED') {
        joinStateRef.current = 'admitted';
        notifyJoinStateSubscribers();
      } else if (msg.type === 'JOIN_DECLINED') {
        joinStateRef.current = 'declined';
        notifyJoinStateSubscribers();
      } else if (msg.type === 'JOIN_REQUESTS') {
        joinRequestsRef.current = msg.payload.pending;
        notifyJoinRequestsSubscribers();
      } else if (msg.type === 'JOIN_POLICY') {
        joinPolicyRef.current = msg.payload.policy;
        notifyJoinPolicySubscribers();
      }
      } catch (err) {
        // One malformed/unexpected message must NOT take down the whole
        // message loop — especially the path that adds remote participants.
        // Most common cause: a stale partykit dev server emitting an older
        // payload shape than the client expects (e.g. BOARDROOM_STATE before
        // the takeover fields were added).
        console.error('[partypresence] error handling message', msg?.type, err);
      }
    });

    return () => {
      clearInterval(knockTimer);
      stopSceneSeedWatch();
      sceneSeedRef.current = { unseeded: false, attemptedKey: null, inFlight: false };
      socket.removeEventListener('open', knock);
      knockRef.current = null;
      socket.close();
      socketRef.current = null;
      partySocketRef.current = null;
      seenTranscriptIds.clear();
      remoteParticipants.current.clear();
      setRemoteParticipantList([]);
      recordingStateRef.current = null;
      notifyRecordingStateSubscribers();
      joinStateRef.current = 'joining';
      notifyJoinStateSubscribers();
      joinRequestsRef.current = [];
      notifyJoinRequestsSubscribers();
    };
  }, [roomId]);

  function broadcastPresence(position: [number, number, number], lookAt: [number, number, number]) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    lastPresenceRef.current = { position, lookAt };

    // Read here rather than passed in, so every broadcaster — the scene's
    // frame loop and mobile's 5s ping alike — reports who it is following.
    const { followingRemoteUserId, followNudged } = useStore.getState();

    const msg: RoomMessage = {
      type: 'PRESENCE',
      payload: {
        userId: userRef.current.userId,
        name: userRef.current.name,
        color: userRef.current.color,
        position,
        lookAt,
        sameRoom: sameRoomRef.current,
        followingUserId: followingRemoteUserId,
        followNudged,
        guest: userRef.current.guest,
        // Sent on every frame, and verified at most once per token string:
        // the server caches the answer per connection (party/room.server.ts),
        // so this costs a string comparison rather than an HMAC at 10 fps.
        accessToken: accessTokenRef.current ?? undefined,
      },
    };
    socket.send(JSON.stringify(msg));
  }

  function setSameRoom(value: boolean) {
    sameRoomRef.current = value;
    // Re-broadcast immediately so the flag propagates without waiting for the next frame
    const { position, lookAt } = lastPresenceRef.current;
    broadcastPresence(position, lookAt);
  }

  function broadcastPresenterChange(agentId: string | null) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'PRESENTER_CHANGE', payload: { agentId } }));
  }

  function broadcastInsightCard(card: InsightCard) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'INSIGHT_CARD', payload: card }));
  }

  function broadcastLeaderChange(userId: string | null) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'LEADER_CHANGE', payload: { userId } }));
  }

  function broadcastBoardroomCountdown() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'BOARDROOM_COUNTDOWN', payload: {} }));
  }

  function broadcastArenaEntry() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'ARENA_ENTRY', payload: {} }));
  }

  function broadcastLaserMove(position: [number, number, number] | null, targetId?: string | null, targetMeshName?: string | null, targetPartName?: string | null) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'LASER_MOVE',
      payload: {
        userId: userRef.current.userId,
        position,
        targetId: targetId ?? null,
        targetMeshName: targetMeshName ?? null,
        targetPartName: targetPartName ?? null,
      },
    }));
  }

  function broadcastPrivacyMode(enabled: boolean) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'PRIVACY_MODE', payload: { enabled } }));
  }

  function broadcastLeaderTakeover(userId: string) {
    // Optimistic local apply so the host's own UI is instant — the server's
    // echo to all clients (including the sender) then keeps everyone in sync.
    setBoardroomLeaderId(userId);
    useStore.getState().resumeBoardroomPresenter();
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'LEADER_TAKEOVER', payload: { userId } }));
  }

  function broadcastReviewConfig(config: ReviewDraft): boolean {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'REVIEW_CONFIG', payload: { config } }));
    return true;
  }

  /**
   * Ask the room to turn Edit on for me.
   *
   * A request, not a switch. The room server decides — whether this person's role
   * allows it at all, and whether somebody else already has it — and answers with
   * EDITING_STATE (to everybody, sender included) or EDITING_REFUSED (to me
   * alone). Nothing here writes to the store, so there is no frame in which the
   * tools are up before the room has agreed.
   *
   * `force` is the second press, from the "ask them, or take over" prompt: it ends
   * whoever was editing and tells them by name.
   */
  function requestReviewEdit(force = false) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    // Clearing a stale refusal first: the prompt the person just answered must
    // not still be on screen while the new answer is in flight.
    useStore.getState().setReviewEditRefusal(null);
    socket.send(JSON.stringify({ type: 'EDITING_START', payload: { force } } as RoomMessage));
  }

  /** Give Edit up. Only the person holding it can, and the server checks that too. */
  function endReviewEdit() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'EDITING_STOP', payload: {} } as RoomMessage));
  }

  /**
   * Ask the room to make ONE change to what is on screen.
   *
   * An operation, not a list. Sending "here is my scene" would be the natural
   * thing to write and is the bug it avoids: two people who each did that would
   * have the second silently undo the first, because neither had seen the
   * other's change. The server applies the operation to its own copy and relays
   * the result as SCENE_STATE — to this client too, which is how the caller
   * learns what the scene actually became.
   *
   * Answers false when there is no open socket, so a caller working outside a
   * room (the review setup page) can apply the change locally and know that is
   * all there is to do.
   */
  function broadcastSceneUpdate(update: SceneUpdate): boolean {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'SCENE_UPDATE', payload: update } as RoomMessage));
    return true;
  }

  /**
   * Host-only: choose who may change the models in this room.
   *
   * The server checks that the sender is the host before it changes anything, so
   * this is a request rather than a command — hiding the control from everybody
   * else is what makes it obvious, and refusing them is what makes it true.
   */
  function broadcastSetModelEditors(modelEditors: ModelEditors): boolean {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: 'SET_MODEL_EDITORS', payload: { modelEditors } } as RoomMessage));
    return true;
  }

  function broadcastMeetingEnd() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'MEETING_END', payload: {} }));
  }

  function broadcastTakeoverSync(enabled: boolean, approvedUserIds: string[]) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'TAKEOVER_SYNC', payload: { enabled, approvedUserIds } }));
  }

  function broadcastHostTransfer(toUserId: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'HOST_TRANSFER', payload: { toUserId } }));
  }

  function broadcastPresenterRequest(fromUserId: string, fromName: string) {
    // Mark the request as pending locally — UI shows a "requested…" badge until
    // accepted (LEADER_TAKEOVER arrives) or denied (PRESENTER_REQUEST_DENIED).
    useStore.getState().setPresenterRequestStatus('pending');
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'PRESENTER_REQUEST', payload: { fromUserId, fromName } }));
  }

  function broadcastPresenterRequestDenied(fromUserId: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'PRESENTER_REQUEST_DENIED', payload: { fromUserId } }));
  }

  function broadcastTakeoverAttempt(userId: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'TAKEOVER_ATTEMPT', payload: { userId } }));
  }

  function broadcastCommentAdd(comment: SpatialComment) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'COMMENT_ADD', payload: { comment } }));
  }

  function broadcastChatMessage(msg: LiveChatMessage) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'LIVE_CHAT', payload: msg }));
  }

  function broadcastXRPresence(data: XRParticipantData) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'XR_PRESENCE', payload: data }));
  }

  function broadcastCommentUpdate(id: string, updates: Partial<SpatialComment>) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'COMMENT_UPDATE', payload: { id, updates } }));
  }

  function broadcastCommentDelete(id: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'COMMENT_DELETE', payload: { id } }));
  }

  function broadcastCommentResolve(id: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'COMMENT_RESOLVE', payload: { id } }));
  }

  function broadcastWebRTCSignal(to: string, data: WebRTCSignalData) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'WEBRTC_SIGNAL',
      payload: { from: userRef.current.userId, to, data },
    }));
  }

  // Stable reference — must not change across renders so the useWebRTC effect only runs once.
  // If this were a plain function it would be recreated every render, causing the effect to
  // repeatedly cleanup (null) then re-register, creating a window where signals get dropped.
  const registerWebRTCSignalHandler = useCallback((handler: (payload: { from: string; to: string; data: WebRTCSignalData }) => void): () => void => {
    webRTCSignalHandlerRef.current = handler;
    return () => { webRTCSignalHandlerRef.current = null; };
  }, []);

  return {
    localUserId: userRef.current.userId,
    remoteParticipants,
    remoteLasers,
    remoteParticipantList,
    broadcastPresence,
    setSameRoom,
    broadcastPresenterChange,
    broadcastInsightCard,
    broadcastLeaderChange,
    broadcastBoardroomCountdown,
    broadcastArenaEntry,
    broadcastLaserMove,
    broadcastPrivacyMode,
    broadcastLeaderTakeover,
    broadcastSceneUpdate,
    broadcastSetModelEditors,
    broadcastReviewConfig,
    requestReviewEdit,
    endReviewEdit,
    broadcastMeetingEnd,
    broadcastTakeoverSync,
    broadcastHostTransfer,
    broadcastPresenterRequest,
    broadcastPresenterRequestDenied,
    broadcastTakeoverAttempt,
    broadcastCommentAdd,
    broadcastCommentUpdate,
    broadcastCommentDelete,
    broadcastCommentResolve,
    broadcastChatMessage,
    broadcastXRPresence,
    broadcastWebRTCSignal,
    registerWebRTCSignalHandler,
  };
}

/**
 * Broadcast a live-transcript line to every participant in the room.
 *
 * Module-level function (not a hook return) because useLiveTranscript calls it
 * from an async queue processor, outside the React render cycle. Uses the same
 * socket the hook opened; no-op when no room is connected.
 */
export function broadcastTranscriptLine(msg: import('../types').ChatMessage): void {
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  // Mark as seen locally so the sender does not add it twice when the server
  // echoes it back.
  seenTranscriptIds.add(msg.id);
  socket.send(JSON.stringify({ type: 'TRANSCRIPT_LINE', payload: msg }));
}

/**
 * Broadcast the recording state to every participant. The host calls this
 * when pressing Start or Stop; every client reacts by starting/stopping its
 * own mic slicer. Module-level for the same reason as broadcastTranscriptLine.
 */
export function broadcastRecordingState(state: RecordingStatePayload): void {
  recordingStateRef.current = state;
  notifyRecordingStateSubscribers();
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'RECORDING_STATE', payload: state }));
}

/**
 * Tell the room whether this meeting's transcript is to be stored with it.
 *
 * Written locally as well as sent, because the two halves of the choice can be the
 * same browser: a room with no server to relay through (a local room, a socket that
 * has not opened yet) still has to be able to record the meeting it just held, and
 * the person who pressed the button is then the person who ends it. Where there IS a
 * server it relays this to everybody, which is how the choice reaches the browser
 * that will record the meeting when that is somebody else.
 *
 * Host-only, and the room server enforces it rather than trusting this function to
 * be called from behind the right button.
 */
export function broadcastTranscriptKeep(payload: TranscriptKeepPayload): void {
  setTranscriptKeep(payload);
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'TRANSCRIPT_KEEP', payload }));
}

/**
 * Broadcast a finished pointing segment to the room. Called by
 * usePointingTimeline when a segment closes. Module-level for the same
 * reason as broadcastTranscriptLine.
 */
export function broadcastPointingSegment(seg: PointingSegment): void {
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'POINTING_SEGMENT', payload: seg }));
}

/** Host-only: admit a pending user. Module-level for the same reason as broadcastRecordingState. */
export function broadcastAdmit(userId: string): void {
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'ADMIT', payload: { userId } }));
}

/** Host-only: decline a pending user. */
export function broadcastDecline(userId: string): void {
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'DECLINE', payload: { userId } }));
}

/** Host-only: change the join policy for this room session. */
export function broadcastSetJoinPolicy(policy: 'open' | 'ask'): void {
  const socket = partySocketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'SET_JOIN_POLICY', payload: { policy } }));
}
