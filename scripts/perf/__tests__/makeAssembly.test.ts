// The fixture generator's promises, checked without loading three.js: the GLB's
// JSON chunk is plain bytes at a known offset, and everything these tests assert
// — how many meshes, what they are called, how deeply they nest, whether any two
// parts share a mesh — is in that chunk.
//
// Determinism is the one that matters most and the one nothing else checks. Every
// row in perf/results/README.md is only comparable to the next one if the fixture
// it measured is byte-identical to the fixture the next run measures. A generator
// that quietly became order-dependent (a Set iteration, a Map keyed on object
// identity, a Math.random nobody noticed) would leave every later benchmark
// measuring a different assembly and still passing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const GENERATOR = join(REPO_ROOT, 'scripts', 'perf', 'make-assembly.mjs');

// Small enough to build in about a second, large enough to hold more than one
// subassembly and both classes of part.
const PARTS = 120;
const SEED = 1337;

const GLB_MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
}
interface Gltf {
  scenes: { nodes: number[] }[];
  nodes: GltfNode[];
  meshes: { primitives: unknown[] }[];
}

let dir = '';
let seeded: Buffer = Buffer.alloc(0);
let seededJson: Gltf;
let reseeded: Buffer = Buffer.alloc(0);
let budgeted: Buffer = Buffer.alloc(0);

/** Runs the generator and reads back the GLB, with its JSON chunk parsed. */
function generate(out: string, args: string[]): { bytes: Buffer; json: Gltf } {
  execFileSync(process.execPath, [GENERATOR, '--out', out, '--force', ...args], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
  });
  const bytes = readFileSync(out);
  expect(bytes.readUInt32LE(0), 'not a GLB').toBe(GLB_MAGIC);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16), 'first chunk is not JSON').toBe(JSON_CHUNK);
  return {
    bytes,
    json: JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf,
  };
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The names of the nodes that carry a part, which is what the scene tree shows. */
const partNames = (json: Gltf) =>
  json.nodes.filter((node) => node.mesh !== undefined).map((node) => node.name ?? '');

/** Depth of the node tree, counting the scene's own roots as depth 1. */
function depth(json: Gltf): number {
  const walk = (index: number, level: number): number =>
    (json.nodes[index].children ?? []).reduce(
      (deepest, child) => Math.max(deepest, walk(child, level + 1)),
      level,
    );
  return json.scenes[0].nodes.reduce((deepest, root) => Math.max(deepest, walk(root, 1)), 0);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vp-perf-assembly-'));
  const size = ['--parts', String(PARTS)];
  const first = generate(join(dir, 'a.glb'), [...size, '--seed', String(SEED)]);
  seeded = first.bytes;
  seededJson = first.json;
  reseeded = generate(join(dir, 'b.glb'), [...size, '--seed', String(SEED + 1)]).bytes;
  // Tight enough that the budget guard in the generator has to shrink the
  // triangle ranges to meet it, which is the behaviour under test.
  budgeted = generate(join(dir, 'c.glb'), [...size, '--max-mb', '5']).bytes;
}, 120_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('make-assembly.mjs', () => {
  it('is deterministic: the same seed and size write the same bytes', () => {
    const again = generate(join(dir, 'd.glb'), ['--parts', String(PARTS), '--seed', String(SEED)]);
    expect(sha256(again.bytes)).toBe(sha256(seeded));
  }, 120_000);

  it('a different seed writes a different assembly', () => {
    expect(sha256(reseeded)).not.toBe(sha256(seeded));
  });

  it('builds the part count asked for, one mesh each, sharing nothing', () => {
    expect(seededJson.meshes).toHaveLength(PARTS);

    const meshNodes = seededJson.nodes.filter((node) => node.mesh !== undefined);
    expect(meshNodes, 'every mesh is carried by exactly one node').toHaveLength(PARTS);
    // The point of the fixture: a STEP import shares no geometry between parts, so
    // an instancing or batching pass has real work to do. Two nodes carrying the
    // same mesh index would be exactly the sharing the benchmark must not have.
    expect(new Set(meshNodes.map((node) => node.mesh)).size).toBe(PARTS);
  });

  it('splits roughly 70% fastener repeats against 30% unique parts', () => {
    const names = partNames(seededJson);
    const fasteners = ['Bolt ', 'Socket Screw ', 'Nut ', 'Washer ', 'Spacer '];
    const repeats = names.filter((name) => fasteners.some((kind) => name.startsWith(kind)));

    const share = repeats.length / names.length;
    expect(share, `${repeats.length}/${names.length} parts were fasteners`).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.8);
  });

  it('nests parts three or four levels of group deep, named like a CAD tree', () => {
    // Assembly root, subassembly, module, and — for a fastener pattern — one more
    // group before the part itself.
    expect(depth(seededJson)).toBeGreaterThanOrEqual(4);

    const names = seededJson.nodes.map((node) => node.name ?? '');
    expect(names.some((name) => /^Subassembly \d+$/.test(name)), 'a subassembly group').toBe(true);
    expect(
      names.some((name) => /^(Bolt|Nut|Washer|Spacer|Socket Screw) M\d+ \(\d+\)$/.test(name)),
      'a fastener instance numbered the way a STEP import numbers it',
    ).toBe(true);
    expect(
      names.some((name) => /^(Bolt Pattern|Rail|Hole Set|Fastener Set|Rib Bay) /.test(name)),
      'a fastener pattern group',
    ).toBe(true);
  });

  it('keeps the file inside the size budget it was given', () => {
    expect(budgeted.byteLength / (1024 * 1024)).toBeLessThanOrEqual(5);
  });
});
