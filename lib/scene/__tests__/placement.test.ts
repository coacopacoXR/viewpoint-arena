// Where a model goes when it joins a scene that already has something in it.
//
// Both arrangements are the same idea — put the new thing BESIDE what is there,
// far enough away that neither overlaps the other, and leave everything else
// where it was — so the interesting assertions below are about two things that
// are easy to get wrong in a way that still looks like it works:
//
//   * the gap is a FRACTION of a width, not a distance. An imported model is
//     normalised to about two scene units across, but the scale slider can make
//     it ten times that, and a fixed gap that looked right for a bracket would
//     have put a scaled-up assembly on top of its neighbour;
//   * everything is measured from the models' actual positions, not from the
//     origin and not from whichever model arrived first. The cases with a model
//     already off to the right are the regression that arithmetic exists to stop.

import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_GAP_FRACTION,
  combinedXExtent,
  compareOffsets,
  nextToOffset,
  sceneExtents,
  sceneWidth,
} from '../placement';
import type { SceneExtent } from '../placement';
import type { SceneModel } from '../roomScene';

/** A footprint centred on x, which is what centerModel leaves an import as. */
function extent(x: number, width: number): SceneExtent {
  return { offset: [x, 0, 0], width };
}

function sceneModel(id: string, offset: [number, number, number]): SceneModel {
  return {
    id,
    hash: `hash-${id}`,
    fileName: `${id}.step`,
    line: id,
    revision: 'A',
    visible: true,
    offset,
  };
}

/** The air between a placed centre and the edge it was placed beyond. */
function gapBeyond(centre: number, edge: number, widthOfNew: number): number {
  return centre - widthOfNew / 2 - edge;
}

describe('sceneWidth', () => {
  it('is the measured width through the base scale and the slider', () => {
    // The caller measures geometry in its own units; centerModel's normalisation
    // and the user's slider each multiply that. Placing with only one of the two
    // would have overlapped the moment the slider moved.
    expect(sceneWidth(2, 0.5, 4)).toBe(4);
    expect(sceneWidth(3, 1.5, 0.25)).toBe(1.125);
  });

  it('answers to each of the three factors', () => {
    expect(sceneWidth(2, 1, 1)).not.toBe(sceneWidth(4, 1, 1));
    expect(sceneWidth(2, 1, 1)).not.toBe(sceneWidth(2, 2, 1));
    expect(sceneWidth(2, 1, 1)).not.toBe(sceneWidth(2, 1, 2));
  });
});

describe('combinedXExtent', () => {
  it('is null for a scene with nothing in it', () => {
    // Null rather than {min:0,max:0}: an empty scene has no edge to be beside,
    // and a zero box would have been a real position the first model then had to
    // clear, putting it off-centre in an otherwise empty room.
    expect(combinedXExtent([])).toBeNull();
  });

  it('spans a model that is centred on its offset', () => {
    // Symmetric about offset[0] is the only assumption the arithmetic makes, and
    // it comes from centerModel centring an imported model in X and Z.
    expect(combinedXExtent([extent(0, 2)])).toEqual({ min: -1, max: 1 });
    expect(combinedXExtent([extent(5, 2)])).toEqual({ min: 4, max: 6 });
  });

  it('takes the left edge of one model and the right edge of another', () => {
    // A wide assembly at the origin and a small part parked far to the right:
    // neither on its own gives the box that matters, and it is the box the next
    // arrival has to clear both of.
    const wide = combinedXExtent([extent(0, 10)]);
    const small = combinedXExtent([extent(20, 1)]);
    const both = combinedXExtent([extent(0, 10), extent(20, 1)]);

    expect(wide).toEqual({ min: -5, max: 5 });
    expect(small).toEqual({ min: 19.5, max: 20.5 });
    expect(both).toEqual({ min: -5, max: 20.5 });
  });

  it('is a footprint along X only', () => {
    // Two models at different heights and depths are side by side already; a
    // bounding box that included Y would have pushed them apart for no reason.
    expect(combinedXExtent([{ offset: [1, 9, -9], width: 2 }])).toEqual({ min: 0, max: 2 });
  });
});

