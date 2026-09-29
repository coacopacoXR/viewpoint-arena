import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { SceneNode } from '../../types';
import { parseModelFile } from '../modelLoader';
import { INVALID_FILE_TYPE_MESSAGE, NATIVE_CAD_MESSAGE, modelFileMime } from '../modelFormats';
import type { CadReaderKind } from '../cadImport';
import { loaderCalls } from './loaderMocks';

// The formats below are faked at the loader boundary: what is under test is
// that parseModelFile reaches the right reader for each extension, not that
// three.js can parse a file we made up. PLY, STL, OBJ and glTF are exercised
// for real further down.
vi.mock('three/examples/jsm/loaders/3MFLoader.js', async () => {
    const { groupMock } = await import('./loaderMocks');
    return { ThreeMFLoader: class { parse() { return groupMock('3mf'); } } };
});

vi.mock('three/examples/jsm/loaders/ColladaLoader.js', async () => {
    const { colladaMock } = await import('./loaderMocks');
    return { ColladaLoader: class { parse() { return colladaMock('dae'); } } };
});

vi.mock('three/examples/jsm/loaders/TDSLoader.js', async () => {
    const { groupMock } = await import('./loaderMocks');
    return { TDSLoader: class { parse() { return groupMock('3ds'); } } };
});

vi.mock('three/examples/jsm/loaders/VRMLLoader.js', async () => {
    const { sceneMock } = await import('./loaderMocks');
    return { VRMLLoader: class { parse() { return sceneMock('wrl'); } } };
});

vi.mock('three/examples/jsm/loaders/AMFLoader.js', async () => {
    const { groupMock } = await import('./loaderMocks');
    return { AMFLoader: class { parse() { return groupMock('amf'); } } };
});

// The real CAD client would spin up a Web Worker and 7.6 MB of WASM; everything
// else about the path (dispatch, up axis, tree) stays real.
vi.mock('../cadImport', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../cadImport')>();
    const { cadResultMock } = await import('./loaderMocks');
    return {
        ...actual,
        readCadFile: async (_file: File, reader: CadReaderKind) => cadResultMock(reader)
    };
});

const modelFile = (name: string, contents = 'not really a model'): File =>
    new File([contents], name, { type: modelFileMime(name) });

const ASCII_PLY = [
    'ply',
    'format ascii 1.0',
    'element vertex 3',
    'property float x',
    'property float y',
    'property float z',
    'element face 1',
    'property list uchar int vertex_indices',
    'end_header',
    '0 0 0',
    '1 0 0',
    '0 0 2',
    '3 0 1 2',
    ''
].join('\n');

const ASCII_STL = [
    'solid tri',
    '  facet normal 0 0 1',
    '    outer loop',
    '      vertex 0 0 0',
    '      vertex 1 0 0',
    '      vertex 0 1 0',
    '    endloop',
    '  endfacet',
    'endsolid tri',
    ''
].join('\n');

const OBJ_TEXT = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3', ''].join('\n');

