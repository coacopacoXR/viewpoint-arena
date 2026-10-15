import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { AdaptiveDpr } from '@react-three/drei';
import { Vector3, type PerspectiveCamera } from 'three';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { remoteXRParticipants } from '../../lib/xrPresenceRef';
import { partRegistries } from '../../lib/scene/partRegistry';

/**
 * Cheaper frames while the camera moves, and no frames at all when nothing does.
 *
 * The review canvas renders on demand (ViewpointCanvas passes `frameloop="demand"`), which
 * turns "how fast is this scene" into two separate questions: how much does a frame cost when
 * one is needed, and how often is one needed when nothing is happening. This file answers the
 * second and asks the first of drei. Three things live here, and they are in one file because
 * they are one decision — what the renderer is allowed to spend while the person is moving:
 *
 *   • `MotionQuality` watches the camera. While it moves, R3F's own performance regression
 *     drops the pixel ratio (drei's `<AdaptiveDpr>` puts it back `MOTION_SETTLE_MS` after the
 *     last movement) and the parts too small to see stop being drawn.
 *   • `StoreDrivenFrames` asks for a frame when something the picture depends on changes.
 *   • `PresenceDrivenFrames` asks for one when somebody else in the room moves.
 *
 * WHAT IS DELIBERATELY NOT HERE: any change to what a part IS. The motion cull is a
 * render-only flag inside the registries (lib/scene/partRegistry.ts `motionCull`), composed
 * with the tree's visibility rather than written through it, so a camera that settles gives
 * back exactly the parts it took and never one somebody had hidden.
 */

/**
 * How small a part has to project before it stops being drawn while the camera moves, in CSS
 * pixels of projected bounding-sphere radius.
 *
 * 2, which is the task's default and about the smallest thing a person can see move on a
 * review: at the room's fixed camera a 3 200-part assembly is ~117 px tall on a 900 px
 * viewport, so its fasteners are already a handful of pixels across and the ones under this
 * are specks. Raising it buys more frame time and starts to visibly simplify the model;
 * lowering it towards 1 buys almost nothing, because a part one pixel across still costs a
 * draw and a depth write.
 */
export const MOTION_CULL_PIXELS = 2;

/**
 * How long the camera has to be still before it counts as settled.
 *
 * One constant for both halves of the settle on purpose: R3F's `performance.debounce` is what
 * puts the pixel ratio back, and this is what gives the culled parts back. Two numbers would be
 * two moments, and a frame drawn between them is a full-resolution picture of a model with
 * holes in it.
 */
export const MOTION_SETTLE_MS = 200;

/**
 * The pixel ratio a moving camera draws at, as a fraction of the canvas's own.
 *
 * Handed to `<Canvas performance={{ min: … }}>` rather than used here, because drei's
 * `<AdaptiveDpr>` is what reads it: it multiplies the canvas's initial ratio by R3F's
 * `performance.current`, which regresses to this floor and debounces back to 1. Halving the
 * ratio is a quarter of the pixels, which on a fill-rate-bound frame is the single largest win
 * available while moving — and it is also the one a person notices least, because the frame
 * they are looking at is the one that is already blurred by motion.
 */
export const MOTION_DPR_MIN = 0.5;

/**
 * How far the camera has to move in one frame to count as moving, in scene units and in
 * quaternion components.
 *
 * Not zero, and the reason is damping: OrbitControls keeps nudging the camera by amounts that
 * round to nothing on screen long after a drag has ended, and a detector with no epsilon would
 * keep asking for frames — and keep regressing the pixel ratio — for as long as the tail of the
 * easing was above the noise floor. 1e-4 units is ~0.006 px at the room's camera distance and
 * 1e-5 of a quaternion component is ~0.001°, so both are comfortably under anything visible and
 * comfortably over anything floating point drifts by.
 */
const POSITION_EPSILON = 1e-4;
const ROTATION_EPSILON = 1e-5;

