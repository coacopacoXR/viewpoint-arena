import React, { Suspense, useRef, useEffect, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Html } from '@react-three/drei';
import { XR } from '@react-three/xr';
import World from './World';
import RemoteParticipants from './RemoteParticipant';
import DialogueEngine from '../System/DialogueEngine';
import UserLaser from './UserLaser';
import MobileLaser from './MobileLaser';
import SpatialComments from './SpatialComments';
import XRManager from './XRManager';
import ReviewArtifacts from './ReviewArtifacts';
import ReviewModelGizmo from './ReviewModelGizmo';
import SceneClickSelect from './SceneClickSelect';
import { SCENE_TONE_MAPPING, SCENE_TONE_MAPPING_EXPOSURE } from './LightRig';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { participantLabel } from '../../lib/identity';
import type { RemoteLaserState } from '../../lib/usePartyPresence';
import { isLaserEntryFresh } from '../../lib/laserTargetRef';
import { ViewMode } from '../../types';
import type { ViewCapture } from '../../types';
import { xrStore } from '../../lib/xrStore';
import { computeOrbitPivot, getModelCenter } from '../../lib/orbitPivot';
import { FOLLOW_RESUME_DELAY_MS } from '../../lib/followTiming';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';
import * as THREE from 'three';

// Follow ease, expressed per second instead of per frame: 1 - e^(-k·dt) equals
// the old 0.06-per-frame lerp at 60fps (-60·ln(1-0.06) ≈ 3.7) but no longer
// runs three times as fast on a 180Hz display.
const FOLLOW_EASE_K = 3.7;

// Syncs followingRemoteUserId with boardroomLeaderId when in boardroom mode.
// Lives outside the Canvas so it can use both useStore and usePresence.
const BoardroomPresenterSync: React.FC = () => {
  const { localUserId } = usePresence();
  const isBoardroomMode = useStore(state => state.isBoardroomMode);
  const boardroomLeaderId = useStore(state => state.boardroomLeaderId);
  const boardroomPresenterDetachedId = useStore(state => state.boardroomPresenterDetachedId);
  const setFollowingRemoteUser = useStore(state => state.setFollowingRemoteUser);

  useEffect(() => {
    if (!isBoardroomMode) return;
    if (boardroomPresenterDetachedId) return; // user manually detached — idle timer will resume

    if (boardroomLeaderId && boardroomLeaderId !== localUserId) {
      setFollowingRemoteUser(boardroomLeaderId);
    } else {
      // I am the presenter, or no presenter set — don't follow anyone
      setFollowingRemoteUser(null);
    }
  }, [isBoardroomMode, boardroomLeaderId, boardroomPresenterDetachedId, localUserId]);

  return null;
};

// Helper to calculate AI Camera target based on Weights and Gaze
const calculateWeightedCameraTarget = (scene: THREE.Scene, agents: any[], weights: Record<string, number>, time: number) => {
  const focusPoints: THREE.Vector3[] = [];
  const agentPositions: THREE.Vector3[] = [];
  let totalWeight = 0;

  if (!agents) return { target: new THREE.Vector3(), position: new THREE.Vector3(0, 5, 5) };

  agents.forEach(agent => {
      const weight = weights[agent.id] || 0;
      if (weight > 0) {
          const agentObj = scene.getObjectByName(`Agent-${agent.id}`);
          if (agentObj) {
              // Get Agent Head Position
              const headPos = new THREE.Vector3().setFromMatrixPosition(agentObj.matrixWorld);
              headPos.y += 1.6; 
              
              // Get Gaze Target (Approximate)
              const forward = new THREE.Vector3(0, 0, 1);
              forward.applyQuaternion(agentObj.quaternion);
              const lookTarget = headPos.clone().add(forward.multiplyScalar(3)); // 3 units ahead
              
              focusPoints.push(lookTarget.multiplyScalar(weight));
              agentPositions.push(headPos.multiplyScalar(weight));
              totalWeight += weight;
          }
      }
  });

  if (totalWeight === 0) {
      // Fallback: Gentle orbit around center
      return {
          target: new THREE.Vector3(0, 0.5, 0),
          position: new THREE.Vector3(
             Math.sin(time * 0.1) * 5, 
             3, 
             Math.cos(time * 0.1) * 5
          )
      };
  }

  // Calculate Weighted Centroid for LOOK TARGET
  const avgTarget = new THREE.Vector3();
  focusPoints.forEach(p => avgTarget.add(p));
  avgTarget.divideScalar(totalWeight);

  // Calculate Weighted Centroid for CAMERA POSITION
  const avgPos = new THREE.Vector3();
  agentPositions.forEach(p => avgPos.add(p));
  avgPos.divideScalar(totalWeight);

  // Ideally we want to be ~2-3 units behind the weighted center of agents, looking at the weighted center of attention
  const directionToBack = avgPos.clone().sub(avgTarget).normalize();
  const idealCamPos = avgPos.clone().add(directionToBack.multiplyScalar(3.0)).add(new THREE.Vector3(0, 1.0, 0));

  return {
      target: avgTarget,
      position: idealCamPos
  };
};

