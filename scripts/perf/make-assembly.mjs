#!/usr/bin/env node
// scripts/perf/make-assembly.mjs
//
// Builds the synthetic CAD assembly that e2e/perf/orbit.perf.spec.ts imports.
//
// Why synthetic at all: the benchmark has to run on a clean checkout, with no
// customer NDA file, no licence and no 200 MB download, and it has to build the
// SAME assembly on every machine — otherwise a frame time from this week cannot
// be compared with one from next. A seeded generator gives both, and it means
// the fixture is never committed (perf/fixtures/ is gitignored) so the repo does
// not carry a binary nobody can diff.
//
// Why it is not a grid of cubes: the cost the later tasks (batching, instancing,
// BVH, LOD) attack is per-PART, not per-triangle. A STEP import lands as
// thousands of small meshes sharing nothing, nested three or four levels deep,
// roughly 70% of them repeats of a handful of fastener shapes. A cube grid has
// one mesh per cube, no nesting and no repeats, so it would measure the wrong
// thing and make instancing look pointless.
//
// Usage:
//   node scripts/perf/make-assembly.mjs --parts 3200
//   node scripts/perf/make-assembly.mjs --parts 800 --seed 7 --out perf/fixtures/a.glb
//
// Presets the benchmark uses: 800, 3200, 10000 parts.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// GLTFExporter's binary path collects its buffers into a Blob and reads that Blob
// back with FileReader — a browser API Node does not ship. Blob.arrayBuffer() is
// the same read, so the shim is a few lines rather than a dependency (rule 5 of
// .qwen-tasks/00-RULES.md). The read is deferred to a macrotask because the
// exporter assigns its onloadend handler on the line AFTER it calls read.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      setTimeout(() => {
        blob.arrayBuffer().then(
          (buffer) => {
            this.result = buffer;
            this.onloadend?.();
          },
          (err) => {
            this.error = err;
            this.onerror?.();
            this.onloadend?.();
          },
        );
      }, 0);
    }
  };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ─── Shape of the assembly ───────────────────────────────────────────────────
// The brief's split: ~70% repeats of a small fastener set, ~30% one-off parts.
const REPEAT_FRACTION = 0.7;
const REPEAT_TRIS = [200, 800];
const UNIQUE_TRIS = [2000, 20000];

// The app refuses a model file over MAX_MODEL_FILE_BYTES (utils/modelFormats.ts,
// 200 MB), so a fixture that big is a fixture the benchmark cannot import. The
// default sits well under that because the browser has to hold the File, its
// SHA-256 pass, the parsed glTF and the uploaded buffers at the same time, and
// because the import itself is part of what the benchmark times.
const DEFAULT_MAX_MB = 140;

const MODULE_NAMES = [
  'Frame', 'Drive Unit', 'Gearbox', 'Piping', 'Enclosure',
  'Mounting Plate', 'Manifold', 'Bearing Housing', 'Linkage', 'Cover',
];
const PATTERN_NAMES = ['Bolt Pattern', 'Rail', 'Hole Set', 'Fastener Set', 'Rib Bay'];

// One material per finish rather than one per part: a STEP import collapses to a
// handful of colours, and materials are not what the per-part identity invariant
// is about (that is userData.modelId / nodeId / meshIndex).
const FINISHES = [
  { name: 'Steel', color: 0x9aa0a6, metalness: 0.85, roughness: 0.38 },
  { name: 'Blackened Steel', color: 0x3b3f45, metalness: 0.7, roughness: 0.55 },
  { name: 'Aluminium', color: 0xc9ccd1, metalness: 0.9, roughness: 0.28 },
  { name: 'Painted Blue', color: 0x2f5fa8, metalness: 0.15, roughness: 0.62 },
  { name: 'Zinc Plated', color: 0xb8bcc2, metalness: 0.6, roughness: 0.45 },
  { name: 'Rubber', color: 0x22252a, metalness: 0.0, roughness: 0.9 },
];

// ─── Deterministic RNG ───────────────────────────────────────────────────────
// mulberry32: 32-bit state, good enough for placing fasteners, and small enough
// to read. Every random number in this file comes from the one instance below,
// consumed in a fixed order, which is what makes two runs byte-identical.
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rngFloat = (rng, lo, hi) => lo + rng() * (hi - lo);
const rngInt = (rng, lo, hi) => Math.floor(rngFloat(rng, lo, hi + 1));
const rngPick = (rng, list) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

// ─── Geometry helpers ────────────────────────────────────────────────────────
const trianglesOf = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
const mid = ([lo, hi]) => (lo + hi) / 2;

// CAD tessellations carry no UVs and neither does an occt STEP import, so the
// attribute goes: it is 8 bytes per vertex of file and of upload for nothing.
function strip(g) {
  g.deleteAttribute('uv');
  return g;
}

// ExtrudeGeometry comes out non-indexed (3 vertices per triangle, 72 bytes of
// attributes each). Re-indexing it roughly halves the exported size, and
// mergeVertices only welds vertices whose every remaining attribute matches, so
// the hard edges an extrusion depends on survive it.
function weld(g) {
  return mergeVertices(strip(g), 1e-4);
}

