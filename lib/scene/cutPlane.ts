// The room's cut plane, as renderer state — task 08a.
//
// WHAT THIS OWNS. One `THREE.Plane`, the flag that says whether the room is cutting,
// the single function that puts a model material onto that plane (and takes it off
// again), and the predicate that says whether a point in the world is on the side the
// cut has taken away. `lib/scene/viewTools.ts` is the shared VALUE — the axis, the
// normalised position, the flip — and this is the shared MECHANISM that turns it into
// something three draws and something a raycast can be filtered by.
//
// ONE PLANE INSTANCE, AND WHY THAT IS THE WHOLE DESIGN. A material's clipping planes
// are read by `WebGLClipping.setState` on EVERY draw (three r181, WebGLRenderer's
// `setProgram`), which projects them into view space and uploads the uniform. So moving
// the cut is a write to one Plane's normal and constant plus an `invalidate()`: no
// material is touched, nothing is marked `needsUpdate`, and no shader is recompiled
// while a slider is being dragged. What DOES recompile is the count — three folds
// `numClippingPlanes` into its `needsProgramChange` test and into the program cache key —
// so turning the cut on or off costs one compile per distinct model material and moving
// it costs nothing at all. That is the trade this file is built around, and it is why the
// plane is a module-level constant rather than something a component owns.
//
// LOCAL CLIPPING, NOT GLOBAL. `renderer.clippingPlanes` would cut the room, the floor,
// the avatars, the lasers, the comment pins and the gizmos along with the product, and
// the one thing a section view has to leave alone is the thing you are standing in. So
// this uses `renderer.localClippingEnabled` and `material.clippingPlanes`, and only the
// materials of the models are ever handed the plane — see `applyCut`, which walks a
// model's own root and nothing else's.
//
// THE CAP. A clipped shell is a hollow one: look into the opening and you see the inside
// of the far wall, which three culls because the material is FrontSide, so you see
// straight through the product to the background behind it. The fix here is back faces
// drawn in a flat cap colour, and it is done in the material's own shader rather than in
// a second object per model:
//
//   • it is the only cap that is correct for a BatchedMesh. A batch draws every one of
//     its instances from ONE material in ONE multi-draw call, so a cap pass would have
//     to be a second BatchedMesh sharing the first one's merged geometry, its instance
//     buffers and its indirect-draw texture — three has no cheap way to build one, and
//     the 3 200- and 10 000-part fixtures this task is measured on are both above
//     `BATCH_MIN_PARTS` (lib/scene/batchedParts.ts) and therefore both batches.
//   • it costs no draw call at all, with the cut ON as well as OFF. `side` becomes
//     DoubleSide and the fragment shader paints a back face in the cap colour, so the
//     model is still one draw per material and the interior is closed. `side` is GL
//     state and not program state — `WebGLRenderer.setMaterial` turns face culling off
//     for it — so the cap adds nothing to the compile the clipping already forces.
//
// The price is fill rate: back faces that were culled are now rasterised, and the ones
// the depth test throws away still cost a fragment shader. That is the number the orbit
// benchmark in this task's report measures.
//
// THREE r181, AND THE TWO THINGS THAT ARE NOT GUESSABLE ABOUT IT:
//
//   • Three clips the NEGATIVE side. Its own rule for `Material.clippingPlanes` is that
//     a point whose signed distance to the plane (`normal · p + constant`) is negative is
//     not rendered, and `clipping_planes_fragment.glsl.js` implements exactly that. So the
//     plane's normal points INTO the part of the model that stays, and `isCutAway` below
//     asks the same question the shader does rather than a similar one.
//   • `defines` is the only channel that reaches the FRAGMENT prefix. `USE_BATCHING` is
//     defined in the vertex prefix alone, and `onBeforeCompile` runs after the prefixes
//     are built, so a patch that needs a `#define` in the fragment shader carries its own
//     through `material.defines` — the same trick lib/scene/materialHighlight.ts's
//     per-instance glow uses, and the reason a patched material never shares a program
//     with an unpatched one (`getProgramCacheKey` folds `defines` into the key).