// Broadcasts local camera position to PartyKit at ~10fps
const PresenceBroadcaster: React.FC = () => {
  const { broadcastPresence } = usePresence();
  const { camera } = useThree();
  const lastBroadcast = useRef(0);

  useFrame(() => {
    const now = Date.now();
    if (now - lastBroadcast.current < 100) return; // 10fps
    lastBroadcast.current = now;

    const pos = camera.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const lookAt = pos.clone().add(forward);

    broadcastPresence(
      [pos.x, pos.y, pos.z],
      [lookAt.x, lookAt.y, lookAt.z],
    );
  });

  return null;
};

// Helper component to handle rendering logic (Standard vs Split)
const SceneRenderer = () => {
  // Use selectors to avoid re-rendering on every store update (like time)
  const viewMode = useStore(state => state.viewMode);
  const followingRemoteUserId = useStore(state => state.followingRemoteUserId);
  const setFollowNudged = useStore(state => state.setFollowNudged);
  const { remoteParticipants } = usePresence();
  const activeAgentId = useStore(state => state.activeAgentId);
  const splitScreenTarget = useStore(state => state.splitScreenTarget);
  const agents = useStore(state => state.agents);
  const agentWeights = useStore(state => state.agentWeights);
  const isLaserActive = useStore(state => state.isLaserActive);
  const drawingInteractionActive = useStore(state => state.drawingInteractionActive);
  const temporarilyDisengagedFromAgentId = useStore(state => state.temporarilyDisengagedFromAgentId);
  const temporarilyDisengageFromAgent = useStore(state => state.temporarilyDisengageFromAgent);
  const resumeFollowingAgent = useStore(state => state.resumeFollowingAgent);
  const isBoardroomMode = useStore(state => state.isBoardroomMode);
  const boardroomPresenterDetachedId = useStore(state => state.boardroomPresenterDetachedId);
  const detachBoardroomPresenter = useStore(state => state.detachBoardroomPresenter);
  const resumeBoardroomPresenter = useStore(state => state.resumeBoardroomPresenter);

  const { broadcastTakeoverAttempt, localUserId } = usePresence();

  const { gl, scene, camera: defaultCamera, size } = useThree();
  
  // Lazy init secondary camera
  const agentCamRef = useRef<THREE.PerspectiveCamera | null>(null);
  if (!agentCamRef.current) {
      agentCamRef.current = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  }

  const controlsRef = useRef<any>(null);

  // Whether the amber strip's gizmo has hold of the pointer, written by the gizmo and
  // read by the click that selects a part. A shared ref rather than a prop because the
  // two are siblings with nothing between them, and because the answer has to be
  // current at the instant a press lands — see components/Scene/SceneClickSelect.tsx.
  const gizmoDraggingRef = useRef(false);

  // Movement smoothing refs
  const posVec = useRef(new THREE.Vector3());
  const targetVec = useRef(new THREE.Vector3());
  const aiTargetRef = useRef(new THREE.Vector3(0,0,0));
  const aiPosRef = useRef(new THREE.Vector3(0,5,5));
  const forwardVec = useRef(new THREE.Vector3());

  // Interaction State for AI Mode Override
  const isInteracting = useRef(false);
  const lastInteractionEnd = useRef(0);

  // Idle timeout for auto-resume after disengage
  const idleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Separate timer for the follow nudge, so looking around and an
  // agent/boardroom detach can't cancel each other's resume.
  const followResumeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const prevFollowingIdRef = useRef<string | null>(followingRemoteUserId);
  const prevViewModeRef = useRef<ViewMode>(viewMode);

  // Clear idle timeouts on unmount
  useEffect(() => {
    return () => {
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      if (followResumeTimerRef.current) clearTimeout(followResumeTimerRef.current);
    };
  }, []);

  /**
   * Publish where the camera is, so "Save this view" can read it.
   *
   * A function on the store rather than a value, for the same reason the drawing
   * overlay publishes its screenshot that way: the button lives in the amber strip,
   * which is an overlay in another React tree, and the camera's pose is only
   * readable from inside R3F. Reading it at call time instead of closing over it is
   * what stops a view saved after an hour of orbiting from being the camera's
   * arrival position.
   */
  useEffect(() => {
    const { setViewCapture } = useStore.getState();
    setViewCapture((): ViewCapture | null => {
      const cam = defaultCamera as THREE.PerspectiveCamera;
      const controls = controlsRef.current;
      const target = controls?.target as THREE.Vector3 | undefined;
      const captured: ViewCapture = {
        position: [cam.position.x, cam.position.y, cam.position.z],
        lookAt: target ? [target.x, target.y, target.z] : [0, 0, 0],
      };
      try {
        // One fresh frame first: the renderer has autoClear off for the split and
        // boardroom views, so whatever is in the drawing buffer may be half of one.
        gl.render(scene, cam);
        captured.thumbnail = gl.domElement.toDataURL('image/jpeg', 0.55);
      } catch {
        // A canvas that will not give up its pixels still gives up its pose, and
        // a viewpoint without a thumbnail is a viewpoint that still works.
      }
      return captured;
    });
    return () => setViewCapture(null);
  }, [gl, scene, defaultCamera]);

  // Move the orbit pivot out to the model's depth *along the current line of
  // sight*. Every driven camera mode parks the target one unit in front of the
  // eye (presence broadcasts lookAt = position + forward), so without this a
  // drag after leaving a follow spins the user on the spot instead of orbiting
  // the model, and zoom is stuck at minDistance. The pivot stays on the view
  // ray, so nothing the user sees moves.
  const repivot = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const cam = defaultCamera as THREE.PerspectiveCamera;
    forwardVec.current.set(0, 0, -1).applyQuaternion(cam.quaternion);
    controls.target.copy(
      computeOrbitPivot(cam.position, forwardVec.current, getModelCenter(scene)),
    );
    controls.update();
  }, [defaultCamera, scene]);

  // Repivot exactly where a driven camera hands control back — and nowhere
  // else: a camera jump to a review pin sets the target on purpose.
  useEffect(() => {
    const prev = prevFollowingIdRef.current;
    prevFollowingIdRef.current = followingRemoteUserId;
    if (!prev || followingRemoteUserId) return;
    if (followResumeTimerRef.current) {
      clearTimeout(followResumeTimerRef.current);
      followResumeTimerRef.current = null;
    }
    repivot();
  }, [followingRemoteUserId, repivot]);

  useEffect(() => {
    const prev = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;
    // Only the modes whose frame branch drives controls.target leave a pivot
    // worth correcting. Split screen leaves the user's own target alone.
    const prevDroveTarget =
      prev === ViewMode.FOLLOW_PRESENTER ||
      prev === ViewMode.POV_AGENT ||
      prev === ViewMode.AI_GUIDED;
    if (prevDroveTarget && viewMode === ViewMode.FREE) repivot();
  }, [viewMode, repivot]);

  // Handle idle timeout for auto-resume when temporarily disengaged from agent POV
  useEffect(() => {
    if (temporarilyDisengagedFromAgentId && !isInteracting.current) {
      idleTimeoutRef.current = setTimeout(() => { resumeFollowingAgent(); }, FOLLOW_RESUME_DELAY_MS);
      return () => { if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current); };
    }
  }, [temporarilyDisengagedFromAgentId, resumeFollowingAgent]);

  // Handle idle timeout for auto-resume when detached from boardroom presenter
  useEffect(() => {
    if (boardroomPresenterDetachedId && !isInteracting.current) {
      idleTimeoutRef.current = setTimeout(() => { resumeBoardroomPresenter(); }, FOLLOW_RESUME_DELAY_MS);
      return () => { if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current); };
    }
  }, [boardroomPresenterDetachedId, resumeBoardroomPresenter]);

  // Handle canvas click to disengage from POV mode
  const handleCanvasInteractionStart = useCallback(() => {
    isInteracting.current = true;

    if (idleTimeoutRef.current) {
      clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = null;
    }

    // Following a person in the arena: a drag is a look-around, not a
    // departure. The frame loop stops tracking the leader while the flag is
    // set, and the pivot moves to the model's depth so the drag orbits the
    // model rather than the user's own head. followingRemoteUserId is left
    // alone — only the Free View button ends a follow.
    if (followingRemoteUserId && !isBoardroomMode) {
      if (followResumeTimerRef.current) {
        clearTimeout(followResumeTimerRef.current);
        followResumeTimerRef.current = null;
      }
      setFollowNudged(true);
      repivot();
    }

    // If following an agent, disengage on drag
    if (viewMode === ViewMode.POV_AGENT && activeAgentId) {
      temporarilyDisengageFromAgent();
      // Right now, not in the viewMode effect below: OrbitControls reads the
      // target on the very next pointermove, before React re-renders.
      repivot();
    }

    if (isBoardroomMode) {
      // Takeover mode: user interaction = intent to become presenter
      const { takeoverModeEnabled, takeoverApprovedUserIds, boardroomLeaderId } = useStore.getState();
      if (
        takeoverModeEnabled &&
        takeoverApprovedUserIds.includes(localUserId) &&
        boardroomLeaderId !== localUserId
      ) {
        broadcastTakeoverAttempt(localUserId);
        // Don't detach — PRESENTER_CHANGED from server will call resumeBoardroomPresenter
        return;
      }

      // Non-takeover: detach locally so only this user's view is affected
      if (followingRemoteUserId && !boardroomPresenterDetachedId) {
        detachBoardroomPresenter(followingRemoteUserId);
      }
    }
  }, [viewMode, activeAgentId, isBoardroomMode, followingRemoteUserId, boardroomPresenterDetachedId, localUserId, temporarilyDisengageFromAgent, detachBoardroomPresenter, broadcastTakeoverAttempt, setFollowNudged, repivot]);

  const handleCanvasInteractionEnd = useCallback(() => {
    isInteracting.current = false;
    lastInteractionEnd.current = Date.now();

    // Follow nudge: ease back to the leader once the user lets go and idles.
    // The next drag cancels this timer (see interaction start).
    if (useStore.getState().followNudged) {
      if (followResumeTimerRef.current) clearTimeout(followResumeTimerRef.current);
      followResumeTimerRef.current = setTimeout(() => {
        followResumeTimerRef.current = null;
        setFollowNudged(false);
      }, FOLLOW_RESUME_DELAY_MS);
    }

    // Agent POV detach: auto-resume after idle
    if (temporarilyDisengagedFromAgentId) {
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = setTimeout(() => { resumeFollowingAgent(); }, FOLLOW_RESUME_DELAY_MS);
    }

    // Boardroom presenter detach: auto-resume after idle
    if (boardroomPresenterDetachedId) {
      if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      idleTimeoutRef.current = setTimeout(() => { resumeBoardroomPresenter(); }, FOLLOW_RESUME_DELAY_MS);
    }
  }, [temporarilyDisengagedFromAgentId, boardroomPresenterDetachedId, resumeFollowingAgent, resumeBoardroomPresenter, setFollowNudged]);

  // We use render priority 1 to run after standard r3f loops.
  useFrame((state, delta) => {
    const mainCam = defaultCamera as THREE.PerspectiveCamera;
    const controls = controlsRef.current;
    const elapsedTime = state.clock.getElapsedTime();

    // --- 1. CAMERA MOVEMENT LOGIC (Main View) ---

    if (followingRemoteUserId) {
      // Highest priority: follow a remote participant's camera — unless the
      // user is mid-nudge, in which case their drag owns the camera until the
      // resume timer clears the flag. Read per frame from the store so the
      // flag costs no re-render.
      const remote = useStore.getState().followNudged
        ? undefined
        : remoteParticipants.current.get(followingRemoteUserId);
      if (remote) {
        const alpha = 1 - Math.exp(-FOLLOW_EASE_K * delta);
        posVec.current.set(...remote.position);
        targetVec.current.set(...remote.lookAt);
        mainCam.position.lerp(posVec.current, alpha);
        if (controls) controls.target.lerp(targetVec.current, alpha);
      }
    } else if (viewMode === ViewMode.FOLLOW_PRESENTER) {
       const angle = (elapsedTime * 0.2);
       posVec.current.set(Math.sin(angle) * 3.5 * 1.5, 3, Math.cos(angle) * 3.5 * 1.5);
       targetVec.current.set(0, 0, 0);

       mainCam.position.lerp(posVec.current, 0.02);
       if (controls) controls.target.lerp(targetVec.current, 0.05);
    }
    else if (viewMode === ViewMode.POV_AGENT && activeAgentId && !temporarilyDisengagedFromAgentId) {
        // Only follow agent camera when not temporarily disengaged
        const agentObj = scene.getObjectByName(`Agent-${activeAgentId}`);
        if (agentObj) {
             posVec.current.setFromMatrixPosition(agentObj.matrixWorld);
             posVec.current.y += 0.6; // Align with screen/eye height

             mainCam.position.lerp(posVec.current, 0.2);

             const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(agentObj.quaternion);
             targetVec.current.copy(posVec.current).add(forward);

             if (controls) controls.target.lerp(targetVec.current, 0.2);
        }
    }
    else if (viewMode === ViewMode.AI_GUIDED) {
        const { target, position } = calculateWeightedCameraTarget(scene, agents, agentWeights, elapsedTime);
        
        // Check for user manual override
        const now = Date.now();
        const isUserActive = isInteracting.current || (now - lastInteractionEnd.current < 1500); // 1.5s delay

        if (!isUserActive) {
            // AI Controlled
            aiTargetRef.current.lerp(target, 0.02);
            aiPosRef.current.lerp(position, 0.02);
            
            mainCam.position.lerp(aiPosRef.current, 0.05);
            if (controls) controls.target.lerp(aiTargetRef.current, 0.05);
        } else {
            // User Controlled - Sync AI refs to current user position so transition is smooth later
            aiPosRef.current.copy(mainCam.position);
            if (controls) aiTargetRef.current.copy(controls.target);
        }
    }

    if (controls) controls.update();


    // --- 2. RENDER LOGIC (Split vs Standard) ---

    // Three.js setViewport/setScissor accept CSS (logical) pixel values and multiply
    // by pixelRatio internally. Do NOT pre-multiply by DPR here — it would be applied
    // twice on HiDPI screens (DPR=2 → 4× too large), breaking pointer/laser alignment.
    const w = size.width;
    const h = size.height;

    gl.autoClear = false;
    gl.clear();

    if (viewMode === ViewMode.SPLIT_SCREEN) {
        // -- Split Screen --
        const halfWidth = Math.floor(w / 2);

        // 1. Render Left Panel (User View)
        // Update Aspect Ratio based on LOGICAL size
        mainCam.aspect = (size.width / 2) / size.height;
        mainCam.updateProjectionMatrix();

        gl.setViewport(0, 0, halfWidth, h);
        gl.setScissor(0, 0, halfWidth, h);
        gl.setScissorTest(true);
        gl.render(scene, mainCam);

        // Restore main cam aspect for next frame calculations (controls etc)
        mainCam.aspect = size.width / size.height;
        mainCam.updateProjectionMatrix();

        // 2. Render Right Panel — POV of an agent or a remote participant
        let targetFound = false;
        if (splitScreenTarget && agentCamRef.current) {
            const cam = agentCamRef.current;
            // Shared camera setup for both kinds
            cam.aspect = (size.width / 2) / size.height;

            if (splitScreenTarget.kind === 'agent') {
                const agentObj = scene.getObjectByName(`Agent-${splitScreenTarget.id}`);
                if (agentObj) {
                    targetFound = true;
                    const p = new THREE.Vector3();
                    p.setFromMatrixPosition(agentObj.matrixWorld);
                    p.y += 0.6; // Eye/Screen level
                    cam.position.copy(p);

                    // Use the agent's rotation exactly. Objects look at +Z, cameras
                    // down -Z, so we rotate 180° around Y.
                    const q = new THREE.Quaternion();
                    agentObj.getWorldQuaternion(q);
                    cam.quaternion.copy(q);
                    cam.rotateY(Math.PI);
                    cam.updateProjectionMatrix();
                    cam.updateMatrixWorld();

                    // Hide the agent so they don't block their own view
                    const wasVisible = agentObj.visible;
                    agentObj.visible = false;

                    gl.setViewport(halfWidth, 0, halfWidth, h);
                    gl.setScissor(halfWidth, 0, halfWidth, h);
                    gl.render(scene, cam);

                    agentObj.visible = wasVisible;
                }
            } else if (splitScreenTarget.kind === 'user') {
                const remote = remoteParticipants.current.get(splitScreenTarget.userId);
                if (remote) {
                    targetFound = true;
                    cam.position.set(remote.position[0], remote.position[1], remote.position[2]);
                    cam.lookAt(remote.lookAt[0], remote.lookAt[1], remote.lookAt[2]);
                    cam.updateProjectionMatrix();
                    cam.updateMatrixWorld();

                    gl.setViewport(halfWidth, 0, halfWidth, h);
                    gl.setScissor(halfWidth, 0, halfWidth, h);
                    gl.render(scene, cam);
                }
            }
        }

        // Fallback if no target selected or target gone: render an empty pane
        if (!targetFound) {
             gl.setViewport(halfWidth, 0, halfWidth, h);
             gl.setScissor(halfWidth, 0, halfWidth, h);
             gl.setClearColor(new THREE.Color('#111'));
             gl.clear();
             // Restore default clear color
             gl.setClearColor(new THREE.Color('#f0f0f0'));
        }

        gl.setScissorTest(false);
    } else {
        // -- Standard View --
        gl.setViewport(0, 0, w, h);
        gl.setScissor(0, 0, w, h);
        gl.setScissorTest(false);
        gl.render(scene, mainCam);
    }
  }, 1);
  
  return (
    <>
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.1}
        // Always enable controls except for laser/drawing modes
        // User interaction in POV mode will trigger disengage, then auto-resume after idle
        enabled={!isLaserActive && !drawingInteractionActive}
        minDistance={1}
        maxDistance={20}
        onStart={handleCanvasInteractionStart}
        onEnd={handleCanvasInteractionEnd}
      />
      {/* The amber strip's Move / Rotate / Scale, attached to the selected scene
          model. Renders nothing unless this person has Edit on and a model is
          selected, so it costs the room nothing while a meeting is running. */}
      <ReviewModelGizmo controlsRef={controlsRef} draggingRef={gizmoDraggingRef} />
      {/* Clicking a model or one part of it in Edit mode, which is how the strip's
          Part mode gets its selection without a trip to the model tree. Renders
          nothing at all, and outside Edit mode it does not even read the store. */}
      <SceneClickSelect draggingRef={gizmoDraggingRef} />
      {/* Curated review artifacts (pins, camera-jump animator). Shares this
          renderer's controlsRef so jumps update orbit controls in lockstep. */}
      <ReviewArtifacts controlsRef={controlsRef} />
    </>
  );
};

