// The room's explode view, applied to the models — task 08b.
//
// The sibling of components/Scene/ViewToolsCut.tsx and the same shape of thing: a component
// that renders NOTHING, reads the room's shared value off the store, and turns it into
// renderer state. It is mounted inside the canvas rather than outside it because the thing it
// writes is a property of the parsed models, and the models are in here.
//
// WHAT IT DOES NOT DO is touch the scene graph. The whole of the work is
// `registry.setExplode(factor)` per parsed model, which is the same seam every other per-part
// property goes through — visibility, the selection glow, the motion cull, a part somebody
// dragged — and the reason it has to: a batched part is a slot in a BatchedMesh with no
// Object3D of its own, so an explode written by walking the graph would do nothing at all to
// exactly the large assemblies the view exists for. See lib/scene/partRegistry.ts.
//
// ALSO NOT HERE: any write to `SceneModel.parts`, any edit-history step, or anything the part
// gizmo could read back as a part's own transform. An explode is a way of LOOKING at a model,
// shared with the room the way a cut is, and the registry is what keeps that promise — a
// handle asked for its transform answers the assembled one however far apart the parts are
// being drawn. That is why the amber strip switches its per-part tools off while the room is
// exploded (components/review/EditingStrip.tsx) rather than why it has to: dragging a part
// would still write the right numbers, but the part would be somewhere else on screen from the
// gizmo that claims to be moving it, and a tool that cannot be trusted to be pointing at the
// thing it moves is worse than a tool that says it is unavailable.

import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useStore } from '../../store';
import { partRegistries } from '../../lib/scene/partRegistry';

/**
 * Apply the room's explode to every parsed model.
 *
 * Renders nothing.
 */
const ViewToolsExplode: React.FC = () => {
  // The EXPLODE and not the whole of the room's view tools, for the reason the cut's component
  // subscribes to the cut: a drag of the other slider must not re-run this one's effect. A
  // `setExplode` with the same factor is a no-op inside the registry, so the cost of getting it
  // wrong would be a loop over the models rather than a loop over the parts — and the cut's
  // effect is the expensive neighbour, not this one.
  const explode = useStore((state) => state.viewTools.explode);
  const sceneEntries = useStore((state) => state.sceneEntries);
  const roomScene = useStore((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);

  /**
   * The parsed models, memoised because the effect below re-runs on every step of a slider drag
   * and building the array is a walk of the scene list.
   */
  const registries = useMemo(() => partRegistries(sceneEntries), [sceneEntries]);

  /**
   * The value waiting to be written, or null when nothing is.
   *
   * A slider drag is a stream of pointer-moves and each one is its own React commit, so at a
   * high pointer rate two of them land inside one frame — and each would pay for a full write
   * over every part, of which only the last is ever seen. Holding the newest value here and
   * writing it from `useFrame` makes a drag cost one apply per frame drawn, whatever rate the
   * pointer reports at, which is the difference the task's own cost note asks about: measured
   * on the 10 000-part fixture, an apply is most of a frame's budget (see
   * perf/results/viewtools.md), so paying it twice for one picture is paying it once too many.
   */
  const pending = useRef<number | null>(null);

  /**
   * Note the room's value and ask for the frame that will write it.
   *
   * `roomScene` is in the list even though the body never reads it, and it is the reason this
   * effect is not simply `[explode]`: a part override changes where the parts ARE, so the plan
   * the registry measured — every part's centre, and the model's — is stale the moment one
   * lands. The registry notices that itself (`setExplode` compares the plan against its own
   * count of transform writes and rebuilds), but nothing would ASK it again unless this
   * re-ran, and a model that had been taken apart would stay apart the wrong way until the next
   * time somebody touched the slider. `applyPartTransforms` runs in an effect of
   * components/Scene/ImportedModel.tsx, which mounts earlier in this tree and so has already
   * written by the time this one runs.
   */
  useEffect(() => {
    pending.current = explode;
    invalidate();
  }, [explode, registries, roomScene, invalidate]);

  /**
   * The write itself, on the frame that will show it.
   *
   * `useFrame` callbacks run before the frame they belong to is drawn, so the parts are where
   * this puts them in the picture the invalidate above asked for — and under
   * `frameloop="demand"` they run on no other frame, which is what makes this a coalescing
   * rather than a poll.
   */
  useFrame(() => {
    const factor = pending.current;
    if (factor === null) return;
    pending.current = null;
    for (const registry of registries) registry.setExplode(factor);
  });

  /**
   * Assemble everything on the way out.
   *
   * Leaving a room, or unmounting this canvas, must not leave a model standing in pieces: the
   * explode is in the parts' own positions and instance matrices, so a group that outlives this
   * component — the lobby's viewer keeps drawing a group whose registry it disposed — would keep
   * the shape the last room left it in. A separate effect from the one above rather than its
   * cleanup, for the reason the cut's component gives: a cleanup on the value would assemble the
   * model and take it apart again on every step of a drag. The pending write is dropped with it:
   * a value nobody will ever see a frame of is not a value anybody is owed.
   */
  useEffect(
    () => () => {
      pending.current = null;
      for (const registry of registries) registry.setExplode(0);
      invalidate();
    },
    [registries, invalidate],
  );

  return null;
};

export default ViewToolsExplode;
