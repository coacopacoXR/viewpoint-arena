#!/usr/bin/env -S npx tsx
// convert-service/scripts/parity.mjs
//
// Prints the tree the BROWSER builds for a STEP file next to the tree the
// CONVERTED GLB builds, and says whether they match.
//
//   npx tsx convert-service/scripts/parity.mjs
//   npx tsx convert-service/scripts/parity.mjs --step my.step --glb my.glb
//   npx tsx convert-service/scripts/parity.mjs --glb /tmp/out.glb     # keep the GLB
//
// With no --glb it converts the fixture itself by running the service image
// (`docker compose run --rm convert-service …`) into a temp directory, so one
// command compares the two paths end to end. Nothing is written into the repo.
//
// Why this exists when tests/test_conversion.py already asserts a tree: that test
// pins the tree against a literal, so it proves the converter is stable but not
// that it agrees with the browser. This script runs the browser's own code —
// occt-import-js, cadResultToGroup and buildSceneTree — on the same file, which
// is the only comparison that means anything. Per-part identity in this app is
// positional (userData.nodeId is assigned while walking the tree), so a tree that
// differs by one level moves every pin in every review that used to be a STEP
// file. See convert-service/README.md §3.
//
// Run with tsx, not node: it imports the app's TypeScript modules directly, which
// is the point — a reimplementation of cadResultToGroup here would only ever
// agree with itself.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import occtimportjs from 'occt-import-js';

import { CAD_TESSELLATION_PARAMS } from '../../utils/cadImport.ts';
import { cadResultToGroup } from '../../utils/cadToThree.ts';
import { buildSceneTree, parseModelFile } from '../../utils/modelLoader.ts';
import { upAxisFor } from '../../utils/modelFormats.ts';

const EOL = String.fromCharCode(10);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const DEFAULT_STEP = resolve(HERE, '../tests/fixtures/assembly.step');

// parseModelFile's rotation for a Z-up import. Rebuilt here rather than imported
// because modelLoader.ts does not export it; test_formats.py pins the two against
// each other so they cannot drift.
const Z_UP_TO_Y_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

// ─── Arguments ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
};
const flag = (name) => argv.includes(name);

const STEP_PATH = resolve(option('--step') ?? DEFAULT_STEP);
const GIVEN_GLB = option('--glb') ? resolve(option('--glb')) : undefined;
const KEEP = flag('--keep');

if (!existsSync(STEP_PATH)) {
    console.error(`parity: no STEP file at ${STEP_PATH}`);
    console.error('       generate it with: docker compose run --rm convert-service python scripts/make_fixtures.py');
    process.exit(2);
}

// ─── Getting a GLB ──────────────────────────────────────────────────────────

