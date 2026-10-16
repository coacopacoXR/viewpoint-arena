// A highlight that gives the material back what it took — batch BT.
//
// Two paths light a mesh up: a selection in the tree or a click in the 3D view, and
// somebody's laser pointing at it. Both used to write the highlight and then write
// BLACK when the highlight ended, which is right for a material this app authored
// (components/Scene/Product.tsx declares its emissive in JSX, where black IS the
// original) and wrong for a material a file brought with it. A CAD assembly with an
// emissive warning stripe, a glTF whose author gave a lens its own glow, came back
// from one selection permanently dead: the second half of the user's report that
// "it is not great at keeping the textures".
//
// So the original is remembered in `material.userData` the first time a highlight
// touches it, and a highlight that ends restores THAT rather than a constant. It is
// stamped lazily rather than at load: a STEP file can carry tens of thousands of
// materials and at most a handful are ever selected.

import { DataTexture, RedFormat, UnsignedByteType, type Color, type Material, type MeshStandardMaterial } from 'three';

/** Where a material's own emissive is kept once a highlight has touched it. */
export const ORIGINAL_KEY = 'originalEmissive';

/** What a material's file gave it, read back when the highlight ends. */
export interface OriginalEmissive {
  /** A copy, not a reference: the highlight writes into the live colour object. */
  color: Color;
  intensity: number;
}

/** A highlight to apply. Null means "give the material back its own emissive". */
export interface EmissiveHighlight {
  color: Color;
  intensity: number;
}

/**
 * Materials without an emissive channel — points, lines, a basic material.
 *
 * Exported for lib/scene/captureClean.ts, which has to narrow a material before it can
 * compare its live emissive against the one a highlight took off it. The narrowing is a
 * `'emissive' in material` test rather than an instanceof, because the channel arrives on
 * any of the standard-material family — MeshStandardMaterial, MeshPhysicalMaterial, and
 * whatever a glTF extension produced — and not on one named class.
 */
export function emissiveMaterial(material: Material | undefined): MeshStandardMaterial | null {
  if (!material || !('emissive' in material)) return null;
  return material as MeshStandardMaterial;
}

/**
 * The emissive a highlight took off this material, or null when no highlight has ever
 * touched it.
 *
 * READ-ONLY, and that is the whole of the difference from `originalEmissiveOf` below:
 * this does not stamp the material, so a caller that has to ask about every material in
 * the scene — a capture hiding the selection glow, batch BV — can ask about a 40 000-part
 * assembly without writing to the 39 990 of them nobody ever selected.
 */
export function rememberedEmissiveOf(material: Material | undefined): OriginalEmissive | null {
  const mat = emissiveMaterial(material);
  if (!mat) return null;
  const stored = mat.userData[ORIGINAL_KEY] as OriginalEmissive | undefined;
  return stored ?? null;
}

/**
 * This material's own emissive, remembered the first time it is asked for.
 *
 * Null for a material that has no emissive channel at all, which is the answer every
 * caller wants: there is nothing to highlight and nothing to give back.
 */
export function originalEmissiveOf(material: Material | undefined): OriginalEmissive | null {
  const mat = emissiveMaterial(material);
  if (!mat) return null;
  const remembered = rememberedEmissiveOf(mat);
  if (remembered) return remembered;
  const original: OriginalEmissive = { color: mat.emissive.clone(), intensity: mat.emissiveIntensity };
  mat.userData[ORIGINAL_KEY] = original;
  return original;
}

/**
 * Apply a highlight, or take it off.
 *
 * Both halves in one function because they are the two ends of one contract: whatever
 * `setEmissiveHighlight(material, glow)` does, `setEmissiveHighlight(material, null)`
 * undoes exactly. A caller that writes the highlight and restores it by hand is the
 * bug this file exists to prevent.
 *
 * `emissiveMap` is deliberately not touched and not restored: no highlight here
 * replaces or clears it, and a map that is still bound keeps multiplying whatever
 * colour the material ends up with, which is what the file meant.
 */
export function setEmissiveHighlight(
  material: Material | undefined,
  highlight: EmissiveHighlight | null,
): void {
  const mat = emissiveMaterial(material);
  if (!mat) return;
  const original = originalEmissiveOf(mat);
  if (!original) return;
  if (highlight) {
    mat.emissive.copy(highlight.color);
    mat.emissiveIntensity = highlight.intensity;
    return;
  }
  mat.emissive.copy(original.color);
  mat.emissiveIntensity = original.intensity;
}

