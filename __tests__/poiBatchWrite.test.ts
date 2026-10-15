// Registering a model's points of interest — task 04b stage 3, the store half of the
// render audit's D3.
//
// `registerPOI` is one zustand `set()` per call, and components/Scene/ImportedModel.tsx
// used to call it once per mesh inside a traverse. Every `set()` re-renders every
// subscriber of `pois` — the agents, the boardroom's two layouts, the dialogue engine — so
// a 40 000-part STEP cost 40 000 writes and 40 000 renders of each of them, per model, on
// every change to the model's moved parts. That is independent of batching and was
// arguably worse than the draw-call problem 04b exists to fix.
//
// `registerPOIs` is the same upsert for a whole model as ONE write. And the seed the store
// derives from a scene tree is capped at the same number of components the extraction
// prompt is allowed, because an uncapped seed hands the store one POI per leaf of that
// assembly and every one of them is at the origin — 200 measured centres would be 200
// needles in it, and an agent picks its target uniformly at random out of the list.
//
// The render half — which parts, and which 200 of them — is in
// components/Scene/__tests__/modelPointsOfInterest.test.ts.

import { describe, it, expect, beforeEach } from 'vitest';
import { Vector3 } from 'three';
import { useStore } from '../store';
import { DEFAULT_MAX_COMPONENTS } from '../lib/componentIndex';
import type { PointOfInterest, SceneNode } from '../types';

function poi(id: string, x = 0): PointOfInterest {
  return { id, position: new Vector3(x, 0, 0), label: id.toUpperCase(), type: 'GENERAL' };
}

/** A model of `leaves` parts under one root, in the shape buildSceneTree produces. */
function tree(leaves: number): SceneNode {
  return {
    id: 'm_0',
    name: 'Assembly',
    type: 'GROUP',
    children: Array.from({ length: leaves }, (_, index) => ({
      id: `m_${index + 1}`,
      name: `Part ${index}`,
      type: 'MESH' as const,
    })),
  };
}

beforeEach(() => {
  useStore.setState({ pois: [] });
});

describe('registerPOIs — a whole model as one write', () => {
  it('is ONE store write, where registerPOI was one per part', () => {
    let writes = 0;
    const unsubscribe = useStore.subscribe(() => { writes += 1; });

    useStore.getState().registerPOIs([poi('a_1'), poi('a_2'), poi('a_3')]);
    const batched = writes;

    writes = 0;
    for (const id of ['b_1', 'b_2', 'b_3']) useStore.getState().registerPOI(poi(id));
    const oneAtATime = writes;
    unsubscribe();

    expect(batched).toBe(1);
    expect(oneAtATime).toBe(3);
    expect(useStore.getState().pois.map((one) => one.id))
      .toEqual(['a_1', 'a_2', 'a_3', 'b_1', 'b_2', 'b_3']);
  });

  it('upserts, so a model\'s measured centres replace the seeded ones in place', () => {
    useStore.getState().registerPOIs([poi('a_1'), poi('a_2')]);
    useStore.getState().registerPOIs([poi('a_2', 9), poi('a_3', 9)]);

    // Same contract the single version has: an id that is already there is overwritten
    // where it stands rather than appended again, so a re-measure after a part moved does
    // not grow the list or reorder it.
    const pois = useStore.getState().pois;
    expect(pois.map((one) => one.id)).toEqual(['a_1', 'a_2', 'a_3']);
    expect(pois[1].position.x).toBe(9);
  });

  it('leaves another model\'s POIs alone', () => {
    useStore.getState().registerPOIs([poi('a_1'), poi('a_2')]);
    useStore.getState().registerPOIs([poi('b_1')]);

    expect(useStore.getState().pois.map((one) => one.id)).toEqual(['a_1', 'a_2', 'b_1']);
  });

  it('is not a write at all when there is nothing to register', () => {
    let writes = 0;
    const unsubscribe = useStore.subscribe(() => { writes += 1; });

    useStore.getState().registerPOIs([]);
    unsubscribe();

    // A model with no parts in it — or an entry hand-built without a registry — must not
    // churn every subscriber for a list that did not change.
    expect(writes).toBe(0);
  });
});

describe('the seeded POIs are capped too', () => {
  it('stops at DEFAULT_MAX_COMPONENTS leaves', () => {
    useStore.getState().setBuiltInSceneTree('bicycle', tree(DEFAULT_MAX_COMPONENTS + 100));

    expect(useStore.getState().pois).toHaveLength(DEFAULT_MAX_COMPONENTS);
  });

  it('seeds every leaf of a model small enough to fit, exactly as it always did', () => {
    useStore.getState().setBuiltInSceneTree('bicycle', tree(12));

    const pois = useStore.getState().pois;
    expect(pois).toHaveLength(12);
    expect(pois[0].id).toBe('m_1');
    // At the origin, which is the seed's whole weakness and the reason the renderer's own
    // measured centres upsert over it.
    expect(pois[0].position.toArray()).toEqual([0, 0, 0]);
  });
});
