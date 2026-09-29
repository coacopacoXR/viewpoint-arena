// The single source of truth for which 3D files this app accepts.
//
// Everything that names a format reads it from here: both file pickers
// (components/UI/SceneTree.tsx, pages/ReviewSetupPage.tsx), the validation and
// dispatch in utils/modelLoader.ts, and the MIME lookup used when a model is
// re-created from bytes on a remote client (lib/usePartyPresence.ts). The lists
// were duplicated in four places before, and had already drifted.
//
// Nothing here imports three.js or a worker, so a picker can take the accept
// string without pulling in the loaders.

/** Formats three.js reads on its own (utils/modelLoader.ts). */
export const MESH_EXTENSIONS = [
    '.glb', '.gltf', '.obj', '.fbx', '.stl',
    '.3mf', '.ply', '.dae', '.3ds', '.wrl', '.vrml', '.amf'
];

/**
 * B-rep CAD formats, tessellated by OpenCascade (occt-import-js) in a Web
 * Worker — see utils/cadWorker.ts. Nothing of OpenCascade loads until one of
 * these is actually opened.
 */
export const CAD_EXTENSIONS = ['.step', '.stp', '.iges', '.igs', '.brep', '.brp'];

export const SUPPORTED_EXTENSIONS = [...MESH_EXTENSIONS, ...CAD_EXTENSIONS];

/**
 * Native proprietary CAD formats. No open-source reader exists for any of them,
 * so they are recognised only to say what to do instead. They are deliberately
 * NOT in SUPPORTED_EXTENSIONS and never offered in a file picker.
 */
export const NATIVE_CAD_EXTENSIONS = [
    '.sldprt', '.sldasm',                    // SolidWorks
    '.catpart', '.catproduct',               // CATIA
    '.prt',                                  // NX and Creo
    '.asm',                                  // Creo
    '.ipt', '.iam',                          // Inventor
    '.x_t', '.x_b',                          // Parasolid
    '.jt'                                    // JT
];

export const NATIVE_CAD_MESSAGE =
    'This is a native CAD file. Export it as STEP (AP214/AP242) from your CAD system, ' +
    'or connect your PLM system, which can convert it.';

export const INVALID_FILE_TYPE_MESSAGE =
    `Invalid file type. Supported formats: ${SUPPORTED_EXTENSIONS.map(ext => ext.slice(1).toUpperCase()).join(', ')}.`;

/** Both cases: the pickers listed .GLB alongside .glb before, so keep that. */
export const MODEL_FILE_ACCEPT = SUPPORTED_EXTENSIONS
    .flatMap(ext => [ext, ext.toUpperCase()])
    .join(',');

const MAX_MESH_FILE_BYTES = 50 * 1024 * 1024;
/** A STEP assembly is mostly text and routinely outgrows 50 MB. */
const MAX_CAD_FILE_BYTES = 200 * 1024 * 1024;

export const isCadExtension = (extension: string): boolean => CAD_EXTENSIONS.includes(extension);

export const isNativeCadExtension = (extension: string): boolean => NATIVE_CAD_EXTENSIONS.includes(extension);

export const maxFileSizeFor = (extension: string): number =>
    isCadExtension(extension) ? MAX_CAD_FILE_BYTES : MAX_MESH_FILE_BYTES;

export const maxFileSizeMessage = (extension: string): string =>
    `File too large. Maximum size is ${maxFileSizeFor(extension) / (1024 * 1024)}MB.`;

export type UpAxis = 'y' | 'z';

/**
 * Which axis points up in the file's own coordinate system. CAD kernels are
 * Z-up, three.js is Y-up, so CAD imports are tipped −90° about X after loading
 * (utils/modelLoader.ts). This is the only place that decides; change it here
 * if a source turns out to export Y-up.
 */
export const UP_AXIS_BY_EXTENSION: Record<string, UpAxis> = Object.fromEntries(
    CAD_EXTENSIONS.map(ext => [ext, 'z' as UpAxis])
);

export const DEFAULT_UP_AXIS: UpAxis = 'y';

export const upAxisFor = (extension: string): UpAxis => UP_AXIS_BY_EXTENSION[extension] ?? DEFAULT_UP_AXIS;

/** Dotted, lower-cased extension: '.STEP' → '.step'. Empty when there is none. */
export const modelFileExtension = (fileName: string): string => {
    const lower = fileName.toLowerCase();
    const dot = lower.lastIndexOf('.');
    return dot <= 0 ? '' : lower.slice(dot);
};

/**
 * The MIME type is cosmetic — parseModelFile dispatches on the extension — but
 * a remote client rebuilds the File from base64 bytes and the browser wants a
 * type. Every supported extension has an entry; the fallback covers the rest.
 */
export const MODEL_MIME_TYPES: Record<string, string> = {
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.obj': 'text/plain',
    '.fbx': 'application/octet-stream',
    '.stl': 'application/octet-stream',
    '.3mf': 'model/3mf',
    '.ply': 'application/octet-stream',
    '.dae': 'model/vnd.collada+xml',
    '.3ds': 'application/octet-stream',
    '.wrl': 'model/vrml',
    '.vrml': 'model/vrml',
    '.amf': 'application/octet-stream',
    '.step': 'model/step',
    '.stp': 'model/step',
    '.iges': 'model/iges',
    '.igs': 'model/iges',
    '.brep': 'application/octet-stream',
    '.brp': 'application/octet-stream'
};

export const modelFileMime = (fileName: string): string =>
    MODEL_MIME_TYPES[modelFileExtension(fileName)] ?? 'application/octet-stream';
