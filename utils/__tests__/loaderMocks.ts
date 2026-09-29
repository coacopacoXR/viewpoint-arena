// Shared fakes for modelLoader.dispatch.test.ts.
//
// vi.mock factories are hoisted above the test file's imports, so they cannot
// see anything the test file declared. They pull these in with a dynamic
// import instead, and the call log lives here so both sides share one instance.

import * as THREE from 'three';
import type { OcctImportResult } from 'occt-import-js';

/** Which loader each parseModelFile call reached, in order. */
export const loaderCalls: string[] = [];

/** One triangle spanning x 0..1 and z 0..2, so an up-axis flip shows up in the bounds. */
const triangleMesh = (name: string): THREE.Mesh => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 2], 3));
    geometry.setIndex([0, 1, 2]);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    mesh.name = name;
    return mesh;
};

export const groupMock = (label: string): THREE.Group => {
    loaderCalls.push(label);
    const group = new THREE.Group();
    group.name = `${label} assembly`;
    group.add(triangleMesh(`${label} part`));
    return group;
};

export const sceneMock = (label: string): THREE.Scene => {
    loaderCalls.push(label);
    const scene = new THREE.Scene();
    scene.name = `${label} scene`;
    scene.add(triangleMesh(`${label} part`));
    return scene;
};

/** ColladaLoader.parse returns a result object, not the scene itself. */
export const colladaMock = (label: string): { scene: THREE.Scene } => ({ scene: sceneMock(label) });

/** Stands in for the JSON utils/cadImport.ts brings back from the worker. */
export const cadResultMock = (reader: string): OcctImportResult => {
    loaderCalls.push(reader);
    return {
        success: true,
        root: { name: `${reader} assembly`, meshes: [0], children: [] },
        meshes: [{
            name: `${reader} part`,
            brep_faces: [],
            attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 0, 2] } },
            index: { array: [0, 1, 2] }
        }]
    };
};