// LatheGeometry derives its end-ring normals from the profile tangent and leaves
// them at the tangent's own length instead of unit length, and a degenerate
// triangle from computeVertexNormals has a zero-length one. Either makes
// GLTFExporter rebuild the attribute and warn once per mesh. The DIRECTIONS it
// writes are correct, so this rescales rather than recomputes — recomputing
// (computeVertexNormals) would smooth away the sharp corners a washer or a flange
// is defined by. Applied to every builder's output so the export is silent.
function unitNormals(g) {
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i += 1) {
    const x = n.getX(i);
    const y = n.getY(i);
    const z = n.getZ(i);
    const len = Math.hypot(x, y, z);
    if (len <= 1e-9) n.setXYZ(i, 0, 1, 0);
    else if (Math.abs(len - 1) > 1e-5) n.setXYZ(i, x / len, y / len, z / len);
  }
  n.needsUpdate = true;
  return g;
}

/**
 * Grow or shrink one integer detail parameter until the geometry lands within
 * `tolerance` of `target` triangles.
 *
 * Only the extrusion families need this: a cylinder, a torus and a lathe have a
 * closed-form triangle count so their callers solve for the parameter directly.
 * Earcut's output is not closed-form, but it is close to linear in the contour
 * vertex count, so one or two proportional steps converge. `build` must be pure
 * — it takes a detail number and nothing else — because it runs more than once
 * and must not consume the shared rng a second time.
 */
function fitDetail(build, target, initial, tolerance = 0.12, maxPasses = 3) {
  let detail = clampInt(initial, 3, 4096);
  let geometry = build(detail);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const measured = trianglesOf(geometry);
    if (measured <= 0) break;
    if (Math.abs(measured - target) / target <= tolerance) break;
    const next = clampInt(detail * (target / measured), 3, 4096);
    if (next === detail) break;
    detail = next;
    geometry.dispose();
    geometry = build(detail);
  }
  return geometry;
}

// ─── Fasteners (the repeating ~70%) ─────────────────────────────────────────
// Sizes in millimetres, roughly ISO 4014 / 4032 / 7089 for M6, M8, M10, M12.
// The app normalises the whole assembly to two scene units on import
// (centerModel in utils/modelLoader.ts), so the unit only has to be consistent.
const FASTENER_SIZES = [
  { size: 'M6', acrossFlats: 10, headHeight: 4, shankR: 3, boreR: 3, washerInner: 3.2, washerOuter: 6.6 },
  { size: 'M8', acrossFlats: 13, headHeight: 5.3, shankR: 4, boreR: 4, washerInner: 4.3, washerOuter: 8 },
  { size: 'M10', acrossFlats: 16, headHeight: 6.4, shankR: 5, boreR: 5, washerInner: 5.3, washerOuter: 10 },
  { size: 'M12', acrossFlats: 18, headHeight: 7.5, shankR: 6, boreR: 6, washerInner: 6.4, washerOuter: 12 },
];

const hexCircumradius = (acrossFlats) => acrossFlats / Math.sqrt(3);

function hexagonShape(circumradius) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const x = Math.cos(a) * circumradius;
    const y = Math.sin(a) * circumradius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function circlePath(radius, clockwise) {
  const path = new THREE.Path();
  path.absarc(0, 0, radius, 0, Math.PI * 2, clockwise);
  return path;
}

/** Hex head standing on a plain shank. Triangle count: 24 (head) + 6·segments. */
function buildBolt(p, detail) {
  const headR = hexCircumradius(p.acrossFlats);
  const head = new THREE.CylinderGeometry(headR, headR * 0.94, p.headHeight, 6, 1);
  head.translate(0, p.shankLength + p.headHeight / 2, 0);
  const shank = new THREE.CylinderGeometry(p.shankR, p.shankR, p.shankLength, detail, 2);
  shank.translate(0, p.shankLength / 2, 0);
  return mergeGeometries([strip(head), strip(shank)], false);
}

/** Cylinder head with a hex socket countersunk into it. */
function buildSocketScrew(p, detail) {
  const head = new THREE.CylinderGeometry(p.acrossFlats * 0.58, p.acrossFlats * 0.58, p.headHeight * 1.2, detail, 1);
  head.translate(0, p.shankLength + p.headHeight * 0.6, 0);
  const socket = new THREE.CylinderGeometry(hexCircumradius(p.acrossFlats) * 0.55, hexCircumradius(p.acrossFlats) * 0.55, p.headHeight * 0.7, 6, 1);
  socket.translate(0, p.shankLength + p.headHeight * 0.85, 0);
  const shank = new THREE.CylinderGeometry(p.shankR, p.shankR, p.shankLength, detail, 2);
  shank.translate(0, p.shankLength / 2, 0);
  return mergeGeometries([strip(head), strip(socket), strip(shank)], false);
}

