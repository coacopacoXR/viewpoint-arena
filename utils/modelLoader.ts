import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { SceneNode, ObjectState } from '../types';
import { cadResultToGroup } from './cadToThree';
import { CAD_READER_BY_EXTENSION, readCadFile } from './cadImport';
import {
    INVALID_FILE_TYPE_MESSAGE,
    NATIVE_CAD_MESSAGE,
    SUPPORTED_EXTENSIONS,
    isNativeCadExtension,
    maxFileSizeFor,
    maxFileSizeMessage,
    modelFileExtension,
    upAxisFor
} from './modelFormats';

export interface ModelImportResult {
    root: THREE.Group;
    sceneTree: SceneNode;
    fileName: string;
    baseScale: number;
    basePosition: THREE.Vector3;
    /**
     * The bounding box in the model's OWN units, before baseScale normalises it.
     * Placement needs a width to put one model beside another, and measuring it
     * here costs nothing: centerModel already has the box in hand.
     */
    size: { x: number; y: number; z: number };
}

/** How parseModelFile should build the tree it returns. */
export interface ParseModelOptions {
    /**
     * Prefix for every node id, and so for every userData.modelId.
     *
     * One scene can hold several models and each numbers its nodes from zero, so
     * without a prefix the second model's `imported_4` is the first one's
     * `imported_4`: one tree row for two meshes, and a pin that resolves to the
     * wrong geometry. Callers pass sceneModelPrefix(hash), which is the same on
     * every client — see lib/scene/roomScene.ts.
     */
    treePrefix?: string;
}

/** Tips a Z-up CAD model onto three.js's Y-up frame. See UP_AXIS_BY_EXTENSION. */
const Z_UP_TO_Y_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

const baseNameOf = (file: File): string => file.name.replace(/\.[^/.]+$/, '');

/**
 * The material a model gets when its file did not bring one.
 *
 * STL and PLY carry nothing but triangles, an OBJ carries an MTL this loader does not
 * read, and a CAD kernel hands back faces with a colour and no shading model at all.
 * What they must not get is three's default: a mesh built with no material is a white,
 * unlit `MeshBasicMaterial`, which reads as a placeholder and leaves the person who
 * uploaded the file no way to tell whether their file is wrong or the viewer is.
 *
 * Light grey, rough and barely metallic — the neutral clay a product is shown in when
 * nobody has decided what it is made of. One factory so an STL, a PLY and a materialless
 * mesh inside a FBX all answer the same way, and so a change to it changes all three.
 */
const neutralModelMaterial = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.7, 0.7, 0.75),
    metalness: 0.1,
    roughness: 0.6,
    side: THREE.DoubleSide
});

const convertToStandardMaterial = (material: THREE.Material): THREE.MeshStandardMaterial => {
    // If already a MeshStandardMaterial or MeshPhysicalMaterial, just ensure proper settings
    if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
        material.side = THREE.DoubleSide;
        material.needsUpdate = true;
        return material as THREE.MeshStandardMaterial;
    }

    // Create a new MeshStandardMaterial with properties from the original
    const newMaterial = new THREE.MeshStandardMaterial({
        side: THREE.DoubleSide,
        metalness: 0.2,
        roughness: 0.6
    });

    // Copy common properties from original material
    if ('color' in material && material.color instanceof THREE.Color) {
        newMaterial.color.copy(material.color);
    }
    if ('map' in material && material.map) {
        newMaterial.map = material.map as THREE.Texture;
    }
    if ('normalMap' in material && material.normalMap) {
        newMaterial.normalMap = material.normalMap as THREE.Texture;
    }
    if ('opacity' in material) {
        newMaterial.opacity = material.opacity as number;
    }
    if ('transparent' in material) {
        newMaterial.transparent = material.transparent as boolean;
    }
    if ('alphaMap' in material && material.alphaMap) {
        newMaterial.alphaMap = material.alphaMap as THREE.Texture;
    }

    newMaterial.needsUpdate = true;
    return newMaterial;
};

