// The room's explode view, as the maths both registries share — task 08b.
//
// WHAT AN EXPLODE IS HERE. Every part moves along the line from its MODEL's own centre to
// that part's own bounding-box centre, by `factor × EXPLODE_SPREAD × (the distance between
// the two)`. A direction times its own distance is the vector between the two points, so
// the whole rule reduces to one vector per part — `centre(part) − centre(model)` — scaled
// by one number the slider owns. A part standing at the centre has a zero vector and stays
// put, which is what keeps a concentric assembly from turning itself inside out, and each
// model measures its own centre so a room with two products explodes each about itself
// rather than dragging one across the floor away from the other.
//
// WHY THE VECTORS LIVE IN THE MODEL'S ROOT SPACE. A model is placed, dragged and scaled by
// the wrapper above its root (components/Scene/ImportedModel.tsx's `placeImportedGroup` and
// the amber strip's whole-model Move), and none of that is an explode. Measuring centres in
// the root's own space — and writing the result back in a space the root is above — means a
// model somebody dragged across the room keeps the plan it was built with, and the cache
// does not have to be thrown away every time the camera-facing half of the app moves a
// product. What DOES throw it away is a part moving inside the model, because then the
// centres themselves are wrong: see `PartRegistry.setExplode`.
//
// NESTED PARTS DO NOT COMPOUND, AND THAT IS THE SUBTLE HALF. The rule above is a statement
// about where a part ENDS UP, not about what is written to it. A parsed model is a real
// hierarchy, so writing "move by D" to a group moves every part inside it by D as well, and
// a bolt three levels down would be pushed by its own D plus its assembly's plus its
// sub-assembly's — a model that flies apart the deeper it is nested. `explodeObjectOffsets`
// is the correction: each object is handed the offset that leaves its OWN realised
// displacement in the root's space equal to its own direction, net of what its ancestors
// already contribute. The two are the same number for a flat model and differ for a nested
// one, and the difference is invisible in the picture either way — which is exactly why it
// has to be computed rather than hoped for.
//
// A batch has no hierarchy to correct for. A slot's matrix is already in the root's space,
// so the batched registry writes the direction straight into it and never calls the second
// function except for the parts batching refused, which kept their Object3D and with it
// their place in a real graph.
//
// BOTH FUNCTIONS ARE PURE AND BOTH RUN ONCE PER PLAN, never per frame. What a slider drag
// costs is one pass writing `base + direction × scale` per part, which is the difference
// between an explode that can be dragged on a 10 000-part assembly and one that cannot.

import { Box3, Matrix3, Matrix4, Vector3, type Object3D } from 'three';
import type { PartHandle } from './partRegistry';

/**
 * How far a fully exploded model is pushed, in units of its own radius.
 *
 * At `factor` 1 a part ends up `1 + EXPLODE_SPREAD` times as far from the model's centre as
 * it started, so the product occupies about two and a half times the box it was assembled in.
 * Tuned by eye on the bundled sample and on the perf fixtures rather than derived: the number
 * that reads as "taken apart, and I can still see which part came from where" is a little
 * under a doubling of the model's own extent, and past about 2.5 the parts leave the frame
 * the room had settled on. It is one constant here rather than a per-model guess because the
 * room shares ONE explode factor on the wire (lib/scene/viewTools.ts), and a factor that
 * meant a different distance in each model would mean two browsers disagreeing about what
 * 0.6 looks like.
 */
export const EXPLODE_SPREAD = 1.5;

/** Scratch, so a plan build allocates nothing per part. */
const scratchBox = new Box3();
const scratchCentre = new Vector3();
const scratchModelCentre = new Vector3();
const scratchInverse = new Matrix4();
const scratchParentToRoot = new Matrix4();
const scratchLinear = new Matrix3();
/** The root's own displacement, which is nothing: a model does not explode away from itself. */
const NO_DISPLACEMENT = new Vector3();