/** Hex nut: a hexagonal prism with a bored hole, which is what an extrusion of a
 *  hexagon-with-a-circle gives, welded back into an indexed mesh. */
function buildNut(p, detail) {
  const shape = hexagonShape(hexCircumradius(p.acrossFlats));
  shape.holes.push(circlePath(p.boreR, true));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: p.headHeight * 1.25, bevelEnabled: false, curveSegments: detail, steps: 1,
  });
  g.rotateX(-Math.PI / 2); // an extrusion grows along +Z; a nut stands along +Y
  return weld(g);
}

/** Plain washer: a thin annulus. */
function buildWasher(p, detail) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, p.washerOuter, 0, Math.PI * 2, false);
  shape.holes.push(circlePath(p.washerInner, true));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: p.thickness, bevelEnabled: false, curveSegments: detail, steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  return weld(g);
}

/** Plain spacer sleeve: a lathed rectangle profile, indexed and cheap. */
function buildSpacer(p, detail) {
  const profile = [
    new THREE.Vector2(p.boreR, 0),
    new THREE.Vector2(p.boreR * 1.7, 0),
    new THREE.Vector2(p.boreR * 1.7, p.shankLength * 0.4),
    new THREE.Vector2(p.boreR, p.shankLength * 0.4),
  ];
  return strip(new THREE.LatheGeometry(profile, detail));
}

const FASTENER_KINDS = [
  { kind: 'Bolt', build: buildBolt, weight: 3 },
  { kind: 'Socket Screw', build: buildSocketScrew, weight: 2 },
  { kind: 'Nut', build: buildNut, weight: 3 },
  { kind: 'Washer', build: buildWasher, weight: 2 },
  { kind: 'Spacer', build: buildSpacer, weight: 1 },
];

/** Weighted pick, because "Bolt M8 (17)" should be common and "Spacer" rare. */
function pickFastenerKind(rng) {
  const total = FASTENER_KINDS.reduce((sum, k) => sum + k.weight, 0);
  let roll = rng() * total;
  for (const entry of FASTENER_KINDS) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return FASTENER_KINDS[FASTENER_KINDS.length - 1];
}

/**
 * Build one fastener TEMPLATE at a triangle target.
 *
 * Templates are built once per (kind, size, target) and then cloned per
 * instance — cloning is what keeps every repeat its own mesh node with its own
 * geometry, which is what a STEP import produces today and what the benchmark
 * has to reproduce, because shared geometry would let a future instancing pass
 * look like a win it did not earn.
 */
function buildFastenerTemplate(rng, targetTris) {
  const entry = pickFastenerKind(rng);
  const size = rngPick(rng, FASTENER_SIZES);
  const p = {
    ...size,
    shankLength: rngFloat(rng, 16, 60),
    thickness: rngFloat(rng, 1.2, 3),
  };

  const geometry = (() => {
    // Closed-form families: solve for the detail parameter instead of searching.
    if (entry.build === buildBolt) {
      return entry.build(p, clampInt((targetTris - 24) / 6, 8, 220));
    }
    if (entry.build === buildSocketScrew) {
      return entry.build(p, clampInt((targetTris - 24) / 10, 8, 160));
    }
    if (entry.build === buildSpacer) {
      // 4-point profile, so 3 bands of 2 triangles per segment.
      return entry.build(p, clampInt(targetTris / 6, 8, 220));
    }
    return fitDetail((detail) => entry.build(p, detail), targetTris, clampInt(targetTris / 24, 4, 400));
  })();

  geometry.computeBoundingBox();
  return {
    kind: entry.kind,
    size: size.size,
    geometry: unitNormals(geometry),
    triangles: trianglesOf(geometry),
  };
}

// ─── One-off parts (the unique ~30%) ────────────────────────────────────────

/**
 * A smooth solid whose wall is pushed about by a few sine harmonics — the shape
 * a cast housing or a formed cover tessellates to.
 * Closed form: radial · (2·heightBands + 2) triangles.
 */
function buildHousing(p, radial) {
  const bands = clampInt(radial / 4, 2, 512);
  const g = new THREE.CylinderGeometry(p.topR, p.bottomR, p.height, radial, bands, false);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-6) continue;
    const angle = Math.atan2(z, x);
    let k = 1;
    for (const h of p.harmonics) {
      k += h.amp * Math.sin(h.n * angle + h.phase + y * h.yFreq);
    }
    pos.setX(i, Math.cos(angle) * r * k);
    pos.setZ(i, Math.sin(angle) * r * k);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return strip(g);
}

function roundedRectShape(w, h, r) {
  const x = -w / 2;
  const y = -h / 2;
  const radius = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3);
  const s = new THREE.Shape();
  s.moveTo(x + radius, y);
  s.lineTo(x + w - radius, y);
  s.absarc(x + w - radius, y + radius, radius, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - radius);
  s.absarc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2, false);
  s.lineTo(x + radius, y + h);
  s.absarc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + radius);
  s.absarc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** A machined plate: filleted rectangle, bolt holes through it. */