const convertWithDocker = (stepPath, directory) => {
    const input = join(directory, 'input.step');
    copyFileSync(stepPath, input);
    writeFileSync(
        join(directory, 'job.json'),
        JSON.stringify({
            input: '/parity/input.step',
            output: '/parity/model.glb',
            reader: 'step',
            // The scene is named after this, exactly as cadResultToGroup names its
            // root group after the file.
            fileName: basename(stepPath),
            gltfpack: 'gltfpack',
        })
    );

    const run = spawnSync(
        'docker',
        [
            'compose', 'run', '--rm', '--no-deps', '-T',
            '-v', `${directory}:/parity`,
            'convert-service',
            'python', '-m', 'convert_service.worker',
            '--job', '/parity/job.json',
            '--result', '/parity/result.json',
        ],
        { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    if (run.status !== 0) {
        throw new Error(`docker compose run convert-service exited ${run.status}`);
    }
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'));
    if (!result.ok) {
        throw new Error(`the conversion failed: ${result.code} — ${result.detail ?? ''}`);
    }
    return { glb: join(directory, 'model.glb'), result };
};

// ─── The two paths ──────────────────────────────────────────────────────────

/** The world-space box of a mesh's VERTICES, not of its local bounding box. */
const exactWorldBox = (mesh) => {
    const box = new THREE.Box3();
    const position = mesh.geometry.attributes.position;
    const point = new THREE.Vector3();
    for (let index = 0; index < position.count; index += 1) {
        box.expandByPoint(point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
    }
    return box;
};

/** What parseModelFile does after a reader hands it an object, minus the parts
 *  that cannot change a tree: applySceneDefaults touches materials and
 *  centerModel scales and moves the root. buildSceneTree is the real one. */
const treeFrom = (loadedObject, baseName, extension) => {
    if (upAxisFor(extension) === 'z') loadedObject.applyQuaternion(Z_UP_TO_Y_UP);

    const rootGroup = new THREE.Group();
    rootGroup.name = baseName;
    rootGroup.add(loadedObject);

    const tree = buildSceneTree(rootGroup, { value: 0 }, 'parity');

    let parts = 0;
    let triangles = 0;
    const boxes = [];
    rootGroup.updateMatrixWorld(true);
    rootGroup.traverse((child) => {
        if (child.isMesh) {
            parts += 1;
            const geometry = child.geometry;
            triangles += geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
            boxes.push(exactWorldBox(child));
        }
    });

    // The union of the exact part boxes, NOT Box3.setFromObject(root): that one
    // transforms each mesh's local bounding box, so a part whose rotation lives in
    // a node matrix reports the box of a rotated box. The browser path bakes
    // rotations into vertices and the server path puts them in matrices, so the
    // inflated measurement would show a difference that is not in the geometry.
    const size = boxes.reduce((total, box) => total.union(box), new THREE.Box3()).getSize(new THREE.Vector3());

    return { tree, size, parts, triangles, boxes };
};

const browserPath = async (stepPath) => {
    const bytes = new Uint8Array(readFileSync(stepPath));
    const started = performance.now();
    const occt = await occtimportjs();
    const extension = `.${basename(stepPath).split('.').pop().toLowerCase()}`;
    const reader = { '.step': 'ReadStepFile', '.stp': 'ReadStepFile', '.iges': 'ReadIgesFile', '.igs': 'ReadIgesFile', '.brep': 'ReadBrepFile', '.brp': 'ReadBrepFile' }[extension];
    if (!reader) throw new Error(`parity: no browser reader for ${extension}`);
    const result = occt[reader](bytes, CAD_TESSELLATION_PARAMS);
    if (!result.success) throw new Error(`occt-import-js refused ${basename(stepPath)}`);
    const elapsed = performance.now() - started;

    const baseName = basename(stepPath).replace(/\.[^/.]+$/, '');
    return { ...treeFrom(cadResultToGroup(result, baseName), baseName, extension), ms: elapsed, readerResult: result };
};

const serverPath = async (glbPath, baseName) => {
    const bytes = readFileSync(glbPath);
    const started = performance.now();
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    await MeshoptDecoder.ready;
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const elapsed = performance.now() - started;

    return { ...treeFrom(gltf.scene, baseName, '.glb'), ms: elapsed, gltf };
};

// ─── Printing ───────────────────────────────────────────────────────────────

const lines = (node, depth = 0, rename = (name) => name) => {
    const pad = '  '.repeat(depth);
    const head = `${pad}${rename(node.name || '<unnamed>')} [${node.type}]`;
    return [head, ...(node.children ?? []).flatMap((child) => lines(child, depth + 1, rename))];
};

// GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, which
// turns whitespace into underscores and strips [ ] . : / , and then through
// createUniqueName, which appends _1, _2 … to any name the file already used.
// Both happen to EVERY .glb the app loads, whatever produced it, so a converted
// assembly cannot avoid them — and a CAD assembly is full of the two things that
// trigger them (spaces in part names, and one part instanced fifty times). This
// is the normalisation the comparison applies to both sides so that what is left
// is a real structural difference rather than three.js's spelling.
const canonical = (name) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        // Repeatedly, because GLTFLoader's uniqueness suffix lands ON TOP of a
        // part number: "Fastener 04" becomes "Fastener_04_7" in a file that
        // instances it seven times, and both suffixes are bookkeeping.
        .replace(/(?: \d+)+$/, '');

const sideBySide = (left, right) => {
    const width = Math.max(...left.map((line) => line.length), 46) + 3;
    const rows = Math.max(left.length, right.length);
    const out = [];
    for (let index = 0; index < rows; index += 1) {
        const a = left[index] ?? '';
        const b = right[index] ?? '';
        out.push(`${a.padEnd(width)}${b}${a === b ? '' : '   <-- differs'}`);
    }
    return out;
};

const main = async () => {
    const baseName = basename(STEP_PATH).replace(/\.[^/.]+$/, '');
    const browser = await browserPath(STEP_PATH);

    let cleanup = null;
    let glbPath = GIVEN_GLB;
    let conversion = null;
    if (!glbPath) {
        const directory = mkdtempSync(join(tmpdir(), 'va-parity-'));
        cleanup = directory;
        console.log(`parity: converting ${basename(STEP_PATH)} in the service image…`);
        const converted = convertWithDocker(STEP_PATH, directory);
        glbPath = converted.glb;
        conversion = converted.result;
    }
    if (!existsSync(glbPath)) throw new Error(`parity: no GLB at ${glbPath}`);

    const server = await serverPath(glbPath, baseName);

    const left = lines(browser.tree);
    const right = lines(server.tree);

    console.log('');
    console.log(
        sideBySide(
            ['BROWSER  (occt-import-js + cadResultToGroup)'],
            ['SERVER   (convert-service GLB + GLTFLoader)']
        ).join('\n')
    );
    console.log('─'.repeat(100));
    console.log(sideBySide(left, right).join('\n'));
    console.log('');

    const rows = [
        ['rows in the tree', left.length, right.length],
        ['pickable parts (meshes)', browser.parts, server.parts],
        ['triangles', browser.triangles, server.triangles],
        [`size x (mm)`, browser.size.x.toFixed(3), server.size.x.toFixed(3)],
        [`size y (mm)`, browser.size.y.toFixed(3), server.size.y.toFixed(3)],
        [`size z (mm)`, browser.size.z.toFixed(3), server.size.z.toFixed(3)],
        // Not a parity check: the browser column includes tessellating the file
        // in WASM, the server column is only GLTFLoader reading a finished mesh.
        ['seconds (load)', (browser.ms / 1000).toFixed(2), (server.ms / 1000).toFixed(2)],
    ];
    console.log('                          BROWSER          SERVER');
    for (const [label, a, b] of rows) {
        const differs = String(a) === String(b) ? '' : '<-- differs';
        console.log(`  ${label.padEnd(24)}${String(a).padEnd(17)}${String(b).padEnd(12)}${label.startsWith('seconds') ? '' : differs}`);
    }
    if (conversion) {
        console.log('');
        console.log(`  service reported: ${conversion.partCount} parts, ${conversion.triangleCount} triangles,`
            + ` ${conversion.uniqueMeshes} unique meshes, ${conversion.convertMs} ms`);
        console.log(`  glb: ${(readFileSync(glbPath).length / 1024).toFixed(1)} KiB`
            + (KEEP ? ` (kept at ${glbPath})` : ''));
    }

    // The app's own entry point, as a cross-check that the inline path above is
    // not the only thing that agrees: if parseModelFile builds the same tree from
    // the GLB, a participant importing it gets what is printed here.
    const viaParseModelFile = await parseModelFile(new File([readFileSync(glbPath)], `${baseName}.glb`));
    const appLines = lines(viaParseModelFile.sceneTree);
    const sameAsInline = JSON.stringify(appLines) === JSON.stringify(right);

    // Per-part bounding boxes, matched by position in the (identical) depth-first
    // walk. This is what separates "the two kernels tessellated the same B-rep at
    // slightly different densities" from "the server dropped geometry": a missing
    // face moves a part's box, a coarser chord tolerance does not.
    const boxDrift = browser.boxes.map((box, index) => {
        const other = server.boxes[index];
        if (!other) return Number.POSITIVE_INFINITY;
        return Math.max(
            Math.abs(box.min.x - other.min.x), Math.abs(box.min.y - other.min.y),
            Math.abs(box.min.z - other.min.z), Math.abs(box.max.x - other.max.x),
            Math.abs(box.max.y - other.max.y), Math.abs(box.max.z - other.max.z)
        );
    });
    const worstDrift = boxDrift.length ? Math.max(...boxDrift) : Number.NaN;
    // 0.01 mm: far below the chord tolerance the two kernels share, so anything
    // over it is a placement bug rather than a tessellation difference.
    const drifted = boxDrift.filter((value) => value > 0.01).length;

    const canonicalLeft = lines(browser.tree, 0, canonical);
    const canonicalRight = lines(server.tree, 0, canonical);
    const structureMatches = JSON.stringify(canonicalLeft) === JSON.stringify(canonicalRight);

    console.log('');
    console.log(`  tree identical (raw names):        ${JSON.stringify(left) === JSON.stringify(right) ? 'YES' : 'no'}`);
    console.log(`  tree identical (canonical names):  ${structureMatches ? 'YES' : 'NO'}`);
    console.log(`  parseModelFile agrees:             ${sameAsInline ? 'YES' : 'NO'}`);
    console.log(`  parts identical:                   ${browser.parts === server.parts ? 'YES' : 'NO'}`);
    console.log(`  triangles identical:               ${browser.triangles === server.triangles ? 'YES' : 'NO'}`
        + `  (${browser.triangles} browser, ${server.triangles} server${browser.triangles === server.triangles ? '': `, ${(((server.triangles - browser.triangles) / browser.triangles) * 100).toFixed(1)}%`})`);
    console.log(`  worst per-part box drift:          ${worstDrift.toFixed(4)} mm`
        + `  (parts over 0.01 mm: ${drifted} of ${boxDrift.length})`);
    if (!structureMatches) {
        console.log('');
        console.log(sideBySide(canonicalLeft, canonicalRight).join(EOL));
    }

    if (cleanup && !KEEP) rmSync(cleanup, { recursive: true, force: true });

    // The exit code turns on STRUCTURE, not on spelling: names differ by
    // three.js's sanitisation for every GLB the app has ever loaded, while a
    // structural difference is what moves a pin. A triangle-count difference is
    // reported rather than fatal for the same reason — a reviewer may be running
    // this against an OCCT build that is not the one the browser's WASM was
    // compiled from — but with the pinned cadquery-ocp 8.0.1 it should be zero.
    if (!structureMatches || !sameAsInline || drifted > 0) process.exitCode = 1;
};

main().catch((error) => {
    console.error(`parity: ${error.message}`);
    process.exitCode = 2;
});
