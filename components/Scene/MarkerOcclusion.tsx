// The frame loop that decides when the room's markers are owed an occlusion pass — task 09a.
//
// ONE component, mounted once, for every comment bubble and every review pin in the room.
// That is the whole reason it is a component of its own rather than a `useFrame` inside each
// marker: lib/scene/markerOcclusion.ts costs one raycast per marker per pass, and a pass
// asked for by each marker on its own clock would be N passes at N different moments rather
// than one. It is also why the registry it reads is a module and not a context — the bubbles
// live in components/Scene/SpatialComments.tsx, the pins in components/Scene/ReviewArtifacts.tsx,
// and the models' group lives here in World, with no prop path between any of the three.
//
// WHAT IT DECIDES, and nothing else. The geometry question ("is anything the room is drawing
// between the eye and this anchor?") is `isAnchorOccluded` in lib/scene/markerOcclusion.ts
// and has its own test. What is here is the schedule: a pass runs when the camera moved or
// the models did, never more than ten times a second, and not at all in a room nobody is
// touching. Under `frameloop="demand"` that last one is not an optimisation so much as the
// point — an untouched room draws no frames, so a pass nobody asked a frame for is a pass
// that never runs.
//
// The corollary is the `invalidate()` calls below, and both are load-bearing. A flip has to
// ask for a frame because the pin's material is written by React and the bubble's opacity is
// a DOM style: neither is drawn by the frame the pass ran in. And a pass the throttle turned
// away has to ask for the frame that will run it, because a camera that stops on a throttled
// frame stops asking for frames itself, and the markers would stay one pass behind until
// somebody touched the room again.

import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Raycaster, Vector3, type Group } from 'three';
import { useStore } from '../../store';
import { partRegistries } from '../../lib/scene/partRegistry';
import {
  currentMarkerVersion,
  isAnchorOccluded,
  occludedMarkerCount,
  occludedMarkers,
  readOcclusionInputs,
  sameOcclusionInputs,
  shouldRunOcclusionPass,
  type OcclusionInputs,
  type OcclusionProbe,
} from '../../lib/scene/markerOcclusion';

interface MarkerOcclusionProps {
  /**
   * The group holding the models and nothing else — World.tsx's own, and the same ref
   * components/Scene/ViewToolsCut.tsx walks to find the materials it clips.
   *
   * A ref to that group rather than a traversal of the scene, for the reason its own comment
   * gives: it is the one object in the graph whose children are exactly the models, so the
   * floor, the grid, the contact shadows, the avatars, the lasers and the cut's own guide
   * rectangle are not merely filtered out of the answer but never traversed at all.
   */
  modelsRef: React.RefObject<Group | null>;
}

const MarkerOcclusion: React.FC<MarkerOcclusionProps> = ({ modelsRef }) => {
  const sceneEntries = useStore((state) => state.sceneEntries);
  const scene = useStore((state) => state.scene);
  const objectStates = useStore((state) => state.objectStates);
  const localModelVisibility = useStore((state) => state.localModelVisibility);
  const viewTools = useStore((state) => state.viewTools);
  const modelTransform = useStore((state) => state.modelTransform);

  /**
   * The parsed models' registries, which is what turns a raycast hit into a part — and, just
   * as importantly for this pass, what refuses a hit on a part the Model Tree has hidden.
   * Memoised on the entries the way ViewToolsCut memoises it, because the effect below re-runs
   * on every step of a slider drag.
   */
  const registries = useMemo(() => partRegistries(sceneEntries), [sceneEntries]);

  /**
   * "Something the answer depends on moved", as one number.
   *
   * Counted rather than compared because the six fields that move it are four object
   * references, a value object and — in the explode's case — no store field at all: an
   * explode writes the parts' positions straight into their registries
   * (components/Scene/ViewToolsExplode.tsx) and leaves `viewTools.explode` as the only trace.
   * Subscribing to the whole set and bumping a counter is what makes the per-frame question
   * cheap enough to ask on every frame, which is what lib/scene/markerOcclusion.ts's
   * `shouldRunOcclusionPass` needs in order to answer "no" for free.
   *
   * The values are never read: the pass raycasts the live scene graph, which already has
   * every one of them applied.
   */
  const sceneVersion = useRef(0);
  useEffect(() => {
    sceneVersion.current += 1;
  }, [scene, sceneEntries, objectStates, localModelVisibility, viewTools, modelTransform]);

  const raycaster = useRef(new Raycaster());
  const eye = useRef(new Vector3());
  const probe = useRef<OcclusionProbe>({ raycaster: raycaster.current, roots: [], registries: [] });
  const previous = useRef<OcclusionInputs | null>(null);
  const lastPassAt = useRef(Number.NEGATIVE_INFINITY);
  const matricesFreshFor = useRef(-1);

  useFrame((state) => {
    if (occludedMarkerCount() === 0) return;

    const inputs = readOcclusionInputs(state.camera, sceneVersion.current, currentMarkerVersion());
    const nowMs = state.clock.elapsedTime * 1000;
    if (!shouldRunOcclusionPass(previous.current, inputs, nowMs - lastPassAt.current)) {
      // Moved, but inside the throttle's window. Ask for the frame that will run the pass —
      // see the header. A frame that found nothing to do asks for nothing.
      if (!sameOcclusionInputs(previous.current, inputs)) state.invalidate();
      return;
    }
    previous.current = inputs;
    lastPassAt.current = nowMs;

    const models = modelsRef.current;
    if (models === null) return;
    // One array per pass rather than one per frame: a pass runs at most ten times a second,
    // and the alternative is a slot in a ref holding a group that World may not have
    // committed yet.
    probe.current.roots = [models];
    probe.current.registries = registries;

    // The models' world matrices, but only when the MODELS moved. The renderer writes them
    // every frame it draws, so a pass whose only change was the camera is reading matrices
    // that are already current; a pass triggered by a mount, a drag, a visibility click or an
    // explode step is not, because the write that moved them happened after the last frame.
    // Forced rather than left to the renderer for the reason components/Scene/ViewToolsCut.tsx
    // gives for measuring bounds in an effect: an object that has not been through a frame
    // since it changed is still carrying the transform it had before.
    if (matricesFreshFor.current !== inputs.sceneVersion) {
      models.updateMatrixWorld(true);
      matricesFreshFor.current = inputs.sceneVersion;
    }

    state.camera.getWorldPosition(eye.current);
    let flipped = false;
    for (const { marker } of occludedMarkers()) {
      const anchor = marker.anchor;
      if (anchor === null) continue;
      const occluded = isAnchorOccluded(anchor, eye.current, probe.current, marker.attachedTo);
      if (occluded === marker.occluded) continue;
      marker.occluded = occluded;
      marker.onOccluded(occluded);
      flipped = true;
    }
    // Asked for only when an answer moved, which is the ordinary frame's whole saving: a pass
    // that confirmed what it already knew draws nothing new and owes the room no frame.
    if (flipped) state.invalidate();
  });

  return null;
};

export default MarkerOcclusion;