function buildPlate(p, curveSegments) {
  const shape = roundedRectShape(p.width, p.depth, p.cornerR);
  for (const hole of p.holes) {
    const path = new THREE.Path();
    path.absarc(hole.x, hole.y, hole.r, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: p.thickness, bevelEnabled: false, curveSegments, steps: 1,
  });
  g.translate(0, 0, -p.thickness / 2);
  g.rotateX(-Math.PI / 2);
  return weld(g);
}

/** A box section with a rectangular slot milled through it and holes beside it. */
function buildChannel(p, curveSegments) {
  const shape = roundedRectShape(p.width, p.depth, p.cornerR);
  const slot = new THREE.Path();
  const sw = p.width * 0.45;
  const sd = p.depth * 0.35;
  slot.moveTo(-sw / 2, -sd / 2);
  slot.lineTo(sw / 2, -sd / 2);
  slot.lineTo(sw / 2, sd / 2);
  slot.lineTo(-sw / 2, sd / 2);
  slot.closePath();
  shape.holes.push(slot);
  for (const hole of p.holes) {
    const path = new THREE.Path();
    path.absarc(hole.x, hole.y, hole.r, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: p.height, bevelEnabled: false, curveSegments, steps: 1,
  });
  return weld(g);
}

/** A bearing race or ring gear. Closed form: 2 · radial · tubular triangles. */
function buildRace(p, tubular) {
  const radial = clampInt(tubular / 2, 3, 512);
  return strip(new THREE.TorusGeometry(p.majorR, p.minorR, radial, tubular));
}

/** A stepped flange, lathed from a profile the rng picked. */
function buildFlange(p, segments) {
  const profile = p.profile.map(([x, y]) => new THREE.Vector2(Math.max(1e-3, x), y));
  return strip(new THREE.LatheGeometry(profile, segments));
}

const UNIQUE_KINDS = [
  { label: 'Housing', build: buildHousing, family: 'cylinder' },
  { label: 'Plate', build: buildPlate, family: 'extrude' },
  { label: 'Box Section', build: buildChannel, family: 'extrude' },
  { label: 'Bearing Race', build: buildRace, family: 'torus' },
  { label: 'Flange', build: buildFlange, family: 'lathe' },
];

/**
 * Sample every random decision for one unique part up front, then build.
 *
 * The split matters: fitDetail may call `build` several times, and a build that
 * read from the shared rng would consume a different amount of randomness on
 * each pass, so the same seed would produce a different assembly depending on
 * how many correction passes a part happened to need.
 */
function sampleUniqueParams(rng) {
  const entry = rngPick(rng, UNIQUE_KINDS);

  if (entry.family === 'cylinder') {
    const bottomR = rngFloat(rng, 40, 160);
    return {
      entry,
      params: {
        bottomR,
        topR: bottomR * rngFloat(rng, 0.55, 1.1),
        height: rngFloat(rng, 60, 420),
        harmonics: Array.from({ length: rngInt(rng, 2, 4) }, () => ({
          n: rngInt(rng, 2, 9),
          amp: rngFloat(rng, 0.01, 0.07),
          phase: rngFloat(rng, 0, Math.PI * 2),
          yFreq: rngFloat(rng, 0.002, 0.02),
        })),
      },
      // radial · (2·bands + 2) with bands ≈ radial/4 → ≈ radial²/2
      detailFor: (target) => clampInt(Math.sqrt(2 * target) - 2, 8, 900),
    };
  }

  if (entry.build === buildRace) {
    const majorR = rngFloat(rng, 60, 200);
    return {
      entry,
      params: { majorR, minorR: majorR * rngFloat(rng, 0.08, 0.22) },
      detailFor: (target) => clampInt(Math.sqrt(target), 8, 900), // 2·(t/2)·t = t²
    };
  }

  if (entry.family === 'lathe') {
    const steps = rngInt(rng, 5, 9);
    const outerR = rngFloat(rng, 70, 220);
    const height = rngFloat(rng, 20, 90);
    const profile = [];
    for (let i = 0; i < steps; i += 1) {
      const t = i / (steps - 1);
      profile.push([outerR * (1 - 0.35 * t * t), height * t]);
      if (i < steps - 1) profile.push([outerR * rngFloat(rng, 0.5, 0.95), height * t + height / steps * 0.5]);
    }
    profile.push([outerR * 0.2, height]);
    return {
      entry,
      params: { profile },
      // segments · (points - 1) · 2
      detailFor: (target) => clampInt(target / (2 * Math.max(1, profile.length - 1)), 8, 900),
    };
  }

  // Extrusions: the hole layout is sampled here, the tessellation is fitted.
  const width = rngFloat(rng, 120, 420);
  const depth = rngFloat(rng, 90, 320);
  const holeCount = entry.build === buildChannel ? rngInt(rng, 2, 5) : rngInt(rng, 3, 12);
  // Laid out on a jittered grid rather than scattered: two overlapping holes make
  // earcut emit degenerate triangles, and a degenerate triangle has a zero-length
  // normal, which GLTFExporter then rebuilds and warns about once per mesh. A
  // grid is also what a real drilled plate has.
  const cols = Math.ceil(Math.sqrt(holeCount * (width / depth)));
  const rows = Math.ceil(holeCount / cols);
  const cellW = width / cols;
  const cellD = depth / rows;
  const holeR = Math.min(cellW, cellD) * 0.26;
  const holes = Array.from({ length: holeCount }, (_, i) => ({
    x: -width / 2 + cellW * ((i % cols) + 0.5) + rngFloat(rng, -cellW * 0.12, cellW * 0.12),
    y: -depth / 2 + cellD * (Math.floor(i / cols) + 0.5) + rngFloat(rng, -cellD * 0.12, cellD * 0.12),
    r: holeR * rngFloat(rng, 0.55, 1),
  }));
  return {
    entry,
    params: {
      width,
      depth,
      cornerR: rngFloat(rng, 4, 18),
      thickness: rngFloat(rng, 6, 28),
      height: rngFloat(rng, 40, 180),
      holes,
    },
    detailFor: (target) => clampInt(target / (8 * (holeCount + 4)), 3, 900),
  };
}

