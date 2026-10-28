// The room's cut plane, drawn — task 08a.
//
// ONE component between the room's shared `viewTools` and three's renderer state. It is
// the only thing in the app that turns `{ axis, position, flip }` into a plane, and the
// only thing that draws the guide rectangle saying where the plane is. Everything that
// actually clips lives in lib/scene/cutPlane.ts; this is the wiring and the picture.
//
// WHY IT IS A COMPONENT AND NOT AN EFFECT ON EACH MODEL. The plane is shared: one
// THREE.Plane instance that every model material holds a reference to, so a room with two
// models on screen cuts both with the same section and moving the slider is one write
// rather than one per model. Something has to own that write, resolve the normalised
// position against the bounds of the models THIS browser can see, and ask for a frame —
// and under `frameloop="demand"` the asking is not optional. That something is mounted
// once, in components/Scene/World.tsx, beside the models it cuts.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   • It does not touch the explode. `viewTools.explode` travels the whole wire from this
//     task and is rendered by task 08b, so that adding the rendering is a renderer change
//     and not a protocol one.
//   • It does not clip the room. `renderer.localClippingEnabled` plus per-material planes,
//     never `renderer.clippingPlanes`: the floor, the grid, the avatars, the lasers, the
//     comment pins and the gizmos all stay whole, because the one thing a section view has
//     to leave alone is the room you are standing in.
//   • It does not re-resolve the plane per frame. Only when the room's value changes or the
//     models it resolves against do, which is what makes dragging the slider cost one plane
//     write and one frame rather than a walk of the scene per frame.

import React, { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  Box3,
  DoubleSide,
  EdgesGeometry,
  PlaneGeometry,
  Vector3,
  type Group,
  type Intersection,
  type Raycaster,
} from 'three';
import { useStore } from '../../store';
import { partRegistries } from '../../lib/scene/partRegistry';
import { reviewModelBounds } from '../../lib/scene/modelBounds';
import {
  applyCut,
  setCutEnabled,
  writeCutPlane,
} from '../../lib/scene/cutPlane';
import { EDITING_HELPER_KEY } from '../../lib/scene/captureClean';
import type { CutPlane } from '../../lib/scene/viewTools';

/**
 * How much bigger than the model's own box the guide rectangle is, per axis.
 *
 * A rectangle exactly the size of the model's silhouette reads as a face of the model
 * rather than as a plane through it, and the point of the guide is to say where the
 * section is when the model is not filling the view. Six percent is enough to see the
 * corner of the plane past the corner of the product and not enough to look like furniture.
 */
const HELPER_PAD = 1.06;

/**
 * A raycast that answers nothing, ever.
 *
 * The guide is not something a ray may land on. `userData.skipRaycast` is this codebase's
 * idiom for that and every pick path in the app honours it through `isPointedThrough` —
 * but components/Scene/XRManager.tsx has its own loop with its own name-and-type test, and
 * a controller's ray that stopped on this rectangle would be a hand that could not reach
 * the model through its own section. Overriding `Object3D.raycast` is three's own answer
 * and is true for every caller without any of them having to agree.
 */
const neverRaycast = (_raycaster: Raycaster, _intersects: Intersection[]): void => {};

/** Scratch, so resolving the plane and placing the guide allocate nothing. */
const scratchSize = new Vector3();
const scratchCentre = new Vector3();

interface ViewToolsCutProps {
  /**
   * The group holding the models and nothing else — World.tsx's own, which wraps the
   * bundled preset and every imported model together.
   *
   * A ref to that group rather than a walk of the scene, and rather than the store's
   * `sceneModelGroups`: the walk would have to know which of the scene's objects are the
   * product, and the store's map holds the imported models only, so a room looking at the
   * bundled synth would have nothing to cut. This is the one object in the graph whose
   * children are exactly the models.
   */
  modelsRef: React.RefObject<Group | null>;
}

/**
 * Resolve the room's cut into renderer state, and draw where it is.
 *
 * Renders the guide rectangle and nothing else.
 */
