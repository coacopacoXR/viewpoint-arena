import React, { useRef, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Vector3, Vector2, Raycaster, Mesh, Group } from 'three';
import * as THREE from 'three';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { setLaserEntry, clearLaserEntry } from '../../lib/laserTargetRef';
import { fingerPointerRef } from '../../lib/fingerPointerRef';
import { pointingSourceRef } from '../../lib/pointingSourceRef';
import { getModelCenter } from '../../lib/orbitPivot';
import { pickSelectionId } from '../../lib/pickSelectionId';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';

// Project the active model's center to NDC. Returns true on success.
function computeModelCenterNDC(scene: THREE.Scene, camera: THREE.Camera, out: Vector2): boolean {
    const center = getModelCenter(scene);
    if (!center) return false;
    center.project(camera); // world → NDC
    out.set(center.x, center.y);
    return true;
}

const UserLaser: React.FC = () => {
    const { camera, scene } = useThree();
    const isLaserActive = useStore(state => state.isLaserActive);
    const setLaserActive = useStore(state => state.setLaserActive);
    const selectNode = useStore(state => state.selectNode);
    const userColor = useStore(state => state.currentUserColor);
    const hoverPointingEnabled = useStore(state => state.hoverPointingEnabled);
    const { broadcastLaserMove, localUserId } = usePresence();
    const lastLaserBroadcast = useRef(0);

    const raycaster = useRef(new Raycaster());

    // Refs for direct manipulation (60fps performance)
    const beamMesh = useRef<Mesh>(null);
    const sparkMesh = useRef<Group>(null);
    const partLabelRef = useRef<HTMLDivElement>(null);

    const laserEndPos = useRef(new Vector3());
    const laserStartPos = useRef(new Vector3());

    const lastHitId = useRef<string | null>(null);
    const lastPartName = useRef<string | null>(null);

    // Activation sources tracked independently so the laser stays active as
    // long as ANY source is held (mouse both-buttons OR P key OR finger pointing
    // OR hover-dwell on a model part).
    const mouseHeld = useRef(false);
    const keyHeld = useRef(false);
    const fingerHeld = useRef(false);
    const dwellHeld = useRef(false);
    const wasActive = useRef(false);
    const syncRef = useRef<() => void>(() => {});

    useEffect(() => {
        const sync = () => {
            const active = mouseHeld.current || keyHeld.current || fingerHeld.current || dwellHeld.current;
            if (active === wasActive.current) return;
            wasActive.current = active;
            setLaserActive(active);
            if (!active) {
                // Belt-and-suspenders: clear local state + tell remotes the laser is off.
                // The TTL on receivers is a backstop if this broadcast is lost.
                broadcastLaserMove(null, null);
                selectNode(null);
                lastHitId.current = null;
                lastPartName.current = null;
                clearLaserEntry(localUserId);
                pointingSourceRef.current = null;
                if (partLabelRef.current) {
                    partLabelRef.current.style.display = 'none';
                    partLabelRef.current.textContent = '';
                }
            }
        };
        syncRef.current = sync;

        const isTextInput = (target: EventTarget | null) => {
            if (!(target instanceof HTMLElement)) return false;
            return (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.tagName === 'SELECT' ||
                target.isContentEditable
            );
        };

        const handleMouseDown = (e: MouseEvent) => {
            if (e.buttons === 3) { mouseHeld.current = true; sync(); }
        };
        const handleMouseUp = (e: MouseEvent) => {
            if (e.buttons !== 3) { mouseHeld.current = false; sync(); }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.repeat) return;
            if (e.key !== 'p' && e.key !== 'P') return;
            if (isTextInput(e.target)) return;
            keyHeld.current = true;
            sync();
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.key !== 'p' && e.key !== 'P') return;
            keyHeld.current = false;
            sync();
        };
        const releaseAll = () => {
            mouseHeld.current = false;
            keyHeld.current = false;
            sync();
        };
        const handleVisibility = () => {
            if (document.hidden) releaseAll();
        };

        window.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mouseup', handleMouseUp);
        // pointerup fires even when the cursor leaves the window — covers cases
        // where mouseup doesn't get delivered (drag out, browser focus loss).
        window.addEventListener('pointerup', handleMouseUp as unknown as EventListener);
        window.addEventListener('pointercancel', releaseAll);
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', releaseAll);
        document.addEventListener('visibilitychange', handleVisibility);

        return () => {
            window.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('pointerup', handleMouseUp as unknown as EventListener);
            window.removeEventListener('pointercancel', releaseAll);
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', releaseAll);
            document.removeEventListener('visibilitychange', handleVisibility);
        };
    }, [setLaserActive, selectNode, broadcastLaserMove, localUserId]);

    // Reused per frame to avoid GC churn when finger pointing.
    const fingerPointerVec = useRef(new Vector2());
    // Trackpad-style anchoring. On fresh detection we record:
    //   fingerOrigin = where the homography puts the hand at that moment
    //   fingerAnchor = where on screen we want to start (model center)
    // Each frame: pointer = anchor + (currentAim − origin) × sensitivity.
    // Hover-dwell pointing constants. The buffer keeps 2s of history so we
    // can distinguish "cursor was moving, then settled here" (= pointing
    // intent) from "cursor has been frozen here forever" (= idle). Activation
    // requires BOTH a tight recent cluster AND evidence of approach.
    const DWELL_BUFFER_MS = 2000;          // total history retained
    const DWELL_RECENT_MS = 600;           // last slice that must be clustered
    const DWELL_DISPERSION_NDC = 0.04;     // max recent distance from centroid
    const DWELL_APPROACH_NDC = 0.06;       // older samples must reach at least this far away
    const DWELL_MIN_RECENT = 10;           // min samples in the recent slice
    const DWELL_MIN_OLDER = 6;             // min samples in the older slice to require approach
    const dwellBuf = useRef<Array<{ x: number; y: number; t: number }>>([]);
    const dwellSettledSince = useRef<number | null>(null);
    const dwellRaycaster = useRef(new Raycaster());
    const dwellVec = useRef(new Vector2());

    const FINGER_SENSITIVITY = 0.55;
    // Hand must be visible this long before we even start checking stillness.
    // Filters out brief flickers (face touches, reaching gestures).
    const FINGER_ACTIVATION_DELAY_MS = 500;
    // Once visible long enough, hand must be stationary (low velocity) this
    // long before the anchor locks. Captures the position the user *settled at*,
    // not the position they were still drifting through.
    const FINGER_STILLNESS_REQUIRED_MS = 250;
    // Per-frame NDC distance under which the pointer counts as "still". Small
    // because the rolling window already smooths frame-to-frame noise; this
    // is targeted at separating "user has stopped moving" from "user is moving".
    const FINGER_STILLNESS_THRESHOLD = 0.008;
    const fingerOrigin = useRef(new Vector2(0, 0));
    const fingerAnchor = useRef(new Vector2(0, 0));
    const fingerLocked = useRef(false);
    const handPresentSince = useRef<number | null>(null);
    const fingerStillSince = useRef<number | null>(null);
    const lastFingerPos = useRef<[number, number] | null>(null);
    const modelCenterTmp = useRef(new Vector2());

    useFrame((state) => {
        const frameNow = Date.now();
        const fingerFresh = frameNow - fingerPointerRef.lastUpdate < 200;
        const handPresent = fingerFresh && fingerPointerRef.pointerNDC !== null;

        if (handPresent) {
            if (handPresentSince.current === null) handPresentSince.current = frameNow;
        } else {
            // Hand gone — reset every piece of activation state so the next
            // appearance has to earn its way through visibility + stillness again.
            handPresentSince.current = null;
            fingerStillSince.current = null;
            fingerLocked.current = false;
            lastFingerPos.current = null;
        }

        const heldLongEnough =
            handPresentSince.current !== null &&
            frameNow - handPresentSince.current >= FINGER_ACTIVATION_DELAY_MS;

        // Stillness detection. Only runs once the visibility delay has passed;
        // we don't want incidental hand-raising frames to count as "settled".
        if (handPresent && heldLongEnough && fingerPointerRef.pointerNDC && !fingerLocked.current) {
            const curr = fingerPointerRef.pointerNDC;
            if (lastFingerPos.current) {
                const speed = Math.hypot(
                    curr[0] - lastFingerPos.current[0],
                    curr[1] - lastFingerPos.current[1],
                );
                if (speed < FINGER_STILLNESS_THRESHOLD) {
                    if (fingerStillSince.current === null) fingerStillSince.current = frameNow;
                    if (frameNow - fingerStillSince.current >= FINGER_STILLNESS_REQUIRED_MS) {
                        // Hand has settled — lock origin to where the user actually is,
                        // and snap the anchor to the model center.
                        fingerOrigin.current.set(curr[0], curr[1]);
                        if (computeModelCenterNDC(scene, camera, modelCenterTmp.current)) {
                            fingerAnchor.current.copy(modelCenterTmp.current);
                        } else {
                            fingerAnchor.current.copy(fingerOrigin.current);
                        }
                        fingerLocked.current = true;
                    }
                } else {
                    // Moved — restart the stillness timer.
                    fingerStillSince.current = null;
                }
            }
            lastFingerPos.current = [curr[0], curr[1]];
        }

        // Laser only engages once the hand is locked (visible + settled).
        const fingerNow = handPresent && fingerLocked.current;
        if (fingerNow !== fingerHeld.current) {
            fingerHeld.current = fingerNow;
            syncRef.current();
        }

        // ───── Mouse hover-dwell detection ─────
        // Disabled by default; an explicit source always wins (don't dwell-
        // engage while the user is mid-drag or holding finger/P).
        const explicitActive = mouseHeld.current || keyHeld.current || fingerHeld.current;
        if (hoverPointingEnabled && !explicitActive) {
            const px = state.pointer.x;
            const py = state.pointer.y;
            const buf = dwellBuf.current;
            buf.push({ x: px, y: py, t: frameNow });
            while (buf.length > 0 && frameNow - buf[0].t > DWELL_BUFFER_MS) buf.shift();

            // Split into recent slice (must be still) and older slice (must show approach).
            const recentCutoff = frameNow - DWELL_RECENT_MS;
            let recentCount = 0;
            let recentCx = 0, recentCy = 0;
            for (const p of buf) {
                if (p.t >= recentCutoff) {
                    recentCx += p.x; recentCy += p.y; recentCount++;
                }
            }

            let settled = false;
            if (recentCount >= DWELL_MIN_RECENT) {
                recentCx /= recentCount; recentCy /= recentCount;

                // Recent stillness: max distance from recent centroid in the recent slice.
                let recentMaxDist = 0;
                for (const p of buf) {
                    if (p.t < recentCutoff) continue;
                    const d = Math.hypot(p.x - recentCx, p.y - recentCy);
                    if (d > recentMaxDist) recentMaxDist = d;
                }

                // Approach: did the cursor come from somewhere noticeably different?
                // We look at the older slice's farthest distance from the recent
                // centroid. If the cursor has been parked here forever the older
                // samples all lie inside the same cluster and this stays small.
                let olderCount = 0;
                let olderFarthest = 0;
                for (const p of buf) {
                    if (p.t >= recentCutoff) continue;
                    olderCount++;
                    const d = Math.hypot(p.x - recentCx, p.y - recentCy);
                    if (d > olderFarthest) olderFarthest = d;
                }

                const recentClustered = recentMaxDist < DWELL_DISPERSION_NDC;
                // If we don't yet have enough older history (cursor just entered
                // the canvas / hover just toggled on), an approach happened
                // implicitly — accept on stillness alone.
                const approached = olderCount < DWELL_MIN_OLDER || olderFarthest > DWELL_APPROACH_NDC;
                settled = recentClustered && approached;
            }

            if (settled) {
                if (dwellSettledSince.current === null) dwellSettledSince.current = frameNow;
            } else {
                dwellSettledSince.current = null;
            }

            // We engage on the same frame settling is detected — the recent
            // window itself is the "hold" period, so no extra wait is needed.
            const dwellLongEnough = dwellSettledSince.current !== null;

            let newDwellHeld = false;
            if (dwellLongEnough) {
                // Confirm the cursor is over a tagged model — we only auto-engage
                // when there's something to point at. Skip remote avatars / lasers.
                dwellVec.current.set(px, py);
                dwellRaycaster.current.setFromCamera(dwellVec.current, camera);
                const hits = dwellRaycaster.current.intersectObjects(scene.children, true);
                for (const hit of hits) {
                    const obj: THREE.Object3D = hit.object;
                    if (
                        obj.userData?.skipRaycast ||
                        obj.name?.startsWith?.('Agent') ||
                        obj.type === 'Line' ||
                        obj.type === 'Points'
                    ) continue;
                    let curr: THREE.Object3D | null = obj;
                    let skip = false;
                    while (curr) {
                        if (curr.userData?.skipRaycast) { skip = true; break; }
                        if (curr.userData?.modelId) { newDwellHeld = true; break; }
                        curr = curr.parent ?? null;
                    }
                    if (skip) continue;
                    if (newDwellHeld) break;
                }
            }

            if (newDwellHeld !== dwellHeld.current) {
                dwellHeld.current = newDwellHeld;
                syncRef.current();
            }
        } else {
            // Hover disabled or explicit source took over — drop any held dwell.
            dwellBuf.current.length = 0;
            dwellSettledSince.current = null;
            if (dwellHeld.current) {
                dwellHeld.current = false;
                syncRef.current();
            }
        }

        if (!isLaserActive) return;

        // Pick the pointer source. Finger source uses anchor + scaled delta.
        let pointerX: number, pointerY: number;
        if (fingerHeld.current && fingerPointerRef.pointerNDC) {
            const dx = fingerPointerRef.pointerNDC[0] - fingerOrigin.current.x;
            const dy = fingerPointerRef.pointerNDC[1] - fingerOrigin.current.y;
            pointerX = fingerAnchor.current.x + dx * FINGER_SENSITIVITY;
            pointerY = fingerAnchor.current.y + dy * FINGER_SENSITIVITY;
            // Clamp so wild swings don't yank the pointer entirely off-screen.
            pointerX = Math.max(-1, Math.min(1, pointerX));
            pointerY = Math.max(-1, Math.min(1, pointerY));
        } else {
            pointerX = state.pointer.x;
            pointerY = state.pointer.y;
        }
        fingerPointerVec.current.set(pointerX, pointerY);
        raycaster.current.setFromCamera(fingerPointerVec.current, camera);

        const intersects = raycaster.current.intersectObjects(scene.children, true);

        let foundId: string | null = null;
        let foundMeshName: string | null = null;
        let foundPartName: string | null = null;
        let hitObject: THREE.Object3D | null = null;
        const hitPoint = new Vector3();

        for (let i = 0; i < intersects.length; i++) {
            const hit = intersects[i];
            const obj: THREE.Object3D = hit.object;
            // Skip non-content (helpers, agent avatars, remote avatars, remote laser dots/beams)
            if (
                obj.userData?.skipRaycast ||
                obj.name?.startsWith?.('Agent') ||
                obj.type === 'Line' ||
                obj.type === 'Points'
            ) continue;

            // Walk up looking for a tagged model — also bail if any ancestor is skipRaycast
            let curr: THREE.Object3D | null = obj;
            let skip = false;
            while (curr) {
                if (curr.userData?.skipRaycast) { skip = true; break; }
                if (curr.userData?.modelId) { foundId = curr.userData.modelId; break; }
                curr = curr.parent ?? null;
            }
            if (skip) { foundId = null; continue; }

            if (foundId) {
                hitObject = obj;
                hitPoint.copy(hit.point);
                foundMeshName = obj.userData?.meshIndex != null
                    ? String(obj.userData.meshIndex)
                    : (obj.name || null);
                foundPartName = obj.userData?.partName ?? null;
                break;
            }
        }

        // Build beam start position (handheld feel — offset right, down, forward from camera)
        const start = new Vector3();
        start.setFromMatrixPosition(camera.matrixWorld);

        const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

        start.add(right.multiplyScalar(0.3));
        start.add(up.multiplyScalar(-0.2));
        start.add(forward.multiplyScalar(0.5));

        let hitSomething = false;

        if (!foundId) {
            hitPoint.copy(raycaster.current.ray.origin).add(raycaster.current.ray.direction.multiplyScalar(20));
            hitSomething = false;
        } else {
            hitSomething = true;
        }

        laserStartPos.current.copy(start);
        laserEndPos.current.copy(hitPoint);

        if (beamMesh.current) {
            const midPoint = new Vector3().addVectors(start, hitPoint).multiplyScalar(0.5);
            beamMesh.current.position.copy(midPoint);
            beamMesh.current.lookAt(hitPoint);
            beamMesh.current.rotateX(Math.PI / 2);

            const dist = start.distanceTo(hitPoint);
            beamMesh.current.scale.set(1, dist, 1);
        }

        if (sparkMesh.current) {
            sparkMesh.current.visible = hitSomething;
            if (hitSomething) {
                sparkMesh.current.position.copy(hitPoint);
                const pulse = 1.0 + 0.25 * Math.sin(state.clock.elapsedTime * 14.0);
                sparkMesh.current.scale.setScalar(pulse);
            }
        }

        if (foundId !== lastHitId.current) {
             const granularity = useStore.getState().laserHighlightGranularity;
             const selectionId = pickSelectionId(hitObject, granularity);
             selectNode(selectionId);
             lastHitId.current = foundId;
        }

        // Local part-name label (imperative DOM update — no re-render)
        if (partLabelRef.current && foundPartName !== lastPartName.current) {
            lastPartName.current = foundPartName;
            partLabelRef.current.textContent = foundPartName ?? '';
            partLabelRef.current.style.display = foundPartName ? 'block' : 'none';
        }

        // Local highlight feedback — mirror our own laser target into the
        // shared maps so model components light up the part we're pointing at
        // without waiting for a network roundtrip.
        setLaserEntry(localUserId, foundId, foundMeshName, foundPartName, userColor);
        pointingSourceRef.current = fingerHeld.current ? 'finger' : dwellHeld.current ? 'hover' : 'laser';

        // Network broadcast at ~10fps
        const now = Date.now();
        if (now - lastLaserBroadcast.current > 100) {
            lastLaserBroadcast.current = now;
            broadcastLaserMove([hitPoint.x, hitPoint.y, hitPoint.z], foundId, foundMeshName, foundPartName);
        }
    });

    if (!isLaserActive) return null;

    return (
        <group>
            <mesh ref={beamMesh} userData={{ skipRaycast: true }}>
                <cylinderGeometry args={[0.005, 0.005, 1, 8]} />
                <meshBasicMaterial color={userColor} transparent opacity={0.6} depthTest={false} />
            </mesh>

            {/* editingHelper: the spark is the dot this person's laser lands on, and
                the lobby's thumbnail leaves the dots out (batch BV,
                lib/scene/captureClean.ts). */}
            <group ref={sparkMesh} userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}>
                <mesh userData={{ skipRaycast: true }}>
                    <sphereGeometry args={[0.03, 8, 8]} />
                    <meshBasicMaterial color={userColor} toneMapped={false} />
                </mesh>
                <pointLight color={userColor} intensity={2} distance={1} />
                {/* Part-name label tracks the spark so the user always knows what they're pointing at */}
                <Html position={[0, 0.08, 0]} center distanceFactor={6} style={{ pointerEvents: 'none' }} zIndexRange={[0, 0]}>
                    <div
                        ref={partLabelRef}
                        style={{
                            background: userColor,
                            color: '#fff',
                            fontFamily: 'monospace',
                            fontSize: '8px',
                            padding: '1px 4px',
                            borderRadius: '3px',
                            whiteSpace: 'nowrap',
                            display: 'none',
                            boxShadow: '0 0 6px rgba(0,0,0,0.5)',
                        }}
                    />
                </Html>
            </group>
        </group>
    );
};

export default UserLaser;
