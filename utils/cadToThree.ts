// Turns the JSON that occt-import-js (OpenCascade) returns into a three.js
// hierarchy. Pure and worker-free on purpose: utils/cadWorker.ts does the
// tessellating, utils/cadImport.ts drives it, and this only converts, so the
// CAD assembly tree can be tested without WASM.
//
// The CAD assembly structure is kept as-is — one THREE.Group per assembly node,
// one THREE.Mesh per tessellated part — because everything downstream (the model
// tree, picking, pins, sharing) reads names and hierarchy off the Object3D.

import * as THREE from 'three';
import type { OcctBrepFace, OcctColor, OcctImportResult, OcctMesh, OcctNode } from 'occt-import-js';

const nonEmpty = (value: string | undefined | null): string | undefined => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/** Files carry sRGB colours; three.js wants them converted to its working space. */
const srgbColor = (rgb: OcctColor): THREE.Color =>
    new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);

/** The grey every other importer uses for untextured geometry. */
const neutralColor = (): THREE.Color => new THREE.Color(0.7, 0.7, 0.75);

const toColor = (rgb: OcctColor | null | undefined): THREE.Color =>
    rgb && rgb.length >= 3 ? srgbColor(rgb) : neutralColor();

const materialFor = (color: THREE.Color): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide });

const colorKey = (rgb: OcctColor): string => rgb.slice(0, 3).map(value => value.toFixed(4)).join(',');

const geometryFrom = (mesh: OcctMesh): THREE.BufferGeometry | null => {
    const position = mesh.attributes?.position?.array;
    const index = mesh.index?.array;
    if (!position || position.length < 3 || !index || index.length < 3) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setIndex(index);

    const normal = mesh.attributes.normal?.array;
    if (normal && normal.length === position.length) {
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    } else {
        // The reader only emits normals when every vertex has one, so this is
        // the difference between a shaded part and a black one.
        geometry.computeVertexNormals();
    }

    return geometry;
};

const inRange = (face: OcctBrepFace, indexCount: number): boolean =>
    face.first >= 0 && face.last >= face.first && (face.last + 1) * 3 <= indexCount;

/**
 * Per-face colours (brep_faces) become geometry groups with one material each —
 * but only when the faces really differ. A solid of one colour keeps a single
 * material, which is the common case and the cheaper one to render.
 */
const materialsFor = (mesh: OcctMesh, geometry: THREE.BufferGeometry): THREE.Material | THREE.Material[] => {
    const indexCount = geometry.index?.count ?? 0;
    const faces = (mesh.brep_faces ?? []).filter(face => inRange(face, indexCount));
    const distinct = new Set(faces.filter(face => face.color).map(face => colorKey(face.color as OcctColor)));

    if (distinct.size < 2) {
        const single = faces.find(face => face.color)?.color;
        return materialFor(toColor(mesh.color ?? single));
    }

    const palette: THREE.MeshStandardMaterial[] = [];
    const indexByKey = new Map<string, number>();
    const materialIndexFor = (color: OcctColor | null): number => {
        const key = color ? colorKey(color) : '';
        const existing = indexByKey.get(key);
        if (existing !== undefined) return existing;
        const index = palette.length;
        indexByKey.set(key, index);
        palette.push(materialFor(toColor(color ?? mesh.color)));
        return index;
    };

    for (const face of faces) {
        // first/last are triangle indices, three.js groups are index-array spans.
        geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materialIndexFor(face.color));
    }

    return palette;
};

const meshFrom = (mesh: OcctMesh, nodeName: string, partNumber: number): THREE.Mesh | null => {
    const geometry = geometryFrom(mesh);
    if (!geometry) return null;

    const threeMesh = new THREE.Mesh(geometry, materialsFor(mesh, geometry));
    threeMesh.name = nonEmpty(mesh.name) ?? nonEmpty(nodeName) ?? `Part ${partNumber}`;
    return threeMesh;
};

const groupFrom = (node: OcctNode, meshes: OcctMesh[], nextPart: { value: number }): THREE.Group => {
    const group = new THREE.Group();
    group.name = nonEmpty(node.name) ?? '';

    for (const meshIndex of node.meshes ?? []) {
        const mesh = meshes[meshIndex];
        if (!mesh) continue;
        const threeMesh = meshFrom(mesh, group.name, nextPart.value++);
        if (threeMesh) group.add(threeMesh);
    }

    for (const child of node.children ?? []) {
        group.add(groupFrom(child, meshes, nextPart));
    }

    return group;
};

/**
 * Converts one occt-import-js result. `fallbackName` (the file's base name) is
 * used when the CAD root node carries no name of its own.
 */
export const cadResultToGroup = (result: OcctImportResult, fallbackName = ''): THREE.Group => {
    const root = result.root ?? { name: '', meshes: [], children: [] };
    const group = groupFrom(root, result.meshes ?? [], { value: 1 });
    if (!group.name) group.name = nonEmpty(fallbackName) ?? '';
    return group;
};
