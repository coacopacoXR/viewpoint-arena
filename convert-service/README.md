# convert-service

Tessellate STEP, IGES and BREP files **once, on the server**, and hand every
participant the same compressed GLB.

Until now every browser that opened a CAD file tessellated its own copy of it, in
a Web Worker, with OpenCascade compiled to WebAssembly
([`utils/cadWorker.ts`](../utils/cadWorker.ts) →
[`occt-import-js`](https://github.com/kovacsv/occt-import-js)). That has three
hard ceilings, all of them measured rather than feared:

* the WASM heap tops out around **2 GB**, and tessellation holds roughly **six
  times the file size** — which is why `CAD_SLOW_IMPORT_BYTES` in
  [`utils/modelLoader.ts`](../utils/modelLoader.ts) starts warning at 100 MB;
* imports **time out around 150–170 MB**, after three minutes
  (`CAD_IMPORT_TIMEOUT_MS`), with the person watching a spinner;
* the work is **repeated by every participant**, on every reload, forever. A room
  of six people reviewing one assembly pays for it six times.

This service does it once. It is the same kernel — `cadquery-ocp` is the pip build
of OCCT's Python bindings, and occt-import-js is OCCT compiled to WASM — with the
same tessellation parameters, producing the same assembly tree. Task 03a; the api
that calls it is 03b and the client that consumes the GLB is 03c.

**What is NOT here, deliberately:** no api route, no client change, no storage, no
cache keyed on a model hash, and nothing that decides *when* a browser should use
this instead of its own reader. Those are 03b and 03c. This service is a function
with an HTTP shape: a CAD file goes in, a GLB comes out.

---

## 1. Run it locally, without Docker

```bash
cd convert-service

# 1. A virtualenv, Python 3.11 or newer
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate

# 2. The HTTP service
pip install -r requirements-dev.txt

# 3. The engine: OpenCascade, plus gltfpack on PATH.
#    cadquery-ocp has wheels for Linux, Windows and macOS on CPython 3.11–3.14
#    and no source build, so a platform without a wheel runs the HTTP half only.
pip install -r requirements-ocp.txt
#    gltfpack: https://github.com/zeux/meshoptimizer/releases — one static binary.
#    The Dockerfile pins v1.3 with a checksum; put it anywhere on PATH.

# 4. Start it
python -m convert_service
# …or with flags instead of environment variables:
uvicorn convert_service.main:app --host 127.0.0.1 --port 8080

# 5. Convert something
curl -sS -D- -o /tmp/out.glb \
  -H "X-File-Name: bracket.step" \
  --data-binary @bracket.step \
  http://127.0.0.1:8080/convert
```

With Docker, which is how it is deployed:

```bash
docker compose build convert-service
docker compose run --rm convert-service pytest          # the acceptance check
docker compose up -d convert-service                    # usually started by the api
docker compose exec convert-service python healthcheck.py
```

Without the engine the service still starts and answers `/health`; every
`/convert` then fails `503 engine_unavailable` with the install step in the
message. That is the same contract capture-service has with faster-whisper, and
it is why the HTTP test suite needs no OpenCascade at all.

---

## 2. Configuration and the HTTP interface

### Variables

Every setting is an environment variable with a `CONVERT_` prefix — no settings
file, no flag that overrides one. [`config.py`](convert_service/config.py)
validates them at start-up and names the offending variable in the error.
[`.env.example`](.env.example) is the template; `install.sh` writes the real one.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONVERT_SHARED_SECRET` | *(empty)* | Bearer token for **every** route. Empty = off, which is only safe because the default bind is `127.0.0.1` and compose publishes no port. |
| `CONVERT_MAX_UPLOAD_BYTES` | `209715200` | Ceiling on one upload (200 MiB — `MAX_MODEL_FILE_BYTES` in `utils/modelFormats.ts`). Enforced while the body streams. |
| `CONVERT_TIMEOUT_S` | `900` | Wall clock for one **request**, queueing included. On expiry the job's process group is killed and the caller gets a 504. |
| `CONVERT_CONCURRENCY` | `1` | Conversions running at once. Extra requests queue rather than fail. |
| `CONVERT_GLTFPACK` | `gltfpack` | Executable name or path. |
| `CONVERT_HOST` / `CONVERT_PORT` | `127.0.0.1` / `8080` | Bind address for `python -m convert_service`. The image sets `0.0.0.0`. |
| `CONVERT_MEM_LIMIT`, `CONVERT_CPUS` | `6g`, `4` | Interpolated by `docker-compose.yml` into the container's ceilings; not read by Python. |

No `VITE_` prefix appears anywhere here, and none may: `VITE_`-prefixed variables
are inlined into the browser bundle at build time, so `CONVERT_SHARED_SECRET`
under that name would be a public secret. `scripts/check-public-env.mjs` is what
enforces the rule.

### `GET /health`

```json
{
  "status": "ok",
  "service": "convert-service",
  "version": "0.1.0",
  "formats": [".step", ".stp", ".iges", ".igs", ".brep", ".brp"],
  "engine": { "ocpFound": true, "gltfpackPath": "/usr/local/bin/gltfpack" },
  "limits": { "maxUploadBytes": 209715200, "timeoutSeconds": 900.0, "concurrency": 1 },
  "inFlight": 0
}
```

Performs no conversion and opens no socket, so a container healthcheck can poll it
every 30 s. `ocpFound` comes from `importlib.util.find_spec`, which locates the
module without loading 67 MB of native code into the HTTP process — the subprocess
design depends on that process never importing OCP. The Dockerfile proves
`import OCP` works at build time, because a service that answers 200 here and 500
on every conversion is worse than one that will not start.

### `POST /convert`

The **raw request body is the CAD file** — not a multipart form, because a STEP
file is binary and the answer is binary, and wrapping 200 MB in form encoding
would copy it for no reason.

| Request header | Meaning |
| --- | --- |
| `X-File-Name` | The original filename. Its extension picks the reader and names the glTF scene. It is client text, so it is never echoed in a response, never logged, and never used to name a file on this disk. |
| `X-Convert-Token` | The shared secret, when one is configured. `Authorization: Bearer …` is accepted too. |

| Response header | Meaning |
| --- | --- |
| `Content-Type` | `model/gltf-binary` |
| `X-Part-Count` | Nodes in the output carrying a mesh — the parts a participant can select. |
| `X-Triangle-Count` | Triangles **drawn**, so a shared mesh counts once per instance. |
| `X-Convert-Ms` | The whole job: read, tessellate, write, compress. |

There is no `Content-Disposition`: nothing the client sent is used to name a file
on this disk or in a header.

### Errors

One shape, `{"error": "<code>"}`, plus the small non-sensitive extras noted below.
Codes are a contract with 03b, not messages — [`errors.py`](convert_service/errors.py)
is where they are defined, and a `message` never crosses the wire.

| Status | Code | Extra | Meaning |
| --- | --- | --- | --- |
| 400 | `empty_upload` | | Zero-byte body. |
| 401 | `unauthorized` | | The secret is set and was not presented. |
| 413 | `upload_too_large` | `maxUploadBytes` | Over the ceiling, caught while streaming. |
| 415 | `unsupported_format` | `extensions` | The extension is not one this service reads. |
| 422 | `convert_unreadable` | | OpenCascade opened it and found nothing usable. |
| 422 | `convert_empty` | | It read fine and tessellated to zero triangles. |
| 500 | `convert_crashed` | | The subprocess died without reporting: a segfault, an OOM kill. |
| 500 | `internal_error` | | Anything unhandled. The traceback is in the log, not the body. |
| 503 | `engine_unavailable` | | OCP or gltfpack is missing. |
| 504 | `convert_timeout` | `timeoutSeconds` | Over `CONVERT_TIMEOUT_S`; the process group was killed. |

The 422/504 pair is what the browser already says to a person —
`cadReadFailureMessage` and `cadTimeoutMessage` in `utils/cadImport.ts` — so 03b
can map them onto the sentences a reviewer has already read.

Nothing in a response or a log line carries file content. That includes the
uploaded **filename** (client text like any other header) and OpenCascade's own
stdout, which quotes product names from the file while it reads: the worker's
stdout and stderr are discarded rather than forwarded, and the only detail that
reaches the log is this service's own bounded text (a reader status, an exception
type, gltfpack's last line). A developer who needs OCCT's chatter runs
`python -m convert_service.worker --job … --result …` by hand.

---

## 3. Parity with the browser path

**This is the requirement the service stands or falls on.** Per-part identity in
this app is derived from the tree a client walks after an import: `buildSceneTree`
in [`utils/modelLoader.ts`](../utils/modelLoader.ts) assigns `userData.modelId`
and `userData.nodeId` **positionally**, and pins, comments, visibility, variants
and the model tree all key on those. A server conversion that produced a flatter
or differently ordered tree would not look wrong — it would silently move every
pin in every review that used to be a STEP file.

So [`cad.py`](convert_service/cad.py) is a transcription of occt-import-js's XDE
reader, which is vendored in this repo at
`node_modules/occt-import-js/occt-import-js/src/importer-xcaf.cpp`:

| occt-import-js | convert-service |
| --- | --- |
| `XcafRootNode::GetChildren`, `IsFreeShape` | `_Converter._xde_roots`, `_is_free_shape` |
| `TriangulateShape` (importer-utils.cpp) | `_tessellate` |
| `XcafNode::IsMeshNode` | `_is_mesh_node` |
| `XcafNode::EnumerateShapeMeshes` | `_mesh_sources` |
| `XcafShapeMesh::GetName` / `GetShapeName` | `_shape_name` |
| `GetLabelName`, which follows references | `_label_name` |
| `XcafFace::GetColor`, `GetLabelColor` | `_label_colour`, `_shape_colour` |
| `OcctFace::EnumerateVertices/Normals/Triangles` | `_tessellate_faces` |
| `HierarchyWriter` (js-interface.cpp) | [`gltf.write_glb`](convert_service/gltf.py) |
| `cadResultToGroup`, `meshFrom`, `materialsFor` (cadToThree.ts) | the naming fallback chain, `_primitives` |

The tessellation constants are `CAD_TESSELLATION_PARAMS` verbatim — `0.001` of the
bounding box as chord tolerance, `0.5` rad angular, millimetres — and
`tests/test_formats.py` reads them out of the TypeScript source so they cannot
drift. Y-up is `Z_UP_TO_Y_UP` (−90° about +X), folded into the root nodes'
matrices rather than applied to the geometry, because rotating a placed part's
vertices about the world origin would move it as well as tip it.

### Proving it

```bash
npx tsx convert-service/scripts/parity.mjs
```

That runs the app's own code — `occt-import-js`, `cadResultToGroup`,
`buildSceneTree` — on `tests/fixtures/assembly.step`, converts the same file in the
service image, loads the GLB with `GLTFLoader` + `MeshoptDecoder`, and prints both
trees side by side. Measured output:

```
BROWSER  (occt-import-js + cadResultToGroup)     SERVER   (convert-service GLB + GLTFLoader)
assembly [GROUP]                                 assembly [GROUP]
  Frame Assembly [GROUP]                           Frame_Assembly [GROUP]   <-- differs
    Base Plate [MESH]                                Base_Plate [MESH]      <-- differs
    Corner Joint [GROUP]                             Corner_Joint [GROUP]   <-- differs
      Corner Bracket [MESH]                            Corner_Bracket [MESH]
      M6 Bolt [MESH]                                   M6_Bolt [MESH]
      M6 Bolt [MESH]                                   M6_Bolt_1 [MESH]     <-- differs
    Corner Joint [GROUP]                             Corner_Joint_1 [GROUP] <-- differs
      …                                              …
                          BROWSER          SERVER
  rows in the tree        13               13
  pickable parts (meshes) 9                9
  triangles               636              636
  size x (mm)             120.000          120.000
  size y (mm)             68.000           68.000
  size z (mm)             80.000           80.000

  tree identical (canonical names):  YES
  parseModelFile agrees:             YES
  parts identical:                   YES
  triangles identical:               YES
```

**636 triangles against 636, and identical bounds to the millimetre**: the same
kernel at the same deflection produces the same mesh. `parseModelFile agrees: YES`
means the app's real entry point — not a reimplementation in the script — builds
that tree from the GLB.

On the generated 800-part benchmark assembly
(`scripts/make_step_assembly.py --parts 800`, a 3.8 MB STEP), the same script
reports:

```
  rows in the tree        809              809
  pickable parts (meshes) 800              800
  triangles               92644            88978       <-- differs
  size x (mm)             1428.277         1428.277
  size y (mm)             154.286          154.286
  size z (mm)             822.271          822.271
  seconds (load)          6.54             0.03

  tree identical (canonical names):  YES
  parseModelFile agrees:             YES
  parts identical:                   YES
  worst per-part box drift:          0.0001 mm  (parts over 0.01 mm: 0 of 800)
```

Every one of the 800 parts is in the same place to a tenth of a micron, and
opening the converted file is **6.5 s → 0.03 s** on this machine — the browser
column is tessellating in WASM, the server column is `GLTFLoader` reading a
finished mesh. That is the whole argument for this service, measured.

The one number that differs is the triangle count, and it is worth being precise
about rather than rounding away: **141 of the 800 parts** tessellate differently,
every one of them a conical face (178 triangles in the browser, 152 here). Boxes,
spheres and cylinders come out identical. The two builds of OpenCascade segment a
cone's side surface differently at the same chord tolerance —
`occt-import-js@0.0.23` is WASM from an OCCT 7.x tree, `cadquery-ocp` 8.0.1 is
OCCT 8.0 — and nothing a writer can do closes that gap except pinning the kernels
together. 4% fewer triangles on curved parts, zero measurable difference in where
any part sits, is the trade this service makes; the alternative (downgrading the
server kernel to chase a WASM build that will itself move) is recorded here rather
than taken.

### Differences that could not be avoided

1. **three.js rewrites node names on load.** `PropertyBinding.sanitizeNodeName`
   turns whitespace into `_` and strips `[ ] . : /`; `GLTFLoader.createUniqueName`
   then appends `_1`, `_2` … to any name the file already used. So "Base Plate"
   reads as `Base_Plate`, and the second "M6 Bolt" reads as `M6_Bolt_1`. This
   happens to **every** GLB the app has ever loaded, whatever produced it, and a
   CAD assembly is made of exactly the two things that trigger it: spaces in part
   names, and one part instanced fifty times. Nothing a writer can do reaches
   past it; `parity.mjs` therefore compares canonical names and exits on
   structure, not spelling.
2. **A glTF node carries at most one mesh.** occt-import-js hangs N meshes off one
   node, so N meshes become N child nodes. `GLTFLoader` turns a child node that
   has a mesh and no children back into a `THREE.Mesh`, so the object the client
   ends up with is `Group("Corner Joint") > Mesh(…)` — the same shape as
   `cadResultToGroup`'s output.
3. **A part with ONE mesh is written already collapsed**, as a single node holding
   both the name and the mesh. The browser makes `Group("Base Plate") >
   Mesh("Base Plate")` and `collapseSingleChildGroups` folds that into one row; a
   GLB cannot rely on that folding, because GLTFLoader would rename the inner node
   `Base_Plate_1` and the collapse keeps a child's name unless it matches
   `/^(Mesh|Group) \d+$/`.
4. **Units stay the file's own** — millimetres for a typical STEP, not metres.
   The browser path does not rescale either: occt-import-js hands three.js the
   numbers the file carries and `centerModel` normalises whatever arrives
   (`baseScale = 2 / maxDim`). Rescaling here would make a converted model a
   different size from the same file imported in a browser, which is visible in a
   room where one participant has each.
5. **Instance geometry lives in the shared master's frame**, with the placement on
   the node, instead of being baked per instance the way the browser bakes it.
   Identical rendered result; it is what makes six bolts cost one mesh.
6. **Colour-group order.** `cadToThree.materialsFor` builds `geometry.groups` in
   face order; glTF primitives come out in colour order. Each triangle gets the
   same material either way, and nothing in the app reads `geometry.groups`.
   (In practice a STEP file yields one colour per part: a face inside a solid has
   no XDE label of its own, so `Search` finds no per-face colour — true of the
   browser path too, which goes through the same `Search`.)
7. **Normals are omitted when incomplete**, exactly as js-interface.cpp attaches a
   `NORMAL` attribute only if every vertex got one; `applySceneDefaults` then
   computes vertex normals on the client, which is what `cadToThree` does today.
8. **The glTF scene plays occt's unnamed root node.** Its `nodes` are the file's
   free shapes and its name is the file's base name, because that is what
   `cadResultToGroup` names its root group when the reader's root has no name —
   which, for every reader here, it does not.
9. **Conical faces tessellate ~15% coarser** than the browser's OCCT 7.x does —
   141 of the 800 benchmark parts, 4% of its triangles, no measurable difference
   in geometry. See the measurement above; this is the only difference that is a
   property of the two kernels rather than of the two file formats.

---

## 4. The GLB: writer, compression and the flags

### pygltflib, not trimesh

Both were on the table. trimesh's glTF exporter models **one geometry per node**,
which cannot express a part whose faces carry two colours: that has to be one glTF
mesh with two primitives, because two primitives are what become one `THREE.Mesh`
with a material array and two geometry groups — the thing
`materialsFor` in `cadToThree.ts` builds. pygltflib is a set of glTF dataclasses
with nothing in the way, so this service writes exactly the tables it means, and
it has no numpy: the buffers are `array.array('f')` and `array.array('I')`, four
bytes per float instead of a 24-byte Python object, which is the difference
between holding a 200 MB assembly in memory and holding three copies of it.

Materials mirror the browser's shading: `metallicFactor 0.2`, `roughnessFactor
0.6`, `doubleSided`, and a base colour converted **sRGB → linear** with the same
piecewise curve three.js uses, because glTF stores linear and `cadToThree` feeds
`sRGB` to `THREE.Color.setRGB(…, SRGBColorSpace)`.

### gltfpack: `-cc -kn -km -noq`

| Flag | Why |
| --- | --- |
| `-cc` | meshopt compression (`EXT_meshopt_compression`). `modelLoader.ts` already wires `MeshoptDecoder` into its `GLTFLoader`, so the app reads this with no new client dependency. |
| `-kn` | **Mandatory, not a size optimisation.** Without it gltfpack merges nodes it considers redundant — measured on the fixture, the `Base Plate` group disappears entirely. Merging nodes is merging parts, and node identity here is positional. |
| `-km` | Keeps material names. |
| `-noq` | Turns off gltfpack's default position quantization. See below. |
| *(no `-si`)* | No simplification. A design review is about the geometry. |

`-noq` is the one flag that is a judgement call, and it was made from a
measurement rather than a preference. With quantization on, gltfpack adds
`KHR_mesh_quantization` and — because a quantized mesh needs its dequantisation
transform on the node that holds it, and one mesh here is held by six nodes —
inserts an extra **unnamed** node per mesh instance. gltfpack also strips every
mesh name (all six flag combinations measured), so `GLTFLoader` has nothing to
name the part with and falls back to `mesh_0`, `mesh_2_instance_3`: **that is what
the model tree would show**, and `collapseSingleChildGroups` cannot rescue it
because its placeholder rule only matches `Mesh N` / `Group N`.

It is not a size regression, at either end of the scale — the extra nodes and
their matrices cost more JSON than 14-bit positions save:

| fixture | raw GLB | `-cc -kn -km` | `-cc -kn -km -noq` |
| --- | --- | --- | --- |
| `assembly.step` (9 parts, 636 tris) | 9 604 B | 5 832 B | **5 580 B** |
| 800-part benchmark (88 978 tris) | 728 KiB | 373 KiB | **368 KiB** |

It is also the more accurate choice: 14 bits over a 10 m assembly is a 0.6 mm
grid, and the browser path this service has to match does not quantize at all.

### Instancing

`_mesh_key` keys the tessellation cache on the **label a solid resolves to**, not
on the node it was found under, so every instance of a part lands on one glTF mesh
and differs only by its node matrix. On the 800-part benchmark: **800 parts, 237
meshes, 88 978 triangles, 368 KiB** — 3.4× sharing, from a 3.8 MB STEP, in
**2.7 s** including process start and OCP's import.

---

## 5. Tests

```bash
docker compose run --rm convert-service pytest      # everything, engine included
cd convert-service && python -m pytest              # on a laptop, if OCP is installed
cd convert-service && python -m pytest -k "not conversion"   # HTTP surface only
```

`103 passed` in the image. The split is the point:

* **Without the engine** — `requirements-dev.txt` alone — everything about the
  HTTP surface still runs: configuration validation, the shared secret, the
  streaming size cap, the 400/413/415/422/500/503/504 mapping, the queue and the
  deadline. Those tests inject a fake `JobRunner` the way capture-service's
  inject a fake transcriber, so a contributor on a platform `cadquery-ocp` has no
  wheel for can still prove the service behaves.
* **With the engine** — `tests/test_conversion.py` — converts the committed
  fixtures through the production path (subprocess, OCP, gltfpack) and asserts on
  the **file**: the tree, the part names, the shared mesh indices, the Y-up
  bounding box, the linear material colours, the BREP fallback names, and that a
  file the reader cannot parse is a 422 rather than a crash. Those tests skip with
  a printed reason when OCP or gltfpack is missing, so `python -m pytest` is
  honest on both kinds of machine.

`tests/test_formats.py` reads the app's TypeScript source and fails when the
format list, the reader table or the tessellation constants drift. It skips inside
the image, which ships only `convert-service/`; `parity.mjs` is the check that
runs where the app's source is.

Fixtures are **committed** (46 KB total) and generated by
[`scripts/make_fixtures.py`](scripts/make_fixtures.py):

```bash
docker compose run --rm convert-service python scripts/make_fixtures.py
```

`assembly.step` is a two-level assembly — a plate, two `Corner Joint`
sub-assemblies (one turned 90°), two loose bolts — with eight solids, three
distinct shapes and three colours, so it exercises nesting, instancing, rotation
and per-part colour in 43 KB. `box.brep` is the format with no assembly at all.
Unlike capture-service, this service's image carries `tests/` and pytest, because
`docker compose run --rm convert-service pytest` is how the service is proved to
work; see the comment in [`.dockerignore`](.dockerignore).

The large fixture for the perf benchmark is generated, not committed:

```bash
docker compose run --rm convert-service python scripts/make_step_assembly.py --parts 3200
# → perf/fixtures/step-assembly-3200.step   (gitignored, like the GLB make-assembly.mjs builds)
```

It mirrors `scripts/perf/make-assembly.mjs` — ~70% repeats of a 12-fastener set,
30% one-off parts, three levels of nesting, seeded — so the benchmark can compare
browser and server tessellation on the same kind of machine.

---

## 6. Layout

```
convert-service/
├── Dockerfile                  # two stages: the pinned gltfpack binary, then the service
├── README.md                   # this file
├── healthcheck.py              # the container HEALTHCHECK; sends the secret, exits 0 only on status ok
├── pytest.ini
├── requirements.txt            # fastapi, uvicorn, pygltflib
├── requirements-ocp.txt        # cadquery-ocp — the engine, pinned to the OCCT line
├── requirements-dev.txt        # pytest, httpx
├── convert_service/
│   ├── __init__.py             # version, and why nothing here imports OCP
│   ├── __main__.py             # python -m convert_service
│   ├── auth.py                 # the shared-secret middleware; why there is no CORS here
│   ├── cad.py                  # the XDE walk and the tessellation — the parity-critical file
│   ├── config.py               # CONVERT_* validation, one named error per variable
│   ├── errors.py               # the failure taxonomy; no message ever quotes content
│   ├── formats.py              # extension → reader, mirroring utils/modelFormats.ts
│   ├── gltf.py                 # the pygltflib writer: nodes, shared meshes, primitives
│   ├── jobs.py                 # the subprocess runner: queue, deadline, process-group kill
│   ├── main.py                 # the FastAPI app: /health, /convert, the error handlers
│   ├── schemas.py              # the wire shapes, camelCase like capture-service's
│   └── worker.py               # python -m convert_service.worker — one job, its own process
├── scripts/
│   ├── make_fixtures.py        # regenerates the committed fixtures
│   ├── make_step_assembly.py   # the large benchmark assembly (--parts N)
│   └── parity.mjs              # browser tree vs GLB tree, side by side
└── tests/
    ├── conftest.py             # fakes, the engine skip-marker, and the GLB readers
    ├── fixtures/               # assembly.step, box.brep
    ├── test_config.py
    ├── test_conversion.py      # needs the engine
    ├── test_endpoints.py
    ├── test_formats.py         # reads the app's TypeScript
    └── test_jobs.py
```

### Why the conversion runs in a subprocess

`jobs.py` starts `python -m convert_service.worker` per request and waits for a
JSON result file. Three reasons, none of them theoretical:

* OpenCascade is native code. A malformed STEP can segfault the kernel, and a
  segfault in the uvicorn worker takes the service — and every queued job — with
  it. In a subprocess it takes down one job and the parent reports
  `convert_crashed`.
* Tessellation needs roughly six times the file size in memory. A job that exceeds
  the container's ceiling is OOM-killed, which again kills the worker and not the
  service.
* OCP's 67 MB module and its document are released when the process exits, rather
  than accumulating in a long-lived server.

The deadline covers **queueing plus work** (`asyncio.timeout` wraps the semaphore
as well as the subprocess), so `CONVERT_TIMEOUT_S` is a promise about how long a
request takes. On expiry the worker's whole **process group** is signalled, which
is why it is started with `start_new_session`: the worker runs gltfpack as a child
of its own, and killing only the worker would leave a compressor running against a
file whose job no longer exists.

---

## 7. Not implemented here (and where it lives)

* **Calling this service.** Task 03b: an api route that takes the upload, checks
  the room's access gate, calls `/convert`, stores the GLB under the model's
  SHA-256 and serves it to participants. The header and error-code contract is §2.
* **Using the GLB in the browser.** Task 03c: deciding when a CAD import comes
  from here instead of the Web Worker, and loading the result. Nothing in this
  service assumes a client; `parseModelFile` already reads meshopt GLBs.
* **Caching.** Nothing here stores a conversion. The api is the right place: it
  already keys models by hash, and a cache in this service would be a second copy
  of that key space.
* **CORS.** No browser calls this service — the api does, server-side, the way it
  calls capture-service. Adding CORS would mean maintaining an origin allowlist
  for callers that do not exist. See [`auth.py`](convert_service/auth.py).
* **IGES fixtures.** The reader is wired and the extension is accepted, but the
  committed fixtures are STEP and BREP. IGES has no assembly structure, so it
  exercises the same walk with a flat label tree; `utils/__tests__/fixtures/` has
  an IGES file the browser tests use if one is wanted here.
* **A conversion CLI.** `python -m convert_service.worker --job … --result …` is
  the whole protocol and is what `parity.mjs` runs; a friendlier CLI is not worth
  a second entry point until somebody needs one.
