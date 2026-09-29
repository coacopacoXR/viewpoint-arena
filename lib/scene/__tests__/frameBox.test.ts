// The framing arithmetic, on its own and with no WebGL anywhere.
//
// docs/plan/15-sessions-and-variants.md batch BP. lib/scene/frameBox.ts is the one place
// that says how far back a camera sits for a bounding box, and two callers read it: the
// lobby's live viewer and the room's thumbnail capture. The point of it being one place
// is that a card's snapshot and the "Turn in 3D" that replaces it are the same
// composition of the same model, so what is pinned here is the composition — the
// distance, the angle, the clipping — and the refusals that stop a scene with nothing in
// it from putting a camera at the origin.
//
// three.js is real (Box3, Sphere, Vector3, PerspectiveCamera are all pure maths and run
// in jsdom); what is absent is a renderer, a canvas and a context. The numbers below are
// worked out by hand rather than by re-running the formula, because a test that
// recomputes its own implementation would pass no matter what the implementation said.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  FRAME_DIRECTION,
  FRAME_FOV,
  FRAME_PADDING,
  applyFrame,
  frameBox,
} from '../frameBox';

/** A 2 x 1 x 1 box centred on the origin: a bracket, in scene units. */
function bracket(): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(-1, -0.5, -0.5), new THREE.Vector3(1, 0.5, 0.5));
}

/** The same bracket standing somewhere else, so "the middle" is not always (0,0,0). */
function offsetBracket(): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(-10, -0.5, -0.5), new THREE.Vector3(-8, 0.5, 0.5));
}

/** sqrt(1^2 + 0.5^2 + 0.5^2) — the bounding sphere's radius of a 2x1x1 box. */
const BRACKET_RADIUS = Math.sqrt(1.5);

