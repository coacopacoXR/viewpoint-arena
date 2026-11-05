// The cut filter, and the guard that it stays ONE filter.
//
// lib/scene/cutPick.ts exists because three's `Raycaster` does not know a clipping plane
// exists: it tests geometry, and clipping happens later in the fragment shader, so a ray
// aimed at a model the room has cut in half reports hits on BOTH halves. The behavioural
// half of that is covered in cutPlane.test.ts against a real Raycaster over a real clipped
// model. What is covered here is the half that decays silently — that every pick path in
// the app goes through it.
//
// There is no single function every pick goes through. There are six places that raycast,
// each with its own loop over the hits, and the failure mode of a seventh one added later
// is a laser that names a part nobody can see, or a pin dropped on a face the meeting has
// just cut off — neither of which throws, and both of which look like the model is wrong
// rather than like a filter is missing. So the list is asserted against the sources.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as THREE from 'three';
import { firstUncutHit, isHitCutAway, uncutHits } from '../cutPick';
import { CUT_PLANE, cutEnabled, setCutEnabled, writeCutPlane } from '../cutPlane';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Every `.tsx`/`.ts` under a directory, recursively, as repo-relative posix paths. */
function sources(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(REPO_ROOT, path)).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path.split(sep).join('/'));
  }
  return out;
}

/**
 * The places that raycast the whole scene, and the one that is allowed not to filter.
 *
 * `PerfProbe` is the `?perf=1` benchmark's own measurement of what a whole-scene
 * `intersectObjects` costs. Filtering it would make the `raycast ms` column of
 * perf/results/laser.md depend on whether a cut happened to be on, and that table is the
 * control the rest of the task is measured against — so it is exempt on purpose and named
 * here rather than silently skipped.
 */
const EXEMPT = new Set(['components/Scene/PerfProbe.tsx']);

describe('every raycast in the app goes through the one cut filter', () => {
  it('wraps each whole-scene intersectObjects in uncutHits', () => {
    const offenders: string[] = [];
    const wrapped: string[] = [];

    for (const path of sources('components')) {
      if (EXEMPT.has(path)) continue;
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      let index = source.indexOf('.intersectObjects(');
      while (index !== -1) {
        const line = source.slice(0, index).split('\n').length;
        const at = `${path}:${line}`;
        // The filter WRAPS the raycast, so what sits between `uncutHits(` and
        // `.intersectObjects(` is the raycaster's own name and nothing else. A window rather
        // than a parse: the idiom in every pick path is one line, and this is a guard on a
        // shape rather than a compiler.
        const before = source.slice(Math.max(0, index - 80), index);
        if (/uncutHits\(\s*[A-Za-z_$][\w$.]*\s*$/.test(before)) wrapped.push(at);
        else offenders.push(`${at} — ${before.split('\n').pop()?.trim()}`);
        index = source.indexOf('.intersectObjects(', index + 1);
      }
    }

    // The list is asserted as well as the rule, so that removing a pick path is as visible
    // as adding one: a guard that passes because there is nothing left to guard is not a
    // guard. Six sites — the laser and its dwell, the touch laser, a headset controller,
    // the Edit-mode click, and the comment placement preview and click.
    expect(offenders).toEqual([]);
    expect(wrapped.length).toBeGreaterThanOrEqual(6);
    const sites = wrapped.join('\n');
    for (const file of ['UserLaser.tsx', 'MobileLaser.tsx', 'XRManager.tsx', 'SceneClickSelect.tsx', 'SpatialComments.tsx']) {
      expect(sites).toContain(file);
    }
  });

  it('names the exempt benchmark probe, so the exemption cannot grow quietly', () => {
    expect([...EXEMPT]).toEqual(['components/Scene/PerfProbe.tsx']);
    const source = readFileSync(join(REPO_ROOT, 'components/Scene/PerfProbe.tsx'), 'utf8');
    expect(source).toContain('intersectObjects');
    expect(source).not.toContain('uncutHits');
  });

  it('covers the marker occlusion raycast, which lives in lib/scene rather than components', () => {
    // Task 09a's seventh pick path, and the reason this file's scan of `components/` is not
    // enough on its own: "is the model hiding this comment?" is a raycast too, and a marker
    // that stayed faded behind a section the meeting had just cut away would be exactly the
    // drift the guard above exists to catch — it would just be caught by nobody.
    //
    // Named rather than folded into the scan because `sources('lib')` would also pick up
    // every fixture in lib/**/__tests__ that raycasts on purpose without the filter.
    const source = readFileSync(join(REPO_ROOT, 'lib/scene/markerOcclusion.ts'), 'utf8');
    const at = source.indexOf('.intersectObjects(');
    expect(at, 'markerOcclusion no longer raycasts — this guard has nothing left to guard').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, at - 80), at)).toMatch(/uncutHits\(\s*[A-Za-z_$][\w$.]*\s*$/);
    expect(source.indexOf('.intersectObjects(', at + 1), 'a second, unfiltered raycast appeared').toBe(-1);
  });
});