function buildUniquePart(rng, targetTris) {
  const sampled = sampleUniqueParams(rng);
  const geometry = fitDetail(
    (detail) => sampled.entry.build(sampled.params, detail),
    targetTris,
    sampled.detailFor(targetTris),
  );
  geometry.computeBoundingBox();
  return {
    label: sampled.entry.label,
    geometry: unitNormals(geometry),
    triangles: trianglesOf(geometry),
  };
}

// ─── Scene tree ──────────────────────────────────────────────────────────────
// Three or four levels of Group between the root and a mesh, the way a STEP
// assembly arrives: product → subassembly → module → (sometimes) a fastener
// pattern → part. The scene tree panel shows that path, so a fixture with a flat
// list of meshes would not exercise the same code.

function placeOnLattice(rng, cellIndex, cellSize, columns) {
  const col = cellIndex % columns;
  const row = Math.floor(cellIndex / columns);
  return new THREE.Vector3(
    (col - (columns - 1) / 2) * cellSize + rngFloat(rng, -cellSize * 0.2, cellSize * 0.2),
    0,
    (row - (columns - 1) / 2) * cellSize + rngFloat(rng, -cellSize * 0.2, cellSize * 0.2),
  );
}

function randomOrientation(rng) {
  const e = new THREE.Euler(
    rngPick(rng, [0, 0, Math.PI / 2, -Math.PI / 2]),
    rngFloat(rng, 0, Math.PI * 2),
    rngPick(rng, [0, 0, Math.PI / 2]),
  );
  return new THREE.Quaternion().setFromEuler(e);
}

/**
 * A fastener pattern: a bolt circle or a straight rail of instances, which is
 * where the repeats of one shape actually come from in a real assembly.
 * Returns the meshes it made so the caller can name them.
 */
function buildPattern(rng, template, material, count, patternGroup) {
  const circular = rng() < 0.45;
  const radius = rngFloat(rng, 60, 170);
  const pitch = rngFloat(rng, 28, 60);
  const made = [];
  for (let i = 0; i < count; i += 1) {
    const mesh = new THREE.Mesh(template.geometry.clone(), material);
    if (circular) {
      const a = (i / count) * Math.PI * 2;
      mesh.position.set(Math.cos(a) * radius, rngFloat(rng, -6, 6), Math.sin(a) * radius);
    } else {
      mesh.position.set((i - (count - 1) / 2) * pitch, rngFloat(rng, -4, 4), rngFloat(rng, -8, 8));
    }
    // Head down into the joint, and every fastener in the pattern parallel: the
    // pattern GROUP carries the random orientation (see buildAssembly), which is
    // how a bolt circle on an angled face actually looks. Orienting each instance
    // independently instead would scatter them, and scattered fasteners are the
    // one thing a real assembly never has.
    mesh.rotation.set(Math.PI, rngFloat(rng, -0.1, 0.1), 0);
    patternGroup.add(mesh);
    made.push(mesh);
  }
  return made;
}

