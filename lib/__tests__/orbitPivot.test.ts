// The orbit pivot is what makes free view feel like orbiting the model instead
// of spinning on your own head after a follow. It must stay on the view ray —
// otherwise leaving a follow visibly jumps the picture.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeOrbitPivot, getModelCenter } from '../orbitPivot';

const ORIGIN = new THREE.Vector3(0, 0, 0);

describe('computeOrbitPivot', () => {
  it('lies on the camera line of sight', () => {
    const camPos = new THREE.Vector3(3, 2, 8);
    const forward = new THREE.Vector3(0.2, -0.1, -0.97).normalize();

    const pivot = computeOrbitPivot(camPos, forward, new THREE.Vector3(1, 1, 0));

    const offset = pivot.clone().sub(camPos);
    // Zero cross product with the ray direction = collinear = on the line of sight.
    expect(offset.clone().cross(forward).length()).toBeLessThan(1e-9);
    // …and in front of the camera, not behind it.
    expect(offset.dot(forward)).toBeGreaterThan(0);
  });

  it('sits at the depth of the model', () => {
    const camPos = new THREE.Vector3(2, 1, 6);
    const forward = new THREE.Vector3(0, 0, -1);

    const pivot = computeOrbitPivot(camPos, forward, new THREE.Vector3(2, 1, -1));

    expect(pivot.distanceTo(camPos)).toBeCloseTo(7);
    expect(pivot.z).toBeCloseTo(-1);
  });

  it('takes only the depth of an off-axis model, so the picture does not shift', () => {
    const camPos = ORIGIN.clone();
    const forward = new THREE.Vector3(0, 0, -1);

    // 4 units ahead, 3 to the side.
    const pivot = computeOrbitPivot(camPos, forward, new THREE.Vector3(3, 0, -4));

    expect(pivot.x).toBeCloseTo(0);
    expect(pivot.y).toBeCloseTo(0);
    expect(pivot.z).toBeCloseTo(-4);
  });

  it('clamps to minDist when the model is behind the camera', () => {
    const camPos = new THREE.Vector3(0, 0, 0);
    const forward = new THREE.Vector3(0, 0, -1);

    const pivot = computeOrbitPivot(camPos, forward, new THREE.Vector3(0, 0, 10));

    expect(pivot.distanceTo(camPos)).toBeCloseTo(1.5);
    expect(pivot.z).toBeCloseTo(-1.5);
  });

  it('clamps to minDist when the model is at the camera', () => {
    const camPos = new THREE.Vector3(4, 0, 4);
    const forward = new THREE.Vector3(0, 0, -1);

    const pivot = computeOrbitPivot(camPos, forward, camPos.clone());

    expect(pivot.distanceTo(camPos)).toBeCloseTo(1.5);
  });

  it('clamps to maxDist when the model is far away', () => {
    const camPos = ORIGIN.clone();
    const forward = new THREE.Vector3(0, 0, -1);

    const pivot = computeOrbitPivot(camPos, forward, new THREE.Vector3(0, 0, -500));

    expect(pivot.distanceTo(camPos)).toBeCloseTo(15);
  });

  it('falls back to the world origin when there is no model', () => {
    const camPos = new THREE.Vector3(0, 0, 5);
    const forward = new THREE.Vector3(0, 0, -1);

    const pivot = computeOrbitPivot(camPos, forward, null);

    expect(pivot.x).toBeCloseTo(0);
    expect(pivot.y).toBeCloseTo(0);
    expect(pivot.z).toBeCloseTo(0);
  });

  it('honours custom bounds', () => {
    const camPos = ORIGIN.clone();
    const forward = new THREE.Vector3(0, 0, -1);

    expect(computeOrbitPivot(camPos, forward, camPos.clone(), 4, 9).distanceTo(camPos)).toBeCloseTo(4);
    expect(
      computeOrbitPivot(camPos, forward, new THREE.Vector3(0, 0, -99), 4, 9).distanceTo(camPos),
    ).toBeCloseTo(9);
  });

  it('does not mutate the camera position or the model centre', () => {
    const camPos = new THREE.Vector3(1, 2, 3);
    const model = new THREE.Vector3(1, 2, -3);

    computeOrbitPivot(camPos, new THREE.Vector3(0, 0, -1), model);

    expect(camPos).toEqual(new THREE.Vector3(1, 2, 3));
    expect(model).toEqual(new THREE.Vector3(1, 2, -3));
  });
});

describe('getModelCenter', () => {
  function taggedMesh(id: string, position: THREE.Vector3, size = 2) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    mesh.userData.modelId = id;
    mesh.position.copy(position);
    return mesh;
  }

  it('returns null when nothing is tagged as a model', () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    scene.updateMatrixWorld(true);

    expect(getModelCenter(scene)).toBeNull();
  });

  it('returns the centre of the tagged model', () => {
    const scene = new THREE.Scene();
    scene.add(taggedMesh('m1', new THREE.Vector3(4, 0, 0)));
    scene.updateMatrixWorld(true);

    const center = getModelCenter(scene);
    expect(center).not.toBeNull();
    expect(center!.x).toBeCloseTo(4);
    expect(center!.y).toBeCloseTo(0);
    expect(center!.z).toBeCloseTo(0);
  });

  it('spans every tagged mesh, including ones nested in a group', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.add(taggedMesh('m1', new THREE.Vector3(-2, 0, 0)));
    scene.add(group);
    scene.add(taggedMesh('m1', new THREE.Vector3(6, 0, 0)));
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50))); // untagged: ignored
    scene.updateMatrixWorld(true);

    const center = getModelCenter(scene);
    expect(center!.x).toBeCloseTo(2);
    expect(center!.y).toBeCloseTo(0);
    expect(center!.z).toBeCloseTo(0);
  });
});
