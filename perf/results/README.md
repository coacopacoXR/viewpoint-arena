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

Columns: **parts** is the fixture's part meshes; **fixture** its size on disk;
**tris** and **calls** are `renderer.info` for one frame while orbiting, which is
what the batching, instancing and LOD tasks are measured against; **visible** is
the seconds from picking the file to the model's triangles reaching the renderer;
**median** and **p95** are frame times in ms over the orbit; **FPS** is
`1000 / median`; **heap** is `performance.memory.usedJSHeapSize` afterwards;
**gpu** is the GL implementation that drew it. The JSON file beside this one holds
every frame time the run recorded, plus the machine and browser.

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

| date | git sha | parts | fixture | tris | calls | visible s | median ms | p95 ms | FPS | heap MB | gpu |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-10-15 | 8481b9b | 800 | 81.3 MB | 2,901,416 | 802 | 1.4 | 10.80 | 17.30 | 92.6 | 124.9 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 8481b9b | 3200 | 108.3 MB | 3,559,014 | 3202 | 2.7 | 59.50 | 72.40 | 16.8 | 414.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 8481b9b | 10000 | 80.0 MB | 2,311,038 | 10002 | 16.0 | 207.70 | 230.10 | 4.8 | 414.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | f9a96f0 | 3200 | 108.3 MB | 3,559,014 | 8 | 1.8 | 4.30 | 6.10 | 232.6 | 168.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | f9a96f0 | 10000 | 80.0 MB | 2,311,038 | 8 | 1.2 | 11.40 | 14.70 | 87.7 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
