import React, { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';
import type { ReviewPin, PinSeverity } from '../../lib/reviewSetupStore';

const PIN_COLOR: Record<PinSeverity, string> = {
  info: '#3b82f6',
  concern: '#f59e0b',
  blocker: '#ef4444',
};

// Pin marker matching the setup-canvas style. skipRaycast so lasers and
// hover-dwell don't accidentally pin to the marker itself. editingHelper so the
// lobby's thumbnail leaves it out (batch BV, lib/scene/captureClean.ts): a pin is
// something a curator placed, and a picture of the review with the pins still on it
// is a picture of the review mid-curation.
const PinMarker: React.FC<{ pin: ReviewPin }> = ({ pin }) => {
  return (
    <group position={pin.worldPos} userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}>
      <mesh userData={{ skipRaycast: true }}>
        <sphereGeometry args={[0.035, 16, 16]} />
        <meshBasicMaterial color={PIN_COLOR[pin.severity]} toneMapped={false} depthTest={false} />
      </mesh>
      <mesh position={[0, 0.05, 0]} userData={{ skipRaycast: true }}>
        <cylinderGeometry args={[0.003, 0.003, 0.1, 6]} />
        <meshBasicMaterial color={PIN_COLOR[pin.severity]} toneMapped={false} depthTest={false} />
      </mesh>
      <Html
        position={[0, 0.13, 0]}
        center
        distanceFactor={6}
        style={{ pointerEvents: 'none' }}
        zIndexRange={[0, 0]}
      >
        <div style={{
          background: PIN_COLOR[pin.severity],
          color: '#fff',
          fontFamily: 'monospace',
          fontSize: '8px',
          padding: '1px 4px',
          borderRadius: 3,
          whiteSpace: 'nowrap',
          opacity: 0.92,
        }}>
          {pin.label}
        </div>
      </Html>
    </group>
  );
};

// "Ride to viewpoint" animator. Watches activeReviewStore.jumpTarget; when set,
// lerps camera position + orbit-controls target toward it, then releases.
// Lives inside the existing canvas so it shares its OrbitControls instance.
const ViewpointAnimator: React.FC<{ controlsRef: React.MutableRefObject<any> }> = ({ controlsRef }) => {
  const { camera } = useThree();
  const target = useActiveReviewStore((s) => s.jumpTarget);
  const clear = useActiveReviewStore((s) => s.clearJumpTarget);

  const start = useRef(new THREE.Vector3());
  const startLook = useRef(new THREE.Vector3());
  const goalPos = useRef(new THREE.Vector3());
  const goalLook = useRef(new THREE.Vector3());
  const elapsed = useRef(0);
  const active = useRef(false);
  const DURATION = 0.6; // seconds

  useEffect(() => {
    if (!target) return;
    start.current.copy(camera.position);
    if (controlsRef.current?.target) {
      startLook.current.copy(controlsRef.current.target);
    } else {
      startLook.current.set(0, 0, 0);
    }
    goalPos.current.set(...target.position);
    goalLook.current.set(...target.lookAt);
    elapsed.current = 0;
    active.current = true;
  }, [target, camera, controlsRef]);

  useFrame((_, delta) => {
    if (!active.current) return;
    elapsed.current += delta;
    const t = Math.min(1, elapsed.current / DURATION);
    const k = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    camera.position.lerpVectors(start.current, goalPos.current, k);
    if (controlsRef.current?.target) {
      controlsRef.current.target.lerpVectors(startLook.current, goalLook.current, k);
      controlsRef.current.update();
    }
    if (t >= 1) {
      active.current = false;
      clear();
    }
  });

  return null;
};

interface Props {
  controlsRef: React.MutableRefObject<any>;
}

// Renders all curated review artifacts (pins + camera jump animator) inside
// the existing ViewpointCanvas. Mount once at the top of the canvas tree.
const ReviewArtifacts: React.FC<Props> = ({ controlsRef }) => {
  const config = useActiveReviewStore((s) => s.config);
  if (!config) return null;
  return (
    <>
      <ViewpointAnimator controlsRef={controlsRef} />
      {config.pins.map((p) => <PinMarker key={p.id} pin={p} />)}
    </>
  );
};

export default ReviewArtifacts;