const ViewToolsCut: React.FC<ViewToolsCutProps> = ({ modelsRef }) => {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);
  const viewTools = useStore((state) => state.viewTools);
  const sceneEntries = useStore((state) => state.sceneEntries);
  const roomScene = useStore((state) => state.scene);
  const localModelVisibility = useStore((state) => state.localModelVisibility);
  const guideRef = useRef<Group>(null);

  /**
   * Local clipping, once, for the life of this canvas.
   *
   * Without `renderer.localClippingEnabled` three ignores `material.clippingPlanes`
   * entirely — `WebGLClipping.setState` resets to the global state before it ever looks at
   * them — so every material write below would be decoration. Restored rather than left on,
   * because a renderer this component did not configure is not one it gets to leave
   * configured; nothing else in the app uses local clipping today, and a second feature
   * that did would be reading a flag it did not set.
   */
  useEffect(() => {
    const before = gl.localClippingEnabled;
    gl.localClippingEnabled = true;
    return () => {
      gl.localClippingEnabled = before;
    };
  }, [gl]);

  /** The guide's outline, built once: four edges of a unit square, scaled per frame. */
  const outlineGeometry = useMemo(() => new EdgesGeometry(new PlaneGeometry(1, 1)), []);
  useEffect(
    () => () => {
      outlineGeometry.dispose();
      // The PlaneGeometry it was built from is not retained by EdgesGeometry, and three
      // does not dispose a source it was only read from — so it goes here, with the thing
      // that was made out of it.
    },
    [outlineGeometry],
  );

  /**
   * The parsed models, memoised because the effect below re-runs on every step of a slider
   * drag and building the map is a walk of the scene list.
   */
  const registries = useMemo(() => partRegistries(sceneEntries), [sceneEntries]);

  /**
   * Resolve the room's value into the shared plane, put the models on it, and place the
   * guide.
   *
   * The order is the contract. `writeCutPlane` first, because it is what decides whether
   * there IS a cut — a room with no visible model answers false for a cut that was asked
   * for, and the plane is parked far away rather than left where the last model put it.
   * `setCutEnabled` second, because `syncCut` reads that flag and every material walked
   * after it has to agree with the plane that was just written. `applyCut` third, and
   * `invalidate` last, so the frame that is asked for is the one that draws all of it.
   *
   * The bounds are measured HERE, in the effect, and not in a render-time memo. `Box3
   * .setFromObject` reads `matrixWorld`, and at render time the model that a scene change
   * just mounted has not been through a frame yet — its world matrix is still the one it
   * had before it existed. A memo would freeze that stale box in as the thing every later
   * position resolves against, and two browsers mounting the same model a frame apart would
   * then cut it in two different places, which is exactly the disagreement this component
   * exists to prevent. Measuring after the commit costs a walk of the scene per step of a
   * drag; the walk is over the models' own objects, which is less work than the raycast the
   * laser does every frame beside it.
   */
  useEffect(() => {
    const bounds = reviewModelBounds(scene, registries);
    const cutting = writeCutPlane(viewTools.cut, bounds);
    setCutEnabled(cutting);
    // The mounted models, and then every parsed model whether it is mounted or not.
    //
    // The second walk is not redundant: a model hidden in the Model Tree is unmounted by
    // components/Scene/ImportedModel.tsx, so its group is not under `modelsRef` any more,
    // and a cut turned OFF while it was hidden would have left its materials holding a
    // plane nobody updates — a model that comes back cut in a room that is not cutting.
    // `syncCut` is idempotent, so walking the mounted ones twice costs a property compare.
    applyCut(modelsRef.current);
    for (const id of Object.keys(sceneEntries)) applyCut(sceneEntries[id]?.group);
    placeGuide(guideRef.current, cutting ? viewTools.cut : null, bounds);
    invalidate();
    // `roomScene` and `localModelVisibility` are in the list even though the effect body
    // never reads them: each moves the box the position resolves against — a model dragged
    // by the gizmo, a model hidden in the tree — without changing the value on the wire, and
    // a cut that stayed where the models used to be would be cutting air.
  }, [viewTools, registries, sceneEntries, roomScene, localModelVisibility, scene, modelsRef, invalidate]);

  /**
   * Take the cut off everything on the way out.
   *
   * Leaving a room, or unmounting this canvas, must not leave a model clipping against a
   * plane that nothing resolves any more: the plane is a module-level constant, so the
   * materials would keep it and the next room would inherit a section nobody asked for.
   * A separate effect from the one above rather than its cleanup, because that one returns
   * nothing and a cleanup that ran on every value change would have taken the cut off and
   * put it back on twice per drag.
   */
  useEffect(
    () => () => {
      setCutEnabled(false);
      applyCut(modelsRef.current);
      invalidate();
    },
    [modelsRef, invalidate],
  );

  const cutting = viewTools.cut !== null;

  return (
    <group
      ref={guideRef}
      visible={false}
      // skipRaycast is this codebase's idiom and `neverRaycast` below is three's; both,
      // because the second is the one that also holds for the pick path that does not use
      // the first. EDITING_HELPER_KEY keeps the guide out of a capture and out of the
      // lobby's thumbnail — a card of the meeting should show the section, not the ruler
      // that says where it is.
      userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}
    >
      <lineSegments
        geometry={outlineGeometry}
        renderOrder={998}
        raycast={neverRaycast}
        userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}
      >
        {/* depthTest off, so the plane is still readable when the model is in front of it
            — which, from most angles, it is. That is the whole job of a guide: to say
            where the section is when the section itself is edge-on and invisible. */}
        <lineBasicMaterial
          color="#f59e0b"
          transparent
          opacity={cutting ? 0.5 : 0}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
      <mesh raycast={neverRaycast} renderOrder={997} userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}>
        <planeGeometry args={[1, 1]} />
        {/* Faint, and depth-TESTED rather than depth-blind: a tint that showed through the
            product would read as a coloured model, and the faint square you can see around
            the silhouette is the one that reads as "a plane is here". DoubleSide because
            the rectangle has to be visible from the cut-away side as well as the kept one. */}
        <meshBasicMaterial
          color="#f59e0b"
          transparent
          opacity={cutting ? 0.05 : 0}
          side={DoubleSide}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};

