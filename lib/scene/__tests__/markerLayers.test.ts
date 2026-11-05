// The layers the room's comment and pin markers are drawn on — task 09a.
//
// The claim these numbers make is a claim about THREE files that do not import each other:
// lib/scene/markerLayers.ts holds the constants, pages/RoomPage.tsx holds the z-index the
// whole UI overlay is lifted to, and components/UI/Interface.tsx holds the z-indexes of the
// panels inside it. Nothing in the type system connects them, and the failure mode of one of
// them moving is not an error — it is a comment bubble that quietly starts covering the Model
// Tree again, which is the bug this task exists to fix and which no other test would notice.
//
// So the numbers are read out of the sources rather than repeated here, the way
// lib/scene/__tests__/cutPick.test.ts reads its pick paths out of them: an assertion against
// a hardcoded 10 would keep passing on the day somebody moved the overlay to 30.
//
// WHY 10 AND NOT 20 IS THE PART THAT IS EASY TO GET WRONG, and is written down here because
// it is the thing a reader of this test most needs. `pages/RoomPage.tsx` mounts the canvas
// and the UI as siblings:
//
//     <div class="relative flex-1 min-w-0">     position relative, z-index auto
//       <ViewpointCanvas />                     R3F's div: relative, overflow hidden, z auto
//       <div class="absolute inset-0 z-10">     ← all of Interface.tsx
//
// Neither ancestor is a stacking context — `position: relative` with `z-index: auto` is not
// one — so the z-index drei writes on a marker competes at the ROOT of the document against
// that wrapper's 10. The `z-[20]`…`z-[250]` inside Interface.tsx are all trapped in the
// wrapper's own stacking context and cannot be reached from a marker at any value. A marker
// at 15 is under every panel in the app; a marker at 10777271 was over all of them, which is
// what drei's default `zIndexRange` hands out.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOWEST_PANEL_Z,
  MARKER_OCCLUDED_OPACITY,
  MARKER_Z_RANGE,
  MARKER_Z_RANGE_EXPANDED,
  ROOM_OVERLAY_Z,
} from '../markerLayers';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const source = (path: string): string => readFileSync(join(REPO_ROOT, ...path.split('/')), 'utf8');

/**
 * The z-index the room lifts its whole UI overlay to, read out of the element it is on.
 *
 * Looked for as `absolute inset-0 z-N` rather than as any z-class in the file, because
 * RoomPage.tsx also has a `z-[60]` dropped-line banner that is a sibling of the overlay and
 * not the thing a marker has to stay under.
 */
function roomOverlayZ(): number {
  const found = source('pages/RoomPage.tsx').match(/className="absolute inset-0 z-(\d+)/);
  expect(found, 'RoomPage no longer lifts the UI overlay with `absolute inset-0 z-N`').not.toBeNull();
  return Number(found![1]);
}

/**
 * Every z-index Interface.tsx uses, as Tailwind writes it — `z-20` from the built-in scale
 * and `z-[137]` from an arbitrary value, which is the spelling most of the panels use.
 */
function interfaceZIndexes(): number[] {
  const out: number[] = [];
  const pattern = /\bz-\[?(\d+)\]?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source('components/UI/Interface.tsx'))) !== null) {
    out.push(Number(match[1]));
  }
  expect(out.length, 'Interface.tsx has no z-indexes left to be under').toBeGreaterThan(0);
  return out;
}

/** The highest z-index drei writes on a marker in either of the two marker components. */
function markerZCeiling(): number {
  return Math.max(MARKER_Z_RANGE[0], MARKER_Z_RANGE[1], MARKER_Z_RANGE_EXPANDED[0], MARKER_Z_RANGE_EXPANDED[1]);
}

describe('the numbers agree with the sources they describe', () => {
  it('names the z-index the room lifts its UI overlay to', () => {
    expect(ROOM_OVERLAY_Z).toBe(roomOverlayZ());
  });

  it('names the lowest z-index a panel inside that overlay uses', () => {
    expect(LOWEST_PANEL_Z).toBe(Math.min(...interfaceZIndexes()));
  });

  it('puts the overlay under its own lowest panel, which is what makes 10 the threshold', () => {
    // Not an independent fact, and asserted because the whole argument rests on it: if the
    // wrapper ever moved above a panel inside it, the threshold would move with it.
    expect(ROOM_OVERLAY_Z).toBeLessThan(LOWEST_PANEL_Z);
  });
});