/** A one-triangle glTF 2.0 with its buffer inline, so nothing is fetched. */
const gltfFile = (): File => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const bytes = new Uint8Array(positions.byteLength + indices.byteLength);
    bytes.set(new Uint8Array(positions.buffer), 0);
    bytes.set(new Uint8Array(indices.buffer), positions.byteLength);

    let binary = '';
    bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
    });

    const gltf = {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'Triangle' }],
        meshes: [{ name: 'Triangle', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR', max: [2], min: [0] }
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
            { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 }
        ],
        buffers: [{ byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(binary)}` }]
    };

    return new File([JSON.stringify(gltf)], 'triangle.gltf', { type: 'model/gltf+json' });
};

const namesOf = (node: SceneNode): string[] =>
    [node.name, ...(node.children ?? []).flatMap(namesOf)];

const boundsOf = (root: THREE.Object3D): THREE.Vector3 =>
    new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());

describe('parseModelFile dispatch', () => {
    const meshLoaderCases: Array<[string, string]> = [
        ['model.3mf', '3mf'],
        ['model.dae', 'dae'],
        ['model.3ds', '3ds'],
        ['model.wrl', 'wrl'],
        ['model.vrml', 'wrl'],
        ['model.amf', 'amf']
    ];

    for (const [fileName, expected] of meshLoaderCases) {
        it(`reads ${fileName} with the ${expected} loader`, async () => {
            loaderCalls.length = 0;

            const result = await parseModelFile(modelFile(fileName));

            expect(loaderCalls).toEqual([expected]);
            expect(result.fileName).toBe(fileName);
            expect(namesOf(result.sceneTree)).toContain(`${expected} part`);
        });
    }

    const cadCases: Array<[string, CadReaderKind]> = [
        ['bracket.step', 'step'],
        ['bracket.stp', 'step'],
        ['bracket.iges', 'iges'],
        ['bracket.igs', 'iges'],
        ['bracket.brep', 'brep'],
        ['bracket.brp', 'brep']
    ];

    for (const [fileName, reader] of cadCases) {
        it(`sends ${fileName} to the ${reader} reader`, async () => {
            loaderCalls.length = 0;

            const result = await parseModelFile(modelFile(fileName));

            expect(loaderCalls).toEqual([reader]);
            // The assembly group survives in 3D; the tree collapses a wrapper
            // that holds a single part and shows the part instead.
            expect(result.root.children[0].name).toBe(`${reader} assembly`);
            expect(namesOf(result.sceneTree)).toContain(`${reader} part`);
        });
    }

    it('dispatches on the extension whatever the MIME type says', async () => {
        loaderCalls.length = 0;
        // A remote client rebuilds the File from socket bytes; the MIME is cosmetic.
        const file = new File(['x'], 'bracket.STEP', { type: 'text/plain' });

        await parseModelFile(file);

        expect(loaderCalls).toEqual(['step']);
    });

    it('tells the user what to do with a native CAD file', async () => {
        for (const fileName of ['part.sldprt', 'part.catpart', 'part.prt', 'part.ipt', 'part.x_t', 'part.jt']) {
            loaderCalls.length = 0;
            await expect(parseModelFile(modelFile(fileName))).rejects.toThrow(NATIVE_CAD_MESSAGE);
            expect(loaderCalls).toEqual([]);
        }
    });

    it('rejects anything else with the list of what is supported', async () => {
        await expect(parseModelFile(modelFile('notes.zip'))).rejects.toThrow(INVALID_FILE_TYPE_MESSAGE);
        await expect(parseModelFile(modelFile('README'))).rejects.toThrow(INVALID_FILE_TYPE_MESSAGE);
    });
});

describe('up axis', () => {
    it('tips a CAD import from Z-up onto three.js Y-up', async () => {
        const result = await parseModelFile(modelFile('bracket.step'));

        // The fake part spans 2 units along Z; after the flip that is height.
        const size = boundsOf(result.root);
        expect(size.y).toBeCloseTo(2, 5);
        expect(size.z).toBeCloseTo(0, 5);
        expect(result.root.children[0].rotation.x).toBeCloseTo(-Math.PI / 2, 5);
    });

    it('leaves a mesh file in its own frame', async () => {
        const result = await parseModelFile(modelFile('scan.ply', ASCII_PLY));

        const size = boundsOf(result.root);
        expect(size.y).toBeCloseTo(0, 5);
        expect(size.z).toBeCloseTo(2, 5);
        expect(result.root.children[0].rotation.x).toBe(0);
    });
});

describe('formats that were already supported', () => {
    it('reads a real ASCII PLY into a named mesh', async () => {
        const result = await parseModelFile(modelFile('scan.ply', ASCII_PLY));

        expect(result.root.children[0].name).toBe('scan');
        expect(boundsOf(result.root).x).toBeCloseTo(1, 5);
        expect(result.baseScale).toBeCloseTo(1, 5);
    });

    it('reads a real ASCII STL', async () => {
        const result = await parseModelFile(modelFile('tri.stl', ASCII_STL));

        expect(namesOf(result.sceneTree)).toContain('tri');
    });

    it('reads a real OBJ', async () => {
        const result = await parseModelFile(modelFile('part.obj', OBJ_TEXT));

        let meshes = 0;
        result.root.traverse(child => {
            if (child instanceof THREE.Mesh) meshes += 1;
        });
        expect(meshes).toBeGreaterThan(0);
    });

    it('reads a real glTF and keeps the node names in the tree', async () => {
        const result = await parseModelFile(gltfFile());

        expect(namesOf(result.sceneTree)).toContain('Triangle');
    });

    it('normalises scale and centres the model', async () => {
        const result = await parseModelFile(modelFile('bracket.step'));

        // The longest side is scaled to 2 units, and the centre sits on the origin.
        expect(result.baseScale).toBeCloseTo(1, 5);
        const box = new THREE.Box3().setFromObject(result.root);
        expect(box.getCenter(new THREE.Vector3()).length()).toBeCloseTo(0, 5);
    });
});
