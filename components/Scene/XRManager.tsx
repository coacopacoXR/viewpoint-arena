import React, { useRef, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Text } from '@react-three/drei';
import { useXR, useXRInputSourceState, useXRControllerButtonEvent } from '@react-three/xr';
import type { XRControllerState } from '@pmndrs/xr/internals';
import * as THREE from 'three';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { participantLabel } from '../../lib/identity';
import { remoteXRParticipants } from '../../lib/xrPresenceRef';
import { mobileLaserRef } from '../../lib/mobileLaserRef';
import type { XRParticipantData } from '../../types';

// ─── CONTROLLER BUTTON GUIDE ─────────────────────────────────────────────────

const GUIDE_RIGHT = [
  { label: 'Trigger', desc: 'Laser pointer' },
  { label: 'Grip',    desc: 'Grab / rotate model' },
  { label: 'A',       desc: 'Toggle boardroom' },
  { label: 'B',       desc: 'Toggle agents' },
  { label: 'Stick',   desc: 'Orbit camera' },
];

const GUIDE_LEFT = [
  { label: 'Trigger', desc: 'Zoom in' },
  { label: 'Grip',    desc: 'Reset view' },
  { label: 'X',       desc: 'Mute mic' },
  { label: 'Y',       desc: 'Participants' },
  { label: 'Stick',   desc: 'Pan' },
];

function ControllerGuide({
  controllerState,
  side,
}: {
  controllerState: XRControllerState;
  side: 'left' | 'right';
}) {
  const obj = controllerState.object;
  if (!obj) return null;

  const guide = side === 'right' ? GUIDE_RIGHT : GUIDE_LEFT;
  const offsetX = side === 'right' ? 0.12 : -0.12;

  return (
    <group>
      <Html
        position={[offsetX, 0.06, 0]}
        // Attach to the controller object so it follows it
        occlude={false}
        transform
        distanceFactor={0.15}
        center
        portal={{ current: obj as unknown as HTMLElement }}
      >
        <div
          style={{
            background: 'rgba(0,0,0,0.82)',
            border: '1px solid rgba(255,255,255,0.18)',
            borderRadius: 10,
            padding: '8px 10px',
            minWidth: 120,
            backdropFilter: 'blur(8px)',
            pointerEvents: 'none',
          }}
        >
          <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 8, fontFamily: 'monospace', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4, letterSpacing: 1 }}>
            {side} controller
          </div>
          {guide.map(g => (
            <div key={g.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 2 }}>
              <span style={{ color: '#a78bfa', fontSize: 9, fontFamily: 'monospace', fontWeight: 700, minWidth: 38 }}>{g.label}</span>
              <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 9, fontFamily: 'sans-serif' }}>{g.desc}</span>
            </div>
          ))}
        </div>
      </Html>
    </group>
  );
}

// ─── XR LASER (right trigger) ─────────────────────────────────────────────────

function XRLaser({ rightState }: { rightState: XRControllerState | undefined }) {
  const { scene } = useThree();
  const { broadcastLaserMove } = usePresence();
  const raycaster = useRef(new THREE.Raycaster());
  const lastBroadcast = useRef(0);
  const dotRef = useRef<THREE.Mesh>(null);
  const isPressed = useRef(false);

  useXRControllerButtonEvent(rightState, 'xr-standard-trigger', state => {
    isPressed.current = state === 'pressed' || state === 'touched';
  });

  useFrame(() => {
    if (!isPressed.current || !rightState?.object) {
      if (dotRef.current) dotRef.current.visible = false;
      if (!isPressed.current) {
        mobileLaserRef.ndc = null;
        // only broadcast null once on release
      }
      return;
    }

    const controllerObj = rightState.object;
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 0, -1);
    controllerObj.getWorldPosition(origin);
    direction.applyQuaternion(controllerObj.getWorldQuaternion(new THREE.Quaternion()));

    raycaster.current.set(origin, direction);
    const intersects = raycaster.current.intersectObjects(scene.children, true);
    const hitPoint = new THREE.Vector3();
    let found = false;

    for (const hit of intersects) {
      if (hit.object.name.startsWith('Agent') || hit.object.type === 'Line' || hit.object.type === 'Points') continue;
      if (dotRef.current && hit.object === dotRef.current) continue;
      hitPoint.copy(hit.point);
      found = true;
      break;
    }
    if (!found) raycaster.current.ray.at(5, hitPoint);

    if (dotRef.current) {
      dotRef.current.visible = true;
      dotRef.current.position.copy(hitPoint);
    }

    const now = Date.now();
    if (now - lastBroadcast.current >= 80) {
      lastBroadcast.current = now;
      broadcastLaserMove([hitPoint.x, hitPoint.y, hitPoint.z]);
    }
  });

  return (
    <mesh ref={dotRef} visible={false} renderOrder={999}>
      <sphereGeometry args={[0.04, 10, 10]} />
      <meshBasicMaterial color="#ff2222" toneMapped={false} depthTest={false} />
    </mesh>
  );
}

