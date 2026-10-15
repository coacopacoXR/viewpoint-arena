"""convert-service — one-shot CAD tessellation for Viewpoint Arena.

Task 03a of the large-models work: STEP, IGES and BREP files are tessellated
HERE, once, with native OpenCascade (the `OCP` module from cadquery-ocp) and
handed to every participant as a meshopt-compressed GLB. Until now each browser
tessellated its own copy through occt-import-js, which costs roughly six times
the file size in WASM heap, hits a 2 GB ceiling and times out around 150–170 MB
(see CAD_SLOW_IMPORT_BYTES in utils/modelLoader.ts).

The output is not "a mesh": it is the same assembly tree the browser path builds
in utils/cadToThree.ts, node for node and name for name, because per-part
identity — selection, pins, visibility, variants — is derived from that tree.
convert_service/cad.py is where that parity is implemented and
convert-service/README.md §3 is where it is documented.

This package deliberately imports no OpenCascade at import time. OCP is a 67 MB
native module that takes seconds to load and can crash the process that holds
it, so it lives behind `python -m convert_service.worker`: the HTTP service runs
each conversion in a subprocess and the whole test suite for the HTTP surface
runs with no engine installed at all.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