describe('nextToOffset', () => {
  it('puts the first model at the origin', () => {
    // There is nothing to be beside, whatever the model's own width turns out to
    // be once it has been parsed.
    expect(nextToOffset([], 2)).toEqual([0, 0, 0]);
    expect(nextToOffset([], 20)).toEqual([0, 0, 0]);
  });

  it('puts the next model one gap beyond the one already there', () => {
    // Right edge 1, plus 20% of the combined width of 2 (0.4), plus half the new
    // model's own width (1): the CENTRE is 2.4, and its left edge at 1.4 clears
    // the model that was already on screen.
    const offset = nextToOffset([extent(0, 2)], 2);
    expect(offset).toEqual([2.4, 0, 0]);
    expect(offset[0] - 1).toBeGreaterThan(1);
  });

  it('leaves proportionally more air for a wider scene', () => {
    // The gap is a fraction of the combined width, so it grows with the thing it
    // is measured against rather than staying at a distance that suited a bracket.
    const besideBracket = nextToOffset([extent(0, 2)], 2)[0];
    const besideAssembly = nextToOffset([extent(0, 10)], 2)[0];

    expect(besideBracket).toBe(2.4);
    expect(besideAssembly).toBe(8);
    expect(gapBeyond(besideBracket, 1, 2)).toBeCloseTo(0.4, 10);
    expect(gapBeyond(besideAssembly, 5, 2)).toBeCloseTo(2, 10);
    expect(gapBeyond(besideAssembly, 5, 2)).toBeGreaterThan(gapBeyond(besideBracket, 1, 2));
  });

  it('clears the right-most of several models, not the first one in the list', () => {
    // Two models in the room, at the origin and at x=5: the combined box spans
    // -1..6, the gap is 1.4, and the new centre is 8.4. Measured from whichever
    // model is nearest the door, not from whichever arrived first — which is why
    // the order of the array cannot matter.
    expect(nextToOffset([extent(0, 2), extent(5, 2)], 2)).toEqual([8.4, 0, 0]);
    expect(nextToOffset([extent(5, 2), extent(0, 2)], 2)).toEqual([8.4, 0, 0]);

    const offset = nextToOffset([extent(0, 2), extent(5, 2)], 2);
    expect(gapBeyond(offset[0], 6, 2)).toBeCloseTo(1.4, 10);
    expect(offset[0] - 1).toBeGreaterThan(6);
  });

  it('lands beyond a model that is already off to the right', () => {
    // The regression this arithmetic exists to prevent. A model the user dragged
    // out to x=8 has its right edge at 9, and an offset computed from the origin
    // — or from the first entry in the list — would have dropped the new arrival
    // on top of it.
    const offset = nextToOffset([extent(8, 2)], 2);
    expect(offset).toEqual([10.4, 0, 0]);
    expect(offset[0] - 1).toBeGreaterThan(9);
    expect(offset[0]).toBeGreaterThan(8);
  });

  it('honours a gap fraction the caller chose', () => {
    // 0 means touching, which is what a caller that wants two revisions read as
    // one assembly asks for; 1 means a gap as wide as everything already there.
    const touching = nextToOffset([extent(0, 2)], 2, 0);
    expect(touching).toEqual([2, 0, 0]);
    expect(gapBeyond(touching[0], 1, 2)).toBe(0);
    expect(nextToOffset([extent(0, 2)], 2, 1)).toEqual([4, 0, 0]);
  });

  it('defaults to the exported fraction', () => {
    // One number, so a caller that wants to show "20% clear" in the UI is not
    // keeping its own copy of it.
    expect(PLACEMENT_GAP_FRACTION).toBe(0.2);
    expect(nextToOffset([extent(0, 2)], 2)).toEqual(
      nextToOffset([extent(0, 2)], 2, PLACEMENT_GAP_FRACTION),
    );
  });
});