describe('uncutHits', () => {
  const point = (x: number): { point: THREE.Vector3; distance: number; name: string } => ({
    point: new THREE.Vector3(x, 0, 0),
    distance: Math.abs(x),
    name: `at ${x}`,
  });

  /** A cut at x = 0 with the positive side taken away. */
  function cutAtZero() {
    const bounds = new THREE.Box3(new THREE.Vector3(-10, -1, -1), new THREE.Vector3(10, 1, 1));
    writeCutPlane({ axis: 'x', position: 0.5, flip: false }, bounds);
    setCutEnabled(true);
  }

  it('drops the hits on the clipped side and keeps the rest in order', () => {
    cutAtZero();
    try {
      const hits = [point(-4), point(-1), point(2), point(6)];
      const kept = uncutHits(hits);
      expect(kept.map((hit) => hit.name)).toEqual(['at -4', 'at -1']);
    } finally {
      setCutEnabled(false);
    }
  });

  it('hands back the SAME array when it dropped nothing', () => {
    cutAtZero();
    try {
      const hits = [point(-4), point(-1)];
      // The ordinary case — no cut, or a cut the ray never reached — and what keeps a laser
      // running sixty times a second from allocating sixty arrays a second.
      expect(uncutHits(hits)).toBe(hits);
    } finally {
      setCutEnabled(false);
    }
  });

  it('copies rather than splices, so a caller holding the raycast’s array is not edited under', () => {
    cutAtZero();
    try {
      const hits = [point(-4), point(2)];
      const kept = uncutHits(hits);
      expect(hits).toHaveLength(2);
      expect(kept).not.toBe(hits);
    } finally {
      setCutEnabled(false);
    }
  });

  it('drops nothing at all while the room is not cutting', () => {
    writeCutPlane({ axis: 'x', position: 0.5, flip: false }, new THREE.Box3(new THREE.Vector3(-10, -1, -1), new THREE.Vector3(10, 1, 1)));
    setCutEnabled(false);
    const hits = [point(-4), point(2), point(6)];
    expect(uncutHits(hits)).toBe(hits);
    expect(isHitCutAway(point(6))).toBe(false);
  });

  it('answers the nearest kept hit, and null once the cut has taken them all', () => {
    cutAtZero();
    try {
      expect(firstUncutHit([point(6), point(-4), point(2)])?.name).toBe('at -4');
      expect(firstUncutHit([point(6), point(2)])).toBeNull();
      expect(firstUncutHit([])).toBeNull();
    } finally {
      setCutEnabled(false);
    }
  });

  it('is the same sign the renderer clips on, at the plane and either side of it', () => {
    cutAtZero();
    try {
      // Three discards where the signed distance is strictly negative, so a fragment ON the
      // plane is drawn — and a hit on it has to survive the filter, or the last click of a
      // drag would select nothing at all.
      expect(CUT_PLANE.distanceToPoint(new THREE.Vector3(0, 0, 0))).toBe(0);
      expect(isHitCutAway(point(0))).toBe(false);
      expect(isHitCutAway(point(-0.001))).toBe(false);
      expect(isHitCutAway(point(0.001))).toBe(true);
      expect(cutEnabled()).toBe(true);
    } finally {
      setCutEnabled(false);
    }
  });

  it('says a hit it was handed nothing is not one the cut took', () => {
    cutAtZero();
    try {
      expect(isHitCutAway(null)).toBe(false);
      expect(isHitCutAway(undefined)).toBe(false);
    } finally {
      setCutEnabled(false);
    }
  });
});