/**
 * The vector each part moves along, at factor 1, in the ROOT's space.
 *
 * `out` is filled to one entry per part in `parts` — the registry's own order, which is the
 * order both implementations index by — and each entry is `centre(part) − centre(model)`, so
 * the distance the task's rule asks for is the entry's own length and the direction is the
 * entry normalised. Nothing here normalises it, because a direction times its distance is
 * what gets written and keeping the two as one vector is what makes the per-frame write a
 * multiply and an add.
 *
 * @param root the model's own root, whose space the answers are in
 * @param parts every part, asked for its box through the handle so that a batched part and
 *        an Object3D one answer the same way
 * @param assembledBox the model's box in WORLD space, measured with the explode OFF. The
 *        caller's job and not this function's, because only the registry knows how to answer
 *        its own bounds — and a centre measured off an exploded model would push every part
 *        further out on the next step, so a slider held still would creep the model apart.
 * @param out filled in place, one Vector3 per part, zero for a part with nothing in it
 */
export function explodeDirections(
  root: Object3D,
  parts: readonly PartHandle[],
  assembledBox: Box3,
  out: Vector3[],
): void {
  out.length = 0;
  for (let at = 0; at < parts.length; at += 1) out.push(new Vector3());

  root.updateMatrixWorld(true);
  scratchInverse.copy(root.matrixWorld).invert();

  // The model's centre in its own space. An empty box answers the origin, which would put
  // every part's direction at "away from the origin" and blow a model apart that has no
  // geometry in it, so the emptiness is tested rather than trusted.
  scratchBox.copy(assembledBox);
  if (scratchBox.isEmpty()) return;
  scratchBox.applyMatrix4(scratchInverse);
  if (scratchBox.isEmpty()) return;
  scratchBox.getCenter(scratchModelCentre);

  for (let at = 0; at < parts.length; at += 1) {
    parts[at].getBoundingBox(scratchBox);
    // A part with nothing to draw — a group whose branches batching emptied, a node the file
    // left without geometry — stays where it is. Its own centre would otherwise be the origin
    // and its direction the whole way to it.
    if (scratchBox.isEmpty()) continue;
    scratchBox.applyMatrix4(scratchInverse);
    scratchBox.getCenter(scratchCentre);
    out[at].copy(scratchCentre).sub(scratchModelCentre);
  }
}

/**
 * What to ADD to each moving object's own `position`, at factor 1, in its PARENT's space.
 *
 * The correction described at the head of this file. Walking the graph in pre-order means an
 * object's parent has already been decided by the time it is reached, so the displacement the
 * object actually gets is its own direction and the displacement it INHERITS is its parent's
 * realised one — an untagged object between two parts moves only because its parent does, so
 * it passes that number straight down. The offset written is the difference between the two,
 * turned from the root's space into the parent's, which leaves every part standing at its own
 * direction however deep it sits.
 *
 * Only the objects in `directionOf` are written to; everything else in the graph is visited
 * to carry an inherited displacement and is left alone.
 *
 * @param root the model's own root, whose space `directionOf`'s vectors are in
 * @param directionOf the root-space direction of every object the explode moves
 * @param out filled in place: one parent-space offset per object in `directionOf`
 */
export function explodeObjectOffsets(
  root: Object3D,
  directionOf: ReadonlyMap<Object3D, Vector3>,
  out: Map<Object3D, Vector3>,
): void {
  out.clear();
  if (directionOf.size === 0) return;
  root.updateMatrixWorld(true);

  // Per object, the displacement it ends up with at factor 1. A Map and not a field on the
  // object because the objects belong to the parse and this belongs to one plan build.
  const realised = new Map<Object3D, Vector3>();
  realised.set(root, NO_DISPLACEMENT);

  root.traverse((object) => {
    if (object === root) return;
    const parent = object.parent ?? root;
    const inherited = realised.get(parent) ?? NO_DISPLACEMENT;
    const direction = directionOf.get(object);
    if (!direction) {
      // Not a part the explode moves, but its children may be under it, so the displacement
      // it passes down is the one it arrived with.
      realised.set(object, inherited);
      return;
    }
    // root-space → this object's parent's space. `parent.matrixWorld⁻¹ × root.matrixWorld` is
    // the chain from the root down to the parent, inverted: the root's own placement cancels,
    // so the answer is the same wherever in the room the model is standing.
    scratchParentToRoot.copy(parent.matrixWorld).invert().multiply(root.matrixWorld);
    scratchLinear.setFromMatrix4(scratchParentToRoot);
    scratchCentre.copy(direction).sub(inherited).applyMatrix3(scratchLinear);
    out.set(object, scratchCentre.clone());
    realised.set(object, direction);
  });
}
