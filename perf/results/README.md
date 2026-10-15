# Perf benchmark results

`npm run perf` orbits a large synthetic assembly in the review scene and appends
one row per fixture size to the table below, so a change that claims to make big
models faster can be read against the run before it. `PERF_PARTS=800 npm run perf`
measures one size. It builds the app, starts the room server and
`scripts/perf/serve.mjs`, generates any missing fixture with
`scripts/perf/make-assembly.mjs` (seeded, so one size is one assembly every time,
written to the gitignored `perf/fixtures/`), then per size opens a room with
`?perf=1`, imports the fixture through the real file input, and drags the mouse
across the canvas for ten seconds while `components/Scene/PerfProbe.tsx` records.

`npm run perf` runs a SECOND scenario as well, which writes
[`laser.md`](./laser.md) rather than the table below: the same fixtures with the
pointing laser held up and the pointer swept across the model's own projected box,
so that everything a hit triggers — the raycast, the selection it writes, the tree
rows and highlight overlays that follow it — lands inside the frame times. The two
answer different questions: this table is what a frame costs to DRAW, that one is
what it costs to POINT AT, so a row from one is not a baseline for the other. Pass
`--grep` to `npm run perf` to run either on its own.

Columns: **parts** is the fixture's part meshes; **fixture** its size on disk;
**tris** and **calls** are `renderer.info` for one frame while orbiting, which is
what the batching, instancing and LOD tasks are measured against; **visible** is
the seconds from picking the file to the model's triangles reaching the renderer;
**median** and **p95** are frame times in ms over the orbit; **FPS** is
`1000 / median`; **heap** is `performance.memory.usedJSHeapSize` afterwards;
**gpu** is the GL implementation that drew it. The JSON file beside this one holds
every frame time the run recorded, plus the machine and browser.

**idle frames / 5 s** is the last column and answers a different question from all
the others: how many frames did the renderer draw over five seconds in which nobody
touched anything, after the orbit's damping had settled. It is a GPU-usage proxy —
`renderer.info.render.frame` counts `WebGLRenderer.render` calls, which is what an
untouched room costs when it keeps drawing itself. A scene that renders on demand
reads ~0 here; one that renders every interval reads hundreds. Rows written before
task 06 added the column are one cell short.

**FROM TASK 06 THE ORBIT SCENARIO MEASURES A MOVING CAMERA, NOT A NEUTRAL ONE.** The room
renders on demand, drops its pixel ratio to half while the camera moves and stops drawing parts
whose projected bounding sphere is under two pixels — all three of which are exactly what an
orbit triggers and all three of which switch themselves off the moment the drag ends. So an orbit
row's `tris` is the count with the small parts gone (3 559 014 → 2 491 078 at 3 200 parts on the
row that introduced it, with the file unchanged), and its `median` is the cost of a frame drawn at
half resolution. Neither is comparable to a row above the change without that in mind. The LASER
table is the control: a sweep holds the camera still, so none of the three applies to it and its
rows stay comparable across the change. `renderer.info` is read off the renderer after the run, so
`calls` is unaffected — it is still 8, which is what the batching assertion is really about.

**Frames are timed with vsync off**, so FPS is the render loop's own throughput
and not what a monitor shows — a scene drawing in 4 ms reports ~250 rather than
being pinned to 60. Deliberate: a number stuck at the refresh rate cannot tell a
change that halved the frame cost from one that did nothing. `playwright.config.ts`
also picks headless Chromium's GPU backend, because its default SwiftShader draws
these assemblies at seconds a frame.

**These numbers are machine-, browser- and GPU-dependent.** Check the `gpu`
column before believing any of them, and only compare rows from the same machine,
in the same browser, close together in time. A row is a baseline for the next row,
never an absolute score.

<!-- Rows below this line are appended by e2e/perf/orbit.perf.spec.ts. Keep the
     table last in the file: the spec appends to the end and does not reformat. -->

| date | git sha | parts | fixture | tris | calls | visible s | median ms | p95 ms | FPS | heap MB | gpu | idle frames / 5 s |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 2026-10-15 | 8481b9b | 800 | 81.3 MB | 2,901,416 | 802 | 1.4 | 10.80 | 17.30 | 92.6 | 124.9 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 8481b9b | 3200 | 108.3 MB | 3,559,014 | 3202 | 2.7 | 59.50 | 72.40 | 16.8 | 414.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 8481b9b | 10000 | 80.0 MB | 2,311,038 | 10002 | 16.0 | 207.70 | 230.10 | 4.8 | 414.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | f9a96f0 | 3200 | 108.3 MB | 3,559,014 | 8 | 1.8 | 4.30 | 6.10 | 232.6 | 168.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | f9a96f0 | 10000 | 80.0 MB | 2,311,038 | 8 | 1.2 | 11.40 | 14.70 | 87.7 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 091c0b3 | 3200 | 108.3 MB | 3,559,014 | 8 | 1.5 | 5.50 | 8.20 | 181.8 | 189.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 091c0b3 | 10000 | 80.0 MB | 2,311,038 | 8 | 1.2 | 16.40 | 22.40 | 61.0 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 3200 | 108.3 MB | 3,559,014 | 8 | 1.6 | 5.50 | 8.10 | 181.8 | 179.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 5256 |
| 2026-10-15 | 25b6a5d | 10000 | 80.0 MB | 2,311,038 | 8 | 1.2 | 16.00 | 22.00 | 62.5 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 1974 |
| 2026-10-15 | 25b6a5d | 3200 | 108.3 MB | 2,491,078 | 8 | 1.5 | 2.70 | 4.90 | 370.4 | 189.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 0 |
| 2026-10-15 | 25b6a5d | 10000 | 80.0 MB | 1,818,446 | 8 | 1.2 | 5.80 | 9.20 | 172.4 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 0 |
| 2026-10-15 | 25b6a5d | 3200 | 108.3 MB | 2,491,078 | 8 | 1.5 | 2.80 | 5.10 | 357.1 | 179.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 0 |
| 2026-10-15 | 25b6a5d | 10000 | 80.0 MB | 1,818,446 | 8 | 1.2 | 5.80 | 9.10 | 172.4 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 0 |