describe('compareOffsets', () => {
  it('leaves the older revision exactly where the room had it', () => {
    // The older revision is the one the room has been discussing: the viewpoints,
    // pins and comments all point at where it is, and a comparison that slid it
    // sideways would have left every pin floating in empty space next to the
    // model it was placed on. Y and Z come back untouched too.
    const result = compareOffsets({ offset: [-3, 1.5, 2], width: 4 }, { offset: [0, 0, 0], width: 2 });
    expect(result.older).toEqual([-3, 1.5, 2]);
  });

  it('shifts the newer one out by the older width plus a fifth of it', () => {
    // Older: centre -3, width 4, so its right edge is -1 and the gap is 0.8 of
    // the OLDER model's width — the newer one is the visitor, so the room it
    // needs is measured from what was already there. Newer: width 2, centre at
    // -1 + 0.8 + 1 = 0.8.
    const result = compareOffsets(
      { offset: [-3, 1.5, 2], width: 4 },
      { offset: [0, 2.5, -3], width: 2 },
    );
    expect(result.newer).toEqual([0.8, 2.5, -3]);
    expect(gapBeyond(result.newer[0], -1, 2)).toBeCloseTo(0.8, 10);
  });

  it('keeps the newer revision at the same height and depth, and ignores where it was', () => {
    // Revisions of one product differ in detail, not in size: lifting one off the
    // floor to make room would have read as a mistake rather than a comparison.
    // The newer model's own X is not consulted either, because Compare places it.
    const result = compareOffsets(extent(0, 4), { offset: [9, 2.5, -7], width: 2 });
    expect(result.newer).toEqual([3.8, 2.5, -7]);
    expect(result.older).toEqual([0, 0, 0]);
  });

  it('keeps a much wider newer revision clear of the older one', () => {
    // Compare puts two revisions of a line side by side, but a revision can add a
    // whole assembly. The centre moves out by the older width only, so the
    // clearance for a wide newer model has to come from its own half-width as
    // well — which is why this asserts the edges and not the centres.
    const older = extent(0, 2);
    const newer: SceneExtent = { offset: [0, 0, 0], width: 20 };

    const result = compareOffsets(older, newer);

    expect(result.older).toEqual([0, 0, 0]);
    expect(result.newer[0]).toBe(11.4);
    expect(result.newer[0] - newer.width / 2).toBeGreaterThan(older.offset[0] + older.width / 2);
  });

  it('honours a gap fraction the caller chose', () => {
    // A tighter comparison is a legitimate thing to ask for, and the older
    // revision must stay put whatever the gap turns out to be.
    const older: SceneExtent = { offset: [2, 0, 0], width: 4 };
    const result = compareOffsets(older, { offset: [0, 0, 0], width: 2 }, 0);
    expect(result.older).toEqual([2, 0, 0]);
    expect(result.newer).toEqual([5, 0, 0]);
    expect(gapBeyond(result.newer[0], 4, 2)).toBe(0);
  });
});

describe('sceneExtents', () => {
  it('measures every model with the width function it was given', () => {
    // These functions stay three-free so they can be tested without a WebGL
    // context, which means the caller is the only thing holding the parsed
    // geometry. Passing the model to the measuring function is what lets it use
    // the hash, the base normalisation and the slider together.
    const models = [sceneModel('a', [-4, 0, 0]), sceneModel('b', [0, 1, 2])];
    const measured: string[] = [];

    const extents = sceneExtents(models, (model) => {
      measured.push(model.id);
      return model.id === 'a' ? 3 : 5;
    });

    // Each model measured once, in scene order, with the offset it is really at.
    expect(measured).toEqual(['a', 'b']);
    expect(extents).toEqual([
      { offset: [-4, 0, 0], width: 3 },
      { offset: [0, 1, 2], width: 5 },
    ]);
  });

  it('maps an empty scene to nothing, which is where the origin case starts', () => {
    expect(sceneExtents([], () => 2)).toEqual([]);
    expect(nextToOffset(sceneExtents([], () => 2), 2)).toEqual([0, 0, 0]);
  });

  it('feeds the placement functions, which is how a caller uses it', () => {
    // The whole path an import takes: measure the models the room already holds,
    // take their combined footprint, and put the new one beside it.
    const models = [sceneModel('a', [0, 0, 0]), sceneModel('b', [6, 0, 0])];
    const extents = sceneExtents(models, (model) => (model.id === 'a' ? 2 : 4));

    expect(combinedXExtent(extents)).toEqual({ min: -1, max: 8 });
    expect(nextToOffset(extents, 2)).toEqual([10.8, 0, 0]);
  });
});
