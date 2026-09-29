# Third-party components

Viewpoint Arena itself is licensed under the Apache License, Version 2.0 — see
[LICENSE](LICENSE). This file records what the application is built from, and
the one component whose licence carries obligations of its own.

## occt-import-js — LGPL-2.1 (OpenCascade)

| | |
| --- | --- |
| Package | [`occt-import-js`](https://github.com/kovacsv/occt-import-js) 0.0.23 |
| Licence | LGPL-2.1, and the OpenCascade Technology it compiles to WebAssembly is LGPL-2.1 with the OpenCascade exception |
| Licence texts | `node_modules/occt-import-js/LICENSE.md` (the library) and `node_modules/occt-import-js/dist/license.occt.txt` (OCCT) |
| Used for | Reading STEP (`.step`, `.stp`), IGES (`.iges`, `.igs`) and BREP (`.brep`, `.brp`) files |
| How | Unmodified. `utils/cadWorker.ts` runs in a Web Worker that is created only when a CAD file is opened, and loads `occt-import-js.wasm` as a separate asset |

**Why this sits alongside Apache-2.0.** The two licences are combined as
separate works, not merged into one: no Viewpoint Arena source is derived from
OpenCascade, the library is not modified, and it is not statically linked into
the application bundle. It is fetched at runtime as its own file
(`dist/assets/occt-import-js-*.wasm`), so someone who receives a build can
replace that file with a different build of the same library — which is what
LGPL-2.1 §6 asks of a combined work. TypeScript declarations for the small
surface we call live in `types/occt-import-js.d.ts` and are ours, not theirs.

**If you redistribute a build** (a Docker image, a `dist/` folder, a desktop
package), ship the two licence texts named above next to it, and keep the WASM
as a separate, replaceable file. Copying them into a `licenses/` directory of
this repository is the tidy way to do that; they are not committed today
because the npm package already carries them.

**Test fixtures.** `utils/__tests__/fixtures/` holds three small CAD files from
the upstream test set, also LGPL-2.1 — see the README in that directory. They
are test data only and are not part of any build.

## Everything else

The remaining runtime dependencies — three.js, React, React Three Fiber,
Zustand, Tailwind, PartyKit, Supabase, MSAL, lucide-react and the rest — are
listed with their versions in `package.json`, and each ships its own licence
file in `node_modules`. All of them are permissively licensed (MIT, BSD or
Apache-2.0), are consumed as published, and are bundled by Vite without
modification.