// ─── XR PRESENCE BROADCASTER ─────────────────────────────────────────────────

function XRPresenceBroadcaster({
  leftState,
  rightState,
}: {
  leftState: XRControllerState | undefined;
  rightState: XRControllerState | undefined;
}) {
  const { camera } = useThree();
  const { broadcastXRPresence, localUserId } = usePresence();
  const lastBroadcast = useRef(0);

  const userInfo = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('vp_user') || '{}'); } catch { return {}; }
  }, []);

  useFrame(() => {
    const now = Date.now();
    if (now - lastBroadcast.current < 100) return; // 10fps
    lastBroadcast.current = now;

    const pos = camera.position;
    const quat = camera.quaternion;

    const data: XRParticipantData = {
      userId: localUserId,
      name: userInfo.name || 'VR User',
      color: userInfo.color || '#818cf8',
      head: {
        position: [pos.x, pos.y, pos.z],
        quaternion: [quat.x, quat.y, quat.z, quat.w],
      },
    };

    if (leftState?.object) {
      const lPos = new THREE.Vector3();
      const lQuat = new THREE.Quaternion();
      leftState.object.getWorldPosition(lPos);
      leftState.object.getWorldQuaternion(lQuat);
      data.leftController = {
        position: [lPos.x, lPos.y, lPos.z],
        quaternion: [lQuat.x, lQuat.y, lQuat.z, lQuat.w],
      };
    }

    if (rightState?.object) {
      const rPos = new THREE.Vector3();
      const rQuat = new THREE.Quaternion();
      rightState.object.getWorldPosition(rPos);
      rightState.object.getWorldQuaternion(rQuat);
      data.rightController = {
        position: [rPos.x, rPos.y, rPos.z],
        quaternion: [rQuat.x, rQuat.y, rQuat.z, rQuat.w],
      };
    }

    broadcastXRPresence(data);
  });

  return null;
}

// ─── REMOTE XR AVATARS ────────────────────────────────────────────────────────