/**
 * A private copy of `source`, already carrying `highlight` — task 04b stage 2.
 *
 * This is the seam the render audit's decision 1 calls the overlay, and it is the whole
 * of the fix for its D1. A highlight used to be written ONTO the material, and materials
 * are shared: `ensureMeshMaterial` (utils/modelLoader.ts) converts a Basic/Lambert/Phong
 * into a new Standard material but for anything already standard it sets `.side` and
 * hands back the SAME object — so a GLB or a STEP whose 400 bolts share one material had
 * one Material between them, and selecting one bolt glowed all 400. Drawing the selected
 * part from its own clone leaves every other part on the file's material, which is both
 * the fix and the exact look the app has had: same emissive, same intensity, same
 * textures, because Material.copy carries `map` and friends across by reference.
 *
 * The clone is unstamped before the highlight goes on. Material.copy runs `userData`
 * through JSON, which would turn a remembered `originalEmissive` — a THREE.Color — into
 * a plain `{r,g,b}` object that the restore then reads as if it were a colour. A source
 * material is never highlighted itself any more so it has nothing to lose here, but a
 * clone has to start with nothing remembered so that `setEmissiveHighlight` stamps the
 * real Color it will later give back.
 *
 * The CALLER owns the returned material and must dispose it: nothing in the scene graph
 * knows it exists, and components/lobby/ReviewModelViewer's `disposeGroup` walks the
 * live materials of a group, which for a highlighted part is this clone and not the
 * file's own.
 */
export function highlightClone(source: Material, highlight: EmissiveHighlight): Material {
  const clone = source.clone();
  delete clone.userData[ORIGINAL_KEY];
  setEmissiveHighlight(clone, highlight);
  return clone;
}

// ─── the same glow, per instance, inside a batch ────────────────────────────
//
// Task 04c. `highlightClone` is one material per part being drawn, which is what a
// BatchedMesh cannot do: it draws every one of its instances from ONE material in ONE
// multi-draw call, and lib/scene/batchedParts.ts's answer to that is an overlay Mesh per
// highlighted part — bounded by MAX_OVERLAY_PARTS, because an unbounded one puts the draw
// calls batching removed straight back. Past the cap a part has to glow where it already is,
// which means the glow has to be per INSTANCE rather than per material, and the only per
// instance channel a batch has is the one its own shader reads with `gl_DrawID`.
//
// So: a byte per slot in a small DataTexture, and a patch on the material that swaps
// `totalEmissiveRadiance` for the highlight's own value on the instances whose byte is set.
// The result is the same number the overlay draws — `emissive` × `emissiveIntensity`, both
// set by `setEmissiveHighlight`, then multiplied by `emissiveMap` exactly as the chunk after
// the anchor multiplies it — because the clone this returns carries the highlight in its own
// `.emissive` and the patch hands the UNflagged instances the material's remembered original
// instead. Same colour, same intensity, same textures, and captureClean.ts calms it during a
// thumbnail capture for free: it looks for a material whose live emissive differs from the
// one it remembers, which is precisely what this clone is while any of its parts is flagged.
//
// THREE r181, AND THE TWO THINGS THAT ARE NOT GUESSABLE ABOUT IT:
//
//   • `USE_BATCHING` is defined in the VERTEX prefix only (WebGLProgram.js puts
//     `parameters.batching` in `prefixVertex` and not in `prefixFragment`), so a fragment
//     shader cannot test it. The patch therefore carries its own define, `USE_PART_HIGHLIGHT`,
//     which `material.defines` puts in BOTH prefixes and which `getProgramCacheKey` reads, so
//     a patched material never shares a program with an unpatched one.
//   • The instance index is not `gl_DrawID`. A BatchedMesh compacts the visible instances into
//     its indirect-draw list every frame, so draw N is instance `getIndirectIndex(N)` — the
//     lookup three's own `batching_vertex` and `color_vertex` chunks do, and the reason a
//     hidden part's flag can never land on its neighbour.
//
// The anchors are the literal lines this replaces, in the ShaderLib sources of the four
// families that declare an emissive at all (meshphysical, meshlambert, meshphong, meshtoon —
// verified against node_modules/three/src/renderers/shaders/ShaderLib, not remembered). A
// family without them is a family this cannot patch, and `partHighlightMaterial` says so
// rather than drawing a whole batch in the highlight colour.

/** The define both shader prefixes get, which is what makes the fragment half exist at all. */
const PART_HIGHLIGHT_DEFINE = 'USE_PART_HIGHLIGHT';

/** The program cache key a patched material answers, so it never shares an unpatched program. */
const PART_HIGHLIGHT_CACHE_KEY = 'viewpoint-part-highlight';

