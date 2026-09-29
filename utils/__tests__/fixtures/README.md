# CAD test fixtures

Small real CAD files used by `../cadImport.node.test.ts` to prove the
OpenCascade path works end to end, not just against hand-written JSON.

| File | Format | Bytes | Upstream path in `kovacsv/occt-import-js` |
| --- | --- | --- | --- |
| `cube.stp` | STEP AP203 | 8,247 | `test/testfiles/simple-basic-cube/cube.stp` |
| `cube-10x10.igs` | IGES | 11,562 | `test/testfiles/cube-10x10mm/Cube 10x10.igs` |
| `as1_pe_203.brep` | BREP | 42,186 | `test/testfiles/cax-if-brep/as1_pe_203.brep` |

**Source:** https://github.com/kovacsv/occt-import-js — the `test/testfiles`
directory of release 0.0.23, the version this repo depends on. They were copied
byte-for-byte out of `node_modules/occt-import-js/test/testfiles/` (the same
files the upstream repository publishes), so no network access is needed to
refresh them.

**Licence:** LGPL-2.1, the licence of occt-import-js itself. They are test data
for an LGPL-2.1 library, unmodified, and are not linked into any shipped
bundle. `cube.stp` was originally published on grabcad.com
("simple-basic-cube") and `as1_pe_203.brep` comes from the CAX-IF STEP test
library (https://www.cax-if.org/cax/cax_stepLib.php), as recorded in the
upstream `source.txt` files.

Total: 62 KB. Keep additions under 200 KB.
