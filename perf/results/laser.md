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

| date | git sha | parts | tris | calls | visible s | median ms | p95 ms | FPS | heap MB | gpu |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2026-10-15 | 091c0b3 | 3200 | 3,559,014 | 9 | 1.7 | 39.40 | 62.90 | 25.4 | 242.2 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
| 2026-10-15 | 091c0b3 | 10000 | 2,311,038 | 9 | 1.2 | 114.90 | 155.60 | 8.7 | 272.8 | NVIDIA, NVIDIA RTX A3000 Laptop GPU (0x000024B8) |