import {
  Box3,
  Color,
  DoubleSide,
  Plane,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Side,
} from 'three';
import type { CutAxis, CutPlane } from './viewTools';

/**
 * The ONE plane every model material clips against.
 *
 * Module-level and never replaced: a component that owned it would hand a new Plane to
 * every material each time it re-rendered, which is a `numClippingPlanes` the renderer
 * has to re-read and, worse, a set of materials pointing at a plane nobody updates any
 * more. Its normal and constant are written by `writeCutPlane` and read by three on
 * every draw.
 *
 * Starts parked rather than at the origin, so that a material still holding it after the
 * cut was turned off — one this module never got to walk, because its model left the
 * room first — clips nothing instead of taking a slice out of it.
 */
export const CUT_PLANE = new Plane(new Vector3(-1, 0, 0), Number.MAX_VALUE);

/** Shared one-element array, so enabling the cut allocates nothing per material. */
const PLANES: Plane[] = [CUT_PLANE];

/** The flat colour the section reads as. */
export const CAP_COLOUR = new Color('#9aa0a6');

/** Whether the room is cutting right now. Read by every material handed to `syncCut`. */
let cutting = false;

/** Whether the room is cutting right now. */
export function cutEnabled(): boolean {
  return cutting;
}

/**
 * Say whether the room is cutting.
 *
 * A flag rather than an argument on every call, because the materials that have to
 * answer it are created in places that know nothing about the cut: a highlight clone
 * made by a selection, a batch's glow material made by task 04c's flag path. Handing
 * each of those a parameter is the "patch the call sites one by one" this exists to
 * avoid. `applyCut` is what walks the materials that already exist.
 */
export function setCutEnabled(on: boolean): void {
  cutting = on;
}

/**
 * The unit normal that points INTO the kept side for each axis, before `flip`.
 *
 * Negative on purpose and it is the one sign worth getting right once: three discards a
 * fragment whose signed distance to the plane is negative, so the normal points at what
 * STAYS, and the default cut keeps the negative side of the axis and takes the positive
 * one away — "cut from here outwards", which is what dragging the slider towards the far
 * end of a model means to the person dragging it.
 */
const KEPT_NORMAL: Record<CutAxis, Vector3> = {
  x: new Vector3(-1, 0, 0),
  y: new Vector3(0, -1, 0),
  z: new Vector3(0, 0, -1),
};

/**
 * Write the shared plane for a normalised cut and the bounds it resolves against.
 *
 * `bounds` is the union box of the models this client can see, in world space and
 * UNEXPLODED, so `position` 0 is the near end of them on `axis` and 1 the far end — see
 * lib/scene/viewTools.ts for why the value on the wire is a fraction and not a
 * coordinate. Answers false for a cut there is nothing to resolve against (no model, or
 * a model with no geometry), which is the answer the caller turns into "not cutting".
 */
export function writeCutPlane(cut: CutPlane | null, bounds: Box3): boolean {
  if (!cut || bounds.isEmpty()) {
    CUT_PLANE.normal.set(-1, 0, 0);
    CUT_PLANE.constant = Number.MAX_VALUE;
    return false;
  }
  const min = cut.axis === 'x' ? bounds.min.x : cut.axis === 'y' ? bounds.min.y : bounds.min.z;
  const max = cut.axis === 'x' ? bounds.max.x : cut.axis === 'y' ? bounds.max.y : bounds.max.z;
  const at = min + (max - min) * cut.position;
  CUT_PLANE.normal.copy(KEPT_NORMAL[cut.axis]);
  if (cut.flip) CUT_PLANE.normal.negate();
  // distanceToPoint = normal · p + constant, and the kept side answers zero or more. With
  // the normal along -axis that constant is `at`; flipped, both change sign together.
  CUT_PLANE.constant = cut.flip ? -at : at;
  return true;
}

/**
 * Whether a point in world space is on the side the cut has taken away.
 *
 * The same question the fragment shader asks, with the same sign, and it is exported
 * because three's `Raycaster` cannot ask it: it tests geometry and never looks at a
 * material's clipping planes, so a ray goes straight through the part of a model the
 * renderer is not drawing and reports a hit on a face nobody can see. Every pick path
 * filters its hits through this — see lib/scene/cutPick.ts.
 */
