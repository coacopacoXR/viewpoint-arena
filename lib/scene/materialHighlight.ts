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

import type { Color, Material, MeshStandardMaterial } from 'three';

/** Where a material's own emissive is kept once a highlight has touched it. */
const ORIGINAL_KEY = 'originalEmissive';

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