const ensureMeshMaterial = (mesh: THREE.Mesh) => {
    if (!mesh.material) {
        mesh.material = neutralModelMaterial();
        return;
    }

    // Convert materials to MeshStandardMaterial if they don't respond to lights
    if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(mat => {
            // MeshBasicMaterial and similar don't respond to lights
            if (mat instanceof THREE.MeshBasicMaterial ||
                mat instanceof THREE.MeshLambertMaterial ||
                mat instanceof THREE.MeshPhongMaterial) {
                return convertToStandardMaterial(mat);
            }
            mat.side = THREE.DoubleSide;
            return mat;
        });
    } else {
        // Single material
        if (mesh.material instanceof THREE.MeshBasicMaterial ||
            mesh.material instanceof THREE.MeshLambertMaterial ||
            mesh.material instanceof THREE.MeshPhongMaterial) {
            mesh.material = convertToStandardMaterial(mesh.material);
        } else {
            mesh.material.side = THREE.DoubleSide;
        }
    }
};

const hasRenderableDescendant = (object: THREE.Object3D): boolean => {
    if (object instanceof THREE.Mesh) return true;
    return object.children.some(child => hasRenderableDescendant(child));
};

const FALLBACK_NAME = /^(Mesh|Group) \d+$/;

/**
 * Exporters wrap parts in groups that hold exactly one thing: Sketchfab-style
 * GLBs nest every model six levels deep ("Sketchfab_model" > "root" > ...),
 * and CAD exports put each mesh in a same-named group ("Hook Left" > "Hook
 * Left"). Each such group is shown as its only child instead, so the tree reads
 * as the product rather than the file. The child keeps its id (that is what the
 * 3D objects carry), and takes the group's name when its own is a placeholder.
 * Collapsed groups simply have no row; their meshes are still reachable.
 */
export const collapseSingleChildGroups = (node: SceneNode): SceneNode => {
    let current = node;
    while (current.type === 'GROUP' && current.children?.length === 1) {
        const only = current.children[0];
        current = FALLBACK_NAME.test(only.name) ? { ...only, name: current.name } : only;
    }
    return current;
};

export const buildSceneTree = (
    object: THREE.Object3D,
    counter: { value: number },
    prefix: string = 'imported'
): SceneNode | null => {
    if (!hasRenderableDescendant(object)) return null;

    const index = counter.value++;
    const id = `${prefix}_${index}`;
    object.userData.modelId = id;
    object.userData.nodeId = id;

    const isMesh = object instanceof THREE.Mesh;
    const fallbackName = isMesh ? `Mesh ${index + 1}` : `Group ${index + 1}`;
    const name = object.name && object.name.trim().length > 0 ? object.name : fallbackName;

    const node: SceneNode = {
        id,
        name,
        type: isMesh ? 'MESH' : 'GROUP'
    };

    const children = object.children
        .map(child => buildSceneTree(child, counter, prefix))
        .filter((child): child is SceneNode => Boolean(child))
        .map(collapseSingleChildGroups);

    if (children.length > 0) {
        node.children = children;
    }

    return node;
};

/**
 * Tag a material's COLOUR textures as sRGB.
 *
 * A texture is either colour or data, and the renderer has to be told which: colour is
 * stored gamma-encoded and must be decoded before it is lit, data (a normal map, a
 * roughness map) is a number and must be sampled raw. GLTFLoader tags its own — that is
 * why an imported GLB looks right — and none of the other readers here does, so an FBX
 * with a diffuse texture, a 3MF, a Collada, a TDS or a VRML file comes in with its colour
 * map treated as data. The result is a model that looks washed out and slightly grey,
 * which is exactly the "not great at keeping the textures" this batch was raised for and
 * exactly the kind of wrong that reads as "the file is bad".
 *
 * Only `map` and `emissiveMap`, and only downwards: a texture already tagged sRGB is
 * left alone, and the data maps are not touched at all — tagging a normal map sRGB would
 * be a worse bug than the one this fixes.
 */
const ensureSrgbColorTextures = (material: THREE.Material | THREE.Material[]) => {
    for (const one of Array.isArray(material) ? material : [material]) {
        // MeshPhysicalMaterial extends MeshStandardMaterial, so this covers both, and
        // it is the right gate: ensureMeshMaterial has already converted every unlit
        // material that was going to be converted, and anything left is either one of
        // these or something with no colour map to tag.
        if (!(one instanceof THREE.MeshStandardMaterial)) continue;
        for (const texture of [one.map, one.emissiveMap]) {
            if (!texture || texture.colorSpace === THREE.SRGBColorSpace) continue;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
        }
    }
};

