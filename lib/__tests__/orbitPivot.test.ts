// The orbit pivot is what makes free view feel like orbiting the model instead
// of spinning on your own head after a follow. It must stay on the view ray —
// otherwise leaving a follow visibly jumps the picture.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeOrbitPivot, getModelCenter } from '../orbitPivot';
import { MeshPartRegistry, type PartRegistry } from '../scene/partRegistry';
import { buildSceneTree } from '../../utils/modelLoader';

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
  /**
   * One parsed model: a root group with a box in it at `position`, indexed the way a
   * parse indexes it. `buildSceneTree` does the tagging, so the fixture is the shape
   * lib/scene/sceneEntries.ts builds a registry from rather than a hand-stamped one.
   */
  function model(position: THREE.Vector3, size = 2, prefix = 'm1'): PartRegistry {
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    mesh.position.copy(position);
    root.add(mesh);
    buildSceneTree(root, { value: 0 }, prefix);
    root.updateMatrixWorld(true);
    return new MeshPartRegistry(root);
  }

  it('returns null when there are no models', () => {
    // Which is also the bundled synth's answer, and always was: components/Scene/
    // Product.tsx tags its part GROUPS and leaves their meshes untagged, so the walk
    // this replaced — which asked for `isMesh` as well as the tag — never found it
    // either. Both callers fall back to where they already were.
    expect(getModelCenter([])).toBeNull();
  });

  it('returns the centre of the model', () => {
    const center = getModelCenter([model(new THREE.Vector3(4, 0, 0))]);

    expect(center).not.toBeNull();
    expect(center!.x).toBeCloseTo(4);
    expect(center!.y).toBeCloseTo(0);
    expect(center!.z).toBeCloseTo(0);
  });

  it('spans every model in the scene, including parts nested in a group', () => {
    const nested = new THREE.Group();
    const inner = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    inner.position.set(-2, 0, 0);
    nested.add(inner);
    const outer = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    outer.position.set(6, 0, 0);
    const root = new THREE.Group();
    root.add(nested, outer);
    buildSceneTree(root, { value: 0 }, 'm1');
    root.updateMatrixWorld(true);

    const center = getModelCenter([new MeshPartRegistry(root)]);
    expect(center!.x).toBeCloseTo(2);
    expect(center!.y).toBeCloseTo(0);
    expect(center!.z).toBeCloseTo(0);
  });

  it('spans two models, because a comparison puts both in the room', () => {
    const center = getModelCenter([
      model(new THREE.Vector3(-2, 0, 0), 2, 'a1'),
      model(new THREE.Vector3(6, 0, 0), 2, 'b2'),
    ]);

    expect(center!.x).toBeCloseTo(2);
  });
});