function buildAssembly({ parts, seed, repeats, uniques, name }) {
  const rng = makeRng(seed);
  const root = new THREE.Group();
  root.name = name;

  const materials = FINISHES.map((f) => new THREE.MeshStandardMaterial({
    name: f.name, color: f.color, metalness: f.metalness, roughness: f.roughness,
  }));

  // A handful of subassemblies rather than one per part: enough nesting to be
  // realistic, few enough that a 10k-part fixture is not 10k top-level groups.
  const subassemblyCount = Math.max(2, Math.min(24, Math.round(parts / 140)));
  const columns = Math.ceil(Math.sqrt(subassemblyCount));
  const cellSize = 520;

  // Template cache, keyed by the shape AND its triangle target. Two repeats of
  // "Bolt M8" at different targets are different templates; the clone below is
  // what makes two repeats at the SAME target different meshes.
  const templateCache = new Map();
  const counters = new Map();
  let totalTriangles = 0;
  let meshCount = 0;

  const nextName = (label) => {
    const n = (counters.get(label) ?? 0) + 1;
    counters.set(label, n);
    return `${label} (${n})`;
  };

  const remaining = { repeat: repeats.count, unique: uniques.count };

  for (let s = 0; s < subassemblyCount; s += 1) {
    const subassembly = new THREE.Group();
    subassembly.name = `Subassembly ${s + 1}`;
    const origin = placeOnLattice(rng, s, cellSize, columns);
    subassembly.position.copy(origin);
    root.add(subassembly);

    const moduleCount = rngInt(rng, 2, 4);
    const last = s === subassemblyCount - 1;

    for (let m = 0; m < moduleCount; m += 1) {
      const module = new THREE.Group();
      module.name = rngPick(rng, MODULE_NAMES);
      module.position.set(
        rngFloat(rng, -cellSize * 0.3, cellSize * 0.3),
        rngFloat(rng, 0, cellSize * 0.5),
        rngFloat(rng, -cellSize * 0.3, cellSize * 0.3),
      );
      subassembly.add(module);

      // The last subassembly mops up whatever the even split left behind, so the
      // part count is exact rather than "roughly what was asked for".
      const share = (total, done) => {
        const groupsLeft = (subassemblyCount - s) * moduleCount - m;
        return last && m === moduleCount - 1
          ? total - done
          : Math.max(0, Math.round((total - done) / Math.max(1, groupsLeft)));
      };

      const uniqueHere = Math.min(remaining.unique, share(uniques.count, uniques.count - remaining.unique));
      const repeatHere = Math.min(remaining.repeat, share(repeats.count, repeats.count - remaining.repeat));

      // Unique parts first: they are the big ones and they define the volume the
      // fasteners then bolt onto.
      for (let u = 0; u < uniqueHere; u += 1) {
        const target = rngInt(rng, uniques.tris[0], uniques.tris[1]);
        const built = buildUniquePart(rng, target);
        const material = rngPick(rng, materials);
        const mesh = new THREE.Mesh(built.geometry, material);
        mesh.name = nextName(built.label);
        mesh.position.set(rngFloat(rng, -120, 120), rngFloat(rng, -90, 90), rngFloat(rng, -120, 120));
        mesh.quaternion.copy(randomOrientation(rng));
        const scale = rngFloat(rng, 0.7, 1.4);
        mesh.scale.setScalar(scale);
        module.add(mesh);
        totalTriangles += built.triangles;
        meshCount += 1;
        remaining.unique -= 1;
      }

      // Repeats go into a pattern group one level deeper, which is both the
      // realistic place for a bolt circle and the fourth level of nesting.
      let placed = 0;
      while (placed < repeatHere) {
        const target = rngInt(rng, repeats.tris[0], repeats.tris[1]);
        const key = `${target}`;
        let template = templateCache.get(key);
        if (!template) {
          template = buildFastenerTemplate(rng, target);
          templateCache.set(key, template);
        }
        const count = Math.min(rngInt(rng, 3, 14), repeatHere - placed);
        const pattern = new THREE.Group();
        pattern.name = `${rngPick(rng, PATTERN_NAMES)} ${template.kind} ${template.size}`;
        pattern.position.set(rngFloat(rng, -140, 140), rngFloat(rng, -100, 100), rngFloat(rng, -140, 140));
        pattern.quaternion.copy(randomOrientation(rng));
        module.add(pattern);

        const material = rngPick(rng, materials);
        const meshes = buildPattern(rng, template, material, count, pattern);
        for (const mesh of meshes) {
          mesh.name = nextName(`${template.kind} ${template.size}`);
          totalTriangles += template.triangles;
          meshCount += 1;
        }
        placed += count;
        remaining.repeat -= count;
      }
    }
  }

  root.updateMatrixWorld(true);
  return { root, meshCount, totalTriangles, templateCount: templateCache.size, materials };
}

// ─── Budget ──────────────────────────────────────────────────────────────────
// What a part costs in the exported GLB, in three terms:
//   · ~30 bytes per triangle — positions and normals at 24 bytes per vertex,
//     ~0.75 vertices per triangle on a tessellated solid, plus indices;
//   · ~6000 divided by the MEAN part size, in bytes per triangle, because a small
//     mesh has proportionally far more boundary vertices. Measured: a 2,900,000
//     triangle / 800 part assembly exported at 29.4 bytes per triangle, a
//     5,100,000 / 3200 one at 30.7, and a 500-triangle-per-part one at 35.7;
//   · ~1.2 KB of glTF JSON per part — a node, a mesh, three accessors and three
//     buffer views — which does not depend on the part's size at all, and is the
//     term that makes 10,000 parts cost far more than 4× 2,500.
// A flat bytes-per-triangle constant gets the last two wrong by ~25% at 10,000
// parts, which is how a fixture the app refuses to import gets written. The
// projection is still a model, so main() re-checks the real size and rebuilds.
const BYTES_PER_TRIANGLE = 30;
const SMALL_PART_BYTES_PER_TRIANGLE = 6000;
const BYTES_PER_PART_JSON = 1200;
// Plan to 90% of the cap. The builders have their own floors — a hex head alone
// is 24 triangles, so no bolt can come in under ~72 — and a plan that asks for
// less than a builder can produce comes back bigger than it was told to.
const PLAN_SAFETY = 0.9;
// Below this, a "unique 2k-20k triangle part" is not a unique part any more, and
// shrinking it further would quietly change what the fixture is. Past this point
// the whole assembly scales together instead.
const MIN_UNIQUE_SHARE = 0.05;