const applySceneDefaults = (root: THREE.Object3D) => {
    root.traverse(child => {
        if (child instanceof THREE.Mesh) {
            child.castShadow = true;
            child.receiveShadow = true;
            ensureMeshMaterial(child);
            // After the conversion, so a material that was a Phong with a diffuse map is
            // tagged on the MeshStandardMaterial it became — convertToStandardMaterial
            // copies the texture by reference, and the reference is what carries the tag.
            ensureSrgbColorTextures(child.material);
            if (child.geometry && !child.geometry.attributes.normal) {
                child.geometry.computeVertexNormals();
            }
        }
    });
};

const centerModel = (root: THREE.Group): { baseScale: number; basePosition: THREE.Vector3; size: { x: number; y: number; z: number } } => {
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    root.position.sub(center);
    const basePosition = root.position.clone();

    const baseScale = maxDim > 0 ? 2 / maxDim : 1;

    return { baseScale, basePosition, size: { x: size.x, y: size.y, z: size.z } };
};

const loadGLTF = async (file: File): Promise<THREE.Object3D> => {
    const loader = new GLTFLoader();
    // Meshopt-compressed GLBs (EXT_meshopt_compression, e.g. gltfpack output and
    // the bundled bicycle) fail outright without a decoder. The built-in models
    // get one from drei's useGLTF; imports have to wire it themselves.
    loader.setMeshoptDecoder(MeshoptDecoder);
    const arrayBuffer = await file.arrayBuffer();

    return new Promise((resolve, reject) => {
        loader.parse(
            arrayBuffer,
            '',
            gltf => resolve(gltf.scene || gltf.scenes[0]),
            error => reject(error)
        );
    });
};

const loadOBJ = async (file: File): Promise<THREE.Object3D> => {
    const loader = new OBJLoader();
    const text = await file.text();
    return loader.parse(text);
};

const loadFBX = async (file: File): Promise<THREE.Object3D> => {
    const loader = new FBXLoader();
    const arrayBuffer = await file.arrayBuffer();
    return loader.parse(arrayBuffer, '');
};

/** Geometry-only formats (STL, PLY) carry no material: give them the neutral grey. */
const meshFromGeometry = (geometry: THREE.BufferGeometry, name: string): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, neutralModelMaterial());
    mesh.name = name;
    return mesh;
};

const loadSTL = async (file: File): Promise<THREE.Object3D> => {
    const loader = new STLLoader();
    const arrayBuffer = await file.arrayBuffer();
    return meshFromGeometry(loader.parse(arrayBuffer), baseNameOf(file));
};

// Imported on demand, not at module scope: none of these are needed until a
// file of that format is opened, and VRMLLoader alone pulls in a parser
// generator (chevrotain) that has no business sitting in the main bundle.
const load3MF = async (file: File): Promise<THREE.Object3D> => {
    const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
    return new ThreeMFLoader().parse(await file.arrayBuffer());
};

const loadPLY = async (file: File): Promise<THREE.Object3D> => {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    return meshFromGeometry(new PLYLoader().parse(await file.arrayBuffer()), baseNameOf(file));
};

const loadDAE = async (file: File): Promise<THREE.Object3D> => {
    const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
    // Textures would be sibling files; an uploaded .dae carries only what is in
    // the XML, so the empty path leaves them unresolved rather than fetching.
    return new ColladaLoader().parse(await file.text(), '').scene;
};

const load3DS = async (file: File): Promise<THREE.Object3D> => {
    const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js');
    // Same as .dae: material colours and geometry survive, external textures
    // referenced by the file cannot be resolved from a single upload.
    return new TDSLoader().parse(await file.arrayBuffer(), '');
};

const loadVRML = async (file: File): Promise<THREE.Object3D> => {
    const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js');
    return new VRMLLoader().parse(await file.text(), '');
};