export function isCutAway(point: Vector3): boolean {
  return cutting && CUT_PLANE.distanceToPoint(point) < 0;
}

/** What `syncCut` remembers on a material it patched, under `CUT_CAP_KEY`. */
interface CutCapState {
  side: Side;
  onBeforeCompile: Material['onBeforeCompile'];
  wrapper: Material['onBeforeCompile'];
}

const CUT_CAP_KEY = 'viewpointCutCap';

/** What three hands `onBeforeCompile`, named without importing three's internal type. */
type ShaderSource = Parameters<Material['onBeforeCompile']>[0];

/**
 * The define the fragment half of the cap is guarded by.
 *
 * Carried through `material.defines` for the reason materialHighlight.ts gives: it is
 * the only channel that reaches the fragment prefix, and `getProgramCacheKey` reads it,
 * so a capped material never shares a program with an uncapped one.
 */
const CAP_DEFINE = 'USE_VIEWPOINT_CUT_CAP';
const CAP_UNIFORM = 'viewpointCutCap';

/**
 * The anchors this patch replaces itself with, in the ShaderLib sources of every family
 * that declares a `diffuseColor` — which is every one that draws a surface (meshbasic,
 * meshlambert, meshphong, meshtoon, meshphysical, meshmatcap; verified against
 * node_modules/three/src/renderers/shaders/ShaderLib, not remembered).
 */
const COMMON_ANCHOR = '#include <common>';
const DIFFUSE_ANCHOR = 'vec4 diffuseColor = vec4( diffuse, opacity );';
// Present on the families that have a specular lobe to kill. Optional on purpose: a cap
// that is matte on a Standard material and lit on a Lambert one is still a cap.
const ROUGHNESS_ANCHOR = '#include <roughnessmap_fragment>';
const METALNESS_ANCHOR = '#include <metalnessmap_fragment>';

const CAP_PARS = `
#ifdef ${CAP_DEFINE}
  uniform vec3 ${CAP_UNIFORM};
#endif`;

/**
 * A back face IS the cut face, so it reads as a section rather than as the inside of a
 * shell: one flat colour for every family, with the file's own texture and vertex colour
 * taken off it. `diffuseColor.a` is kept rather than replaced, because a material the
 * file made translucent has to stay translucent — an opaque cap on a glass housing would
 * be a solid where the product is not.
 */
const CAP_DIFFUSE = `
#ifdef ${CAP_DEFINE}
  if ( ! gl_FrontFacing ) {
    diffuseColor = vec4( ${CAP_UNIFORM}, diffuseColor.a );
  }
#endif`;

const CAP_ROUGHNESS = `
#ifdef ${CAP_DEFINE}
  if ( ! gl_FrontFacing ) { roughnessFactor = 1.0; }
#endif`;
const CAP_METALNESS = `
#ifdef ${CAP_DEFINE}
  if ( ! gl_FrontFacing ) { metalnessFactor = 0.0; }
#endif`;

/**
 * Write the cap into one program's source.
 *
 * A family with no `diffuseColor` to replace is left alone rather than half-patched: the
 * clipping half still works, because that is three's own chunk and not this one, and a
 * cap that cannot be drawn is a shell — the same thing it was before. Nothing logs,
 * because the answer is a property of the material's family and not of anything that went
 * wrong at runtime.
 */
function injectCutCap(shader: ShaderSource): void {
  const fragment = shader.fragmentShader;
  if (!fragment.includes(COMMON_ANCHOR) || !fragment.includes(DIFFUSE_ANCHOR)) return;

  shader.fragmentShader = fragment
    .replace(COMMON_ANCHOR, `${COMMON_ANCHOR}${CAP_PARS}`)
    .replace(DIFFUSE_ANCHOR, `${DIFFUSE_ANCHOR}${CAP_DIFFUSE}`)
    .replace(ROUGHNESS_ANCHOR, `${ROUGHNESS_ANCHOR}${CAP_ROUGHNESS}`)
    .replace(METALNESS_ANCHOR, `${METALNESS_ANCHOR}${CAP_METALNESS}`);

  shader.uniforms[CAP_UNIFORM] = { value: CAP_COLOUR };
}