describe('frameBox', () => {
  it('sits the camera back far enough that the box fits, and no further than the padding allows', () => {
    const view = frameBox(bracket());

    expect(view).not.toBeNull();
    // radius 1.22474 / tan(22.5 degrees) = 0.41421 → 2.95699, times 1.4 of padding.
    expect(view!.distance).toBeCloseTo(4.1398, 3);
  });

  it('arrives from three-quarters and slightly above, which is the room\'s own angle', () => {
    const view = frameBox(bracket())!;
    const direction = view.position.clone().sub(view.target).normalize();

    // The room's default camera is at [8, 6, 8], so this is that view scaled to the
    // model: not straight on, not from directly overhead, and above the model's middle.
    expect(direction.x).toBeCloseTo(FRAME_DIRECTION.x, 6);
    expect(direction.y).toBeCloseTo(FRAME_DIRECTION.y, 6);
    expect(direction.z).toBeCloseTo(FRAME_DIRECTION.z, 6);
    expect(direction.y).toBeGreaterThan(0);
    expect(direction.x).toBeGreaterThan(direction.y);
  });

  it('looks at the middle of the box, wherever the box is standing', () => {
    expect(frameBox(bracket())!.target).toEqual(new THREE.Vector3(0, 0, 0));
    expect(frameBox(offsetBracket())!.target).toEqual(new THREE.Vector3(-9, 0, 0));

    const view = frameBox(offsetBracket())!;
    // The position is the target pushed out along the one direction, and nothing else:
    // a model standing off to the side is framed on itself rather than on the origin.
    expect(view.position.clone().sub(view.target).length()).toBeCloseTo(view.distance, 6);
  });

  it('steps back for a bigger model and in for a smaller one, by the same factor', () => {
    const small = frameBox(bracket())!.distance;
    const big = frameBox(bracket().applyMatrix4(new THREE.Matrix4().makeScale(10, 10, 10)))!.distance;
    const bigger = frameBox(bracket().applyMatrix4(new THREE.Matrix4().makeScale(100, 100, 100)))!.distance;

    // Scale invariance is the whole claim: a 20 mm fastener and a 6 m assembly are the
    // same picture at different distances, and neither is a speck or a wall of model.
    expect(big).toBeCloseTo(small * 10, 6);
    expect(bigger).toBeCloseTo(small * 100, 6);
  });

  it('steps in for a wider field of view and back for a narrower one', () => {
    const wide = frameBox(bracket(), 90)!.distance;
    const narrow = frameBox(bracket(), 20)!.distance;

    expect(wide).toBeLessThan(narrow);
    // radius / tan(45 degrees) = radius, times the padding.
    expect(wide).toBeCloseTo(BRACKET_RADIUS * FRAME_PADDING, 6);
  });

  it('clips to the model rather than to a constant, so neither a fastener nor an assembly is cut off', () => {
    const view = frameBox(bracket())!;
    const huge = frameBox(bracket().applyMatrix4(new THREE.Matrix4().makeScale(1000, 1000, 1000)))!;

    expect(view.near).toBeGreaterThan(0);
    expect(view.near).toBeLessThan(view.distance);
    expect(view.far).toBeGreaterThan(view.distance + BRACKET_RADIUS);
    // The near plane grows with the distance: a fixed one deep enough for an assembly
    // z-fights on a bracket, and a fixed one shallow enough for a bracket clips an
    // assembly into nothing.
    expect(huge.near).toBeGreaterThan(view.near);
    expect(huge.far).toBeGreaterThan(view.far);
  });

  it('refuses a box with nothing in it, rather than putting the camera at the origin', () => {
    expect(frameBox(new THREE.Box3())).toBeNull();
    // A single point: a real box, with no extent to fit.
    const point = new THREE.Box3();
    point.expandByPoint(new THREE.Vector3(1, 2, 3));
    expect(frameBox(point)).toBeNull();
  });

  it('refuses a field of view it cannot divide by, and frames at its own instead', () => {
    for (const fov of [0, -30, 180, 400, Number.NaN]) {
      expect(frameBox(bracket(), fov)!.distance).toBeCloseTo(frameBox(bracket())!.distance, 9);
    }
  });

  it('pads the frame, because a model touching all four edges reads as a crop', () => {
    expect(FRAME_PADDING).toBeGreaterThan(1);
    const padded = frameBox(bracket())!.distance;
    const exact = BRACKET_RADIUS / Math.tan((FRAME_FOV * Math.PI) / 360);
    expect(padded).toBeCloseTo(exact * FRAME_PADDING, 9);
    expect(padded).toBeGreaterThan(exact);
  });
});

describe('applyFrame', () => {
  it('poses the camera it is given and turns it to the target', () => {
    const camera = new THREE.PerspectiveCamera(FRAME_FOV, 16 / 9, 0.05, 400);
    const view = frameBox(offsetBracket())!;

    applyFrame(camera, view);
    camera.updateMatrixWorld(true);

    expect(camera.position).toEqual(view.position);
    expect(camera.near).toBe(view.near);
    expect(camera.far).toBe(view.far);
    // Looking at the target: the ray from the eye along the camera's own forward meets
    // it, which is the assertion that survives the target being somewhere other than the
    // origin.
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const toTarget = view.target.clone().sub(camera.position).normalize();
    expect(forward.dot(toTarget)).toBeCloseTo(1, 6);
  });

  it('writes nothing but the camera it was handed', () => {
    const scene = new THREE.Scene();
    const room = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    room.position.set(8, 6, 8);
    scene.add(room);

    const capture = new THREE.PerspectiveCamera(FRAME_FOV, 16 / 9, 0.05, 400);
    applyFrame(capture, frameBox(bracket())!);

    // The room's camera is where the person left it, and the capture's was never added
    // to a scene — which is why there is nothing to restore afterwards.
    expect(room.position).toEqual(new THREE.Vector3(8, 6, 8));
    expect(room.fov).toBe(60);
    expect(capture.parent).toBeNull();
    expect(scene.children).toHaveLength(1);
  });
});