const loadAMF = async (file: File): Promise<THREE.Object3D> => {
    const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js');
    return new AMFLoader().parse(await file.arrayBuffer());
};

/** STEP / IGES / BREP: tessellated by OpenCascade in a Web Worker, then rebuilt as an assembly. */
const loadCAD = async (file: File, extension: string): Promise<THREE.Object3D> => {
    const result = await readCadFile(file, CAD_READER_BY_EXTENSION[extension]);
    return cadResultToGroup(result, baseNameOf(file));
};

export const validateModelFile = (file: File): string | null => {
    const extension = modelFileExtension(file.name);

    // Recognised only to say what to do: there is no open-source reader for these.
    if (isNativeCadExtension(extension)) {
        return NATIVE_CAD_MESSAGE;
    }

    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
        return INVALID_FILE_TYPE_MESSAGE;
    }

    if (file.size > maxFileSizeFor(extension)) {
        return maxFileSizeMessage(extension);
    }

    return null;
};

export async function parseModelFile(file: File, options: ParseModelOptions = {}): Promise<ModelImportResult> {
    const extension = modelFileExtension(file.name);

    let loadedObject: THREE.Object3D;

    switch (extension) {
        case '.glb':
        case '.gltf':
            loadedObject = await loadGLTF(file);
            break;
        case '.obj':
            loadedObject = await loadOBJ(file);
            break;
        case '.fbx':
            loadedObject = await loadFBX(file);
            break;
        case '.stl':
            loadedObject = await loadSTL(file);
            break;
        case '.3mf':
            loadedObject = await load3MF(file);
            break;
        case '.ply':
            loadedObject = await loadPLY(file);
            break;
        case '.dae':
            loadedObject = await loadDAE(file);
            break;
        case '.3ds':
            loadedObject = await load3DS(file);
            break;
        case '.wrl':
        case '.vrml':
            loadedObject = await loadVRML(file);
            break;
        case '.amf':
            loadedObject = await loadAMF(file);
            break;
        case '.step':
        case '.stp':
        case '.iges':
        case '.igs':
        case '.brep':
        case '.brp':
            loadedObject = await loadCAD(file, extension);
            break;
        default:
            // Remote clients land here straight from the socket bytes, without
            // having gone through validateModelFile, so say the useful thing.
            throw new Error(isNativeCadExtension(extension) ? NATIVE_CAD_MESSAGE : INVALID_FILE_TYPE_MESSAGE);
    }

    if (upAxisFor(extension) === 'z') {
        // CAD kernels are Z-up, three.js is Y-up. Applied in the parent frame,
        // before centring, so the bounding box matches what the user sees.
        loadedObject.applyQuaternion(Z_UP_TO_Y_UP);
    }

    const rootGroup = new THREE.Group();
    rootGroup.name = baseNameOf(file);
    // A cast, not @ts-expect-error: @pmndrs/pointer-events augments Object3D via
    // `declare module 'three'`, giving a dual identity with src/core/Object3D under
    // @types/three's dual entry points, and the polymorphic `this` on applyQuaternion
    // makes the two mutually unassignable. Whether that clash is visible depends on
    // which modules the program pulls in, so a directive here is "unused" in some
    // builds and required in others (it broke a typecheck on 2026-09-22). Both are
    // THREE.Object3D instances at runtime.
    rootGroup.add(loadedObject as unknown as THREE.Object3D);

    applySceneDefaults(rootGroup);

    const { baseScale, basePosition, size } = centerModel(rootGroup);

    const counter = { value: 0 };
    const sceneTree = buildSceneTree(rootGroup, counter, options.treePrefix ?? 'imported') ?? {
        id: `${options.treePrefix ?? 'imported'}_root`,
        name: rootGroup.name,
        type: 'GROUP'
    };

    return {
        root: rootGroup,
        sceneTree,
        fileName: file.name,
        baseScale,
        basePosition,
        size
    };
}

export function generateObjectStates(node: SceneNode, states: Record<string, ObjectState> = {}): Record<string, ObjectState> {
    states[node.id] = {
        id: node.id,
        visible: true,
        selected: false,
        expanded: true
    };

    if (node.children) {
        node.children.forEach(child => generateObjectStates(child, states));
    }

    return states;
}