/**
 * Put one model material on the cut plane, or take it off it — cap and all.
 *
 * THE ONE PLACE A MATERIAL MEETS THE CUT. It is called by the walk over a model's root
 * (`applyCut`), by `HighlightMaterials.of` for every clone it hands out, and by task
 * 04c's `partHighlightMaterial` for the batch glow clone: three sites, one rule, and a
 * material created after the cut was turned on is covered by whichever of them made it
 * rather than by a caller remembering.
 *
 * Idempotent in the strong sense that matters here — it can be called again after
 * somebody else has replaced `onBeforeCompile` underneath it, and it re-wraps the NEW
 * function rather than restoring over it. The test is on the wrapper's IDENTITY and not
 * on a boolean, which is what makes a clobber visible instead of silent, and it is what
 * lets this sit at the end of `partHighlightMaterial`: that function assigns its own
 * per-instance-glow patch AFTER `highlightClone` has already run.
 */
export function syncCut(material: Material | null | undefined): void {
  if (!material || !material.userData) return;
  const installed = material.userData[CUT_CAP_KEY] as CutCapState | undefined;
  const withDefines = material as Material & { defines?: Record<string, unknown> };

  if (!cutting) {
    material.clippingPlanes = null;
    // Guarded rather than rebuilt: this runs for every material of every model on every
    // step of a slider drag, and a spread that produced the same object it replaced would
    // be an allocation per material per frame for nothing.
    if (withDefines.defines && CAP_DEFINE in withDefines.defines) {
      const { [CAP_DEFINE]: _gone, ...rest } = withDefines.defines;
      withDefines.defines = rest;
    }
    if (!installed) return;
    material.side = installed.side;
    material.onBeforeCompile = installed.onBeforeCompile;
    delete material.userData[CUT_CAP_KEY];
    return;
  }

  material.clippingPlanes = PLANES;
  if (!withDefines.defines || !(CAP_DEFINE in withDefines.defines)) {
    withDefines.defines = { ...withDefines.defines, [CAP_DEFINE]: '' };
  }
  // Already patched, and nothing has replaced the patch since.
  if (installed && material.onBeforeCompile === installed.wrapper) return;

  const inner = material.onBeforeCompile;
  const wrapper = (shader: ShaderSource, renderer: unknown): void => {
    inner.call(material, shader, renderer as never);
    injectCutCap(shader);
  };
  material.userData[CUT_CAP_KEY] = {
    // The side and the function as they were before THIS module first touched the
    // material, so taking the cut off gives back exactly what the file brought.
    side: installed?.side ?? material.side,
    onBeforeCompile: installed?.onBeforeCompile ?? inner,
    wrapper,
  };
  // DoubleSide is what makes the cap exist at all: the back faces are the cap.
  material.side = DoubleSide;
  material.onBeforeCompile = wrapper;
}

/**
 * Put every material of one model on the cut plane, or take them all off it.
 *
 * Walks the model's OWN root and nothing else's, which is the whole of "only the models
 * are cut": the room, the floor, the grid, the avatars, the lasers, the pins and the
 * gizmos are siblings of the models in the scene graph and this never sees them. Answers
 * how many materials it wrote, which is the number the rendering test asserts on rather
 * than on a picture.
 *
 * Reaches every material a part of this model can be drawn with, including the ones
 * batching hides: a BatchedMesh's own material, the overlay meshes task 04b raises for a
 * highlighted part (children of the batch, so the walk finds them), the clone a selection
 * swapped onto a mesh that batching left alone, and task 04c's glow material, which is
 * `batch.mesh.material` while any of its slots is flagged. Multi-material parts are an
 * array and every element of it is walked, because the CAD reader splits a solid whose
 * faces differ in colour into a material each.
 */
export function applyCut(root: Object3D | null | undefined): number {
  if (!root || typeof root.traverse !== 'function') return 0;
  let written = 0;
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      syncCut(material);
      written += 1;
    }
  });
  return written;
}
