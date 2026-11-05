import React, { useRef, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useActiveReviewStore } from '../../lib/activeReviewStore';
import { useStore } from '../../store';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';
import { useMarkerOccluded } from '../../lib/scene/markerOcclusion';
import { MARKER_OCCLUDED_OPACITY, MARKER_Z_RANGE } from '../../lib/scene/markerLayers';
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
//
// `depthTest={false}` STAYS, and that is a choice rather than an oversight. The anchor is a
// point on a surface — components/review/ReviewEditPanel.tsx drops it at the placement
// raycast's own `hit.point` — so a depth-tested sphere whose centre is exactly on a
// triangle is half in and half out of it, and which half wins is decided per pixel by
// precision. That is a pin that sparkles on the face it was put on. Depth-blind is the fix
// for that, and the fix for what depth-blindness then costs — a pin showing straight
// through the model that is hiding it — is the occlusion pass, which fades the whole marker
// to MARKER_OCCLUDED_OPACITY when anything the room is drawing stands between it and the
// camera. See lib/scene/markerOcclusion.ts.
const PinMarker: React.FC<{ pin: ReviewPin }> = ({ pin }) => {
  const anchor = useMemo(
    () => new THREE.Vector3(pin.worldPos[0], pin.worldPos[1], pin.worldPos[2]),
    [pin.worldPos],
  );
  // The part the pin was placed on, which may not hide it: `meshIndex` is the node id the
  // drop resolved to and `modelId` the fallback for a pin curated before there was one, the
  // same pair lib/activeReviewStore.pinToComment reads when it mirrors a pin into the
  // room's comment list.
  const occluded = useMarkerOccluded(`pin-${pin.id}`, anchor, pin.meshIndex ?? pin.modelId ?? null);
  const opacity = occluded ? MARKER_OCCLUDED_OPACITY : 1;
  return (
    <group position={pin.worldPos} userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}>
      <mesh userData={{ skipRaycast: true }}>
        <sphereGeometry args={[0.035, 16, 16]} />
        <meshBasicMaterial
          color={PIN_COLOR[pin.severity]}
          toneMapped={false}
          depthTest={false}
          transparent
          opacity={opacity}
        />
      </mesh>
      <mesh position={[0, 0.05, 0]} userData={{ skipRaycast: true }}>
        <cylinderGeometry args={[0.003, 0.003, 0.1, 6]} />
        <meshBasicMaterial
          color={PIN_COLOR[pin.severity]}
          toneMapped={false}
          depthTest={false}
          transparent
          opacity={opacity}
        />
      </mesh>
      <Html
        position={[0, 0.13, 0]}
        center
        distanceFactor={6}
        // The layer every comment and pin marker shares, under the room's panels rather
        // than over them. It was `[0, 0]` before, which was already under them — but a pin
        // label at 0 also sat under an avatar's name tag and a laser's part label, and the
        // two families are placed by the same raycast and hidden by the same switch.
        // See lib/scene/markerLayers.ts.
        zIndexRange={MARKER_Z_RANGE}
        style={{ pointerEvents: 'none', opacity, transition: 'opacity 0.2s' }}
      >
        <div
          data-testid="pin-marker"
          data-pin-id={pin.id}
          data-occluded={occluded ? '1' : '0'}
          style={{
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
  const { camera, invalidate } = useThree();
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
    // The jump lives in activeReviewStore, not in the store the room's other frames are asked
    // for, so it has to ask for its own first one — under `frameloop="demand"` a camera ride
    // nobody requested a frame for is a ride that never leaves.
    invalidate();
  }, [target, camera, controlsRef, invalidate]);

  useFrame((state, delta) => {
    if (!active.current) return;
    // And then every frame of the ride, until it lands and clears itself.
    state.invalidate();
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
  // The same local switch components/Scene/SpatialComments.tsx reads, and read before the
  // early return below because a hook after a conditional one is a hook that changes order.
  const markersHidden = useStore((s) => s.sceneMarkersHidden);
  if (!config) return null;
  return (
    <>
      {/* The animator is NOT behind the switch: it is the camera ride the review's own
          viewpoint list asks for, which has nothing to do with whether the pins are drawn. */}
      <ViewpointAnimator controlsRef={controlsRef} />
      {/* Not mounted rather than mounted invisible, for the reason the comment markers are
          not either: an unmounted pin is no sphere, no label element and no entry in the
          occlusion registry, which is the difference between a switch that hides things and
          a switch that hides things and still costs what showing them did. */}
      {!markersHidden && config.pins.map((p) => <PinMarker key={p.id} pin={p} />)}
    </>
  );
};

export default ReviewArtifacts;