/** What an UNflagged instance keeps drawing, and the texels that say which are flagged. */
const BASE_EMISSIVE_UNIFORM = 'partBaseEmissive';
const FLAGS_UNIFORM = 'partHighlightTexture';
/**
 * The store's width as a uniform rather than a `textureSize` in the vertex shader: three's own
 * batching chunks ask the texture its size per vertex, and one more of those per vertex of a
 * ten-thousand-part batch is a texture-unit query in the loop that draws the whole model.
 */
const WIDTH_UNIFORM = 'partHighlightWidth';

const VERTEX_PARS_ANCHOR = '#include <batching_pars_vertex>';
const VERTEX_MAIN_ANCHOR = '#include <batching_vertex>';
const FRAGMENT_PARS_ANCHOR = '#include <emissivemap_pars_fragment>';
const FRAGMENT_EMISSIVE_ANCHOR = 'vec3 totalEmissiveRadiance = emissive;';

const VERTEX_PARS = `
#ifdef ${PART_HIGHLIGHT_DEFINE}
  uniform highp sampler2D ${FLAGS_UNIFORM};
  uniform int ${WIDTH_UNIFORM};
  varying float vPartHighlight;
#endif`;

const VERTEX_MAIN = `
#ifdef ${PART_HIGHLIGHT_DEFINE}
  // 0 unless this really is a slot in a batch, and that is what makes the patch a no-op on a
  // material a plain Mesh is also drawing with: the fragment half then mixes all the way back
  // to the material's own emissive and the mesh looks exactly as it did before the patch.
  vPartHighlight = 0.0;
  #ifdef USE_BATCHING
  {
    int partIndex = int( getIndirectIndex( gl_DrawID ) );
    vPartHighlight = float( texelFetch( ${FLAGS_UNIFORM}, ivec2( partIndex % ${WIDTH_UNIFORM}, partIndex / ${WIDTH_UNIFORM} ), 0 ).r );
  }
  #endif
#endif`;

const FRAGMENT_PARS = `
#ifdef ${PART_HIGHLIGHT_DEFINE}
  uniform vec3 ${BASE_EMISSIVE_UNIFORM};
  varying float vPartHighlight;
#endif`;

/**
 * Before `#include <emissivemap_fragment>` and not after it, on purpose: the overlay's clone
 * keeps the file's `emissiveMap` bound, and that chunk multiplies whatever emissive the
 * material ended up with by the map's own texel. Mixing after it would give a flagged part a
 * glow the map does not modulate, which is a different look from the part beside it.
 */
const FRAGMENT_MAIN = `
#ifdef ${PART_HIGHLIGHT_DEFINE}
  totalEmissiveRadiance = mix( ${BASE_EMISSIVE_UNIFORM}, totalEmissiveRadiance, vPartHighlight );
#endif`;

/** What three hands `onBeforeCompile`, named without importing three's internal type. */
type ShaderSource = Parameters<Material['onBeforeCompile']>[0];

/**
 * One batch's per-instance highlight store: a byte per slot, and the layout the patch reads.
 *
 * One byte rather than a float or a colour because a flag is a boolean and the store is sized
 * to the batch: 10 000 slots is 10 KB here and 160 KB as an RGBA float texture that would
 * carry three channels nothing reads. Square, because that is how three sizes its own
 * per-instance textures (`BatchedMesh._initIndirectTexture`), and it keeps a 40 000-slot batch
 * inside a 200 × 200 texture rather than asking for a 40 000-pixel-wide one.
 */
export interface PartHighlightFlags {
  /** Bound as `partHighlightTexture`. Owned by the caller, disposed with the registry. */
  texture: DataTexture;
  /** The texels, flat: slot `i` is byte `i`, which is the indexing the shader does. */
  data: Uint8Array;
  /** The texture's width, bound as `partHighlightWidth` so the shader never has to ask. */
  side: number;
  /** Mark one slot glowing or not, and tell three the texels changed. */
  write(slot: number, glowing: boolean): void;
}

/** The flag store for a batch of `slots` slots, every one of them starting unflagged. */
export function partHighlightFlags(slots: number): PartHighlightFlags {
  const side = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, slots))));
  const data = new Uint8Array(side * side);
  // RedFormat rather than RGBA because the shader reads one channel, and NearestFilter and
  // `unpackAlignment = 1` because DataTexture defaults to both — a flag is fetched by index,
  // never sampled between two of them, and a square side is rarely a multiple of four.
  const texture = new DataTexture(data, side, side, RedFormat, UnsignedByteType);
  return {
    texture,
    data,
    side,
    write(slot: number, glowing: boolean): void {
      data[slot] = glowing ? 255 : 0;
      // The uniform upload that carries this to the GPU happens when the material is refreshed,
      // which three does on the first draw of a material in a pass — and a patched material is
      // one batch's alone, so that is every frame this batch is drawn.
      texture.needsUpdate = true;
    },
  };
}