// Must be inside Canvas so it has R3F context; reads PresenceContext via hook
const RemoteParticipantsWrapper: React.FC = () => {
  const { remoteParticipants } = usePresence();
  return <RemoteParticipants participantsRef={remoteParticipants} />;
};

// Per-user laser dot + beam with name label, pulsing animation, and target part display.
// Color is read from remoteParticipants every frame (not from the prop) so it stays
// fresh even when participant data syncs after the laser has started.
const RemoteLaserDot: React.FC<{
  userId: string;
  remoteLasers: React.MutableRefObject<Map<string, RemoteLaserState>>;
  remoteParticipants: React.MutableRefObject<Map<string, import('../../party/room.server').ParticipantPresence>>;
}> = ({ userId, remoteLasers, remoteParticipants }) => {
  const groupRef = useRef<THREE.Group>(null);
  const dotRef = useRef<THREE.Mesh>(null);
  const dotMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const beamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const pointLightRef = useRef<THREE.PointLight>(null);
  const nameLabelRef = useRef<HTMLDivElement>(null);
  const targetLabelRef = useRef<HTMLDivElement>(null);
  const nameTextRef = useRef<HTMLSpanElement>(null);
  const _start = useRef(new THREE.Vector3());
  const _end = useRef(new THREE.Vector3());
  const _mid = useRef(new THREE.Vector3());
  const _color = useRef(new THREE.Color());
  const lastColor = useRef<string>('');
  const lastName = useRef<string>('');

  useFrame(({ clock }) => {
    const state = remoteLasers.current.get(userId);
    const pos = state?.position ?? null;
    const participant = remoteParticipants.current.get(userId);
    const color = participant?.color ?? '#ffffff';
    // The floating label above the impact dot is a name tag like the avatar's,
    // so it carries the same guest mark.
    const name = participant
      ? participantLabel(participant.name, participant.guest)
      : userId.slice(0, 6);

    // --- Apply color imperatively (handles late-arriving participant data) ---
    if (color !== lastColor.current) {
      lastColor.current = color;
      _color.current.set(color);
      if (dotMatRef.current) dotMatRef.current.color.copy(_color.current);
      if (beamMatRef.current) beamMatRef.current.color.copy(_color.current);
      if (pointLightRef.current) pointLightRef.current.color.copy(_color.current);
      if (nameLabelRef.current) {
        nameLabelRef.current.style.background = color;
        nameLabelRef.current.style.borderColor = color;
      }
    }
    if (name !== lastName.current) {
      lastName.current = name;
      if (nameTextRef.current) nameTextRef.current.textContent = name;
    }

    // --- Dot at hit point ---
    if (groupRef.current) {
      if (pos) {
        groupRef.current.position.set(pos[0], pos[1], pos[2]);
        groupRef.current.visible = true;
        if (dotRef.current) {
          const pulse = 1.0 + 0.3 * Math.sin(clock.elapsedTime * 12.0);
          dotRef.current.scale.setScalar(pulse);
        }
      } else {
        groupRef.current.visible = false;
      }
    }

    // --- Beam from participant avatar body to hit point ---
    if (beamRef.current) {
      if (pos && participant?.position) {
        // Avatar visuals span ~y+0.1 to y+0.6 above the camera/group origin
        // (see RemoteParticipant.tsx). Anchor the beam at the avatar body center.
        _start.current.set(
          participant.position[0],
          participant.position[1] + 0.2,
          participant.position[2],
        );
        _end.current.set(pos[0], pos[1], pos[2]);
        _mid.current.addVectors(_start.current, _end.current).multiplyScalar(0.5);
        beamRef.current.position.copy(_mid.current);
        beamRef.current.lookAt(_end.current);
        beamRef.current.rotateX(Math.PI / 2);
        beamRef.current.scale.set(1, _start.current.distanceTo(_end.current), 1);
        beamRef.current.visible = true;
      } else {
        beamRef.current.visible = false;
      }
    }

    // --- Imperatively update target label — no React re-render ---
    if (targetLabelRef.current) {
      const partName = state?.partName ?? null;
      targetLabelRef.current.textContent = partName ?? '';
      targetLabelRef.current.style.display = partName ? 'block' : 'none';
    }
  });

  return (
    <>
      {/* Hit-point group: dot + glow + label. skipRaycast so the laser doesn't pin to
          its own dot; editingHelper so the lobby's thumbnail leaves the dot out (batch
          BV, lib/scene/captureClean.ts) — a dot on the model says somebody was pointing
          at it, and the picture is of the review rather than of one person's laser. */}
      <group ref={groupRef} visible={false} userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}>
        <mesh ref={dotRef} renderOrder={999} userData={{ skipRaycast: true }}>
          <sphereGeometry args={[0.035, 10, 10]} />
          <meshBasicMaterial ref={dotMatRef} toneMapped={false} depthTest={false} />
        </mesh>
        <pointLight ref={pointLightRef} intensity={1.5} distance={0.8} />
        <Html position={[0, 0.12, 0]} center distanceFactor={6} style={{ pointerEvents: 'none' }} zIndexRange={[0, 0]}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
            <div
              ref={nameLabelRef}
              style={{
                background: '#ffffff',
                border: '1px solid #ffffff',
                color: '#fff',
                fontFamily: 'monospace',
                fontSize: '7px',
                padding: '0 3px',
                borderRadius: '3px',
                whiteSpace: 'nowrap',
                backdropFilter: 'blur(4px)',
              }}
            >
              <span ref={nameTextRef} />
            </div>
            <div
              ref={targetLabelRef}
              style={{
                background: 'rgba(0,0,0,0.7)',
                color: '#fff',
                fontFamily: 'monospace',
                fontSize: '6px',
                padding: '0 3px',
                borderRadius: '3px',
                whiteSpace: 'nowrap',
                display: 'none',
              }}
            />
          </div>
        </Html>
      </group>
      {/* Beam from remote avatar body to hit point — skipRaycast keeps it out of hit testing */}
      <mesh ref={beamRef} visible={false} userData={{ skipRaycast: true }}>
        <cylinderGeometry args={[0.004, 0.004, 1, 6]} />
        <meshBasicMaterial ref={beamMatRef} transparent opacity={0.5} depthTest={false} />
      </mesh>
    </>
  );
};

