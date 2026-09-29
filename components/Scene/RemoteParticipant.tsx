import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store';
import { AgentStyle } from '../../types';
import { participantLabel } from '../../lib/identity';

import type { ParticipantPresence } from '../../lib/usePartyPresence';

interface Props {
  participantsRef: React.MutableRefObject<Map<string, ParticipantPresence>>;
}

// Reads position directly from the ref every frame — no prop updates needed
function RemoteAvatar({
  userId,
  initialPresence,
  participantsRef,
}: {
  userId: string;
  initialPresence: ParticipantPresence;
  participantsRef: React.MutableRefObject<Map<string, ParticipantPresence>>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const visualRef = useRef<THREE.Group>(null);
  const targetPos = useRef(new THREE.Vector3(...initialPresence.position));
  const targetLookAt = useRef(new THREE.Vector3(...initialPresence.lookAt));
  const agentStyle = useStore(state => state.agentStyle);
  const color = initialPresence.color;

  useFrame(() => {
    if (!groupRef.current) return;
    const p = participantsRef.current.get(userId);
    if (!p) return;

    targetPos.current.set(...p.position);
    targetLookAt.current.set(...p.lookAt);

    groupRef.current.position.lerp(targetPos.current, 0.15);

    if (agentStyle === AgentStyle.BOX && visualRef.current) {
      visualRef.current.lookAt(0, 0.5, 0);
    } else {
      const dir = targetLookAt.current.clone().sub(groupRef.current.position).normalize();
      if (dir.lengthSq() > 0.001) {
        const angle = Math.atan2(dir.x, dir.z);
        groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, angle, 0.15);
      }
    }
  });

  // userData.skipRaycast on the group: lasers traverse children and bail at this tag,
  // so remote avatars no longer block the pointer from hitting models behind them.
  return (
    <group ref={groupRef} position={initialPresence.position} userData={{ skipRaycast: true }}>
      {agentStyle === AgentStyle.BOX && (
        <group ref={visualRef} position={[0, 0.6, 0]}>
          <mesh castShadow userData={{ skipRaycast: true }}>
            <planeGeometry args={[0.12, 0.08]} />
            <meshPhysicalMaterial color={color} roughness={0.1} metalness={0.8} emissive={color} emissiveIntensity={0.5} side={THREE.DoubleSide} transparent opacity={0.85} />
          </mesh>
          <mesh position={[0, 0, -0.005]} userData={{ skipRaycast: true }}>
            <boxGeometry args={[0.13, 0.09, 0.01]} />
            <meshStandardMaterial color="#111" roughness={0.5} />
          </mesh>
        </group>
      )}

      {agentStyle === AgentStyle.CAPSULE && (
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]} position={[0, 0.1, 0]} userData={{ skipRaycast: true }}>
          <capsuleGeometry args={[0.2, 1.2, 4, 8]} />
          <meshStandardMaterial color={color} roughness={0.3} metalness={0.1} />
        </mesh>
      )}

      {agentStyle === AgentStyle.ROBOT && (
        <group position={[0, 0.2, 0]}>
          <mesh castShadow userData={{ skipRaycast: true }}>
            <boxGeometry args={[0.4, 0.8, 0.3]} />
            <meshStandardMaterial color="#444" roughness={0.3} metalness={0.6} />
          </mesh>
          <mesh castShadow position={[0, 0.6, 0]} userData={{ skipRaycast: true }}>
            <boxGeometry args={[0.3, 0.3, 0.3]} />
            <meshStandardMaterial color={color} />
          </mesh>
        </group>
      )}

      {agentStyle === AgentStyle.VR_HEADSET && (
        <group position={[0, 0.5, 0]}>
          <mesh castShadow userData={{ skipRaycast: true }}>
            <boxGeometry args={[0.18, 0.09, 0.12]} />
            <meshPhysicalMaterial color="#1a1a1a" roughness={0.15} metalness={0.9} clearcoat={0.8} clearcoatRoughness={0.2} />
          </mesh>
          <mesh position={[0, 0, 0.065]} userData={{ skipRaycast: true }}>
            <boxGeometry args={[0.16, 0.06, 0.01]} />
            <meshPhysicalMaterial color={color} roughness={0.1} metalness={0.5} emissive={color} emissiveIntensity={0.4} transparent opacity={0.9} />
          </mesh>
          <mesh position={[0.06, 0.035, 0.06]} userData={{ skipRaycast: true }}>
            <sphereGeometry args={[0.008, 8, 8]} />
            <meshBasicMaterial color="#00ff88" />
          </mesh>
        </group>
      )}

      <Html position={[0, 1.0, 0]} center distanceFactor={6} style={{ pointerEvents: 'none' }} zIndexRange={[0, 0]}>
        <div className="flex flex-col items-center gap-1 opacity-80">
          <div className="font-mono text-[8px] px-1 rounded border whitespace-nowrap backdrop-blur-md text-white" style={{ background: color, borderColor: color }}>
            {participantLabel(initialPresence.name, initialPresence.guest)}
          </div>
        </div>
      </Html>
    </group>
  );
}

// Only re-renders when participant count changes (join/leave).
// Position updates happen inside useFrame — zero React re-renders at 60fps.
const RemoteParticipants: React.FC<Props> = ({ participantsRef }) => {
  const isBoardroomMode = useStore(state => state.isBoardroomMode);
  const [participantIds, setParticipantIds] = React.useState<
    { userId: string; presence: ParticipantPresence }[]
  >([]);
  const lastCountRef = useRef(0);

  useFrame(() => {
    if (isBoardroomMode) return;
    const map = participantsRef.current;
    if (map.size !== lastCountRef.current) {
      lastCountRef.current = map.size;
      setParticipantIds(
        Array.from(map.entries()).map(([userId, presence]) => ({ userId, presence })),
      );
    }
  });

  if (isBoardroomMode) return null;

  return (
    <>
      {participantIds.map(({ userId, presence }) => (
        <RemoteAvatar
          key={userId}
          userId={userId}
          initialPresence={presence}
          participantsRef={participantsRef}
        />
      ))}
    </>
  );
};

export default RemoteParticipants;
