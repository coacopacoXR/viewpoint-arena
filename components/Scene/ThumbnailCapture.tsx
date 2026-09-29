// Taking the picture of a room that the lobby's card shows.
//
// docs/plan/15-sessions-and-variants.md batch BO. The user's complaint about the old
// lobby was that it gave no way to see what a design review looked like from outside it,
// and a card with a name and three numbers on it does not answer that. This is where the
// answer comes from: a JPEG of the room's own canvas, written onto the review's row, read
// back by every lobby that lists it.
//
// WHY IT LIVES INSIDE THE CANVAS. Reading a WebGL drawing buffer needs the renderer, the
// scene and the camera, and only React-three-fiber holds those. So this is a component
// that renders nothing, mounted by World, and it reaches the room's state through the
// same store every other scene component uses.
//
// WHEN IT CAPTURES, AND WHEN IT DOES NOT
//
//   * The moment THIS browser's meeting ends. store.endMeeting(true) bumps
//     `snapshotRequest` and nothing else does — one meeting is recorded once, by the
//     browser whose person pressed End, and its picture belongs with that record.
//   * ~3 s after a model arrives or moves, debounced. An import and a gizmo drag both
//     replace the store's scene, so watching it covers "a model was imported", "a model
//     was placed" and "its placement was saved" with one dependency. The debounce is
//     what stops a drag from writing a row per frame.
//   * Only for somebody who may EDIT the review. `can('editReview')` is the room's own
//     answer (lib/reviews/roles.ts): a participant's browser and a guest's do not write,
//     so a review's picture is always one its editors were looking at.
//   * Only from the MAIN LINE's room, batch BV. `review_curations.thumbnail` is the
//     review's one picture and every line of it shares the row, so a variant's browser
//     writing it replaced the review's thumbnail with the variant's model, moved
//     wherever the variant had moved it — which is what the user saw after exploring a
//     variant that had never met. A variant's room captures nothing at all; the
//     review's picture is taken by its own room, and after an adoption that room opens
//     on the positions the adoption made the main line's (docs/supabase-schema.sql,
//     `adopt_review_line`) and takes a new one then. `activeLine` null means the main
//     line, an ad-hoc room and an install with no lines, and all three keep capturing.
//   * Never when there is nothing on screen. An empty room's snapshot would replace a
//     good picture with a grey rectangle, and the lobby would show it to everybody.
//
// NOTHING HERE MAY BLOCK ANYTHING. Every path is fire-and-forget and every failure is
// logged and dropped: a review without a thumbnail is a card with a placeholder on it,
// which is what it was before this batch, and a meeting that could not be ended because
// a picture failed is a bug in the thing that was supposed to be a nicety.
//
// The renderer's drawing buffer is NOT preserved between frames unless the canvas asked
// for `preserveDrawingBuffer`, so lib/reviews/thumbnail.ts renders a frame and reads it
// in the same synchronous call. That is also why nothing here awaits between the two.
//
// THE CAMERA IS NOT THE ROOM'S. Batch BP: framing the card with the camera whoever
// pressed End happened to be looking through is what produced a model the size of a
// speck in a wide grey floor, because that camera is at [8, 6, 8] at best and anywhere
// at all in practice. lib/reviews/thumbnail.ts poses a temporary camera of its own on
// the bounding box of the review's models, with the same fit rule the lobby's "Turn in
// 3D" viewer uses. Nothing here reads the room's camera and nothing restores one.

import React, { useCallback, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { sceneModelVisible, useStore } from '../../store';
import { usePresence } from '../../lib/PresenceContext';
import { useReviewRole } from '../../lib/reviews/useReviewRole';
import { captureRoomThumbnail, saveReviewThumbnail } from '../../lib/reviews/thumbnail';

/** How long the scene has to be still before an import or a move is worth a picture. */
const SETTLE_MS = 3000;

/** The offscreen canvas lib/reviews/thumbnail.ts downscales into. */
function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, context: canvas.getContext('2d') };
}

/** Whether there is anything on screen worth photographing. */
function somethingToShow(): boolean {
  const { scene, sceneEntries, localModelVisibility } = useStore.getState();
  if (scene.builtIn !== null) return true;
  return scene.models.some(
    (model) => sceneModelVisible(model, localModelVisibility) && sceneEntries[model.id] !== undefined,
  );
}

const ThumbnailCapture: React.FC = () => {
  const { gl, scene } = useThree();
  const reviewId = useStore((state) => state.activeReviewId);
  const snapshotRequest = useStore((state) => state.snapshotRequest);
  const sessionHostId = useStore((state) => state.sessionHostId);
  // Subscribed rather than read at capture time so that a parse finishing re-arms the
  // debounce below: the geometry landing is what makes the picture worth taking.
  const sceneEntries = useStore((state) => state.sceneEntries);
  const roomScene = useStore((state) => state.scene);
  // The line this room resolved itself to, put in the store by pages/RoomPage.tsx
  // before the socket opened. Null on the main line, for an ad-hoc room and on an
  // install with no database — and all three are a room that may write the review's
  // picture. A variant's is not: see the header.
  const activeLine = useStore((state) => state.activeLine);
  const localUserId = usePresence().localUserId;
  const { can, loading } = useReviewRole({ reviewId, sessionHostId, localUserId });

  const mayCapture =
    reviewId !== null &&
    !loading &&
    can('editReview') &&
    (activeLine === null || activeLine.kind === 'main');

  // Read through a ref at the moment of capture rather than closed over, because the
  // debounced call fires three seconds after the render that armed it and the scene may
  // well have changed since. A stale closure here is a picture of a room that has gone.
  const latest = useRef({ gl, scene, reviewId, mayCapture });
  latest.current = { gl, scene, reviewId, mayCapture };

  const capture = useCallback(async () => {
    const { gl: renderer, scene: world, reviewId: id, mayCapture: allowed } = latest.current;
    if (!allowed || !id) return;
    if (!somethingToShow()) return;
    try {
      const thumbnail = captureRoomThumbnail(renderer, world, makeCanvas);
      if (!thumbnail) return;
      await saveReviewThumbnail(id, thumbnail);
    } catch (err) {
      // A canvas that cannot be read — a lost context, a tainted buffer, a browser that
      // refused. The review keeps whatever picture it had.
      console.warn('[thumbnail] could not capture the room:', err);
    }
  }, []);

  // The meeting ended here, and this is the browser that recorded it.
  useEffect(() => {
    if (snapshotRequest === 0) return;
    void capture();
  }, [snapshotRequest, capture]);

  // A model arrived, or moved, or its placement was saved. Re-armed by every change so a
  // drag writes once, at the end, rather than once per frame. `roomScene` is the store's
  // list of models — NOT the three.js scene `useThree` hands back, which has no models
  // on it and is only here to be photographed.
  useEffect(() => {
    if (roomScene.models.length === 0 && roomScene.builtIn === null) return;
    const timer = setTimeout(() => { void capture(); }, SETTLE_MS);
    return () => clearTimeout(timer);
    // `sceneEntries` is a dependency on purpose: the parse finishing is what makes the
    // picture worth taking, and it lands after the scene that asked for it.
  }, [roomScene, sceneEntries, capture]);

  return null;
};

export default ThumbnailCapture;
