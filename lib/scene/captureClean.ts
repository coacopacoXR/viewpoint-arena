// What the lobby's picture of a room must not contain.
//
// docs/plan/15-sessions-and-variants.md batch BV. The thumbnail is taken from the room's
// own WebGL canvas by lib/reviews/thumbnail.ts, and for two batches it took WHATEVER was
// in front of the camera at that moment. The user's report from live testing was a review
// whose lobby picture had the move gizmo's arrows in it: the capture is armed by a model
// arriving or moving and fires three seconds later, and three seconds after a drag is
// exactly when the gizmo is still attached to the model somebody moved. So the picture of
// the review on every card in the lobby was a picture of the moment one person was
// mid-edit in it — arrows, the selection glow on the part they had clicked, the pin they
// were placing and the dot their laser was pointing with.
//
// WHAT COUNTS AS AN EDITING HELPER, and what does not. Hidden: the transform gizmo, a
// selection or laser highlight on a material, the pins somebody placed while curating,
// and the dots a laser lands on. Left alone, deliberately: the models, the grid, the
// floor shadow, the lights and the other people in the room, because those are what
// makes the picture look like a meeting rather than like a render — the batch asks for
// the tools to come out of it, not the room.
//
// HOW. `visible = false` on the object and back again in a `finally`, rather than a
// layer mask. A mask would need every helper in the app to be created on its own layer
// and every camera to keep two masks in step, and the one renderer call this file exists
// for is a single frame nobody else sees; hiding and restoring is a pair of assignments
// that cannot desynchronise anything. The restore is in the caller's `finally`, so a
// renderer that throws on a lost context gives the room its gizmo back rather than
// leaving a meeting with invisible tools.
//
// Two ways to be a helper, because the app owns one of them and a library owns the other:
// a `userData.editingHelper` tag, which is what every scene component this repo renders
// sets (see markEditingHelper), and three's own `TransformControls*` type names, which is
// what the gizmo drei mounts arrives as. The tag is also set on that gizmo by
// components/Scene/ReviewModelGizmo.tsx, so the type test is a second mechanism and not
// the only thing standing between a card and an arrow.

import { Mesh, type Color, type MeshStandardMaterial, type Object3D } from 'three';
import { emissiveMaterial, rememberedEmissiveOf } from './materialHighlight';

/** The `userData` key that says a scene object is a tool rather than part of the room. */
export const EDITING_HELPER_KEY = 'editingHelper';

/**
 * Tag a scene object as an editing helper, so a capture hides it.
 *
 * Shaped for a JSX `ref` callback and for R3F's `userData` prop alike:
 *
 *     <TransformControls ref={markEditingHelper} … />
 *     <group userData={{ skipRaycast: true, [EDITING_HELPER_KEY]: true }}>
 *
 * Accepts anything with a `userData` bag rather than an `Object3D` so the ref of a
 * library control — which this repo does not own the class of — satisfies it without a
 * cast at the call site.
 */
export function markEditingHelper(object: { userData: Record<string, unknown> } | null | undefined): void {
  if (object) object.userData[EDITING_HELPER_KEY] = true;
}

/** Whether one object is an editing helper. Its children are hidden with it. */
export function isEditingHelper(object: Object3D): boolean {
  if (object.userData?.[EDITING_HELPER_KEY] === true) return true;
  // three's own gizmo, and the two objects it hangs off itself: 'TransformControls',
  // 'TransformControlsGizmo' and 'TransformControlsPlane' all begin the same way.
  return object.type.startsWith('TransformControls');
}

/** A material whose live emissive a highlight had taken over, and what to give back. */
interface GlowingMaterial {
  material: MeshStandardMaterial;
  color: Color;
  intensity: number;
}

/** The state a capture changed, and the one call that puts all of it back. */
export interface CaptureClean {
  /** How many objects were hidden. A test asserts on this rather than on the drawing. */
  hidden: number;
  /** How many materials were taken off a highlight. */
  calmed: number;
  /** Put everything back. Idempotent, and safe to call from a `finally`. */
  restore(): void;
}

const NOTHING: CaptureClean = {
  hidden: 0,
  calmed: 0,
  restore() {},
};

/**
 * Take the editing tools off the scene, for one render.
 *
 * Synchronous and complete before it returns, because the caller renders and reads the
 * canvas in the same call — see lib/reviews/thumbnail.ts for why nothing in that path
 * may await. Two passes rather than one: hidden objects are collected first, then the
 * highlights, because a highlight on a mesh INSIDE a hidden helper is still a highlight
 * on a material that outlives the capture and would stay calm after it.
 *
 * Only objects that were VISIBLE are hidden, and only the emissive that differs from
 * the material's own is calmed, so `restore` puts back exactly what was there and
 * nothing else — a gizmo drei had already detached, and a material a highlight never
 * touched, are both left completely alone.
 */
export function hideEditingHelpers(root: Object3D | null | undefined): CaptureClean {
  if (!root) return NOTHING;

  const hidden: Object3D[] = [];
  const glowing: GlowingMaterial[] = [];

  root.traverse((object) => {
    // Already invisible: nothing to hide, and pushing it would make `restore` show
    // something the room had turned off.
    if (!object.visible) return;
    if (!isEditingHelper(object)) return;
    hidden.push(object);
    object.visible = false;
  });

  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      const live = emissiveMaterial(material);
      if (!live) continue;
      // Read-only on purpose: `originalEmissiveOf` would STAMP the original onto every
      // material in a large assembly, and lib/scene/materialHighlight exists in the
      // shape it does precisely so that a highlight is the only thing that writes it.
      const own = rememberedEmissiveOf(live);
      // No remembered original means no highlight has ever touched this material, so
      // whatever it is glowing with is its own — a warning stripe a CAD file carried,
      // a lens an author gave a glow. Taking that out of the picture would be taking
      // the model apart.
      if (!own) continue;
      if (live.emissive.equals(own.color) && live.emissiveIntensity === own.intensity) continue;
      glowing.push({
        material: live,
        color: live.emissive.clone(),
        intensity: live.emissiveIntensity,
      });
      live.emissive.copy(own.color);
      live.emissiveIntensity = own.intensity;
    }
  });

  if (hidden.length === 0 && glowing.length === 0) return NOTHING;

  let restored = false;
  return {
    hidden: hidden.length,
    calmed: glowing.length,
    restore() {
      // Once, because a caller that puts this in a `finally` under a `try` that also
      // returned early would otherwise run it twice and the second run would be a
      // no-op at best and a wrong answer if something else had shown one of these.
      if (restored) return;
      restored = true;
      for (const object of hidden) object.visible = true;
      for (const glow of glowing) {
        glow.material.emissive.copy(glow.color);
        glow.material.emissiveIntensity = glow.intensity;
      }
    },
  };
}