/**
 * Put the guide rectangle on the plane, or take it down.
 *
 * Written imperatively rather than as props, because this runs on every step of a slider
 * drag and the alternative is a React render per step for four numbers on one group. The
 * rectangle is a unit square in local XY, so an axis is a rotation and an extent is a
 * scale — three composes T·R·S, which is why the scale is the model's OTHER two axes and
 * the position carries the cut axis's own coordinate.
 */
function placeGuide(guide: Group | null, cut: CutPlane | null, bounds: Box3): void {
  if (!guide) return;
  if (!cut || bounds.isEmpty()) {
    guide.visible = false;
    return;
  }
  bounds.getSize(scratchSize);
  bounds.getCenter(scratchCentre);
  const at =
    (cut.axis === 'x' ? bounds.min.x : cut.axis === 'y' ? bounds.min.y : bounds.min.z) +
    (cut.axis === 'x' ? scratchSize.x : cut.axis === 'y' ? scratchSize.y : scratchSize.z) *
      cut.position;
  guide.visible = true;
  if (cut.axis === 'x') {
    guide.rotation.set(0, Math.PI / 2, 0);
    guide.scale.set(scratchSize.z * HELPER_PAD, scratchSize.y * HELPER_PAD, 1);
    guide.position.set(at, scratchCentre.y, scratchCentre.z);
  } else if (cut.axis === 'y') {
    // −90° about X, which takes local +Y to world −Z: the square lies in the XZ plane with
    // its own x across the model's x and its own y across the model's z.
    guide.rotation.set(-Math.PI / 2, 0, 0);
    guide.scale.set(scratchSize.x * HELPER_PAD, scratchSize.z * HELPER_PAD, 1);
    guide.position.set(scratchCentre.x, at, scratchCentre.z);
  } else {
    guide.rotation.set(0, 0, 0);
    guide.scale.set(scratchSize.x * HELPER_PAD, scratchSize.y * HELPER_PAD, 1);
    guide.position.set(scratchCentre.x, scratchCentre.y, at);
  }
}

export default ViewToolsCut;