// Outer component: watches which users have active lasers, mounts one dot per active user.
// Only the userId set drives mount/unmount — name/color are read live inside each dot.
const RemoteLasers: React.FC = () => {
  const { remoteLasers, remoteParticipants } = usePresence();
  const [activeIds, setActiveIds] = React.useState<string[]>([]);
  const lastKeySetRef = useRef('');

  useFrame(() => {
    const ids = Array.from(remoteLasers.current.entries())
      .filter(([id, s]) => s.position !== null && isLaserEntryFresh(id))
      .map(([id]) => id)
      .sort();
    const key = ids.join(',');
    if (key === lastKeySetRef.current) return;
    lastKeySetRef.current = key;
    setActiveIds(ids);
  });

  return (
    <>
      {activeIds.map(userId => (
        <RemoteLaserDot
          key={userId}
          userId={userId}
          remoteLasers={remoteLasers}
          remoteParticipants={remoteParticipants}
        />
      ))}
    </>
  );
};

const ViewpointCanvas: React.FC = () => {
  return (
    <>
    <BoardroomPresenterSync />
    <Canvas
      shadows
      dpr={[1, 2]}
      eventPrefix="client"
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
      gl={{
        antialias: true,
        // Neutral rather than ACES filmic: the film curve desaturates towards white as
        // it rolls off, which is a look a colour grading suite wants and a design review
        // does not — the colour of the part is the thing under discussion. One constant,
        // shared with the lobby's preview. See components/Scene/LightRig.tsx.
        toneMapping: SCENE_TONE_MAPPING,
        toneMappingExposure: SCENE_TONE_MAPPING_EXPOSURE,
        autoClear: false,
        preserveDrawingBuffer: true
      }}
    >
      <XR store={xrStore}>
        <PerspectiveCamera makeDefault position={[8, 6, 8]} fov={60} />

        {/* Systems */}
        <DialogueEngine />
        <UserLaser />
        <MobileLaser />
        <XRManager />
        <SpatialComments />
        <RemoteLasers />
        <SceneRenderer />
        <PresenceBroadcaster />

        <Suspense fallback={null}>
          <World />
          <RemoteParticipantsWrapper />
        </Suspense>
      </XR>
    </Canvas>
    </>
  );
};

export default ViewpointCanvas;
