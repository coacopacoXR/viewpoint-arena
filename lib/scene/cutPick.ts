// Which raycast hits the room's cut has taken away — task 08a.
//
// Three's `Raycaster` does not know a clipping plane exists. It tests geometry, and
// clipping happens later in the fragment shader, so a ray aimed at a model the room has
// cut in half reports hits on BOTH halves — including the one nobody can see. Left alone
// that is not a cosmetic problem: the laser would name a part that is not on screen, a
// click in Edit mode would park the gizmo on it, a comment pin would be dropped on a face
// the meeting has just cut off, and a hand in a headset would reach through a section and
// touch the far wall of it. "Clicking into a cut model selects the part you see in the
// section" needs the pick to agree with the picture, and the picture is decided by
// `isCutAway` in lib/scene/cutPlane.ts.
//
// ONE PREDICATE, ONE FILTER, and every pick path in the app goes through them. That is the
// rule this file exists to make possible rather than to state: lib/scene/clickSelection.ts
// opens with a long account of what five copies of one resolution did to this codebase — a
// laser and a Model Tree that disagreed about what was selected — and a cut filter written
// per call site is the same drift with a new subject. A laser that honours the cut and a
// pin drop that does not is a pin on a part the person placing it could not see.
//
// There is no single function in this app that every pick goes through. There are six
// places that raycast, each with its own loop over the hits, and each of them wraps the
// raycast in `uncutHits`:
//
//   components/Scene/UserLaser.tsx        the desktop laser, and the dwell that arms it
//   components/Scene/MobileLaser.tsx      the touch laser
//   components/Scene/XRManager.tsx        a headset controller's ray
//   components/Scene/SceneClickSelect.tsx the click that selects a part in Edit mode
//   components/Scene/SpatialComments.tsx  the placement preview, and the click that drops
//
// lib/scene/__tests__/cutPick.test.ts asserts the list is still complete, because a seventh
// raycast added later is exactly how a filter like this quietly stops being one.
//
// NOT filtered, deliberately: components/Scene/PerfProbe.tsx's `?perf=1` raycast, which
// measures what a whole-scene `intersectObjects` costs. Filtering it would make the number
// in perf/results/laser.md depend on whether a cut happened to be on, and the benchmark is
// the control the rest of this task is measured against.
//
// The filter keeps the ORDER the raycaster answered in, which is nearest first, so "drop
// the hits on the clipped side and take the next one" is what a caller gets by reading its
// own loop and nothing more — no caller had to learn to walk past a hit.

import type { Vector3 } from 'three';
import { isCutAway } from './cutPlane';

/**
 * The part of an `Intersection` this filter is allowed to read.
 *
 * Narrowed rather than taking `Intersection` whole, for the reason
 * lib/scene/partRegistry.ts narrows `PickHit`: the filter has to work on a hit straight
 * out of a `Raycaster` and on one a test has hand-built, and the only field either must
 * have is where in the world it landed.
 */
export interface CutTestableHit {
  point: Vector3;
}

/**
 * Whether one hit is on the side of the cut that is not being drawn.
 *
 * Exported as well as used here because a caller that has already reduced its hits to one
 * — a gizmo that keeps a `Vector3` and nothing else — still has to be able to ask, and the
 * alternative is a second copy of the sign.
 */
export function isHitCutAway(hit: CutTestableHit | null | undefined): boolean {
  return hit !== null && hit !== undefined && isCutAway(hit.point);
}

/**
 * The hits that are still on screen, nearest first.
 *
 * Returns the SAME array when nothing was dropped, which is the ordinary case — no cut at
 * all, or a cut the ray never reached — and is what keeps a laser that runs sixty times a
 * second from allocating sixty arrays a second. A fresh array otherwise rather than an
 * in-place splice, because three reuses the array a `Raycaster` was given and a caller that
 * held onto it would find it edited underneath them.
 *
 * Two passes and not one: the first answers whether anything has to be copied at all, so
 * the common case is a scan and no allocation, and the second copies. `isCutAway` is a
 * dot product against a flag, so the second pass costs less than the array it saves.
 */
export function uncutHits<T extends CutTestableHit>(hits: readonly T[]): readonly T[] {
  let dropped = 0;
  for (const hit of hits) {
    if (isCutAway(hit.point)) dropped += 1;
  }
  if (dropped === 0) return hits;
  const kept: T[] = [];
  for (const hit of hits) {
    if (!isCutAway(hit.point)) kept.push(hit);
  }
  return kept;
}

/** The nearest hit that is still on screen, or null when the cut took every one of them. */
export function firstUncutHit<T extends CutTestableHit>(hits: readonly T[]): T | null {
  for (const hit of hits) {
    if (!isCutAway(hit.point)) return hit;
  }
  return null;
}