/**
 * How often the presence refs are looked at, in ms.
 *
 * The rate presence ARRIVES at: PresenceBroadcaster sends every 100 ms and so does every other
 * client, so polling faster than that can only find the same numbers twice.
 */
const PRESENCE_POLL_MS = 100;

/**
 * Whether an XR session is presenting right now.
 *
 * `gl.xr.isPresenting` is not reactive, and everything here has to stop in a headset: the frame
 * loop is the session's own (`gl.xr.setAnimationLoop` in R3F's Canvas, which advances every
 * frame whatever `frameloop` says), so there is nothing to save by demanding fewer of them —
 * and there is a great deal to lose, because a dropped pixel ratio inside a headset is the one
 * place the number is physically visible as screen door.
 *
 * Listened to rather than polled, on the same two events R3F's own Canvas uses to switch the
 * render loop over.
 */
function useXRPresenting(): boolean {
  const gl = useThree((state) => state.gl);
  const [presenting, setPresenting] = useState(() => gl.xr?.isPresenting ?? false);

  useEffect(() => {
    const xr = gl.xr;
    if (!xr) return;
    const onChange = () => setPresenting(xr.isPresenting);
    // Read once on the way in as well: a session that started before this mounted is still one.
    onChange();
    xr.addEventListener('sessionstart', onChange);
    xr.addEventListener('sessionend', onChange);
    return () => {
      xr.removeEventListener('sessionstart', onChange);
      xr.removeEventListener('sessionend', onChange);
    };
  }, [gl]);

  return presenting;
}

/** The mutable half of `MotionCullView`: one object, reused for every frame of every model. */
interface CullView {
  eye: Vector3;
  k: number;
}

/**
 * The camera's pose as the last frame saw it, as seven numbers.
 *
 * Numbers and not a copy of the Vector3 and the Quaternion, because a comparison that runs every
 * frame of every movement should not be the thing that allocates in it.
 */
interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** False until one frame has been seen, which is the frame that has nothing to compare to. */
  sampled: boolean;
}

const savePose = (
  pose: Pose,
  position: { x: number; y: number; z: number },
  quaternion: { x: number; y: number; z: number; w: number },
): void => {
  pose.x = position.x;
  pose.y = position.y;
  pose.z = position.z;
  pose.qx = quaternion.x;
  pose.qy = quaternion.y;
  pose.qz = quaternion.z;
  pose.qw = quaternion.w;
};

/**
 * Watch the camera, and while it moves spend less on the frame.
 *
 * Renders nothing. Mounted inside the review canvas beside the other systems.
 */
