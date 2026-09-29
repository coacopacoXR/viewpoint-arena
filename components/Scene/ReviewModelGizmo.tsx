// The room's transform gizmo: Move / Rotate / Scale, applied to the SELECTED
// scene model — or, since batch BR, to one PART of it.
//
// docs/plan/14-rooms-models-admin-ai.md batch BH. The amber strip owns the three
// buttons and writes `reviewGizmoMode`; this is the thing those buttons actually
// turn on, and it lives inside the canvas because drei's TransformControls has to
// be an R3F child of the scene it manipulates. The old curate page had the same
// arrangement (components/Scene/ReviewSetupCanvas.tsx) against a single loaded
// model; this one works against the room's scene, where there can be eight.
//
// What it writes depends on the strip's other switch, `reviewGizmoTarget`:
//
//   Whole model — the model's OWN transform, SceneModel.offset/.rotation/.scale,
//     sent as one `setTransform`. Unchanged since batch BH.
//   Part — one node's transform, in that node's own local space, sent as one
//     `setPartTransform` keyed by the node id the Model Tree shows. The node is the
//     one the laser or the tree has SELECTED; there is no second selection.
//
// Both go to the room server as one operation, so it applies the change to its single
// copy and relays the result to everybody. That is the difference between "I moved
// the model" and "the model moved": a drag here is a change to the meeting, not to
// this browser.
//
// Batch BI added a second copy of the answer, written when the drag ENDS: the
// review keeps every model's placement — and, since BR, every moved part — because
// the room server's storage is the room's and a review is opened again long after
// that room is gone. See lib/scene/keepPlacements.ts.

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { selectedNodeId, useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { keepReviewPlacements } from '../../lib/scene/keepPlacements';
import { markEditingHelper } from '../../lib/scene/captureClean';
import {
  findPartNode,
  partTargetFor,
  partTransformFromObject,
  rememberOriginalLocalTransform,
  usablePartScale,
} from '../../lib/scene/partTransforms';
import { sceneModelLabel, sceneModelTransform, type SceneModel, type SceneUpdate } from '../../lib/scene/roomScene';
import { useSceneEditHistory } from '../../lib/scene/useSceneEditHistory';

/** How often a drag may put a message on the socket. See flush. */
const SEND_INTERVAL_MS = 100;

/**
 * The part of drei's OrbitControls this component touches.
 *
 * Named rather than imported: the canvas holds its controls ref loosely, and all
 * the gizmo needs from it is the one flag that stops the camera orbiting
 * underneath a model somebody is moving.
 */
interface OrbitLike {
  enabled: boolean;
}

const ReviewModelGizmo: React.FC<{
  controlsRef: React.MutableRefObject<OrbitLike | null>;
  /**
   * Written while a handle has hold of the pointer, read by the click that selects a
   * part. Optional so a canvas that mounts no SceneClickSelect — the two review-setup
   * tests, and any future canvas that wants the gizmo without the click — has nothing
   * to hand over. See components/Scene/SceneClickSelect.tsx for why it has to be known
   * at the instant a press lands rather than at the moment it is released.
   */
  draggingRef?: React.MutableRefObject<boolean>;
}> = ({ controlsRef, draggingRef }) => {
  const mode = useStore((state) => state.reviewGizmoMode);
  const editing = useStore((state) => state.reviewEditing);
  const gizmoTarget = useStore((state) => state.reviewGizmoTarget);
  const activeSceneModelId = useStore((state) => state.activeSceneModelId);
  const groups = useStore((state) => state.sceneModelGroups);
  const models = useStore((state) => state.scene.models);
  const entries = useStore((state) => state.sceneEntries);
  const selection = useStore((state) => selectedNodeId(state.objectStates));
  const { localUserId, broadcastSceneUpdate, broadcastReviewConfig } = usePresence();

  /**
   * What Part mode is pointing at, or null in Whole model mode.
   *
   * The same resolution the strip does, from the same selection, so the strip and
   * the gizmo cannot disagree about what is about to move. A `nodeId` of null means
   * the selection is a model's own root, which the batch brief says behaves like
   * Whole model — so the wrapper group it falls through to below is the answer, not
   * a special case.
   */
  const partTarget = useMemo(
    () => (gizmoTarget === 'part'
      ? partTargetFor(models, (modelId) => entries[modelId]?.sceneTree.id ?? null, selection)
      : null),
    [gizmoTarget, models, entries, selection],
  );

  // Which model the drag will be written against: the one the tree has active in
  // Whole model mode, the one the selected part belongs to in Part mode. The two are
  // not the same thing — pointing at a part in the 3D view selects it without
  // changing which model the scale slider refers to.
  const modelId = gizmoTarget === 'part' ? partTarget?.modelId ?? null : activeSceneModelId;
  const wrapper = modelId ? groups[modelId] : undefined;

  /**
   * The node itself, found in the model's parsed group.
   *
   * A walk rather than a lookup because the parsed group is the only index of the
   * objects there is; see findPartNode. Memoised on the wrapper and the target so a
   * drag that changes nothing about either does not re-walk a 400-part assembly on
   * every socket echo.
   */
  const partObject = useMemo(() => {
    const nodeId = partTarget?.nodeId;
    if (!wrapper || !nodeId) return null;
    return findPartNode(wrapper, nodeId);
  }, [wrapper, partTarget]);

  /**
   * The object the gizmo is attached to, or undefined for "there is nothing to move".
   *
   * A part id that resolves to no object — a model still downloading, a node id from
   * a file that has since been replaced — gives NO gizmo rather than quietly falling
   * back to the whole model. Moving a product when somebody meant to move one bolt
   * of it is the kind of mistake that is expensive to notice.
   */
  let object: THREE.Object3D | undefined = wrapper;
  if (partTarget && partTarget.nodeId !== null) object = partObject ?? undefined;

  // The gizmo is a tool of edit mode, and edit mode belongs to one person. A
  // participant who is watching somebody else edit sees the model move; they do
  // not get handles on it.
  const mine = editing !== null && editing.userId === localUserId;

  // When the last transform of this drag went on the wire, and the one waiting to
  // go if it was throttled. Throttled rather than per frame: onObjectChange fires
  // on every pointer move, and each one would be a socket message the room server
  // applies, persists and relays as a whole SCENE_STATE to every connection. Ten
  // a second is smooth enough to watch a colleague's drag and a fraction of the
  // traffic.
  const lastSentAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback(() => {
    if (!modelId) return;
    const nodeId = partTarget?.nodeId;

    if (nodeId && partObject) {
      // The file's own transform, remembered BEFORE anything else touches this node
      // — which on a drag has already happened at pointer-down, so this is a read.
      // An override REPLACES it rather than adding to it, so the value sent is the
      // node's local transform as it now stands and applying it twice is a no-op.
      const original = rememberOriginalLocalTransform(partObject);
      const local = partTransformFromObject(partObject);
      const update: SceneUpdate = {
        op: 'setPartTransform',
        id: modelId,
        nodeId,
        transform: {
          position: local.position ?? original.position,
          rotation: local.rotation ?? original.rotation,
          // Non-uniform, unlike the model's own scale: a part is inside the model's
          // bounding box, so nothing else in the scene has to read this back as one
          // number. A drag through zero is clamped to the file's own value on that
          // axis rather than sent, because the wire refuses a part scaled to nothing
          // and a refused drag would leave this browser showing what the room is not.
          scale: usablePartScale(local.scale ?? original.scale, original.scale),
        },
      };
      lastSentAt.current = Date.now();
      broadcastSceneUpdate(update);
      useStore.getState().applyLocalSceneUpdate(update);
      return;
    }

    if (!wrapper) return;
    const model = useStore.getState().scene.models.find((m) => m.id === modelId);
    if (!model) return;
    const current = sceneModelTransform(model);
    const update: SceneUpdate = {
      op: 'setTransform',
      id: modelId,
      transform: {
        offset: [wrapper.position.x, wrapper.position.y, wrapper.position.z],
        rotation: [wrapper.rotation.x, wrapper.rotation.y, wrapper.rotation.z],
        // Uniform, as everywhere else in the app: drei's scale gizmo drags one
        // axis at a time, and a model scaled 2× on X and 1× on Y is not something
        // the rest of the scene — the bounding box, the label height, placement —
        // knows how to read. Averaging the three keeps a non-uniform drag from
        // being thrown away while still landing on one number.
        scale: (wrapper.scale.x + wrapper.scale.y + wrapper.scale.z) / 3 || current.scale,
      },
    };
    lastSentAt.current = Date.now();
    // Sent first, then applied locally — the order SceneTree's import uses. The
    // server relays the resulting scene back to this client too, so the local
    // step is a prediction the echo confirms; it is still needed outside a room.
    broadcastSceneUpdate(update);
    useStore.getState().applyLocalSceneUpdate(update);
  }, [modelId, partObject, partTarget, wrapper, broadcastSceneUpdate]);

  const flush = useCallback(() => {
    const wait = SEND_INTERVAL_MS - (Date.now() - lastSentAt.current);
    if (wait <= 0) {
      send();
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      send();
    }, wait);
  }, [send]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    // Unmounted mid-drag — Done pressed, or the tool switched off under a hand still on
    // a handle. Left true, this would tell SceneClickSelect that every subsequent press
    // belongs to a gizmo that is no longer there, and clicking a part would stop working
    // for the rest of the meeting.
    if (draggingRef) draggingRef.current = false;
  }, [draggingRef]);

  /**
   * Remember where the drag ended with the REVIEW as well as with the room.
   *
   * `send` puts the transform in the scene, which the room server persists — and
   * room storage is the room's, so a review opened next month, from the lobby, on
   * an install whose server hibernated, gets its models back standing the way they
   * arrived rather than the way they were left (batch BI), and its parts back where
   * their file had them rather than where the meeting left them (batch BR).
   *
   * Once per drag and not per frame: onObjectChange fires on every pointer move,
   * and each of these is a whole review broadcast to everybody in the room and a
   * row written a second later. By drag end `send` has already applied the final
   * transform locally, so the scene this reads is the scene the person is looking
   * at. Null back from the store means there was nothing to remember — no review
   * open, or every model and every part ended where it started — and then nothing
   * is broadcast.
   */
  const keepPlacements = useCallback(() => {
    keepReviewPlacements(broadcastReviewConfig);
  }, [broadcastReviewConfig]);

  const { snapshot, recordFrom } = useSceneEditHistory();

  /**
   * The record this drag started from, taken at pointer-down.
   *
   * Not at pointer-up, and not by asking the history to read the scene when it records:
   * a drag puts a throttled operation on the wire every hundred milliseconds and applies
   * each one here, so by the time the pointer comes up the scene already says where the
   * drag ended. An "after" measured against that is a step from nowhere to nowhere, and
   * Ctrl+Z would put the model where the first frame of the drag left it.
   */
  const dragBefore = useRef<SceneModel[]>([]);

  /**
   * What this drag will be called in the history.
   *
   * Named after the tool and the subject rather than left as "Moved": Ctrl+Z four times
   * in a row is four notices, and "Undone." four times tells a person nothing about
   * whether the one they wanted is next. The part is described rather than named because
   * the gizmo has the object and not the tree's row for it, and the strip already shows
   * the name of whatever the tools are attached to.
   */
  const dragLabel = useMemo(() => {
    const verb = mode === 'rotate' ? 'Turned' : mode === 'scale' ? 'Resized' : 'Moved';
    const model = models.find((one) => one.id === modelId);
    const subject = model ? sceneModelLabel(model) : 'the model';
    return partTarget?.nodeId ? `${verb} a part of ${subject}` : `${verb} ${subject}`;
  }, [mode, modelId, models, partTarget]);

  if (!mine || !mode || !object) return null;

  return (
    <TransformControls
      // Tagged so the lobby's thumbnail hides it for the one frame it renders. Batch
      // BV: the capture fires three seconds after a model moves, which is while the
      // gizmo is still attached to it, and the review's card in the lobby showed the
      // arrows. lib/scene/captureClean.ts also recognises three's own
      // 'TransformControls' type name, so this tag is the second of two mechanisms and
      // not the only thing between a card and an arrow.
      ref={markEditingHelper}
      object={object}
      mode={mode}
      size={0.8}
      onMouseDown={() => {
        // The camera must not orbit underneath a model that is being moved. The
        // curate canvas did the same to its own OrbitControls.
        if (controlsRef.current) controlsRef.current.enabled = false;
        // Said out loud for the click-to-select beside this component: the press landed
        // on a handle, so it is not a click on the part underneath one.
        if (draggingRef) draggingRef.current = true;
        dragBefore.current = snapshot(modelId ? [modelId] : []);
        // Stamped here and not in an effect: TransformControls moves the object on
        // the pointer-move that follows this event, and an "original" captured after
        // that would be the dragged value — which is what "Reset part" restores, so
        // getting the moment wrong would make Reset put the part where the drag
        // happened to end.
        if (partObject) rememberOriginalLocalTransform(partObject);
      }}
      onMouseUp={() => {
        if (controlsRef.current) controlsRef.current.enabled = true;
        if (draggingRef) draggingRef.current = false;
        // A drag that ends inside the throttle window still has to land: the last
        // few centimetres of a move are the ones the person was aiming.
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        // ONE step for the whole drag, recorded here and not in onObjectChange: that
        // fires on every pointer move, and fifty steps for one move is a history
        // nobody can walk back through. Measured against the snapshot taken when the
        // handle was taken hold of, and stored at all only when the two differ, so a
        // press that moved nothing costs no step.
        recordFrom(dragLabel, modelId ? [modelId] : [], dragBefore.current, () => {
          send();
          keepPlacements();
        });
      }}
      onObjectChange={() => flush()}
    />
  );
};

export default ReviewModelGizmo;