function RemoteXRAvatar({ userId }: { userId: string }) {
  const headRef = useRef<THREE.Mesh>(null);
  const leftCtrlRef = useRef<THREE.Mesh>(null);
  const rightCtrlRef = useRef<THREE.Mesh>(null);
  const nameRef = useRef<THREE.Group>(null);

  const headPos = useRef(new THREE.Vector3());
  const headQuat = useRef(new THREE.Quaternion());

  useFrame(() => {
    const data = remoteXRParticipants.get(userId);
    if (!data) return;

    headPos.current.set(...data.head.position);
    headQuat.current.set(...data.head.quaternion);

    if (headRef.current) {
      headRef.current.position.lerp(headPos.current, 0.2);
      headRef.current.quaternion.slerp(headQuat.current, 0.2);
    }
    if (nameRef.current) {
      nameRef.current.position.copy(headPos.current).add(new THREE.Vector3(0, 0.25, 0));
    }

    if (leftCtrlRef.current && data.leftController) {
      const lPos = new THREE.Vector3(...data.leftController.position);
      leftCtrlRef.current.position.lerp(lPos, 0.2);
      leftCtrlRef.current.quaternion.slerp(new THREE.Quaternion(...data.leftController.quaternion), 0.2);
      leftCtrlRef.current.visible = true;
    } else if (leftCtrlRef.current) {
      leftCtrlRef.current.visible = false;
    }

    if (rightCtrlRef.current && data.rightController) {
      const rPos = new THREE.Vector3(...data.rightController.position);
      rightCtrlRef.current.position.lerp(rPos, 0.2);
      rightCtrlRef.current.quaternion.slerp(new THREE.Quaternion(...data.rightController.quaternion), 0.2);
      rightCtrlRef.current.visible = true;
    } else if (rightCtrlRef.current) {
      rightCtrlRef.current.visible = false;
    }
  });

  const data = remoteXRParticipants.get(userId);
  const color = data?.color ?? '#818cf8';
  const name = data?.name ?? 'VR';

  return (
    <group>
      {/* Head — VR headset shape (box) */}
      <mesh ref={headRef}>
        <boxGeometry args={[0.2, 0.12, 0.12]} />
        <meshStandardMaterial color={color} roughness={0.4} metalness={0.6} />
        {/* Visor */}
        <mesh position={[0, 0, 0.062]}>
          <boxGeometry args={[0.16, 0.06, 0.01]} />
          <meshBasicMaterial color="#111122" />
        </mesh>
      </mesh>

      {/* Name label */}
      <group ref={nameRef}>
        <Text
          fontSize={0.06}
          color={color}
          anchorX="center"
          anchorY="bottom"
          font={undefined}
        >
          {name} [VR]
        </Text>
      </group>

      {/* Left controller */}
      <mesh ref={leftCtrlRef} visible={false}>
        <cylinderGeometry args={[0.015, 0.02, 0.12, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>

      {/* Right controller */}
      <mesh ref={rightCtrlRef} visible={false}>
        <cylinderGeometry args={[0.015, 0.02, 0.12, 8]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
    </group>
  );
}

function RemoteXRAvatars() {
  const [xrUserIds, setXrUserIds] = React.useState<string[]>([]);

  useFrame(() => {
    const ids = Array.from(remoteXRParticipants.keys());
    setXrUserIds(prev => {
      if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) return prev;
      return ids;
    });
  });

  return (
    <>
      {xrUserIds.map(id => (
        <RemoteXRAvatar key={id} userId={id} />
      ))}
    </>
  );
}

// ─── BOARDROOM VIRTUAL SCREEN (AR passthrough) ─────────────────────────────────
// A floating screen anchored 1.5m in front of the HMD showing session info.

function BoardroomVirtualScreen() {
  const isBoardroomMode = useStore(state => state.isBoardroomMode);
  const boardroomLeaderId = useStore(state => state.boardroomLeaderId);
  const time = useStore(state => state.time);
  const { remoteParticipantList } = usePresence();
  const { camera } = useThree();
  const screenGroupRef = useRef<THREE.Group>(null);
  const isAnchored = useRef(false);
  const anchorPos = useRef(new THREE.Vector3());
  const anchorQuat = useRef(new THREE.Quaternion());

  // Anchor the screen once when boardroom activates (so it doesn't follow head)
  useFrame(() => {
    if (!isBoardroomMode) {
      isAnchored.current = false;
      return;
    }
    if (!isAnchored.current) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      anchorPos.current.copy(camera.position).addScaledVector(fwd, 1.5);
      anchorPos.current.y = camera.position.y; // keep at eye height
      anchorQuat.current.copy(camera.quaternion);
      isAnchored.current = true;
    }
    if (screenGroupRef.current) {
      screenGroupRef.current.position.lerp(anchorPos.current, 0.05);
      screenGroupRef.current.quaternion.slerp(anchorQuat.current, 0.05);
    }
  });

  if (!isBoardroomMode) return null;

  const boardroomLeader = remoteParticipantList.find(p => p.userId === boardroomLeaderId);
  const leaderName = boardroomLeaderId
    ? boardroomLeader
      ? participantLabel(boardroomLeader.name, boardroomLeader.guest)
      : 'Host'
    : 'No presenter';
  const mins = String(Math.floor(time / 60)).padStart(2, '0');
  const secs = String(Math.floor(time % 60)).padStart(2, '0');

  return (
    <group ref={screenGroupRef}>
      {/* Screen bezel (dark plane) */}
      <mesh position={[0, 0, -0.002]}>
        <planeGeometry args={[0.84, 0.52]} />
        <meshBasicMaterial color="#0a0a14" />
      </mesh>
      {/* Screen content via Html */}
      <Html
        transform
        occlude={false}
        distanceFactor={0.5}
        center
        style={{ pointerEvents: 'none' }}
      >
        <div style={{
          width: 360,
          height: 220,
          background: 'rgba(8,8,20,0.92)',
          border: '1.5px solid rgba(129,140,248,0.35)',
          borderRadius: 12,
          padding: '12px 16px',
          fontFamily: 'monospace',
          color: '#fff',
          boxSizing: 'border-box',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#f87171', animation: 'pulse 1s infinite' }} />
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: '#a5b4fc' }}>
                BOARDROOM
              </span>
            </div>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{mins}:{secs}</span>
          </div>

          {/* Presenter */}
          <div style={{ background: 'rgba(129,140,248,0.12)', border: '1px solid rgba(129,140,248,0.25)', borderRadius: 8, padding: '7px 10px', marginBottom: 10 }}>
            <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', marginBottom: 2, textTransform: 'uppercase', letterSpacing: 1 }}>Presenting</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#c7d2fe' }}>{leaderName}</div>
          </div>

          {/* Participants */}
          <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
            Live participants ({remoteParticipantList.length + 1})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {remoteParticipantList.map(p => (
              <div key={p.userId} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: 'rgba(255,255,255,0.06)', borderRadius: 20, padding: '3px 8px',
              }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: p.color }} />
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.7)' }}>{participantLabel(p.name, p.guest)}</span>
              </div>
            ))}
          </div>

          {/* Footer hint */}
          <div style={{ marginTop: 10, fontSize: 8, color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
            Press A to exit boardroom · Your passthrough view is your primary canvas
          </div>
        </div>
      </Html>
    </group>
  );
}