const MotionQuality: React.FC = () => {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const performance = useThree((state) => state.performance);
  const invalidate = useThree((state) => state.invalidate);
  const sceneEntries = useStore((state) => state.sceneEntries);
  const presenting = useXRPresenting();

  /**
   * The registries of the models in the room, recomputed when the room's models change and
   * never per frame: `partRegistries` builds an array, and a frame that allocated one would be
   * paying the garbage collector for a list that only a new import can change.
   */
  const registries = useMemo(() => partRegistries(sceneEntries), [sceneEntries]);

  // Read through a ref by the settle timer and the unmount cleanup, both of which fire long
  // after the render that armed them and neither of which should see the models that were in
  // the room then. Same reason ThumbnailCapture keeps a `latest`.
  const registriesRef = useRef(registries);
  registriesRef.current = registries;
  const presentingRef = useRef(presenting);
  presentingRef.current = presenting;

  const view = useRef<CullView | null>(null);
  if (!view.current) view.current = { eye: new Vector3(), k: 0 };

  /** The camera's pose as the last frame saw it, and whether it has been seen at all. */
  const pose = useRef<Pose>({ x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, sampled: false });
  const moving = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Give every culled part back, which is the whole of what settling means. */
  const restore = useCallback(() => {
    for (const registry of registriesRef.current) registry.motionCull(null);
  }, []);

  const settle = useCallback(() => {
    settleTimer.current = null;
    moving.current = false;
    restore();
    // One frame for the picture that has its parts back. The pixel ratio restores itself:
    // R3F's debounce writes `performance.current`, the root store subscribes to its own writes
    // with an invalidate, and drei's <AdaptiveDpr> is listening for exactly that.
    invalidate();
  }, [invalidate, restore]);

  // Stop cleanly, in both directions: leaving the room must not leave a model with parts hidden,
  // and putting a headset on must not either.
  useEffect(() => {
    if (!presenting) return;
    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    moving.current = false;
    restore();
    // And the pose it was comparing against is the one a headset left behind, which the flat
    // camera on the way out has nothing to do with. Forget it, so the first frame back on the
    // desktop establishes a baseline rather than reporting a jump that was really a change of
    // camera — a jump that would drop the resolution for 200 ms on the way out of a session.
    pose.current.sampled = false;
  }, [presenting, restore]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      restore();
    },
    [restore],
  );

  // Priority 0: after drei's OrbitControls (-1), which is what moves the camera on a drag, and
  // before SceneRenderer (1), which is what draws it — so the parts this frame hides are hidden
  // in the picture this frame renders rather than in the next one.
  useFrame(() => {
    if (presentingRef.current) return;

    const last = pose.current;
    const { position, quaternion } = camera;
    // The first frame has nothing to compare against, so it establishes the pose and says
    // nothing about it. Claiming motion there would regress the pixel ratio and hide parts on
    // the frame the room first appears, which is the one frame everybody is looking at.
    if (!last.sampled) {
      last.sampled = true;
      savePose(last, position, quaternion);
      return;
    }
    const moved =
      Math.abs(position.x - last.x) > POSITION_EPSILON ||
      Math.abs(position.y - last.y) > POSITION_EPSILON ||
      Math.abs(position.z - last.z) > POSITION_EPSILON ||
      Math.abs(quaternion.x - last.qx) > ROTATION_EPSILON ||
      Math.abs(quaternion.y - last.qy) > ROTATION_EPSILON ||
      Math.abs(quaternion.z - last.qz) > ROTATION_EPSILON ||
      Math.abs(quaternion.w - last.qw) > ROTATION_EPSILON;
    savePose(last, position, quaternion);

    if (!moved) {
      // Still. Under demand mode nothing will ask for another frame, so the settle is a timer
      // and not a frame count: the culled parts have to come back and the restored resolution
      // has to be drawn, and neither happens if this callback never runs again.
      if (moving.current && settleTimer.current === null) {
        settleTimer.current = setTimeout(settle, MOTION_SETTLE_MS);
      }
      return;
    }

    if (settleTimer.current !== null) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    moving.current = true;

    // Both halves of "cheaper while moving", and the second is why this is called every frame
    // of a movement rather than once at its start: R3F's regress restores itself `debounce` ms
    // after the LAST call, so calling it per frame is what holds the low ratio for the length of
    // the movement and releases it MOTION_SETTLE_MS after the movement ends.
    performance.regress();

    const perspective = camera as PerspectiveCamera;
    const state = view.current!;
    // k folds the pixel threshold, the fov and the viewport height into the one scalar the
    // registries test against — see MotionCullView. CSS pixels, so the answer does not move
    // when the pixel ratio does, and no feedback loop between the two halves of this frame.
    if (perspective.isPerspectiveCamera && size.height > 0) {
      state.eye.copy(position);
      state.k =
        (MOTION_CULL_PIXELS * 2 * Math.tan((perspective.fov * Math.PI) / 360)) / size.height;
      for (const registry of registriesRef.current) registry.motionCull(state);
    }

    // Another frame, so the movement keeps being watched until it stops.
    invalidate();
  });

  // drei's, and the only thing this component renders: it reads `performance.current` and writes
  // the pixel ratio, and restores the canvas's own on unmount. Not mounted in a headset, which
  // both keeps the resolution up there and puts it back on the way in.
  return presenting ? null : <AdaptiveDpr />;
};

