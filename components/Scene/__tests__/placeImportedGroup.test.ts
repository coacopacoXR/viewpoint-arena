import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { placeImportedGroup } from '../ImportedModel';

describe('placeImportedGroup', () => {
  it('centres a model that sits far from its own origin (a CAD part in mm)', () => {
    // A 10 mm cube whose centre is 100 mm out along x.
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    mesh.position.set(100, 5, 0);
    group.add(mesh);
    const center = new THREE.Vector3(100, 5, 0);
    const scale = 2 / 10; // what centerModel computes for a 10 mm model

    placeImportedGroup(group, scale, center.clone().negate());

    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    expect(c.x).toBeCloseTo(0, 5);
    expect(c.z).toBeCloseTo(0, 5);
    expect(box.min.y).toBeCloseTo(0, 5); // resting on the floor
    expect(box.getSize(new THREE.Vector3()).x).toBeCloseTo(2, 5);
  });
});
