// Bridge augmentation for @types/three dual-identity issue.
//
// NOTE: this file must keep the `.ts` extension, NOT `.d.ts`. With
// `moduleDetection: "force"` in tsconfig.json, a `.ts` file is a module, so
// the block below is a module *augmentation*. Renaming it to `.d.ts` turns it
// into an ambient module *declaration* that replaces rather than extends the
// real types, and `npm run typecheck` fails with 10 errors. Verified.
//
// @pmndrs/pointer-events (pulled in by @react-three/xr) augments Object3D via
// `declare module 'three'`, which under @types/three's dual entry-point
// resolution (exports → build/three.module.d.ts vs types → index.d.ts → src/)
// only applies to the build/three.module module identity. The original class
// declaration at src/core/Object3D does NOT receive those members, causing
// TS2345 errors when Group (which inherits the augmented identity) is passed
// where src/core/Object3D is expected.
//
// This file adds the same members to the src/core/Object3D identity so that
// Group (which extends src/core/Object3D's class) inherits them too.
declare module 'three/src/core/Object3D.js' {
    interface Object3D {
        setPointerCapture(pointerId: number): void;
        releasePointerCapture(pointerId: number): void;
        hasPointerCapture(pointerId: number): boolean;
    }
}