/**
 * Ask for a frame when the store says something the picture depends on has changed.
 *
 * Under `frameloop="demand"` a React re-render that writes an R3F object's props asks for a
 * frame by itself (R3F invalidates on every instance it commits), and so does an OrbitControls
 * change, a gizmo drag and every pump below. What is left over is everything that reaches the
 * scene WITHOUT going through a prop: a part transform applied through a registry handle, a
 * visibility or selection written by `syncStates`, a model swapped for its derived GLB, a
 * variant adopted, a gizmo re-parked on a part somebody else moved. Those are all store writes,
 * so the store is the one place to watch.
 *
 * ONE EXCEPTION, and it is the whole reason this is not `useStore.subscribe(invalidate)`: `time`
 * is written ten times a second by components/Scene/World.tsx from inside its own useFrame. A
 * frame that writes the clock would then ask for the next frame, which would write the clock
 * again, and an idle room would settle at ten frames a second forever instead of at zero — the
 * exact number this task exists to remove. Nothing draws `time`; it is a number four UI
 * components read.
 */
export const StoreDrivenFrames: React.FC = () => {
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    // Snapshotted once rather than `Object.keys(state)` per write: the store's shape is fixed by
    // its initializer and `set` merges into it, so the key list this saw at mount is the key list
    // for the life of the room, and a store write is not the moment to allocate an array.
    const keys = Object.keys(useStore.getState()).filter((key) => key !== 'time');
    return useStore.subscribe((state, previous) => {
      const current = state as unknown as Record<string, unknown>;
      const before = previous as unknown as Record<string, unknown>;
      for (const key of keys) {
        if (current[key] !== before[key]) {
          invalidate();
          return;
        }
      }
    });
  }, [invalidate]);

  return null;
};

/** Round to a millimetre, so a float that jitters in its last digits is not a movement. */
const near = (value: number): number => Math.round(value * 1000);

/**
 * Ask for a frame when somebody else in the room moves.
 *
 * Remote presence never reaches React: it lands in refs and module maps that the avatars, the
 * lasers and the headsets read from inside their own useFrame, so that sixty updates a second
 * cost no re-render at all. That is the right trade — and under demand mode it is a hole, since
 * a ref nobody renders from cannot ask for a frame. An arrival would sit unnoticed until the
 * local person happened to move the mouse, and a colleague walking around a model would appear
 * to be standing still.
 *
 * So: look at the refs ten times a second, which is the rate the data arrives at, and ask for
 * ONE frame when something in them actually moved. Compared rather than assumed, because the
 * alternative — invalidate whenever anybody else is in the room — is ten frames a second of a
 * scene in which everyone is standing still, and "no frames when nothing moves" is the point.
 *
 * A poll and not a hook into the socket because the socket's message handler lives in
 * lib/usePartyPresence.ts, which this task does not own; the signature below is what that hook
 * would have called, and it is written so that swapping it in later is a one-line change there.
 */
export const PresenceDrivenFrames: React.FC = () => {
  const { remoteParticipants, remoteLasers } = usePresence();
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    let last = '';
    const signature = (): string => {
      let out = '';
      for (const [userId, participant] of remoteParticipants.current) {
        const [px, py, pz] = participant.position;
        const [lx, ly, lz] = participant.lookAt;
        out += `${userId}:${near(px)},${near(py)},${near(pz)},${near(lx)},${near(ly)},${near(lz)};`;
      }
      for (const [userId, laser] of remoteLasers.current) {
        const position = laser.position;
        out += position
          ? `L${userId}:${near(position[0])},${near(position[1])},${near(position[2])},${laser.partName ?? ''};`
          : `L${userId}:off;`;
      }
      for (const [userId, xr] of remoteXRParticipants) {
        const [hx, hy, hz] = xr.head.position;
        out += `X${userId}:${near(hx)},${near(hy)},${near(hz)};`;
      }
      return out;
    };

    const id = setInterval(() => {
      const now = signature();
      if (now === last) return;
      last = now;
      invalidate();
    }, PRESENCE_POLL_MS);
    return () => clearInterval(id);
  }, [remoteParticipants, remoteLasers, invalidate]);

  return null;
};

export default MotionQuality;
