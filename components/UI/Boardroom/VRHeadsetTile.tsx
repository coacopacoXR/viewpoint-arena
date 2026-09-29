import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { agentOrientations } from '../../../lib/vrOrientationBridge';

interface VRHeadMeshProps {
  agentId: string;
}

const VRHeadMesh: React.FC<VRHeadMeshProps> = ({ agentId }) => {
  const groupRef = useRef<THREE.Group>(null);
  const targetQuat = useRef(new THREE.Quaternion());

  useFrame(() => {
    if (!groupRef.current) return;
    const orientation = agentOrientations.get(agentId);
    if (orientation) {
      targetQuat.current.copy(orientation);
      // Remap: agent faces +Z in world space; we want that to face the mini-cam (+Z)
      // Invert Y rotation so left/right feels natural as webcam
      const euler = new THREE.Euler().setFromQuaternion(targetQuat.current, 'YXZ');
      euler.x = THREE.MathUtils.clamp(euler.x, -0.4, 0.4);
      euler.z = 0;
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, euler.x, 0.1);
      groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, -euler.y, 0.1);
    }
  });

  return (
    <group ref={groupRef}>
      {/* VR headset body */}
      <mesh>
        <boxGeometry args={[0.22, 0.11, 0.14]} />
        <meshPhysicalMaterial color="#1a1a1a" roughness={0.15} metalness={0.9} clearcoat={0.8} />
      </mesh>
      {/* Front visor */}
      <mesh position={[0, 0, 0.075]}>
        <boxGeometry args={[0.19, 0.08, 0.01]} />
        <meshPhysicalMaterial color="#8b5cf6" roughness={0.05} metalness={0.4} emissive="#8b5cf6" emissiveIntensity={0.5} transparent opacity={0.9} />
      </mesh>
      {/* Left strap nub */}
      <mesh position={[-0.12, 0, 0]} rotation={[0, 0, Math.PI / 12]}>
        <boxGeometry args={[0.05, 0.025, 0.09]} />
        <meshStandardMaterial color="#333" roughness={0.6} />
      </mesh>
      {/* Right strap nub */}
      <mesh position={[0.12, 0, 0]} rotation={[0, 0, -Math.PI / 12]}>
        <boxGeometry args={[0.05, 0.025, 0.09]} />
        <meshStandardMaterial color="#333" roughness={0.6} />
      </mesh>
      {/* Status LED */}
      <mesh position={[0.07, 0.043, 0.073]}>
        <sphereGeometry args={[0.009, 8, 8]} />
        <meshBasicMaterial color="#00ff88" />
      </mesh>
    </group>
  );
};

interface VRHeadsetTileProps {
  agentId: string;
  agentColor: string;
}

const VRHeadsetTile: React.FC<VRHeadsetTileProps> = ({ agentId, agentColor }) => {
  return (
    <div className="w-full h-[calc(100%-28px)] relative overflow-hidden">
      {/* Subtle vignette around the mini canvas */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{ background: 'radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)' }}
      />
      <Canvas
        camera={{ position: [0, 0.05, 0.55], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <color attach="background" args={['#0d0a1a']} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[1, 2, 1]} intensity={1.2} color="#ffffff" />
        <directionalLight position={[-1, -0.5, 0.5]} intensity={0.3} color={agentColor} />
        <VRHeadMesh agentId={agentId} />
      </Canvas>
    </div>
  );
};

export default VRHeadsetTile;
