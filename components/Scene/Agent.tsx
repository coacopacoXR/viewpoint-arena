import React, { useRef, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3, Group, MeshStandardMaterial } from 'three';
import { Html, Line, Trail } from '@react-three/drei';
import { AgentState, PointOfInterest, ViewMode, AgentBehaviorState, AgentStyle } from '../../types';
import { useStore } from '../../store';
import * as THREE from 'three';
import { agentOrientations, agentPositions } from '../../lib/vrOrientationBridge';

interface AgentProps {
  initialState: AgentState;
  allAgents: AgentState[]; 
}

const Agent: React.FC<AgentProps> = ({ initialState, allAgents }) => {
  const groupRef = useRef<Group>(null);
  const visualRef = useRef<Group>(null); // For the visual mesh independent rotation
  const materialRef = useRef<MeshStandardMaterial>(null);
  
  const pois = useStore(state => state.pois);
  const showFrustums = useStore(state => state.showFrustums);
  const showGaze = useStore(state => state.showGaze);
  const showTrails = useStore(state => state.showTrails);
  const isPlaying = useStore(state => state.isPlaying);
  const activeAgentId = useStore(state => state.activeAgentId);
  const setActiveAgent = useStore(state => state.setActiveAgent);
  const setViewMode = useStore(state => state.setViewMode);
  const viewMode = useStore(state => state.viewMode);
  const leaderId = useStore(state => state.leaderId);
  const splitScreenTarget = useStore(state => state.splitScreenTarget);
  const agentStyle = useStore(state => state.agentStyle);
  const updateAgentStatus = useStore(state => state.updateAgentStatus);
  const setFollowRequest = useStore(state => state.setFollowRequest);
  
  // Local state for behavior
  const [behavior, setBehavior] = useState<AgentBehaviorState>('IDLE');
  const [targetPoi, setTargetPoi] = useState<PointOfInterest | null>(null);
  const [targetPos, setTargetPos] = useState(new Vector3(0, 0, 0));
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null); // Who are we following?
  
  // Movement references
  const position = useRef(new Vector3(
    Math.sin(initialState.id === '1' ? 0 : initialState.id === '2' ? 2 : 4) * 3.5,
    1,
    Math.cos(initialState.id === '1' ? 0 : initialState.id === '2' ? 2 : 4) * 3.5
  ));
  const lookTarget = useRef(new Vector3());
  const timer = useRef(0);
  const lookAtRef = useRef(new Vector3()); // Smooth lookAt

  // Initialize random behavior
  useEffect(() => {
    if (pois.length > 0 && !targetPoi) {
      pickNewTask();
    }
  }, [pois]);

  // Check if this is the VR agent (agent ID 4)
  const isVRAgent = initialState.id === '4';

  const pickNewTask = () => {
    if (pois.length === 0) return;

    // Probabilistic Behavior Selector - reduced probabilities for calmer behavior
    const roll = Math.random();

    if (roll < 0.05) {
        // 5% Chance (reduced from 10%): Follow User (Autonomous)
        setBehavior('FOLLOWING');
        updateAgentStatus(initialState.id, 'FOLLOWING', null);
        timer.current = 12 + Math.random() * 8; // Longer follow duration
    }
    else if (roll < 0.10 && allAgents.length > 1) {
        // 5% Chance (reduced from 10%): Follow Another Agent
        const others = allAgents.filter(a => a.id !== initialState.id);
        const target = others[Math.floor(Math.random() * others.length)];

        setTargetAgentId(target.id);
        setBehavior('FOLLOWING_AGENT');
        updateAgentStatus(initialState.id, 'FOLLOWING_AGENT', null);
        timer.current = 10 + Math.random() * 6;
    }
    else if (roll < 0.12) {
        // 2% Chance (reduced from 5%): Ask User to Follow ME
        setFollowRequest({ agentId: initialState.id, timestamp: Date.now() });
    }
    else {
        // Standard: Move to POI - but with longer inspection times
        const poi = pois[Math.floor(Math.random() * pois.length)];
        setTargetPoi(poi);
        setTargetAgentId(null);

        // Calculate a standing position near the POI
        const angle = Math.random() * Math.PI * 2;
        const dist = 2.5 + Math.random() * 1.0;

        const x = Math.sin(angle) * dist;
        const z = Math.cos(angle) * dist;
        setTargetPos(new Vector3(x, 1, z));

        setBehavior('MOVING');
        updateAgentStatus(initialState.id, 'MOVING', null);

        // Longer timer for calmer movement
        timer.current = 4 + Math.random() * 6;
    }
  };

  useFrame((state, delta) => {
    if (!groupRef.current) return;

    // --- Translucency Logic ---
    const camera = state.camera;
    const camPos = camera.position;
    const agentPos = groupRef.current.position;
    const centerPos = new Vector3(0, 0, 0); 

    const distCamToAgent = camPos.distanceTo(agentPos);
    const distCamToCenter = camPos.distanceTo(centerPos);
    
    const toAgent = agentPos.clone().sub(camPos).normalize();
    const toCenter = centerPos.clone().sub(camPos).normalize();
    const alignment = toAgent.dot(toCenter);

    let targetOpacity = 1.0;
    const isOccluding = (distCamToAgent < distCamToCenter - 1.0) && (alignment > 0.92);
    
    if (isOccluding) {
        targetOpacity = 0.15;
    }

    if (materialRef.current) {
        materialRef.current.opacity = THREE.MathUtils.lerp(materialRef.current.opacity, targetOpacity, delta * 5);
        materialRef.current.transparent = true; 
        materialRef.current.depthWrite = materialRef.current.opacity > 0.8;
    }

    if (visualRef.current && agentStyle === AgentStyle.BOX) {
        visualRef.current.lookAt(0, 0.5, 0); 
    }

    if (!isPlaying) return;

    // --- GLOBAL LEADER OVERRIDE ---
    const isForcedFollower = leaderId === 'USER';
    const isAutonomousFollowingUser = behavior === 'FOLLOWING' && !leaderId;
    const isFollowingAgent = behavior === 'FOLLOWING_AGENT' && targetAgentId && !leaderId;

    if (isForcedFollower || isAutonomousFollowingUser) {
         // -- USER FOLLOWING LOGIC --
         // Use camera as target
         const leaderPos = state.camera.position.clone();
         const leaderDir = new Vector3(0, 0, -1).applyQuaternion(state.camera.quaternion);
         leaderDir.y = 0; leaderDir.normalize();
         const leaderRight = new Vector3(-1, 0, 0).applyQuaternion(state.camera.quaternion);
         leaderRight.y = 0; leaderRight.normalize();

         // Formation Slot Logic
         let offsetRight = 0;
         let offsetBack = 2.5;
         
         if (initialState.id === '1') offsetRight = -1.5;
         if (initialState.id === '2') offsetRight = 1.5;
         if (initialState.id === '3') { offsetRight = 0; offsetBack = 3.5; }

         // Use ID as randomness if we are just randomly following user
         if (isAutonomousFollowingUser) {
             offsetBack = 3.0 + (parseInt(initialState.id) % 2);
             offsetRight = (parseInt(initialState.id) % 2 === 0 ? 1 : -1) * 1.5;
         }

         const formationPos = leaderPos.clone()
             .add(leaderDir.clone().multiplyScalar(-offsetBack))
             .add(leaderRight.clone().multiplyScalar(offsetRight));
         
         formationPos.y = 1.0; 

         const farTarget = leaderPos.clone().add(leaderDir.clone().multiplyScalar(10));

         // Slower, more natural movement - especially for VR agent
         const lerpSpeed = isVRAgent ? 0.02 : 0.03;
         position.current.lerp(formationPos, lerpSpeed);
         lookAtRef.current.lerp(farTarget, lerpSpeed);
         
         if (isAutonomousFollowingUser) {
             timer.current -= delta;
             if (timer.current <= 0) pickNewTask();
         }

    } else if (isFollowingAgent) {
        // -- AGENT FOLLOWING LOGIC --
        // Find target agent object
        const targetObj = groupRef.current?.parent?.getObjectByName(`Agent-${targetAgentId}`);
        
        if (targetObj) {
             const targetPos = targetObj.position.clone();

             // Stand 2 units behind the target, slightly offset
             const behindPos = targetPos.clone().add(targetPos.clone().normalize().multiplyScalar(2.0)); // Move outward from center relative to target
             
             position.current.lerp(behindPos, 0.05);
             lookAtRef.current.lerp(targetPos, 0.05); // Look at who we follow

             timer.current -= delta;
             if (timer.current <= 0) pickNewTask();
        } else {
             // Target lost
             pickNewTask();
        }

    } else {
        // -- AUTONOMOUS LOGIC --
        if (behavior === 'MOVING') {
            // Orbital Movement Logic
            const cx = 0; const cz = 0;
            const dx = position.current.x - cx;
            const dz = position.current.z - cz;
            let currentAngle = Math.atan2(dx, dz); 
            let currentRadius = Math.sqrt(dx*dx + dz*dz);
            
            const tx = targetPos.x - cx;
            const tz = targetPos.z - cz;
            const targetAngle = Math.atan2(tx, tz);
            const targetRadius = Math.sqrt(tx*tx + tz*tz);

            let deltaAngle = targetAngle - currentAngle;
            if (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
            if (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;

            // Reduced speeds for calmer movement - VR agent moves more naturally
            const angularSpeed = isVRAgent ? 0.25 : 0.35;
            const radialSpeed = isVRAgent ? 0.4 : 0.6; 
            
            if (Math.abs(deltaAngle) < 0.1 && Math.abs(targetRadius - currentRadius) < 0.2) {
                setBehavior('INSPECTING');
                updateAgentStatus(initialState.id, 'INSPECTING', targetPoi?.id || null);
                timer.current = 3 + Math.random() * 5; 
            } else {
                 const angleStep = angularSpeed * delta;
                 if (Math.abs(deltaAngle) > 0.01) {
                     currentAngle += Math.sign(deltaAngle) * Math.min(Math.abs(deltaAngle), angleStep);
                 }
                 currentRadius = THREE.MathUtils.lerp(currentRadius, targetRadius, delta * radialSpeed);

                 position.current.x = cx + Math.sin(currentAngle) * currentRadius;
                 position.current.z = cz + Math.cos(currentAngle) * currentRadius;
            }
            
            if (targetPoi) lookAtRef.current.lerp(targetPoi.position, 0.1);

        } else if (behavior === 'INSPECTING') {
            timer.current -= delta;
            if (targetPoi) lookAtRef.current.lerp(targetPoi.position, 0.05);
            // Subtle idle animation - VR agent has more natural subtle movement
            const bobSpeed = isVRAgent ? 1.2 : 1.5;
            const bobAmount = isVRAgent ? 0.02 : 0.03;
            position.current.y = 1 + Math.sin(state.clock.elapsedTime * bobSpeed) * bobAmount;
            if (timer.current <= 0) pickNewTask();
        } 
    }

    lookTarget.current.copy(lookAtRef.current);

    // Separation
    if (!isForcedFollower && !isFollowingAgent) {
        allAgents.forEach(other => {
             if (other.id !== initialState.id) {
                const otherObj = groupRef.current?.parent?.getObjectByName(`Agent-${other.id}`);
                if (otherObj) {
                    const diff = position.current.clone().sub(otherObj.position);
                    const dist = diff.length();
                    if (dist < 1.2) {
                        diff.normalize().multiplyScalar(delta * 2.0);
                        position.current.add(diff);
                    }
                }
             }
        });
    }

    // Reduced lerp speed for smoother, calmer movement
    const finalLerp = isVRAgent ? 0.08 : 0.12;
    groupRef.current.position.lerp(position.current, finalLerp);
    groupRef.current.lookAt(lookAtRef.current);

    // Write orientation to bridge for VRHeadsetTile (separate canvas)
    const q = groupRef.current.quaternion;
    let stored = agentOrientations.get(initialState.id);
    if (!stored) { stored = new THREE.Quaternion(); agentOrientations.set(initialState.id, stored); }
    stored.copy(q);

    let storedPos = agentPositions.get(initialState.id);
    if (!storedPos) { storedPos = new THREE.Vector3(); agentPositions.set(initialState.id, storedPos); }
    storedPos.copy(groupRef.current.position);
  });

  const isBoardroomMode = useStore(state => state.isBoardroomMode);

  const agentColor = initialState.role === 'PRESENTER' ? '#ff4400' : (initialState.role === 'REVIEWER' ? '#0066ff' : '#888');

  const isPossessed = (viewMode === ViewMode.POV_AGENT && activeAgentId === initialState.id);
  // In boardroom mode, hide all agents except VR.USER (id=4) — they're represented by boardroom tiles
  if (isBoardroomMode && !isVRAgent) return null;
  const isVisible = !isPossessed; 
  const isActive = activeAgentId === initialState.id;
  const isSplitTarget = splitScreenTarget?.kind === 'agent' && splitScreenTarget.id === initialState.id;

  const handleInteraction = (e: any) => {
    e.stopPropagation();
    setActiveAgent(initialState.id);
    setViewMode(ViewMode.POV_AGENT);
  };

  return (
    <group ref={groupRef} onClick={handleInteraction} name={`Agent-${initialState.id}`}>
      {showTrails && (
          <Trail width={0.3} length={15} color={agentColor} attenuation={(t) => t * t}>
            <mesh visible={false} position={[0, 0, 0]}><sphereGeometry args={[0.1]} /></mesh>
          </Trail>
      )}

      {((isActive && viewMode === ViewMode.POV_AGENT) || (isSplitTarget && viewMode === ViewMode.SPLIT_SCREEN)) && !isPossessed && (
        <mesh position={[0, -0.8, 0]} rotation={[-Math.PI/2, 0, 0]}>
            <ringGeometry args={[0.4, 0.5, 32]} />
            <meshBasicMaterial color={isSplitTarget ? "#00ff00" : agentColor} opacity={0.5} transparent />
        </mesh>
      )}

      <group visible={isVisible}>
          {agentStyle === AgentStyle.BOX && (
             <group ref={visualRef} position={[0, 0.6, 0]}>
                 <mesh castShadow receiveShadow>
                    <planeGeometry args={[0.12, 0.08]} />
                    <meshPhysicalMaterial ref={materialRef} color={agentColor} roughness={0.1} metalness={0.8} emissive={agentColor} emissiveIntensity={0.5} side={THREE.DoubleSide} transparent opacity={0.85} />
                 </mesh>
                 <mesh position={[0, 0, -0.005]}><boxGeometry args={[0.13, 0.09, 0.01]} /><meshStandardMaterial color="#111" roughness={0.5} /></mesh>
             </group>
          )}

          {agentStyle === AgentStyle.CAPSULE && (
             <mesh castShadow receiveShadow rotation={[Math.PI/2, 0, 0]} position={[0, 0.1, 0]}>
                <capsuleGeometry args={[0.2, 1.2, 4, 8]} />
                <meshStandardMaterial ref={materialRef} color="#333" roughness={0.3} metalness={0.1} />
             </mesh>
          )}
          
          {agentStyle === AgentStyle.ROBOT && (
            <group position={[0, 0.2, 0]}>
                 <mesh castShadow receiveShadow><boxGeometry args={[0.4, 0.8, 0.3]} /><meshStandardMaterial ref={materialRef} color="#444" roughness={0.3} metalness={0.6} /></mesh>
                 <mesh castShadow receiveShadow position={[0, 0.6, 0]}><boxGeometry args={[0.3, 0.3, 0.3]} /><meshStandardMaterial color={agentColor} /></mesh>
            </group>
          )}

          {/* VR Headset Style - represents someone joining from VR */}
          {(agentStyle === AgentStyle.VR_HEADSET || isVRAgent) && (
            <group position={[0, 0.5, 0]}>
                 {/* VR Headset body */}
                 <mesh castShadow receiveShadow>
                    <boxGeometry args={[0.18, 0.09, 0.12]} />
                    <meshPhysicalMaterial
                      ref={materialRef}
                      color="#1a1a1a"
                      roughness={0.15}
                      metalness={0.9}
                      clearcoat={0.8}
                      clearcoatRoughness={0.2}
                    />
                 </mesh>
                 {/* Front visor/lens */}
                 <mesh position={[0, 0, 0.065]}>
                    <boxGeometry args={[0.16, 0.06, 0.01]} />
                    <meshPhysicalMaterial
                      color="#8b5cf6"
                      roughness={0.1}
                      metalness={0.5}
                      emissive="#8b5cf6"
                      emissiveIntensity={0.3}
                      transparent
                      opacity={0.9}
                    />
                 </mesh>
                 {/* Side straps hint */}
                 <mesh position={[-0.1, 0, 0]} rotation={[0, 0, Math.PI / 12]}>
                    <boxGeometry args={[0.04, 0.02, 0.08]} />
                    <meshStandardMaterial color="#333" roughness={0.5} />
                 </mesh>
                 <mesh position={[0.1, 0, 0]} rotation={[0, 0, -Math.PI / 12]}>
                    <boxGeometry args={[0.04, 0.02, 0.08]} />
                    <meshStandardMaterial color="#333" roughness={0.5} />
                 </mesh>
                 {/* Small indicator light */}
                 <mesh position={[0.06, 0.035, 0.06]}>
                    <sphereGeometry args={[0.008, 8, 8]} />
                    <meshBasicMaterial color="#00ff88" />
                 </mesh>
            </group>
          )}

          {showFrustums && (
            <group position={[0, 0.6, 0.1]}>
                <Line
                    points={[[0, 0, 0], [-0.5, 0.3, 1.5], [0, 0, 0], [0.5, 0.3, 1.5], [0, 0, 0], [-0.5, -0.3, 1.5], [0, 0, 0], [0.5, -0.3, 1.5], [-0.5, 0.3, 1.5], [0.5, 0.3, 1.5], [0.5, 0.3, 1.5], [0.5, -0.3, 1.5], [0.5, -0.3, 1.5], [-0.5, -0.3, 1.5], [-0.5, -0.3, 1.5], [-0.5, 0.3, 1.5]]}
                    color={agentColor} transparent opacity={isActive ? 0.4 : 0.15} lineWidth={1}
                />
            </group>
          )}
      </group>

      {showGaze && isVisible && (
        <group>
            <Line points={[[0, 0.6, 0.1], [0, 0.6, 4]]} color={agentColor} transparent opacity={0.1} dashScale={2} dashed lineWidth={1} />
        </group>
      )}

      {isVisible && (
        <Html position={[0, 1.0, 0]} center distanceFactor={6} style={{pointerEvents: 'none'}} zIndexRange={[0, 0]}>
            <div className="flex flex-col items-center gap-1 opacity-80">
                <div className={`font-mono text-[8px] px-1 rounded border whitespace-nowrap backdrop-blur-md transition-colors ${isActive ? 'bg-black text-white border-black' : 'text-gray-500 bg-white/60 border-gray-200'}`}>
                {initialState.name}
                </div>
            </div>
        </Html>
      )}
    </group>
  );
};

export default Agent;