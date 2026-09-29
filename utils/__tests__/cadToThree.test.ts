import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { OcctImportResult, OcctMesh } from 'occt-import-js';
import { cadResultToGroup } from '../cadToThree';

/** One triangle in the XY plane. Normals are optional — IGES often has none. */
const triangle = (withNormals: boolean): Pick<OcctMesh, 'attributes' | 'index'> => ({
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
    ...(withNormals ? { normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] } } : {}),
  },
  index: { array: [0, 1, 2] },
});

/** Two triangles sharing an edge, so per-face colours have something to split. */
const quad = (): Pick<OcctMesh, 'attributes' | 'index'> => ({
  attributes: { position: { array: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0] } },
  index: { array: [0, 1, 2, 0, 2, 3] },
});

const twoNodeResult = (): OcctImportResult => ({
  success: true,
  root: {
    name: 'Assembly',
    meshes: [0],
    children: [{ name: 'Bracket', meshes: [1, 2], children: [] }],
  },
  meshes: [
    { name: 'Base Plate', color: [1, 0, 0], brep_faces: [], ...triangle(true) },
    { name: '', ...triangle(false) },
    {
      name: 'Pad',
      brep_faces: [
        { first: 0, last: 0, color: [0, 1, 0] },
        { first: 1, last: 1, color: [0, 0, 1] },
      ],
      ...quad(),
    },
  ],
});

const meshesOf = (root: THREE.Object3D): THREE.Mesh[] => {
  const found: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) found.push(child);
  });
  return found;
};

const singleMaterial = (mesh: THREE.Mesh): THREE.MeshStandardMaterial => {
  expect(Array.isArray(mesh.material)).toBe(false);
  return mesh.material as THREE.MeshStandardMaterial;
};

const materialList = (mesh: THREE.Mesh): THREE.Material[] =>
  Array.isArray(mesh.material) ? mesh.material : [mesh.material];

describe('cadResultToGroup', () => {
  it('keeps the CAD assembly tree: a group per node, named as the file has it', () => {
    const group = cadResultToGroup(twoNodeResult(), 'cube');

    expect(group.name).toBe('Assembly');
    expect(group.children.map((child) => child.name)).toEqual(['Base Plate', 'Bracket']);
    expect(group.children[1]).toBeInstanceOf(THREE.Group);
    expect(group.children[1].children.map((child) => child.name)).toEqual(['Bracket', 'Pad']);
  });

  it('falls back to the file name when the root node has no name', () => {
    const result = twoNodeResult();
    result.root.name = '   ';

    expect(cadResultToGroup(result, 'cube').name).toBe('cube');
  });

  it('names an unnamed mesh after its assembly node', () => {
    const bracket = cadResultToGroup(twoNodeResult(), 'cube').children[1];

    // Mesh 1 carries no name, so it takes the node's; "Pad" keeps its own.
    expect(bracket.children[0].name).toBe('Bracket');
  });

  it('numbers parts when neither the mesh nor the node is named', () => {
    const result = twoNodeResult();
    result.root.children[0].name = '';
    result.meshes[1].name = '';
    result.meshes[2].name = '';

    const bracket = cadResultToGroup(result, 'cube').children[1];
    expect(bracket.children.map((child) => child.name)).toEqual(['Part 2', 'Part 3']);
  });

  it('builds geometry from position and index, using the normals the file supplied', () => {
    const mesh = meshesOf(cadResultToGroup(twoNodeResult(), 'cube'))[0];
    const geometry = mesh.geometry;

    expect(geometry.attributes.position.count).toBe(3);
    expect(Array.from(geometry.index!.array)).toEqual([0, 1, 2]);
    expect(geometry.attributes.normal.array).toEqual(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));
  });

  it('computes normals when the reader sent none', () => {
    const bracket = cadResultToGroup(twoNodeResult(), 'cube').children[1];
    const geometry = (bracket.children[0] as THREE.Mesh).geometry;

    expect(geometry.attributes.normal).toBeDefined();
    expect(geometry.attributes.normal.count).toBe(geometry.attributes.position.count);
    // A flat triangle in the XY plane faces +Z.
    expect(geometry.attributes.normal.getZ(0)).toBeCloseTo(1, 5);
  });

  it('uses the mesh colour, lit like the rest of the app', () => {
    const mesh = meshesOf(cadResultToGroup(twoNodeResult(), 'cube'))[0];
    const material = singleMaterial(mesh);

    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.color.getHex(THREE.SRGBColorSpace)).toBe(0xff0000);
  });

  it('falls back to the same neutral grey the other importers use', () => {
    const bracket = cadResultToGroup(twoNodeResult(), 'cube').children[1];
    const material = singleMaterial(bracket.children[0] as THREE.Mesh);

    expect(material.color.equals(new THREE.Color(0.7, 0.7, 0.75))).toBe(true);
  });

  it('splits per-face colours into geometry groups, one material each', () => {
    const pad = meshesOf(cadResultToGroup(twoNodeResult(), 'cube')).find((m) => m.name === 'Pad');
    expect(pad).toBeDefined();

    const materials = pad!.material;
    expect(Array.isArray(materials)).toBe(true);
    const palette = materials as THREE.MeshStandardMaterial[];
    expect(palette).toHaveLength(2);
    expect(palette.map((m) => m.color.getHex(THREE.SRGBColorSpace))).toEqual([0x00ff00, 0x0000ff]);

    // first/last are triangle indices; groups are index-array spans.
    expect(pad!.geometry.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
  });

  it('keeps one material when every face has the same colour', () => {
    const result = twoNodeResult();
    result.meshes[2].brep_faces = [
      { first: 0, last: 0, color: [0, 1, 0] },
      { first: 1, last: 1, color: [0, 1, 0] },
    ];

    const pad = meshesOf(cadResultToGroup(result, 'cube')).find((m) => m.name === 'Pad');
    const material = singleMaterial(pad!);

    expect(material.color.getHex(THREE.SRGBColorSpace)).toBe(0x00ff00);
    expect(pad!.geometry.groups).toEqual([]);
  });

  it('ignores face ranges that do not fit the index buffer', () => {
    const result = twoNodeResult();
    result.meshes[2].brep_faces = [
      { first: 0, last: 0, color: [0, 1, 0] },
      { first: 1, last: 1, color: [0, 0, 1] },
      // The quad has two triangles; this one starts past the end of the buffer.
      { first: 2, last: 5, color: [1, 0, 0] },
    ];

    const pad = meshesOf(cadResultToGroup(result, 'cube')).find((m) => m.name === 'Pad');
    // The bogus face is dropped instead of emitting a group past the end and a
    // material nothing would ever use.
    expect(materialList(pad!)).toHaveLength(2);
    expect(pad!.geometry.groups).toEqual([
      { start: 0, count: 3, materialIndex: 0 },
      { start: 3, count: 3, materialIndex: 1 },
    ]);
  });

  it('skips meshes the reader left empty', () => {
    const result = twoNodeResult();
    result.meshes[1].index = { array: [] };

    const bracket = cadResultToGroup(result, 'cube').children[1];
    expect(bracket.children.map((child) => child.name)).toEqual(['Pad']);
  });
});
