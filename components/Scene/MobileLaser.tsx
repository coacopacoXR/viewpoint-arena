import React, { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3, Raycaster, Vector2, Mesh } from 'three';
import { mobileLaserRef } from '../../lib/mobileLaserRef';
import { usePresence } from '../../lib/PresenceContext';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';
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
    let foundId: string | null = null;
    let foundMeshName: string | null = null;
    let foundPartName: string | null = null;
    let hitPoint: Vector3 | null = null;

    for (const hit of intersects) {
      const obj: any = hit.object;
      if (
        obj.userData?.skipRaycast ||
        obj.name?.startsWith?.('Agent') ||
        obj.type === 'Line' ||
        obj.type === 'Points' ||
        (dotRef.current && obj === dotRef.current)
      ) continue;

      let curr: any = obj;
      let skip = false;
      while (curr) {
        if (curr.userData?.skipRaycast) { skip = true; break; }
        if (curr.userData?.modelId) { foundId = curr.userData.modelId; break; }
        curr = curr.parent ?? null;
      }
      if (skip) { foundId = null; continue; }

      if (foundId) {
        hitPoint = hit.point;
        foundMeshName = obj.userData?.meshIndex != null
          ? String(obj.userData.meshIndex)
          : (obj.name || null);
        foundPartName = obj.userData?.partName ?? null;
        break;
      }
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
