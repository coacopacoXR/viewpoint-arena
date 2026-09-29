// @vitest-environment node
//
// End-to-end proof that the CAD path works on real files, not just on
// hand-written JSON: occt-import-js runs in Node too, so the same reader the
// Web Worker uses tessellates a real STEP, IGES and BREP file here, and the
// result goes through the same converter the browser uses.
//
// Fixtures are from the occt-import-js test set (LGPL-2.1) — see
// utils/__tests__/fixtures/README.md.

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import occtimportjs from 'occt-import-js';
import type { OcctImportResult, OcctInstance, OcctNode } from 'occt-import-js';
import { CAD_TESSELLATION_PARAMS } from '../cadImport';
import { cadResultToGroup } from '../cadToThree';

const WASM_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 60_000;

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

const meshesOf = (root: THREE.Object3D): THREE.Mesh[] => {
  const found: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) found.push(child);
  });
  return found;
};

let occt: OcctInstance;

beforeAll(async () => {
  occt = await occtimportjs();
}, WASM_TIMEOUT_MS);

/** What the app needs of any import, whatever the format. */
const expectRenderable = (group: THREE.Group) => {
  const meshes = meshesOf(group);
  expect(meshes.length).toBeGreaterThan(0);

  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    // The model tree shows this, so an empty name would show as "Mesh N".
    expect(mesh.name.trim().length).toBeGreaterThan(0);
    expect(geometry.attributes.position.count).toBeGreaterThan(0);
    expect(geometry.index).not.toBeNull();
    expect(geometry.index!.count % 3).toBe(0);
    // Without normals nothing is shaded; cadToThree computes them when the
    // reader sends none (IGES in particular usually does).
    expect(geometry.attributes.normal.count).toBe(geometry.attributes.position.count);
    expect(Number.isNaN(geometry.attributes.position.array[0])).toBe(false);
  }

  const box = new THREE.Box3().setFromObject(group);
  expect(box.isEmpty()).toBe(false);
  const size = box.getSize(new THREE.Vector3());
  expect(size.x).toBeGreaterThan(0);
  expect(size.y).toBeGreaterThan(0);
  expect(size.z).toBeGreaterThan(0);

  return meshes;
};

describe('OpenCascade reads real CAD files', () => {
  it('tessellates a STEP file into a solid, colour included', () => {
    const result: OcctImportResult = occt.ReadStepFile(fixture('cube.stp'), CAD_TESSELLATION_PARAMS);

    expect(result.success).toBe(true);
    expect(result.meshes.length).toBeGreaterThan(0);

    const group = cadResultToGroup(result, 'cube');
    const meshes = expectRenderable(group);

    // A cube is at least 12 triangles; a single stray triangle would mean the
    // tessellation silently collapsed.
    const triangles = meshes.reduce((total, mesh) => total + mesh.geometry.index!.count / 3, 0);
    expect(triangles).toBeGreaterThanOrEqual(12);

    // The orange the STEP file asks for reaches the material, not the neutral grey.
    const material = meshes[0].material as THREE.MeshStandardMaterial;
    expect(material.color.getHex(THREE.SRGBColorSpace)).toBe(0xff5100);
  }, READ_TIMEOUT_MS);

  it('tessellates an IGES file, computing any normals the reader left out', () => {
    const result = occt.ReadIgesFile(fixture('cube-10x10.igs'), CAD_TESSELLATION_PARAMS);

    expect(result.success).toBe(true);

    const group = cadResultToGroup(result, 'cube-10x10');
    expectRenderable(group);

    // The solid keeps the name IGES gave it, so the model tree reads as the part.
    expect(group.children.map((child) => child.name)).toEqual(['Solid1']);
  }, READ_TIMEOUT_MS);

  it('tessellates a BREP file', () => {
    const result = occt.ReadBrepFile(fixture('as1_pe_203.brep'), CAD_TESSELLATION_PARAMS);

    expect(result.success).toBe(true);
    // 18 unnamed solids: they get "Part N" rather than an empty row in the tree.
    expect(result.meshes.length).toBeGreaterThan(1);
    expectRenderable(cadResultToGroup(result, 'as1_pe_203'));
  }, READ_TIMEOUT_MS);

  it('mirrors the reader assembly tree, group for group and mesh for mesh', () => {
    const result = occt.ReadStepFile(fixture('cube.stp'), CAD_TESSELLATION_PARAMS);
    const group = cadResultToGroup(result, 'cube');

    const readerNodes = (node: OcctNode): number =>
      1 + node.children.reduce((total, child) => total + readerNodes(child), 0);

    const groups: THREE.Object3D[] = [];
    group.traverse((child) => {
      if (child instanceof THREE.Group) groups.push(child);
    });

    expect(groups.length).toBe(readerNodes(result.root));
    expect(meshesOf(group).length).toBe(result.meshes.filter((mesh) => mesh.index.array.length > 0).length);
    // The root node of this file is unnamed, so the file name stands in.
    expect(group.name).toBe('cube');
  }, READ_TIMEOUT_MS);
});
