import React, { useRef, useEffect } from 'react';
import { RoundedBox } from '@react-three/drei';
import { Group, Vector3 } from 'three';
import { useStore } from '../../store';

// Wrapper component that connects 3D objects to the Scene Tree State
// Handles Visibility and Selection Glow
const ModelPart: React.FC<{
    id: string;
    children: React.ReactNode | ((props: { selected: boolean }) => React.ReactNode);
    groupProps?: any;
}> = ({ id, children, groupProps }) => {
    const objectState = useStore(state => state.objectStates[id]);

    // Default to visible if state not ready
    const visible = objectState ? objectState.visible : true;
    const selected = objectState ? objectState.selected : false;

    if (!visible) return null;

    return (
        // userData.modelId and nodeId are crucial for the Laser Raycaster to identify this group
        <group {...groupProps} userData={{ modelId: id, nodeId: id }}>
            {typeof children === 'function' ? children({ selected }) : children}
        </group>
    );
};

const Knob: React.FC<{ position: [number, number, number]; color?: string; id: string; label: string; selected?: boolean }> = ({ position, color = '#333', id, label, selected }) => {
  const registerPOI = useStore(state => state.registerPOI);
  const ref = useRef<Group>(null);

  useEffect(() => {
      if (ref.current) {
          const worldPos = new Vector3();
          ref.current.getWorldPosition(worldPos);
          worldPos.y += 0.1;
          registerPOI({ id, position: worldPos, label, type: 'KNOB' });
      }
  }, [registerPOI, id, label]);

  // Selection Glow Color Override
  const finalColor = selected ? '#0088ff' : color;
  const finalEmissive = selected ? '#0088ff' : "#000000";
  const finalEmissiveIntensity = selected ? 0.8 : 0;

  return (
    <group ref={ref} position={position}>
      <mesh castShadow receiveShadow position={[0, 0.1, 0]}>
        <cylinderGeometry args={[0.15, 0.15, 0.2, 32]} />
        <meshStandardMaterial 
            color={finalColor} 
            emissive={finalEmissive}
            emissiveIntensity={finalEmissiveIntensity}
            roughness={0.4} 
        />
      </mesh>
      <mesh position={[0, 0.2, 0]}>
        <boxGeometry args={[0.04, 0.05, 0.15]} />
        <meshStandardMaterial color="white" />
      </mesh>
    </group>
  );
};

const Key: React.FC<{ position: [number, number, number]; black?: boolean }> = ({ position, black }) => (
  <mesh position={position} castShadow receiveShadow>
    <boxGeometry args={[0.18, 0.1, black ? 0.6 : 0.9]} />
    <meshStandardMaterial color={black ? '#222' : '#eee'} roughness={0.2} />
  </mesh>
);

const Product: React.FC = () => {
  const groupRef = useRef<Group>(null);
  const registerPOI = useStore(state => state.registerPOI);

  useEffect(() => {
     if (groupRef.current) {
        const screenPos = new Vector3(0.6, 0.2, -0.3);
        registerPOI({ id: 'screen-main', position: screenPos, label: 'Main Display', type: 'SCREEN' });
        
        const keysPos = new Vector3(0.3, 0.15, 0.4);
        registerPOI({ id: 'keys-section', position: keysPos, label: 'Keybed', type: 'KEY' });
     }
  }, [registerPOI]);

  // Generate keys
  const keys = [];
  for (let i = 0; i < 7; i++) {
    keys.push(<Key key={`w-${i}`} position={[-0.9 + i * 0.2, 0.1, 0.4]} />);
    if (i !== 2 && i !== 6) {
       keys.push(<Key key={`b-${i}`} position={[-0.8 + i * 0.2, 0.15, 0.1]} black />);
    }
  }
  
  return (
    <group ref={groupRef} position={[0, 0, 0]}>

        <ModelPart id="assembly">

            {/* CHASSIS GROUP */}
            <ModelPart id="chassis_grp">
                <ModelPart id="main_body">
                    {({ selected }) => (
                        <RoundedBox args={[2.4, 0.2, 1.6]} radius={0.05} smoothness={4} position={[0, 0, 0]} castShadow receiveShadow>
                            <meshStandardMaterial
                                color="#e0e0e0"
                                roughness={0.6} 
                                emissive={selected ? "#0044aa" : "#000000"}
                                emissiveIntensity={selected ? 0.5 : 0}
                            />
                        </RoundedBox>
                    )}
                </ModelPart>
                
                <ModelPart id="branding">
                    {({ selected }) => (
                        <mesh position={[-1.0, 0.11, 0.6]} rotation={[-Math.PI/2, 0, 0]}>
                            <planeGeometry args={[0.1, 0.02]} />
                            <meshBasicMaterial color={selected ? "#0088ff" : "#999"} />
                        </mesh>
                    )}
                </ModelPart>
            </ModelPart>

            {/* INTERFACE GROUP */}
            <ModelPart id="interface">
                
                {/* SCREEN GROUP */}
                <ModelPart id="screen_grp">
                    <ModelPart id="screen_glass">
                        {({ selected }) => (
                             <mesh position={[0.6, 0.11, -0.3]} rotation={[-Math.PI / 2, 0, 0]}>
                                <planeGeometry args={[0.8, 0.5]} />
                                <meshBasicMaterial color={selected ? "#0044aa" : "#1a1a1a"} />
                             </mesh>
                        )}
                    </ModelPart>
                    <ModelPart id="screen_ui">
                        {({ selected }) => (
                            <mesh position={[0.6, 0.12, -0.3]} rotation={[-Math.PI / 2, 0, 0]}>
                                <planeGeometry args={[0.7, 0.4]} />
                                <meshBasicMaterial color={selected ? "#00ffff" : "#ff5500"} wireframe />
                            </mesh>
                        )}
                    </ModelPart>
                </ModelPart>

                {/* CONTROLS GROUP */}
                <ModelPart id="controls">
                    
                    {/* KNOBS */}
                    <ModelPart id="knobs_grp">
                        <ModelPart id="knob-vol">
                            {({ selected }) => <Knob position={[-0.8, 0.1, -0.4]} color="#d63031" id="knob-vol" label="Master Vol" selected={selected} />}
                        </ModelPart>
                        <ModelPart id="knob-filter">
                            {({ selected }) => <Knob position={[-0.4, 0.1, -0.4]} id="knob-filter" label="Filter Cutoff" selected={selected} />}
                        </ModelPart>
                        <ModelPart id="knob-res">
                            {({ selected }) => <Knob position={[0.0, 0.1, -0.4]} id="knob-res" label="Resonance" selected={selected} />}
                        </ModelPart>
                    </ModelPart>

                    {/* KEYS */}
                    <ModelPart id="keybed">
                        {({ selected }) => (
                            <group position={[0.3, 0.1, 0]}>
                                {keys}
                                {selected && (
                                    // Since keys are many meshes, we add a bounding box highlight instead of coloring all
                                    <mesh position={[0.4, 0.05, 0.25]}>
                                        <boxGeometry args={[1.5, 0.2, 0.6]} />
                                        <meshBasicMaterial color="#0088ff" wireframe transparent opacity={0.5} />
                                    </mesh>
                                )}
                            </group>
                        )}
                    </ModelPart>

                </ModelPart>

            </ModelPart>

        </ModelPart>

    </group>
  );
};

export default Product;