/**
 * A batch's own glowing material: `source` cloned, carrying `highlight`, patched to read
 * `flags`.
 *
 * Null when there is nothing to glow with — a material with no emissive channel, which is the
 * same answer an overlay gives, because `highlightClone` on it is a plain clone and
 * `setEmissiveHighlight` a no-op — or when three's shader for this family has none of the
 * lines this patch replaces. A caller that gets null leaves the part drawing normally, which
 * is what the cap did before this existed; what it must NOT do is draw the batch with an
 * unpatched clone, because that clone's `.emissive` is the highlight and every instance would
 * wear it. That is the audit's D1 leak, and it is why the fail-safe below restores the
 * clone's own emissive rather than logging and carrying on.
 *
 * The CALLER owns the returned material and must dispose it, exactly as for `highlightClone`:
 * nothing in the scene graph knows a batch's material was replaced, so
 * components/lobby/ReviewModelViewer's `disposeGroup` cannot find it.
 */
export function partHighlightMaterial(
  source: Material,
  highlight: EmissiveHighlight,
  flags: PartHighlightFlags,
): Material | null {
  const clone = highlightClone(source, highlight);
  // Read off the CLONE and never off the source: `originalEmissiveOf(source)` would stamp the
  // file's own material, and stamping is the write this file exists to keep off it — a large
  // assembly has one material between hundreds of parts and only ever needs one answer here.
  // `highlightClone` has just stamped the clone with the clone's own emissive, which is the
  // source's, so the number wanted is already in hand.
  const own = rememberedEmissiveOf(clone);
  if (!own) {
    clone.dispose();
    return null;
  }

  // The base is the uniform three would have uploaded for this material untouched: its own
  // colour times its own intensity, the one product `refreshMaterialUniforms` does.
  const baseEmissive = own.color.clone().multiplyScalar(own.intensity);
  // `defines` is typed on ShaderMaterial alone in @types/three, and the cast is not a dodge:
  // three reads it off ANY material (`WebGLPrograms.getParameters` takes `material.defines`,
  // `WebGLProgram` turns it into `#define`s for BOTH prefixes, and `getProgramCacheKey` folds
  // it into the key). It is the only channel that reaches the fragment prefix, which is why
  // the patch carries its own define rather than testing `USE_BATCHING` — see the note above.
  const withDefines = clone as Material & { defines?: Record<string, unknown> };
  withDefines.defines = { ...withDefines.defines, [PART_HIGHLIGHT_DEFINE]: '' };
  clone.onBeforeCompile = (shader) => {
    if (!injectPartHighlight(shader, flags, baseEmissive)) {
      // A family with no `totalEmissiveRadiance` to replace. Take the highlight back off so
      // the batch draws what it drew before it was cloned, and leave the flags unread.
      setEmissiveHighlight(clone, null);
    }
  };
  clone.customProgramCacheKey = () => PART_HIGHLIGHT_CACHE_KEY;
  return clone;
}

/**
 * Write the patch into one program's source. False when an anchor is missing, which means the
 * material's family has no emissive to replace and the caller has to fall back.
 */
function injectPartHighlight(shader: ShaderSource, flags: PartHighlightFlags, baseEmissive: Color): boolean {
  const vertex = shader.vertexShader;
  const fragment = shader.fragmentShader;
  if (
    !vertex.includes(VERTEX_PARS_ANCHOR) ||
    !vertex.includes(VERTEX_MAIN_ANCHOR) ||
    !fragment.includes(FRAGMENT_PARS_ANCHOR) ||
    !fragment.includes(FRAGMENT_EMISSIVE_ANCHOR)
  ) {
    return false;
  }

  shader.vertexShader = vertex
    .replace(VERTEX_PARS_ANCHOR, `${VERTEX_PARS_ANCHOR}${VERTEX_PARS}`)
    .replace(VERTEX_MAIN_ANCHOR, `${VERTEX_MAIN_ANCHOR}${VERTEX_MAIN}`);
  shader.fragmentShader = fragment
    .replace(FRAGMENT_PARS_ANCHOR, `${FRAGMENT_PARS_ANCHOR}${FRAGMENT_PARS}`)
    .replace(FRAGMENT_EMISSIVE_ANCHOR, `${FRAGMENT_EMISSIVE_ANCHOR}${FRAGMENT_MAIN}`);

  shader.uniforms[FLAGS_UNIFORM] = { value: flags.texture };
  shader.uniforms[WIDTH_UNIFORM] = { value: flags.side };
  shader.uniforms[BASE_EMISSIVE_UNIFORM] = { value: baseEmissive };
  return true;
}