function projectedBytes(parts, repeatCount, uniqueCount, repeatTris, uniqueTris) {
  const tris = repeatCount * mid(repeatTris) + uniqueCount * mid(uniqueTris);
  const meanTris = tris / Math.max(1, parts);
  const perTriangle = BYTES_PER_TRIANGLE + SMALL_PART_BYTES_PER_TRIANGLE / Math.max(1, meanTris);
  return tris * perTriangle + parts * BYTES_PER_PART_JSON;
}

/**
 * The largest x in [lo, hi] satisfying `fits`, which must be monotone — true at x
 * implies true below x. Bisection rather than proportional stepping because the
 * projection is not linear in the scale: shrinking the parts raises the
 * bytes-per-triangle term, so stepping undershoots, overshoots and can oscillate.
 */
function bisect(lo, hi, fits) {
  if (!fits(lo)) return lo;
  if (fits(hi)) return hi;
  for (let i = 0; i < 48; i += 1) {
    const m = (lo + hi) / 2;
    if (fits(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/**
 * Decide how many triangles each class of part gets.
 *
 * The brief's ranges (200-800 for repeats, 2k-20k for unique) fit at 800 parts
 * and not at 3200 or 10000: 3000 unique parts at 11k triangles each is over
 * 800 MB of GLB, and the app refuses anything over 200 MB (MAX_MODEL_FILE_BYTES
 * in utils/modelFormats.ts). So the ranges shrink — the unique ones first,
 * because the fasteners are 70% of the part count and therefore essentially all
 * of the draw calls, which is the number the batching and instancing tasks are
 * judged on.
 */
function planBudget(parts, maxMb) {
  const repeatCount = Math.round(parts * REPEAT_FRACTION);
  const uniqueCount = parts - repeatCount;
  const maxBytes = maxMb * 1024 * 1024 * PLAN_SAFETY;
  const scaleRange = ([lo, hi], f) => [
    Math.max(24, Math.round(lo * f)),
    Math.max(48, Math.round(hi * f)),
  ];
  const bytesAt = (repeatScale, uniqueScale) => projectedBytes(
    parts, repeatCount, uniqueCount,
    scaleRange(REPEAT_TRIS, repeatScale), scaleRange(UNIQUE_TRIS, uniqueScale),
  );

  const uniqueOnly = bisect(0, 1, (u) => bytesAt(1, u) <= maxBytes);
  const uniform = uniqueOnly >= MIN_UNIQUE_SHARE
    ? 1
    : bisect(0, 1, (s) => bytesAt(s, s) <= maxBytes);
  const repeatScale = uniqueOnly >= MIN_UNIQUE_SHARE ? 1 : uniform;
  const uniqueScale = uniqueOnly >= MIN_UNIQUE_SHARE ? uniqueOnly : uniform;

  const repeatTris = scaleRange(REPEAT_TRIS, repeatScale);
  const uniqueTris = scaleRange(UNIQUE_TRIS, uniqueScale);
  const shrunk = repeatScale < 1 || uniqueScale < 1;

  return {
    repeatCount,
    uniqueCount,
    repeats: { count: repeatCount, tris: repeatTris },
    uniques: { count: uniqueCount, tris: uniqueTris },
    projected: projectedBytes(parts, repeatCount, uniqueCount, repeatTris, uniqueTris),
    note: shrunk
      ? `triangle ranges reduced to fit the ${maxMb} MB budget: ` +
        `repeats ${repeatTris[0]}-${repeatTris[1]}, unique ${uniqueTris[0]}-${uniqueTris[1]} ` +
        `(the brief asks for ${REPEAT_TRIS[0]}-${REPEAT_TRIS[1]} and ${UNIQUE_TRIS[0]}-${UNIQUE_TRIS[1]}, ` +
        `which at ${parts} parts is a file the app would refuse to import)`
      : null,
  };
}

/** Scales a plan down after a build came out bigger than projected. */
function shrinkPlan(plan, parts, factor) {
  const scaleRange = ([lo, hi], f) => [
    Math.max(24, Math.round(lo * f)),
    Math.max(48, Math.round(hi * f)),
  ];
  return {
    ...plan,
    repeats: { count: plan.repeatCount, tris: scaleRange(plan.repeats.tris, factor) },
    uniques: { count: plan.uniqueCount, tris: scaleRange(plan.uniques.tris, factor) },
    projected: projectedBytes(
      parts, plan.repeatCount, plan.uniqueCount,
      plan.repeats.tris, plan.uniques.tris,
    ) * factor,
  };
}

/** Frees a rejected build. At 10,000 parts the geometries are gigabytes of
 *  typed arrays, and the retry below would otherwise hold two builds at once. */
function disposeAssembly(root) {
  root.traverse((object) => {
    if (object.isMesh) object.geometry.dispose();
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const USAGE = `make-assembly.mjs — build a synthetic CAD assembly GLB for the perf benchmark

  --parts <n>      number of part meshes (required; presets 800, 3200, 10000)
  --seed <n>       rng seed, default 1337. Same seed + same parts = same bytes.
  --out <path>     output file, default perf/fixtures/assembly-<parts>.glb
  --max-mb <n>     refuse to write a fixture larger than this, default ${DEFAULT_MAX_MB}.
                   The app's own import cap is 200 MB (utils/modelFormats.ts).
  --force          overwrite an existing file (default: reuse it)
  -h, --help       this text
`;

function parseArgs(argv) {
  const out = { parts: null, seed: 1337, out: null, maxMb: DEFAULT_MAX_MB, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i];
    switch (arg) {
      case '--parts': out.parts = Number.parseInt(value(), 10); break;
      case '--seed': out.seed = Number.parseInt(value(), 10); break;
      case '--out': out.out = value(); break;
      case '--max-mb': out.maxMb = Number.parseFloat(value()); break;
      case '--force': out.force = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return out;
}

async function exportGlb(root) {
  const exporter = new GLTFExporter();
  return new Promise((done, fail) => {
    exporter.parse(root, done, fail, {
      binary: true,
      onlyVisible: true,
      truncateDrawRange: true,
      forceIndices: false,
    });
  });
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`make-assembly: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!Number.isFinite(args.parts) || args.parts < 1) {
    console.error(`make-assembly: --parts is required and must be a positive integer\n\n${USAGE}`);
    process.exit(2);
  }

  const outPath = resolve(REPO_ROOT, args.out ?? `perf/fixtures/assembly-${args.parts}.glb`);

  // Reused rather than rebuilt unless --force: a 3200-part fixture is a couple of
  // minutes of geometry work and ~100 MB of writing, and the generator is seeded,
  // so an existing file at the same path is the same file this run would make.
  // The benchmark calls this before every run and would otherwise pay that twice.
  if (!args.force && existsSync(outPath)) {
    const existing = statSync(outPath).size;
    console.log(
      `make-assembly: ${outPath} already exists (${formatBytes(existing)}), reusing it. ` +
      `Pass --force to rebuild.`,
    );
    return;
  }

  const started = Date.now();
  let plan = planBudget(args.parts, args.maxMb);
  if (plan.note) console.log(`make-assembly: ${plan.note}`);

  const name = `PerfAssembly_${args.parts}`;
  const maxBytes = args.maxMb * 1024 * 1024;

  // Build → export → measure, and rebuild smaller if the projection was off.
  // The projection in planBudget is a model of the exporter (its buffer padding,
  // its Uint16-vs-Uint32 index choice, the builders' own triangle floors); the
  // measured size is the truth, and one extra build is cheaper than a fixture the
  // app refuses to import. Reaching this loop at all means the estimate was wrong,
  // which the line it prints is there to make visible.
  let built = null;
  let glb = null;
  for (let attempt = 1; ; attempt += 1) {
    built = buildAssembly({
      parts: args.parts,
      seed: args.seed,
      repeats: plan.repeats,
      uniques: plan.uniques,
      name,
    });
    glb = await exportGlb(built.root);
    if (glb.byteLength <= maxBytes) break;

    if (attempt >= 3) {
      console.error(
        `make-assembly: FAIL — ${formatBytes(glb.byteLength)} still exceeds the ` +
        `${args.maxMb} MB budget after ${attempt} builds.\n` +
        `  Lower --max-mb, or raise it towards the app's own 200 MB cap if this\n` +
        `  machine can carry a fixture that size.`,
      );
      process.exit(1);
    }
    console.log(
      `make-assembly: ${formatBytes(glb.byteLength)} over the ${args.maxMb} MB budget ` +
      `(projected ${formatBytes(plan.projected)}), rebuilding smaller`,
    );
    disposeAssembly(built.root);
    // 0.92 rather than the exact ratio: shrinking the triangles also raises the
    // bytes-per-triangle cost, so the exact ratio would land back over the line.
    plan = shrinkPlan(plan, args.parts, (maxBytes * 0.92) / glb.byteLength);
  }

  const bytes = glb.byteLength;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(glb));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `make-assembly: ${outPath}\n` +
    `  parts ${built.meshCount} (${plan.repeats.count} repeat / ${plan.uniqueCount} unique), ` +
    `templates ${built.templateCount}, triangles ${built.totalTriangles.toLocaleString('en-US')}\n` +
    `  size ${formatBytes(bytes)} (~${(bytes / Math.max(1, built.totalTriangles)).toFixed(1)} bytes/triangle), ` +
    `seed ${args.seed}, built in ${elapsed}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
