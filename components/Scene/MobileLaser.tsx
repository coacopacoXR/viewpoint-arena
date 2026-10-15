import React, { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3, Raycaster, Vector2, Mesh } from 'three';
import { mobileLaserRef } from '../../lib/mobileLaserRef';
import { usePresence } from '../../lib/PresenceContext';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';
import { hitParts, isPointableHit, partRegistries } from '../../lib/scene/partRegistry';
import { useStore } from '../../store';
import { setLaserEntry, clearLaserEntry } from '../../lib/laserTargetRef';

const MobileLaser: React.FC = () => {
  const { camera, scene } = useThree();
  const { broadcastLaserMove, localUserId } = usePresence();
  const userColor = useStore(state => state.currentUserColor);
  const raycaster = useRef(new Raycaster());
  const lastBroadcast = useRef(0);
  const wasActive = useRef(false);
  const dotRef = useRef<Mesh>(null);
  const lastHit = useRef(new Vector3());
  const lastFoundId = useRef<string | null>(null);

  useFrame(() => {
    const ndc = mobileLaserRef.ndc;

    if (ndc === null) {
      if (wasActive.current) {
        broadcastLaserMove(null, null);
        clearLaserEntry(localUserId);
        wasActive.current = false;
        lastFoundId.current = null;
      }
      if (dotRef.current) dotRef.current.visible = false;
      return;
    }

    wasActive.current = true;

    raycaster.current.setFromCamera(new Vector2(ndc[0], ndc[1]), camera);

    const intersects = raycaster.current.intersectObjects(scene.children, true);
    const registries = partRegistries(useStore.getState().sceneEntries);
    let foundId: string | null = null;
    let foundMeshName: string | null = null;
    let foundPartName: string | null = null;
    let hitPoint: Vector3 | null = null;

    for (const hit of intersects) {
      // Covers the dot this component draws, which used to be excluded by an explicit
      // `obj === dotRef.current` beside the same test: the dot is tagged skipRaycast in
      // the JSX below, so it is not something a ray may land on and neither is anything
      // above it.
      if (!isPointableHit(hit)) continue;

      const parts = hitParts(hit, registries);
      if (parts.modelId === null) continue;

      foundId = parts.modelId;
      hitPoint = hit.point;
      foundMeshName = hit.object.name || null;
      // The part's readable name. `userData.partName` before, which no importer writes,
      // so the touch laser had never named a part either.
      foundPartName = parts.handle?.name ?? null;
      break;
    }

    if (hitPoint) {
      lastHit.current.copy(hitPoint);
    } else {
      // No model hit — project the dot forward along the ray so it doesn't pin to an avatar
      raycaster.current.ray.at(6, lastHit.current);
    }

    if (dotRef.current) {
      dotRef.current.visible = true;
      dotRef.current.position.copy(lastHit.current);
    }

    setLaserEntry(localUserId, foundId, foundMeshName, foundPartName, userColor);

    const now = Date.now();
    if (now - lastBroadcast.current >= 80) {
      lastBroadcast.current = now;
      broadcastLaserMove([lastHit.current.x, lastHit.current.y, lastHit.current.z], foundId, foundMeshName, foundPartName);
      lastFoundId.current = foundId;
    }
  });

  // editingHelper: this is the dot a pointing finger lands on, and the lobby's
  // thumbnail leaves the dots out (batch BV, lib/scene/captureClean.ts).
  return (
    <mesh
      ref={dotRef}
      visible={false}
      renderOrder={999}
      userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}
    >
      <sphereGeometry args={[0.045, 12, 12]} />
      <meshBasicMaterial color={userColor} toneMapped={false} depthTest={false} />
    </mesh>
  );
};

export default MobileLaser;
