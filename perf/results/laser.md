# Laser sweep — what pointing at a large assembly costs

Appended by the second scenario in
[../../e2e/perf/orbit.perf.spec.ts](../../e2e/perf/orbit.perf.spec.ts): the same fixtures
with the pointing laser held up and the pointer swept across the model's own projected box,
so that everything a hit triggers — the raycast, the selection it writes, the tree rows and
highlight overlays that follow it — lands inside the frame times.

Do not compare a row here with one in [README.md](./README.md): that table orbits, which
never raycasts and never selects, so its frames are what a picture costs to DRAW and these
are what one costs to POINT AT. Same machine, same browser, close in time, or the pair means
nothing.

The last two columns are task 05d's, and they are the two halves the median cannot show.
**first hover ms** is the longest frame in a separate recording that holds nothing but the
laser's FIRST touch of a part — before the warm-up, so the warm-up is not hiding it — which
is where an overlay's material, its slice of the merged buffer, the tree's one-time mount of
a row per part and any new shader program all land. **raycast ms** is one whole-scene
`intersectObjects(scene.children, true)` on its own, with the pointer on the model and the
scene already warm, i.e. the pick path's share of a frame that also contains a store write
and a React pass. Rows written before they existed are two cells short.

| date | git sha | parts | tris | calls | visible s | median ms | p95 ms | FPS | heap MB | gpu | first hover ms | raycast ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| 2026-10-15 | 091c0b3 | 3200 | 3,559,014 | 9 | 1.7 | 39.40 | 62.90 | 25.4 | 242.2 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 091c0b3 | 10000 | 2,311,038 | 9 | 1.2 | 114.90 | 155.60 | 8.7 | 272.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 3200 | 3,559,014 | 9 | 1.1 | 38.90 | 65.80 | 25.7 | 242.2 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 10000 | 2,311,038 | 9 | 1.3 | 103.30 | 149.20 | 9.7 | 272.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 3200 | 3,559,014 | 9 | 1.1 | 37.70 | 61.00 | 26.5 | 242.2 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 10000 | 2,311,038 | 9 | 1.2 | 110.30 | 148.50 | 9.1 | 272.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 3200 | 3,559,014 | 9 | 1.0 | 36.20 | 63.20 | 27.6 | 214.6 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 25b6a5d | 10000 | 2,311,038 | 9 | 1.2 | 106.80 | 159.00 | 9.4 | 289.9 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | e09eb99 | 3200 | 3,559,014 | 9 | 1.1 | 36.80 | 58.80 | 27.2 | 214.6 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 60.80 | 22.78 |
| 2026-10-15 | e09eb99 | 10000 | 2,311,038 | 9 | 1.2 | 104.60 | 143.20 | 9.6 | 227.9 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 139.20 | 8.72 |
| 2026-10-16 | e09eb99 | 3200 | 3,559,014 | 9 | 1.1 | 22.90 | 97.60 | 43.7 | 179.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 128.10 | 22.02 |
| 2026-10-16 | e09eb99 | 10000 | 2,311,038 | 9 | 1.2 | 56.80 | 137.80 | 17.6 | 468.3 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) | 150.80 | 10.88 |
