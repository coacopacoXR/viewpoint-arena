import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Grid, ContactShadows } from '@react-three/drei';
import type * as THREE from 'three';

import Product from './Product';
import ImportedModel from './ImportedModel';
import Agent from './Agent';
import LightRig from './LightRig';
import ThumbnailCapture from './ThumbnailCapture';
import { useStore } from '../../store';
import { useSceneModelLoader } from '../../lib/scene/useSceneModelLoader';

interface WorldProps {
  hideAgents?: boolean;
  /** When provided, the inner model-transform group attaches to this ref so
   * the setup canvas can drive it with TransformControls. */
  modelGroupRef?: React.MutableRefObject<THREE.Group | null>;
}

const World: React.FC<WorldProps> = ({ hideAgents: hideAgentsOverride, modelGroupRef }) => {
  // Use selectors to improve performance and prevent re-renders
  const isPlaying = useStore(state => state.isPlaying);
  const setTime = useStore(state => state.setTime);
  const setUserInteractionPoint = useStore(state => state.setUserInteractionPoint);
  const agents = useStore(state => state.agents);
  const storeHideAgents = useStore(state => state.hideAgents);
  const hideAgents = hideAgentsOverride ?? storeHideAgents;
  const activeModelType = useStore(state => state.activeModelType);
  const modelTransform = useStore(state => state.modelTransform);

  // Whatever the room's scene lists but this browser has not parsed yet gets
  // downloaded and parsed here, so a late joiner ends up looking at the same
  // geometry as everybody else. Mounted in World because World is the one
  // component every canvas in the app renders.
  useSceneModelLoader();

  // Ref to track throttle
  const lastTimeUpdate = useRef(0);

  // THE CLOCK MUST NOT ASK FOR A FRAME, and the room renders on demand
  // (`frameloop="demand"` in components/Scene/ViewpointCanvas.tsx), so that is a live constraint
  // rather than a taste: this runs inside useFrame, so a frame that wrote the clock and then
  // asked for another one would keep an untouched room turning at ten frames a second forever.
  // It does not ask — nothing here calls `invalidate()` — and components/Scene/MotionQuality.tsx's
  // `StoreDrivenFrames` skips `time` when it decides whether a store write means the picture
  // changed, which is the other half of the same rule. Nothing draws the clock; it is a number
  // four UI components read. If this ever grows a visual, the visual asks for its own frames and
  // the clock stays quiet.
  useFrame((state) => {
    if (isPlaying) {
      // Only update React state (store.time) every 100ms to prevent crash
      // This keeps the UI clock ticking but allows 60fps animation via state.clock
      if (state.clock.elapsedTime - lastTimeUpdate.current > 0.1) {
          setTime(state.clock.elapsedTime);
          lastTimeUpdate.current = state.clock.elapsedTime;
      }
    }
  });

  // Handle user gaze/interaction tracking for "Follow User" mode
  const handlePointerMove = (e: any) => {
    if (e.point) {
        setUserInteractionPoint(e.point);
    }
  };

  return (
    <>
      <color attach="background" args={['#f0f0f0']} />
      <fog attach="fog" args={['#f0f0f0', 5, 25]} />

      {/* The lights, and the same lights the lobby's "Turn in 3D" preview draws a model
          under — see components/Scene/LightRig.tsx for what changed and why. What was
          here (ambient 0.7, one point light, a studio environment blurred to nothing)
          left a curved surface with no gradient on it, which is most of why an imported
          model looked flat next to the picture its author took of it. */}
      <LightRig />

      {/* Interaction Plane for Mouse Tracking */}
      <mesh visible={false} rotation={[-Math.PI/2, 0, 0]} position={[0, 0.5, 0]} onPointerMove={handlePointerMove}>
         <planeGeometry args={[20, 20]} />
         <meshBasicMaterial />
      </mesh>

      <Grid 
        infiniteGrid 
        fadeDistance={20} 
        fadeStrength={1.5} 
        sectionSize={1} 
        cellSize={0.5} 
        sectionColor="#cccccc"
        cellColor="#e5e5e5"
        position={[0, -0.01, 0]}
      />

      <group position={[0, 0, 0]}>
        {/* Inner group applies the curator's transform — affects only the
            model itself, not contact shadows / heatmap / etc. */}
        <group
          ref={modelGroupRef as React.RefObject<THREE.Group>}
          position={modelTransform.position}
          rotation={modelTransform.rotation}
          scale={modelTransform.scale}
        >
          {/* A built-in shows only while the scene holds no models of its own:
              activeModelType is derived from the scene, so 'imported' means the
              list is not empty and the preset steps aside. */}
          {activeModelType === 'synth' ? <Product /> : null}
          {/* Every model the room's scene holds, each at its own offset. Renders
              nothing at all when the list is empty, which is why it can sit here
              unconditionally next to the presets. */}
          <ImportedModel />
        </group>

        <ContactShadows
            opacity={0.4}
            scale={10}
            blur={1.5}
            far={1.2}
            resolution={256}
            color="#000000"
        />
      </group>
      
      {!hideAgents && agents.map((agent) => (
        <Agent key={agent.id} initialState={agent} allAgents={agents} />
      ))}

      {/* Renders nothing. Mounted here because World is the one component every canvas
          in this app draws, and taking the lobby's picture of a room needs the renderer
          this canvas owns. See components/Scene/ThumbnailCapture.tsx. */}
      <ThumbnailCapture />
    </>
  );
};

export default World;
