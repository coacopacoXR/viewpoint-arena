// Types for occt-import-js (https://github.com/kovacsv/occt-import-js), which
// ships no TypeScript declarations. Only the surface this repo uses is
// declared: the module factory, the three readers, and the JSON they return.
// Field names come from the package README and from the `Set ("...")` calls in
// its own occt-import-js/src/js-interface.cpp.
//
// Licence: occt-import-js is LGPL-2.1 (OpenCascade compiled to WebAssembly).
// It is used unmodified and loaded as its own file by a Web Worker
// (utils/cadWorker.ts), which is how the LGPL is met alongside this project's
// Apache-2.0 licence. See THIRD_PARTY.md.
declare module 'occt-import-js' {
    /** Unit the tessellated geometry is returned in. Has no effect on BREP input. */
    export type OcctLinearUnit = 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';

    /** What `linearDeflection` means: a ratio of the bounding box, or an absolute value. */
    export type OcctLinearDeflectionType = 'bounding_box_ratio' | 'absolute_value';

    export interface OcctTessellationParams {
        linearUnit?: OcctLinearUnit;
        linearDeflectionType?: OcctLinearDeflectionType;
        linearDeflection?: number;
        angularDeflection?: number;
    }

    /** r, g, b in 0..1. Null/absent means the source carried no colour. */
    export type OcctColor = number[];

    export interface OcctAttribute {
        array: number[];
    }

    export interface OcctAttributes {
        position: OcctAttribute;
        /** Present only when every vertex has a normal. */
        normal?: OcctAttribute;
    }

    /**
     * One b-rep face of the source solid, as the triangle range it tessellated
     * to: triangles `first..last` inclusive (triangle indices, not index-array
     * offsets, so a three.js group starts at `first * 3`).
     */
    export interface OcctBrepFace {
        first: number;
        last: number;
        color: OcctColor | null;
    }

    export interface OcctMesh {
        name: string;
        color?: OcctColor;
        brep_faces?: OcctBrepFace[];
        attributes: OcctAttributes;
        index: OcctAttribute;
    }

    /** A node of the assembly tree; `meshes` holds indices into the flat mesh array. */
    export interface OcctNode {
        name: string;
        meshes: number[];
        children: OcctNode[];
    }

    export interface OcctImportResult {
        success: boolean;
        root: OcctNode;
        meshes: OcctMesh[];
    }

    export interface OcctInstance {
        ReadStepFile(content: Uint8Array, params: OcctTessellationParams | null): OcctImportResult;
        ReadIgesFile(content: Uint8Array, params: OcctTessellationParams | null): OcctImportResult;
        ReadBrepFile(content: Uint8Array, params: OcctTessellationParams | null): OcctImportResult;
    }

    export interface OcctModuleArgs {
        /** Resolves the .wasm file; Vite gives us its URL via `?url`. */
        locateFile?: (path: string, scriptDirectory: string) => string;
    }

    const occtimportjs: (moduleArgs?: OcctModuleArgs) => Promise<OcctInstance>;

    export default occtimportjs;
}