describe('every marker stays under the panels', () => {
  it('is below the overlay, and therefore below every panel inside it', () => {
    expect(markerZCeiling()).toBeLessThan(ROOM_OVERLAY_Z);
  });

  it('is below the lowest panel too, so the claim holds even if the wrapper is ever flattened', () => {
    expect(markerZCeiling()).toBeLessThan(LOWEST_PANEL_Z);
  });

  it('stays a positive z-index, so a marker is still over the canvas it annotates', () => {
    // The other failure mode, and the one a "just set it to 0" fix would walk into: the
    // canvas is an in-flow descendant of its container, so a marker at a negative z-index is
    // painted behind the very picture it is pointing at.
    expect(MARKER_Z_RANGE[1]).toBeGreaterThan(0);
    expect(MARKER_Z_RANGE_EXPANDED[1]).toBeGreaterThan(0);
  });

  it('puts an opened card above every collapsed marker, which is what opening one is for', () => {
    expect(MARKER_Z_RANGE_EXPANDED[1]).toBeGreaterThan(MARKER_Z_RANGE[0]);
  });

  it('orders both ranges near-first, the way drei reads the pair', () => {
    // drei maps the camera's `near` onto element 0 and its `far` onto element 1, so a range
    // written the other way round would put the markers furthest away on top.
    expect(MARKER_Z_RANGE[0]).toBeGreaterThan(MARKER_Z_RANGE[1]);
    expect(MARKER_Z_RANGE_EXPANDED[0]).toBeGreaterThan(MARKER_Z_RANGE_EXPANDED[1]);
  });
});

describe('every marker in the family is on one of those layers', () => {
  /**
   * The two components that draw a comment bubble or a review pin.
   *
   * Named rather than discovered, the way cutPick.test.ts names its pick paths: a marker
   * drawn from a third file is exactly the drift this guard is for, and a scan that found it
   * automatically would also find it silently.
   */
  const MARKER_FILES = [
    'components/Scene/SpatialComments.tsx',
    'components/Scene/ReviewArtifacts.tsx',
  ];

  it('gives every <Html> in them a range from markerLayers, and never drei’s default', () => {
    for (const path of MARKER_FILES) {
      const text = source(path);
      const htmls = text.match(/<Html\b/g) ?? [];
      expect(htmls.length, `${path} has no <Html> left to be layered`).toBeGreaterThan(0);
      const ranges = text.match(/zIndexRange=\{([^}]*)\}/g) ?? [];
      // One range per <Html>, and every one of them a constant from markerLayers rather than
      // a number written at the call site — a literal here is a fourth place the threshold
      // has to be kept in step by hand.
      expect(ranges.length, `${path} has an <Html> with drei's 16777271 default`).toBe(htmls.length);
      for (const range of ranges) {
        expect(range, `${path}: ${range}`).toMatch(/MARKER_Z_RANGE(_EXPANDED)?/);
      }
    }
  });

  it('leaves the other <Html> users alone, because they were already under the panels', () => {
    // Asserted so that the exemption is a decision on the record and not an oversight. Each
    // of these passes `zIndexRange={[0, 0]}` and has done so since before this task.
    for (const path of [
      'components/Scene/UserLaser.tsx',
      'components/Scene/RemoteParticipant.tsx',
      'components/Scene/Agent.tsx',
      'components/Scene/ImportedModel.tsx',
      'components/Scene/ViewpointCanvas.tsx',
    ]) {
      expect(source(path), `${path} moved onto the markers' layer`).not.toMatch(/MARKER_Z_RANGE/);
    }
  });
});

describe('the fade', () => {
  it('is faint enough to read as hidden and strong enough to still be there', () => {
    // 0 would take the answer to "is there a comment back there?" with it, which is the
    // reason to orbit in the first place; much above 0.3 and the text behind the model is
    // legible again, which is the complaint this task started from.
    expect(MARKER_OCCLUDED_OPACITY).toBeGreaterThan(0);
    expect(MARKER_OCCLUDED_OPACITY).toBeLessThanOrEqual(0.3);
  });
});