// ─── BUTTON ACTIONS (wired to controller buttons) ────────────────────────────

function XRButtonActions({ rightState }: {
  rightState: XRControllerState | undefined;
  leftState: XRControllerState | undefined;
}) {
  const { toggleBoardroomMode, triggerBoardroomEntry, isBoardroomMode, toggleHideAgents } = useStore.getState();
  const { broadcastBoardroomCountdown, broadcastArenaEntry } = usePresence();

  // A = boardroom toggle
  useXRControllerButtonEvent(rightState, 'a-button', state => {
    if (state !== 'pressed') return;
    if (isBoardroomMode) {
      toggleBoardroomMode();
      broadcastArenaEntry();
    } else {
      triggerBoardroomEntry();
      broadcastBoardroomCountdown();
    }
  });

  // B = hide/show agents
  useXRControllerButtonEvent(rightState, 'b-button', state => {
    if (state !== 'pressed') return;
    toggleHideAgents();
  });

  return null;
}

// ─── ROOT XR MANAGER ─────────────────────────────────────────────────────────

const XRManager: React.FC = () => {
  const isPresenting = useXR(state => state.session != null);
  const rightState = useXRInputSourceState('controller', 'right');
  const leftState = useXRInputSourceState('controller', 'left');

  if (!isPresenting) return null;

  return (
    <>
      <XRPresenceBroadcaster leftState={leftState} rightState={rightState} />
      <RemoteXRAvatars />
      <XRLaser rightState={rightState} />
      <BoardroomVirtualScreen />
      <XRButtonActions rightState={rightState} leftState={leftState} />

      {/* Controller guides — rendered in world space attached to each controller object */}
      {rightState?.object && (
        <primitive object={rightState.object}>
          <ControllerGuide controllerState={rightState} side="right" />
        </primitive>
      )}
      {leftState?.object && (
        <primitive object={leftState.object}>
          <ControllerGuide controllerState={leftState} side="left" />
        </primitive>
      )}
    </>
  );
};

export default XRManager;
