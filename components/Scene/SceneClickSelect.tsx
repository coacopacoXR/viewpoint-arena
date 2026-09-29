// Clicking a part in the 3D view — batch BT.
//
// "it is not possible to click on the 3d models parts directly, you need to click them
// on the tree." The selection this writes is the one that already existed — `selectNode`,
// which the Model Tree's rows and the laser both call — so the tree scrolls to the row,
// highlights it, and the amber strip's Part mode attaches its gizmo to what was clicked.
// Nothing here is a second selection to keep in step with the first.
//
// WHY A POINTER LISTENER AND NOT R3F's onClick. The models are mounted with
// `<primitive object={entry.group} />`, and R3F's event system only raycasts objects
// that were given a handler in JSX — a primitive's geometry has none, and threading
// handlers through a parsed CAD assembly of forty thousand meshes is not a thing to do.
// So this listens on the canvas the way components/Scene/UserLaser.tsx raycasts from
// the shared maps: one listener, one raycaster, the store read at event time.
//
// WHY ONLY IN EDIT MODE. Outside it, a click belongs to whatever it always belonged to
// — the laser's own picking, the pin drop that is waiting for a surface, the camera
// drag — and this component returns before it has read anything. Edit mode is one
// person's, and while they have it the click means "this is what I am about to move".
//
// WHY THE DISTANCE TEST. Every press on this canvas is also the start of a camera orbit,
// and OrbitControls takes it from the same element. Without a threshold, orbiting the
// camera would end by selecting whatever the pointer happened to be over when it was
// released. lib/scene/clickSelection.isClick is that threshold, and it is a pure
// function with its own test.

import React, { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { clickedNodeId, isClick, type ScreenPoint } from '../../lib/scene/clickSelection';
import { sceneModelForNode } from '../../lib/scene/roomScene';

const SceneClickSelect: React.FC<{
  /**
   * Whether the amber strip's gizmo has hold of this pointer.
   *
   * Set by components/Scene/ReviewModelGizmo.tsx in the mouseDown drei's
   * TransformControls hands it, which fires only when the press landed on one of its
   * handles. Three-stdlib's controls register their own pointerdown on this canvas
   * when they are constructed — during a render, so always before this effect runs —
   * which is what makes reading the flag here safe rather than a race: by the time
   * this handler looks, a press on a handle has already said so.
   *
   * Without it, pressing a handle would fall through to "nothing tagged here" and
   * CLEAR the selection, detaching the gizmo from the very part the person is dragging.
   */
  draggingRef: React.MutableRefObject<boolean>;
}> = ({ draggingRef }) => {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  const { localUserId } = usePresence();

  const raycaster = useRef(new THREE.Raycaster());
  const ndc = useRef(new THREE.Vector2());
  const down = useRef<ScreenPoint>({ x: 0, y: 0 });
  // Set on a press that this component may act on and cleared by the release that
  // answers it, so a press outside Edit mode that is released inside one does nothing.
  const armed = useRef(false);

  useEffect(() => {
    const element = gl.domElement;

    const onPointerDown = (event: PointerEvent) => {
      armed.current = false;
      // Left button only: the right is the context menu, the middle is a pan, and both
      // together is the laser's own activation (components/Scene/UserLaser.tsx).
      if (event.button !== 0) return;
      const { reviewEditing, commentMode, drawingInteractionActive } = useStore.getState();
      if (!reviewEditing || reviewEditing.userId !== localUserId) return;
      // A click that is already spoken for. Placing a pin and placing a comment are both
      // "click something in the 3D view", and they are part of the SAME edit session as
      // this — the pins tab is in the panel the strip swaps in — so a press that is
      // dropping a pin must not also move the selection and the gizmo with it. The
      // drawing overlay is the same story: its click belongs to the marker.
      if (commentMode !== 'none' || drawingInteractionActive) return;
      if (draggingRef.current) return;
      armed.current = true;
      down.current = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!armed.current) return;
      armed.current = false;
      if (event.button !== 0) return;
      if (!isClick(down.current, { x: event.clientX, y: event.clientY })) return;

      const state = useStore.getState();
      const { reviewEditing } = state;
      // Re-checked rather than trusted from the press: the edit lock can be taken away
      // in between, and a click that lands afterwards belongs to the meeting again.
      if (!reviewEditing || reviewEditing.userId !== localUserId) return;

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // The canvas is styled in CSS pixels and R3F's own events are read with
      // eventPrefix "client", so clientX/clientY against the element's own box is the
      // same measurement the renderer's pointer would be.
      ndc.current.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.current.setFromCamera(ndc.current, camera);
      scene.updateMatrixWorld();
      const hits = raycaster.current.intersectObjects(scene.children, true);

      // The first hit that resolves, not the first hit: this scene holds invisible
      // things that are in front of the model — the mouse-tracking plane in World.tsx,
      // the gizmo's own picker meshes — and a ray that stopped at the first of those
      // would clear the selection every time somebody clicked a part.
      let nodeId: string | null = null;
      for (const hit of hits) {
        nodeId = clickedNodeId(hit.object, {
          target: state.reviewGizmoTarget,
          models: state.scene.models,
          rootIdOf: (modelId) => state.sceneEntries[modelId]?.sceneTree.id ?? null,
          lists: (id) => Boolean(state.objectStates[id]),
        });
        if (nodeId !== null) break;
      }

      state.selectNode(nodeId);
      // Whole model mode selects the model the way the tree's model row does, which is
      // two writes and not one: the row also makes this the model the scale slider and
      // the strip's Reset buttons refer to. Part mode leaves that alone on purpose —
      // pointing at one bolt of a product is not a decision about which product the
      // meeting is looking at.
      if (nodeId !== null && state.reviewGizmoTarget === 'model') {
        const model = sceneModelForNode(state.scene.models, nodeId);
        if (model) state.setActiveSceneModel(model.id);
      }
    };

    const onPointerCancel = () => {
      armed.current = false;
    };

    element.addEventListener('pointerdown', onPointerDown);
    // On the window, not on the canvas: a press that starts on the model and is
    // released outside it (over the side panel, over the strip) is a camera drag, and
    // leaving it armed would let the NEXT release anywhere count as its answer.
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [gl, camera, scene, localUserId, draggingRef]);

  return null;
};

export default SceneClickSelect;
